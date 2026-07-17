import Database from "better-sqlite3";
import { AppError } from "../domain/errors.js";
import {
  migrateSqliteDatabase,
  migrationChecksum,
  SQLITE_MIGRATIONS,
  type SqliteMigration,
} from "./migrations.js";
import {
  runInImmediateTransaction,
  runInNewImmediateTransaction,
} from "./sqlite-transaction.js";

function storageError(message: string, cause?: unknown): AppError {
  return new AppError("STORAGE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

export function sqliteVersionAtLeast(
  actual: string,
  minimum: readonly [number, number, number],
): boolean {
  const parts = actual.split(".");
  const parsed = minimum.map((_, index) => {
    const value = parts[index];
    return value === undefined || !/^\d+$/u.test(value)
      ? Number.NaN
      : Number.parseInt(value, 10);
  });
  if (parsed.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return false;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index]! > minimum[index]!) return true;
    if (parsed[index]! < minimum[index]!) return false;
  }
  return true;
}

function simplePragma(
  database: Database.Database,
  source: string,
): string | number | undefined {
  const value = database.pragma(source, { simple: true });
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function verifyPragma(
  database: Database.Database,
  name: string,
  expected: string | number,
): void {
  const actual = simplePragma(database, name);
  if (
    (typeof expected === "string" &&
      String(actual).toLowerCase() !== expected.toLowerCase()) ||
    (typeof expected === "number" && Number(actual) !== expected)
  ) {
    throw storageError(`SQLite refused required PRAGMA ${name}`);
  }
}

export function openSqliteDatabase(path: string): Database.Database {
  let database: Database.Database | undefined;
  try {
    database = new Database(path);
    const versionRow = database
      .prepare("SELECT sqlite_version() AS version")
      .get() as { readonly version?: unknown } | undefined;
    if (
      typeof versionRow?.version !== "string" ||
      !sqliteVersionAtLeast(versionRow.version, [3, 38, 0])
    ) {
      throw storageError("SQLite 3.38.0 or newer is required");
    }

    const encoding = simplePragma(database, "encoding");
    if (typeof encoding !== "string" || encoding.toUpperCase() !== "UTF-8") {
      throw storageError("SQLite database encoding must be UTF-8");
    }
    const jsonProbe = database
      .prepare(
        `SELECT json_valid('{"ok":true}') AS valid,
                json_type('{"ok":true}','$.ok') AS kind`,
      )
      .get() as { readonly valid?: unknown; readonly kind?: unknown };
    if (jsonProbe.valid !== 1 || jsonProbe.kind !== "true") {
      throw storageError("SQLite JSON functions are unavailable");
    }

    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    database.pragma("trusted_schema = OFF");
    database.pragma("synchronous = FULL");
    if (path !== ":memory:") {
      const journalMode = database.pragma("journal_mode = WAL", {
        simple: true,
      });
      if (
        typeof journalMode !== "string" ||
        journalMode.toLowerCase() !== "wal"
      ) {
        throw storageError("SQLite WAL mode is required");
      }
      database.pragma("mmap_size = 0");
      verifyPragma(database, "mmap_size", 0);
      verifyPragma(database, "journal_mode", "wal");
    }

    verifyPragma(database, "busy_timeout", 5_000);
    verifyPragma(database, "foreign_keys", 1);
    verifyPragma(database, "trusted_schema", 0);
    verifyPragma(database, "synchronous", 2);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the primary failure.
    }
    if (error instanceof AppError) throw error;
    throw storageError("failed to open SQLite database", error);
  }
}

export {
  migrateSqliteDatabase,
  migrationChecksum,
  runInImmediateTransaction,
  runInNewImmediateTransaction,
  SQLITE_MIGRATIONS,
  type SqliteMigration,
};
