import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { SystemRuntime } from "../../src/app/ports/runtime-port.js";
import type { StoragePort } from "../../src/app/ports/storage-port.js";
import type { ServiceRegistry } from "../../src/app/services/service-registry.js";
import type {
  StatusInput,
  StatusResult,
} from "../../src/app/services/status-service.js";
import type { AppConfig } from "../../src/config.js";
import { runServer, type SignalSource } from "../../src/server.js";
import { fakeServices } from "../fixtures/fake-services.js";

const CONFIG: AppConfig = Object.freeze({
  host: "github.com",
  authMode: "env",
  dataDir: "C:\\state",
  logLevel: "error",
  readOnly: true,
  maxReadConcurrency: 4,
  writeIntervalMs: 1_000,
  maxPlanActions: 5_000,
  planTtlMinutes: 1_440,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

class TestSignals implements SignalSource {
  readonly #listeners = new Map<NodeJS.Signals, Set<() => void>>();

  on(signal: NodeJS.Signals, listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
  }

  off(signal: NodeJS.Signals, listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of this.#listeners.get(signal) ?? []) listener();
  }
}

class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  constructor(
    private readonly inner: Transport,
    private readonly events: string[],
  ) {}

  start(): Promise<void> {
    this.events.push("connectTransport");
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    return this.inner.start();
  }

  send(
    ...parameters: Parameters<Transport["send"]>
  ): ReturnType<Transport["send"]> {
    return this.inner.send(...parameters);
  }

  close(): Promise<void> {
    this.events.push("closeTransport");
    return this.inner.close();
  }
}

function lifecycleStore(events: string[]): StoragePort {
  return {
    migrate: () => events.push("migrate"),
    recoverIncompleteSnapshots: () => {
      events.push("recoverIncompleteSnapshots");
      return [];
    },
    recoverInterruptedRuns: () => {
      events.push("recoverInterruptedRuns");
      return [];
    },
    close: () => events.push("closeStore"),
  } as unknown as StoragePort;
}

describe("runServer lifecycle", () => {
  it("recovers local state before connecting and closes in safe order", async () => {
    const events: string[] = [];
    const signals = new TestSignals();
    const [clientTransport, rawServerTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lifecycle-test", version: "1.0.0" });
    const running = runServer({
      config: CONFIG,
      loggerSink: { write: () => true },
      dependencies: {
        runtime: new SystemRuntime(),
        signalSource: signals,
        storeFactory: () => lifecycleStore(events),
        serviceFactory: () => {
          events.push("createServices");
          return Promise.resolve(fakeServices());
        },
        transportFactory: () =>
          new RecordingTransport(rawServerTransport, events),
      },
    });

    await client.connect(clientTransport);
    expect(events.slice(0, 4)).toEqual([
      "migrate",
      "recoverIncompleteSnapshots",
      "recoverInterruptedRuns",
      "createServices",
    ]);
    expect(events[4]).toBe("connectTransport");

    signals.emit("SIGTERM");
    await running;
    expect(events.slice(-2)).toEqual(["closeTransport", "closeStore"]);
  });

  it("aborts an active handler but drains its safety cleanup before close", async () => {
    const events: string[] = [];
    const signals = new TestSignals();
    const entered = deferred<void>();
    const base = fakeServices();
    const services: ServiceRegistry = {
      ...base,
      status: {
        status: vi.fn(
          async (
            input?: StatusInput,
            signal?: AbortSignal,
          ): Promise<StatusResult> => {
            entered.resolve();
            await new Promise<void>((resolve) => {
              signal?.addEventListener(
                "abort",
                () => {
                  events.push("abort");
                  resolve();
                },
                { once: true },
              );
            });
            events.push("finishAudit");
            await Promise.resolve();
            events.push("waitSafetyWindow");
            await Promise.resolve();
            events.push("releaseLease");
            return base.status.status(input, signal);
          },
        ),
      },
    };
    const [clientTransport, rawServerTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lifecycle-test", version: "1.0.0" });
    const running = runServer({
      config: CONFIG,
      loggerSink: { write: () => true },
      dependencies: {
        runtime: new SystemRuntime(),
        signalSource: signals,
        storeFactory: () => lifecycleStore(events),
        serviceFactory: () => Promise.resolve(services),
        transportFactory: () =>
          new RecordingTransport(rawServerTransport, events),
      },
    });
    await client.connect(clientTransport);

    const call = client.callTool({
      name: "github_stars_status",
      arguments: {},
    });
    await entered.promise;
    signals.emit("SIGINT");
    await running;
    await Promise.allSettled([call]);

    expect(events).toEqual(
      expect.arrayContaining([
        "abort",
        "finishAudit",
        "waitSafetyWindow",
        "releaseLease",
        "closeTransport",
        "closeStore",
      ]),
    );
    expect(events.indexOf("abort")).toBeLessThan(events.indexOf("finishAudit"));
    expect(events.indexOf("finishAudit")).toBeLessThan(
      events.indexOf("waitSafetyWindow"),
    );
    expect(events.indexOf("waitSafetyWindow")).toBeLessThan(
      events.indexOf("releaseLease"),
    );
    expect(events.indexOf("releaseLease")).toBeLessThan(
      events.indexOf("closeTransport"),
    );
    expect(events.indexOf("closeTransport")).toBeLessThan(
      events.indexOf("closeStore"),
    );
  });
});
