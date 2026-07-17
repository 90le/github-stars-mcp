import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import {
  MutationPacer,
  type MutationPacerRuntime,
} from "../../../src/app/services/mutation-pacer.js";

class AutoAdvanceRuntime implements MutationPacerRuntime {
  monotonic = 0;
  readonly waits: Array<
    Readonly<{ delayMs: number; signal: AbortSignal | undefined }>
  > = [];

  monotonicMs(): number {
    return this.monotonic;
  }

  wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.waits.push(Object.freeze({ delayMs, signal }));
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    this.monotonic += delayMs;
    return Promise.resolve();
  }
}

type PendingWait = {
  readonly delayMs: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

class ManualRuntime implements MutationPacerRuntime {
  monotonic = 0;
  readonly waits: PendingWait[] = [];

  monotonicMs(): number {
    return this.monotonic;
  }

  wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = (): void => {
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waits.push({
        delayMs,
        signal,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          this.monotonic += delayMs;
          resolve();
        },
        reject,
      });
    });
  }
}

function dispatchPreparation<T>(
  prepared: T,
): Readonly<{ kind: "dispatch"; prepared: T }> {
  return Object.freeze({ kind: "dispatch", prepared });
}

function skippedOutcome() {
  return Object.freeze({
    kind: "skipped" as const,
    before: Object.freeze({ starred: true }),
    after: Object.freeze({ starred: true }),
    receipt: null,
  });
}

describe("MutationPacer", () => {
  it("starts concurrent mutations FIFO at 0, 1000, and 2000 with one active dispatch", async () => {
    const runtime = new AutoAdvanceRuntime();
    const pacer = new MutationPacer(runtime);
    const starts: number[] = [];
    let active = 0;
    let maximumConcurrency = 0;

    const execute = (value: number) =>
      pacer.run({
        prepare: () => Promise.resolve(dispatchPreparation(value)),
        dispatch: async (prepared) => {
          starts.push(runtime.monotonic);
          active += 1;
          maximumConcurrency = Math.max(maximumConcurrency, active);
          await Promise.resolve();
          active -= 1;
          return prepared;
        },
      });

    await expect(
      Promise.all([execute(1), execute(2), execute(3)]),
    ).resolves.toEqual([1, 2, 3]);
    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(maximumConcurrency).toBe(1);
    expect(runtime.waits.map((entry) => entry.delayMs)).toEqual([1_000, 1_000]);
  });

  it("aborts an interruptible queued wait without preparing or dispatching", async () => {
    const runtime = new ManualRuntime();
    const pacer = new MutationPacer(runtime);
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = pacer.run({
      prepare: () => Promise.resolve(dispatchPreparation("first")),
      dispatch: () => firstDispatch,
    });
    await vi.waitFor(() => {
      expect(runtime.monotonic).toBe(0);
    });

    const controller = new AbortController();
    const prepare = vi.fn(() => Promise.resolve(dispatchPreparation("second")));
    const dispatch = vi.fn(() => Promise.resolve("second"));
    const second = pacer.run({
      signal: controller.signal,
      prepare,
      dispatch,
    });

    releaseFirst();
    await first;
    await vi.waitFor(() => {
      expect(runtime.waits).toHaveLength(1);
    });
    controller.abort();

    await expect(second).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "cancelled" },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("checks cancellation after prepare and before the unique dispatch", async () => {
    const runtime = new AutoAdvanceRuntime();
    const pacer = new MutationPacer(runtime);
    const controller = new AbortController();
    const dispatch = vi.fn(() => Promise.resolve("unexpected"));

    const result = pacer.run({
      signal: controller.signal,
      prepare: () => {
        controller.abort();
        return Promise.resolve(dispatchPreparation("prepared"));
      },
      dispatch,
    });

    await expect(result).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "cancelled" },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not move the safety window for skipped operations", async () => {
    const runtime = new AutoAdvanceRuntime();
    const pacer = new MutationPacer(runtime);
    const dispatch = vi.fn(() => Promise.resolve("unexpected"));

    await expect(
      pacer.run({
        prepare: () =>
          Promise.resolve({
            kind: "skipped" as const,
            outcome: skippedOutcome(),
          }),
        dispatch,
      }),
    ).resolves.toEqual(skippedOutcome());
    await expect(
      pacer.run({
        prepare: () =>
          Promise.resolve({
            kind: "skipped" as const,
            outcome: skippedOutcome(),
          }),
        dispatch,
      }),
    ).resolves.toEqual(skippedOutcome());

    expect(runtime.waits).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("waits a skipped read after a mutation but adds no second interval", async () => {
    const runtime = new AutoAdvanceRuntime();
    const pacer = new MutationPacer(runtime);

    await pacer.run({
      prepare: () => Promise.resolve(dispatchPreparation("mutation")),
      dispatch: () => Promise.resolve("mutation"),
    });
    await pacer.run({
      prepare: () =>
        Promise.resolve({
          kind: "skipped" as const,
          outcome: skippedOutcome(),
        }),
      dispatch: () => Promise.reject(new Error("unexpected dispatch")),
    });
    await pacer.run({
      prepare: () =>
        Promise.resolve({
          kind: "skipped" as const,
          outcome: skippedOutcome(),
        }),
      dispatch: () => Promise.reject(new Error("unexpected dispatch")),
    });

    expect(runtime.waits.map((entry) => entry.delayMs)).toEqual([1_000]);
    expect(runtime.monotonic).toBe(1_000);
  });

  it("waitForSafetyWindow retains the final non-cancellable interval", async () => {
    const runtime = new ManualRuntime();
    const pacer = new MutationPacer(runtime);
    await pacer.run({
      prepare: () => Promise.resolve(dispatchPreparation("mutation")),
      dispatch: () => Promise.resolve("mutation"),
    });

    let settled = false;
    const safety = pacer.waitForSafetyWindow().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(runtime.waits).toHaveLength(1);
    });

    expect(runtime.waits[0]?.signal).toBeUndefined();
    expect(runtime.waits[0]?.delayMs).toBe(1_000);
    expect(settled).toBe(false);
    runtime.waits[0]?.resolve();
    await safety;
    expect(settled).toBe(true);
  });

  it.each([
    ["non-finite clock", Number.NaN],
    ["negative clock", -1],
  ])("fails closed on a %s", async (_label, monotonic) => {
    const runtime: MutationPacerRuntime = {
      monotonicMs: () => monotonic,
      wait: () => Promise.resolve(),
    };
    const dispatch = vi.fn(() => Promise.resolve("unexpected"));

    await expect(
      new MutationPacer(runtime).run({
        prepare: () => Promise.resolve(dispatchPreparation("prepared")),
        dispatch,
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
