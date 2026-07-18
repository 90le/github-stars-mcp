import { AppError } from "../../domain/errors.js";

type CoordinatedOperation<T> = (signal: AbortSignal) => PromiseLike<T> | T;

function shuttingDown(): AppError {
  return new AppError("CAPABILITY_UNAVAILABLE", "The server is shutting down", {
    retryable: false,
    details: { reason: "shutting_down" },
  });
}

function shutdownAbortReason(): DOMException {
  return new DOMException("The server is shutting down", "AbortError");
}

export class OperationCoordinator {
  #accepting = true;
  readonly #active = new Set<Promise<unknown>>();
  readonly #controllers = new Set<AbortController>();
  readonly #drainWaiters = new Set<() => void>();

  get activeCount(): number {
    return this.#active.size;
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  abort(): void {
    for (const controller of this.#controllers) {
      if (!controller.signal.aborted) {
        controller.abort(shutdownAbortReason());
      }
    }
  }

  run<T>(
    operation: CoordinatedOperation<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    if (!this.#accepting) throw shuttingDown();

    const controller = new AbortController();
    this.#controllers.add(controller);
    let removeParentListener = (): void => undefined;

    try {
      if (parentSignal !== undefined) {
        const forwardAbort = (): void => {
          if (!controller.signal.aborted) {
            controller.abort(parentSignal.reason);
          }
        };
        if (parentSignal.aborted) {
          forwardAbort();
        } else {
          parentSignal.addEventListener("abort", forwardAbort, { once: true });
          removeParentListener = () =>
            parentSignal.removeEventListener("abort", forwardAbort);
        }
      }
    } catch (error) {
      this.#controllers.delete(controller);
      throw error;
    }

    let result: Promise<T>;
    try {
      result = Promise.resolve(operation(controller.signal));
    } catch (error) {
      removeParentListener();
      this.#controllers.delete(controller);
      this.#resolveDrainWaiters();
      throw error;
    }

    const tracked = result.finally(() => {
      removeParentListener();
      this.#controllers.delete(controller);
      this.#active.delete(tracked);
      this.#resolveDrainWaiters();
    });
    this.#active.add(tracked);
    return tracked;
  }

  drain(): Promise<void> {
    if (this.#active.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#drainWaiters.add(resolve);
    });
  }

  #resolveDrainWaiters(): void {
    if (this.#active.size !== 0) return;
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}
