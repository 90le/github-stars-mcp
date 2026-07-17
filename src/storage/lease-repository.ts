import type Database from "better-sqlite3";
import type {
  AcquireLeaseInput,
  Lease,
  LeaseGuard,
} from "../app/ports/storage-port.js";
import { canonicalJsonClone } from "../domain/canonical-json.js";
import { AppError } from "../domain/errors.js";
import type { JsonValue } from "../domain/json.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import { runInImmediateTransaction } from "./sqlite-transaction.js";

interface LeaseRow {
  readonly name: string;
  readonly owner_id: string;
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string;
}

function stableText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new AppError("VALIDATION_ERROR", `${label} must be stable text`);
  }
  return value;
}

function exactObject(
  input: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, JsonValue>> {
  const cloned = canonicalJsonClone(input);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new AppError("VALIDATION_ERROR", `${label} must be an object`);
  }
  const actual = Object.keys(cloned);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} contains unsupported properties`,
    );
  }
  return cloned as Readonly<Record<string, JsonValue>>;
}

function leaseFromRow(row: LeaseRow): Lease {
  return Object.freeze({
    name: row.name,
    ownerId: row.owner_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  });
}

function missing(): never {
  throw new AppError("NOT_FOUND", "lease was not found");
}

function precondition(message: string): never {
  throw new AppError("PRECONDITION_FAILED", message);
}

export class LeaseRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  #write<T>(operation: () => T): T {
    return runInImmediateTransaction(this.#database, operation);
  }

  #row(name: string): LeaseRow | undefined {
    return this.#database
      .prepare(
        `SELECT name,owner_id,acquired_at,heartbeat_at,expires_at
         FROM leases WHERE name=?`,
      )
      .get(name) as LeaseRow | undefined;
  }

  acquireLease(input: AcquireLeaseInput): Lease | null {
    const root = exactObject(
      input,
      ["name", "ownerId", "now", "expiresAt"],
      "acquire lease input",
    );
    const name = stableText(root.name, "lease name");
    const ownerId = stableText(root.ownerId, "lease owner");
    const now = canonicalUtcTimestamp(root.now, "lease now");
    const expiresAt = canonicalUtcTimestamp(root.expiresAt, "lease expiresAt");
    if (expiresAt <= now) {
      throw new AppError(
        "VALIDATION_ERROR",
        "lease expiry must be later than now",
      );
    }
    return this.#write(() => {
      const row = this.#database
        .prepare(
          `INSERT INTO leases(name,owner_id,acquired_at,heartbeat_at,expires_at)
           VALUES (@name,@ownerId,@now,@now,@expiresAt)
           ON CONFLICT(name) DO UPDATE SET
             owner_id=excluded.owner_id,
             acquired_at=excluded.acquired_at,
             heartbeat_at=excluded.heartbeat_at,
             expires_at=excluded.expires_at
           WHERE leases.expires_at<=@now
           RETURNING name,owner_id,acquired_at,heartbeat_at,expires_at`,
        )
        .get({ name, ownerId, now, expiresAt }) as LeaseRow | undefined;
      return row === undefined ? null : leaseFromRow(row);
    });
  }

  assertLease(input: LeaseGuard): Lease {
    const root = exactObject(input, ["name", "ownerId", "now"], "lease guard");
    const name = stableText(root.name, "lease name");
    const ownerId = stableText(root.ownerId, "lease owner");
    const now = canonicalUtcTimestamp(root.now, "lease now");
    const row = this.#row(name);
    if (row === undefined) return missing();
    if (row.owner_id !== ownerId)
      return precondition("lease owner does not match");
    if (now < row.heartbeat_at) {
      return precondition("lease guard time cannot precede its heartbeat");
    }
    if (row.expires_at <= now) return precondition("lease is no longer active");
    return leaseFromRow(row);
  }

  renewLease(input: AcquireLeaseInput): Lease {
    const root = exactObject(
      input,
      ["name", "ownerId", "now", "expiresAt"],
      "renew lease input",
    );
    const name = stableText(root.name, "lease name");
    const ownerId = stableText(root.ownerId, "lease owner");
    const now = canonicalUtcTimestamp(root.now, "lease now");
    const expiresAt = canonicalUtcTimestamp(root.expiresAt, "lease expiresAt");
    if (expiresAt <= now) {
      throw new AppError(
        "VALIDATION_ERROR",
        "lease expiry must be later than now",
      );
    }
    return this.#write(() => {
      const current = this.#row(name);
      if (current === undefined) return missing();
      if (current.owner_id !== ownerId) {
        return precondition("lease owner does not match");
      }
      if (now < current.heartbeat_at) {
        return precondition("lease renewal time cannot move backward");
      }
      if (current.expires_at <= now)
        return precondition("lease is no longer active");
      if (expiresAt <= current.expires_at) {
        return precondition("lease renewal must strictly extend expiry");
      }
      const row = this.#database
        .prepare(
          `UPDATE leases
           SET heartbeat_at=@now, expires_at=@expiresAt
           WHERE name=@name AND owner_id=@ownerId AND expires_at>@now
           RETURNING name,owner_id,acquired_at,heartbeat_at,expires_at`,
        )
        .get({ name, ownerId, now, expiresAt }) as LeaseRow | undefined;
      if (row === undefined)
        return precondition("lease renewal lost ownership");
      return leaseFromRow(row);
    });
  }

  releaseLease(input: {
    readonly name: string;
    readonly ownerId: string;
  }): void {
    const root = exactObject(input, ["name", "ownerId"], "release lease input");
    const name = stableText(root.name, "lease name");
    const ownerId = stableText(root.ownerId, "lease owner");
    this.#write(() => {
      const row = this.#row(name);
      if (row === undefined) return missing();
      if (row.owner_id !== ownerId) {
        return precondition("lease owner does not match");
      }
      this.#database
        .prepare("DELETE FROM leases WHERE name=? AND owner_id=?")
        .run(name, ownerId);
    });
  }
}
