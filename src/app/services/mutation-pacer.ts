import { performance } from "node:perf_hooks";
import { setTimeout as waitFor } from "node:timers/promises";
import type { MutationReceipt } from "../ports/github-port.js";
import { AppError } from "../../domain/errors.js";
import type { JsonValue } from "../../domain/json.js";

export type ExecutionOutcome =
  | Readonly<{
      kind: "skipped";
      before: JsonValue;
      after: JsonValue;
      receipt: null;
    }>
  | Readonly<{
      kind: "succeeded";
      before: JsonValue;
      after: JsonValue;
      receipt: MutationReceipt;
    }>;

export interface MutationPacerRuntime {
  monotonicMs(): number;
  wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 1_000;

const DEFAULT_RUNTIME: MutationPacerRuntime = Object.freeze({
  monotonicMs: () => performance.now(),
  async wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    await waitFor(
      delayMs,
      undefined,
      signal === undefined ? undefined : { signal },
    );
  },
});

function cancelled(): AppError {
  return new AppError(
    "GITHUB_UNAVAILABLE",
    "Mutation execution was cancelled",
    {
      retryable: false,
      details: { reason: "cancelled" },
    },
  );
}

function invalidClock(): AppError {
  return new AppError("INTERNAL_ERROR", "Mutation pacing clock is invalid", {
    retryable: false,
    details: { reason: "invalid_monotonic_clock" },
  });
}

function waitFailed(): AppError {
  return new AppError("INTERNAL_ERROR", "Mutation pacing wait failed", {
    retryable: false,
    details: { reason: "mutation_pacing_wait_failed" },
  });
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

export class MutationPacer {
  readonly #runtime: MutationPacerRuntime;
  readonly #intervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  #lastStart: number | null = null;
  #lastObserved: number | null = null;

  constructor(
    runtime: MutationPacerRuntime = DEFAULT_RUNTIME,
    intervalMs = DEFAULT_INTERVAL_MS,
  ) {
    if (
      typeof intervalMs !== "number" ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < DEFAULT_INTERVAL_MS
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Mutation pacing interval is invalid",
        {
          retryable: false,
          details: { reason: "invalid_mutation_interval" },
        },
      );
    }
    this.#runtime = runtime;
    this.#intervalMs = intervalMs;
  }

  run<TPrepared, TResult>(input: {
    readonly signal?: AbortSignal;
    readonly prepare: () => Promise<
      | { readonly kind: "skipped"; readonly outcome: ExecutionOutcome }
      | { readonly kind: "dispatch"; readonly prepared: TPrepared }
    >;
    readonly dispatch: (prepared: TPrepared) => Promise<TResult>;
  }): Promise<ExecutionOutcome | TResult> {
    const result = this.#tail.then(() => this.#execute(input));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  waitForSafetyWindow(): Promise<void> {
    const result = this.#tail.then(() => this.#waitForSafetyWindow());
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #execute<TPrepared, TResult>(input: {
    readonly signal?: AbortSignal;
    readonly prepare: () => Promise<
      | { readonly kind: "skipped"; readonly outcome: ExecutionOutcome }
      | { readonly kind: "dispatch"; readonly prepared: TPrepared }
    >;
    readonly dispatch: (prepared: TPrepared) => Promise<TResult>;
  }): Promise<ExecutionOutcome | TResult> {
    this.#throwIfAborted(input.signal);
    if (this.#lastStart !== null) {
      await this.#waitUntil(this.#lastStart + this.#intervalMs, input.signal);
    }
    this.#throwIfAborted(input.signal);
    const preparation = await input.prepare();
    if (preparation.kind === "skipped") return preparation.outcome;

    this.#throwIfAborted(input.signal);
    this.#lastStart = this.#monotonicNow();
    return input.dispatch(preparation.prepared);
  }

  async #waitForSafetyWindow(): Promise<void> {
    if (this.#lastStart === null) return;
    await this.#waitUntil(this.#lastStart + this.#intervalMs);
  }

  async #waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
    while (true) {
      this.#throwIfAborted(signal);
      const delayMs = deadline - this.#monotonicNow();
      if (!Number.isFinite(delayMs)) throw invalidClock();
      if (delayMs <= 0) return;
      try {
        await this.#runtime.wait(delayMs, signal);
      } catch {
        if (signalIsAborted(signal)) throw cancelled();
        throw waitFailed();
      }
    }
  }

  #monotonicNow(): number {
    let value: number;
    try {
      value = this.#runtime.monotonicMs();
    } catch {
      throw invalidClock();
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (this.#lastObserved !== null && value < this.#lastObserved)
    ) {
      throw invalidClock();
    }
    this.#lastObserved = value;
    return value;
  }

  #throwIfAborted(signal: AbortSignal | undefined): void {
    if (signalIsAborted(signal)) throw cancelled();
  }
}
