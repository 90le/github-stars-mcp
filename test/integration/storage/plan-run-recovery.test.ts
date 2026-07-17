import { afterEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
import type { LeaseGuard } from "../../../src/app/ports/storage-port.js";
import { AppError } from "../../../src/domain/errors.js";
import { asPlanId, asRunId, asSnapshotId } from "../../../src/domain/ids.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  type ChangePlan,
  type PlanExecutableContent,
} from "../../../src/domain/plan.js";
import {
  parseChangeRun,
  parseRunOperation,
  type ChangeRun,
} from "../../../src/domain/run.js";
import { PlanRunRepository } from "../../../src/storage/plan-run-repository.js";
import {
  accountBindingFixture,
  changePlanFixture,
  changeRunFixture,
  pendingOperationFixture,
} from "../../fixtures/domain.js";
import {
  createSqliteSnapshotFixture,
  publishBatch,
  repositoryBatch,
  snapshotDraft,
  type SqliteSnapshotFixture,
} from "../../fixtures/sqlite-snapshot.js";

const openDatabases: Database.Database[] = [];
const RECOVERY_NOW = "2026-07-16T03:00:00.000Z";
const otherBinding = Object.freeze({
  host: "github.com",
  login: "other-account",
  accountId: "U_other",
});

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("expected operation to fail");
}

function openRepository(): {
  readonly fixture: SqliteSnapshotFixture;
  readonly repository: PlanRunRepository;
} {
  const fixture = createSqliteSnapshotFixture();
  openDatabases.push(fixture.database);
  const batch = repositoryBatch();
  fixture.snapshots.createSnapshot({
    draft: snapshotDraft(changePlanFixture.executable.snapshotId),
    lease: fixture.guard,
  });
  fixture.snapshots.appendSnapshotBatch({
    id: changePlanFixture.executable.snapshotId,
    batch,
    lease: fixture.guard,
  });
  publishBatch(fixture, changePlanFixture.executable.snapshotId, batch);
  return {
    fixture,
    repository: new PlanRunRepository(fixture.database),
  };
}

