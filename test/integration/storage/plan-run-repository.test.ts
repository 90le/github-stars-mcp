import { afterEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { canonicalJson } from "../../../src/domain/canonical-json.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asPlanId,
  asRepositoryDatabaseId,
  asRepositoryId,
  asUserListId,
} from "../../../src/domain/ids.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  type ChangePlan,
  type PlanExecutableContent,
  type ResolvedOperation,
} from "../../../src/domain/plan.js";
import { PlanRunRepository } from "../../../src/storage/plan-run-repository.js";
import { runInNewImmediateTransaction } from "../../../src/storage/sqlite-transaction.js";
import {
  changePlanFixture,
  accountBindingFixture,
} from "../../fixtures/domain.js";
import {
  createSqliteSnapshotFixture,
  publishBatch,
  repositoryBatch,
  snapshotDraft,
  type SqliteSnapshotFixture,
} from "../../fixtures/sqlite-snapshot.js";

interface PlanRow {
  readonly state: string;
  readonly executable_json: string;
  readonly warnings_json: string;
  readonly summary_json: string;
}

interface CountRow {
  readonly value: number;
}

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

function completeSource(
  coverage: "complete" | "unavailable" | "omitted" = "complete",
): {
  readonly fixture: SqliteSnapshotFixture;
  readonly plans: PlanRunRepository;
} {
  const fixture = createSqliteSnapshotFixture();
  openDatabases.push(fixture.database);
  const batch = repositoryBatch({ includeList: coverage === "complete" });
  fixture.snapshots.createSnapshot({
    draft: snapshotDraft(
      changePlanFixture.executable.snapshotId,
      coverage === "complete" ? "collecting" : coverage,
    ),
    lease: fixture.guard,
  });
  fixture.snapshots.appendSnapshotBatch({
    id: changePlanFixture.executable.snapshotId,
    batch,
    lease: fixture.guard,
  });
  publishBatch(
    fixture,
    changePlanFixture.executable.snapshotId,
    batch,
    coverage,
  );
  return { fixture, plans: new PlanRunRepository(fixture.database) };
}

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("expected operation to fail");
}

