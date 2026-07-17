import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "../domain/errors.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";

const CURSOR_SECRET_NAME = "cursor_hmac_sha256_v1";

interface SecretRow {
  readonly value: unknown;
  readonly storage_type: string;
  readonly byte_length: number;
}

function secretError(message: string, cause?: unknown): AppError {
  return new AppError("STORAGE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

export class RuntimeSecretRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  getOrCreateCursorSigningKey(createdAtInput: string): Uint8Array {
    const createdAt = canonicalUtcTimestamp(
      createdAtInput,
      "cursor secret createdAt",
    );
    if (this.#database.inTransaction) {
      throw secretError(
        "cursor secret initialization requires its own transaction",
      );
    }

    const generated = randomBytes(32);
    let selected: Buffer | undefined;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#database
        .prepare(
          `INSERT INTO runtime_secrets(name,value,created_at)
           VALUES (@name,@value,@createdAt)
           ON CONFLICT(name) DO NOTHING`,
        )
        .run({ name: CURSOR_SECRET_NAME, value: generated, createdAt });
      const row = this.#database
        .prepare(
          `SELECT value, typeof(value) AS storage_type, length(value) AS byte_length
           FROM runtime_secrets WHERE name=@name`,
        )
        .get({ name: CURSOR_SECRET_NAME }) as SecretRow | undefined;
      if (row !== undefined && Buffer.isBuffer(row.value)) {
        selected = row.value;
      }
      if (
        row === undefined ||
        row.storage_type !== "blob" ||
        row.byte_length !== 32 ||
        selected === undefined ||
        selected.byteLength !== 32
      ) {
        throw secretError("stored cursor signing key is corrupt");
      }
      this.#database.exec("COMMIT");
      return Uint8Array.from(selected);
    } catch (error) {
      if (this.#database.inTransaction) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the primary failure.
        }
      }
      if (error instanceof AppError) throw error;
      throw secretError("cursor signing key initialization failed", error);
    } finally {
      generated.fill(0);
      selected?.fill(0);
    }
  }
}