function variantPlan(id: string, zeroOperations = false): ChangePlan {
  const executable: PlanExecutableContent = zeroOperations
    ? {
        ...changePlanFixture.executable,
        operations: [],
        dependencies: [],
      }
    : changePlanFixture.executable;
  return parseChangePlan({
    ...changePlanFixture,
    id: asPlanId(id),
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function sixOperationPlan(): ChangePlan {
  const operations = Array.from({ length: 6 }, (_, index) => ({
    ...changePlanFixture.operations[0]!,
    operationId: `op_${String(index)}`,
  }));
  const executable: PlanExecutableContent = {
    ...changePlanFixture.executable,
    operations,
    dependencies: [],
  };
  return parseChangePlan({
    ...changePlanFixture,
    id: asPlanId("plan_statuses"),
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function variantRun(
  id: string,
  plan: ChangePlan,
  startedAt = changeRunFixture.startedAt,
): ChangeRun {
  return parseChangeRun({
    ...changeRunFixture,
    id: asRunId(id),
    planId: plan.id,
    startedAt,
  });
}

interface PreparedRun {
  readonly plan: ChangePlan;
  readonly run: ChangeRun;
  readonly guard: LeaseGuard;
}

function prepareRun(
  context: ReturnType<typeof openRepository>,
  input: {
    readonly planId: string;
    readonly runId: string;
    readonly leaseName: string;
    readonly leaseOwner?: string;
    readonly leaseExpiresAt?: string;
    readonly startedAt?: string;
    readonly state?: "pending" | "running";
    readonly operation?: "none" | "pending" | "running";
  },
): PreparedRun {
  const ownerId = input.leaseOwner ?? `${input.runId}:owner`;
  const expiresAt = input.leaseExpiresAt ?? "2026-07-16T02:30:00.000Z";
  const acquired = context.fixture.leases.acquireLease({
    name: input.leaseName,
    ownerId,
    now: "2026-07-16T02:00:00.000Z",
    expiresAt,
  });
  expect(acquired).not.toBeNull();
  const guard: LeaseGuard = {
    name: input.leaseName,
    ownerId,
    now: "2026-07-16T02:01:00.000Z",
  };
  const plan = variantPlan(input.planId, input.operation === "none");
  const run = variantRun(input.runId, plan, input.startedAt);
  context.repository.savePlan(plan);
  context.repository.compareAndSetPlanState({
    planId: plan.id,
    expected: ["ready"],
    next: "applying",
  });
  context.repository.createRun({ run, lease: guard });
  if ((input.state ?? "running") === "running") {
    context.repository.compareAndSetRunState({
      runId: run.id,
      expected: ["pending"],
      next: "running",
      finishedAt: null,
      lease: guard,
    });
  }
  if (input.operation !== "none" && input.operation !== undefined) {
    context.repository.createRunOperation({
      operation: parseRunOperation({
        ...pendingOperationFixture,
        runId: run.id,
      }),
      lease: guard,
    });
    if (input.operation === "running") {
      context.repository.startRunOperation({
        runId: run.id,
        operationId: pendingOperationFixture.operationId,
        startedAt: "2026-07-16T02:02:00.000Z",
        lease: guard,
      });
    }
  }
  return { plan, run, guard };
}

describe("PlanRunRepository recovery", () => {
  test("globally recovers a fixed expired/taken-over set in JS lexical order", () => {
    const context = openRepository();
    const pending = prepareRun(context, {
      planId: "plan_astral",
      runId: "run_𐀀",
      leaseName: "apply:astral",
      operation: "pending",
    });
    const running = prepareRun(context, {
      planId: "plan_private",
      runId: "run_\uE000",
      leaseName: "apply:private",
      operation: "running",
    });
    const zero = prepareRun(context, {
      planId: "plan_zero",
      runId: "run_zero",
      leaseName: "apply:zero",
      state: "pending",
      operation: "none",
    });
    const equal = prepareRun(context, {
      planId: "plan_equal",
      runId: "run_equal",
      leaseName: "apply:equal",
      leaseExpiresAt: RECOVERY_NOW,
      operation: "pending",
    });
    const takeover = prepareRun(context, {
      planId: "plan_takeover",
      runId: "run_takeover",
      leaseName: "apply:takeover",
      leaseOwner: "old-owner",
      operation: "pending",
    });
    context.fixture.leases.acquireLease({
      name: takeover.guard.name,
      ownerId: "new-owner",
      now: "2026-07-16T02:31:00.000Z",
      expiresAt: "2026-07-16T04:00:00.000Z",
    });
    const otherLease = prepareRun(context, {
      planId: "plan_other_lease",
      runId: "run_other_lease",
      leaseName: "apply:expired",
      leaseOwner: "shared-owner",
      operation: "pending",
    });
    context.fixture.leases.acquireLease({
      name: "apply:unrelated",
      ownerId: otherLease.guard.ownerId,
      now: "2026-07-16T02:10:00.000Z",
      expiresAt: "2026-07-16T04:00:00.000Z",
    });
    const active = prepareRun(context, {
      planId: "plan_active",
      runId: "run_active",
      leaseName: "apply:active",
      leaseExpiresAt: "2026-07-16T04:00:00.000Z",
      operation: "running",
    });
    const runningProjectionBefore = context.repository.getRunOperation({
      runId: running.run.id,
      operationId: "op_1",
    })!;
    const runningAttemptBefore = context.repository.getRunOperationAttempt({
      runId: running.run.id,
      operationId: "op_1",
      attempt: 1,
    })!;

    const recovered = context.repository.recoverInterruptedRuns(RECOVERY_NOW);

    expect(recovered).toEqual([
      equal.run.id,
      otherLease.run.id,
      takeover.run.id,
      zero.run.id,
      pending.run.id,
      running.run.id,
    ]);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(context.repository.getRun(active.run.id)?.state).toBe("running");
    expect(context.repository.getPlan(active.plan.id)?.state).toBe("applying");
    expect(context.repository.getRun(zero.run.id)).toMatchObject({
      state: "partial",
      finishedAt: RECOVERY_NOW,
    });
    const pendingProjection = context.repository.getRunOperation({
      runId: pending.run.id,
      operationId: "op_1",
    });
    expect(pendingProjection).toMatchObject({
      status: "failed",
      reconciliation: "confirmed_not_applied",
      attempts: 0,
      startedAt: null,
      finishedAt: RECOVERY_NOW,
      externalRequestId: null,
      after: null,
      error: {
        code: "INTERNAL_ERROR",
        message:
          "Operation was interrupted before dispatch; dispatch did not occur",
        retryable: true,
        details: { recovered: true },
      },
    });
    expect(
      context.repository.listRunOperationAttemptsPage({
        runId: pending.run.id,
        operationId: "op_1",
        afterAttempt: null,
        pageSize: 10,
      }).total,
    ).toBe(0);
    const recoveredProjection = context.repository.getRunOperation({
      runId: running.run.id,
      operationId: "op_1",
    })!;
    expect(recoveredProjection).toMatchObject({
      status: "unresolved",
      reconciliation: "unknown",
      before: runningProjectionBefore.before,
      startedAt: runningProjectionBefore.startedAt,
      finishedAt: RECOVERY_NOW,
      externalRequestId: runningProjectionBefore.externalRequestId,
      error: {
        code: "RECONCILIATION_REQUIRED",
        message: "Dispatch outcome is unknown after interruption",
        retryable: false,
        details: { recovered: true },
      },
    });
    const recoveredAttempt = context.repository.getRunOperationAttempt({
      runId: running.run.id,
      operationId: "op_1",
      attempt: 1,
    })!;
    expect(recoveredAttempt).toMatchObject({
      status: "unresolved",
      reconciliation: "unknown",
      before: runningAttemptBefore.before,
      startedAt: runningAttemptBefore.startedAt,
      finishedAt: RECOVERY_NOW,
      externalRequestId: runningAttemptBefore.externalRequestId,
      error: {
        code: "RECONCILIATION_REQUIRED",
        message: "Dispatch outcome is unknown after interruption",
        retryable: false,
        details: { recovered: true },
      },
    });
    expect(
      context.repository.listRunOperationReconciliationsPage({
        runId: running.run.id,
        operationId: "op_1",
        afterEventSequence: null,
        pageSize: 10,
      }).total,
    ).toBe(0);
    expect(context.repository.getPlan(running.plan.id)?.state).toBe("partial");
    expect(context.repository.recoverInterruptedRuns(RECOVERY_NOW)).toEqual([]);
  });

  test("targeted recovery validates the new lease and restricts binding/name", () => {
    const context = openRepository();
    const target = prepareRun(context, {
      planId: "plan_target",
      runId: "run_target",
      leaseName: "apply:target",
      leaseOwner: "old-owner",
      operation: "pending",
    });
    const other = prepareRun(context, {
      planId: "plan_other",
      runId: "run_other",
      leaseName: "apply:other",
      operation: "pending",
    });
    const otherBatch = repositoryBatch();
    const otherSnapshotId = asSnapshotId("snap_other_binding");
    context.fixture.snapshots.createSnapshot({
      draft: snapshotDraft(otherSnapshotId, "collecting", otherBinding),
      lease: context.fixture.guard,
    });
    context.fixture.snapshots.appendSnapshotBatch({
      id: otherSnapshotId,
      batch: otherBatch,
      lease: context.fixture.guard,
    });
    publishBatch(context.fixture, otherSnapshotId, otherBatch);
    const otherExecutable: PlanExecutableContent = {
      ...changePlanFixture.executable,
      binding: otherBinding,
      snapshotId: otherSnapshotId,
    };
    const crossBindingPlan = parseChangePlan({
      ...changePlanFixture,
      id: asPlanId("plan_cross_binding"),
      hash: hashPlanExecutable(otherExecutable),
      executable: otherExecutable,
      operations: otherExecutable.operations,
      dependencies: otherExecutable.dependencies,
    });
    const crossBindingRun = parseChangeRun({
      ...changeRunFixture,
      id: asRunId("run_cross_binding"),
      planId: crossBindingPlan.id,
      binding: otherBinding,
    });
    context.repository.savePlan(crossBindingPlan);
    context.repository.compareAndSetPlanState({
      planId: crossBindingPlan.id,
      expected: ["ready"],
      next: "applying",
    });
    context.repository.createRun({
      run: crossBindingRun,
      lease: target.guard,
    });
    context.repository.compareAndSetRunState({
      runId: crossBindingRun.id,
      expected: ["pending"],
      next: "running",
      finishedAt: null,
      lease: target.guard,
    });
    context.fixture.leases.acquireLease({
      name: target.guard.name,
      ownerId: "new-owner",
      now: "2026-07-16T02:31:00.000Z",
      expiresAt: "2026-07-16T04:00:00.000Z",
    });
    const newGuard: LeaseGuard = {
      name: target.guard.name,
      ownerId: "new-owner",
      now: RECOVERY_NOW,
    };
    expect(
      errorCode(() =>
        context.repository.recoverAbandonedRuns({
          binding: accountBindingFixture,
          lease: { ...newGuard, ownerId: "not-owner" },
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(context.repository.getRun(target.run.id)?.state).toBe("running");

    expect(
      context.repository.recoverAbandonedRuns({
        binding: accountBindingFixture,
        lease: newGuard,
      }),
    ).toEqual([target.run.id]);
    expect(context.repository.getRun(other.run.id)?.state).toBe("running");
    expect(context.repository.getRun(crossBindingRun.id)?.state).toBe(
      "running",
    );
  });

  test("rolls back every candidate when one recovery timestamp is invalid", () => {
    const context = openRepository();
    const early = prepareRun(context, {
      planId: "plan_early",
      runId: "run_early",
      leaseName: "apply:early",
      startedAt: "2026-07-16T02:00:00.000Z",
      operation: "pending",
    });
    const future = prepareRun(context, {
      planId: "plan_future",
      runId: "run_future",
      leaseName: "apply:future",
      startedAt: "2026-07-16T04:00:00.000Z",
      operation: "pending",
    });

    expect(
      errorCode(() => context.repository.recoverInterruptedRuns(RECOVERY_NOW)),
    ).toBe("PRECONDITION_FAILED");
    expect(context.repository.getRun(early.run.id)?.state).toBe("running");
    expect(context.repository.getPlan(early.plan.id)?.state).toBe("applying");
    expect(
      context.repository.getRunOperation({
        runId: early.run.id,
        operationId: "op_1",
      })?.status,
    ).toBe("pending");
    expect(context.repository.getRun(future.run.id)?.state).toBe("running");
  });
});

describe("PlanRunRepository incomplete summaries", () => {
  test("returns bounded ordered frozen counts for every incomplete state/status", () => {
    const context = openRepository();
    context.fixture.leases.acquireLease({
      name: "apply:statuses",
      ownerId: "summary-owner",
      now: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T04:00:00.000Z",
    });
    const statusGuard: LeaseGuard = {
      name: "apply:statuses",
      ownerId: "summary-owner",
      now: "2026-07-16T02:01:00.000Z",
    };
    const statusPlan = sixOperationPlan();
    const statusRun = variantRun("run_statuses", statusPlan);
    context.repository.savePlan(statusPlan);
    context.repository.compareAndSetPlanState({
      planId: statusPlan.id,
      expected: ["ready"],
      next: "applying",
    });
    context.repository.createRun({ run: statusRun, lease: statusGuard });
    context.repository.compareAndSetRunState({
      runId: statusRun.id,
      expected: ["pending"],
      next: "running",
      finishedAt: null,
      lease: statusGuard,
    });
    for (
      let sequence = 0;
      sequence < statusPlan.operations.length;
      sequence += 1
    ) {
      const resolved = statusPlan.operations[sequence]!;
      context.repository.createRunOperation({
        operation: parseRunOperation({
          ...pendingOperationFixture,
          runId: statusRun.id,
          operationId: resolved.operationId,
          sequence,
          before: resolved.before,
        }),
        lease: statusGuard,
      });
    }
    const start = (operationId: string, startedAt: string): void => {
      context.repository.startRunOperation({
        runId: statusRun.id,
        operationId,
        startedAt,
        lease: statusGuard,
      });
    };
    start("op_1", "2026-07-16T02:10:00.000Z");
    start("op_2", "2026-07-16T02:11:00.000Z");
    context.repository.finishRunOperation({
      phase: "after_dispatch",
      runId: statusRun.id,
      operationId: "op_2",
      status: "succeeded",
      reconciliation: "not_required",
      externalRequestId: null,
      after: null,
      error: null,
      finishedAt: "2026-07-16T02:12:00.000Z",
      lease: statusGuard,
    });
    context.repository.finishRunOperation({
      phase: "before_dispatch",
      runId: statusRun.id,
      operationId: "op_3",
      status: "skipped",
      reconciliation: "not_required",
      error: null,
      finishedAt: "2026-07-16T02:13:00.000Z",
      lease: statusGuard,
    });
    context.repository.finishRunOperation({
      phase: "before_dispatch",
      runId: statusRun.id,
      operationId: "op_4",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      error: {
        code: "GITHUB_UNAVAILABLE",
        message: "not dispatched",
        retryable: true,
        details: {},
      },
      finishedAt: "2026-07-16T02:14:00.000Z",
      lease: statusGuard,
    });
    start("op_5", "2026-07-16T02:15:00.000Z");
    context.repository.finishRunOperation({
      phase: "after_dispatch",
      runId: statusRun.id,
      operationId: "op_5",
      status: "unresolved",
      reconciliation: "unknown",
      externalRequestId: null,
      after: null,
      error: {
        code: "RECONCILIATION_REQUIRED",
        message: "unknown",
        retryable: false,
        details: {},
      },
      finishedAt: "2026-07-16T02:16:00.000Z",
      lease: statusGuard,
    });

    const astral = prepareRun(context, {
      planId: "plan_summary_astral",
      runId: "run_𐀀_summary",
      leaseName: "apply:summary-astral",
      operation: "none",
    });
    context.repository.compareAndSetRunState({
      runId: astral.run.id,
      expected: ["running"],
      next: "partial",
      finishedAt: RECOVERY_NOW,
      lease: astral.guard,
    });
    const privateUse = prepareRun(context, {
      planId: "plan_summary_private",
      runId: "run_\uE000_summary",
      leaseName: "apply:summary-private",
      state: "pending",
      operation: "none",
    });

    const otherBatch = repositoryBatch();
    const otherSnapshotId = asSnapshotId("snap_summary_other");
    context.fixture.snapshots.createSnapshot({
      draft: snapshotDraft(otherSnapshotId, "collecting", otherBinding),
      lease: context.fixture.guard,
    });
    context.fixture.snapshots.appendSnapshotBatch({
      id: otherSnapshotId,
      batch: otherBatch,
      lease: context.fixture.guard,
    });
    publishBatch(context.fixture, otherSnapshotId, otherBatch);
    const otherExecutable: PlanExecutableContent = {
      ...changePlanFixture.executable,
      binding: otherBinding,
      snapshotId: otherSnapshotId,
      operations: [],
      dependencies: [],
    };
    const otherPlan = parseChangePlan({
      ...changePlanFixture,
      id: asPlanId("plan_summary_other"),
      hash: hashPlanExecutable(otherExecutable),
      executable: otherExecutable,
      operations: [],
      dependencies: [],
    });
    const otherRun = parseChangeRun({
      ...changeRunFixture,
      id: asRunId("run_summary_other"),
      planId: otherPlan.id,
      binding: otherBinding,
    });
    context.repository.savePlan(otherPlan);
    context.repository.compareAndSetPlanState({
      planId: otherPlan.id,
      expected: ["ready"],
      next: "applying",
    });
    context.repository.createRun({ run: otherRun, lease: statusGuard });

    const summary = context.repository.getIncompleteRunSummaries({
      binding: accountBindingFixture,
      limit: 1,
    });

    expect(summary.total).toBe(3);
    expect(summary.truncated).toBe(true);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]).toEqual({
      runId: statusRun.id,
      planId: statusPlan.id,
      state: "running",
      startedAt: statusRun.startedAt,
      finishedAt: null,
      counts: {
        pending: 1,
        running: 1,
        succeeded: 1,
        skipped: 1,
        failed: 1,
        unresolved: 1,
      },
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.items)).toBe(true);
    expect(Object.isFrozen(summary.items[0]?.counts)).toBe(true);
    const full = context.repository.getIncompleteRunSummaries({
      binding: accountBindingFixture,
      limit: 10,
    });
    expect(full).toMatchObject({ total: 3, truncated: false });
    expect(full.items.map(({ runId }) => runId)).toEqual([
      statusRun.id,
      astral.run.id,
      privateUse.run.id,
    ]);
    expect(full.items.map(({ state }) => state)).toEqual([
      "running",
      "partial",
      "pending",
    ]);
    for (const limit of [0, 101]) {
      expect(
        errorCode(() =>
          context.repository.getIncompleteRunSummaries({
            binding: accountBindingFixture,
            limit,
          }),
        ),
      ).toBe("VALIDATION_ERROR");
    }
  });
});
