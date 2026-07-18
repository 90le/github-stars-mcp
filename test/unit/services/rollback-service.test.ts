import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  GitHubLiveReadPort,
  GitHubMutationPort,
  MutationReceipt,
  RepositoryIdentity,
  UserListMutationResult,
} from "../../../src/app/ports/github-port.js";
import { MutationExecutor } from "../../../src/app/services/mutation-executor.js";
import {
  RollbackService,
  type CreateRollbackInput,
} from "../../../src/app/services/rollback-service.js";
import { canonicalJson } from "../../../src/domain/canonical-json.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asPlanId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
  type UserListId,
} from "../../../src/domain/ids.js";
import type {
  ListMembershipQuery,
  ListMembershipQueryPage,
} from "../../../src/domain/filter.js";
import type { JsonValue } from "../../../src/domain/json.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  parsePlanExecutable,
  parseResolvedOperation,
  topologicalOperationIds,
  type ChangePlan,
  type ResolvedOperation,
} from "../../../src/domain/plan.js";
import type { UserList } from "../../../src/domain/repository.js";
import {
  parseChangeRun,
  parseRunOperation,
  type RunOperation,
} from "../../../src/domain/run.js";
import {
  rollbackFixture,
  rollbackSourceOperationIds,
  userListFixture,
} from "../../support/change-service-fixtures.js";

type Fixture = ReturnType<typeof rollbackFixture>;

function service(fixture: Fixture): RollbackService {
  return new RollbackService(fixture.storage, fixture.runtime, fixture.config);
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: AppError["code"],
): Promise<AppError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ code, retryable: false });
  return caught as AppError;
}

function expectNoSave(fixture: Fixture): void {
  expect(fixture.tracking.transactionCalls).toBe(0);
  expect(fixture.tracking.savedPlans).toEqual([]);
}

function operationById(
  operations: readonly ResolvedOperation[],
  operationId: string,
): ResolvedOperation {
  const operation = operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (operation === undefined) {
    throw new Error(`Missing fixture operation ${operationId}`);
  }
  return operation;
}

function metadata(value: unknown): {
  readonly name: string;
  readonly description: string | null;
  readonly isPrivate: boolean;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected metadata state");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    (record.description !== null && typeof record.description !== "string") ||
    typeof record.isPrivate !== "boolean"
  ) {
    throw new Error("Expected complete metadata state");
  }
  return {
    name: record.name,
    description: record.description,
    isPrivate: record.isPrivate,
  };
}

