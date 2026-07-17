import { describe, expect, test } from "vitest";
import type {
  LeaseGuard,
  StoragePort,
  StorageTransaction,
} from "../../../src/app/ports/storage-port.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asPlanId,
  asRepositoryId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import { parseChangePlan } from "../../../src/domain/plan.js";
import { parseChangeRun, parseRunOperation } from "../../../src/domain/run.js";
import {
  parseSnapshotBatch,
  parseSnapshotDraft,
  type SnapshotBatch,
} from "../../../src/domain/snapshot.js";
import {
  accountBindingFixture,
  changePlanFixture,
  changeRunFixture,
  pendingOperationFixture,
  repositoryInputFixture,
  snapshotBatchFixture,
  snapshotDraftFixture,
} from "../../fixtures/domain.js";
import { createMemoryStorage } from "../../fixtures/memory-storage.js";

const SYNC_GUARD = {
  name: "sync:U_1",
  ownerId: "sync-owner",
  now: "2026-07-16T00:01:00.000Z",
} as const;

const APPLY_GUARD = {
  name: "apply:U_1",
  ownerId: "apply-owner",
  now: "2026-07-16T02:01:00.000Z",
} as const;

function openStore(): StoragePort {
  const store = createMemoryStorage({ cursorKey: new Uint8Array(32).fill(7) });
  store.migrate();
  return store;
}

function acquireSync(store: StoragePort): void {
  expect(
    store.acquireLease({
      name: SYNC_GUARD.name,
      ownerId: SYNC_GUARD.ownerId,
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    }),
  ).toMatchObject({ ownerId: SYNC_GUARD.ownerId });
}

function verificationBatch(batch: SnapshotBatch) {
  return {
    stars: batch.stars,
    lists: batch.lists,
    memberships: batch.memberships,
  };
}

function completeSnapshot(
  store: StoragePort,
  options: {
    readonly id?: string;
    readonly batch?: SnapshotBatch;
    readonly verification?: ReturnType<typeof verificationBatch>;
    readonly draftCoverage?: "collecting" | "unavailable" | "omitted";
    readonly finalCoverage?: "complete" | "unavailable" | "omitted";
    readonly guard?: LeaseGuard;
  } = {},
) {
  const guard = options.guard ?? SYNC_GUARD;
  const batch = options.batch ?? snapshotBatchFixture;
  const draft = parseSnapshotDraft({
    ...snapshotDraftFixture,
    id: options.id ?? snapshotDraftFixture.id,
    listCoverage: options.draftCoverage ?? "collecting",
  });
  store.createSnapshot({ draft, lease: guard });
  store.appendSnapshotBatch({ id: draft.id, batch, lease: guard });
  const finalCoverage = options.finalCoverage ?? "complete";
  store.beginSnapshotVerification({
    id: draft.id,
    listCoverage: finalCoverage,
    lease: guard,
  });
  store.appendSnapshotVerificationBatch({
    id: draft.id,
    batch: options.verification ?? verificationBatch(batch),
    lease: guard,
  });
  store.finishSnapshotVerification({ id: draft.id, lease: guard });
  return store.completeSnapshot({
    id: draft.id,
    completedAt: "2026-07-16T00:02:00.000Z",
    listCoverage: finalCoverage,
    counts: {
      repositories: batch.repositories.length,
      stars: batch.stars.length,
      lists: batch.lists.length,
      memberships: batch.memberships.length,
    },
    warningCount: 0,
    sourceRateLimit: null,
    lease: guard,
  });
}

