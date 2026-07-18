import { afterEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
import type {
  FinishRunOperationInput,
  LeaseGuard,
  ReconcileRunOperationInput,
} from "../../../src/app/ports/storage-port.js";
import { AppError } from "../../../src/domain/errors.js";
import { asRunId } from "../../../src/domain/ids.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  type ChangePlan,
  type PlanExecutableContent,
  type ResolvedOperation,
} from "../../../src/domain/plan.js";
import {
  parseChangeRun,
  parseRunOperation,
  type RunOperation,
} from "../../../src/domain/run.js";
import { PlanRunRepository } from "../../../src/storage/plan-run-repository.js";
import {
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
const START_1 = "2026-07-16T02:01:00.000Z";
const FINISH_1 = "2026-07-16T02:02:00.000Z";
const START_2 = "2026-07-16T02:03:00.000Z";
const FINISH_2 = "2026-07-16T02:04:00.000Z";
const OBSERVED_1 = "2026-07-16T02:05:00.000Z";
const OBSERVED_1B = "2026-07-16T02:05:30.000Z";
const OBSERVED_2 = "2026-07-16T02:06:00.000Z";
const OBSERVED_3 = "2026-07-16T02:07:00.000Z";

const retryableError = Object.freeze({
  code: "GITHUB_UNAVAILABLE" as const,
  message: "request was not applied",
  retryable: true,
  details: Object.freeze({}),
});

const unresolvedError = Object.freeze({
  code: "RECONCILIATION_REQUIRED" as const,
  message: "dispatch outcome is unknown",
  retryable: false,
  details: Object.freeze({}),
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

function twoOperationPlan(): ChangePlan {
  const first = {
    ...changePlanFixture.operations[0]!,
    operationId: "op_1",
  } as ResolvedOperation;
  const second = {
    ...changePlanFixture.operations[0]!,
    operationId: "op_2",
    dependsOn: ["op_1"],
  } as ResolvedOperation;
  const executable: PlanExecutableContent = {
    ...changePlanFixture.executable,
    operations: [first, second],
    dependencies: [{ operationId: "op_2", dependsOnOperationId: "op_1" }],
  };
  return parseChangePlan({
    ...changePlanFixture,
    hash: hashPlanExecutable(executable),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
  });
}

function openPlan(plan: ChangePlan = changePlanFixture): {
  readonly fixture: SqliteSnapshotFixture;
  readonly repository: PlanRunRepository;
} {
  const fixture = createSqliteSnapshotFixture();
  openDatabases.push(fixture.database);
  const batch = repositoryBatch();
  fixture.snapshots.createSnapshot({
    draft: snapshotDraft(plan.executable.snapshotId),
    lease: fixture.guard,
  });
  fixture.snapshots.appendSnapshotBatch({
    id: plan.executable.snapshotId,
    batch,
    lease: fixture.guard,
  });
  publishBatch(fixture, plan.executable.snapshotId, batch);
  const repository = new PlanRunRepository(fixture.database);
  repository.savePlan(plan);
  return { fixture, repository };
}

function beginRun(
  plan: ChangePlan = changePlanFixture,
  createOperations = true,
): {
  readonly fixture: SqliteSnapshotFixture;
  readonly repository: PlanRunRepository;
  readonly operations: readonly RunOperation[];
} {
  const context = openPlan(plan);
  context.repository.compareAndSetPlanState({
    planId: plan.id,
    expected: ["ready"],
    next: "applying",
  });
  context.repository.createRun({
    run: changeRunFixture,
    lease: context.fixture.guard,
  });
  context.repository.compareAndSetRunState({
    runId: changeRunFixture.id,
    expected: ["pending"],
    next: "running",
    finishedAt: null,
    lease: context.fixture.guard,
  });
  const operations = plan.operations.map((resolved, sequence) =>
    parseRunOperation({
      ...pendingOperationFixture,
      operationId: resolved.operationId,
      sequence,
      before: resolved.before,
    }),
  );
  if (createOperations) {
    for (const operation of operations) {
      context.repository.createRunOperation({
        operation,
        lease: context.fixture.guard,
      });
    }
  }
  return { ...context, operations };
}

function startFirst(
  context: ReturnType<typeof beginRun>,
  startedAt = START_1,
): RunOperation {
  return context.repository.startRunOperation({
    runId: changeRunFixture.id,
    operationId: context.operations[0]!.operationId,
    startedAt,
    lease: context.fixture.guard,
  });
}

function makeFirstUnresolved(
  context: ReturnType<typeof beginRun>,
): RunOperation {
  startFirst(context);
  return context.repository.finishRunOperation({
    phase: "after_dispatch",
    runId: changeRunFixture.id,
    operationId: "op_1",
    status: "unresolved",
    reconciliation: "unknown",
    externalRequestId: "request-unresolved",
    after: null,
    error: unresolvedError,
    finishedAt: FINISH_1,
    lease: context.fixture.guard,
  });
}

describe("PlanRunRepository run lifecycle", () => {
  test("creates immutable runs, CASes lifecycle, and rebinds a resumed run", () => {
    const { fixture, repository } = openPlan();
    expect(
      errorCode(() =>
        repository.createRun({
          run: changeRunFixture,
          lease: fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");

    repository.compareAndSetPlanState({
      planId: changePlanFixture.id,
      expected: ["ready"],
      next: "applying",
    });
    repository.createRun({ run: changeRunFixture, lease: fixture.guard });
    expect(repository.getRun(changeRunFixture.id)).toEqual(changeRunFixture);
    expect(repository.getLatestRunForPlan(changePlanFixture.id)).toEqual(
      changeRunFixture,
    );

    repository.compareAndSetRunState({
      runId: changeRunFixture.id,
      expected: ["pending"],
      next: "running",
      finishedAt: null,
      lease: fixture.guard,
    });
    repository.createRun({ run: changeRunFixture, lease: fixture.guard });
    expect(repository.getRun(changeRunFixture.id)?.state).toBe("running");

    const changed = parseChangeRun({
      ...changeRunFixture,
      warnings: ["different immutable warning"],
    });
    expect(
      errorCode(() =>
        repository.createRun({ run: changed, lease: fixture.guard }),
      ),
    ).toBe("PRECONDITION_FAILED");
    const other = parseChangeRun({
      ...changeRunFixture,
      id: asRunId("run_other"),
    });
    expect(
      errorCode(() =>
        repository.createRun({ run: other, lease: fixture.guard }),
      ),
    ).toBe("PRECONDITION_FAILED");

    const partial = repository.compareAndSetRunState({
      runId: changeRunFixture.id,
      expected: ["running"],
      next: "partial",
      finishedAt: FINISH_1,
      lease: fixture.guard,
    });
    expect(partial.state).toBe("partial");
    repository.createRun({ run: changeRunFixture, lease: fixture.guard });
    expect(repository.getRun(changeRunFixture.id)).toMatchObject({
      state: "partial",
      finishedAt: FINISH_1,
      warnings: changeRunFixture.warnings,
    });
    repository.compareAndSetPlanState({
      planId: changePlanFixture.id,
      expected: ["applying"],
      next: "partial",
    });
    fixture.leases.acquireLease({
      name: "apply:resumed",
      ownerId: "process-2",
      now: "2026-07-16T00:02:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    const resumedGuard: LeaseGuard = {
      name: "apply:resumed",
      ownerId: "process-2",
      now: "2026-07-16T00:03:00.000Z",
    };
    repository.compareAndSetPlanState({
      planId: changePlanFixture.id,
      expected: ["partial"],
      next: "applying",
    });
    const resumed = repository.compareAndSetRunState({
      runId: changeRunFixture.id,
      expected: ["partial"],
      next: "running",
      finishedAt: null,
      lease: resumedGuard,
    });
    expect(resumed.finishedAt).toBeNull();
    expect(resumed.warnings).toEqual(changeRunFixture.warnings);
    repository.createRun({ run: changeRunFixture, lease: resumedGuard });
    expect(repository.getRun(changeRunFixture.id)?.state).toBe("running");

    const operation = pendingOperationFixture;
    repository.createRunOperation({ operation, lease: resumedGuard });
    expect(
      errorCode(() =>
        repository.startRunOperation({
          runId: changeRunFixture.id,
          operationId: operation.operationId,
          startedAt: START_1,
          lease: fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    repository.createRunOperation({ operation, lease: resumedGuard });
    expect(
      repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: operation.operationId,
      })?.status,
    ).toBe("pending");
  });

  test("validates every run CAS edge before lookup and enforces finish times", () => {
    const context = beginRun(changePlanFixture, false);
    expect(
      errorCode(() =>
        context.repository.compareAndSetRunState({
          runId: asRunId("run_missing"),
          expected: ["running", "running"],
          next: "failed",
          finishedAt: FINISH_1,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(() =>
        context.repository.listRunOperationsPage({
          runId: changeRunFixture.id,
          afterSequence: null,
          pageSize: 0,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(() =>
        context.repository.compareAndSetRunState({
          runId: asRunId("run_missing"),
          expected: ["completed"],
          next: "running",
          finishedAt: null,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      errorCode(() =>
        context.repository.compareAndSetRunState({
          runId: asRunId("run_missing"),
          expected: ["running"],
          next: "failed",
          finishedAt: null,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      errorCode(() =>
        context.repository.compareAndSetRunState({
          runId: asRunId("run_missing"),
          expected: ["partial"],
          next: "running",
          finishedAt: FINISH_1,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      errorCode(() =>
        context.repository.compareAndSetRunState({
          runId: asRunId("run_missing"),
          expected: ["running"],
          next: "failed",
          finishedAt: FINISH_1,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      errorCode(() =>
        context.repository.compareAndSetRunState({
          runId: changeRunFixture.id,
          expected: ["pending"],
          next: "running",
          finishedAt: null,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      errorCode(() =>
        context.repository.compareAndSetRunState({
          runId: changeRunFixture.id,
          expected: ["running"],
          next: "completed",
          finishedAt: "2026-07-16T01:59:59.000Z",
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(context.repository.getRun(changeRunFixture.id)?.state).toBe(
      "running",
    );
  });
});

describe("PlanRunRepository operation and audit lifecycle", () => {
  test("creates exact initial projections and keeps duplicate creation idempotent", () => {
    const context = beginRun(changePlanFixture, false);
    const operation = pendingOperationFixture;
    context.repository.createRunOperation({
      operation,
      lease: context.fixture.guard,
    });
    expect(
      context.repository.getRunOperation({
        runId: operation.runId,
        operationId: operation.operationId,
      }),
    ).toEqual(operation);

    startFirst({ ...context, operations: [operation] });
    context.repository.createRunOperation({
      operation,
      lease: context.fixture.guard,
    });
    expect(
      context.repository.getRunOperation({
        runId: operation.runId,
        operationId: operation.operationId,
      })?.status,
    ).toBe("running");
    const finish: FinishRunOperationInput = {
      phase: "after_dispatch",
      runId: operation.runId,
      operationId: operation.operationId,
      status: "succeeded",
      reconciliation: "not_required",
      externalRequestId: "request-terminal",
      after: { starred: false },
      error: null,
      finishedAt: FINISH_1,
      lease: context.fixture.guard,
    };
    context.repository.finishRunOperation(finish);
    context.repository.createRunOperation({
      operation,
      lease: context.fixture.guard,
    });
    expect(
      context.repository.getRunOperation({
        runId: operation.runId,
        operationId: operation.operationId,
      })?.status,
    ).toBe("succeeded");
    expect(errorCode(() => context.repository.finishRunOperation(finish))).toBe(
      "PRECONDITION_FAILED",
    );

    const wrongSequence = parseRunOperation({
      ...operation,
      sequence: 1,
    });
    expect(
      errorCode(() =>
        context.repository.createRunOperation({
          operation: wrongSequence,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
  });

  test("starts projection before attempt and rolls both back if attempt insert fails", () => {
    const context = beginRun();
    context.fixture.database.exec(`
      CREATE TRIGGER fail_attempt_insert
      BEFORE INSERT ON run_operation_attempts
      BEGIN
        SELECT RAISE(ABORT,'forced-attempt-failure');
      END;
    `);

    expect(errorCode(() => startFirst(context))).toBe("STORAGE_ERROR");
    expect(
      context.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      }),
    ).toEqual(pendingOperationFixture);
    expect(
      context.repository.listRunOperationAttemptsPage({
        runId: changeRunFixture.id,
        operationId: "op_1",
        afterAttempt: null,
        pageSize: 10,
      }).items,
    ).toEqual([]);
  });

  test("finalizes attempts before projections and rolls both back on projection failure", () => {
    const context = beginRun();
    startFirst(context);
    context.fixture.database.exec(`
      CREATE TRIGGER fail_projection_finish
      BEFORE UPDATE ON run_operations
      WHEN NEW.status='succeeded'
      BEGIN
        SELECT RAISE(ABORT,'forced-projection-failure');
      END;
    `);
    const finish: FinishRunOperationInput = {
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "succeeded",
      reconciliation: "not_required",
      externalRequestId: "request-1",
      after: { starred: false },
      error: null,
      finishedAt: FINISH_1,
      lease: context.fixture.guard,
    };

    expect(errorCode(() => context.repository.finishRunOperation(finish))).toBe(
      "STORAGE_ERROR",
    );
    expect(
      context.repository.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: "op_1",
        attempt: 1,
      })?.status,
    ).toBe("running");
    expect(
      context.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      })?.status,
    ).toBe("running");
  });

  test("rejects stale start/finish times and unknown finish phases without writes", () => {
    const context = beginRun();
    context.fixture.leases.acquireLease({
      name: context.fixture.guard.name,
      ownerId: context.fixture.guard.ownerId,
      now: "2026-07-16T02:01:00.000Z",
      expiresAt: "2026-07-16T03:00:00.000Z",
    });
    const lateGuard: LeaseGuard = {
      ...context.fixture.guard,
      now: "2026-07-16T02:02:00.000Z",
    };
    expect(
      errorCode(() =>
        context.repository.startRunOperation({
          runId: changeRunFixture.id,
          operationId: "op_1",
          startedAt: START_1,
          lease: lateGuard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      context.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      })?.status,
    ).toBe("pending");

    context.repository.startRunOperation({
      runId: changeRunFixture.id,
      operationId: "op_1",
      startedAt: START_2,
      lease: lateGuard,
    });
    expect(
      errorCode(() =>
        (
          context.repository.finishRunOperation as (
            input: unknown,
          ) => RunOperation
        )({ phase: "unknown" }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(() =>
        context.repository.finishRunOperation({
          phase: "after_dispatch",
          runId: changeRunFixture.id,
          operationId: "op_1",
          status: "succeeded",
          reconciliation: "not_required",
          externalRequestId: null,
          after: { starred: false },
          error: null,
          finishedAt: FINISH_1,
          lease: lateGuard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      context.repository.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: "op_1",
        attempt: 1,
      })?.status,
    ).toBe("running");

    const pending = beginRun();
    pending.fixture.leases.acquireLease({
      name: pending.fixture.guard.name,
      ownerId: pending.fixture.guard.ownerId,
      now: "2026-07-16T02:01:00.000Z",
      expiresAt: "2026-07-16T03:00:00.000Z",
    });
    expect(
      errorCode(() =>
        pending.repository.finishRunOperation({
          phase: "before_dispatch",
          runId: changeRunFixture.id,
          operationId: "op_1",
          status: "skipped",
          reconciliation: "not_required",
          error: null,
          finishedAt: START_1,
          lease: {
            ...pending.fixture.guard,
            now: "2026-07-16T02:02:00.000Z",
          },
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      pending.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      })?.status,
    ).toBe("pending");
  });

  test("supports before-dispatch failure, retry, and skip without inventing attempts", () => {
    const context = beginRun();
    const failed = context.repository.finishRunOperation({
      phase: "before_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      error: retryableError,
      finishedAt: FINISH_1,
      lease: context.fixture.guard,
    });
    expect(failed.attempts).toBe(0);
    expect(
      context.repository.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: "op_1",
        attempt: 1,
      }),
    ).toBeNull();

    expect(
      context.repository.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
        maxAttempts: 1,
        lease: context.fixture.guard,
      }).status,
    ).toBe("pending");
    expect(
      context.repository.finishRunOperation({
        phase: "before_dispatch",
        runId: changeRunFixture.id,
        operationId: "op_1",
        status: "skipped",
        reconciliation: "not_required",
        error: null,
        finishedAt: FINISH_2,
        lease: context.fixture.guard,
      }).status,
    ).toBe("skipped");
    expect(
      context.repository.listRunOperationAttemptsPage({
        runId: changeRunFixture.id,
        operationId: "op_1",
        afterAttempt: null,
        pageSize: 10,
      }).total,
    ).toBe(0);
  });

  test("appends a guarded reconciliation event for a retryable failed attempt", () => {
    const context = beginRun();
    startFirst(context);
    context.repository.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      externalRequestId: null,
      after: { starred: true },
      error: retryableError,
      finishedAt: FINISH_1,
      lease: context.fixture.guard,
    });

    const reconciled = context.repository.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      after: { starred: true },
      observedAt: OBSERVED_1,
      error: retryableError,
      lease: context.fixture.guard,
    });
    expect(reconciled).toMatchObject({
      status: "failed",
      reconciliation: "confirmed_not_applied",
      attempts: 1,
      finishedAt: OBSERVED_1,
    });
    expect(
      context.repository.listRunOperationReconciliationsPage({
        runId: changeRunFixture.id,
        operationId: "op_1",
        afterEventSequence: null,
        pageSize: 10,
      }).items,
    ).toMatchObject([
      {
        attempt: 1,
        eventSequence: 1,
        status: "failed",
        reconciliation: "confirmed_not_applied",
        observedAt: OBSERVED_1,
      },
    ]);
    expect(
      context.repository.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
        maxAttempts: 2,
        lease: context.fixture.guard,
      }).status,
    ).toBe("pending");

    const zeroAttempt = beginRun();
    zeroAttempt.repository.finishRunOperation({
      phase: "before_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      error: retryableError,
      finishedAt: FINISH_1,
      lease: zeroAttempt.fixture.guard,
    });
    expect(
      errorCode(() =>
        zeroAttempt.repository.reconcileRunOperation({
          runId: changeRunFixture.id,
          operationId: "op_1",
          status: "failed",
          reconciliation: "confirmed_not_applied",
          after: { starred: true },
          observedAt: OBSERVED_1,
          error: retryableError,
          lease: zeroAttempt.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
  });

  test("preserves attempts, appends reconciliation history, and allows retry after confirmation", () => {
    const context = beginRun();
    startFirst(context);
    context.repository.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      externalRequestId: "request-1",
      after: { starred: true },
      error: retryableError,
      finishedAt: FINISH_1,
      lease: context.fixture.guard,
    });
    context.repository.retryRunOperation({
      runId: changeRunFixture.id,
      operationId: "op_1",
      maxAttempts: 2,
      lease: context.fixture.guard,
    });
    startFirst(context, START_2);
    context.repository.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "unresolved",
      reconciliation: "unknown",
      externalRequestId: "request-2",
      after: null,
      error: unresolvedError,
      finishedAt: FINISH_2,
      lease: context.fixture.guard,
    });
    expect(
      errorCode(() =>
        context.repository.retryRunOperation({
          runId: changeRunFixture.id,
          operationId: "op_1",
          maxAttempts: 3,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");

    const unknown: ReconcileRunOperationInput = {
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "unresolved",
      reconciliation: "unknown",
      after: null,
      observedAt: OBSERVED_1,
      error: unresolvedError,
      lease: context.fixture.guard,
    };
    expect(
      errorCode(() =>
        context.repository.reconcileRunOperation({
          ...unknown,
          observedAt: "2026-07-16T02:03:59.000Z",
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(context.repository.reconcileRunOperation(unknown).status).toBe(
      "unresolved",
    );
    expect(
      context.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      })?.finishedAt,
    ).toBe(OBSERVED_1);
    expect(
      errorCode(() =>
        context.repository.reconcileRunOperation({
          ...unknown,
          observedAt: "2026-07-16T02:04:59.000Z",
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      context.repository.reconcileRunOperation({
        ...unknown,
        observedAt: OBSERVED_1B,
      }).finishedAt,
    ).toBe(OBSERVED_1B);
    const confirmed: ReconcileRunOperationInput = {
      ...unknown,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      observedAt: OBSERVED_2,
      error: retryableError,
    };
    expect(context.repository.reconcileRunOperation(confirmed).status).toBe(
      "failed",
    );
    expect(
      context.repository.reconcileRunOperation({
        ...confirmed,
        observedAt: OBSERVED_3,
      }),
    ).toMatchObject({
      status: "failed",
      reconciliation: "confirmed_not_applied",
      attempts: 2,
      finishedAt: OBSERVED_3,
    });
    expect(
      context.repository.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: "op_1",
        attempt: 2,
      })?.finishedAt,
    ).toBe(FINISH_2);
    expect(
      context.repository
        .listRunOperationReconciliationsPage({
          runId: changeRunFixture.id,
          operationId: "op_1",
          afterEventSequence: null,
          pageSize: 10,
        })
        .items.map(({ eventSequence }) => eventSequence),
    ).toEqual([1, 2, 3, 4]);
    expect(
      errorCode(() =>
        context.repository.retryRunOperation({
          runId: changeRunFixture.id,
          operationId: "op_1",
          maxAttempts: 2,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      context.repository.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
        maxAttempts: 3,
        lease: context.fixture.guard,
      }).status,
    ).toBe("pending");
    context.repository.createRunOperation({
      operation: pendingOperationFixture,
      lease: context.fixture.guard,
    });
    expect(
      context.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      }),
    ).toMatchObject({ status: "pending", attempts: 2 });
  });

  test("reconciles confirmed applied with identical event/projection bytes", () => {
    const context = beginRun();
    makeFirstUnresolved(context);
    const succeeded = context.repository.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "succeeded",
      reconciliation: "confirmed_applied",
      after: { starred: false, evidence: "confirmed" },
      observedAt: OBSERVED_1,
      error: null,
      lease: context.fixture.guard,
    });
    expect(succeeded.status).toBe("succeeded");
    expect(
      context.repository.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: "op_1",
        attempt: 1,
      })?.finishedAt,
    ).toBe(FINISH_1);
    const bytes = context.fixture.database
      .prepare(
        `SELECT ro.after_json AS projection_after,
                ro.error_json AS projection_error,
                e.after_json AS event_after,
                e.error_json AS event_error
         FROM run_operations ro
         JOIN run_operation_reconciliations e
           ON e.run_id=ro.run_id AND e.operation_id=ro.operation_id
         WHERE ro.run_id=? AND ro.operation_id=?`,
      )
      .get(changeRunFixture.id, "op_1") as {
      readonly projection_after: string;
      readonly projection_error: string | null;
      readonly event_after: string;
      readonly event_error: string | null;
    };
    expect(bytes.projection_after).toBe(bytes.event_after);
    expect(bytes.projection_error).toBe(bytes.event_error);
  });

  test("requires the current unresolved attempt and rolls back event-first reconciliation", () => {
    const missing = beginRun();
    makeFirstUnresolved(missing);
    missing.fixture.database
      .prepare(
        `DELETE FROM run_operation_attempts
         WHERE run_id=? AND operation_id=? AND attempt=1`,
      )
      .run(changeRunFixture.id, "op_1");
    const input: ReconcileRunOperationInput = {
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      after: null,
      observedAt: OBSERVED_1,
      error: retryableError,
      lease: missing.fixture.guard,
    };
    expect(
      errorCode(() => missing.repository.reconcileRunOperation(input)),
    ).toBe("PRECONDITION_FAILED");
    expect(
      missing.repository.listRunOperationReconciliationsPage({
        runId: changeRunFixture.id,
        operationId: "op_1",
        afterEventSequence: null,
        pageSize: 10,
      }).total,
    ).toBe(0);
    expect(
      missing.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      })?.status,
    ).toBe("unresolved");

    const rollback = beginRun();
    makeFirstUnresolved(rollback);
    rollback.fixture.database.exec(`
      CREATE TRIGGER fail_reconciled_projection
      BEFORE UPDATE ON run_operations
      WHEN OLD.status='unresolved' AND NEW.status='failed'
      BEGIN
        SELECT RAISE(ABORT,'forced-reconciliation-projection-failure');
      END;
    `);
    expect(
      errorCode(() => rollback.repository.reconcileRunOperation(input)),
    ).toBe("STORAGE_ERROR");
    expect(
      rollback.repository.listRunOperationReconciliationsPage({
        runId: changeRunFixture.id,
        operationId: "op_1",
        afterEventSequence: null,
        pageSize: 10,
      }).total,
    ).toBe(0);
    expect(
      rollback.repository.getRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
      })?.status,
    ).toBe("unresolved");
  });

  test("enforces retry cap after a second confirmed-not-applied dispatch", () => {
    const context = beginRun();
    startFirst(context);
    const failedInput = {
      phase: "after_dispatch" as const,
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed" as const,
      reconciliation: "confirmed_not_applied" as const,
      externalRequestId: "request-retry",
      after: null,
      error: retryableError,
      finishedAt: FINISH_1,
      lease: context.fixture.guard,
    };
    context.repository.finishRunOperation(failedInput);
    context.repository.retryRunOperation({
      runId: changeRunFixture.id,
      operationId: "op_1",
      maxAttempts: 2,
      lease: context.fixture.guard,
    });
    startFirst(context, START_2);
    context.repository.finishRunOperation({
      ...failedInput,
      externalRequestId: "request-retry-2",
      finishedAt: FINISH_2,
    });
    expect(
      errorCode(() =>
        context.repository.retryRunOperation({
          runId: changeRunFixture.id,
          operationId: "op_1",
          maxAttempts: 2,
          lease: context.fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      context.repository.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: "op_1",
        maxAttempts: 3,
        lease: context.fixture.guard,
      }),
    ).toMatchObject({ status: "pending", attempts: 2 });
  });

  test("paginates immutable projections and append-only histories", () => {
    const context = beginRun(twoOperationPlan());
    const firstPage = context.repository.listRunOperationsPage({
      runId: changeRunFixture.id,
      afterSequence: null,
      pageSize: 1,
    });
    expect(firstPage.total).toBe(2);
    expect(firstPage.items.map(({ sequence }) => sequence)).toEqual([0]);
    expect(firstPage.nextSequence).toBe(0);
    const secondPage = context.repository.listRunOperationsPage({
      runId: changeRunFixture.id,
      afterSequence: firstPage.nextSequence,
      pageSize: 1,
    });
    expect(secondPage.items.map(({ sequence }) => sequence)).toEqual([1]);
    expect(secondPage.nextSequence).toBeNull();
    expect(Object.isFrozen(firstPage)).toBe(true);
    expect(Object.isFrozen(firstPage.items)).toBe(true);
    expect(
      errorCode(() =>
        context.repository.listRunOperationsPage({
          runId: changeRunFixture.id,
          afterSequence: 2,
          pageSize: 1,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(() =>
        context.repository.listRunOperationsPage({
          runId: changeRunFixture.id,
          afterSequence: null,
          pageSize: 101,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
  });

  test("paginates attempts and reconciliation events with exact totals and bounds", () => {
    const context = beginRun();
    startFirst(context);
    context.repository.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "failed",
      reconciliation: "confirmed_not_applied",
      externalRequestId: null,
      after: null,
      error: retryableError,
      finishedAt: FINISH_1,
      lease: context.fixture.guard,
    });
    context.repository.retryRunOperation({
      runId: changeRunFixture.id,
      operationId: "op_1",
      maxAttempts: 2,
      lease: context.fixture.guard,
    });
    startFirst(context, START_2);
    context.repository.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "unresolved",
      reconciliation: "unknown",
      externalRequestId: null,
      after: null,
      error: unresolvedError,
      finishedAt: FINISH_2,
      lease: context.fixture.guard,
    });
    const unknown: ReconcileRunOperationInput = {
      runId: changeRunFixture.id,
      operationId: "op_1",
      status: "unresolved",
      reconciliation: "unknown",
      after: null,
      observedAt: OBSERVED_1,
      error: unresolvedError,
      lease: context.fixture.guard,
    };
    context.repository.reconcileRunOperation(unknown);
    context.repository.reconcileRunOperation({
      ...unknown,
      observedAt: OBSERVED_1B,
    });

    const attemptOne = context.repository.listRunOperationAttemptsPage({
      runId: changeRunFixture.id,
      operationId: "op_1",
      afterAttempt: null,
      pageSize: 1,
    });
    expect(attemptOne).toMatchObject({ total: 2, nextAttempt: 1 });
    expect(attemptOne.items.map(({ attempt }) => attempt)).toEqual([1]);
    const attemptTwo = context.repository.listRunOperationAttemptsPage({
      runId: changeRunFixture.id,
      operationId: "op_1",
      afterAttempt: attemptOne.nextAttempt,
      pageSize: 1,
    });
    expect(attemptTwo).toMatchObject({ total: 2, nextAttempt: null });
    expect(attemptTwo.items.map(({ attempt }) => attempt)).toEqual([2]);
    expect(Object.isFrozen(attemptOne)).toBe(true);
    expect(Object.isFrozen(attemptOne.items)).toBe(true);
    expect(Object.isFrozen(attemptOne.items[0])).toBe(true);

    const eventOne = context.repository.listRunOperationReconciliationsPage({
      runId: changeRunFixture.id,
      operationId: "op_1",
      afterEventSequence: null,
      pageSize: 1,
    });
    expect(eventOne).toMatchObject({ total: 2, nextEventSequence: 1 });
    expect(eventOne.items.map(({ eventSequence }) => eventSequence)).toEqual([
      1,
    ]);
    const eventTwo = context.repository.listRunOperationReconciliationsPage({
      runId: changeRunFixture.id,
      operationId: "op_1",
      afterEventSequence: eventOne.nextEventSequence,
      pageSize: 1,
    });
    expect(eventTwo).toMatchObject({ total: 2, nextEventSequence: null });
    expect(eventTwo.items.map(({ eventSequence }) => eventSequence)).toEqual([
      2,
    ]);
    expect(Object.isFrozen(eventOne)).toBe(true);
    expect(Object.isFrozen(eventOne.items)).toBe(true);
    expect(Object.isFrozen(eventOne.items[0])).toBe(true);

    for (const pageSize of [0, 101]) {
      expect(
        errorCode(() =>
          context.repository.listRunOperationAttemptsPage({
            runId: changeRunFixture.id,
            operationId: "op_1",
            afterAttempt: null,
            pageSize,
          }),
        ),
      ).toBe("VALIDATION_ERROR");
      expect(
        errorCode(() =>
          context.repository.listRunOperationReconciliationsPage({
            runId: changeRunFixture.id,
            operationId: "op_1",
            afterEventSequence: null,
            pageSize,
          }),
        ),
      ).toBe("VALIDATION_ERROR");
    }
    expect(
      errorCode(() =>
        context.repository.listRunOperationAttemptsPage({
          runId: changeRunFixture.id,
          operationId: "op_1",
          afterAttempt: 3,
          pageSize: 1,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(() =>
        context.repository.listRunOperationReconciliationsPage({
          runId: changeRunFixture.id,
          operationId: "op_1",
          afterEventSequence: 3,
          pageSize: 1,
        }),
      ),
    ).toBe("VALIDATION_ERROR");

    const empty = beginRun();
    expect(
      errorCode(() =>
        empty.repository.listRunOperationAttemptsPage({
          runId: changeRunFixture.id,
          operationId: "op_1",
          afterAttempt: 0,
          pageSize: 1,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(() =>
        empty.repository.listRunOperationReconciliationsPage({
          runId: changeRunFixture.id,
          operationId: "op_1",
          afterEventSequence: 0,
          pageSize: 1,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
  });
});
