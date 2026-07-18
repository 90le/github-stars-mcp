import {
  clearInterval as clearNodeInterval,
  setInterval as setNodeInterval,
} from "node:timers";
import type { Clock } from "../ports/runtime-port.js";
import type {
  AcquireLeaseInput,
  Lease,
  LeaseGuard,
  StoragePort,
} from "../ports/storage-port.js";
import { AppError, serializeError } from "../../domain/errors.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";

const LEASE_TTL_MS = 10 * 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CLEANUP_DIAGNOSTICS = 4;

export interface LeaseScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export type LeaseScopeOptions = Readonly<{
  storage: StoragePort;
  runtime: Clock;
  name: string;
  ownerId: string;
  ttlMs?: number;
  signal?: AbortSignal;
  scheduler?: LeaseScheduler;
}>;

const NODE_SCHEDULER: LeaseScheduler = Object.freeze({
  setInterval(callback: () => void, intervalMs: number): unknown {
    const handle = setNodeInterval(callback, intervalMs);
    handle.unref();
    return handle;
  },
  clearInterval(handle: unknown): void {
    clearNodeInterval(handle as NodeJS.Timeout);
  },
});

function leaseLost(): AppError {
  return new AppError(
    "CAPABILITY_UNAVAILABLE",
    "The account lease is no longer owned by this operation",
    {
      retryable: true,
      details: { reason: "lease_lost" },
    },
  );
}

function leaseHeld(): AppError {
  return new AppError(
    "CAPABILITY_UNAVAILABLE",
    "Another operation currently holds the account lease",
    {
      retryable: true,
      details: { reason: "lease_held" },
    },
  );
}

function leaseStorageFailure(): AppError {
  return new AppError("STORAGE_ERROR", "Account lease storage failed", {
    retryable: false,
    details: { reason: "lease_storage_failure" },
  });
}

function runtimeFailure(): AppError {
  return new AppError("INTERNAL_ERROR", "Lease runtime clock failed", {
    retryable: false,
    details: { reason: "invalid_runtime_clock" },
  });
}

function schedulerFailure(): AppError {
  return new AppError("INTERNAL_ERROR", "Lease heartbeat could not start", {
    retryable: false,
    details: { reason: "lease_scheduler_failure" },
  });
}

function ownershipFailure(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === "NOT_FOUND" || error.code === "PRECONDITION_FAILED")
  );
}

function mappedStorageError(error: unknown): AppError {
  return ownershipFailure(error) ? leaseLost() : leaseStorageFailure();
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  const next = value + milliseconds;
  if (!Number.isFinite(value) || !Number.isSafeInteger(next) || next <= value) {
    throw runtimeFailure();
  }
  try {
    return canonicalUtcTimestamp(new Date(next).toISOString(), "lease expiry");
  } catch {
    throw runtimeFailure();
  }
}

function leaseTtl(value: number | undefined): number {
  const ttl = value ?? LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1) {
    throw new AppError("VALIDATION_ERROR", "Lease TTL is invalid", {
      retryable: false,
      details: { reason: "invalid_lease_ttl" },
    });
  }
  return ttl;
}

function safeNow(runtime: Clock): string {
  try {
    return canonicalUtcTimestamp(runtime.now(), "lease time");
  } catch {
    throw runtimeFailure();
  }
}

function acquireInput(
  runtime: Clock,
  name: string,
  ownerId: string,
  ttlMs: number,
): AcquireLeaseInput {
  const now = safeNow(runtime);
  return Object.freeze({
    name,
    ownerId,
    now,
    expiresAt: addMilliseconds(now, ttlMs),
  });
}

function fixedAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function validateLease(lease: Lease, name: string, ownerId: string): string {
  if (
    lease === null ||
    typeof lease !== "object" ||
    lease.name !== name ||
    lease.ownerId !== ownerId
  ) {
    throw leaseStorageFailure();
  }
  try {
    canonicalUtcTimestamp(lease.acquiredAt, "lease acquiredAt");
    canonicalUtcTimestamp(lease.heartbeatAt, "lease heartbeatAt");
    return canonicalUtcTimestamp(lease.expiresAt, "lease expiresAt");
  } catch {
    throw leaseStorageFailure();
  }
}

