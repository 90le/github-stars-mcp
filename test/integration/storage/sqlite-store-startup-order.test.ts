import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";

test("orders startup validation before secrets and wipes key copies before repositories", async () => {
  const trace: string[] = [];
  let rejectValidation = true;
  let selectedKey: Uint8Array | undefined;
  let codecCopy: Uint8Array | undefined;
  const dataDirectory = resolve("sqlite-store-startup-order-state");
  const database = {
    close() {
      trace.push("close");
    },
  };

  vi.doMock("../../../src/storage/state-directory.js", () => ({
    prepareStateDirectory() {
      trace.push("prepare");
      return {
        dataDir: dataDirectory,
        databasePath: join(dataDirectory, "github-stars-mcp.sqlite3"),
        platformLimitations: [],
      };
    },
    validateStateFilesAfterOpen() {
      trace.push("validate");
      if (rejectValidation) throw new Error("post-open validation failed");
    },
  }));
  vi.doMock("../../../src/storage/sqlite-database.js", () => ({
    SQLITE_MIGRATIONS: [{ version: 1, name: "initial", sql: "SELECT 1" }],
    migrationChecksum: () => "checksum",
    openSqliteDatabase() {
      trace.push("open");
      return database;
    },
    migrateSqliteDatabase() {
      trace.push("migrate");
    },
  }));
  vi.doMock("../../../src/storage/runtime-secret-repository.js", () => ({
    RuntimeSecretRepository: class {
      getOrCreateCursorSigningKey(): Uint8Array {
        trace.push("secret");
        selectedKey = new Uint8Array(32).fill(7);
        return selectedKey;
      }
    },
  }));
  vi.doMock("../../../src/domain/cursor.js", () => ({
    createCursorCodec(key: Uint8Array) {
      trace.push("codec");
      codecCopy = key;
      return {};
    },
  }));
  vi.doMock("../../../src/storage/lease-repository.js", () => ({
    LeaseRepository: class {
      constructor() {
        trace.push(
          `lease:wiped=${String(
            selectedKey?.every((value) => value === 0) === true &&
              codecCopy?.every((value) => value === 0) === true,
          )}`,
        );
      }
    },
  }));
  vi.doMock("../../../src/storage/snapshot-repository.js", () => ({
    SnapshotRepository: class {
      constructor() {
        trace.push("snapshot");
      }
    },
  }));
  vi.doMock("../../../src/storage/plan-run-repository.js", () => ({
    PlanRunRepository: class {
      constructor() {
        trace.push("plan-run");
      }
    },
  }));

  try {
    const { SQLiteStore } =
      await import("../../../src/storage/sqlite-store.js");
    const store = new SQLiteStore(dataDirectory, {
      now: () => "2026-07-16T00:00:00.000Z",
    });
    let firstFailure: unknown;
    try {
      store.migrate();
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({ code: "STORAGE_ERROR" });
    expect(trace).toEqual(["prepare", "open", "migrate", "validate", "close"]);

    rejectValidation = false;
    store.migrate();
    expect(trace).toEqual([
      "prepare",
      "open",
      "migrate",
      "validate",
      "close",
      "prepare",
      "open",
      "migrate",
      "validate",
      "secret",
      "codec",
      "lease:wiped=true",
      "snapshot",
      "plan-run",
    ]);
    store.close();
    expect(trace.at(-1)).toBe("close");
  } finally {
    vi.doUnmock("../../../src/storage/state-directory.js");
    vi.doUnmock("../../../src/storage/sqlite-database.js");
    vi.doUnmock("../../../src/storage/runtime-secret-repository.js");
    vi.doUnmock("../../../src/domain/cursor.js");
    vi.doUnmock("../../../src/storage/lease-repository.js");
    vi.doUnmock("../../../src/storage/snapshot-repository.js");
    vi.doUnmock("../../../src/storage/plan-run-repository.js");
    vi.resetModules();
  }
});
