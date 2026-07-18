import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { RateLimitState } from "../../../src/app/ports/github-port.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import {
  RateGate,
  type RateGateRuntime,
} from "../../../src/github/rate-gate.js";

const WALL_NOW = Date.parse("2026-07-18T00:00:00.000Z");
const MONOTONIC_NOW = 10_000;
const MAX_OBSERVATION_DELAY_MS = 24 * 60 * 60 * 1_000;

function timestamp(offsetMs: number): string {
  return new Date(WALL_NOW + offsetMs).toISOString();
}

class ControlledRuntime implements RateGateRuntime {
  wallMs = WALL_NOW;
  monotonicMs = MONOTONIC_NOW;
  readonly waits: {
    readonly delayMs: number;
    readonly signal: AbortSignal | undefined;
  }[] = [];
  waitImplementation:
    | ((delayMs: number, signal: AbortSignal | undefined) => Promise<void>)
    | null = null;

  wallNowMs(): number {
    return this.wallMs;
  }

  monotonicNowMs(): number {
    return this.monotonicMs;
  }

  wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.waits.push({ delayMs, signal });
    if (this.waitImplementation !== null) {
      return this.waitImplementation(delayMs, signal);
    }
    this.monotonicMs += delayMs;
    return Promise.resolve();
  }
}

