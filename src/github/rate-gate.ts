import { performance } from "node:perf_hooks";
import { setTimeout as waitFor } from "node:timers/promises";
import type { RateLimitState } from "../app/ports/github-port.js";
import { AppError } from "../domain/errors.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";

export interface RateGateRuntime {
  wallNowMs(): number;
  monotonicNowMs(): number;
  wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

const MAX_OBSERVATION_DELAY_MS = 24 * 60 * 60 * 1_000;

const DEFAULT_RUNTIME: RateGateRuntime = Object.freeze({
  wallNowMs: () => Date.now(),
  monotonicNowMs: () => performance.now(),
  async wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    await waitFor(delayMs, undefined, { signal });
  },
});

function unavailable(
  message: string,
  reason:
    | "cancelled"
    | "invalid_rate_limit_observation"
    | "invalid_runtime_clock"
    | "wait_failed",
): AppError {
  return new AppError("GITHUB_UNAVAILABLE", message, {
    retryable: false,
    details: { reason },
  });
}

function invalidObservation(): AppError {
  return unavailable(
    "GitHub rate limit observation is invalid",
    "invalid_rate_limit_observation",
  );
}

function cancelled(): AppError {
  return unavailable("GitHub request was cancelled", "cancelled");
}

function invalidRuntimeClock(): AppError {
  return unavailable(
    "GitHub rate limit clock is invalid",
    "invalid_runtime_clock",
  );
}

function waitFailed(): AppError {
  return unavailable("GitHub rate limit wait failed", "wait_failed");
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

export class RateGate {
  readonly #runtime: RateGateRuntime;
  #state: RateLimitState | null = null;
  #pauseUntilMonotonicMs: number | null = null;
  #lastMonotonicMs: number | null = null;

  constructor(runtime: RateGateRuntime = DEFAULT_RUNTIME) {
    this.#runtime = runtime;
  }

  async beforeRequest(signal?: AbortSignal): Promise<void> {
    if (signalIsAborted(signal)) throw cancelled();

    while (this.#pauseUntilMonotonicMs !== null) {
      const observedDeadline = this.#pauseUntilMonotonicMs;
      const monotonicNow = this.#monotonicNow();
      const delayMs = observedDeadline - monotonicNow;
      if (!Number.isFinite(delayMs)) throw invalidRuntimeClock();

      if (delayMs <= 0) {
        if (this.#pauseUntilMonotonicMs === observedDeadline) {
          this.#pauseUntilMonotonicMs = null;
        }
        continue;
      }

      try {
        await this.#runtime.wait(delayMs, signal);
      } catch {
        if (signalIsAborted(signal)) throw cancelled();
        throw waitFailed();
      }
      if (signalIsAborted(signal)) throw cancelled();
    }
  }

  observe(state: RateLimitState | null): void {
    if (state === null) {
      this.#state = null;
      return;
    }

    let remaining: unknown;
    let resetAt: unknown;
    try {
      remaining = state.remaining;
      resetAt = state.resetAt;
    } catch {
      throw invalidObservation();
    }
    if (
      !finiteNonNegative(remaining) ||
      !Number.isInteger(remaining) ||
      typeof resetAt !== "string"
    ) {
      throw invalidObservation();
    }

    const observation = this.#observation(resetAt);
    const nextState = Object.freeze({
      remaining,
      resetAt: observation.timestamp,
    });
    this.#state = nextState;
    if (remaining === 0) {
      this.#extendPause(observation.monotonicDeadlineMs);
    }
  }

  observePrimaryLimit(resetAt: string): void {
    const observation = this.#observation(resetAt);
    this.#state = Object.freeze({
      remaining: 0,
      resetAt: observation.timestamp,
    });
    this.#extendPause(observation.monotonicDeadlineMs);
  }

  observeSecondaryLimit(retryAt: string): void {
    const observation = this.#observation(retryAt);
    this.#extendPause(observation.monotonicDeadlineMs);
  }

  getState(): RateLimitState | null {
    return this.#state;
  }

  #observation(timestamp: string): {
    readonly timestamp: string;
    readonly monotonicDeadlineMs: number;
  } {
    let canonicalTimestamp: string;
    let wallNow: number;
    let monotonicNow: number;
    try {
      canonicalTimestamp = canonicalUtcTimestamp(
        timestamp,
        "rate limit timestamp",
      );
      wallNow = this.#runtime.wallNowMs();
      monotonicNow = this.#runtime.monotonicNowMs();
    } catch {
      throw invalidObservation();
    }

    if (!finiteNonNegative(wallNow) || !finiteNonNegative(monotonicNow)) {
      throw invalidObservation();
    }
    if (
      this.#lastMonotonicMs !== null &&
      monotonicNow < this.#lastMonotonicMs
    ) {
      throw invalidObservation();
    }
    const targetWallMs = Date.parse(canonicalTimestamp);
    const delayMs = targetWallMs - wallNow;
    if (
      !Number.isFinite(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_OBSERVATION_DELAY_MS
    ) {
      throw invalidObservation();
    }
    const monotonicDeadlineMs = monotonicNow + delayMs;
    if (!Number.isFinite(monotonicDeadlineMs)) {
      throw invalidObservation();
    }
    this.#lastMonotonicMs = monotonicNow;

    return {
      timestamp: canonicalTimestamp,
      monotonicDeadlineMs,
    };
  }

  #monotonicNow(): number {
    let value: number;
    try {
      value = this.#runtime.monotonicNowMs();
    } catch {
      throw invalidRuntimeClock();
    }
    if (!finiteNonNegative(value)) throw invalidRuntimeClock();
    if (this.#lastMonotonicMs !== null && value < this.#lastMonotonicMs) {
      throw invalidRuntimeClock();
    }
    this.#lastMonotonicMs = value;
    return value;
  }

  #extendPause(deadlineMs: number): void {
    this.#pauseUntilMonotonicMs =
      this.#pauseUntilMonotonicMs === null
        ? deadlineMs
        : Math.max(this.#pauseUntilMonotonicMs, deadlineMs);
  }
}