export function appendCleanupDiagnostic(
  primary: unknown,
  cleanup: unknown,
): void {
  if (
    (typeof primary !== "object" && typeof primary !== "function") ||
    primary === null
  ) {
    return;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      primary,
      "cleanupDiagnostics",
    );
    const previous =
      descriptor !== undefined &&
      Object.hasOwn(descriptor, "value") &&
      Array.isArray(descriptor.value)
        ? (descriptor.value as readonly unknown[])
        : [];
    const diagnostics = Object.freeze(
      previous.length >= MAX_CLEANUP_DIAGNOSTICS
        ? previous.slice(0, MAX_CLEANUP_DIAGNOSTICS)
        : [...previous, Object.freeze(serializeError(cleanup))],
    );
    Object.defineProperty(primary, "cleanupDiagnostics", {
      configurable: true,
      enumerable: false,
      value: diagnostics,
      writable: false,
    });
  } catch {
    // The primary error remains authoritative even when it is non-extensible.
  }
}

export class LeaseScope {
  readonly #storage: StoragePort;
  readonly #runtime: Clock;
  readonly #name: string;
  readonly #ownerId: string;
  readonly #scheduler: LeaseScheduler;
  readonly #callerSignal: AbortSignal | undefined;
  readonly #controller = new AbortController();
  readonly #callerAbort: () => void;
  #interval: unknown;
  #heartbeatStarted = false;
  #started = false;
  #stopped = false;
  #lost = false;
  #retainUntilExpiry = false;
  #callerCancelled = false;
  #heartbeatFailure: AppError | null = null;
  #expiresAt: string;
  #ttlMs: number;

