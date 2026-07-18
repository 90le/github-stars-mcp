import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SystemRuntime } from "../../../src/app/ports/runtime-port.js";
import type { StoragePort } from "../../../src/app/ports/storage-port.js";
import type { AppConfig } from "../../../src/config.js";
import { ToolNames } from "../../../src/mcp/schemas/common.js";
import { runServer, type SignalSource } from "../../../src/server.js";
import { fakeServices } from "../../fixtures/fake-services.js";

const CONFIG: AppConfig = Object.freeze({
  host: "github.com",
  authMode: "env",
  dataDir: "C:\\state",
  logLevel: "info",
  readOnly: true,
  maxReadConcurrency: 4,
  writeIntervalMs: 1_000,
  maxPlanActions: 5_000,
  planTtlMinutes: 1_440,
});

class TestSignals implements SignalSource {
  readonly #listeners = new Set<() => void>();

  on(_signal: NodeJS.Signals, listener: () => void): void {
    this.#listeners.add(listener);
  }

  off(_signal: NodeJS.Signals, listener: () => void): void {
    this.#listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function startupStore(): StoragePort {
  return {
    migrate: () => undefined,
    recoverIncompleteSnapshots: () => [],
    recoverInterruptedRuns: () => [],
    close: () => undefined,
  } as unknown as StoragePort;
}

describe("stdio protocol", () => {
  it("writes only JSON-RPC to stdout through initialize, list, and shutdown", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new TestSignals();
    let rawOutput = "";
    let rawLogs = "";
    output.setEncoding("utf8").on("data", (chunk: string) => {
      rawOutput += chunk;
    });
    const lines = createInterface({ input: output });
    const responses = lines[Symbol.asyncIterator]();
    const running = runServer({
      config: CONFIG,
      input,
      output,
      loggerSink: {
        write(chunk) {
          rawLogs += chunk;
          return true;
        },
      },
      dependencies: {
        runtime: new SystemRuntime(),
        signalSource: signals,
        storeFactory: startupStore,
        serviceFactory: () => Promise.resolve(fakeServices()),
      },
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "stdio-contract", version: "1.0.0" },
        },
      })}\n`,
    );
    const initialized = JSON.parse(
      (await responses.next()).value as string,
    ) as {
      id: number;
      result: {
        serverInfo: { name: string };
        instructions: string;
      };
    };
    expect(initialized).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "github-stars-mcp" } },
    });
    expect(initialized.result.instructions).toContain("explicit authorization");

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })}\n`,
    );
    const listed = JSON.parse((await responses.next()).value as string) as {
      id: number;
      result: { tools: { name: string }[] };
    };
    expect(listed.id).toBe(2);
    expect(listed.result.tools).toHaveLength(ToolNames.length);
    expect(listed.result.tools.map((tool) => tool.name).sort()).toEqual(
      [...ToolNames].sort(),
    );

    signals.emit();
    await running;
    lines.close();
    for (const line of rawOutput.trim().split(/\r?\n/u)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(rawOutput).not.toContain("GitHub Stars MCP server started");
    expect(rawLogs).toContain('"event":"server_started"');
  });
});
