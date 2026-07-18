import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
  StoragePort,
  StorageTransaction,
} from "../../../src/app/ports/storage-port.js";
import { AppError } from "../../../src/domain/errors.js";
import { asSnapshotId, asUserListId } from "../../../src/domain/ids.js";
import { parseSnapshotBatch } from "../../../src/domain/snapshot.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";
import { SQLiteStore } from "../../../src/storage/sqlite-store.js";
import {
  prepareStateDirectory,
  STATE_DATABASE_BASENAME,
} from "../../../src/storage/state-directory.js";
import { seedCompleteSnapshot } from "../../contracts/storage-port.contract.js";
import {
  accountBindingFixture,
  changePlanFixture,
  changeRunFixture,
  pendingOperationFixture,
  snapshotBatchFixture,
  snapshotDraftFixture,
} from "../../fixtures/domain.js";

const MIGRATION_TIME = "2026-07-16T00:00:00.000Z";

function expectCode(
  operation: () => unknown,
  code: AppError["code"],
): AppError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

function readyStore(): SQLiteStore {
  const store = new SQLiteStore(":memory:", { now: () => MIGRATION_TIME });
  store.migrate();
  return store;
}

function leaseInput(name: string) {
  return {
    name,
    ownerId: `owner:${name}`,
    now: "2026-07-16T00:01:00.000Z",
    expiresAt: "2026-07-16T00:10:00.000Z",
  } as const;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("SQLiteStore migration lifecycle", () => {
  test("constructs without I/O, requires migration, and never reopens after close", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-store-"));
    temporaryRoots.push(root);
    const dataDirectory = resolve(root, "state");
    let clockCalls = 0;
    const store = new SQLiteStore(dataDirectory, {
      now: () => {
        clockCalls += 1;
        return MIGRATION_TIME;
      },
    });

    expect(existsSync(dataDirectory)).toBe(false);
    expect(clockCalls).toBe(0);
    expectCode(() => store.getSchemaVersion(), "STORAGE_ERROR");
    expectCode(
      () => store.acquireLease(leaseInput("before-migrate")),
      "STORAGE_ERROR",
    );
    expect(existsSync(dataDirectory)).toBe(false);

    store.close();
    store.close();
    expectCode(() => store.migrate(), "STORAGE_ERROR");
    expect(clockCalls).toBe(0);
    expect(existsSync(dataDirectory)).toBe(false);
  });

  test("migrates once, delegates repository methods, hides internals, and closes idempotently", () => {
    let clockCalls = 0;
    const store = new SQLiteStore(":memory:", {
      now: () => {
        clockCalls += 1;
        return MIGRATION_TIME;
      },
    });

    store.migrate();
    store.migrate();
    expect(clockCalls).toBe(1);
    expect(store.getSchemaVersion()).toBe(1);
    expect(store.acquireLease(leaseInput("delegated"))?.name).toBe("delegated");
    expect(Object.keys(store)).toEqual([]);
    expect(
      Object.getOwnPropertyNames(store).some((name) =>
        /database|sqlite|secret|codec|repository|path|directory/iu.test(name),
      ),
    ).toBe(false);

    store.close();
    store.close();
    expectCode(() => store.getSchemaVersion(), "STORAGE_ERROR");
    expectCode(() => store.migrate(), "STORAGE_ERROR");
  });

  test("validates the complete migration ledger on every schema-version read", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-store-"));
    temporaryRoots.push(root);
    const dataDirectory = resolve(root, "state");
    const prepared = prepareStateDirectory(dataDirectory);
    const store = new SQLiteStore(dataDirectory, {
      now: () => MIGRATION_TIME,
    });
    try {
      store.migrate();
      expect(store.getSchemaVersion()).toBe(1);
      const inspector = openSqliteDatabase(prepared.databasePath);
      try {
        inspector
          .prepare(
            `UPDATE schema_migrations
             SET checksum=?
             WHERE version=1`,
          )
          .run("f".repeat(64));
      } finally {
        inspector.close();
      }
      const error = expectCode(() => store.getSchemaVersion(), "STORAGE_ERROR");
      expect(error.message).toBe("SQLite schema migration ledger is invalid");
    } finally {
      store.close();
    }
  });

  test("rejects a reentrant migration and still completes the outer migration", () => {
    let reentrantError: AppError | undefined;
    const store = new SQLiteStore(":memory:", {
      now: () => {
        reentrantError = expectCode(
          () => store.migrate(),
          "PRECONDITION_FAILED",
        );
        return MIGRATION_TIME;
      },
    });

    store.migrate();
    expect(reentrantError?.code).toBe("PRECONDITION_FAILED");
    expect(store.getSchemaVersion()).toBe(1);
    store.close();
  });

  test("cleans up a failed migration and allows a complete retry", () => {
    let calls = 0;
    const store = new SQLiteStore(":memory:", {
      now: () => {
        calls += 1;
        return calls === 1 ? "not-a-timestamp" : MIGRATION_TIME;
      },
    });

    expectCode(() => store.migrate(), "VALIDATION_ERROR");
    expectCode(() => store.getSchemaVersion(), "STORAGE_ERROR");
    store.migrate();
    expect(calls).toBe(2);
    expect(store.getSchemaVersion()).toBe(1);
    store.close();
  });

  test("does not inspect a supplied clock until migration starts", () => {
    let getterReads = 0;
    const clock = Object.create(null) as { now: () => string };
    Object.defineProperty(clock, "now", {
      configurable: false,
      enumerable: true,
      get() {
        getterReads += 1;
        return () => MIGRATION_TIME;
      },
    });
    const store = new SQLiteStore(":memory:", clock);
    expect(getterReads).toBe(0);
    store.migrate();
    expect(getterReads).toBe(1);
    store.close();
  });

  test("uses captured typed-array copy intrinsics during startup", () => {
    const setDescriptor = Object.getOwnPropertyDescriptor(
      Uint8Array.prototype,
      "set",
    );
    const fillDescriptor = Object.getOwnPropertyDescriptor(
      Uint8Array.prototype,
      "fill",
    );
    const thenDescriptor = Object.getOwnPropertyDescriptor(
      Uint8Array.prototype,
      "then",
    );
    const fromDescriptor = Object.getOwnPropertyDescriptor(Uint8Array, "from");
    let patchedCalls = 0;
    const store = new SQLiteStore(":memory:", {
      now: () => MIGRATION_TIME,
    });
    try {
      Object.defineProperty(Uint8Array.prototype, "set", {
        configurable: true,
        value() {
          patchedCalls += 1;
          throw new Error("patched typed-array set");
        },
        writable: true,
      });
      Object.defineProperty(Uint8Array.prototype, "fill", {
        configurable: true,
        value() {
          patchedCalls += 1;
          throw new Error("patched typed-array fill");
        },
        writable: true,
      });
      Object.defineProperty(Uint8Array.prototype, "then", {
        configurable: true,
        get() {
          patchedCalls += 1;
          throw new Error("patched typed-array then");
        },
      });
      Object.defineProperty(Uint8Array, "from", {
        configurable: true,
        value() {
          patchedCalls += 1;
          throw new Error("patched typed-array from");
        },
        writable: true,
      });
      store.migrate();
    } finally {
      if (setDescriptor === undefined) {
        Reflect.deleteProperty(Uint8Array.prototype, "set");
      } else {
        Object.defineProperty(Uint8Array.prototype, "set", setDescriptor);
      }
      if (fillDescriptor === undefined) {
        Reflect.deleteProperty(Uint8Array.prototype, "fill");
      } else {
        Object.defineProperty(Uint8Array.prototype, "fill", fillDescriptor);
      }
      if (thenDescriptor === undefined) {
        Reflect.deleteProperty(Uint8Array.prototype, "then");
      } else {
        Object.defineProperty(Uint8Array.prototype, "then", thenDescriptor);
      }
      if (fromDescriptor === undefined) {
        Reflect.deleteProperty(Uint8Array, "from");
      } else {
        Object.defineProperty(Uint8Array, "from", fromDescriptor);
      }
    }
    expect(patchedCalls).toBe(0);
    expect(store.getSchemaVersion()).toBe(1);
    store.close();
  });

  test("performs complete file startup with one timestamp and preserves cursor continuity after reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-store-"));
    temporaryRoots.push(root);
    const dataDirectory = resolve(root, "state");
    const firstTime = "2026-07-16T01:02:03.000Z";
    const first = new SQLiteStore(dataDirectory, { now: () => firstTime });
    first.migrate();

    const inspector = openSqliteDatabase(
      join(dataDirectory, STATE_DATABASE_BASENAME),
    );
    expect(
      inspector
        .prepare("SELECT applied_at FROM schema_migrations WHERE version=1")
        .pluck()
        .get(),
    ).toBe(firstTime);
    expect(
      inspector
        .prepare(
          `SELECT created_at,typeof(value) AS type,length(value) AS length
           FROM runtime_secrets WHERE name='cursor_hmac_sha256_v1'`,
        )
        .get(),
    ).toEqual({ created_at: firstTime, type: "blob", length: 32 });
    inspector.close();

    const secondList = {
      ...snapshotBatchFixture.lists[0]!,
      listId: asUserListId("UL_2"),
      name: "Tools",
      slug: "tools",
    };
    const batch = parseSnapshotBatch({
      repositories: snapshotBatchFixture.repositories,
      stars: snapshotBatchFixture.stars,
      lists: [...snapshotBatchFixture.lists, secondList],
      memberships: snapshotBatchFixture.memberships,
    });
    const snapshot = seedCompleteSnapshot(first, { batch });
    const firstPage = first.queryLists({
      snapshotId: snapshot.id,
      pageSize: 1,
      cursor: null,
    });
    expect(firstPage.nextCursor).not.toBeNull();
    first.close();

    const reopened = new SQLiteStore(dataDirectory, {
      now: () => "2026-07-17T01:02:03.000Z",
    });
    reopened.migrate();
    expect(
      reopened.queryLists({
        snapshotId: snapshot.id,
        pageSize: 1,
        cursor: firstPage.nextCursor,
      }).items,
    ).toHaveLength(1);
    const reopenedInspector = openSqliteDatabase(
      join(dataDirectory, STATE_DATABASE_BASENAME),
    );
    expect(
      reopenedInspector
        .prepare(
          "SELECT created_at FROM runtime_secrets WHERE name='cursor_hmac_sha256_v1'",
        )
        .pluck()
        .get(),
    ).toBe(firstTime);
    reopenedInspector.close();
    reopened.close();
  });

  test("reopens detached frozen plan, run, operation, attempt, and reconciliation history", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-store-"));
    temporaryRoots.push(root);
    const dataDirectory = resolve(root, "state");
    const store = new SQLiteStore(dataDirectory, {
      now: () => MIGRATION_TIME,
    });
    let reopened: SQLiteStore | undefined;
    try {
      store.migrate();
      seedCompleteSnapshot(store);
      const acquired = store.acquireLease({
        name: "apply:reopen",
        ownerId: "reopen-owner",
        now: "2026-07-16T02:00:00.000Z",
        expiresAt: "2026-07-16T04:00:00.000Z",
      });
      expect(acquired).not.toBeNull();
      const lease = {
        name: "apply:reopen",
        ownerId: "reopen-owner",
        now: "2026-07-16T02:01:00.000Z",
      } as const;
      store.savePlan(changePlanFixture);
      store.compareAndSetPlanState({
        planId: changePlanFixture.id,
        expected: ["ready"],
        next: "applying",
      });
      store.createRun({ run: changeRunFixture, lease });
      store.compareAndSetRunState({
        runId: changeRunFixture.id,
        expected: ["pending"],
        next: "running",
        finishedAt: null,
        lease,
      });
      store.createRunOperation({
        operation: pendingOperationFixture,
        lease,
      });
      store.startRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        startedAt: "2026-07-16T02:02:00.000Z",
        lease,
      });
      store.finishRunOperation({
        phase: "after_dispatch",
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        status: "unresolved",
        reconciliation: "unknown",
        externalRequestId: "request-reopen",
        after: null,
        error: {
          code: "RECONCILIATION_REQUIRED",
          message: "outcome unknown",
          retryable: false,
          details: { marker: "[REDACTED]" },
        },
        finishedAt: "2026-07-16T02:03:00.000Z",
        lease,
      });
      store.reconcileRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        status: "failed",
        reconciliation: "confirmed_not_applied",
        after: { starred: true, marker: "[REDACTED]" },
        error: {
          code: "GITHUB_UNAVAILABLE",
          message: "confirmed not applied",
          retryable: true,
          details: { marker: "[REDACTED]" },
        },
        observedAt: "2026-07-16T02:04:00.000Z",
        lease,
      });

      const planBefore = store.getPlan(changePlanFixture.id);
      const runBefore = store.getRun(changeRunFixture.id);
      const operationBefore = store.getRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
      });
      const attemptBefore = store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 1,
      });
      const eventsBefore = store.listRunOperationReconciliationsPage({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        afterEventSequence: null,
        pageSize: 10,
      });
      store.close();

      reopened = new SQLiteStore(dataDirectory, {
        now: () => MIGRATION_TIME,
      });
      reopened.migrate();
      const planAfter = reopened.getPlan(changePlanFixture.id);
      const runAfter = reopened.getRun(changeRunFixture.id);
      const operationAfter = reopened.getRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
      });
      const attemptAfter = reopened.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 1,
      });
      const eventsAfter = reopened.listRunOperationReconciliationsPage({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        afterEventSequence: null,
        pageSize: 10,
      });

      expect(planAfter).toEqual(planBefore);
      expect(planAfter).not.toBe(planBefore);
      expect(Object.isFrozen(planAfter)).toBe(true);
      expect(Object.isFrozen(planAfter?.executable)).toBe(true);
      expect(Object.isFrozen(planAfter?.executable.operations)).toBe(true);
      expect(runAfter).toEqual(runBefore);
      expect(runAfter).not.toBe(runBefore);
      expect(Object.isFrozen(runAfter?.warnings)).toBe(true);
      expect(operationAfter).toEqual(operationBefore);
      expect(operationAfter).not.toBe(operationBefore);
      expect(Object.isFrozen(operationAfter?.after)).toBe(true);
      expect(Object.isFrozen(operationAfter?.error?.details)).toBe(true);
      expect(attemptAfter).toEqual(attemptBefore);
      expect(attemptAfter).not.toBe(attemptBefore);
      expect(Object.isFrozen(attemptAfter?.before)).toBe(true);
      expect(eventsAfter).toEqual(eventsBefore);
      expect(eventsAfter).not.toBe(eventsBefore);
      expect(Object.isFrozen(eventsAfter)).toBe(true);
      expect(Object.isFrozen(eventsAfter.items)).toBe(true);
      expect(Object.isFrozen(eventsAfter.items[0])).toBe(true);
    } finally {
      reopened?.close();
      store.close();
    }
  });

  test("clears a late failed startup, strips its cause, and retries on the same instance", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-store-"));
    temporaryRoots.push(root);
    const dataDirectory = resolve(root, "state");
    const prepared = prepareStateDirectory(dataDirectory);
    const bootstrap = openSqliteDatabase(prepared.databasePath);
    migrateSqliteDatabase(bootstrap, MIGRATION_TIME);
    bootstrap.exec(
      "ALTER TABLE runtime_secrets RENAME TO runtime_secrets_missing",
    );
    bootstrap.close();

    let clockCalls = 0;
    const store = new SQLiteStore(dataDirectory, {
      now: () => {
        clockCalls += 1;
        return `2026-07-16T00:00:0${String(clockCalls)}.000Z`;
      },
    });
    const failure = expectCode(() => store.migrate(), "STORAGE_ERROR");
    expect(failure.message).toMatch(
      /cursor signing key initialization failed/u,
    );
    expect("cause" in failure).toBe(false);
    expect(JSON.stringify(failure)).not.toContain(dataDirectory);
    expectCode(() => store.getSchemaVersion(), "STORAGE_ERROR");

    const repair = openSqliteDatabase(prepared.databasePath);
    repair.exec(
      "ALTER TABLE runtime_secrets_missing RENAME TO runtime_secrets",
    );
    repair.close();
    store.migrate();
    expect(clockCalls).toBe(2);
    expect(store.getSchemaVersion()).toBe(1);
    store.close();
  });

  test("accepts only memory or an absolute data directory", () => {
    expectCode(
      () => new SQLiteStore("relative/state", { now: () => MIGRATION_TIME }),
      "STORAGE_ERROR",
    );
    expectCode(
      () => new SQLiteStore("", { now: () => MIGRATION_TIME }),
      "STORAGE_ERROR",
    );
    expectCode(
      () => new SQLiteStore("bad\0path", { now: () => MIGRATION_TIME }),
      "STORAGE_ERROR",
    );
  });

  test("idempotent migration never performs crash recovery", () => {
    const store = readyStore();
    const input = leaseInput("sync:unrecovered");
    store.acquireLease({
      ...input,
      expiresAt: "2026-07-16T00:02:00.000Z",
    });
    store.createSnapshot({
      draft: {
        ...snapshotDraftFixture,
        id: asSnapshotId("snap_unrecovered"),
      },
      lease: {
        name: input.name,
        ownerId: input.ownerId,
        now: "2026-07-16T00:01:30.000Z",
      },
    });

    store.migrate();
    expect(
      store.recoverIncompleteSnapshots("2026-07-16T00:03:00.000Z"),
    ).toEqual([asSnapshotId("snap_unrecovered")]);
    store.close();
  });
});