  private constructor(options: LeaseScopeOptions, lease: Lease) {
    this.#storage = options.storage;
    this.#runtime = options.runtime;
    this.#name = options.name;
    this.#ownerId = options.ownerId;
    this.#ttlMs = leaseTtl(options.ttlMs);
    this.#scheduler = options.scheduler ?? NODE_SCHEDULER;
    this.#callerSignal = options.signal;
    this.#expiresAt = validateLease(lease, this.#name, this.#ownerId);
    this.#callerAbort = () => {
      this.#callerCancelled = true;
      this.#abortInternal();
    };
    if (this.#signalAborted(options.signal)) {
      this.#callerAbort();
    } else {
      try {
        options.signal?.addEventListener("abort", this.#callerAbort, {
          once: true,
        });
      } catch {
        this.#callerAbort();
      }
    }
  }

  static acquire(options: LeaseScopeOptions): LeaseScope {
    const input = acquireInput(
      options.runtime,
      options.name,
      options.ownerId,
      leaseTtl(options.ttlMs),
    );
    let lease: Lease | null;
    try {
      lease = options.storage.acquireLease(input);
    } catch {
      throw leaseStorageFailure();
    }
    if (lease === null) throw leaseHeld();
    return new LeaseScope(options, lease);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  assertActive(): void {
    if (this.#lost) throw leaseLost();
    if (this.#heartbeatFailure !== null) throw this.#heartbeatFailure;
    if (safeNow(this.#runtime) >= this.#expiresAt) {
      this.#markLost();
      throw leaseLost();
    }
    if (this.#callerCancelled || this.#signalAborted(this.#callerSignal)) {
      throw fixedAbortError();
    }
    if (this.#controller.signal.aborted) throw leaseLost();
  }

  freshGuard(): LeaseGuard {
    if (this.#lost) throw leaseLost();
    const guard = Object.freeze({
      name: this.#name,
      ownerId: this.#ownerId,
      now: safeNow(this.#runtime),
    });
    try {
      const lease = this.#storage.assertLease(guard);
      this.#expiresAt = validateLease(lease, this.#name, this.#ownerId);
      return guard;
    } catch (error) {
      if (ownershipFailure(error)) {
        this.#markLost();
        throw leaseLost();
      }
      throw leaseStorageFailure();
    }
  }

  tryFreshGuard(): LeaseGuard | null {
    if (this.#lost) return null;
    try {
      return this.freshGuard();
    } catch (error) {
      if (this.#lost || ownershipFailure(error)) return null;
      throw error;
    }
  }

  renew(minimumTtlMs = this.#ttlMs): LeaseGuard {
    if (this.#lost) throw leaseLost();
    if (this.#heartbeatFailure !== null) throw this.#heartbeatFailure;
    this.#ttlMs = Math.max(this.#ttlMs, leaseTtl(minimumTtlMs));
    const input = acquireInput(
      this.#runtime,
      this.#name,
      this.#ownerId,
      this.#ttlMs,
    );
    try {
      const lease = this.#storage.renewLease(input);
      this.#expiresAt = validateLease(lease, this.#name, this.#ownerId);
      return Object.freeze({
        name: this.#name,
        ownerId: this.#ownerId,
        now: input.now,
      });
    } catch (error) {
      if (ownershipFailure(error)) {
        this.#markLost();
        throw leaseLost();
      }
      throw error instanceof AppError ? error : leaseStorageFailure();
    }
  }

  retainUntilExpiry(): void {
    this.#retainUntilExpiry = true;
  }

  async run<T>(action: (scope: LeaseScope) => Promise<T>): Promise<T> {
    if (this.#started) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "Lease scope can only run once",
      );
    }
    this.#started = true;

    let primary: unknown;
    let hasPrimary = false;
    let result: T | undefined;
    try {
      try {
        this.#interval = this.#scheduler.setInterval(
          () => this.#heartbeat(),
          HEARTBEAT_INTERVAL_MS,
        );
        this.#heartbeatStarted = true;
      } catch {
        throw schedulerFailure();
      }
      this.assertActive();
      result = await action(this);
      this.assertActive();
    } catch (error) {
      primary = error;
      hasPrimary = true;
    }

    const cleanup = this.#cleanup();
    if (hasPrimary) {
      if (cleanup !== null) appendCleanupDiagnostic(primary, cleanup);
      throw primary;
    }
    if (cleanup !== null) throw cleanup;
    return result as T;
  }

  #heartbeat(): void {
    if (this.#stopped || this.#lost || this.#heartbeatFailure !== null) return;
    try {
      this.renew();
    } catch (error) {
      if (this.#lost) return;
      this.#heartbeatFailure =
        error instanceof AppError ? error : leaseStorageFailure();
      this.#abortInternal();
    }
  }

  #cleanup(): AppError | null {
    if (this.#stopped) return null;
    this.#stopped = true;
    if (this.#heartbeatStarted) {
      try {
        this.#scheduler.clearInterval(this.#interval);
      } catch {
        this.#heartbeatFailure ??= leaseStorageFailure();
      }
    }
    try {
      this.#callerSignal?.removeEventListener("abort", this.#callerAbort);
    } catch {
      // Listener cleanup cannot affect lease ownership.
    }

    if (this.#lost) return null;
    if (this.#retainUntilExpiry) return this.#heartbeatFailure;
    let guard: LeaseGuard | null;
    try {
      guard = this.tryFreshGuard();
    } catch (error) {
      return error instanceof AppError ? error : leaseStorageFailure();
    }
    if (guard === null) return leaseLost();
    try {
      this.#storage.releaseLease({
        name: guard.name,
        ownerId: guard.ownerId,
      });
    } catch (error) {
      return mappedStorageError(error);
    }
    return this.#heartbeatFailure;
  }

  #markLost(): void {
    this.#lost = true;
    this.#abortInternal();
  }

  #abortInternal(): void {
    try {
      this.#controller.abort();
    } catch {
      // Abort delivery is best-effort; assertActive still checks local state.
    }
  }

  #signalAborted(signal: AbortSignal | undefined): boolean {
    if (signal === undefined) return false;
    try {
      return signal.aborted;
    } catch {
      return true;
    }
  }
}
