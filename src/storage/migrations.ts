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

type SqlToken =
  | { readonly kind: "semicolon" }
  | { readonly kind: "word"; readonly value: string };

const TRANSACTION_CONTROL = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
]);

function isSqlWordStart(character: string): boolean {
  return /[A-Z_]/iu.test(character);
}

function isSqlWord(character: string): boolean {
  return /[A-Z0-9_$]/iu.test(character);
}

function* sqlTokens(sql: string): Generator<SqlToken> {
  let index = 0;
  while (index < sql.length) {
    const character = sql.charAt(index);
    const next = sql.charAt(index + 1);
    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && !/[\r\n]/u.test(sql.charAt(index))) {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      const closing = character === "[" ? "]" : character;
      index += 1;
      while (index < sql.length) {
        if (sql.charAt(index) !== closing) {
          index += 1;
          continue;
        }
        if (closing !== "]" && sql.charAt(index + 1) === closing) {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    }
    if (character === ";") {
      yield { kind: "semicolon" };
      index += 1;
      continue;
    }
    if (isSqlWordStart(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && isSqlWord(sql.charAt(index))) {
        index += 1;
      }
      yield {
        kind: "word",
        value: sql.slice(start, index).toUpperCase(),
      };
      continue;
    }
    index += 1;
  }
}

function assertNoTransactionControl(sql: string): void {
  let statementStart = true;
  let createPrefix = 0;
  let inTrigger = false;
  let triggerBody = false;
  let triggerEnded = false;
  let triggerStatementStart = false;
  let caseDepth = 0;

  for (const token of sqlTokens(sql)) {
    if (token.kind === "semicolon") {
      if (!inTrigger || !triggerBody || triggerEnded) {
        statementStart = true;
        createPrefix = 0;
        inTrigger = false;
        triggerBody = false;
        triggerEnded = false;
        triggerStatementStart = false;
        caseDepth = 0;
      } else {
        triggerStatementStart = true;
      }
      continue;
    }

    const word = token.value;
    if (statementStart) {
      if (TRANSACTION_CONTROL.has(word)) {
        throw migrationError(
          `migration SQL cannot contain transaction control (${word})`,
        );
      }
      statementStart = false;
      createPrefix = word === "CREATE" ? 1 : 0;
      continue;
    }

    if (!inTrigger) {
      if (createPrefix === 1 && (word === "TEMP" || word === "TEMPORARY")) {
        createPrefix = 2;
      } else if (
        (createPrefix === 1 || createPrefix === 2) &&
        word === "TRIGGER"
      ) {
        inTrigger = true;
      } else {
        createPrefix = 0;
      }
      continue;
    }

    if (!triggerBody) {
      if (word === "BEGIN") {
        triggerBody = true;
        triggerStatementStart = true;
      }
      continue;
    }
    if (triggerEnded) continue;
    if (triggerStatementStart) {
      if (word === "END" && caseDepth === 0) {
        triggerEnded = true;
        triggerStatementStart = false;
        continue;
      }
      if (TRANSACTION_CONTROL.has(word)) {
        throw migrationError(
          `migration SQL cannot contain transaction control (${word})`,
        );
      }
      triggerStatementStart = false;
    }
    if (word === "CASE") {
      caseDepth += 1;
    } else if (word === "END") {
      if (caseDepth > 0) caseDepth -= 1;
      else triggerEnded = true;
    }
  }
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
  for (const migration of migrations) {
    assertNoTransactionControl(migration.sql);
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
      if (!database.inTransaction) {
        throw migrationError(
          "migration SQL escaped the required outer transaction",
        );
      }
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

    if (!database.inTransaction) {
      throw migrationError(
        "migration SQL escaped the required outer transaction",
      );
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
