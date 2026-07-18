import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
  runInImmediateTransaction,
  runInNewImmediateTransaction,
  SQLITE_MIGRATIONS,
  sqliteVersionAtLeast,
} from "../../../src/storage/sqlite-database.js";

type PragmaOptions = Parameters<Database.Database["pragma"]>[1];

const roots: string[] = [];

function runWorker(
  mode: "migration" | "secret",
  workerId: "1" | "2",
  databasePath: string,
  coordinationDirectory: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const child = spawn(
      process.execPath,
      [
        vitest,
        "run",
        "test/integration/storage/concurrency-worker.test.ts",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_STARS_CONCURRENCY_MODE: mode,
          GITHUB_STARS_CONCURRENCY_WORKER_ID: workerId,
          GITHUB_STARS_CONCURRENCY_DATABASE: databasePath,
          GITHUB_STARS_CONCURRENCY_COORDINATION: coordinationDirectory,
        },
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`concurrency worker failed (${String(code)}): ${output}`),
        );
    });
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("SQLite connection hardening", () => {
  test("uses a SAVEPOINT so a caught inner failure cannot leak into an outer commit", () => {
    const database = openSqliteDatabase(":memory:");
    database.exec(
      "CREATE TABLE transaction_probe(value TEXT PRIMARY KEY) STRICT",
    );

    runInNewImmediateTransaction(database, () => {
      database
        .prepare("INSERT INTO transaction_probe(value) VALUES (?)")
        .run("outer");
      expect(() =>
        runInImmediateTransaction(database, () => {
          database
            .prepare("INSERT INTO transaction_probe(value) VALUES (?)")
            .run("inner");
          throw new Error("rollback inner");
        }),
      ).toThrow(/rollback inner/u);
      database
        .prepare("INSERT INTO transaction_probe(value) VALUES (?)")
        .run("outer-after-catch");
    });

    expect(
      database
        .prepare("SELECT value FROM transaction_probe ORDER BY value")
        .pluck()
        .all(),
    ).toEqual(["outer", "outer-after-catch"]);
    database.close();
  });

  test("requires a new immediate transaction to start at the top level", () => {
    const database = openSqliteDatabase(":memory:");
    expect(
      runInNewImmediateTransaction(database, () => database.inTransaction),
    ).toBe(true);

    database.exec("BEGIN IMMEDIATE");
    let caught: unknown;
    try {
      runInNewImmediateTransaction(database, () => undefined);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("PRECONDITION_FAILED");
    database.exec("ROLLBACK");
    database.close();
  });

  test("compares SQLite versions numerically rather than lexically", () => {
    expect(sqliteVersionAtLeast("3.38.0", [3, 38, 0])).toBe(true);
    expect(sqliteVersionAtLeast("3.100.0", [3, 38, 0])).toBe(true);
    expect(sqliteVersionAtLeast("10.0.0", [3, 38, 0])).toBe(true);
    expect(sqliteVersionAtLeast("3.9.99", [3, 38, 0])).toBe(false);
    expect(sqliteVersionAtLeast("3.37.99", [3, 38, 0])).toBe(false);
    expect(sqliteVersionAtLeast("3.38x.0", [3, 38, 0])).toBe(false);
  });
  test("uses WAL and zero mmap for a file database and supports two readers", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-db-"));
    roots.push(root);
    const path = join(root, "state.sqlite3");
    const first = openSqliteDatabase(path);
    migrateSqliteDatabase(first, "2026-07-16T00:00:00.000Z");
    const second = openSqliteDatabase(path);
    migrateSqliteDatabase(second, "2026-07-16T00:00:01.000Z");

    expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(first.pragma("mmap_size", { simple: true })).toBe(0);
    expect(second.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      second.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(SQLITE_MIGRATIONS.length);
    second.close();
    first.close();
  });

  test("allows a WAL reader to see the last commit during an active writer", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-db-"));
    roots.push(root);
    const path = join(root, "state.sqlite3");
    const writer = openSqliteDatabase(path);
    migrateSqliteDatabase(writer, "2026-07-16T00:00:00.000Z");
    writer.exec(
      "CREATE TABLE wal_probe(value INTEGER PRIMARY KEY) STRICT; INSERT INTO wal_probe VALUES (1)",
    );
    const reader = openSqliteDatabase(path);
    writer.exec("BEGIN IMMEDIATE; INSERT INTO wal_probe VALUES (2)");
    expect(reader.prepare("SELECT COUNT(*) FROM wal_probe").pluck().get()).toBe(
      1,
    );
    writer.exec("COMMIT");
    expect(reader.prepare("SELECT COUNT(*) FROM wal_probe").pluck().get()).toBe(
      2,
    );
    reader.close();
    writer.close();
  });

  test(
    "two real concurrent first-start processes converge on one migration",
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "github-stars-db-"));
      roots.push(root);
      const path = join(root, "state.sqlite3");
      await Promise.all([
        runWorker("migration", "1", path, root),
        runWorker("migration", "2", path, root),
      ]);
      const database = openSqliteDatabase(path);
      expect(
        database
          .prepare("SELECT COUNT(*) FROM schema_migrations")
          .pluck()
          .get(),
      ).toBe(SQLITE_MIGRATIONS.length);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      database.close();
    },
  );

  test("retries a transient busy error while enabling WAL", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-db-"));
    roots.push(root);
    const path = join(root, "state.sqlite3");
    const originalPragma = Reflect.get(Database.prototype, "pragma");
    let injectedBusyErrors = 0;
    const pragmaSpy = vi
      .spyOn(Database.prototype, "pragma")
      .mockImplementation(function (
        this: Database.Database,
        source: string,
        options?: PragmaOptions,
      ): unknown {
        if (source === "journal_mode = WAL" && injectedBusyErrors === 0) {
          injectedBusyErrors += 1;
          throw new Database.SqliteError("database is locked", "SQLITE_BUSY");
        }
        return Reflect.apply(originalPragma, this, [source, options]);
      });

    let database: Database.Database | undefined;
    try {
      database = openSqliteDatabase(path);
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(injectedBusyErrors).toBe(1);
    } finally {
      database?.close();
      pragmaSpy.mockRestore();
    }
  });

  test("does not rewrite the persistent WAL mode on later opens", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-db-"));
    roots.push(root);
    const path = join(root, "state.sqlite3");
    const bootstrap = openSqliteDatabase(path);
    bootstrap.close();

    const originalPragma = Reflect.get(Database.prototype, "pragma");
    let walWriteAttempts = 0;
    const pragmaSpy = vi
      .spyOn(Database.prototype, "pragma")
      .mockImplementation(function (
        this: Database.Database,
        source: string,
        options?: PragmaOptions,
      ): unknown {
        if (source === "journal_mode = WAL") {
          walWriteAttempts += 1;
          throw new Database.SqliteError("database is locked", "SQLITE_BUSY");
        }
        return Reflect.apply(originalPragma, this, [source, options]);
      });

    let database: Database.Database | undefined;
    try {
      database = openSqliteDatabase(path);
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(walWriteAttempts).toBe(0);
    } finally {
      database?.close();
      pragmaSpy.mockRestore();
    }
  });

  test("closes and reports a storage error for a non-UTF-8 database", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-db-"));
    roots.push(root);
    const path = join(root, "utf16.sqlite3");
    const bootstrap = openSqliteDatabase(path);
    bootstrap.close();
    const raw = new (await import("better-sqlite3")).default(path);
    raw.pragma("encoding = 'UTF-16le'");
    raw.exec("CREATE TABLE marker(value TEXT)");
    raw.close();

    expect(() => openSqliteDatabase(path)).toThrow(/UTF-8/u);
  });
});
