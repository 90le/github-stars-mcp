import { describe, expect, test } from "vitest";
import type {
  LeaseGuard,
  StoragePort,
  StorageTransaction,
} from "../../src/app/ports/storage-port.js";
import { AppError } from "../../src/domain/errors.js";
import {
  asRepositoryDatabaseId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
  asPlanId,
  type PlanId,
  type RunId,
  type SnapshotId,
} from "../../src/domain/ids.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  type ChangePlan,
  type PlanExecutableContent,
  type ResolvedOperation,
} from "../../src/domain/plan.js";
import type { AccountBinding } from "../../src/domain/repository.js";
import {
  parseChangeRun,
  parseRunOperation,
  parseRunOperationAttempt,
  type ChangeRun,
  type RunOperation,
} from "../../src/domain/run.js";
import {
  parseSnapshotBatch,
  parseSnapshotDraft,
  type ListCoverage,
  type Snapshot,
  type SnapshotBatch,
} from "../../src/domain/snapshot.js";
import {
  accountBindingFixture,
  changePlanFixture,
  changeRunFixture,
  pendingOperationFixture,
  snapshotBatchFixture,
  snapshotDraftFixture,
} from "../fixtures/domain.js";

export interface StoragePortContractInstance {
  readonly store: StoragePort;
  cleanup(): void;
}

export type StoragePortContractFactory = () => StoragePortContractInstance;

type FinalListCoverage = Exclude<ListCoverage, "collecting">;

export interface SeedCompleteSnapshotOptions {
  readonly id?: SnapshotId;
  readonly binding?: AccountBinding;
  readonly listCoverage?: FinalListCoverage;
  readonly batch?: SnapshotBatch;
}

function fixtureBatchForCoverage(coverage: FinalListCoverage): SnapshotBatch {
  return coverage === "complete"
    ? snapshotBatchFixture
    : parseSnapshotBatch({
        repositories: snapshotBatchFixture.repositories,
        stars: snapshotBatchFixture.stars,
        lists: [],
        memberships: [],
      });
}