function planWith(
  changes: Partial<{
    readonly protectedRepositoryIds: readonly ReturnType<
      typeof asRepositoryId
    >[];
  }>,
): ChangePlan {
  const executable = {
    ...changePlanFixture.executable,
    ...changes,
  };
  return parseChangePlan({
    ...changePlanFixture,
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function dependentPlan(): ChangePlan {
  const first = {
    ...changePlanFixture.operations[0]!,
    operationId: "op_a",
  } as ResolvedOperation;
  const second = {
    ...changePlanFixture.operations[0]!,
    operationId: "op_b",
    dependsOn: ["op_a"],
  } as ResolvedOperation;
  const executable: PlanExecutableContent = {
    ...changePlanFixture.executable,
    operations: [first, second],
    dependencies: [{ operationId: "op_b", dependsOnOperationId: "op_a" }],
  };
  return parseChangePlan({
    ...changePlanFixture,
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function allOperationKindsPlan(): ChangePlan {
  const operationBase = {
    dependsOn: [],
    preconditions: [],
    before: {},
    after: {},
    inverse: {},
    risk: "normal",
  } as const;
  const repositoryTarget = {
    repositoryId: asRepositoryId("R_1"),
    repositoryDatabaseId: asRepositoryDatabaseId("42"),
    coordinates: { owner: "OpenAI", name: "SDK" },
  } as const;
  const operations: readonly ResolvedOperation[] = [
    {
      ...operationBase,
      ...repositoryTarget,
      operationId: "op_star",
      kind: "star",
    },
    {
      ...operationBase,
      ...repositoryTarget,
      operationId: "op_unstar",
      kind: "unstar",
    },
    {
      ...operationBase,
      operationId: "op_list_create",
      kind: "list_create",
      clientRef: "created-list",
    },
    {
      ...operationBase,
      operationId: "op_list_update",
      kind: "list_update",
      listId: asUserListId("UL_1"),
    },
    {
      ...operationBase,
      operationId: "op_list_delete",
      kind: "list_delete",
      listId: asUserListId("UL_1"),
    },
    {
      ...operationBase,
      ...repositoryTarget,
      operationId: "op_list_membership_set",
      kind: "list_membership_set",
      expectedListIds: [],
      targetLists: [],
    },
  ];
  const executable: PlanExecutableContent = {
    ...changePlanFixture.executable,
    operations,
    dependencies: [],
  };
  return parseChangePlan({
    ...changePlanFixture,
    hash: hashPlanExecutable(executable),
    executable,
    operations,
    dependencies: [],
  });
}

function unicodeDependencyPlan(): ChangePlan {
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
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

describe("PlanRunRepository plan persistence", () => {
  test("atomically saves and reconstructs the canonical plan projection", () => {
    const { fixture, plans } = completeSource();

    plans.savePlan(changePlanFixture);

    const loaded = plans.getPlan(changePlanFixture.id);
    expect(loaded).toEqual(changePlanFixture);
    expect(loaded).not.toBe(changePlanFixture);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.executable)).toBe(true);

    const row = fixture.database
      .prepare(
        `SELECT state,executable_json,warnings_json,summary_json
         FROM plans WHERE plan_id=?`,
      )
      .get(changePlanFixture.id) as PlanRow;
    expect(row.state).toBe("ready");
    expect(row.executable_json).toBe(
      canonicalJson(changePlanFixture.executable),
    );
    expect(row.warnings_json).toBe(canonicalJson(changePlanFixture.warnings));
    expect(row.summary_json).toBe(
      canonicalJson({
        list_create: 0,
        list_delete: 0,
        list_membership_set: 0,
        list_update: 0,
        star: 0,
        unstar: 1,
      }),
    );
    expect(
      fixture.database
        .prepare(
          `SELECT sequence,operation_id,kind,operation_json
           FROM plan_operations WHERE plan_id=?
           ORDER BY sequence`,
        )
        .all(changePlanFixture.id),
    ).toEqual([
      {
        sequence: 0,
        operation_id: "op_1",
        kind: "unstar",
        operation_json: canonicalJson(changePlanFixture.operations[0]),
      },
    ]);
    expect(
      fixture.database
        .prepare(
          `SELECT operation_id,depends_on_operation_id
           FROM plan_operation_dependencies WHERE plan_id=?`,
        )
        .all(changePlanFixture.id),
    ).toEqual([]);
  });

  test("stores the canonical six-key summary for every operation kind", () => {
    const { fixture, plans } = completeSource();
    const plan = allOperationKindsPlan();

    plans.savePlan(plan);

    const row = fixture.database
      .prepare("SELECT summary_json FROM plans WHERE plan_id=?")
      .get(plan.id) as Pick<PlanRow, "summary_json">;
    expect(row.summary_json).toBe(
      canonicalJson({
        list_create: 1,
        list_delete: 1,
        list_membership_set: 1,
        list_update: 1,
        star: 1,
        unstar: 1,
      }),
    );
  });

  test("persists and reconstructs normalized dependency rows", () => {
    const { fixture, plans } = completeSource();
    const plan = dependentPlan();

    plans.savePlan(plan);

    expect(plans.getPlan(plan.id)).toEqual(plan);
    expect(
      fixture.database
        .prepare(
          `SELECT operation_id,depends_on_operation_id
           FROM plan_operation_dependencies WHERE plan_id=?
           ORDER BY operation_id,depends_on_operation_id`,
        )
        .all(plan.id),
    ).toEqual([
      {
        operation_id: "op_b",
        depends_on_operation_id: "op_a",
      },
    ]);
  });

  test("round-trips domain UTF-16 dependency order and replays idempotently", () => {
    const { plans } = completeSource();
    const plan = unicodeDependencyPlan();

    plans.savePlan(plan);
    expect(plans.getPlan(plan.id)).toEqual(plan);
    expect(() => plans.savePlan(plan)).not.toThrow();
  });

  test("keeps lifecycle state on an identical replay and rejects immutable ID reuse", () => {
    const { plans } = completeSource();
    plans.savePlan(changePlanFixture);
    plans.compareAndSetPlanState({
      planId: changePlanFixture.id,
      expected: ["ready"],
      next: "applying",
    });

    plans.savePlan(changePlanFixture);
    expect(plans.getPlan(changePlanFixture.id)?.state).toBe("applying");

    const changed = planWith({
      protectedRepositoryIds: [asRepositoryId("R_protected")],
    });
    expect(errorCode(() => plans.savePlan(changed))).toBe(
      "PRECONDITION_FAILED",
    );
    expect(plans.getPlan(changePlanFixture.id)?.state).toBe("applying");
  });

  test("validates hash, source completion, binding, and fail-closed List coverage", () => {
    const rawInvalidHash = {
      ...changePlanFixture,
      hash: "f".repeat(64),
    } as ChangePlan;
    const empty = createSqliteSnapshotFixture();
    openDatabases.push(empty.database);
    const emptyPlans = new PlanRunRepository(empty.database);
    expect(errorCode(() => emptyPlans.savePlan(rawInvalidHash))).toBe(
      "PLAN_HASH_MISMATCH",
    );
    expect(errorCode(() => emptyPlans.savePlan(changePlanFixture))).toBe(
      "NOT_FOUND",
    );

    empty.snapshots.createSnapshot({
      draft: snapshotDraft(changePlanFixture.executable.snapshotId),
      lease: empty.guard,
    });
    expect(errorCode(() => emptyPlans.savePlan(changePlanFixture))).toBe(
      "PRECONDITION_FAILED",
    );

    const wrongBindingExecutable = {
      ...changePlanFixture.executable,
      binding: { ...accountBindingFixture, accountId: "U_other" },
    };
    const wrongBinding = parseChangePlan({
      ...changePlanFixture,
      hash: hashPlanExecutable(wrongBindingExecutable),
      executable: wrongBindingExecutable,
      operations: wrongBindingExecutable.operations,
      dependencies: wrongBindingExecutable.dependencies,
    });
    const unavailable = completeSource("unavailable");
    expect(errorCode(() => unavailable.plans.savePlan(wrongBinding))).toBe(
      "PRECONDITION_FAILED",
    );

    const requiresListsExecutable = {
      ...changePlanFixture.executable,
      protectedListIds: ["UL_protected"],
    };
    const requiresLists = parseChangePlan({
      ...changePlanFixture,
      hash: hashPlanExecutable(requiresListsExecutable),
      executable: requiresListsExecutable,
      operations: requiresListsExecutable.operations,
      dependencies: requiresListsExecutable.dependencies,
    });
    expect(errorCode(() => unavailable.plans.savePlan(requiresLists))).toBe(
      "CAPABILITY_UNAVAILABLE",
    );
  });

  test("validates and atomically compares plan lifecycle state", () => {
    const { plans } = completeSource();
    plans.savePlan(changePlanFixture);

    expect(
      plans.compareAndSetPlanState({
        planId: changePlanFixture.id,
        expected: ["ready"],
        next: "applying",
      }).state,
    ).toBe("applying");
    expect(
      errorCode(() =>
        plans.compareAndSetPlanState({
          planId: changePlanFixture.id,
          expected: ["ready"],
          next: "applying",
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      errorCode(() =>
        plans.compareAndSetPlanState({
          planId: asPlanId("plan_missing"),
          expected: ["ready"],
          next: "applying",
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      errorCode(() =>
        plans.compareAndSetPlanState({
          planId: asPlanId("plan_missing"),
          expected: ["ready", "ready"],
          next: "applying",
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(() =>
        plans.compareAndSetPlanState({
          planId: asPlanId("plan_missing"),
          expected: ["applied"],
          next: "ready",
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
  });

  test("rolls back its savepoint without poisoning a caller transaction", () => {
    const { fixture, plans } = completeSource();
    fixture.database.exec(`
      CREATE TABLE outer_marker(value TEXT PRIMARY KEY) STRICT;
      CREATE TRIGGER fail_plan_operation
      BEFORE INSERT ON plan_operations
      BEGIN
        SELECT RAISE(ABORT,'forced-plan-operation-failure');
      END;
    `);

    runInNewImmediateTransaction(fixture.database, () => {
      expect(errorCode(() => plans.savePlan(changePlanFixture))).toBe(
        "STORAGE_ERROR",
      );
      fixture.database
        .prepare("INSERT INTO outer_marker(value) VALUES ('committed')")
        .run();
    });

    expect(
      (
        fixture.database
          .prepare("SELECT COUNT(*) AS value FROM plans")
          .get() as CountRow
      ).value,
    ).toBe(0);
    expect(
      fixture.database.prepare("SELECT value FROM outer_marker").pluck().get(),
    ).toBe("committed");
  });
});