describe("SQLiteStore synchronous transaction boundary", () => {
  test("commits repository work atomically and rolls back callback failures", () => {
    const store = readyStore();
    seedCompleteSnapshot(store);

    expect(() =>
      store.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        tx.acquireLease(leaseInput("rolled-back"));
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(store.getPlan(changePlanFixture.id)).toBeNull();
    expect(store.acquireLease(leaseInput("rolled-back"))?.ownerId).toBe(
      "owner:rolled-back",
    );
    store.releaseLease({
      name: "rolled-back",
      ownerId: "owner:rolled-back",
    });

    const result = store.withTransaction((tx) => {
      tx.savePlan(changePlanFixture);
      tx.acquireLease(leaseInput("atomic"));
      return { committed: true, nested: ["value"] };
    });
    expect(result).toEqual({ committed: true, nested: ["value"] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
    expect(
      store.assertLease({
        name: "atomic",
        ownerId: "owner:atomic",
        now: "2026-07-16T00:02:00.000Z",
      }).name,
    ).toBe("atomic");
    store.close();
  });

  test("contains a caught repository failure in its savepoint without poisoning the outer transaction", () => {
    const store = readyStore();
    const returned = store.withTransaction((tx) => {
      expectCode(
        () =>
          tx.releaseLease({
            name: "missing",
            ownerId: "owner:missing",
          }),
        "NOT_FOUND",
      );
      tx.acquireLease(leaseInput("after-caught-failure"));
      return "committed";
    });

    expect(returned).toBe("committed");
    expect(
      store.assertLease({
        name: "after-caught-failure",
        ownerId: "owner:after-caught-failure",
        now: "2026-07-16T00:02:00.000Z",
      }).name,
    ).toBe("after-caught-failure");
    store.close();
  });

  test("poisons and rolls back every caught root-store reentry", () => {
    const store = readyStore();
    const rootCalls: readonly (() => unknown)[] = [
      () => store.migrate(),
      () => store.close(),
      () => store.getSchemaVersion(),
      () =>
        store.getIncompleteRunSummaries({
          binding: accountBindingFixture,
          limit: 1,
        }),
      () =>
        store.recoverAbandonedSnapshots({
          binding: accountBindingFixture,
          lease: {
            name: "unused",
            ownerId: "unused",
            now: MIGRATION_TIME,
          },
        }),
      () =>
        store.recoverAbandonedRuns({
          binding: accountBindingFixture,
          lease: {
            name: "unused",
            ownerId: "unused",
            now: MIGRATION_TIME,
          },
        }),
      () => store.recoverIncompleteSnapshots(MIGRATION_TIME),
      () => store.recoverInterruptedRuns(MIGRATION_TIME),
      () => store.withTransaction(() => null),
      () => store.acquireLease(leaseInput("ordinary-root")),
    ];

    rootCalls.forEach((rootCall, index) => {
      const name = `poisoned-${String(index)}`;
      expectCode(
        () =>
          store.withTransaction((tx) => {
            tx.acquireLease(leaseInput(name));
            expectCode(rootCall, "PRECONDITION_FAILED");
            return null;
          }),
        "PRECONDITION_FAILED",
      );
      expect(store.acquireLease(leaseInput(name))?.name).toBe(name);
      store.releaseLease({
        name,
        ownerId: `owner:${name}`,
      });
    });
    store.close();
  });

  test("reports root reentry poison before an invalid callback return", () => {
    const store = readyStore();
    const error = expectCode(
      () =>
        store.withTransaction(() => {
          expectCode(() => store.getSchemaVersion(), "PRECONDITION_FAILED");
          return Promise.resolve("invalid");
        }),
      "PRECONDITION_FAILED",
    );
    expect(error.message).toMatch(/root storage reentry/u);
    store.close();
  });

  test("revokes leaked facades and extracted methods after commit and rollback", () => {
    const store = readyStore();
    let leaked: StorageTransaction | undefined;
    let extracted: StorageTransaction["acquireLease"] | undefined;
    store.withTransaction((tx) => {
      leaked = tx;
      const candidate = (tx as unknown as Readonly<Record<string, unknown>>)
        .acquireLease;
      extracted = candidate as StorageTransaction["acquireLease"];
      return undefined;
    });

    expect(() => leaked!.acquireLease(leaseInput("leaked-facade"))).toThrow();
    expectCode(
      () => extracted!(leaseInput("leaked-method")),
      "PRECONDITION_FAILED",
    );
    expect(store.acquireLease(leaseInput("leaked-facade"))?.name).toBe(
      "leaked-facade",
    );
    expect(store.acquireLease(leaseInput("leaked-method"))?.name).toBe(
      "leaked-method",
    );

    let rolledBackFacade: StorageTransaction | undefined;
    expect(() =>
      store.withTransaction((tx) => {
        rolledBackFacade = tx;
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(() =>
      rolledBackFacade!.acquireLease(leaseInput("after-rollback")),
    ).toThrow();
    store.close();
  });

  test("returns only a detached frozen clone after commit and supports undefined", () => {
    const store = readyStore();
    const input = { value: { count: 1 }, items: ["a"] };
    const returned = store.withTransaction(() => input);
    input.value.count = 2;
    input.items.push("b");

    expect(returned).toEqual({ value: { count: 1 }, items: ["a"] });
    expect(returned).not.toBe(input);
    expect(returned.value).not.toBe(input.value);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.value)).toBe(true);
    expect(Object.isFrozen(returned.items)).toBe(true);
    expect(store.withTransaction(() => undefined)).toBeUndefined();
    store.close();
  });

  test("rejects async, thenable, proxy, and accessor results without invoking user code and rolls back", () => {
    const store = readyStore();
    let getterCalls = 0;
    let trapCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          trapCalls += 1;
          return true;
        },
        getPrototypeOf() {
          trapCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          trapCalls += 1;
          return [];
        },
      },
    );
    const cases: readonly (() => unknown)[] = [
      () => Promise.resolve(true),
      () => ({ then() {} }),
      () => proxy,
      () => accessor,
    ];

    cases.forEach((makeResult, index) => {
      const name = `invalid-result-${String(index)}`;
      expectCode(
        () =>
          store.withTransaction((tx) => {
            tx.acquireLease(leaseInput(name));
            return makeResult();
          }),
        "PRECONDITION_FAILED",
      );
      expect(store.acquireLease(leaseInput(name))?.name).toBe(name);
      store.releaseLease({ name, ownerId: `owner:${name}` });
    });
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
    store.close();
  });

  test("passes only an undefined sentinel to better-sqlite3", () => {
    const store = readyStore();
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "then",
    );
    let inheritedThenReads = 0;
    let returned: { readonly ok: boolean } | undefined;
    try {
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        get() {
          inheritedThenReads += 1;
          throw new Error("inherited then must not be read");
        },
      });
      returned = store.withTransaction((tx) => {
        tx.acquireLease(leaseInput("sentinel"));
        return { ok: true };
      });
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "then");
      } else {
        Object.defineProperty(Object.prototype, "then", descriptor);
      }
    }

    expect(inheritedThenReads).toBe(0);
    expect(returned).toEqual({ ok: true });
    expect(
      store.assertLease({
        name: "sentinel",
        ownerId: "owner:sentinel",
        now: "2026-07-16T00:02:00.000Z",
      }).name,
    ).toBe("sentinel");
    store.close();
  });

  test("does not expose raw SQL, root methods, or private state through the facade", () => {
    const store = readyStore();
    store.withTransaction((tx) => {
      const record = tx as unknown as Record<string, unknown>;
      expect(record.migrate).toBeUndefined();
      expect(record.close).toBeUndefined();
      expect(record.withTransaction).toBeUndefined();
      expect(record.execute).toBeUndefined();
      expect(record.query).toBeUndefined();
      expect(record.database).toBeUndefined();
      expect(record.cursorSigningKey).toBeUndefined();
      return null;
    });
    store.close();
  });

  test("uses a null-prototype proxy handler under Object prototype pollution", () => {
    const store = readyStore();
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "get");
    let inheritedTrapReads = 0;
    let extractedType = "";
    expect(
      store.withTransaction((tx) => {
        try {
          Object.defineProperty(Object.prototype, "get", {
            configurable: true,
            get() {
              inheritedTrapReads += 1;
              throw new Error("inherited proxy trap");
            },
          });
          extractedType = typeof Reflect.get(tx, "acquireLease");
        } finally {
          if (descriptor === undefined) {
            Reflect.deleteProperty(Object.prototype, "get");
          } else {
            Object.defineProperty(Object.prototype, "get", descriptor);
          }
        }
        return true;
      }),
    ).toBe(true);
    expect(inheritedTrapReads).toBe(0);
    expect(extractedType).toBe("function");
    store.close();
  });
});

test("SQLiteStore satisfies the public StoragePort shape", () => {
  const store: StoragePort = readyStore();
  expect(store.getSchemaVersion()).toBe(1);
  store.close();
});