export function seedCompleteSnapshot(
  store: StoragePort,
  options: SeedCompleteSnapshotOptions = {},
): Snapshot {
  const id = options.id ?? snapshotDraftFixture.id;
  const binding = options.binding ?? accountBindingFixture;
  const listCoverage = options.listCoverage ?? "complete";
  const batch = options.batch ?? fixtureBatchForCoverage(listCoverage);
  const leaseName = `seed:${id}`;
  const ownerId = `owner:${id}`;
  const guard: LeaseGuard = {
    name: leaseName,
    ownerId,
    now: "2026-07-16T00:01:00.000Z",
  };
  const lease = store.acquireLease({
    name: leaseName,
    ownerId,
    now: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-16T00:10:00.000Z",
  });
  if (lease === null) {
    throw new Error("snapshot seed lease was not acquired");
  }
  const draft = parseSnapshotDraft({
    ...snapshotDraftFixture,
    id,
    binding,
    listCoverage: listCoverage === "complete" ? "collecting" : listCoverage,
  });
  store.createSnapshot({ draft, lease: guard });
  store.appendSnapshotBatch({ id, batch, lease: guard });
  store.beginSnapshotVerification({ id, listCoverage, lease: guard });
  store.appendSnapshotVerificationBatch({
    id,
    batch: {
      stars: batch.stars,
      lists: batch.lists,
      memberships: batch.memberships,
    },
    lease: guard,
  });
  store.finishSnapshotVerification({ id, lease: guard });
  const snapshot = store.completeSnapshot({
    id,
    completedAt: "2026-07-16T00:02:00.000Z",
    listCoverage,
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
  store.releaseLease({ name: leaseName, ownerId });
  return snapshot;
}

function planWithExecutable(executable: PlanExecutableContent): ChangePlan {
  return parseChangePlan({
    ...changePlanFixture,
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : "non-app-error";
  }
}

function caughtAppError(operation: () => unknown): AppError | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
}

const APPLY_LEASE = Object.freeze({
  name: "apply:contract",
  ownerId: "apply-contract-owner",
  now: "2026-07-16T02:01:00.000Z",
});
const MIGRATION_TIME = "2026-07-16T00:00:00.000Z";

const RETRYABLE_ERROR = Object.freeze({
  code: "GITHUB_UNAVAILABLE",
  message: "transport failed",
  retryable: true,
  details: Object.freeze({ marker: "[REDACTED]" }),
} as const);

const UNKNOWN_ERROR = Object.freeze({
  code: "RECONCILIATION_REQUIRED",
  message: "outcome unknown",
  retryable: false,
  details: Object.freeze({ marker: "[REDACTED]" }),
} as const);

const NON_RETRYABLE_ERROR = Object.freeze({
  code: "GITHUB_UNAVAILABLE",
  message: "permanent transport outcome",
  retryable: false,
  details: Object.freeze({ marker: "[REDACTED]" }),
} as const);

function planFixture(id: string): ChangePlan {
  return parseChangePlan({
    ...changePlanFixture,
    id: asPlanId(id),
  });
}

function unicodeDependencyPlan(id: string): ChangePlan {
  const root = {
    ...changePlanFixture.operations[0]!,
    operationId: "op_root",
  } as ResolvedOperation;
  const surrogate = {
    ...changePlanFixture.operations[0]!,
    operationId: "op_𐀀",
    dependsOn: ["op_root"],
  } as ResolvedOperation;
  const privateUse = {
    ...changePlanFixture.operations[0]!,
    operationId: "op_\uE000",
    dependsOn: ["op_root"],
  } as ResolvedOperation;
  const executable: PlanExecutableContent = {
    ...changePlanFixture.executable,
    operations: [root, surrogate, privateUse],
    dependencies: [
      { operationId: "op_𐀀", dependsOnOperationId: "op_root" },
      { operationId: "op_\uE000", dependsOnOperationId: "op_root" },
    ],
  };
  return parseChangePlan({
    ...changePlanFixture,
    id: asPlanId(id),
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function multiOperationPlan(id: string, count: number): ChangePlan {
  const operations: ResolvedOperation[] = [];
  for (let index = 0; index < count; index += 1) {
    operations.push({
      ...changePlanFixture.operations[0]!,
      operationId: `op_${String(index)}`,
      dependsOn: [],
    });
  }
  const executable: PlanExecutableContent = {
    ...changePlanFixture.executable,
    operations,
    dependencies: [],
  };
  return parseChangePlan({
    ...changePlanFixture,
    id: asPlanId(id),
    hash: hashPlanExecutable(executable),
    executable,
    operations,
    dependencies: [],
  });
}

function runFixture(
  id: string,
  planId: PlanId,
  startedAt = changeRunFixture.startedAt,
): ChangeRun {
  return parseChangeRun({
    ...changeRunFixture,
    id: asRunId(id),
    planId,
    startedAt,
  });
}

function operationFixture(
  runId: RunId,
  overrides: Partial<RunOperation> = {},
): RunOperation {
  return parseRunOperation({
    ...pendingOperationFixture,
    runId,
    ...overrides,
  });
}

function acquireApplyLease(
  store: StoragePort,
  input: {
    readonly name?: string;
    readonly ownerId?: string;
    readonly acquiredAt?: string;
    readonly expiresAt?: string;
  } = {},
): LeaseGuard {
  const name = input.name ?? APPLY_LEASE.name;
  const ownerId = input.ownerId ?? APPLY_LEASE.ownerId;
  const acquiredAt = input.acquiredAt ?? "2026-07-16T02:00:00.000Z";
  const expiresAt = input.expiresAt ?? "2026-07-16T02:10:00.000Z";
  const lease = store.acquireLease({
    name,
    ownerId,
    now: acquiredAt,
    expiresAt,
  });
  if (lease === null) throw new Error("apply lease was not acquired");
  return Object.freeze({
    name,
    ownerId,
    now:
      acquiredAt < "2026-07-16T02:01:00.000Z"
        ? "2026-07-16T02:01:00.000Z"
        : acquiredAt,
  });
}

interface PreparedRun {
  readonly plan: ChangePlan;
  readonly run: ChangeRun;
  readonly operation: RunOperation;
  readonly lease: LeaseGuard;
}

function preparePendingRun(
  store: StoragePort,
  suffix = "contract",
  options: {
    readonly lease?: LeaseGuard;
    readonly startedAt?: string;
    readonly planId?: PlanId;
    readonly runId?: RunId;
  } = {},
): PreparedRun {
  if (
    store.getCompleteSnapshot(changePlanFixture.executable.snapshotId) === null
  ) {
    seedCompleteSnapshot(store);
  }
  const lease = options.lease ?? acquireApplyLease(store);
  const plan = planFixture(options.planId ?? `plan_${suffix}`);
  const run = runFixture(
    options.runId ?? `run_${suffix}`,
    plan.id,
    options.startedAt,
  );
  const operation = operationFixture(run.id);
  store.savePlan(plan);
  store.compareAndSetPlanState({
    planId: plan.id,
    expected: ["ready"],
    next: "applying",
  });
  store.createRun({ run, lease });
  return { plan, run, operation, lease };
}

function prepareRunningRun(
  store: StoragePort,
  suffix = "contract",
  options: {
    readonly lease?: LeaseGuard;
    readonly startedAt?: string;
    readonly createOperation?: boolean;
    readonly planId?: PlanId;
    readonly runId?: RunId;
  } = {},
): PreparedRun {
  const prepared = preparePendingRun(store, suffix, options);
  const { plan, run, operation, lease } = prepared;
  store.compareAndSetRunState({
    runId: run.id,
    expected: ["pending"],
    next: "running",
    finishedAt: null,
    lease,
  });
  if (options.createOperation !== false) {
    store.createRunOperation({ operation, lease });
  }
  return { plan, run, operation, lease };
}

function cleanupInstance(instance: StoragePortContractInstance): void {
  instance.cleanup();
}

function expectPlanCoverageResult(
  factory: StoragePortContractFactory,
  executable: PlanExecutableContent,
  listCoverage: FinalListCoverage,
  expectedCode: string | undefined,
): void {
  const instance = factory();
  try {
    seedCompleteSnapshot(instance.store, { listCoverage });
    expect(
      errorCode(() => instance.store.savePlan(planWithExecutable(executable))),
    ).toBe(expectedCode);
  } finally {
    instance.cleanup();
  }
}

export function defineStoragePortContract(
  label: string,
  factory: StoragePortContractFactory,
): void {
  describe(`${label} StoragePort contract`, () => {
    test("requires the exact complete source snapshot before saving a plan", () => {
      const missing = factory();
      try {
        expect(errorCode(() => missing.store.savePlan(changePlanFixture))).toBe(
          "NOT_FOUND",
        );
      } finally {
        missing.cleanup();
      }

      const incomplete = factory();
      try {
        const guard = {
          name: "seed:incomplete",
          ownerId: "owner:incomplete",
          now: "2026-07-16T00:01:00.000Z",
        } as const;
        incomplete.store.acquireLease({
          ...guard,
          now: "2026-07-16T00:00:00.000Z",
          expiresAt: "2026-07-16T00:10:00.000Z",
        });
        incomplete.store.createSnapshot({
          draft: snapshotDraftFixture,
          lease: guard,
        });
        expect(
          errorCode(() => incomplete.store.savePlan(changePlanFixture)),
        ).toBe("PRECONDITION_FAILED");
      } finally {
        incomplete.cleanup();
      }

      const mismatched = factory();
      try {
        seedCompleteSnapshot(mismatched.store, {
          binding: {
            ...accountBindingFixture,
            accountId: "U_other",
          },
        });
        expect(
          errorCode(() => mismatched.store.savePlan(changePlanFixture)),
        ).toBe("PRECONDITION_FAILED");
      } finally {
        mismatched.cleanup();
      }
    });

    test("allows every Star-only coverage exception and fails closed for List dependencies", () => {
      for (const listCoverage of ["unavailable", "omitted"] as const) {
        expectPlanCoverageResult(
          factory,
          changePlanFixture.executable,
          listCoverage,
          undefined,
        );
      }
      expectPlanCoverageResult(
        factory,
        {
          ...changePlanFixture.executable,
          protectedRepositoryIds: [asRepositoryId("R_protected")],
        },
        "unavailable",
        undefined,
      );
      expectPlanCoverageResult(
        factory,
        {
          ...changePlanFixture.executable,
          operations: [
            {
              ...changePlanFixture.operations[0]!,
              preconditions: [{ kind: "star_state", expected: true }],
            },
          ],
        },
        "omitted",
        undefined,
      );
      for (const preconditionKind of [
        "list_ids",
        "future_precondition",
      ] as const) {
        expectPlanCoverageResult(
          factory,
          {
            ...changePlanFixture.executable,
            operations: [
              {
                ...changePlanFixture.operations[0]!,
                preconditions: [{ kind: preconditionKind, expected: ["UL_1"] }],
              },
            ],
          },
          "unavailable",
          "CAPABILITY_UNAVAILABLE",
        );
      }
      expectPlanCoverageResult(
        factory,
        {
          ...changePlanFixture.executable,
          protectedListIds: [asUserListId("UL_1")],
        },
        "omitted",
        "CAPABILITY_UNAVAILABLE",
      );

      const operationBase = {
        operationId: "op_1",
        dependsOn: [],
        preconditions: [],
        before: {},
        after: {},
        inverse: {},
        risk: "normal",
      } as const;
      const listOperations: readonly ResolvedOperation[] = [
        {
          ...operationBase,
          kind: "list_create",
          clientRef: "created-list",
        },
        {
          ...operationBase,
          kind: "list_update",
          listId: asUserListId("UL_1"),
        },
        {
          ...operationBase,
          kind: "list_delete",
          listId: asUserListId("UL_1"),
        },
        {
          ...operationBase,
          kind: "list_membership_set",
          repositoryId: asRepositoryId("R_1"),
          repositoryDatabaseId: asRepositoryDatabaseId("42"),
          coordinates: { owner: "OpenAI", name: "SDK" },
          expectedListIds: [],
          targetLists: [],
        },
      ];
      for (const operation of listOperations) {
        expectPlanCoverageResult(
          factory,
          {
            ...changePlanFixture.executable,
            operations: [operation],
          },
          "unavailable",
          "CAPABILITY_UNAVAILABLE",
        );
      }
    });

    test("returns a frozen detached snapshot from the public seed helper", () => {
      const instance = factory();
      try {
        const snapshot = seedCompleteSnapshot(instance.store, {
          id: asSnapshotId("snap_contract_seed"),
        });
        expect(snapshot.status).toBe("complete");
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(instance.store.getCompleteSnapshot(snapshot.id)).toEqual(
          snapshot,
        );
      } finally {
        instance.cleanup();
      }
    });

    test("enforces the ready/closed lifecycle and the complete lease matrix", () => {
      const instance = factory();
      const { store } = instance;
      try {
        expect(store.getSchemaVersion()).toBe(1);
        store.migrate();
        expect(store.getSchemaVersion()).toBe(1);

        const first = store.acquireLease({
          name: "contract:lease",
          ownerId: "owner-1",
          now: "2026-07-16T00:00:00.000Z",
          expiresAt: "2026-07-16T00:05:00.000Z",
        });
        expect(first).toMatchObject({
          name: "contract:lease",
          ownerId: "owner-1",
        });
        expect(Object.isFrozen(first)).toBe(true);
        expect(
          store.acquireLease({
            name: "contract:lease",
            ownerId: "owner-1",
            now: "2026-07-16T00:01:00.000Z",
            expiresAt: "2026-07-16T00:06:00.000Z",
          }),
        ).toBeNull();
        expect(
          store.acquireLease({
            name: "contract:lease",
            ownerId: "owner-2",
            now: "2026-07-16T00:01:00.000Z",
            expiresAt: "2026-07-16T00:06:00.000Z",
          }),
        ).toBeNull();
        expect(
          errorCode(() =>
            store.renewLease({
              name: "contract:lease",
              ownerId: "owner-2",
              now: "2026-07-16T00:01:00.000Z",
              expiresAt: "2026-07-16T00:06:00.000Z",
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            store.renewLease({
              name: "contract:lease",
              ownerId: "owner-1",
              now: "2026-07-15T23:59:00.000Z",
              expiresAt: "2026-07-16T00:06:00.000Z",
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            store.renewLease({
              name: "contract:lease",
              ownerId: "owner-1",
              now: "2026-07-16T00:01:00.000Z",
              expiresAt: "2026-07-16T00:05:00.000Z",
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        const renewed = store.renewLease({
          name: "contract:lease",
          ownerId: "owner-1",
          now: "2026-07-16T00:01:00.000Z",
          expiresAt: "2026-07-16T00:06:00.000Z",
        });
        expect(renewed.acquiredAt).toBe(first?.acquiredAt);
        expect(Object.isFrozen(renewed)).toBe(true);
        expect(
          errorCode(() =>
            store.releaseLease({
              name: "contract:lease",
              ownerId: "owner-2",
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.acquireLease({
            name: "contract:lease",
            ownerId: "owner-2",
            now: "2026-07-16T00:06:00.000Z",
            expiresAt: "2026-07-16T00:10:00.000Z",
          })?.ownerId,
        ).toBe("owner-2");
        store.releaseLease({
          name: "contract:lease",
          ownerId: "owner-2",
        });

        store.close();
        store.close();
        expect(errorCode(() => store.migrate())).toBe("STORAGE_ERROR");
        expect(errorCode(() => store.getSchemaVersion())).toBe("STORAGE_ERROR");
        expect(errorCode(() => store.getPlan(changePlanFixture.id))).toBe(
          "STORAGE_ERROR",
        );
        expect(
          errorCode(() =>
            store.acquireLease({
              name: "closed",
              ownerId: "closed",
              now: MIGRATION_TIME,
              expiresAt: "2026-07-16T00:01:00.000Z",
            }),
          ),
        ).toBe("STORAGE_ERROR");
      } finally {
        cleanupInstance(instance);
      }
    });

    test("commits and rolls back cross-repository transaction work", () => {
      const instance = factory();
      const { store } = instance;
      try {
        seedCompleteSnapshot(store);
        expect(() =>
          store.withTransaction((tx) => {
            tx.savePlan(changePlanFixture);
            tx.acquireLease({
              name: "contract:rolled-back",
              ownerId: "contract-owner",
              now: "2026-07-16T03:00:00.000Z",
              expiresAt: "2026-07-16T03:10:00.000Z",
            });
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(store.getPlan(changePlanFixture.id)).toBeNull();
        expect(
          store.acquireLease({
            name: "contract:rolled-back",
            ownerId: "contract-owner",
            now: "2026-07-16T03:00:00.000Z",
            expiresAt: "2026-07-16T03:10:00.000Z",
          }),
        ).not.toBeNull();
        store.releaseLease({
          name: "contract:rolled-back",
          ownerId: "contract-owner",
        });

        const input = {
          committed: true,
          nested: { values: ["one"] },
        };
        const returned = store.withTransaction((tx) => {
          expect(
            errorCode(() =>
              tx.releaseLease({
                name: "missing",
                ownerId: "missing",
              }),
            ),
          ).toBe("NOT_FOUND");
          tx.savePlan(changePlanFixture);
          tx.acquireLease({
            name: "contract:committed",
            ownerId: "contract-owner",
            now: "2026-07-16T03:00:00.000Z",
            expiresAt: "2026-07-16T03:10:00.000Z",
          });
          return input;
        });
        input.nested.values.push("mutated");
        expect(returned).toEqual({
          committed: true,
          nested: { values: ["one"] },
        });
        expect(returned).not.toBe(input);
        expect(Object.isFrozen(returned)).toBe(true);
        expect(Object.isFrozen(returned.nested)).toBe(true);
        expect(Object.isFrozen(returned.nested.values)).toBe(true);
        expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
        expect(store.withTransaction(() => undefined)).toBeUndefined();
      } finally {
        instance.cleanup();
      }
    });

    test("rejects hostile transaction returns without invoking user code or committing", () => {
      const instance = factory();
      const { store } = instance;
      let getterCalls = 0;
      let thenGetterCalls = 0;
      let trapCalls = 0;
      try {
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
        const nestedProxy = new Proxy(proxy, {});
        const ownThenAccessor = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(ownThenAccessor, "then", {
          enumerable: true,
          get() {
            thenGetterCalls += 1;
            throw new Error("own then getter was invoked");
          },
        });
        const thenPrototype = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(thenPrototype, "then", {
          enumerable: true,
          get() {
            thenGetterCalls += 1;
            throw new Error("inherited then getter was invoked");
          },
        });
        const inheritedThenable = Object.create(thenPrototype) as object;
        const customPrototype = Object.create({
          inherited: true,
        }) as object;
        const nestedCustomPrototype = Object.create({
          inherited: true,
        }) as object;
        const symbolValue = { [Symbol("hidden")]: true };
        const sparse = new Array<unknown>(1);
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        const prototypeErasedExotics: object[] = [
          new Map(),
          new Set(),
          new WeakMap(),
          new WeakSet(),
          Promise.resolve(true),
          new Date(0),
          /contract/u,
          new Error("contract"),
          new ArrayBuffer(8),
          new Uint8Array(8),
        ];
        if (typeof SharedArrayBuffer === "function") {
          prototypeErasedExotics.push(new SharedArrayBuffer(8));
        }
        for (const exotic of prototypeErasedExotics) {
          Object.setPrototypeOf(exotic, null);
        }
        const invalidResults: readonly unknown[] = [
          Promise.resolve(true),
          { then() {} },
          ownThenAccessor,
          inheritedThenable,
          customPrototype,
          { nested: nestedCustomPrototype },
          proxy,
          nestedProxy,
          new Map(),
          new Set(),
          new WeakMap(),
          new WeakSet(),
          new Date(0),
          /contract/u,
          new Error("contract"),
          new ArrayBuffer(8),
          new Uint8Array(8),
          ...prototypeErasedExotics,
          accessor,
          symbolValue,
          sparse,
          cycle,
          () => true,
        ];
        invalidResults.forEach((invalid, index) => {
          const name = `contract:invalid:${String(index)}`;
          expect(
            errorCode(() =>
              store.withTransaction((tx) => {
                tx.acquireLease({
                  name,
                  ownerId: "contract-owner",
                  now: "2026-07-16T03:00:00.000Z",
                  expiresAt: "2026-07-16T03:10:00.000Z",
                });
                return invalid;
              }),
            ),
          ).toBe("PRECONDITION_FAILED");
          expect(
            store.acquireLease({
              name,
              ownerId: "contract-owner",
              now: "2026-07-16T03:00:00.000Z",
              expiresAt: "2026-07-16T03:10:00.000Z",
            }),
          ).not.toBeNull();
          store.releaseLease({ name, ownerId: "contract-owner" });
        });
        expect(getterCalls).toBe(0);
        expect(thenGetterCalls).toBe(0);
        expect(trapCalls).toBe(0);
        const protoData = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(protoData, "__proto__", {
          configurable: true,
          enumerable: true,
          value: { inert: true },
          writable: true,
        });
        const accepted = store.withTransaction((tx) => {
          tx.acquireLease({
            name: "contract:proto-data",
            ownerId: "contract-owner",
            now: "2026-07-16T03:00:00.000Z",
            expiresAt: "2026-07-16T03:10:00.000Z",
          });
          return protoData;
        }) as Readonly<Record<string, unknown>>;
        expect(
          Object.getOwnPropertyDescriptor(accepted, "__proto__"),
        ).toMatchObject({
          enumerable: true,
          value: { inert: true },
        });
        expect(Object.getPrototypeOf(accepted)).toBe(Object.prototype);
        expect(Object.isFrozen(accepted)).toBe(true);
        expect(({} as Record<string, unknown>).inert).toBeUndefined();
        const invalidStore = store as unknown as {
          withTransaction(callback: unknown): unknown;
        };
        expect(errorCode(() => invalidStore.withTransaction(null))).toBe(
          "VALIDATION_ERROR",
        );
      } finally {
        instance.cleanup();
      }
    });

    test("exposes only the frozen repository transaction surface", () => {
      const instance = factory();
      try {
        instance.store.withTransaction((tx) => {
          const surface = tx as unknown as Readonly<Record<string, unknown>>;
          expect(Object.getPrototypeOf(surface)).toBeNull();
          expect(Object.isFrozen(surface)).toBe(true);
          for (const forbidden of [
            "migrate",
            "close",
            "getSchemaVersion",
            "withTransaction",
            "getIncompleteRunSummaries",
            "recoverAbandonedSnapshots",
            "recoverAbandonedRuns",
            "recoverIncompleteSnapshots",
            "recoverInterruptedRuns",
            "database",
            "db",
            "query",
            "execute",
            "prepare",
            "exec",
            "key",
            "runtimeSecret",
          ]) {
            expect(
              Reflect.getOwnPropertyDescriptor(surface, forbidden),
            ).toBeUndefined();
            expect(Reflect.get(surface, forbidden)).toBeUndefined();
            expect(Reflect.has(surface, forbidden)).toBe(false);
          }
          expect("savePlan" in surface).toBe(true);
          expect(typeof surface.savePlan).toBe("function");
          return undefined;
        });
      } finally {
        instance.cleanup();
      }
    });

    test("ignores inherited Proxy traps while introspecting the transaction facade", () => {
      const instance = factory();
      const trapNames = ["getOwnPropertyDescriptor", "getPrototypeOf"] as const;
      const previous = trapNames.map((name) =>
        Object.getOwnPropertyDescriptor(Object.prototype, name),
      );
      let inheritedTrapCalls = 0;
      try {
        try {
          for (const name of trapNames) {
            Object.defineProperty(Object.prototype, name, {
              configurable: true,
              value: () => {
                inheritedTrapCalls += 1;
                throw new Error(`inherited ${name} trap was invoked`);
              },
              writable: true,
            });
          }
          instance.store.withTransaction((tx) => {
            expect(Object.getPrototypeOf(tx)).toBeNull();
            expect(Object.isFrozen(tx)).toBe(true);
            const descriptor = Reflect.getOwnPropertyDescriptor(tx, "savePlan");
            expect(
              descriptor === undefined ||
                typeof descriptor.value === "function",
            ).toBe(true);
            expect("savePlan" in tx).toBe(true);
            return undefined;
          });
        } finally {
          for (let index = 0; index < trapNames.length; index += 1) {
            const name = trapNames[index]!;
            const descriptor = previous[index];
            if (descriptor === undefined) {
              Reflect.deleteProperty(Object.prototype, name);
            } else {
              Object.defineProperty(Object.prototype, name, descriptor);
            }
          }
        }
        expect(inheritedTrapCalls).toBe(0);
      } finally {
        instance.cleanup();
      }
    });

    test("poisons every caught root reentry before return validation and rolls back", () => {
      const instance = factory();
      const { store } = instance;
      try {
        const rootCalls: readonly (() => unknown)[] = [
          () =>
            store.acquireLease({
              name: "ordinary-root",
              ownerId: "ordinary-root",
              now: MIGRATION_TIME,
              expiresAt: "2026-07-16T00:01:00.000Z",
            }),
          () => store.migrate(),
          () => store.close(),
          () => store.getSchemaVersion(),
          () => store.withTransaction(() => null),
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
        ];
        rootCalls.forEach((rootCall, index) => {
          const name = `contract:poison:${String(index)}`;
          const error = caughtAppError(() =>
            store.withTransaction((tx) => {
              tx.acquireLease({
                name,
                ownerId: "contract-owner",
                now: "2026-07-16T03:00:00.000Z",
                expiresAt: "2026-07-16T03:10:00.000Z",
              });
              expect(errorCode(rootCall)).toBe("PRECONDITION_FAILED");
              return Promise.resolve("invalid");
            }),
          );
          expect(error?.code).toBe("PRECONDITION_FAILED");
          expect(error?.message).toBe(
            "root storage reentry invalidated the transaction",
          );
          expect(
            store.acquireLease({
              name,
              ownerId: "contract-owner",
              now: "2026-07-16T03:00:00.000Z",
              expiresAt: "2026-07-16T03:10:00.000Z",
            }),
          ).not.toBeNull();
          store.releaseLease({ name, ownerId: "contract-owner" });
        });
      } finally {
        instance.cleanup();
      }
    });

    test("revokes facades and extracted methods after commit and rollback", async () => {
      const instance = factory();
      const { store } = instance;
      let leaked: StorageTransaction | undefined;
      let extracted: StorageTransaction["acquireLease"] | undefined;
      let rolledBack: StorageTransaction | undefined;
      try {
        store.withTransaction((tx) => {
          leaked = tx;
          const candidate = (tx as unknown as Readonly<Record<string, unknown>>)
            .acquireLease;
          extracted = candidate as StorageTransaction["acquireLease"];
          return null;
        });
        expect(() =>
          leaked!.acquireLease({
            name: "leaked",
            ownerId: "leaked",
            now: MIGRATION_TIME,
            expiresAt: "2026-07-16T00:01:00.000Z",
          }),
        ).toThrow();
        expect(
          errorCode(() =>
            extracted!({
              name: "extracted",
              ownerId: "extracted",
              now: MIGRATION_TIME,
              expiresAt: "2026-07-16T00:01:00.000Z",
            }),
          ),
        ).toBe("PRECONDITION_FAILED");

        expect(() =>
          store.withTransaction((tx) => {
            rolledBack = tx;
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(() => rolledBack!.getPlan(changePlanFixture.id)).toThrow();

        let microtaskCode: string | undefined;
        let releaseMicrotask: (() => void) | undefined;
        const microtaskFinished = new Promise<void>((resolve) => {
          releaseMicrotask = resolve;
        });
        store.withTransaction((tx) => {
          const method = (tx as unknown as Readonly<Record<string, unknown>>)
            .acquireLease as StorageTransaction["acquireLease"];
          queueMicrotask(() => {
            microtaskCode = errorCode(() =>
              method({
                name: "microtask",
                ownerId: "microtask",
                now: MIGRATION_TIME,
                expiresAt: "2026-07-16T00:01:00.000Z",
              }),
            );
            releaseMicrotask?.();
          });
          return undefined;
        });
        await microtaskFinished;
        expect(microtaskCode).toBe("PRECONDITION_FAILED");
      } finally {
        instance.cleanup();
      }
    });

    test("never probes inherited then while committing nested repository work", () => {
      const instance = factory();
      const { store } = instance;
      const previous = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "then",
      );
      let getterCalls = 0;
      let returned: { readonly ok: boolean } | undefined;
      try {
        try {
          Object.defineProperty(Object.prototype, "then", {
            configurable: true,
            get() {
              getterCalls += 1;
              throw new Error("inherited then was read");
            },
          });
          returned = store.withTransaction((tx) => {
            tx.acquireLease({
              name: "contract:sentinel",
              ownerId: "contract-owner",
              now: "2026-07-16T03:00:00.000Z",
              expiresAt: "2026-07-16T03:10:00.000Z",
            });
            return { ok: true };
          });
        } finally {
          if (previous === undefined) {
            Reflect.deleteProperty(Object.prototype, "then");
          } else {
            Object.defineProperty(Object.prototype, "then", previous);
          }
        }
        expect(getterCalls).toBe(0);
        expect(returned).toEqual({ ok: true });
        expect(
          store.assertLease({
            name: "contract:sentinel",
            ownerId: "contract-owner",
            now: "2026-07-16T03:01:00.000Z",
          }).name,
        ).toBe("contract:sentinel");
      } finally {
        instance.cleanup();
      }
    });

    test("round-trips immutable plans without lifecycle reset and preserves UTF-16 dependency order", () => {
      const instance = factory();
      const { store } = instance;
      try {
        seedCompleteSnapshot(store);
        const nonInitial = parseChangePlan({
          ...planFixture("plan_non_initial"),
          state: "applying",
        });
        expect(errorCode(() => store.savePlan(nonInitial))).toBe(
          "PRECONDITION_FAILED",
        );
        const unicode = unicodeDependencyPlan("plan_unicode_contract");
        store.savePlan(unicode);
        const loaded = store.getPlan(unicode.id);
        expect(loaded).toEqual(unicode);
        expect(loaded).not.toBe(unicode);
        expect(Object.isFrozen(loaded)).toBe(true);
        expect(Object.isFrozen(loaded?.executable)).toBe(true);
        expect(
          loaded?.dependencies.map(({ operationId }) => operationId),
        ).toEqual(["op_𐀀", "op_\uE000"]);

        store.savePlan(changePlanFixture);
        store.compareAndSetPlanState({
          planId: changePlanFixture.id,
          expected: ["ready"],
          next: "applying",
        });
        store.savePlan(changePlanFixture);
        expect(store.getPlan(changePlanFixture.id)?.state).toBe("applying");
        const changed = parseChangePlan({
          ...changePlanFixture,
          callerNote: "different immutable content",
        });
        expect(errorCode(() => store.savePlan(changed))).toBe(
          "PRECONDITION_FAILED",
        );
        expect(
          errorCode(() =>
            store.savePlan({
              ...planFixture("plan_bad_hash"),
              hash: "f".repeat(64),
            }),
          ),
        ).toBe("PLAN_HASH_MISMATCH");
      } finally {
        instance.cleanup();
      }
    });

    test("implements every legal plan CAS edge and rejects invalid expected sets", () => {
      const edges = [
        ["ready", "applying"],
        ["ready", "expired"],
        ["ready", "superseded"],
        ["applying", "applied"],
        ["applying", "partial"],
        ["applying", "failed"],
        ["partial", "applying"],
      ] as const;
      for (const [from, next] of edges) {
        const instance = factory();
        try {
          seedCompleteSnapshot(instance.store);
          const plan = planFixture(`plan_edge_${from}_${next}`);
          instance.store.savePlan(plan);
          if (from === "applying" || from === "partial") {
            instance.store.compareAndSetPlanState({
              planId: plan.id,
              expected: ["ready"],
              next: "applying",
            });
          }
          if (from === "partial") {
            instance.store.compareAndSetPlanState({
              planId: plan.id,
              expected: ["applying"],
              next: "partial",
            });
          }
          expect(
            instance.store.compareAndSetPlanState({
              planId: plan.id,
              expected: [from],
              next,
            }).state,
          ).toBe(next);
        } finally {
          instance.cleanup();
        }
      }

      const invalid = factory();
      try {
        seedCompleteSnapshot(invalid.store);
        const plan = planFixture("plan_invalid_edges");
        invalid.store.savePlan(plan);
        expect(
          errorCode(() =>
            invalid.store.compareAndSetPlanState({
              planId: plan.id,
              expected: [],
              next: "applying",
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            invalid.store.compareAndSetPlanState({
              planId: plan.id,
              expected: ["ready", "ready"],
              next: "applying",
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            invalid.store.compareAndSetPlanState({
              planId: plan.id,
              expected: ["applied"],
              next: "ready",
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            invalid.store.compareAndSetPlanState({
              planId: plan.id,
              expected: ["applying"],
              next: "partial",
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            invalid.store.compareAndSetPlanState({
              planId: asPlanId("plan_missing"),
              expected: ["ready"],
              next: "applying",
            }),
          ),
        ).toBe("NOT_FOUND");
      } finally {
        invalid.cleanup();
      }
    });

    test("enforces run identity, binding, lease, one-run, and replay invariants", () => {
      const instance = factory();
      const { store } = instance;
      try {
        seedCompleteSnapshot(store);
        const lease = acquireApplyLease(store);
        const plan = planFixture("plan_run_invariants");
        const run = parseChangeRun({
          ...runFixture("run_invariants", plan.id),
          warnings: ["preserve immutable warning"],
        });
        store.savePlan(plan);
        expect(errorCode(() => store.createRun({ run, lease }))).toBe(
          "PRECONDITION_FAILED",
        );
        store.compareAndSetPlanState({
          planId: plan.id,
          expected: ["ready"],
          next: "applying",
        });
        const nonInitial = parseChangeRun({
          ...run,
          state: "running",
          finishedAt: null,
        });
        expect(
          errorCode(() => store.createRun({ run: nonInitial, lease })),
        ).toBe("PRECONDITION_FAILED");
        const wrongBinding = parseChangeRun({
          ...run,
          binding: {
            ...run.binding,
            accountId: "U_other",
          },
        });
        expect(
          errorCode(() => store.createRun({ run: wrongBinding, lease })),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            store.createRun({
              run,
              lease: { ...lease, ownerId: "wrong-owner" },
            }),
          ),
        ).toBe("PRECONDITION_FAILED");

        store.createRun({ run, lease });
        store.createRun({ run, lease });
        store.compareAndSetRunState({
          runId: run.id,
          expected: ["pending"],
          next: "running",
          finishedAt: null,
          lease,
        });
        store.createRun({ run, lease });
        expect(store.getRun(run.id)?.state).toBe("running");
        expect(Object.isFrozen(store.getRun(run.id))).toBe(true);
        const changed = parseChangeRun({
          ...run,
          warnings: ["different immutable warning"],
        });
        expect(errorCode(() => store.createRun({ run: changed, lease }))).toBe(
          "PRECONDITION_FAILED",
        );
        expect(
          errorCode(() =>
            store.createRun({
              run: runFixture("run_other_for_plan", plan.id),
              lease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        store.compareAndSetRunState({
          runId: run.id,
          expected: ["running"],
          next: "completed",
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease,
        });
        expect(
          errorCode(() =>
            store.createRun({
              run,
              lease: { ...lease, ownerId: "wrong-owner" },
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        store.createRun({ run, lease });
        expect(store.getRun(run.id)).toMatchObject({
          state: "completed",
          finishedAt: "2026-07-16T02:03:00.000Z",
          warnings: ["preserve immutable warning"],
        });
        expect(store.getLatestRunForPlan(plan.id)?.id).toBe(run.id);
      } finally {
        instance.cleanup();
      }
    });

    test("implements every legal run CAS edge with exact finished-time and resume rules", () => {
      const terminalEdges = ["completed", "partial", "failed"] as const;
      for (const next of terminalEdges) {
        const instance = factory();
        try {
          const prepared = preparePendingRun(
            instance.store,
            `run_edge_${next}`,
          );
          instance.store.compareAndSetRunState({
            runId: prepared.run.id,
            expected: ["pending"],
            next: "running",
            finishedAt: null,
            lease: prepared.lease,
          });
          expect(
            instance.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["running"],
              next,
              finishedAt: "2026-07-16T02:03:00.000Z",
              lease: prepared.lease,
            }).state,
          ).toBe(next);
        } finally {
          instance.cleanup();
        }
      }

      const pending = factory();
      try {
        const prepared = preparePendingRun(pending.store, "pending_running");
        expect(
          errorCode(() =>
            pending.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["pending"],
              next: "partial",
              finishedAt: "2026-07-16T02:01:00.000Z",
              lease: prepared.lease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(pending.store.getRun(prepared.run.id)?.state).toBe("pending");
        expect(
          pending.store.compareAndSetRunState({
            runId: prepared.run.id,
            expected: ["pending"],
            next: "running",
            finishedAt: null,
            lease: prepared.lease,
          }).state,
        ).toBe("running");
      } finally {
        pending.cleanup();
      }

      const resumed = factory();
      try {
        const prepared = preparePendingRun(resumed.store, "partial_running");
        resumed.store.compareAndSetRunState({
          runId: prepared.run.id,
          expected: ["pending"],
          next: "running",
          finishedAt: null,
          lease: prepared.lease,
        });
        resumed.store.compareAndSetRunState({
          runId: prepared.run.id,
          expected: ["running"],
          next: "partial",
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease: prepared.lease,
        });
        const newLease = acquireApplyLease(resumed.store, {
          name: "apply:resumed",
          ownerId: "resumed-owner",
          acquiredAt: "2026-07-16T02:04:00.000Z",
          expiresAt: "2026-07-16T02:20:00.000Z",
        });
        expect(
          resumed.store.compareAndSetRunState({
            runId: prepared.run.id,
            expected: ["partial"],
            next: "running",
            finishedAt: null,
            lease: newLease,
          }),
        ).toMatchObject({ state: "running", finishedAt: null });
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["running"],
              next: "partial",
              finishedAt: "2026-07-16T02:05:00.000Z",
              lease: prepared.lease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          resumed.store.compareAndSetRunState({
            runId: prepared.run.id,
            expected: ["running"],
            next: "partial",
            finishedAt: "2026-07-16T02:05:00.000Z",
            lease: newLease,
          }).state,
        ).toBe("partial");
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["partial"],
              next: "running",
              finishedAt: "2026-07-16T02:06:00.000Z",
              lease: newLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: [],
              next: "running",
              finishedAt: null,
              lease: newLease,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["partial", "partial"],
              next: "running",
              finishedAt: null,
              lease: newLease,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        resumed.store.compareAndSetRunState({
          runId: prepared.run.id,
          expected: ["partial"],
          next: "running",
          finishedAt: null,
          lease: newLease,
        });
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["running"],
              next: "failed",
              finishedAt: null,
              lease: newLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["running"],
              next: "partial",
              finishedAt: "2026-07-16T02:03:30.000Z",
              lease: newLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["running"],
              next: "partial",
              finishedAt: "2026-07-16T01:59:00.000Z",
              lease: newLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: prepared.run.id,
              expected: ["pending"],
              next: "running",
              finishedAt: null,
              lease: newLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          errorCode(() =>
            resumed.store.compareAndSetRunState({
              runId: asRunId("run_missing"),
              expected: ["pending"],
              next: "running",
              finishedAt: null,
              lease: newLease,
            }),
          ),
        ).toBe("NOT_FOUND");
      } finally {
        resumed.cleanup();
      }
    });

    test("enforces operation identity and all five finish branches with exact attempt semantics", () => {
      for (const status of ["skipped", "failed"] as const) {
        const instance = factory();
        try {
          const prepared = prepareRunningRun(
            instance.store,
            `before_${status}`,
            { createOperation: false },
          );
          const unrelatedLease = acquireApplyLease(instance.store, {
            name: `apply:unrelated:before:${status}`,
            ownerId: `unrelated-owner:before:${status}`,
          });
          expect(
            errorCode(() =>
              instance.store.createRunOperation({
                operation: prepared.operation,
                lease: unrelatedLease,
              }),
            ),
          ).toBe("PRECONDITION_FAILED");
          expect(
            instance.store.getRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
            }),
          ).toBeNull();
          instance.store.createRunOperation({
            operation: prepared.operation,
            lease: prepared.lease,
          });
          const changed = operationFixture(prepared.run.id, {
            before: { starred: false },
          });
          expect(
            errorCode(() =>
              instance.store.createRunOperation({
                operation: changed,
                lease: prepared.lease,
              }),
            ),
          ).toBe("PRECONDITION_FAILED");
          if (status === "skipped") {
            expect(
              errorCode(() =>
                instance.store.createRunOperation({
                  operation: operationFixture(prepared.run.id, {
                    operationId: "op_wrong",
                  }),
                  lease: prepared.lease,
                }),
              ),
            ).toBe("PRECONDITION_FAILED");
            expect(
              errorCode(() =>
                instance.store.createRunOperation({
                  operation: operationFixture(prepared.run.id, {
                    sequence: 1,
                  }),
                  lease: prepared.lease,
                }),
              ),
            ).toBe("PRECONDITION_FAILED");
            expect(
              errorCode(() =>
                instance.store.createRunOperation({
                  operation: operationFixture(prepared.run.id, {
                    status: "running",
                    reconciliation: "pending",
                    attempts: 1,
                    startedAt: "2026-07-16T02:02:00.000Z",
                  }),
                  lease: prepared.lease,
                }),
              ),
            ).toBe("PRECONDITION_FAILED");
          }
          const result =
            status === "skipped"
              ? instance.store.finishRunOperation({
                  phase: "before_dispatch",
                  runId: prepared.run.id,
                  operationId: prepared.operation.operationId,
                  status: "skipped",
                  reconciliation: "not_required",
                  error: null,
                  finishedAt: "2026-07-16T02:02:00.000Z",
                  lease: prepared.lease,
                })
              : instance.store.finishRunOperation({
                  phase: "before_dispatch",
                  runId: prepared.run.id,
                  operationId: prepared.operation.operationId,
                  status: "failed",
                  reconciliation: "confirmed_not_applied",
                  error: RETRYABLE_ERROR,
                  finishedAt: "2026-07-16T02:02:00.000Z",
                  lease: prepared.lease,
                });
          expect(result).toMatchObject({
            status,
            attempts: 0,
            startedAt: null,
            externalRequestId: null,
            after: null,
          });
          expect(
            instance.store.listRunOperationAttemptsPage({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              afterAttempt: null,
              pageSize: 10,
            }).total,
          ).toBe(0);
        } finally {
          instance.cleanup();
        }
      }

      for (const status of ["succeeded", "failed", "unresolved"] as const) {
        const instance = factory();
        try {
          const prepared = prepareRunningRun(instance.store, `after_${status}`);
          const started = instance.store.startRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            startedAt: "2026-07-16T02:02:00.000Z",
            lease: prepared.lease,
          });
          expect(started).toMatchObject({
            status: "running",
            attempts: 1,
          });
          expect(Object.isFrozen(started)).toBe(true);
          instance.store.createRunOperation({
            operation: prepared.operation,
            lease: prepared.lease,
          });
          expect(
            instance.store.getRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
            })?.status,
          ).toBe("running");
          if (status === "succeeded") {
            expect(
              errorCode(() =>
                instance.store.finishRunOperation({
                  phase: "after_dispatch",
                  runId: prepared.run.id,
                  operationId: prepared.operation.operationId,
                  status: "succeeded",
                  reconciliation: "not_required",
                  externalRequestId: null,
                  after: { starred: false },
                  error: null,
                  finishedAt: "2026-07-16T02:00:30.000Z",
                  lease: prepared.lease,
                }),
              ),
            ).toBe("PRECONDITION_FAILED");
            expect(
              instance.store.getRunOperation({
                runId: prepared.run.id,
                operationId: prepared.operation.operationId,
              })?.status,
            ).toBe("running");
          }
          if (status === "failed") {
            const rawStore = instance.store as unknown as {
              finishRunOperation(input: unknown): unknown;
            };
            expect(
              errorCode(() =>
                rawStore.finishRunOperation({
                  phase: "after_dispach",
                  runId: prepared.run.id,
                  operationId: prepared.operation.operationId,
                  status: "failed",
                  reconciliation: "confirmed_not_applied",
                  externalRequestId: "request-invalid-phase",
                  after: { starred: true },
                  error: RETRYABLE_ERROR,
                  finishedAt: "2026-07-16T02:03:00.000Z",
                  lease: prepared.lease,
                }),
              ),
            ).toBe("VALIDATION_ERROR");
            expect(
              instance.store.getRunOperationAttempt({
                runId: prepared.run.id,
                operationId: prepared.operation.operationId,
                attempt: 1,
              })?.status,
            ).toBe("running");
          }
          const result =
            status === "succeeded"
              ? instance.store.finishRunOperation({
                  phase: "after_dispatch",
                  runId: prepared.run.id,
                  operationId: prepared.operation.operationId,
                  status: "succeeded",
                  reconciliation: "not_required",
                  externalRequestId: "request-1",
                  after: { starred: false },
                  error: null,
                  finishedAt: "2026-07-16T02:03:00.000Z",
                  lease: prepared.lease,
                })
              : status === "failed"
                ? instance.store.finishRunOperation({
                    phase: "after_dispatch",
                    runId: prepared.run.id,
                    operationId: prepared.operation.operationId,
                    status: "failed",
                    reconciliation: "confirmed_not_applied",
                    externalRequestId: "request-1",
                    after: { starred: true },
                    error: RETRYABLE_ERROR,
                    finishedAt: "2026-07-16T02:03:00.000Z",
                    lease: prepared.lease,
                  })
                : instance.store.finishRunOperation({
                    phase: "after_dispatch",
                    runId: prepared.run.id,
                    operationId: prepared.operation.operationId,
                    status: "unresolved",
                    reconciliation: "unknown",
                    externalRequestId: null,
                    after: null,
                    error: UNKNOWN_ERROR,
                    finishedAt: "2026-07-16T02:03:00.000Z",
                    lease: prepared.lease,
                  });
          expect(result).toMatchObject({ status, attempts: 1 });
          const attempt = instance.store.getRunOperationAttempt({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            attempt: 1,
          });
          expect(attempt).toMatchObject({ status, attempt: 1 });
          expect(Object.isFrozen(attempt)).toBe(true);
          const unrelatedLease = acquireApplyLease(instance.store, {
            name: `apply:unrelated:terminal:${status}`,
            ownerId: `unrelated-owner:terminal:${status}`,
            acquiredAt: "2026-07-16T02:04:00.000Z",
            expiresAt: "2026-07-16T02:20:00.000Z",
          });
          expect(
            errorCode(() =>
              instance.store.createRunOperation({
                operation: prepared.operation,
                lease: unrelatedLease,
              }),
            ),
          ).toBe("PRECONDITION_FAILED");
          expect(
            instance.store.getRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
            }),
          ).toEqual(result);
          instance.store.createRunOperation({
            operation: prepared.operation,
            lease: prepared.lease,
          });
          expect(
            instance.store.getRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
            }),
          ).toMatchObject({ status, attempts: 1 });
          expect(
            errorCode(() =>
              status === "succeeded"
                ? instance.store.finishRunOperation({
                    phase: "after_dispatch",
                    runId: prepared.run.id,
                    operationId: prepared.operation.operationId,
                    status: "succeeded",
                    reconciliation: "not_required",
                    externalRequestId: "request-2",
                    after: { starred: false },
                    error: null,
                    finishedAt: "2026-07-16T02:04:00.000Z",
                    lease: prepared.lease,
                  })
                : instance.store.startRunOperation({
                    runId: prepared.run.id,
                    operationId: prepared.operation.operationId,
                    startedAt: "2026-07-16T02:04:00.000Z",
                    lease: prepared.lease,
                  }),
            ),
          ).toBe("PRECONDITION_FAILED");
        } finally {
          instance.cleanup();
        }
      }
    });

    test("requires the exact active run lease for every operation mutation", () => {
      const instance = factory();
      const { store } = instance;
      try {
        const prepared = prepareRunningRun(store, "operation_lease");
        const unrelatedLease = acquireApplyLease(store, {
          name: "apply:operation-unrelated",
          ownerId: "operation-unrelated-owner",
          acquiredAt: "2026-07-16T02:02:00.000Z",
          expiresAt: "2026-07-16T04:00:00.000Z",
        });
        expect(
          errorCode(() =>
            store.startRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              startedAt: "2026-07-16T02:02:00.000Z",
              lease: unrelatedLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.getRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
          }),
        ).toMatchObject({ status: "pending", attempts: 0 });
        store.startRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          startedAt: "2026-07-16T02:02:00.000Z",
          lease: prepared.lease,
        });
        expect(
          errorCode(() =>
            store.finishRunOperation({
              phase: "after_dispatch",
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              status: "failed",
              reconciliation: "confirmed_not_applied",
              externalRequestId: "wrong-lease-request",
              after: { starred: true },
              error: RETRYABLE_ERROR,
              finishedAt: "2026-07-16T02:03:00.000Z",
              lease: unrelatedLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.getRunOperationAttempt({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            attempt: 1,
          }),
        ).toMatchObject({ status: "running", finishedAt: null });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          externalRequestId: "request-1",
          after: { starred: true },
          error: RETRYABLE_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease: prepared.lease,
        });
        expect(
          errorCode(() =>
            store.retryRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              maxAttempts: 3,
              lease: unrelatedLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.getRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
          })?.status,
        ).toBe("failed");
        store.retryRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          maxAttempts: 3,
          lease: prepared.lease,
        });
        store.startRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          startedAt: "2026-07-16T02:04:00.000Z",
          lease: prepared.lease,
        });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "unresolved",
          reconciliation: "unknown",
          externalRequestId: null,
          after: null,
          error: UNKNOWN_ERROR,
          finishedAt: "2026-07-16T02:05:00.000Z",
          lease: prepared.lease,
        });
        expect(
          errorCode(() =>
            store.reconcileRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              status: "failed",
              reconciliation: "confirmed_not_applied",
              after: { starred: true },
              error: RETRYABLE_ERROR,
              observedAt: "2026-07-16T02:06:00.000Z",
              lease: unrelatedLease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.listRunOperationReconciliationsPage({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            afterEventSequence: null,
            pageSize: 10,
          }).total,
        ).toBe(0);
        expect(
          store.reconcileRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            status: "failed",
            reconciliation: "confirmed_not_applied",
            after: { starred: true },
            error: RETRYABLE_ERROR,
            observedAt: "2026-07-16T02:06:00.000Z",
            lease: prepared.lease,
          }).status,
        ).toBe("failed");
      } finally {
        instance.cleanup();
      }
    });

    test("rejects retry for a confirmed-not-applied nonretryable failure without mutation", () => {
      const instance = factory();
      const { store } = instance;
      try {
        const prepared = prepareRunningRun(store, "nonretryable_failure");
        store.startRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          startedAt: "2026-07-16T02:02:00.000Z",
          lease: prepared.lease,
        });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          externalRequestId: "request-nonretryable",
          after: { starred: true },
          error: NON_RETRYABLE_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease: prepared.lease,
        });
        const projection = store.getRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
        });
        const attempt = store.getRunOperationAttempt({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          attempt: 1,
        });
        const attempts = store.listRunOperationAttemptsPage({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          afterAttempt: null,
          pageSize: 10,
        });
        const events = store.listRunOperationReconciliationsPage({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          afterEventSequence: null,
          pageSize: 10,
        });
        expect(projection).toMatchObject({
          status: "failed",
          reconciliation: "confirmed_not_applied",
          attempts: 1,
          error: NON_RETRYABLE_ERROR,
        });
        expect(
          errorCode(() =>
            store.retryRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              maxAttempts: 3,
              lease: prepared.lease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.getRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
          }),
        ).toEqual(projection);
        expect(
          store.getRunOperationAttempt({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            attempt: 1,
          }),
        ).toEqual(attempt);
        expect(
          store.listRunOperationAttemptsPage({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            afterAttempt: null,
            pageSize: 10,
          }),
        ).toEqual(attempts);
        expect(
          store.listRunOperationReconciliationsPage({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            afterEventSequence: null,
            pageSize: 10,
          }),
        ).toEqual(events);
        expect(events.total).toBe(0);
      } finally {
        instance.cleanup();
      }
    });

    test("reconciles confirmed-applied outcomes without rewriting attempt history", () => {
      const instance = factory();
      const { store } = instance;
      try {
        const prepared = prepareRunningRun(store, "confirmed_applied");
        store.startRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          startedAt: "2026-07-16T02:02:00.000Z",
          lease: prepared.lease,
        });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "unresolved",
          reconciliation: "unknown",
          externalRequestId: "request-confirmed",
          after: null,
          error: UNKNOWN_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease: prepared.lease,
        });
        const originalAttempt = store.getRunOperationAttempt({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          attempt: 1,
        });
        expect(originalAttempt).toMatchObject({
          status: "unresolved",
          reconciliation: "unknown",
          externalRequestId: "request-confirmed",
          error: UNKNOWN_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
        });

        const reconciled = store.reconcileRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "succeeded",
          reconciliation: "confirmed_applied",
          after: { starred: false, marker: "[REDACTED]" },
          error: null,
          observedAt: "2026-07-16T02:04:00.000Z",
          lease: prepared.lease,
        });
        expect(reconciled).toMatchObject({
          status: "succeeded",
          reconciliation: "confirmed_applied",
          attempts: 1,
          startedAt: "2026-07-16T02:02:00.000Z",
          externalRequestId: "request-confirmed",
          after: { starred: false, marker: "[REDACTED]" },
          error: null,
          finishedAt: "2026-07-16T02:04:00.000Z",
        });
        expect(Object.isFrozen(reconciled)).toBe(true);
        const preservedAttempt = store.getRunOperationAttempt({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          attempt: 1,
        });
        expect(preservedAttempt).toEqual(originalAttempt);
        expect(preservedAttempt).toMatchObject({
          status: "unresolved",
          reconciliation: "unknown",
          error: UNKNOWN_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
        });
        const events = store.listRunOperationReconciliationsPage({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          afterEventSequence: null,
          pageSize: 10,
        });
        expect(events).toMatchObject({
          total: 1,
          nextEventSequence: null,
          items: [
            {
              attempt: 1,
              eventSequence: 1,
              status: "succeeded",
              reconciliation: "confirmed_applied",
              after: { starred: false, marker: "[REDACTED]" },
              error: null,
              observedAt: "2026-07-16T02:04:00.000Z",
            },
          ],
        });
        expect(Object.isFrozen(events.items[0])).toBe(true);

        const immutableCalls: readonly (() => unknown)[] = [
          () =>
            store.startRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              startedAt: "2026-07-16T02:05:00.000Z",
              lease: prepared.lease,
            }),
          () =>
            store.retryRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              maxAttempts: 3,
              lease: prepared.lease,
            }),
          () =>
            store.reconcileRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              status: "succeeded",
              reconciliation: "confirmed_applied",
              after: { starred: false },
              error: null,
              observedAt: "2026-07-16T02:05:00.000Z",
              lease: prepared.lease,
            }),
          () =>
            store.finishRunOperation({
              phase: "before_dispatch",
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              status: "skipped",
              reconciliation: "not_required",
              error: null,
              finishedAt: "2026-07-16T02:05:00.000Z",
              lease: prepared.lease,
            }),
        ];
        for (const call of immutableCalls) {
          expect(errorCode(call)).toBe("PRECONDITION_FAILED");
        }
        store.createRunOperation({
          operation: prepared.operation,
          lease: prepared.lease,
        });
        expect(
          store.getRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
          }),
        ).toEqual(reconciled);
      } finally {
        instance.cleanup();
      }
    });

    test("preserves retry history and append-only reconciliation events", () => {
      const instance = factory();
      const { store } = instance;
      try {
        const prepared = prepareRunningRun(store, "retry_reconcile");
        store.startRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          startedAt: "2026-07-16T02:02:00.000Z",
          lease: prepared.lease,
        });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          externalRequestId: "request-1",
          after: { starred: true },
          error: RETRYABLE_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease: prepared.lease,
        });
        expect(
          errorCode(() =>
            store.retryRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              maxAttempts: 1,
              lease: prepared.lease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.retryRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            maxAttempts: 2,
            lease: prepared.lease,
          }),
        ).toMatchObject({ status: "pending", attempts: 1 });
        store.startRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          startedAt: "2026-07-16T02:04:00.000Z",
          lease: prepared.lease,
        });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "unresolved",
          reconciliation: "unknown",
          externalRequestId: null,
          after: null,
          error: UNKNOWN_ERROR,
          finishedAt: "2026-07-16T02:05:00.000Z",
          lease: prepared.lease,
        });
        expect(
          errorCode(() =>
            store.retryRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              maxAttempts: 3,
              lease: prepared.lease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        for (const observedAt of [
          "2026-07-16T02:06:00.000Z",
          "2026-07-16T02:07:00.000Z",
        ]) {
          store.reconcileRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            status: "unresolved",
            reconciliation: "unknown",
            after: null,
            error: UNKNOWN_ERROR,
            observedAt,
            lease: prepared.lease,
          });
        }
        const failed = store.reconcileRunOperation({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          after: { starred: true, marker: "[REDACTED]" },
          error: RETRYABLE_ERROR,
          observedAt: "2026-07-16T02:08:00.000Z",
          lease: prepared.lease,
        });
        expect(failed.after).toEqual({
          starred: true,
          marker: "[REDACTED]",
        });
        expect(
          errorCode(() =>
            store.retryRunOperation({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              maxAttempts: 2,
              lease: prepared.lease,
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          store.retryRunOperation({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            maxAttempts: 3,
            lease: prepared.lease,
          }),
        ).toMatchObject({ status: "pending", attempts: 2 });

        const attempts = store.listRunOperationAttemptsPage({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          afterAttempt: null,
          pageSize: 1,
        });
        expect(attempts).toMatchObject({
          total: 2,
          nextAttempt: 1,
        });
        expect(Object.isFrozen(attempts)).toBe(true);
        expect(Object.isFrozen(attempts.items)).toBe(true);
        expect(Object.isFrozen(attempts.items[0])).toBe(true);
        const finalAttempts = store.listRunOperationAttemptsPage({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          afterAttempt: attempts.nextAttempt,
          pageSize: 10,
        });
        expect(finalAttempts).toMatchObject({
          total: 2,
          nextAttempt: null,
          items: [{ attempt: 2 }],
        });
        expect(Object.isFrozen(finalAttempts)).toBe(true);
        expect(Object.isFrozen(finalAttempts.items)).toBe(true);
        expect(Object.isFrozen(finalAttempts.items[0])).toBe(true);
        const events = store.listRunOperationReconciliationsPage({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          afterEventSequence: null,
          pageSize: 2,
        });
        expect(events.total).toBe(3);
        expect(events.nextEventSequence).toBe(2);
        expect(events.items.map(({ eventSequence }) => eventSequence)).toEqual([
          1, 2,
        ]);
        expect(Object.isFrozen(events)).toBe(true);
        expect(Object.isFrozen(events.items)).toBe(true);
        expect(Object.isFrozen(events.items[0])).toBe(true);
        const finalEvents = store.listRunOperationReconciliationsPage({
          runId: prepared.run.id,
          operationId: prepared.operation.operationId,
          afterEventSequence: events.nextEventSequence,
          pageSize: 2,
        });
        expect(finalEvents).toMatchObject({
          total: 3,
          nextEventSequence: null,
          items: [{ eventSequence: 3 }],
        });
        expect(Object.isFrozen(finalEvents)).toBe(true);
        expect(Object.isFrozen(finalEvents.items)).toBe(true);
        expect(Object.isFrozen(finalEvents.items[0])).toBe(true);
        for (const pageSize of [0, 101]) {
          expect(
            errorCode(() =>
              store.listRunOperationAttemptsPage({
                runId: prepared.run.id,
                operationId: prepared.operation.operationId,
                afterAttempt: null,
                pageSize,
              }),
            ),
          ).toBe("VALIDATION_ERROR");
          expect(
            errorCode(() =>
              store.listRunOperationReconciliationsPage({
                runId: prepared.run.id,
                operationId: prepared.operation.operationId,
                afterEventSequence: null,
                pageSize,
              }),
            ),
          ).toBe("VALIDATION_ERROR");
        }
        expect(
          errorCode(() =>
            store.listRunOperationAttemptsPage({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              afterAttempt: 3,
              pageSize: 1,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            store.listRunOperationReconciliationsPage({
              runId: prepared.run.id,
              operationId: prepared.operation.operationId,
              afterEventSequence: 4,
              pageSize: 1,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          store.getRunOperationAttempt({
            runId: prepared.run.id,
            operationId: prepared.operation.operationId,
            attempt: 2,
          })?.finishedAt,
        ).toBe("2026-07-16T02:05:00.000Z");
      } finally {
        instance.cleanup();
      }
    });

    test("paginates operation, attempt, and event audit records with strict bounds", () => {
      const instance = factory();
      const { store } = instance;
      try {
        seedCompleteSnapshot(store);
        const lease = acquireApplyLease(store);
        const plan = multiOperationPlan("plan_audit_pages", 3);
        const run = runFixture("run_audit_pages", plan.id);
        store.savePlan(plan);
        store.compareAndSetPlanState({
          planId: plan.id,
          expected: ["ready"],
          next: "applying",
        });
        store.createRun({ run, lease });
        store.compareAndSetRunState({
          runId: run.id,
          expected: ["pending"],
          next: "running",
          finishedAt: null,
          lease,
        });
        for (let sequence = 0; sequence < 3; sequence += 1) {
          store.createRunOperation({
            operation: operationFixture(run.id, {
              operationId: `op_${String(sequence)}`,
              sequence,
            }),
            lease,
          });
        }

        const first = store.listRunOperationsPage({
          runId: run.id,
          afterSequence: null,
          pageSize: 2,
        });
        expect(first.total).toBe(3);
        expect(first.nextSequence).toBe(1);
        expect(first.items.map(({ sequence }) => sequence)).toEqual([0, 1]);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.items)).toBe(true);
        const final = store.listRunOperationsPage({
          runId: run.id,
          afterSequence: first.nextSequence,
          pageSize: 2,
        });
        expect(final).toMatchObject({
          total: 3,
          nextSequence: null,
          items: [{ sequence: 2 }],
        });
        expect(Object.isFrozen(final)).toBe(true);
        expect(Object.isFrozen(final.items)).toBe(true);
        expect(Object.isFrozen(final.items[0])).toBe(true);
        expect(store.listRunOperations(run.id)).toHaveLength(3);
        expect(
          errorCode(() =>
            store.listRunOperationsPage({
              runId: run.id,
              afterSequence: null,
              pageSize: 0,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            store.listRunOperationsPage({
              runId: run.id,
              afterSequence: null,
              pageSize: 101,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            store.listRunOperationsPage({
              runId: run.id,
              afterSequence: 3,
              pageSize: 1,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            store.listRunOperationAttemptsPage({
              runId: run.id,
              operationId: "op_0",
              afterAttempt: null,
              pageSize: 0,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            store.listRunOperationReconciliationsPage({
              runId: run.id,
              operationId: "op_0",
              afterEventSequence: null,
              pageSize: 101,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
      } finally {
        instance.cleanup();
      }
    });

    test("reports bounded incomplete summaries with all six status counts and UTF-16 order", () => {
      const instance = factory();
      const { store } = instance;
      try {
        seedCompleteSnapshot(store);
        const lease = acquireApplyLease(store);
        const plan = multiOperationPlan("plan_summary_counts", 6);
        const run = runFixture("run_summary_counts", plan.id);
        store.savePlan(plan);
        store.compareAndSetPlanState({
          planId: plan.id,
          expected: ["ready"],
          next: "applying",
        });
        store.createRun({ run, lease });
        store.compareAndSetRunState({
          runId: run.id,
          expected: ["pending"],
          next: "running",
          finishedAt: null,
          lease,
        });
        for (let sequence = 0; sequence < 6; sequence += 1) {
          store.createRunOperation({
            operation: operationFixture(run.id, {
              operationId: `op_${String(sequence)}`,
              sequence,
            }),
            lease,
          });
        }
        store.startRunOperation({
          runId: run.id,
          operationId: "op_1",
          startedAt: "2026-07-16T02:02:00.000Z",
          lease,
        });
        store.startRunOperation({
          runId: run.id,
          operationId: "op_2",
          startedAt: "2026-07-16T02:02:00.000Z",
          lease,
        });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: run.id,
          operationId: "op_2",
          status: "succeeded",
          reconciliation: "not_required",
          externalRequestId: null,
          after: { starred: false },
          error: null,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease,
        });
        store.finishRunOperation({
          phase: "before_dispatch",
          runId: run.id,
          operationId: "op_3",
          status: "skipped",
          reconciliation: "not_required",
          error: null,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease,
        });
        store.finishRunOperation({
          phase: "before_dispatch",
          runId: run.id,
          operationId: "op_4",
          status: "failed",
          reconciliation: "confirmed_not_applied",
          error: RETRYABLE_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease,
        });
        store.startRunOperation({
          runId: run.id,
          operationId: "op_5",
          startedAt: "2026-07-16T02:02:00.000Z",
          lease,
        });
        store.finishRunOperation({
          phase: "after_dispatch",
          runId: run.id,
          operationId: "op_5",
          status: "unresolved",
          reconciliation: "unknown",
          externalRequestId: null,
          after: null,
          error: UNKNOWN_ERROR,
          finishedAt: "2026-07-16T02:03:00.000Z",
          lease,
        });
        const counts = store.getIncompleteRunSummaries({
          binding: accountBindingFixture,
          limit: 10,
        });
        expect(counts.items[0]?.counts).toEqual({
          pending: 1,
          running: 1,
          succeeded: 1,
          skipped: 1,
          failed: 1,
          unresolved: 1,
        });
        expect(Object.isFrozen(counts)).toBe(true);
        expect(Object.isFrozen(counts.items)).toBe(true);
        expect(Object.isFrozen(counts.items[0])).toBe(true);
        expect(Object.isFrozen(counts.items[0]?.counts)).toBe(true);

        for (let index = 0; index < 2; index += 1) {
          const unicodePlan = planFixture(
            `plan_summary_unicode_${String(index)}`,
          );
          const unicodeRun = runFixture(
            index === 0 ? "run_𐀀" : "run_\uE000",
            unicodePlan.id,
            "2026-07-16T03:00:00.000Z",
          );
          store.savePlan(unicodePlan);
          store.compareAndSetPlanState({
            planId: unicodePlan.id,
            expected: ["ready"],
            next: "applying",
          });
          store.createRun({ run: unicodeRun, lease });
        }
        store.compareAndSetRunState({
          runId: asRunId("run_𐀀"),
          expected: ["pending"],
          next: "running",
          finishedAt: null,
          lease,
        });
        store.compareAndSetRunState({
          runId: asRunId("run_𐀀"),
          expected: ["running"],
          next: "partial",
          finishedAt: "2026-07-16T03:01:00.000Z",
          lease,
        });

        const terminalPlan = planFixture("plan_summary_terminal");
        const terminalRun = runFixture(
          "run_summary_terminal",
          terminalPlan.id,
          "2026-07-16T04:00:00.000Z",
        );
        store.savePlan(terminalPlan);
        store.compareAndSetPlanState({
          planId: terminalPlan.id,
          expected: ["ready"],
          next: "applying",
        });
        store.createRun({ run: terminalRun, lease });
        store.compareAndSetRunState({
          runId: terminalRun.id,
          expected: ["pending"],
          next: "running",
          finishedAt: null,
          lease,
        });
        store.compareAndSetRunState({
          runId: terminalRun.id,
          expected: ["running"],
          next: "completed",
          finishedAt: "2026-07-16T04:01:00.000Z",
          lease,
        });

        const otherBinding = Object.freeze({
          host: "github.com",
          login: "other-user",
          accountId: "U_other",
        });
        const otherSnapshotId = asSnapshotId("snap_summary_other");
        seedCompleteSnapshot(store, {
          id: otherSnapshotId,
          binding: otherBinding,
        });
        const otherExecutable: PlanExecutableContent = {
          ...changePlanFixture.executable,
          binding: otherBinding,
          snapshotId: otherSnapshotId,
        };
        const otherPlan = parseChangePlan({
          ...changePlanFixture,
          id: asPlanId("plan_summary_other"),
          hash: hashPlanExecutable(otherExecutable),
          executable: otherExecutable,
          operations: otherExecutable.operations,
          dependencies: otherExecutable.dependencies,
        });
        const otherRun = parseChangeRun({
          ...runFixture("run_summary_other", otherPlan.id),
          binding: otherBinding,
        });
        store.savePlan(otherPlan);
        store.compareAndSetPlanState({
          planId: otherPlan.id,
          expected: ["ready"],
          next: "applying",
        });
        store.createRun({ run: otherRun, lease });

        const bounded = store.getIncompleteRunSummaries({
          binding: accountBindingFixture,
          limit: 2,
        });
        expect(bounded).toMatchObject({
          total: 3,
          truncated: true,
        });
        expect(bounded.items.map(({ runId }) => runId)).toEqual([
          run.id,
          asRunId("run_𐀀"),
        ]);
        expect(Object.isFrozen(bounded)).toBe(true);
        expect(Object.isFrozen(bounded.items)).toBe(true);
        expect(Object.isFrozen(bounded.items[0])).toBe(true);
        expect(Object.isFrozen(bounded.items[0]?.counts)).toBe(true);
        const all = store.getIncompleteRunSummaries({
          binding: accountBindingFixture,
          limit: 10,
        });
        expect(all).toMatchObject({
          total: 3,
          truncated: false,
        });
        expect(all.items.map(({ runId }) => runId)).toEqual([
          run.id,
          asRunId("run_𐀀"),
          asRunId("run_\uE000"),
        ]);
        expect(all.items.map(({ state }) => state)).toEqual([
          "running",
          "partial",
          "pending",
        ]);
        expect(all.items.some(({ runId }) => runId === terminalRun.id)).toBe(
          false,
        );
        expect(all.items.some(({ runId }) => runId === otherRun.id)).toBe(
          false,
        );
        expect(
          errorCode(() =>
            store.getIncompleteRunSummaries({
              binding: accountBindingFixture,
              limit: 0,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
        expect(
          errorCode(() =>
            store.getIncompleteRunSummaries({
              binding: accountBindingFixture,
              limit: 101,
            }),
          ),
        ).toBe("VALIDATION_ERROR");
      } finally {
        instance.cleanup();
      }
    });

    test("performs exact-name snapshot recovery and global all-or-nothing snapshot/run recovery", () => {
      const targeted = factory();
      try {
        targeted.store.acquireLease({
          name: "sync:targeted",
          ownerId: "old-owner",
          now: "2026-07-16T00:00:00.000Z",
          expiresAt: "2026-07-16T00:05:00.000Z",
        });
        const draft = parseSnapshotDraft({
          ...snapshotDraftFixture,
          id: asSnapshotId("snap_targeted_contract"),
        });
        targeted.store.createSnapshot({
          draft,
          lease: {
            name: "sync:targeted",
            ownerId: "old-owner",
            now: "2026-07-16T00:01:00.000Z",
          },
        });
        expect(
          targeted.store.recoverIncompleteSnapshots("2026-07-16T00:03:00.000Z"),
        ).toEqual([]);
        targeted.store.acquireLease({
          name: "sync:unrelated",
          ownerId: "new-owner",
          now: "2026-07-16T00:06:00.000Z",
          expiresAt: "2026-07-16T00:10:00.000Z",
        });
        expect(
          targeted.store.recoverAbandonedSnapshots({
            binding: accountBindingFixture,
            lease: {
              name: "sync:unrelated",
              ownerId: "new-owner",
              now: "2026-07-16T00:06:30.000Z",
            },
          }),
        ).toEqual([]);
        targeted.store.acquireLease({
          name: "sync:targeted",
          ownerId: "new-owner",
          now: "2026-07-16T00:06:00.000Z",
          expiresAt: "2026-07-16T00:10:00.000Z",
        });
        expect(
          targeted.store.recoverAbandonedSnapshots({
            binding: {
              ...accountBindingFixture,
              accountId: "U_other",
            },
            lease: {
              name: "sync:targeted",
              ownerId: "new-owner",
              now: "2026-07-16T00:06:30.000Z",
            },
          }),
        ).toEqual([]);
        const recovered = targeted.store.recoverAbandonedSnapshots({
          binding: accountBindingFixture,
          lease: {
            name: "sync:targeted",
            ownerId: "new-owner",
            now: "2026-07-16T00:06:30.000Z",
          },
        });
        expect(recovered).toEqual([draft.id]);
        expect(Object.isFrozen(recovered)).toBe(true);
        expect(
          targeted.store.recoverIncompleteSnapshots("2026-07-16T00:07:00.000Z"),
        ).toEqual([]);
      } finally {
        targeted.cleanup();
      }

      const atomic = factory();
      try {
        atomic.store.acquireLease({
          name: "sync:atomic",
          ownerId: "old-owner",
          now: "2026-07-16T00:00:00.000Z",
          expiresAt: "2026-07-16T00:10:00.000Z",
        });
        const guard = {
          name: "sync:atomic",
          ownerId: "old-owner",
          now: "2026-07-16T00:01:00.000Z",
        } as const;
        const early = parseSnapshotDraft({
          ...snapshotDraftFixture,
          id: asSnapshotId("snap_atomic_early"),
          startedAt: "2026-07-16T00:00:00.000Z",
        });
        const future = parseSnapshotDraft({
          ...snapshotDraftFixture,
          id: asSnapshotId("snap_atomic_future"),
          startedAt: "2026-07-16T00:20:00.000Z",
        });
        atomic.store.createSnapshot({ draft: early, lease: guard });
        atomic.store.createSnapshot({ draft: future, lease: guard });
        expect(
          errorCode(() =>
            atomic.store.recoverIncompleteSnapshots("2026-07-16T00:15:00.000Z"),
          ),
        ).toBe("PRECONDITION_FAILED");
        const recovered = atomic.store.recoverIncompleteSnapshots(
          "2026-07-16T00:21:00.000Z",
        );
        expect(recovered).toEqual([early.id, future.id]);
        expect(Object.isFrozen(recovered)).toBe(true);
      } finally {
        atomic.cleanup();
      }

      const globalAtomic = factory();
      try {
        globalAtomic.store.acquireLease({
          name: "apply:global-atomic",
          ownerId: "old-owner",
          now: "2026-07-16T02:00:00.000Z",
          expiresAt: "2026-07-16T02:05:00.000Z",
        });
        const guard = {
          name: "apply:global-atomic",
          ownerId: "old-owner",
          now: "2026-07-16T02:01:00.000Z",
        } as const;
        const early = prepareRunningRun(
          globalAtomic.store,
          "global_atomic_early",
          {
            lease: guard,
            startedAt: "2026-07-16T02:00:00.000Z",
          },
        );
        const future = prepareRunningRun(
          globalAtomic.store,
          "global_atomic_future",
          {
            lease: guard,
            startedAt: "2026-07-16T03:00:00.000Z",
          },
        );
        expect(
          errorCode(() =>
            globalAtomic.store.recoverInterruptedRuns(
              "2026-07-16T02:30:00.000Z",
            ),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(globalAtomic.store.getRun(early.run.id)?.state).toBe("running");
        expect(globalAtomic.store.getPlan(early.plan.id)?.state).toBe(
          "applying",
        );
        expect(
          globalAtomic.store.getRunOperation({
            runId: early.run.id,
            operationId: early.operation.operationId,
          })?.status,
        ).toBe("pending");
        expect(globalAtomic.store.getRun(future.run.id)?.state).toBe("running");
        expect(
          globalAtomic.store.getRunOperation({
            runId: future.run.id,
            operationId: future.operation.operationId,
          })?.status,
        ).toBe("pending");

        const recovered = globalAtomic.store.recoverInterruptedRuns(
          "2026-07-16T03:01:00.000Z",
        );
        expect(recovered).toEqual([early.run.id, future.run.id]);
        expect(Object.isFrozen(recovered)).toBe(true);
        expect(
          globalAtomic.store.getRunOperation({
            runId: early.run.id,
            operationId: early.operation.operationId,
          })?.status,
        ).toBe("failed");
        expect(
          globalAtomic.store.getRunOperation({
            runId: future.run.id,
            operationId: future.operation.operationId,
          })?.status,
        ).toBe("failed");
        expect(
          globalAtomic.store.recoverInterruptedRuns("2026-07-16T03:02:00.000Z"),
        ).toEqual([]);
      } finally {
        globalAtomic.cleanup();
      }
    });

    test("recovers pending, running, and zero-operation runs once at lease expiry", () => {
      const instance = factory();
      const { store } = instance;
      try {
        store.acquireLease({
          name: "apply:recovery",
          ownerId: "old-owner",
          now: "2026-07-16T02:00:00.000Z",
          expiresAt: "2026-07-16T02:05:00.000Z",
        });
        const oldGuard = {
          name: "apply:recovery",
          ownerId: "old-owner",
          now: "2026-07-16T02:01:00.000Z",
        } as const;
        const pending = prepareRunningRun(store, "recovery_pending", {
          lease: oldGuard,
          runId: asRunId("run_𐀀"),
        });
        const running = prepareRunningRun(store, "recovery_running", {
          lease: oldGuard,
          runId: asRunId("run_\uE000"),
        });
        const runningStarted = store.startRunOperation({
          runId: running.run.id,
          operationId: running.operation.operationId,
          startedAt: "2026-07-16T02:02:00.000Z",
          lease: oldGuard,
        });
        const runningAttempt = store.getRunOperationAttempt({
          runId: running.run.id,
          operationId: running.operation.operationId,
          attempt: 1,
        });
        if (runningAttempt === null) {
          throw new Error("running recovery attempt was not created");
        }
        const zero = prepareRunningRun(store, "recovery_zero", {
          lease: oldGuard,
          createOperation: false,
          runId: asRunId("run_\uF000"),
        });
        store.acquireLease({
          name: "apply:other-name",
          ownerId: "old-owner",
          now: "2026-07-16T02:04:00.000Z",
          expiresAt: "2026-07-16T03:00:00.000Z",
        });
        expect(
          store.recoverInterruptedRuns("2026-07-16T02:03:00.000Z"),
        ).toEqual([]);
        const recovered = store.recoverInterruptedRuns(
          "2026-07-16T02:05:00.000Z",
        );
        expect(recovered).toEqual([
          pending.run.id,
          running.run.id,
          zero.run.id,
        ]);
        expect(Object.isFrozen(recovered)).toBe(true);
        const recoveredPending = store.getRunOperation({
          runId: pending.run.id,
          operationId: pending.operation.operationId,
        });
        expect(recoveredPending).toEqual(
          parseRunOperation({
            ...pending.operation,
            status: "failed",
            reconciliation: "confirmed_not_applied",
            error: {
              code: "INTERNAL_ERROR",
              message:
                "Operation was interrupted before dispatch; dispatch did not occur",
              retryable: true,
              details: { recovered: true },
            },
            finishedAt: "2026-07-16T02:05:00.000Z",
          }),
        );
        expect(recoveredPending).toMatchObject({
          status: "failed",
          reconciliation: "confirmed_not_applied",
          attempts: 0,
          startedAt: null,
          externalRequestId: null,
          after: null,
          finishedAt: "2026-07-16T02:05:00.000Z",
          error: {
            code: "INTERNAL_ERROR",
            message:
              "Operation was interrupted before dispatch; dispatch did not occur",
            retryable: true,
            details: { recovered: true },
          },
        });
        expect(Object.isFrozen(recoveredPending)).toBe(true);
        expect(Object.isFrozen(recoveredPending?.error)).toBe(true);
        expect(Object.isFrozen(recoveredPending?.error?.details)).toBe(true);
        expect(
          store.listRunOperationAttemptsPage({
            runId: pending.run.id,
            operationId: pending.operation.operationId,
            afterAttempt: null,
            pageSize: 10,
          }).total,
        ).toBe(0);
        expect(
          store.listRunOperationReconciliationsPage({
            runId: pending.run.id,
            operationId: pending.operation.operationId,
            afterEventSequence: null,
            pageSize: 10,
          }).total,
        ).toBe(0);
        const recoveredRunning = store.getRunOperation({
          runId: running.run.id,
          operationId: running.operation.operationId,
        });
        expect(recoveredRunning).toEqual(
          parseRunOperation({
            ...runningStarted,
            status: "unresolved",
            reconciliation: "unknown",
            error: {
              code: "RECONCILIATION_REQUIRED",
              message: "Dispatch outcome is unknown after interruption",
              retryable: false,
              details: { recovered: true },
            },
            finishedAt: "2026-07-16T02:05:00.000Z",
          }),
        );
        expect(recoveredRunning).toMatchObject({
          status: "unresolved",
          reconciliation: "unknown",
          attempts: 1,
          startedAt: "2026-07-16T02:02:00.000Z",
          externalRequestId: null,
          after: null,
          finishedAt: "2026-07-16T02:05:00.000Z",
          error: {
            code: "RECONCILIATION_REQUIRED",
            message: "Dispatch outcome is unknown after interruption",
            retryable: false,
            details: { recovered: true },
          },
        });
        expect(Object.isFrozen(recoveredRunning)).toBe(true);
        const recoveredAttempt = store.getRunOperationAttempt({
          runId: running.run.id,
          operationId: running.operation.operationId,
          attempt: 1,
        });
        expect(runningAttempt).not.toBeNull();
        expect(recoveredAttempt).toEqual(
          parseRunOperationAttempt({
            ...runningAttempt,
            status: "unresolved",
            reconciliation: "unknown",
            error: {
              code: "RECONCILIATION_REQUIRED",
              message: "Dispatch outcome is unknown after interruption",
              retryable: false,
              details: { recovered: true },
            },
            finishedAt: "2026-07-16T02:05:00.000Z",
          }),
        );
        expect(Object.isFrozen(recoveredAttempt)).toBe(true);
        expect(Object.isFrozen(recoveredAttempt?.error)).toBe(true);
        expect(
          store.listRunOperationReconciliationsPage({
            runId: running.run.id,
            operationId: running.operation.operationId,
            afterEventSequence: null,
            pageSize: 10,
          }).total,
        ).toBe(0);
        for (const prepared of [pending, running, zero]) {
          expect(store.getRun(prepared.run.id)?.state).toBe("partial");
          expect(store.getPlan(prepared.plan.id)?.state).toBe("partial");
        }
        expect(
          store.recoverInterruptedRuns("2026-07-16T02:06:00.000Z"),
        ).toEqual([]);
      } finally {
        instance.cleanup();
      }
    });

    test("targets abandoned runs by active lease and binding and rolls back the fixed set atomically", () => {
      const targeted = factory();
      try {
        seedCompleteSnapshot(targeted.store);
        targeted.store.acquireLease({
          name: "apply:targeted",
          ownerId: "old-owner",
          now: "2026-07-16T02:00:00.000Z",
          expiresAt: "2026-07-16T02:05:00.000Z",
        });
        targeted.store.acquireLease({
          name: "apply:other-target",
          ownerId: "old-owner",
          now: "2026-07-16T02:00:00.000Z",
          expiresAt: "2026-07-16T02:05:00.000Z",
        });
        const candidate = prepareRunningRun(
          targeted.store,
          "targeted_candidate",
          {
            lease: {
              name: "apply:targeted",
              ownerId: "old-owner",
              now: "2026-07-16T02:01:00.000Z",
            },
            createOperation: false,
          },
        );
        const other = prepareRunningRun(targeted.store, "targeted_other", {
          lease: {
            name: "apply:other-target",
            ownerId: "old-owner",
            now: "2026-07-16T02:01:00.000Z",
          },
          createOperation: false,
        });
        targeted.store.acquireLease({
          name: "apply:targeted",
          ownerId: "new-owner",
          now: "2026-07-16T02:06:00.000Z",
          expiresAt: "2026-07-16T02:10:00.000Z",
        });
        const takeover = {
          name: "apply:targeted",
          ownerId: "new-owner",
          now: "2026-07-16T02:06:30.000Z",
        } as const;
        expect(
          errorCode(() =>
            targeted.store.recoverAbandonedRuns({
              binding: accountBindingFixture,
              lease: { ...takeover, ownerId: "wrong-owner" },
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(
          targeted.store.recoverAbandonedRuns({
            binding: {
              ...accountBindingFixture,
              accountId: "U_other",
            },
            lease: takeover,
          }),
        ).toEqual([]);
        expect(
          targeted.store.recoverAbandonedRuns({
            binding: accountBindingFixture,
            lease: takeover,
          }),
        ).toEqual([candidate.run.id]);
        expect(targeted.store.getRun(other.run.id)?.state).toBe("running");
        expect(
          targeted.store.recoverInterruptedRuns("2026-07-16T02:07:00.000Z"),
        ).toEqual([other.run.id]);
      } finally {
        targeted.cleanup();
      }

      const atomic = factory();
      try {
        atomic.store.acquireLease({
          name: "apply:atomic",
          ownerId: "old-owner",
          now: "2026-07-16T02:00:00.000Z",
          expiresAt: "2026-07-16T02:05:00.000Z",
        });
        const guard = {
          name: "apply:atomic",
          ownerId: "old-owner",
          now: "2026-07-16T02:01:00.000Z",
        } as const;
        const early = prepareRunningRun(atomic.store, "atomic_early", {
          lease: guard,
          startedAt: "2026-07-16T02:00:00.000Z",
          createOperation: false,
        });
        const future = prepareRunningRun(atomic.store, "atomic_future", {
          lease: guard,
          startedAt: "2026-07-16T03:00:00.000Z",
          createOperation: false,
        });
        atomic.store.acquireLease({
          name: "apply:atomic",
          ownerId: "new-owner",
          now: "2026-07-16T02:06:00.000Z",
          expiresAt: "2026-07-16T04:00:00.000Z",
        });
        expect(
          errorCode(() =>
            atomic.store.recoverAbandonedRuns({
              binding: accountBindingFixture,
              lease: {
                name: "apply:atomic",
                ownerId: "new-owner",
                now: "2026-07-16T02:30:00.000Z",
              },
            }),
          ),
        ).toBe("PRECONDITION_FAILED");
        expect(atomic.store.getRun(early.run.id)?.state).toBe("running");
        expect(atomic.store.getPlan(early.plan.id)?.state).toBe("applying");
        expect(atomic.store.getRun(future.run.id)?.state).toBe("running");
        expect(atomic.store.getPlan(future.plan.id)?.state).toBe("applying");
        const recovered = atomic.store.recoverAbandonedRuns({
          binding: accountBindingFixture,
          lease: {
            name: "apply:atomic",
            ownerId: "new-owner",
            now: "2026-07-16T03:01:00.000Z",
          },
        });
        expect(recovered).toEqual([early.run.id, future.run.id]);
        expect(Object.isFrozen(recovered)).toBe(true);
        expect(
          atomic.store.recoverAbandonedRuns({
            binding: accountBindingFixture,
            lease: {
              name: "apply:atomic",
              ownerId: "new-owner",
              now: "2026-07-16T03:02:00.000Z",
            },
          }),
        ).toEqual([]);
      } finally {
        atomic.cleanup();
      }
    });
  });
}
