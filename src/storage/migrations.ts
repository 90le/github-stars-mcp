import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type Database from "better-sqlite3";
import { AppError } from "../domain/errors.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import {
  initialMigration,
  SCHEMA_MIGRATIONS_SQL,
} from "./migrations/001-initial.js";
import { runInNewImmediateTransaction } from "./sqlite-transaction.js";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  initialMigration,
]);

const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const numberIsSafeInteger = Number.isSafeInteger;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const reflectDefineProperty = Reflect.defineProperty;
const reflectOwnKeys = Reflect.ownKeys;
const stringFromValue = String;
const isProxy = utilTypes.isProxy;

function migrationError(message: string, cause?: unknown): AppError {
  return new AppError("STORAGE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor {
  return descriptor !== undefined && "value" in descriptor;
}

function descriptorValue(descriptor: PropertyDescriptor): unknown {
  return descriptor.value as unknown;
}

function ownPropertyDescriptors(
  input: object,
): Record<PropertyKey, PropertyDescriptor | undefined> {
  return objectGetOwnPropertyDescriptors(input);
}

function snapshotMigrationDefinition(input: unknown): SqliteMigration {
  if (
    typeof input !== "object" ||
    input === null ||
    isProxy(input) ||
    objectGetPrototypeOf(input) !== objectPrototype
  ) {
    throw migrationError(
      "migration definitions must be exact plain data objects",
    );
  }

  const descriptors = ownPropertyDescriptors(input);
  const keys = reflectOwnKeys(descriptors);
  if (keys.length !== 3) {
    throw migrationError(
      "migration definitions must be exact plain data objects",
    );
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== "version" && key !== "name" && key !== "sql") {
      throw migrationError(
        "migration definitions must be exact plain data objects",
      );
    }
  }

  const versionDescriptor = descriptors.version;
  const nameDescriptor = descriptors.name;
  const sqlDescriptor = descriptors.sql;
  if (
    !isDataDescriptor(versionDescriptor) ||
    versionDescriptor.enumerable !== true ||
    !isDataDescriptor(nameDescriptor) ||
    nameDescriptor.enumerable !== true ||
    !isDataDescriptor(sqlDescriptor) ||
    sqlDescriptor.enumerable !== true
  ) {
    throw migrationError(
      "migration definitions must contain only plain data properties",
    );
  }

  const version = descriptorValue(versionDescriptor);
  const name = descriptorValue(nameDescriptor);
  const sql = descriptorValue(sqlDescriptor);
  if (
    typeof version !== "number" ||
    !numberIsSafeInteger(version) ||
    typeof name !== "string" ||
    typeof sql !== "string"
  ) {
    throw migrationError(
      "migration definitions must contain valid plain data values",
    );
  }
  return objectFreeze({ version, name, sql });
}

function snapshotMigrationDefinitions(
  input: unknown,
): readonly SqliteMigration[] {
  if (
    typeof input !== "object" ||
    input === null ||
    isProxy(input) ||
    !arrayIsArray(input) ||
    objectGetPrototypeOf(input) !== arrayPrototype
  ) {
    throw migrationError(
      "migration definitions must be an exact plain data array",
    );
  }

  const descriptors = ownPropertyDescriptors(input);
  const lengthDescriptor = descriptors.length;
  const lengthValue =
    lengthDescriptor === undefined
      ? undefined
      : descriptorValue(lengthDescriptor);
  if (
    !isDataDescriptor(lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    typeof lengthValue !== "number" ||
    !numberIsSafeInteger(lengthValue)
  ) {
    throw migrationError(
      "migration definitions must be an exact plain data array",
    );
  }
  const length = lengthValue;
  if (reflectOwnKeys(descriptors).length !== length + 1) {
    throw migrationError(
      "migration definitions must be an exact plain data array",
    );
  }

  const snapshot: SqliteMigration[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = stringFromValue(index);
    const descriptor = descriptors[key];
    if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      throw migrationError(
        "migration definitions must be an exact plain data array",
      );
    }
    if (
      !reflectDefineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: snapshotMigrationDefinition(descriptorValue(descriptor)),
        writable: true,
      })
    ) {
      throw migrationError("migration definition snapshot failed");
    }
  }
  return objectFreeze(snapshot);
}

function normalizedText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function checksumMigrationSnapshot(migration: SqliteMigration): string {
  return createHash("sha256")
    .update(
      `${String(migration.version)}\n${migration.name}\n${normalizedText(
        migration.sql,
      )}`,
      "utf8",
    )
    .digest("hex");
}

export function migrationChecksum(migration: SqliteMigration): string {
  return checksumMigrationSnapshot(snapshotMigrationDefinition(migration));
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
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
  const migrationSnapshot = snapshotMigrationDefinitions(migrations);
  for (let index = 0; index < migrationSnapshot.length; index += 1) {
    assertNoTransactionControl(migrationSnapshot[index]!.sql);
  }

  try {
    runInNewImmediateTransaction(database, () => {
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
        const expected = migrationSnapshot[index];
        if (expected === undefined) {
          throw migrationError("database schema is newer than this binary");
        }
        if (
          expected.version !== row.version ||
          expected.name !== row.name ||
          checksumMigrationSnapshot(expected) !== row.checksum
        ) {
          throw migrationError("schema migration checksum or name drift");
        }
      }

      for (
        let index = rows.length;
        index < migrationSnapshot.length;
        index += 1
      ) {
        const migration = migrationSnapshot[index]!;
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
            checksum: checksumMigrationSnapshot(migration),
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
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw migrationError("SQLite migration failed", error);
  }
}
