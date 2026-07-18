import { describe, expect, it } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import { OperationCoordinator } from "../../../src/app/services/operation-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("OperationCoordinator", () => {
  it("closes admission synchronously and drains active operations", async () => {
    const coordinator = new OperationCoordinator();
    const release = deferred<void>();
    const entered = deferred<void>();
    const active = coordinator.run(async (signal) => {
      expect(signal.aborted).toBe(false);
      entered.resolve();
      await release.promise;
      return "done";
    });
    await entered.promise;

    expect(coordinator.activeCount).toBe(1);
    coordinator.stopAccepting();
    let admissionError: unknown;
    try {
      void coordinator.run(() => Promise.resolve("late"));
    } catch (error) {
      admissionError = error;
    }
    expect(admissionError).toBeInstanceOf(AppError);
    expect((admissionError as AppError).code).toBe("CAPABILITY_UNAVAILABLE");
    expect((admissionError as AppError).details).toEqual({
      reason: "shutting_down",
    });

    let drained = false;
    const draining = coordinator.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release.resolve();
    await expect(active).resolves.toBe("done");
    await draining;
    expect(coordinator.activeCount).toBe(0);
  });

  it("aborts every child but lets operation cleanup finish before drain", async () => {
    const coordinator = new OperationCoordinator();
    const cleanup = deferred<void>();
    const entered = deferred<void>();
    const events: string[] = [];
    const active = coordinator.run(async (signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            events.push("abort");
            resolve();
          },
          { once: true },
        );
      });
      try {
        events.push("caught");
        return "cancelled";
      } finally {
        await cleanup.promise;
        events.push("cleanup");
      }
    });
    await entered.promise;

    coordinator.stopAccepting();
    coordinator.abort();
    coordinator.abort();
    const draining = coordinator.drain().then(() => events.push("drained"));
    await Promise.resolve();
    expect(events).toEqual(["abort", "caught"]);

    cleanup.resolve();
    await expect(active).resolves.toBe("cancelled");
    await draining;
    expect(events).toEqual(["abort", "caught", "cleanup", "drained"]);
  });

  it("links a caller abort signal without aborting sibling operations", async () => {
    const coordinator = new OperationCoordinator();
    const firstParent = new AbortController();
    const firstSeen = deferred<void>();
    const siblingRelease = deferred<void>();
    let siblingAborted = false;

    const first = coordinator.run(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            firstSeen.resolve();
            resolve();
          },
          { once: true },
        );
      });
      return String(signal.reason);
    }, firstParent.signal);
    const sibling = coordinator.run(async (signal) => {
      signal.addEventListener(
        "abort",
        () => {
          siblingAborted = true;
        },
        { once: true },
      );
      await siblingRelease.promise;
    });

    firstParent.abort("caller");
    await firstSeen.promise;
    await expect(first).resolves.toBe("caller");
    expect(siblingAborted).toBe(false);

    siblingRelease.resolve();
    await sibling;
    await coordinator.drain();
  });

  it("removes failed and synchronously throwing operations", async () => {
    const coordinator = new OperationCoordinator();
    const failure = new Error("failure");

    await expect(coordinator.run(() => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    await coordinator.drain();
    expect(coordinator.activeCount).toBe(0);

    expect(() =>
      coordinator.run(() => {
        throw failure;
      }),
    ).toThrow(failure);
    await coordinator.drain();
    expect(coordinator.activeCount).toBe(0);
  });
});