function replaceOperation(
  plan: ChangePlan,
  operationId: string,
  replace: (operation: ResolvedOperation) => ResolvedOperation,
): ChangePlan {
  const operations = plan.operations.map((operation) =>
    operation.operationId === operationId ? replace(operation) : operation,
  );
  const executable = parsePlanExecutable({
    ...plan.executable,
    operations,
  });
  return parseChangePlan({
    ...plan,
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function renameOperationIds(
  plan: ChangePlan,
  replacements: ReadonlyMap<string, string>,
): ChangePlan {
  const renamed = (operationId: string): string =>
    replacements.get(operationId) ?? operationId;
  const operations = plan.operations.map((operation) => {
    const common = {
      ...operation,
      operationId: renamed(operation.operationId),
      dependsOn: operation.dependsOn.map(renamed).sort(),
    };
    if (operation.kind !== "list_membership_set") return common;
    const after =
      operation.after !== null &&
      typeof operation.after === "object" &&
      !Array.isArray(operation.after)
        ? (operation.after as Readonly<Record<string, JsonValue>>)
        : null;
    return {
      ...common,
      targetLists: operation.targetLists.map((target) =>
        target.kind === "created"
          ? {
              kind: "created" as const,
              createOperationId: renamed(target.createOperationId),
            }
          : target,
      ),
      after: {
        listIds:
          after !== null && Array.isArray(after.listIds)
            ? after.listIds.map((value: JsonValue) =>
                value !== null &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                typeof (value as Readonly<Record<string, JsonValue>>)
                  .createOperationId === "string"
                  ? {
                      createOperationId: renamed(
                        (value as Readonly<Record<string, JsonValue>>)
                          .createOperationId as string,
                      ),
                    }
                  : value,
              )
            : [],
      },
    };
  });
  const dependencies = plan.dependencies
    .map((dependency) => ({
      operationId: renamed(dependency.operationId),
      dependsOnOperationId: renamed(dependency.dependsOnOperationId),
    }))
    .sort((left, right) => {
      const dependent = left.operationId.localeCompare(right.operationId);
      return dependent === 0
        ? left.dependsOnOperationId.localeCompare(right.dependsOnOperationId)
        : dependent;
    });
  const executable = parsePlanExecutable({
    ...plan.executable,
    operations,
    dependencies,
  });
  return parseChangePlan({
    ...plan,
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function renameRows(
  rows: readonly RunOperation[],
  replacements: ReadonlyMap<string, string>,
): readonly RunOperation[] {
  return Object.freeze(
    rows.map((row) =>
      parseRunOperation({
        ...row,
        operationId: replacements.get(row.operationId) ?? row.operationId,
      }),
    ),
  );
}

function replaceCreatedAuditListId(
  rows: readonly RunOperation[],
  listId: UserListId,
): readonly RunOperation[] {
  const createRow = rows.find(
    (row) => row.operationId === rollbackSourceOperationIds.create,
  );
  const createAfter = createRow?.after as
    | Readonly<Record<string, JsonValue>>
    | undefined;
  if (typeof createAfter?.listId !== "string") {
    throw new Error("Expected complete source List creation audit");
  }
  const previousListId = createAfter.listId;
  return Object.freeze(
    rows.map((row) => {
      if (row.operationId === rollbackSourceOperationIds.create) {
        return parseRunOperation({
          ...row,
          after: {
            ...(row.after as Readonly<Record<string, JsonValue>>),
            listId,
          },
        });
      }
      if (row.operationId !== rollbackSourceOperationIds.createdMembership) {
        return row;
      }
      const after = row.after as Readonly<Record<string, JsonValue>>;
      if (!Array.isArray(after.listIds)) {
        throw new Error("Expected created-List membership audit");
      }
      const listIds = after.listIds as readonly JsonValue[];
      return parseRunOperation({
        ...row,
        after: {
          listIds: listIds
            .map((candidate) =>
              candidate === previousListId ? listId : candidate,
            )
            .sort(),
        },
      });
    }),
  );
}

type RepositoryMembershipPage = Extract<
  ListMembershipQueryPage,
  { readonly selector: { readonly kind: "repository" } }
>;

function membershipIds(
  prefix: string,
  start: number,
  count: number,
): readonly UserListId[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      asUserListId(`${prefix}_${String(start + index).padStart(4, "0")}`),
    ),
  );
}

function repositoryMembershipPage(
  input: ListMembershipQuery,
  listIds: readonly UserListId[],
  total: number,
  nextCursor: string | null,
): RepositoryMembershipPage {
  if (input.selector.kind !== "repository") {
    throw new Error("Rollback must query memberships by repository");
  }
  return Object.freeze({
    coverage: "complete",
    selector: Object.freeze({
      kind: "repository" as const,
      repositoryId: input.selector.repositoryId,
    }),
    listIds: Object.freeze([...listIds]),
    total,
    nextCursor,
  });
}

function targetMembershipProvider(
  targetRepositoryId: ReturnType<typeof asRepositoryId>,
  pageForTarget: (input: ListMembershipQuery) => RepositoryMembershipPage,
): (
  input: ListMembershipQuery,
  fallback: () => ListMembershipQueryPage,
) => ListMembershipQueryPage {
  return (input, fallback) =>
    input.selector.kind === "repository" &&
    input.selector.repositoryId === targetRepositoryId
      ? pageForTarget(input)
      : fallback();
}

function assertNoDanglingDependencies(
  operations: readonly ResolvedOperation[],
): void {
  const ids = new Set(operations.map((operation) => operation.operationId));
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      expect(ids.has(dependency)).toBe(true);
    }
  }
}

class ExecutorShapeGitHub implements GitHubLiveReadPort, GitHubMutationPort {
  readonly #operation: ResolvedOperation;

  constructor(operation: ResolvedOperation) {
    this.#operation = operation;
  }

  getRepositoryIdentity(): Promise<RepositoryIdentity | null> {
    const operation = this.#operation;
    if (
      operation.kind !== "star" &&
      operation.kind !== "unstar" &&
      operation.kind !== "list_membership_set"
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      repositoryId: operation.repositoryId,
      repositoryDatabaseId: operation.repositoryDatabaseId,
      coordinates: operation.coordinates,
    });
  }

  checkStar(): Promise<boolean> {
    const before = this.#operation.before as Readonly<{ starred?: unknown }>;
    return Promise.resolve(before.starred === true);
  }

  getUserList(listId: UserListId): Promise<UserList | null> {
    const operation = this.#operation;
    if (operation.kind === "list_create") return Promise.resolve(null);
    if (operation.kind === "list_delete") {
      const before = operation.before as Readonly<{ list?: unknown }>;
      return Promise.resolve(before.list as UserList);
    }
    if (operation.kind === "list_update") {
      const before = metadata(operation.before);
      return Promise.resolve(
        userListFixture({
          listId,
          name: before.name,
          description: before.description,
          isPrivate: before.isPrivate,
        }),
      );
    }
    return Promise.resolve(null);
  }

  getRepositoryListIds(): Promise<readonly UserListId[]> {
    const operation = this.#operation;
    return Promise.resolve(
      operation.kind === "list_membership_set" ? operation.expectedListIds : [],
    );
  }

  star(): Promise<MutationReceipt> {
    return Promise.reject(new Error("shape test must not dispatch"));
  }

  unstar(): Promise<MutationReceipt> {
    return Promise.reject(new Error("shape test must not dispatch"));
  }

  createUserList(): Promise<UserListMutationResult> {
    return Promise.reject(new Error("shape test must not dispatch"));
  }

  updateUserList(): Promise<UserListMutationResult> {
    return Promise.reject(new Error("shape test must not dispatch"));
  }

  deleteUserList(): Promise<MutationReceipt> {
    return Promise.reject(new Error("shape test must not dispatch"));
  }

  setRepositoryListIds(): Promise<MutationReceipt> {
    return Promise.reject(new Error("shape test must not dispatch"));
  }
}

describe("RollbackService", () => {
  it("creates one ready, source-bound plan and normalizes caller policy", async () => {
    const fixture = rollbackFixture();
    const result = await service(fixture).createRollback({
      ...fixture.validInput,
      protectedRepositoryIds: [
        asRepositoryId("R_z"),
        asRepositoryId("R_a"),
        asRepositoryId("R_z"),
      ],
      protectedListIds: [
        asUserListId("UL_z"),
        asUserListId("UL_a"),
        asUserListId("UL_z"),
      ],
      ttlMinutes: 30,
      callerNote: "exact rollback",
    });

    expect(result.plan).toMatchObject({
      id: asPlanId("plan_rollback_1"),
      state: "ready",
      createdAt: "2026-07-16T03:00:00.000Z",
      expiresAt: "2026-07-16T03:30:00.000Z",
      callerNote: "exact rollback",
    });
    expect(result.plan.executable).toMatchObject({
      binding: fixture.sourceRun.binding,
      snapshotId: fixture.sourcePlan.executable.snapshotId,
      protectedRepositoryIds: ["R_a", "R_z"],
      protectedListIds: ["UL_a", "UL_z"],
    });
    expect(result.summary).toEqual({
      star: 1,
      unstar: 1,
      list_create: 1,
      list_update: 1,
      list_delete: 1,
      list_membership_set: 3,
    });
    expect(fixture.tracking.transactionCalls).toBe(1);
    expect(fixture.tracking.savedPlans).toEqual([result.plan]);
    expect(fixture.rawStorage.getPlan(result.plan.id)).toEqual(result.plan);
  });

  it("rejects hostile, unknown, and over-budget caller input before storage mutation", async () => {
    const overlong = "x".repeat(129);
    const tooManyIds = Array.from({ length: 5_001 }, () =>
      asRepositoryId("R_duplicate"),
    );
    const cases: readonly unknown[] = [
      { ...rollbackFixture().validInput, unsupported: true },
      {
        ...rollbackFixture().validInput,
        runId: "",
      },
      {
        ...rollbackFixture().validInput,
        runId: overlong,
      },
      {
        ...rollbackFixture().validInput,
        protectedRepositoryIds: "R_not_an_array",
      },
      {
        ...rollbackFixture().validInput,
        protectedRepositoryIds: tooManyIds,
      },
      {
        ...rollbackFixture().validInput,
        protectedListIds: [overlong],
      },
      {
        ...rollbackFixture().validInput,
        ttlMinutes: 0,
      },
      {
        ...rollbackFixture().validInput,
        callerNote: "x".repeat(2_001),
      },
    ];
    for (const input of cases) {
      const fixture = rollbackFixture();
      await rejectsWith(
        service(fixture).createRollback(input as CreateRollbackInput),
        "VALIDATION_ERROR",
      );
      expectNoSave(fixture);
    }

    let traps = 0;
    const fixture = rollbackFixture();
    const hostile = new Proxy(
      { ...fixture.validInput },
      {
        get() {
          traps += 1;
          throw new Error("hostile getter");
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error("hostile descriptor");
        },
        ownKeys() {
          traps += 1;
          throw new Error("hostile keys");
        },
      },
    );
    await rejectsWith(
      service(fixture).createRollback(hostile),
      "VALIDATION_ERROR",
    );
    expect(traps).toBe(0);
    expectNoSave(fixture);
  });

  it("enforces configured TTL and projected-operation ceilings", async () => {
    const ttl = rollbackFixture({ planTtlMinutes: 60 });
    await rejectsWith(
      service(ttl).createRollback({
        ...ttl.validInput,
        ttlMinutes: 61,
      }),
      "VALIDATION_ERROR",
    );
    expectNoSave(ttl);

    const actions = rollbackFixture({ maxPlanActions: 7 });
    await rejectsWith(
      service(actions).createRollback(actions.validInput),
      "PLAN_TOO_LARGE",
    );
    expectNoSave(actions);
  });

  it.each(["pending", "running", "failed"] as const)(
    "rejects a %s source run before loading or saving its plan",
    async (runState) => {
      const fixture = rollbackFixture({ runState });
      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );
      expect(fixture.tracking.getPlan).toBe(0);
      expectNoSave(fixture);
    },
  );

  it("rejects a coherent run returned under the wrong requested key before downstream reads", async () => {
    const substitutedRunId = asRunId("run_substituted");
    const fixture = rollbackFixture({
      transformRun: (run) =>
        parseChangeRun({
          ...run,
          id: substitutedRunId,
        }),
      runRowsProvider: (runId, rows) =>
        Object.freeze(
          rows.map((row) =>
            parseRunOperation({
              ...row,
              runId,
            }),
          ),
        ),
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );

    expect(fixture.tracking.getRun).toBe(1);
    expect(fixture.tracking.getPlan).toBe(0);
    expect(fixture.tracking.getCompleteSnapshot).toBe(0);
    expect(fixture.tracking.listRunOperations).toBe(0);
    expectNoSave(fixture);
  });

  it("rejects a complete snapshot returned under the wrong requested key before downstream reads", async () => {
    const fixture = rollbackFixture({
      transformSnapshot: (snapshot) => ({
        ...snapshot,
        id: asSnapshotId("snap_substituted"),
      }),
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );

    expect(fixture.tracking.getCompleteSnapshot).toBe(1);
    expect(fixture.tracking.listRunOperations).toBe(0);
    expect(fixture.tracking.listQueries).toEqual([]);
    expect(fixture.tracking.snapshotRepositoryReads).toBe(0);
    expect(fixture.tracking.membershipQueries).toBe(0);
    expectNoSave(fixture);
  });

  it("fails closed for missing source records and bindings", async () => {
    const missingRun = rollbackFixture({ transformRun: () => null });
    await rejectsWith(
      service(missingRun).createRollback(missingRun.validInput),
      "NOT_FOUND",
    );
    expectNoSave(missingRun);

    const missingPlan = rollbackFixture({
      transformRun: (run) =>
        parseChangeRun({ ...run, planId: asPlanId("plan_missing") }),
    });
    await rejectsWith(
      service(missingPlan).createRollback(missingPlan.validInput),
      "NOT_FOUND",
    );
    expectNoSave(missingPlan);

    const binding = rollbackFixture({
      transformRun: (run) =>
        parseChangeRun({
          ...run,
          binding: {
            host: "github.com",
            login: "other",
            accountId: "U_other",
          },
        }),
    });
    await rejectsWith(
      service(binding).createRollback(binding.validInput),
      "PRECONDITION_FAILED",
    );
    expectNoSave(binding);

    const planIdentity = rollbackFixture({
      transformPlan: (plan) =>
        parseChangePlan({
          ...plan,
          id: asPlanId("plan_wrong_source"),
        }),
    });
    await rejectsWith(
      service(planIdentity).createRollback(planIdentity.validInput),
      "PRECONDITION_FAILED",
    );
    expectNoSave(planIdentity);

    const lifecycle = rollbackFixture({
      transformPlan: (plan) =>
        parseChangePlan({
          ...plan,
          state: "ready",
        }),
    });
    await rejectsWith(
      service(lifecycle).createRollback(lifecycle.validInput),
      "PRECONDITION_FAILED",
    );
    expectNoSave(lifecycle);

    const snapshot = rollbackFixture({ sourceSnapshotAvailable: false });
    await rejectsWith(
      service(snapshot).createRollback(snapshot.validInput),
      "STALE_SNAPSHOT",
    );
    expectNoSave(snapshot);
  });

  it.each([
    [
      "run",
      () =>
        rollbackFixture({
          transformRun: (run) => ({ ...run, unknown: true }),
        }),
    ],
    [
      "plan",
      () =>
        rollbackFixture({
          transformPlan: (plan) => ({ ...plan, unknown: true }),
        }),
    ],
    [
      "snapshot",
      () =>
        rollbackFixture({
          transformSnapshot: (snapshot) => ({
            ...snapshot,
            unknown: true,
          }),
        }),
    ],
  ] as const)(
    "normalizes a corrupt storage-returned source %s to a precondition failure",
    async (_label, buildFixture) => {
      const fixture = buildFixture();
      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );
      expectNoSave(fixture);
    },
  );

  it("rejects missing, duplicate, foreign, mis-sequenced, or contradictory audit rows", async () => {
    const cases = [
      rollbackFixture({
        transformRows: (rows) => rows.slice(1),
      }),
      rollbackFixture({
        transformRows: (rows) => Object.freeze([...rows, rows[0]!]),
      }),
      rollbackFixture({
        transformRows: (rows) =>
          Object.freeze([
            ...rows.slice(0, 1),
            parseRunOperation({
              ...rows[1]!,
              runId: asRunId("run_foreign"),
            }),
            ...rows.slice(2),
          ]),
      }),
      rollbackFixture({
        transformRows: (rows) =>
          Object.freeze([
            ...rows.slice(0, 1),
            parseRunOperation({
              ...rows[1]!,
              sequence: 99,
            }),
            ...rows.slice(2),
          ]),
      }),
      rollbackFixture({
        transformRows: (rows) =>
          Object.freeze([
            ...rows.slice(0, 1),
            parseRunOperation({
              ...rows[1]!,
              before: { starred: false },
            }),
            ...rows.slice(2),
          ]),
      }),
      rollbackFixture({
        transformRows: (rows) =>
          Object.freeze([
            ...rows.slice(0, 2),
            parseRunOperation({
              ...rows[2]!,
              after: {
                name: "metadata is not a complete created List",
                description: null,
                isPrivate: false,
              },
            }),
            ...rows.slice(3),
          ]),
      }),
    ];

    for (const fixture of cases) {
      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );
      expectNoSave(fixture);
    }
  });

  it("rejects a completed run containing a failed operation row", async () => {
    const fixture = rollbackFixture({
      rowStatuses: {
        [rollbackSourceOperationIds.membership]: "failed",
      },
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );

    expect(fixture.tracking.listQueries).toEqual([]);
    expect(fixture.tracking.snapshotRepositoryReads).toBe(0);
    expect(fixture.tracking.membershipQueries).toBe(0);
    expectNoSave(fixture);
  });

  it("rejects a full-coverage partial run whose rows are all succeeded or skipped", async () => {
    const fixture = rollbackFixture({
      runState: "partial",
      failureMode: "continue",
      rowStatuses: {
        [rollbackSourceOperationIds.membership]: "skipped",
      },
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );

    expect(fixture.tracking.listQueries).toEqual([]);
    expect(fixture.tracking.snapshotRepositoryReads).toBe(0);
    expect(fixture.tracking.membershipQueries).toBe(0);
    expectNoSave(fixture);
  });

  it.each(["pending", "running"] as const)(
    "rejects a terminal source run containing a %s operation row",
    async (status) => {
      const fixture = rollbackFixture({
        rowStatuses: {
          [rollbackSourceOperationIds.membership]: status,
        },
      });

      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );

      expect(fixture.tracking.listQueries).toEqual([]);
      expect(fixture.tracking.snapshotRepositoryReads).toBe(0);
      expect(fixture.tracking.membershipQueries).toBe(0);
      expectNoSave(fixture);
    },
  );

  it("accepts a valid partial stop prefix ending at an unresolved boundary with an exact unscheduled suffix", async () => {
    const fixture = rollbackFixture({
      runState: "partial",
      failureMode: "stop",
      rowStatuses: {
        [rollbackSourceOperationIds.unstar]: "skipped",
        [rollbackSourceOperationIds.create]: "unresolved",
      },
      transformRows: (rows) => Object.freeze(rows.slice(0, 3)),
    });

    const { plan } = await service(fixture).createRollback(fixture.validInput);

    expect(
      plan.operations.some((operation) =>
        operation.operationId.includes(rollbackSourceOperationIds.star),
      ),
    ).toBe(true);
    expect(
      plan.operations.some((operation) =>
        operation.operationId.includes(rollbackSourceOperationIds.unstar),
      ),
    ).toBe(false);
    expect(plan.warnings).toContain(
      `Source run ${fixture.sourceRun.id} has 4 unscheduled operations without audit rows; they are not included.`,
    );
    expect(fixture.tracking.transactionCalls).toBe(1);
    expect(fixture.tracking.savedPlans).toEqual([plan]);
  });

  it("accepts a partial stop exact successful prefix with an unscheduled suffix", async () => {
    const fixture = rollbackFixture({
      runState: "partial",
      failureMode: "stop",
      transformRows: (rows) => Object.freeze(rows.slice(0, 2)),
    });

    const { plan } = await service(fixture).createRollback(fixture.validInput);

    expect(plan.warnings).toContain(
      `Source run ${fixture.sourceRun.id} has 5 unscheduled operations without audit rows; they are not included.`,
    );
    expect(fixture.tracking.transactionCalls).toBe(1);
    expect(fixture.tracking.savedPlans).toEqual([plan]);
  });

  it("accepts an exact stop-partial audit prefix and warns about the unscheduled gap", async () => {
    const fixture = rollbackFixture({
      runState: "partial",
      failureMode: "stop",
      rowStatuses: {
        [rollbackSourceOperationIds.create]: "failed",
      },
      transformRows: (rows) => Object.freeze(rows.slice(0, 3)),
    });

    const { plan } = await service(fixture).createRollback(fixture.validInput);

    expect(
      plan.operations.some((operation) =>
        operation.operationId.includes(rollbackSourceOperationIds.star),
      ),
    ).toBe(true);
    expect(
      plan.operations.some((operation) =>
        operation.operationId.includes(rollbackSourceOperationIds.unstar),
      ),
    ).toBe(true);
    for (const unscheduledId of [
      rollbackSourceOperationIds.createdMembership,
      rollbackSourceOperationIds.update,
      rollbackSourceOperationIds.delete,
      rollbackSourceOperationIds.membership,
    ]) {
      expect(
        plan.operations.some((operation) =>
          operation.operationId.includes(unscheduledId),
        ),
      ).toBe(false);
    }
    expect(plan.warnings).toContain(
      `Source run ${fixture.sourceRun.id} has 4 unscheduled operations without audit rows; they are not included.`,
    );
    expect(plan.warnings).toContain(
      `Source operation ${rollbackSourceOperationIds.create} was non-succeeded (failed) and is not included.`,
    );
    expect(fixture.tracking.transactionCalls).toBe(1);
    expect(fixture.tracking.savedPlans).toEqual([plan]);
  });

  it("keeps stop-partial audit prefixes closed against gaps, post-stop rows, and other lifecycle modes", async () => {
    const cases = [
      rollbackFixture({
        runState: "partial",
        failureMode: "stop",
        rowStatuses: {
          [rollbackSourceOperationIds.unstar]: "failed",
        },
        transformRows: (rows) => Object.freeze([rows[0]!, rows[2]!]),
      }),
      rollbackFixture({
        runState: "partial",
        failureMode: "stop",
        rowStatuses: {
          [rollbackSourceOperationIds.unstar]: "failed",
        },
        transformRows: (rows) => Object.freeze(rows.slice(0, 3)),
      }),
      rollbackFixture({
        runState: "partial",
        failureMode: "continue",
        rowStatuses: {
          [rollbackSourceOperationIds.create]: "failed",
        },
        transformRows: (rows) => Object.freeze(rows.slice(0, 3)),
      }),
      rollbackFixture({
        runState: "completed",
        failureMode: "stop",
        transformRows: (rows) => Object.freeze(rows.slice(0, 6)),
      }),
    ];

    for (const fixture of cases) {
      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );
      expectNoSave(fixture);
    }
  });

  it("rejects a successful List creation whose actual ID was already in its source baseline", async () => {
    const collision = asUserListId("UL_source_baseline_collision");
    let changedPlan: ChangePlan | null = null;
    const fixture = rollbackFixture({
      transformPlan: (plan) => {
        changedPlan = replaceOperation(
          plan,
          rollbackSourceOperationIds.create,
          (operation) => {
            if (operation.kind !== "list_create") {
              throw new Error("Expected source List creation");
            }
            const before = operation.before as Readonly<{
              listIds?: unknown;
            }>;
            if (!Array.isArray(before.listIds)) {
              throw new Error("Expected source List baseline");
            }
            const listIds = Object.freeze(
              [...(before.listIds as readonly UserListId[]), collision].sort(),
            );
            return parseResolvedOperation({
              ...operation,
              preconditions: Object.freeze([
                Object.freeze({
                  kind: "list_id_baseline",
                  expected: Object.freeze({ listIds }),
                }),
              ]),
              before: Object.freeze({ listIds }),
            });
          },
        );
        return changedPlan;
      },
      transformRows: (rows) =>
        Object.freeze(
          replaceCreatedAuditListId(rows, collision).map((row) => {
            if (row.operationId !== rollbackSourceOperationIds.create) {
              return row;
            }
            const sourceCreate = operationById(
              changedPlan!.operations,
              rollbackSourceOperationIds.create,
            );
            return parseRunOperation({
              ...row,
              before: sourceCreate.before,
            });
          }),
        ),
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );
    expectNoSave(fixture);
  });

  it("exhausts and bounds the complete snapshot List baseline before trusting a created ID", async () => {
    const additionalLists = Object.freeze(
      Array.from({ length: 101 }, (_, index) => {
        const suffix = String(index).padStart(3, "0");
        return userListFixture({
          listId: asUserListId(`UL_extra_${suffix}`),
          name: `Extra ${suffix}`,
          slug: `extra-${suffix}`,
        });
      }),
    );
    const collision = additionalLists[100]!.listId;
    const paged = rollbackFixture({
      additionalSnapshotLists: additionalLists,
      transformRows: (rows) => replaceCreatedAuditListId(rows, collision),
    });

    await rejectsWith(
      service(paged).createRollback(paged.validInput),
      "PRECONDITION_FAILED",
    );
    expect(paged.tracking.listQueries).toHaveLength(2);
    expect(paged.tracking.listQueries[0]).toMatchObject({
      pageSize: 100,
      cursor: null,
    });
    expect(paged.tracking.listQueries[1]!.cursor).not.toBeNull();
    expectNoSave(paged);

    const overBound = rollbackFixture({
      transformListPage: (page) =>
        Object.freeze({
          ...page,
          total: 5_001,
        }),
    });
    await rejectsWith(
      service(overBound).createRollback(overBound.validInput),
      "PRECONDITION_FAILED",
    );
    expect(overBound.tracking.listQueries).toHaveLength(1);
    expectNoSave(overBound);
  });

  it("rejects an A-to-B-to-A membership cursor cycle before revisiting a cursor", async () => {
    const target = asRepositoryId("R_created_member");
    let cursorAVisits = 0;
    const fixture = rollbackFixture({
      membershipPageProvider: targetMembershipProvider(target, (input) => {
        if (input.cursor === null) {
          return repositoryMembershipPage(
            input,
            membershipIds("UL_cycle", 0, 1),
            4,
            "cursor_a",
          );
        }
        if (input.cursor === "cursor_a") {
          cursorAVisits += 1;
          return repositoryMembershipPage(
            input,
            membershipIds("UL_cycle", cursorAVisits === 1 ? 1 : 3, 1),
            4,
            cursorAVisits === 1 ? "cursor_b" : null,
          );
        }
        if (input.cursor === "cursor_b") {
          return repositoryMembershipPage(
            input,
            membershipIds("UL_cycle", 2, 1),
            4,
            "cursor_a",
          );
        }
        throw new Error("Unexpected membership cursor");
      }),
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );
    expect(fixture.tracking.membershipQueries).toBe(3);
    expect(cursorAVisits).toBe(1);
    expectNoSave(fixture);
  });

  it("rejects a single membership page larger than the requested page size", async () => {
    const target = asRepositoryId("R_created_member");
    const fixture = rollbackFixture({
      membershipPageProvider: targetMembershipProvider(target, (input) =>
        repositoryMembershipPage(
          input,
          membershipIds("UL_oversized", 0, 101),
          101,
          null,
        ),
      ),
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );
    expect(fixture.tracking.membershipQueries).toBe(1);
    expectNoSave(fixture);
  });

  it("stops membership pagination as soon as accumulation exceeds the declared total", async () => {
    const target = asRepositoryId("R_created_member");
    const declaredBound = rollbackFixture({
      membershipPageProvider: targetMembershipProvider(target, (input) => {
        if (input.cursor === null) {
          return repositoryMembershipPage(
            input,
            membershipIds("UL_declared", 0, 100),
            100,
            "declared_1",
          );
        }
        if (input.cursor === "declared_1") {
          return repositoryMembershipPage(
            input,
            membershipIds("UL_declared", 100, 1),
            100,
            "declared_2",
          );
        }
        return repositoryMembershipPage(input, [], 100, null);
      }),
    });

    await rejectsWith(
      service(declaredBound).createRollback(declaredBound.validInput),
      "PRECONDITION_FAILED",
    );
    expect(declaredBound.tracking.membershipQueries).toBe(2);
    expectNoSave(declaredBound);
  });

  it("stops membership pagination as soon as accumulation exceeds the global bound", async () => {
    const target = asRepositoryId("R_created_member");
    const globalBound = rollbackFixture({
      membershipPageProvider: targetMembershipProvider(target, (input) => {
        const pageIndex =
          input.cursor === null
            ? 0
            : Number.parseInt(input.cursor.replace("global_", ""), 10);
        if (pageIndex < 50) {
          return repositoryMembershipPage(
            input,
            membershipIds("UL_global", pageIndex * 100, 100),
            5_000,
            `global_${String(pageIndex + 1)}`,
          );
        }
        if (pageIndex === 50) {
          return repositoryMembershipPage(
            input,
            membershipIds("UL_global", 5_000, 1),
            5_000,
            "global_51",
          );
        }
        return repositoryMembershipPage(input, [], 5_000, null);
      }),
    });

    await rejectsWith(
      service(globalBound).createRollback(globalBound.validInput),
      "PRECONDITION_FAILED",
    );
    expect(globalBound.tracking.membershipQueries).toBe(51);
    expectNoSave(globalBound);
  });

  it("rejects negative, unsafe, and cross-page-changing membership totals", async () => {
    const target = asRepositoryId("R_created_member");
    const cases = [
      {
        calls: 1,
        fixture: rollbackFixture({
          membershipPageProvider: targetMembershipProvider(target, (input) =>
            repositoryMembershipPage(input, [], -1, null),
          ),
        }),
      },
      {
        calls: 1,
        fixture: rollbackFixture({
          membershipPageProvider: targetMembershipProvider(target, (input) =>
            repositoryMembershipPage(
              input,
              [],
              Number.MAX_SAFE_INTEGER + 1,
              null,
            ),
          ),
        }),
      },
      {
        calls: 2,
        fixture: rollbackFixture({
          membershipPageProvider: targetMembershipProvider(target, (input) =>
            input.cursor === null
              ? repositoryMembershipPage(
                  input,
                  membershipIds("UL_total", 0, 1),
                  2,
                  "total_1",
                )
              : repositoryMembershipPage(
                  input,
                  membershipIds("UL_total", 1, 1),
                  3,
                  null,
                ),
          ),
        }),
      },
    ];

    for (const { calls, fixture } of cases) {
      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );
      expect(fixture.tracking.membershipQueries).toBe(calls);
      expectNoSave(fixture);
    }
  });

  it("retains exact-end and duplicate membership validation", async () => {
    const target = asRepositoryId("R_created_member");
    const duplicate = asUserListId("UL_duplicate");
    const invalidCases = [
      rollbackFixture({
        membershipPageProvider: targetMembershipProvider(target, (input) =>
          input.cursor === null
            ? repositoryMembershipPage(input, [duplicate], 2, "duplicate_1")
            : repositoryMembershipPage(input, [duplicate], 2, null),
        ),
      }),
      rollbackFixture({
        membershipPageProvider: targetMembershipProvider(target, (input) =>
          repositoryMembershipPage(
            input,
            membershipIds("UL_incomplete", 0, 1),
            2,
            null,
          ),
        ),
      }),
    ];

    for (const fixture of invalidCases) {
      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );
      expectNoSave(fixture);
    }

    const exact = rollbackFixture({
      membershipPageProvider: targetMembershipProvider(target, (input) =>
        input.cursor === null
          ? repositoryMembershipPage(
              input,
              membershipIds("UL_exact", 0, 1),
              2,
              "exact_1",
            )
          : repositoryMembershipPage(
              input,
              membershipIds("UL_exact", 1, 1),
              2,
              null,
            ),
      ),
    });
    const { plan } = await service(exact).createRollback(exact.validInput);
    expect(exact.tracking.transactionCalls).toBe(1);
    expect(exact.tracking.savedPlans).toEqual([plan]);
  });

  it("rejects corrupt or key-mismatched snapshot repository records before persistence", async () => {
    const base = {
      runState: "partial" as const,
      rowStatuses: {
        [rollbackSourceOperationIds.unstar]: "failed" as const,
      },
    };
    const cases = [
      rollbackFixture({
        ...base,
        transformSnapshotRepository: (repository) =>
          repository === null
            ? null
            : {
                ...repository,
                repositoryId: asRepositoryId("R_wrong_snapshot_key"),
              },
      }),
      rollbackFixture({
        ...base,
        transformSnapshotRepository: (repository) =>
          repository === null ? null : { ...repository, owner: "" },
      }),
    ];

    for (const fixture of cases) {
      await rejectsWith(
        service(fixture).createRollback(fixture.validInput),
        "PRECONDITION_FAILED",
      );
      expect(fixture.tracking.snapshotRepositoryReads).toBeGreaterThan(0);
      expectNoSave(fixture);
    }
  });

  it("projects every successful source kind into exact executable inverse state", async () => {
    const fixture = rollbackFixture();
    const { plan } = await service(fixture).createRollback(fixture.validInput);
    const operations = plan.operations;

    const undoStar = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.star}`,
    );
    expect(undoStar).toMatchObject({
      kind: "unstar",
      repositoryId: fixture.ids.starRepository,
      before: { starred: true, listIds: [] },
      after: { starred: false },
      inverse: { kind: "star", listIds: [] },
    });

    const undoUnstar = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.unstar}`,
    );
    expect(undoUnstar).toMatchObject({
      kind: "star",
      repositoryId: fixture.ids.unstarRepository,
      before: { starred: false },
      after: { starred: true },
      inverse: { kind: "unstar" },
    });

    const undoCreate = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.create}`,
    );
    expect(undoCreate).toMatchObject({
      kind: "list_delete",
      listId: fixture.ids.createdActualList,
      before: {
        list: {
          listId: fixture.ids.createdActualList,
          name: fixture.lists.createdActual.name,
          slug: fixture.lists.createdActual.slug,
        },
        repositoryIds: [fixture.ids.createdMemberRepository],
      },
      after: { exists: false },
    });

    const undoUpdate = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.update}`,
    );
    expect(undoUpdate).toMatchObject({
      kind: "list_update",
      listId: fixture.ids.existingList,
      before: {
        name: "Updated",
        description: "After",
        isPrivate: true,
      },
      after: {
        name: fixture.lists.existing.name,
        description: fixture.lists.existing.description,
        isPrivate: fixture.lists.existing.isPrivate,
      },
    });

    const recreate = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.delete}`,
    );
    expect(recreate).toMatchObject({
      kind: "list_create",
      before: {
        listIds: [
          fixture.ids.addList,
          fixture.ids.createdActualList,
          fixture.ids.existingList,
        ],
      },
      after: {
        name: fixture.lists.deleted.name,
        description: fixture.lists.deleted.description,
        isPrivate: fixture.lists.deleted.isPrivate,
      },
    });
    expect(recreate.kind).toBe("list_create");
    if (recreate.kind === "list_create") {
      expect(recreate.clientRef).toMatch(/^rollback_/u);
    }

    const directMembership = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.membership}`,
    );
    expect(directMembership).toMatchObject({
      kind: "list_membership_set",
      repositoryId: fixture.ids.memberRepository,
      expectedListIds: [fixture.ids.addList],
      targetLists: [{ kind: "existing", listId: fixture.ids.existingList }],
      before: { listIds: [fixture.ids.addList] },
      after: { listIds: [fixture.ids.existingList] },
    });

    expect(
      operations.every((operation) => operation.operationId.length <= 128),
    ).toBe(true);
    expect(
      operations.every((operation) =>
        operation.operationId.startsWith("undo_"),
      ),
    ).toBe(true);
    expect(plan.hash).toBe(hashPlanExecutable(plan.executable));
  });

  it("reverses the successful induced graph, orders one-to-many work, and coalesces only exact restorations", async () => {
    const fixture = rollbackFixture();
    const { plan } = await service(fixture).createRollback(fixture.validInput);
    const operations = plan.operations;
    const deleteCreated = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.create}`,
    );
    const removeCreatedMembership = operations.find(
      (operation) =>
        operation.kind === "list_membership_set" &&
        operation.repositoryId === fixture.ids.createdMemberRepository,
    );
    expect(removeCreatedMembership).toBeDefined();
    expect(deleteCreated.dependsOn).toContain(
      removeCreatedMembership!.operationId,
    );

    const restar = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.unstar}`,
    );
    const recreate = operationById(
      operations,
      `undo_${rollbackSourceOperationIds.delete}`,
    );
    const coalesced = operations.filter(
      (operation) =>
        operation.kind === "list_membership_set" &&
        operation.repositoryId === fixture.ids.unstarRepository,
    );
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]!.dependsOn).toEqual(
      [recreate.operationId, restar.operationId].sort(),
    );
    expect(coalesced[0]).toMatchObject({
      expectedListIds: [],
      targetLists: [
        { kind: "existing", listId: fixture.ids.existingList },
        {
          kind: "created",
          createOperationId: recreate.operationId,
        },
      ],
    });

    expect(topologicalOperationIds(operations, plan.dependencies)).toHaveLength(
      operations.length,
    );
    assertNoDanglingDependencies(operations);
  });

  it("uses only succeeded nodes when reversing dependencies and deriving created-List membership", async () => {
    const fixture = rollbackFixture({
      runState: "partial",
      rowStatuses: {
        [rollbackSourceOperationIds.createdMembership]: "skipped",
        [rollbackSourceOperationIds.membership]: "failed",
      },
    });
    const { plan } = await service(fixture).createRollback(fixture.validInput);
    const deleteCreated = operationById(
      plan.operations,
      `undo_${rollbackSourceOperationIds.create}`,
    );

    expect(deleteCreated.dependsOn).toEqual([]);
    expect(deleteCreated).toMatchObject({
      kind: "list_delete",
      before: { repositoryIds: [] },
    });
    expect(
      plan.operations.some((operation) =>
        operation.operationId.includes(
          rollbackSourceOperationIds.createdMembership,
        ),
      ),
    ).toBe(false);
    expect(plan.warnings.join("\n")).toMatch(/partial/iu);
    expect(plan.warnings.join("\n")).toMatch(/non-succeeded|skipped/iu);
  });

  it("rejects conflicting complete restoration sets instead of unioning or taking the last writer", async () => {
    let changedPlan: ChangePlan | null = null;
    const fixture = rollbackFixture({
      transformPlan: (plan) => {
        changedPlan = replaceOperation(
          plan,
          rollbackSourceOperationIds.unstar,
          (operation) => {
            if (operation.kind !== "unstar") {
              throw new Error("Expected source unstar");
            }
            const listIds = Object.freeze([asUserListId("UL_existing")]);
            return {
              ...operation,
              before: {
                starred: true,
                starredAt: "2026-07-16T00:00:00.000Z",
                listIds,
              },
              inverse: { kind: "star", listIds },
            };
          },
        );
        return changedPlan;
      },
      transformRows: (rows) =>
        Object.freeze(
          rows.map((row) =>
            row.operationId === rollbackSourceOperationIds.unstar
              ? parseRunOperation({
                  ...row,
                  before: operationById(
                    changedPlan!.operations,
                    rollbackSourceOperationIds.unstar,
                  ).before,
                })
              : row,
          ),
        ),
    });

    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "PRECONDITION_FAILED",
    );
    expectNoSave(fixture);
  });

  it("applies protected-target dependency closure and rebuilds a graph with no dangling edge", async () => {
    const fixture = rollbackFixture();
    const { plan } = await service(fixture).createRollback({
      ...fixture.validInput,
      protectedRepositoryIds: [fixture.ids.createdMemberRepository],
      protectedListIds: [],
    });

    expect(
      plan.operations.some(
        (operation) =>
          operation.kind === "list_membership_set" &&
          operation.repositoryId === fixture.ids.createdMemberRepository,
      ),
    ).toBe(false);
    expect(
      plan.operations.some(
        (operation) =>
          operation.operationId === `undo_${rollbackSourceOperationIds.create}`,
      ),
    ).toBe(false);
    expect(plan.warnings.join("\n")).toMatch(/protected/iu);
    assertNoDanglingDependencies(plan.operations);
    expect(() =>
      topologicalOperationIds(plan.operations, plan.dependencies),
    ).not.toThrow();

    const protectedList = rollbackFixture();
    const listResult = await service(protectedList).createRollback({
      ...protectedList.validInput,
      protectedRepositoryIds: [],
      protectedListIds: [protectedList.ids.deletedList],
    });
    expect(
      listResult.plan.operations.some(
        (operation) =>
          operation.operationId === `undo_${rollbackSourceOperationIds.delete}`,
      ),
    ).toBe(false);
    assertNoDanglingDependencies(listResult.plan.operations);
  });

  it("emits sorted deterministic warnings for lost timestamps, recreated IDs, protection, and partial coverage", async () => {
    const fixture = rollbackFixture({
      runState: "partial",
      rowStatuses: {
        [rollbackSourceOperationIds.update]: "failed",
      },
    });
    const { plan } = await service(fixture).createRollback({
      ...fixture.validInput,
      protectedRepositoryIds: [fixture.ids.memberRepository],
      protectedListIds: [],
    });
    const warnings = plan.warnings;
    const text = warnings.join("\n");

    expect(text).toMatch(/starred_at/iu);
    expect(text).toMatch(/new.*List ID|List ID.*new/iu);
    expect(text).toMatch(/protected/iu);
    expect(text).toMatch(/partial/iu);
    expect(text).toMatch(/failed|non-succeeded/iu);
    expect(warnings).toEqual([...warnings].sort());
    expect(warnings.length).toBeLessThanOrEqual(1_000);
    expect(warnings.every((warning) => warning.length <= 2_000)).toBe(true);
  });

  it("is byte deterministic across repeated creation except for the plan ID", async () => {
    const fixture = rollbackFixture();
    const rollback = service(fixture);
    const first = await rollback.createRollback(fixture.validInput);
    const second = await rollback.createRollback(fixture.validInput);

    expect(first.plan.id).not.toBe(second.plan.id);
    expect(canonicalJson(first.plan.executable)).toBe(
      canonicalJson(second.plan.executable),
    );
    expect(first.plan.hash).toBe(second.plan.hash);
    expect(first.plan.operations).toEqual(second.plan.operations);
    expect(first.plan.dependencies).toEqual(second.plan.dependencies);
    expect(first.plan.warnings).toEqual(second.plan.warnings);
    expect(fixture.tracking.savedPlans).toHaveLength(2);
  });

  it("derives collision-resistant bounded inverse IDs for distinct legal long source IDs", async () => {
    const firstLong = `op_${"x".repeat(124)}a`;
    const secondLong = `op_${"x".repeat(124)}b`;
    expect(firstLong).toHaveLength(128);
    expect(secondLong).toHaveLength(128);
    const replacements = new Map<string, string>([
      [rollbackSourceOperationIds.star, firstLong],
      [rollbackSourceOperationIds.unstar, secondLong],
    ]);
    let renamedPlan: ChangePlan | null = null;
    const fixture = rollbackFixture({
      transformPlan: (plan) => {
        renamedPlan = renameOperationIds(plan, replacements);
        return renamedPlan;
      },
      transformRows: (rows) => renameRows(rows, replacements),
    });
    const first = await service(fixture).createRollback(fixture.validInput);
    const second = await service(fixture).createRollback(fixture.validInput);
    const relevant = first.plan.operations.filter(
      (operation) => operation.kind === "star" || operation.kind === "unstar",
    );

    expect(renamedPlan).not.toBeNull();
    expect(relevant).toHaveLength(2);
    expect(
      new Set(relevant.map((operation) => operation.operationId)).size,
    ).toBe(2);
    expect(
      relevant.every(
        (operation) =>
          operation.operationId.startsWith("undo_") &&
          operation.operationId.length <= 128,
      ),
    ).toBe(true);
    expect(
      new Set(first.plan.operations.map((operation) => operation.operationId))
        .size,
    ).toBe(first.plan.operations.length);
    expect(
      first.plan.operations.every(
        (operation) =>
          operation.operationId.startsWith("undo_") &&
          operation.operationId.length <= 128,
      ),
    ).toBe(true);
    expect(first.plan.operations.map(({ operationId }) => operationId)).toEqual(
      second.plan.operations.map(({ operationId }) => operationId),
    );
  });

  it("passes every projected kind through the real MutationExecutor shape and precondition path", async () => {
    const fixture = rollbackFixture();
    const { plan } = await service(fixture).createRollback(fixture.validInput);
    expect(new Set(plan.operations.map((operation) => operation.kind))).toEqual(
      new Set([
        "star",
        "unstar",
        "list_create",
        "list_update",
        "list_delete",
        "list_membership_set",
      ]),
    );
    expect(() => parsePlanExecutable(plan.executable)).not.toThrow();
    expect(() =>
      topologicalOperationIds(plan.operations, plan.dependencies),
    ).not.toThrow();

    for (const operation of plan.operations) {
      expect(parseResolvedOperation(operation)).toEqual(operation);
      const github = new ExecutorShapeGitHub(operation);
      const executor = new MutationExecutor(github, github);
      const context = {
        createdListIdsByOperationId: new Map<string, UserListId>(),
      };
      if (operation.kind === "list_membership_set") {
        let sequence = 0;
        for (const target of operation.targetLists) {
          if (target.kind !== "created") continue;
          sequence += 1;
          context.createdListIdsByOperationId.set(
            target.createOperationId,
            asUserListId(`UL_executor_${String(sequence)}`),
          );
        }
      }
      await expect(executor.prepare(operation, context)).resolves.toMatchObject(
        {
          kind: "dispatch",
        },
      );
    }
  });

  it("rolls back a failed save and has no GitHub dependency or constructor slot", async () => {
    const fixture = rollbackFixture({ failSave: true });
    await rejectsWith(
      service(fixture).createRollback(fixture.validInput),
      "STORAGE_ERROR",
    );
    expect(fixture.tracking.transactionCalls).toBe(1);
    expect(fixture.tracking.savedPlans).toEqual([]);
    expect(fixture.rawStorage.getPlan(asPlanId("plan_rollback_1"))).toBeNull();

    const source = readFileSync(
      new URL("../../../src/app/services/rollback-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/github-port/iu);
    expect(source).not.toMatch(/GitHub(?:Read|Mutation|Status|Port|Client)/u);
    expect(RollbackService.length).toBe(3);
  });
});