function twoItemBatch(): SnapshotBatch {
  return parseSnapshotBatch({
    repositories: [
      ...snapshotBatchFixture.repositories,
      {
        repository: {
          ...repositoryInputFixture,
          repositoryId: "R_2",
          repositoryDatabaseId: "43",
          name: "Agents",
          fullName: "OpenAI/Agents",
          url: "https://github.com/OpenAI/Agents",
          primaryLanguage: "__proto__",
          stargazerCount: 20,
        },
        observedAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    stars: [
      ...snapshotBatchFixture.stars,
      {
        repositoryId: "R_2",
        starredAt: "2026-07-15T13:00:00.000Z",
      },
    ],
    lists: [
      ...snapshotBatchFixture.lists,
      {
        listId: "UL_2",
        name: "Tools",
        slug: "tools",
        description: "tooling",
        isPrivate: true,
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        lastAddedAt: null,
      },
    ],
    memberships: [
      ...snapshotBatchFixture.memberships,
      { listId: "UL_1", repositoryId: "R_2" },
      { listId: "UL_2", repositoryId: "R_1" },
    ],
  });
}

function prepareRun(store: StoragePort): void {
  store.acquireLease({
    name: APPLY_GUARD.name,
    ownerId: APPLY_GUARD.ownerId,
    now: "2026-07-16T02:00:00.000Z",
    expiresAt: "2026-07-16T02:10:00.000Z",
  });
  store.savePlan(changePlanFixture);
  store.compareAndSetPlanState({
    planId: changePlanFixture.id,
    expected: ["ready"],
    next: "applying",
  });
  store.createRun({ run: changeRunFixture, lease: APPLY_GUARD });
  store.compareAndSetRunState({
    runId: changeRunFixture.id,
    expected: ["pending"],
    next: "running",
    finishedAt: null,
    lease: APPLY_GUARD,
  });
  store.createRunOperation({
    operation: pendingOperationFixture,
    lease: APPLY_GUARD,
  });
}

function retryableError() {
  return {
    code: "GITHUB_UNAVAILABLE",
    message: "transport failed",
    retryable: true,
    details: {},
  } as const;
}

function unknownError() {
  return {
    code: "RECONCILIATION_REQUIRED",
    message: "outcome unknown",
    retryable: false,
    details: {},
  } as const;
}

describe("synchronous revocable transactions", () => {
  test("commits synchronously and revokes leaked facades", () => {
    const store = openStore();
    let leaked: StorageTransaction | undefined;
    expect(
      store.withTransaction((tx) => {
        leaked = tx;
        tx.savePlan(changePlanFixture);
        return "committed";
      }),
    ).toBe("committed");
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
    expect(() => leaked?.getPlan(changePlanFixture.id)).toThrow();
    store.close();
  });

  test("rolls back throws, native Promises, proxies, and descriptor thenables", () => {
    const transactionResults: readonly unknown[] = [
      Promise.resolve("no"),
      new Proxy({}, {}),
      Object.create({
        then() {
          return undefined;
        },
      }),
    ];
    for (const result of transactionResults) {
      const store = openStore();
      expect(() =>
        store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          return result;
        }),
      ).toThrow(/synchronous|thenable/iu);
      expect(store.getPlan(changePlanFixture.id)).toBeNull();
    }

    const store = openStore();
    let getterCalls = 0;
    const accessorThen = {};
    Object.defineProperty(accessorThen, "then", {
      get() {
        getterCalls += 1;
        return () => undefined;
      },
    });
    expect(() =>
      store.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        return accessorThen;
      }),
    ).toThrow(/synchronous|thenable/iu);
    expect(getterCalls).toBe(0);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();

    let rolledBackFacade: StorageTransaction | undefined;
    expect(() =>
      store.withTransaction((tx) => {
        rolledBackFacade = tx;
        tx.savePlan(changePlanFixture);
        throw new Error("rollback");
      }),
    ).toThrow(/rollback/u);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();
    expect(() => rolledBackFacade?.getPlan(changePlanFixture.id)).toThrow();
  });

  test("poisons caught root reentry and nested transactions", () => {
    const store = openStore();
    expect(() =>
      store.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        try {
          store.getPlan(changePlanFixture.id);
        } catch {
          // A caught root call still invalidates the transaction.
        }
        return null;
      }),
    ).toThrow(/reentry|root/iu);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();

    expect(() =>
      store.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        try {
          store.withTransaction(() => null);
        } catch {
          // A caught nested transaction still invalidates the outer one.
        }
        return null;
      }),
    ).toThrow(/reentry|root/iu);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();
  });

  test("starts unready and keeps migration/close idempotent without exposing a key", () => {
    const key = new Uint8Array(32).fill(5);
    const store = createMemoryStorage({ cursorKey: key });
    key.fill(9);
    expect(() => store.getSchemaVersion()).toThrow();
    expect(Reflect.ownKeys(store)).not.toContain("cursorKey");
    expect(Reflect.ownKeys(store)).not.toContain("codec");
    store.migrate();
    store.migrate();
    expect(store.getSchemaVersion()).toBe(1);
    store.close();
    store.close();
    expect(() => store.getSchemaVersion()).toThrow();
  });
});