async function caught(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

function caughtSync(action: () => void): AppError {
  let error: unknown;
  try {
    action();
  } catch (reason) {
    error = reason;
  }
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("RateGate", () => {
  it("exposes only the approved pause runtime and gate API", () => {
    expectTypeOf<RateGateRuntime>().toEqualTypeOf<{
      wallNowMs(): number;
      monotonicNowMs(): number;
      wait(delayMs: number, signal?: AbortSignal): Promise<void>;
    }>();
    expectTypeOf<RateGate["beforeRequest"]>().toEqualTypeOf<
      (signal?: AbortSignal) => Promise<void>
    >();
    expectTypeOf<RateGate["observe"]>().toEqualTypeOf<
      (state: RateLimitState | null) => void
    >();
    expectTypeOf<RateGate["observePrimaryLimit"]>().toEqualTypeOf<
      (resetAt: string) => void
    >();
    expectTypeOf<RateGate["observeSecondaryLimit"]>().toEqualTypeOf<
      (retryAt: string) => void
    >();
    expectTypeOf<RateGate["getState"]>().toEqualTypeOf<
      () => RateLimitState | null
    >();
  });

  it("converts a wall timestamp once and waits only against monotonic time", async () => {
    const runtime = new ControlledRuntime();
    const wallNow = vi.spyOn(runtime, "wallNowMs");
    const gate = new RateGate(runtime);
    gate.observeSecondaryLimit(timestamp(2_500));

    runtime.wallMs = WALL_NOW - 10 * 60 * 60 * 1_000;
    await gate.beforeRequest();

    expect(wallNow).toHaveBeenCalledTimes(1);
    expect(runtime.waits.map((entry) => entry.delayMs)).toEqual([2_500]);
  });

  it("keeps the later overlapping deadline and never shortens an existing pause", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);

    gate.observeSecondaryLimit(timestamp(5_000));
    gate.observeSecondaryLimit(timestamp(2_000));
    gate.observePrimaryLimit(timestamp(4_000));
    await gate.beforeRequest();

    expect(runtime.waits.map((entry) => entry.delayMs)).toEqual([5_000]);
  });

  it("loops when another observation extends the pause during a wait", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);
    let waitCount = 0;
    runtime.waitImplementation = (delayMs) => {
      runtime.monotonicMs += delayMs;
      runtime.wallMs += delayMs;
      waitCount += 1;
      if (waitCount === 1) {
        gate.observeSecondaryLimit(timestamp(3_000));
      }
      return Promise.resolve();
    };
    gate.observeSecondaryLimit(timestamp(1_000));

    await gate.beforeRequest();

    expect(runtime.waits.map((entry) => entry.delayMs)).toEqual([1_000, 2_000]);
  });

  it("blocks concurrent callers on the same active deadline", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);
    const resolvers: (() => void)[] = [];
    let settled = 0;
    runtime.waitImplementation = () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    gate.observeSecondaryLimit(timestamp(1_000));

    const first = gate.beforeRequest().then(() => {
      settled += 1;
    });
    const second = gate.beforeRequest().then(() => {
      settled += 1;
    });
    await vi.waitFor(() => {
      expect(runtime.waits).toHaveLength(2);
    });
    expect(settled).toBe(0);

    runtime.monotonicMs += 1_000;
    for (const resolve of resolvers) resolve();
    await Promise.all([first, second]);
    expect(settled).toBe(2);
  });

  it("clears returned state without shortening an active pause", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);
    gate.observeSecondaryLimit(timestamp(1_000));

    gate.observe(null);
    expect(gate.getState()).toBeNull();
    await gate.beforeRequest();

    expect(runtime.waits.map((entry) => entry.delayMs)).toEqual([1_000]);
  });

  it("accepts an exact-now observation as a zero delay without waiting", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);

    gate.observeSecondaryLimit(timestamp(0));
    await gate.beforeRequest();

    expect(runtime.waits).toEqual([]);
  });

  it("clears an expired deadline so a later clock change cannot resurrect it", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);
    gate.observeSecondaryLimit(timestamp(1_000));

    await gate.beforeRequest();
    expect(runtime.waits).toHaveLength(1);
    runtime.monotonicMs -= 10_000;
    await gate.beforeRequest();

    expect(runtime.waits).toHaveLength(1);
  });

  it("fails closed when the monotonic clock rolls backward during a wait", async () => {
    const runtime = new ControlledRuntime();
    let waitCount = 0;
    runtime.waitImplementation = () => {
      waitCount += 1;
      if (waitCount === 1) {
        runtime.monotonicMs -= 1;
        return Promise.resolve();
      }
      return Promise.reject(new Error("raw-second-wait-secret"));
    };
    const gate = new RateGate(runtime);
    gate.observeSecondaryLimit(timestamp(1_000));

    const error = await caught(gate.beforeRequest());

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "invalid_runtime_clock" },
    });
    expect(runtime.waits).toHaveLength(1);
    expect(JSON.stringify(serializeError(error))).not.toContain(
      "raw-second-wait-secret",
    );
  });

  it("observes and freezes primary state while positive remaining does not pause", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);
    const input = {
      remaining: 12,
      resetAt: "2026-07-18T00:01:00Z",
    };

    gate.observe(input);
    input.remaining = 0;

    expect(gate.getState()).toEqual({
      remaining: 12,
      resetAt: "2026-07-18T00:01:00.000Z",
    });
    expect(Object.isFrozen(gate.getState())).toBe(true);
    await gate.beforeRequest();
    expect(runtime.waits).toEqual([]);

    gate.observe({
      remaining: 0,
      resetAt: timestamp(60_000),
    });
    await gate.beforeRequest();
    expect(runtime.waits.map((entry) => entry.delayMs)).toEqual([60_000]);

    gate.observe(null);
    expect(gate.getState()).toBeNull();
  });

  it("records a primary limit as zero remaining and leaves secondary limits out of primary state", () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);

    gate.observePrimaryLimit(timestamp(5_000));
    expect(gate.getState()).toEqual({
      remaining: 0,
      resetAt: timestamp(5_000),
    });
    gate.observeSecondaryLimit(timestamp(6_000));
    expect(gate.getState()).toEqual({
      remaining: 0,
      resetAt: timestamp(5_000),
    });
  });

  it.each([
    ["negative remaining", { remaining: -1, resetAt: timestamp(1_000) }],
    ["fractional remaining", { remaining: 1.5, resetAt: timestamp(1_000) }],
    ["NaN remaining", { remaining: Number.NaN, resetAt: timestamp(1_000) }],
    [
      "infinite remaining",
      { remaining: Number.POSITIVE_INFINITY, resetAt: timestamp(1_000) },
    ],
    ["malformed timestamp", { remaining: 0, resetAt: "raw-secret-token" }],
    ["past timestamp", { remaining: 0, resetAt: timestamp(-1) }],
    [
      "unreasonably distant timestamp",
      {
        remaining: 0,
        resetAt: timestamp(MAX_OBSERVATION_DELAY_MS + 1),
      },
    ],
  ])(
    "rejects an invalid %s observation with a bounded error",
    (_label, state) => {
      const gate = new RateGate(new ControlledRuntime());
      const error = caughtSync(() => gate.observe(state));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: { reason: "invalid_rate_limit_observation" },
      });
      expect(JSON.stringify(serializeError(error))).not.toContain(
        "raw-secret-token",
      );
      expect(gate.getState()).toBeNull();
    },
  );

  it("accepts the maximum bounded delay and rejects one millisecond more", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);

    gate.observeSecondaryLimit(timestamp(MAX_OBSERVATION_DELAY_MS));
    await gate.beforeRequest();
    expect(runtime.waits[0]?.delayMs).toBe(MAX_OBSERVATION_DELAY_MS);

    const error = caughtSync(() =>
      gate.observeSecondaryLimit(timestamp(MAX_OBSERVATION_DELAY_MS + 1)),
    );
    expect(error.details).toEqual({
      reason: "invalid_rate_limit_observation",
    });
  });

  it.each([
    ["primary", (gate: RateGate) => gate.observePrimaryLimit("raw-secret")],
    [
      "secondary",
      (gate: RateGate) => gate.observeSecondaryLimit(timestamp(-1)),
    ],
  ])(
    "rejects a direct invalid %s observation through the same bounded boundary",
    (_label, observe) => {
      const gate = new RateGate(new ControlledRuntime());

      const error = caughtSync(() => observe(gate));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: { reason: "invalid_rate_limit_observation" },
      });
      expect(JSON.stringify(serializeError(error))).not.toContain("raw-secret");
    },
  );

  it.each([
    ["wall clock NaN", Number.NaN, MONOTONIC_NOW],
    ["wall clock negative", -1, MONOTONIC_NOW],
    ["monotonic clock infinite", WALL_NOW, Number.POSITIVE_INFINITY],
    ["monotonic clock negative", WALL_NOW, -1],
  ])(
    "rejects %s without storing partial state",
    (_label, wallMs, monotonicMs) => {
      const runtime = new ControlledRuntime();
      runtime.wallMs = wallMs;
      runtime.monotonicMs = monotonicMs;
      const gate = new RateGate(runtime);

      const error = caughtSync(() =>
        gate.observe({ remaining: 0, resetAt: timestamp(1_000) }),
      );
      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: { reason: "invalid_rate_limit_observation" },
      });
      expect(gate.getState()).toBeNull();
    },
  );

  it("maps cancellation before waiting to a fixed non-retryable domain error", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);
    gate.observeSecondaryLimit(timestamp(1_000));
    const controller = new AbortController();
    controller.abort(new Error("raw-secret-token"));

    const error = await caught(gate.beforeRequest(controller.signal));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "cancelled" },
    });
    expect(error.message).toBe("GitHub request was cancelled");
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(JSON.stringify(serializeError(error))).not.toContain(
      "raw-secret-token",
    );
    expect(runtime.waits).toEqual([]);
  });

  it("maps an already-aborted signal even when no deadline is active", async () => {
    const gate = new RateGate(new ControlledRuntime());
    const controller = new AbortController();
    controller.abort(new Error("raw-no-pause-secret"));

    const error = await caught(gate.beforeRequest(controller.signal));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "cancelled" },
    });
    expect(JSON.stringify(serializeError(error))).not.toContain(
      "raw-no-pause-secret",
    );
  });

  it("rechecks cancellation after a runtime wait resolves while ignoring abort", async () => {
    const runtime = new ControlledRuntime();
    const controller = new AbortController();
    runtime.waitImplementation = (delayMs) => {
      runtime.monotonicMs += delayMs;
      controller.abort(new Error("raw-ignored-abort-secret"));
      return Promise.resolve();
    };
    const gate = new RateGate(runtime);
    gate.observeSecondaryLimit(timestamp(1_000));

    const error = await caught(gate.beforeRequest(controller.signal));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "cancelled" },
    });
    expect(JSON.stringify(serializeError(error))).not.toContain(
      "raw-ignored-abort-secret",
    );
  });

  it("maps cancellation during a wait without propagating the wait failure or abort reason", async () => {
    const runtime = new ControlledRuntime();
    const gate = new RateGate(runtime);
    const controller = new AbortController();
    let rejectWait: ((reason?: unknown) => void) | undefined;
    runtime.waitImplementation = () =>
      new Promise<void>((_resolve, reject) => {
        rejectWait = reject;
      });
    gate.observeSecondaryLimit(timestamp(1_000));

    const pending = gate.beforeRequest(controller.signal);
    await vi.waitFor(() => {
      expect(rejectWait).toBeTypeOf("function");
    });
    controller.abort(new Error("raw-abort-secret"));
    rejectWait?.(new Error("raw-wait-secret"));
    const error = await caught(pending);

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "cancelled" },
    });
    expect(JSON.stringify(serializeError(error))).not.toMatch(
      /raw-(?:abort|wait)-secret/u,
    );
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it("maps a non-cancellation wait failure to a bounded non-retryable error", async () => {
    const runtime = new ControlledRuntime();
    runtime.waitImplementation = () =>
      Promise.reject(new Error("raw-wait-secret"));
    const gate = new RateGate(runtime);
    gate.observeSecondaryLimit(timestamp(1_000));

    const error = await caught(gate.beforeRequest());

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "wait_failed" },
    });
    expect(JSON.stringify(serializeError(error))).not.toContain(
      "raw-wait-secret",
    );
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it("does not contain network, retry-owner, credential, URL, body, or header capabilities", async () => {
    const source = await readFile(
      new URL("../../../src/github/rate-gate.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /\b(?:Octokit|fetch|XMLHttpRequest|authorization|credential|jitter|retryCount|retryIndex)\b/u,
    );
    expect(source).not.toMatch(/https?:\/\//u);
  });
});
