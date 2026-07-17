import { describe, expect, test } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import { LeaseRepository } from "../../../src/storage/lease-repository.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";

const t0 = "2026-07-16T00:00:00.000Z";
const t1 = "2026-07-16T00:01:00.000Z";
const t2 = "2026-07-16T00:02:00.000Z";
const t5 = "2026-07-16T00:05:00.000Z";
const t6 = "2026-07-16T00:06:00.000Z";

function setup() {
  const database = openSqliteDatabase(":memory:");
  migrateSqliteDatabase(database, t0);
  return { database, leases: new LeaseRepository(database) };
}

function code(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : "non-app-error";
  }
}

describe("LeaseRepository", () => {
  test("rejects every active reacquire and permits exact-expiry takeover", () => {
    const { database, leases } = setup();
    expect(
      leases.acquireLease({
        name: "sync",
        ownerId: "owner-1",
        now: t0,
        expiresAt: t5,
      })?.ownerId,
    ).toBe("owner-1");
    expect(
      leases.acquireLease({
        name: "sync",
        ownerId: "owner-1",
        now: t1,
        expiresAt: t6,
      }),
    ).toBeNull();
    expect(
      leases.acquireLease({
        name: "sync",
        ownerId: "owner-2",
        now: t1,
        expiresAt: t6,
      }),
    ).toBeNull();
    expect(
      leases.acquireLease({
        name: "sync",
        ownerId: "owner-2",
        now: t5,
        expiresAt: t6,
      })?.ownerId,
    ).toBe("owner-2");
    database.close();
  });

  test("renews monotonically while preserving acquiredAt", () => {
    const { database, leases } = setup();
    leases.acquireLease({
      name: "sync",
      ownerId: "owner",
      now: t0,
      expiresAt: t5,
    });
    expect(
      leases.renewLease({
        name: "sync",
        ownerId: "owner",
        now: t1,
        expiresAt: t6,
      }),
    ).toMatchObject({ acquiredAt: t0, heartbeatAt: t1, expiresAt: t6 });
    expect(
      code(() =>
        leases.renewLease({
          name: "sync",
          ownerId: "owner",
          now: t2,
          expiresAt: t6,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    database.close();
  });

  test("distinguishes missing and wrong-owner operations", () => {
    const { database, leases } = setup();
    expect(
      code(() =>
        leases.renewLease({
          name: "missing",
          ownerId: "owner",
          now: t1,
          expiresAt: t6,
        }),
      ),
    ).toBe("NOT_FOUND");
    leases.acquireLease({
      name: "sync",
      ownerId: "owner",
      now: t0,
      expiresAt: t5,
    });
    expect(
      code(() =>
        leases.assertLease({ name: "sync", ownerId: "other", now: t1 }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      code(() => leases.releaseLease({ name: "sync", ownerId: "other" })),
    ).toBe("PRECONDITION_FAILED");
    leases.releaseLease({ name: "sync", ownerId: "owner" });
    expect(
      code(() => leases.releaseLease({ name: "sync", ownerId: "owner" })),
    ).toBe("NOT_FOUND");
    database.close();
  });

  test("rejects backward guard/renewal times and non-extending input", () => {
    const { database, leases } = setup();
    leases.acquireLease({
      name: "sync",
      ownerId: "owner",
      now: t1,
      expiresAt: t5,
    });
    expect(
      code(() =>
        leases.assertLease({ name: "sync", ownerId: "owner", now: t0 }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      code(() =>
        leases.renewLease({
          name: "sync",
          ownerId: "owner",
          now: t0,
          expiresAt: t6,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    database.close();
  });

  test("rejects unknown outer properties and never invokes accessors", () => {
    const { database, leases } = setup();
    expect(
      code(() =>
        leases.acquireLease({
          name: "sync",
          ownerId: "owner",
          now: t0,
          expiresAt: t5,
          extra: true,
        } as never),
      ),
    ).toBe("VALIDATION_ERROR");
    let reads = 0;
    const hostile = Object.defineProperty(
      {
        ownerId: "owner",
        now: t0,
        expiresAt: t5,
      },
      "name",
      {
        enumerable: true,
        get() {
          reads += 1;
          return "sync";
        },
      },
    );
    expect(code(() => leases.acquireLease(hostile as never))).toBe(
      "VALIDATION_ERROR",
    );
    expect(reads).toBe(0);
    database.close();
  });
});