describe("atomic snapshots, exact verification, and bounded queries", () => {
  test("publishes reordered exact sets and keeps aggregates independent of cursors", () => {
    const store = openStore();
    acquireSync(store);
    const batch = twoItemBatch();
    const verification = {
      stars: [...batch.stars].reverse(),
      lists: [...batch.lists].reverse(),
      memberships: [...batch.memberships].reverse(),
    };
    const snapshot = completeSnapshot(store, { batch, verification });
    expect(snapshot.status).toBe("complete");
    const first = store.queryRepositories({
      snapshotId: snapshot.id,
      filter: null,
      sort: [{ field: "stargazer_count", direction: "desc" }],
      pageSize: 1,
      cursor: null,
    });
    expect(first.total).toBe(2);
    expect(first.aggregates.languages).toEqual([
      { language: "TypeScript", count: 1 },
      { language: "__proto__", count: 1 },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = store.queryRepositories({
      snapshotId: snapshot.id,
      filter: null,
      sort: [{ field: "stargazer_count", direction: "desc" }],
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.total).toBe(first.total);
    expect(second.aggregates).toEqual(first.aggregates);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.items[0])).toBe(true);
  });

  test("rejects duplicate traversal identities and marks collection changes", () => {
    const store = openStore();
    acquireSync(store);
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_duplicates",
    });
    store.createSnapshot({ draft, lease: SYNC_GUARD });
    expect(() =>
      store.appendSnapshotBatch({
        id: draft.id,
        batch: {
          repositories: [],
          stars: [
            snapshotBatchFixture.stars[0]!,
            snapshotBatchFixture.stars[0]!,
          ],
          lists: [],
          memberships: [],
        },
        lease: SYNC_GUARD,
      }),
    ).toThrow(/duplicate/iu);

    store.appendSnapshotBatch({
      id: draft.id,
      batch: snapshotBatchFixture,
      lease: SYNC_GUARD,
    });
    store.beginSnapshotVerification({
      id: draft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    let duplicateFailure: unknown;
    try {
      store.appendSnapshotVerificationBatch({
        id: draft.id,
        batch: {
          stars: [
            snapshotBatchFixture.stars[0]!,
            snapshotBatchFixture.stars[0]!,
          ],
          lists: [],
          memberships: [],
        },
        lease: SYNC_GUARD,
      });
    } catch (error) {
      duplicateFailure = error;
    }
    expect(duplicateFailure).toBeInstanceOf(AppError);
    expect(duplicateFailure).toMatchObject({
      details: { reason: "collection_changed" },
    });
  });

  test("rolls back count and exact-set mismatches before publication", () => {
    const store = openStore();
    acquireSync(store);
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_mismatch",
    });
    store.createSnapshot({ draft, lease: SYNC_GUARD });
    store.appendSnapshotBatch({
      id: draft.id,
      batch: snapshotBatchFixture,
      lease: SYNC_GUARD,
    });
    store.beginSnapshotVerification({
      id: draft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    store.appendSnapshotVerificationBatch({
      id: draft.id,
      batch: {
        ...verificationBatch(snapshotBatchFixture),
        stars: [
          {
            ...snapshotBatchFixture.stars[0]!,
            starredAt: "2026-07-15T14:00:00.000Z",
          },
        ],
      },
      lease: SYNC_GUARD,
    });
    store.finishSnapshotVerification({ id: draft.id, lease: SYNC_GUARD });
    let mismatch: unknown;
    try {
      store.completeSnapshot({
        id: draft.id,
        completedAt: "2026-07-16T00:02:00.000Z",
        listCoverage: "complete",
        counts: { repositories: 1, stars: 1, lists: 1, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: SYNC_GUARD,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toMatchObject({
      details: { reason: "collection_changed" },
    });
    expect(store.getCompleteSnapshot(draft.id)).toBeNull();

    const countDraft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_counts",
    });
    store.createSnapshot({ draft: countDraft, lease: SYNC_GUARD });
    store.appendSnapshotBatch({
      id: countDraft.id,
      batch: snapshotBatchFixture,
      lease: SYNC_GUARD,
    });
    store.beginSnapshotVerification({
      id: countDraft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    store.appendSnapshotVerificationBatch({
      id: countDraft.id,
      batch: verificationBatch(snapshotBatchFixture),
      lease: SYNC_GUARD,
    });
    store.finishSnapshotVerification({
      id: countDraft.id,
      lease: SYNC_GUARD,
    });
    expect(() =>
      store.completeSnapshot({
        id: countDraft.id,
        completedAt: "2026-07-16T00:02:00.000Z",
        listCoverage: "complete",
        counts: { repositories: 99, stars: 1, lists: 1, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: SYNC_GUARD,
      }),
    ).toThrow(/counts/iu);
    expect(store.getCompleteSnapshot(countDraft.id)).toBeNull();
    expect(
      store.completeSnapshot({
        id: countDraft.id,
        completedAt: "2026-07-16T00:02:00.000Z",
        listCoverage: "complete",
        counts: { repositories: 1, stars: 1, lists: 1, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: SYNC_GUARD,
      }).status,
    ).toBe("complete");
  });

  test("enforces exact coverage transitions and gates only List-dependent reads", () => {
    const store = openStore();
    acquireSync(store);
    const noLists = parseSnapshotBatch({
      repositories: snapshotBatchFixture.repositories,
      stars: snapshotBatchFixture.stars,
      lists: [],
      memberships: [],
    });
    const snapshot = completeSnapshot(store, {
      id: "snap_unavailable",
      batch: noLists,
      verification: verificationBatch(noLists),
      draftCoverage: "unavailable",
      finalCoverage: "unavailable",
    });
    expect(
      store.queryRepositories({
        snapshotId: snapshot.id,
        filter: null,
        sort: [],
        pageSize: 10,
        cursor: null,
      }).items,
    ).toHaveLength(1);
    expect(() =>
      store.queryRepositories({
        snapshotId: snapshot.id,
        filter: {
          field: "is_unclassified",
          op: "eq",
          value: true,
        },
        sort: [],
        pageSize: 10,
        cursor: null,
      }),
    ).toThrow(/List coverage/iu);
    expect(() =>
      store.queryLists({
        snapshotId: snapshot.id,
        pageSize: 10,
        cursor: null,
      }),
    ).toThrow(/List coverage/iu);

    const illegal = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_illegal_coverage",
    });
    store.createSnapshot({ draft: illegal, lease: SYNC_GUARD });
    expect(() =>
      store.beginSnapshotVerification({
        id: illegal.id,
        listCoverage: "unavailable",
        lease: SYNC_GUARD,
      }),
    ).toThrow(/transition/iu);
  });

  test("pins metadata, detaches writes, and returns frozen detached reads", () => {
    const store = openStore();
    acquireSync(store);
    const mutable = structuredClone(snapshotBatchFixture);
    completeSnapshot(store, {
      id: "snap_pinned",
      batch: mutable,
      verification: verificationBatch(mutable),
    });
    Reflect.set(mutable.repositories[0]!.repository, "stargazerCount", 999);
    const first = store.getSnapshotRepository(
      asSnapshotId("snap_pinned"),
      asRepositoryId("R_1"),
    );
    expect(first?.stargazerCount).toBe(10);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.topics)).toBe(true);

    const newer = parseSnapshotBatch({
      ...structuredClone(snapshotBatchFixture),
      repositories: [
        {
          repository: {
            ...repositoryInputFixture,
            stargazerCount: 50,
          },
          observedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    });
    completeSnapshot(store, { id: "snap_newer", batch: newer });
    expect(
      store.getSnapshotRepository(
        asSnapshotId("snap_pinned"),
        asRepositoryId("R_1"),
      )?.stargazerCount,
    ).toBe(10);
    expect(
      store.getRepositoryMetadata(asRepositoryId("R_1"))?.repository
        .stargazerCount,
    ).toBe(50);
    expect(
      store.getSnapshotRepository(
        asSnapshotId("snap_pinned"),
        asRepositoryId("R_1"),
      ),
    ).not.toBe(first);
  });

  test("authenticates List and both membership pagination directions", () => {
    const store = openStore();
    acquireSync(store);
    const snapshot = completeSnapshot(store, { batch: twoItemBatch() });
    const firstListPage = store.queryLists({
      snapshotId: snapshot.id,
      pageSize: 1,
      cursor: null,
    });
    expect(firstListPage.items[0]).not.toHaveProperty("repositoryIds");
    expect(firstListPage.items[0]?.repositoryCount).toBeGreaterThan(0);
    expect(
      store.queryLists({
        snapshotId: snapshot.id,
        pageSize: 1,
        cursor: firstListPage.nextCursor,
      }).items,
    ).toHaveLength(1);

    const byList = store.queryListMemberships({
      snapshotId: snapshot.id,
      selector: { kind: "list", listId: asUserListId("UL_1") },
      pageSize: 1,
      cursor: null,
    });
    expect("repositoryIds" in byList && byList.repositoryIds).toHaveLength(1);
    const byListNext = store.queryListMemberships({
      snapshotId: snapshot.id,
      selector: { kind: "list", listId: asUserListId("UL_1") },
      pageSize: 1,
      cursor: byList.nextCursor,
    });
    expect(
      "repositoryIds" in byListNext && byListNext.repositoryIds,
    ).toHaveLength(1);

    const byRepository = store.queryListMemberships({
      snapshotId: snapshot.id,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
      pageSize: 1,
      cursor: null,
    });
    expect("listIds" in byRepository && byRepository.listIds).toHaveLength(1);
    expect(() =>
      store.queryListMemberships({
        snapshotId: snapshot.id,
        selector: {
          kind: "repository",
          repositoryId: asRepositoryId("R_1"),
        },
        pageSize: 1,
        cursor: byList.nextCursor,
      }),
    ).toThrow(/selection|resource|membership/iu);
    const tampered = `${byList.nextCursor?.slice(0, -1)}A`;
    expect(() =>
      store.queryListMemberships({
        snapshotId: snapshot.id,
        selector: { kind: "list", listId: asUserListId("UL_1") },
        pageSize: 1,
        cursor: tampered,
      }),
    ).toThrow();
  });
});

describe("plans, runs, attempts, reconciliation, and audit bounds", () => {
  test("enforces one plan/run, immutable operation identity, and idempotency", () => {
    const store = openStore();
    prepareRun(store);
    expect(() =>
      store.createRun({
        run: parseChangeRun({ ...changeRunFixture, id: "run_other" }),
        lease: APPLY_GUARD,
      }),
    ).toThrow(/one run/iu);
    expect(() =>
      store.createRunOperation({
        operation: parseRunOperation({
          ...pendingOperationFixture,
          before: { starred: false },
        }),
        lease: APPLY_GUARD,
      }),
    ).toThrow(/plan|immutable/iu);

    store.savePlan(changePlanFixture);
    store.createRun({ run: changeRunFixture, lease: APPLY_GUARD });
    store.createRunOperation({
      operation: pendingOperationFixture,
      lease: APPLY_GUARD,
    });
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    store.createRunOperation({
      operation: pendingOperationFixture,
      lease: APPLY_GUARD,
    });
    expect(store.getRun(changeRunFixture.id)?.state).toBe("running");
    expect(
      store.getRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
      })?.status,
    ).toBe("running");
  });

  test("preserves attempts and append-only reconciliation across retries", () => {
    const store = openStore();
    prepareRun(store);
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    store.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      externalRequestId: "req_1",
      after: { starred: true },
      error: retryableError(),
      finishedAt: "2026-07-16T02:03:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(
      store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 1,
      })?.status,
    ).toBe("failed");
    store.retryRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      maxAttempts: 2,
      lease: APPLY_GUARD,
    });
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:04:00.000Z",
      lease: APPLY_GUARD,
    });
    store.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "unresolved",
      reconciliation: "unknown",
      externalRequestId: null,
      after: null,
      error: unknownError(),
      finishedAt: "2026-07-16T02:05:00.000Z",
      lease: APPLY_GUARD,
    });
    store.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "unresolved",
      reconciliation: "unknown",
      after: null,
      error: unknownError(),
      observedAt: "2026-07-16T02:06:00.000Z",
      lease: APPLY_GUARD,
    });
    store.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "unresolved",
      reconciliation: "unknown",
      after: null,
      error: unknownError(),
      observedAt: "2026-07-16T02:07:00.000Z",
      lease: APPLY_GUARD,
    });
    store.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      after: { starred: true },
      error: retryableError(),
      observedAt: "2026-07-16T02:08:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(() =>
      store.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        maxAttempts: 2,
        lease: APPLY_GUARD,
      }),
    ).toThrow(/eligible/iu);
    expect(
      store.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        maxAttempts: 3,
        lease: APPLY_GUARD,
      }).status,
    ).toBe("pending");
    const attempts = store.listRunOperationAttemptsPage({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      afterAttempt: null,
      pageSize: 1,
    });
    expect(attempts.total).toBe(2);
    expect(attempts.nextAttempt).toBe(1);
    expect(
      store.listRunOperationAttemptsPage({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        afterAttempt: attempts.nextAttempt,
        pageSize: 10,
      }).items,
    ).toHaveLength(1);
    const reconciliations = store.listRunOperationReconciliationsPage({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      afterEventSequence: null,
      pageSize: 10,
    });
    expect(reconciliations.items.map(({ status }) => status)).toEqual([
      "unresolved",
      "unresolved",
      "failed",
    ]);
    expect(
      store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 2,
      })?.finishedAt,
    ).toBe("2026-07-16T02:05:00.000Z");
  });

  test("finishes before dispatch without creating an attempt and validates pages", () => {
    const store = openStore();
    prepareRun(store);
    const result = store.finishRunOperation({
      phase: "before_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      error: retryableError(),
      finishedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(result.attempts).toBe(0);
    expect(
      store.listRunOperationAttemptsPage({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        afterAttempt: null,
        pageSize: 10,
      }).total,
    ).toBe(0);
    expect(() =>
      store.listRunOperationsPage({
        runId: changeRunFixture.id,
        afterSequence: 1,
        pageSize: 10,
      }),
    ).toThrow(/beyond/iu);
    expect(() =>
      store.listRunOperationsPage({
        runId: changeRunFixture.id,
        afterSequence: null,
        pageSize: 101,
      }),
    ).toThrow(/page size/iu);
  });

  test("validates all requested CAS edges before reading and requires fresh finish times", () => {
    const store = openStore();
    store.acquireLease({
      name: APPLY_GUARD.name,
      ownerId: APPLY_GUARD.ownerId,
      now: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T02:10:00.000Z",
    });
    expect(() =>
      store.compareAndSetPlanState({
        planId: asPlanId("missing"),
        expected: ["applied"],
        next: "applying",
      }),
    ).toThrow(/transition/iu);
    store.savePlan(changePlanFixture);
    store.compareAndSetPlanState({
      planId: changePlanFixture.id,
      expected: ["ready"],
      next: "applying",
    });
    store.createRun({ run: changeRunFixture, lease: APPLY_GUARD });
    store.compareAndSetRunState({
      runId: changeRunFixture.id,
      expected: ["pending"],
      next: "running",
      finishedAt: null,
      lease: APPLY_GUARD,
    });
    expect(() =>
      store.compareAndSetRunState({
        runId: changeRunFixture.id,
        expected: ["running"],
        next: "partial",
        finishedAt: "2026-07-16T02:00:30.000Z",
        lease: APPLY_GUARD,
      }),
    ).toThrow(/finishedAt/iu);
    expect(
      store.compareAndSetRunState({
        runId: changeRunFixture.id,
        expected: ["running"],
        next: "partial",
        finishedAt: "2026-07-16T02:02:00.000Z",
        lease: APPLY_GUARD,
      }).state,
    ).toBe("partial");
  });
});

