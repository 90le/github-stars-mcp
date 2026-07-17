import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "../domain/errors.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import {
  initialMigration,
  SCHEMA_MIGRATIONS_SQL,
} from "./migrations/001-initial.js";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  initialMigration,
]);

function normalizedText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function migrationChecksum(migration: SqliteMigration): string {
  return createHash("sha256")
    .update(
      `${String(migration.version)}\n${migration.name}\n${normalizedText(
        migration.sql,
      )}`,
      "utf8",
    )
    .digest("hex");
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function migrationError(message: string, cause?: unknown): AppError {
  return new AppError("STORAGE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

export function migrateSqliteDatabase(
  database: Database.Database,
  appliedAtInput: string,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): void {
  const appliedAt = canonicalUtcTimestamp(
    appliedAtInput,
    "migration appliedAt",
  );
  if (database.inTransaction) {
    throw migrationError("cannot migrate inside an existing transaction");
  }

  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(SCHEMA_MIGRATIONS_SQL);

    const rows = database
      .prepare(
        `SELECT version, name, checksum
         FROM schema_migrations
         ORDER BY version`,
      )
      .all() as MigrationRow[];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const expectedVersion = index + 1;
      if (row.version !== expectedVersion) {
        throw migrationError("schema migration ledger contains a gap");
      }
      const expected = migrations[index];
      if (expected === undefined) {
        throw migrationError("database schema is newer than this binary");
      }
      if (
        expected.version !== row.version ||
        expected.name !== row.name ||
        migrationChecksum(expected) !== row.checksum
      ) {
        throw migrationError("schema migration checksum or name drift");
      }
    }

    for (let index = rows.length; index < migrations.length; index += 1) {
      const migration = migrations[index]!;
      if (
        migration.version !== index + 1 ||
        migration.name.length === 0 ||
        migration.name !== migration.name.trim()
      ) {
        throw migrationError("binary migration list is not contiguous");
      }
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations(version,name,checksum,applied_at)
           VALUES (@version,@name,@checksum,@appliedAt)`,
        )
        .run({
          version: migration.version,
          name: migration.name,
          checksum: migrationChecksum(migration),
          appliedAt,
        });
    }

    const violations = database.pragma("foreign_key_check");
    if (!Array.isArray(violations) || violations.length > 0) {
      throw migrationError("foreign key validation failed after migration");
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
    }
    if (error instanceof AppError) throw error;
    throw migrationError("SQLite migration failed", error);
  }
}
