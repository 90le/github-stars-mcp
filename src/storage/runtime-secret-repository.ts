import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "../domain/errors.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import { runInNewImmediateTransaction } from "./sqlite-transaction.js";

const CURSOR_SECRET_NAME = "cursor_hmac_sha256_v1";

const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const typedArrayByteLengthAtLoad = (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength") as {
    readonly get: (this: Uint8Array) => number;
  }
).get;
const typedArrayFillAtLoad = (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "fill") as {
    readonly value: (this: Uint8Array, value: number) => Uint8Array;
  }
).value;
const typedArraySetAtLoad = (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "set") as {
    readonly value: (
      this: Uint8Array,
      source: ArrayLike<number>,
      offset?: number,
    ) => void;
  }
).value;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured once; this static predicate is invoked with Reflect.apply.
const bufferIsBufferAtLoad = Buffer.isBuffer;
const freezeAtLoad = Object.freeze;
const SECRET_INTRINSICS = freezeAtLoad({
  bufferIsBuffer: bufferIsBufferAtLoad,
  randomBytes,
  reflectApply: Reflect.apply,
  typedArrayByteLength: typedArrayByteLengthAtLoad,
  typedArrayFill: typedArrayFillAtLoad,
  typedArraySet: typedArraySetAtLoad,
  uint8ArrayConstructor: Uint8Array,
});

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

function byteLength(value: Uint8Array): number {
  return SECRET_INTRINSICS.reflectApply(
    SECRET_INTRINSICS.typedArrayByteLength,
    value,
    [],
  );
}

function wipe(value: Uint8Array | undefined): void {
  if (value === undefined) return;
  try {
    SECRET_INTRINSICS.reflectApply(
      SECRET_INTRINSICS.typedArrayFill,
      value,
      [0],
    );
  } catch {
    // Wiping must not replace the primary database or validation failure.
  }
}

function exactKeyCopy(value: Uint8Array): Uint8Array {
  if (byteLength(value) !== 32) {
    throw secretError("stored cursor signing key is corrupt");
  }
  const copy = new SECRET_INTRINSICS.uint8ArrayConstructor(32);
  SECRET_INTRINSICS.reflectApply(SECRET_INTRINSICS.typedArraySet, copy, [
    value,
  ]);
  if (byteLength(copy) !== 32) {
    throw secretError("cursor signing key copy failed");
  }
  return copy;
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
    const generated = SECRET_INTRINSICS.randomBytes(32);
    let selected: Buffer | undefined;
    let result: Uint8Array | undefined;
    let handedOff = false;
    try {
      runInNewImmediateTransaction(this.#database, () => {
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
        if (
          row !== undefined &&
          SECRET_INTRINSICS.reflectApply(
            SECRET_INTRINSICS.bufferIsBuffer,
            Buffer,
            [row.value],
          )
        ) {
          selected = row.value as Buffer;
        }
        if (
          row === undefined ||
          row.storage_type !== "blob" ||
          row.byte_length !== 32 ||
          selected === undefined ||
          byteLength(selected) !== 32
        ) {
          throw secretError("stored cursor signing key is corrupt");
        }
        result = exactKeyCopy(selected);
        return undefined;
      });
      if (result === undefined) {
        throw secretError("cursor signing key copy failed");
      }
      handedOff = true;
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw secretError("cursor signing key initialization failed", error);
    } finally {
      wipe(generated);
      wipe(selected);
      if (!handedOff) wipe(result);
    }
  }
}