describe("leases, targeted takeover recovery, and bounded summaries", () => {
  test("rejects active same-owner reacquire and enforces renew/takeover ownership", () => {
    const store = openStore();
    const first = store.acquireLease({
      name: "sync",
      ownerId: "p1",
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:05:00.000Z",
    });
    expect(first?.ownerId).toBe("p1");
    expect(
      store.acquireLease({
        name: "sync",
        ownerId: "p1",
        now: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
      }),
    ).toBeNull();
    expect(() =>
      store.renewLease({
        name: "sync",
        ownerId: "p2",
        now: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
      }),
    ).toThrow(/owner|renew/iu);
    expect(
      store.renewLease({
        name: "sync",
        ownerId: "p1",
        now: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
      }).acquiredAt,
    ).toBe(first?.acquiredAt);
    expect(() =>
      store.renewLease({
        name: "sync",
        ownerId: "p1",
        now: "2026-07-16T00:00:30.000Z",
        expiresAt: "2026-07-16T00:07:00.000Z",
      }),
    ).toThrow(/backward|time|renew/iu);
    expect(
      store.acquireLease({
        name: "sync",
        ownerId: "p2",
        now: "2026-07-16T00:07:00.000Z",
        expiresAt: "2026-07-16T00:10:00.000Z",
      })?.ownerId,
    ).toBe("p2");
    expect(() => store.releaseLease({ name: "sync", ownerId: "p1" })).toThrow(
      /owner/iu,
    );
  });

  test("requires the same account-scoped lease name for targeted snapshot recovery", () => {
    const store = openStore();
    store.acquireLease({
      name: "sync:U_1",
      ownerId: "old",
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:05:00.000Z",
    });
    const oldGuard = {
      name: "sync:U_1",
      ownerId: "old",
      now: "2026-07-16T00:01:00.000Z",
    } as const;
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_abandoned",
    });
    store.createSnapshot({ draft, lease: oldGuard });
    expect(
      store.recoverIncompleteSnapshots("2026-07-16T00:03:00.000Z"),
    ).toEqual([]);

    store.acquireLease({
      name: "unrelated",
      ownerId: "other",
      now: "2026-07-16T00:06:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    expect(
      store.recoverAbandonedSnapshots({
        binding: accountBindingFixture,
        lease: {
          name: "unrelated",
          ownerId: "other",
          now: "2026-07-16T00:06:30.000Z",
        },
      }),
    ).toEqual([]);
    store.acquireLease({
      name: "sync:U_1",
      ownerId: "new",
      now: "2026-07-16T00:06:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    expect(
      store.recoverAbandonedSnapshots({
        binding: accountBindingFixture,
        lease: {
          name: "sync:U_1",
          ownerId: "new",
          now: "2026-07-16T00:06:30.000Z",
        },
      }),
    ).toEqual([draft.id]);
    expect(
      store.recoverIncompleteSnapshots("2026-07-16T00:07:00.000Z"),
    ).toEqual([]);
  });

  test("recovers pending/running audit state once and rebinds a resumed run", () => {
    const store = openStore();
    prepareRun(store);
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(store.recoverInterruptedRuns("2026-07-16T02:03:00.000Z")).toEqual(
      [],
    );
    store.acquireLease({
      name: APPLY_GUARD.name,
      ownerId: "new-owner",
      now: "2026-07-16T02:11:00.000Z",
      expiresAt: "2026-07-16T02:20:00.000Z",
    });
    const resumed = {
      name: APPLY_GUARD.name,
      ownerId: "new-owner",
      now: "2026-07-16T02:12:00.000Z",
    } as const;
    expect(
      store.recoverAbandonedRuns({
        binding: accountBindingFixture,
        lease: resumed,
      }),
    ).toEqual([changeRunFixture.id]);
    expect(
      store.getRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
      })?.status,
    ).toBe("unresolved");
    expect(
      store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 1,
      })?.status,
    ).toBe("unresolved");
    expect(store.recoverInterruptedRuns("2026-07-16T02:13:00.000Z")).toEqual(
      [],
    );
    expect(
      store.compareAndSetRunState({
        runId: changeRunFixture.id,
        expected: ["partial"],
        next: "running",
        finishedAt: null,
        lease: resumed,
      }).state,
    ).toBe("running");
  });

  test("bounds incomplete summaries while reporting full totals and status counts", () => {
    const store = openStore();
    store.acquireLease({
      name: APPLY_GUARD.name,
      ownerId: APPLY_GUARD.ownerId,
      now: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T02:10:00.000Z",
    });
    for (let index = 1; index <= 2; index += 1) {
      const plan = parseChangePlan({
        ...changePlanFixture,
        id: `plan_${index}`,
      });
      const run = parseChangeRun({
        ...changeRunFixture,
        id: `run_${index}`,
        planId: plan.id,
      });
      store.savePlan(plan);
      store.compareAndSetPlanState({
        planId: plan.id,
        expected: ["ready"],
        next: "applying",
      });
      store.createRun({ run, lease: APPLY_GUARD });
    }
    const result = store.getIncompleteRunSummaries({
      binding: accountBindingFixture,
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.items[0]?.counts).toEqual({
      pending: 0,
      running: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      unresolved: 0,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
