import { describe, expect, it, vi } from "vitest";
import type { StoragePort } from "../../../src/app/ports/storage-port.js";
import { InspectService } from "../../../src/app/services/inspect-service.js";
import { canonicalJson } from "../../../src/domain/canonical-json.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asPlanId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import type { JsonValue } from "../../../src/domain/json.js";
import {
  hashPlanExecutable,
  type ChangePlan,
  type ResolvedOperation,
} from "../../../src/domain/plan.js";
import type { AccountBinding } from "../../../src/domain/repository.js";
import type {
  ChangeRun,
  RunOperation,
  RunOperationAttempt,
  RunOperationReconciliation,
} from "../../../src/domain/run.js";

const CREATED_AT = "2026-07-16T00:00:00.000Z";
const EXPIRES_AT = "2026-07-17T00:00:00.000Z";
const FINISHED_AT = "2026-07-16T00:01:00.000Z";
const BINDING: AccountBinding = Object.freeze({
  host: "github.com",
  login: "fixture",
  accountId: "U_fixture",
});

function operationFixture(sequence: number): ResolvedOperation {
  return Object.freeze({
    operationId: `op_${String(sequence).padStart(6, "0")}`,
    kind: "list_create",
    clientRef: `ref_${String(sequence)}`,
    dependsOn: Object.freeze([]),
    preconditions: Object.freeze([]),
    before: Object.freeze({ listIds: Object.freeze([]) }),
    after: Object.freeze({
      name: `List ${String(sequence)}`,
      description: null,
      isPrivate: false,
    }),
    inverse: Object.freeze({ kind: "list_delete" }),
    risk: "normal",
  });
}

function planFixture(id = "plan_fixture", operationCount = 3): ChangePlan {
  const operations = Object.freeze(
    Array.from({ length: operationCount }, (_, index) =>
      operationFixture(index + 1),
    ),
  );
  const dependencies = Object.freeze([]);
  const executable = Object.freeze({
    schemaVersion: 1 as const,
    policyVersion: "1" as const,
    binding: BINDING,
    snapshotId: asSnapshotId("snap_fixture"),
    protectedRepositoryIds: Object.freeze([asRepositoryId("R_protected")]),
    protectedListIds: Object.freeze([asUserListId("UL_protected")]),
    operations,
    dependencies,
  });
  return Object.freeze({
    id: asPlanId(id),
    hash: hashPlanExecutable(executable),
    state: "ready",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    callerNote: "fixture",
    executable,
    operations,
    dependencies,
    warnings: Object.freeze(["review before apply"]),
  });
}

function runFixture(id = "run_fixture", planId = "plan_fixture"): ChangeRun {
  return Object.freeze({
    id: asRunId(id),
    planId: asPlanId(planId),
    binding: BINDING,
    state: "partial",
    failureMode: "continue",
    warnings: Object.freeze(["partial run"]),
    startedAt: CREATED_AT,
    finishedAt: FINISHED_AT,
  });
}

function runOperationFixture(
  runId: string,
  sequence: number,
  details: Readonly<Record<string, unknown>> = {},
): RunOperation {
  return Object.freeze({
    runId: asRunId(runId),
    operationId: `op_${String(sequence).padStart(6, "0")}`,
    sequence,
    status: "failed",
    reconciliation: "confirmed_not_applied",
    attempts: 0,
    before: Object.freeze({ starred: true }),
    after: null,
    externalRequestId: null,
    error: Object.freeze({
      code: "PRECONDITION_FAILED",
      message: "Operation was not dispatched",
      retryable: true,
      details,
    }),
    startedAt: null,
    finishedAt: FINISHED_AT,
  }) as RunOperation;
}

function attemptFixture(
  runId: string,
  operationId: string,
  attempt: number,
  details: Readonly<Record<string, JsonValue>> = {},
): RunOperationAttempt {
  return Object.freeze({
    runId: asRunId(runId),
    operationId,
    attempt,
    before: Object.freeze({ starred: true }),
    startedAt: CREATED_AT,
    status: "failed",
    reconciliation: "confirmed_not_applied",
    after: null,
    externalRequestId: null,
    error: Object.freeze({
      code: "PRECONDITION_FAILED",
      message: "Attempt did not apply",
      retryable: true,
      details,
    }),
    finishedAt: FINISHED_AT,
  });
}

function reconciliationFixture(
  runId: string,
  operationId: string,
  eventSequence: number,
  details: Readonly<Record<string, JsonValue>> = {},
): RunOperationReconciliation {
  return Object.freeze({
    runId: asRunId(runId),
    operationId,
    attempt: 1,
    eventSequence,
    after: null,
    observedAt: FINISHED_AT,
    status: "failed",
    reconciliation: "confirmed_not_applied",
    error: Object.freeze({
      code: "PRECONDITION_FAILED",
      message: "Reconciliation confirmed no mutation",
      retryable: true,
      details,
    }),
  });
}

type InspectStorage = Pick<
  StoragePort,
  | "getPlan"
  | "getRun"
  | "listRunOperationsPage"
  | "listRunOperationAttemptsPage"
  | "listRunOperationReconciliationsPage"
>;

function storageFixture(input?: {
  readonly plans?: readonly ChangePlan[];
  readonly runs?: readonly ChangeRun[];
  readonly runOperations?: Readonly<Record<string, readonly RunOperation[]>>;
  readonly attempts?: Readonly<Record<string, readonly RunOperationAttempt[]>>;
  readonly reconciliations?: Readonly<
    Record<string, readonly RunOperationReconciliation[]>
  >;
}) {
  const plans = new Map(
    (input?.plans ?? []).map((plan) => [String(plan.id), plan]),
  );
  const runs = new Map((input?.runs ?? []).map((run) => [String(run.id), run]));
  const runOperations = input?.runOperations ?? {};
  const listRunOperationsPage = vi.fn(
    (request: {
      readonly runId: ReturnType<typeof asRunId>;
      readonly afterSequence: number | null;
      readonly pageSize: number;
    }) => {
      const items = runOperations[String(request.runId)] ?? [];
      const start =
        request.afterSequence === null
          ? 0
          : items.findIndex(
              ({ sequence }) => sequence > request.afterSequence!,
            );
      const normalizedStart = start < 0 ? items.length : start;
      const page = items.slice(
        normalizedStart,
        normalizedStart + request.pageSize,
      );
      const last = page.at(-1);
      return Object.freeze({
        items: Object.freeze(page),
        total: items.length,
        nextSequence:
          last !== undefined &&
          items.some(({ sequence }) => sequence > last.sequence)
            ? last.sequence
            : null,
      });
    },
  );
  const historyKey = (runId: string, operationId: string) =>
    `${runId}\u0000${operationId}`;
  const listRunOperationAttemptsPage = vi.fn(
    (request: {
      readonly runId: ReturnType<typeof asRunId>;
      readonly operationId: string;
      readonly afterAttempt: number | null;
      readonly pageSize: number;
    }) => {
      const items =
        input?.attempts?.[
          historyKey(String(request.runId), request.operationId)
        ] ?? [];
      const page = items
        .filter(
          ({ attempt }) =>
            request.afterAttempt === null || attempt > request.afterAttempt,
        )
        .slice(0, request.pageSize);
      const last = page.at(-1);
      return Object.freeze({
        items: Object.freeze(page),
        total: items.length,
        nextAttempt:
          last !== undefined &&
          items.some(({ attempt }) => attempt > last.attempt)
            ? last.attempt
            : null,
      });
    },
  );
  const listRunOperationReconciliationsPage = vi.fn(
    (request: {
      readonly runId: ReturnType<typeof asRunId>;
      readonly operationId: string;
      readonly afterEventSequence: number | null;
      readonly pageSize: number;
    }) => {
      const items =
        input?.reconciliations?.[
          historyKey(String(request.runId), request.operationId)
        ] ?? [];
      const page = items
        .filter(
          ({ eventSequence }) =>
            request.afterEventSequence === null ||
            eventSequence > request.afterEventSequence,
        )
        .slice(0, request.pageSize);
      const last = page.at(-1);
      return Object.freeze({
        items: Object.freeze(page),
        total: items.length,
        nextEventSequence:
          last !== undefined &&
          items.some(({ eventSequence }) => eventSequence > last.eventSequence)
            ? last.eventSequence
            : null,
      });
    },
  );
  const storage: InspectStorage = {
    getPlan: (id) => plans.get(String(id)) ?? null,
    getRun: (id) => runs.get(String(id)) ?? null,
    listRunOperationsPage,
    listRunOperationAttemptsPage,
    listRunOperationReconciliationsPage,
  };
  return {
    storage,
    listRunOperationsPage,
    listRunOperationAttemptsPage,
    listRunOperationReconciliationsPage,
  };
}

function cursor(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function cursorFromText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function cursorPayload(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function cursorText(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

describe("InspectService", () => {
  it("pages plan operations in stable one-based order with a target-bound cursor", async () => {
    const plan = planFixture("plan_many", 120);
    const { storage } = storageFixture({ plans: [plan] });
    const service = new InspectService(storage);

    const first = await service.inspect({ kind: "plan", id: "plan_many" });
    expect(first).toMatchObject({
      kind: "plan",
      total: 120,
      plan: {
        id: "plan_many",
        hash: plan.hash,
        operationCount: 120,
        dependencyCount: 0,
      },
    });
    expect(first.operations).toHaveLength(50);
    expect(first.operations.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(first.nextCursor).not.toBeNull();
    expect(cursorPayload(first.nextCursor!)).toEqual({
      version: 1,
      kind: "plan",
      targetId: "plan_many",
      afterSequence: 50,
    });

    const second = await service.inspect({
      kind: "plan",
      id: "plan_many",
      cursor: first.nextCursor,
    });
    const third = await service.inspect({
      kind: "plan",
      id: "plan_many",
      cursor: second.nextCursor,
    });
    expect(second.operations).toHaveLength(50);
    expect(third.operations).toHaveLength(20);
    expect(third.nextCursor).toBeNull();
    const sequences = [
      ...first.operations,
      ...second.operations,
      ...third.operations,
    ].map(({ sequence }) => sequence);
    expect(new Set(sequences).size).toBe(120);
    expect(sequences).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );
  });

  it("passes only a validated run sequence and bounded page size to storage", async () => {
    const run = runFixture("run_page");
    const operations = Object.freeze([
      runOperationFixture("run_page", 0),
      runOperationFixture("run_page", 1),
      runOperationFixture("run_page", 2),
    ]);
    const { storage, listRunOperationsPage } = storageFixture({
      runs: [run],
      runOperations: { run_page: operations },
    });
    const service = new InspectService(storage);

    const first = await service.inspect({
      kind: "run",
      id: "run_page",
      limit: 2,
    });
    expect(first).toMatchObject({
      kind: "run",
      run: { id: "run_page", planId: "plan_fixture" },
      total: 3,
      operations: [{ sequence: 0 }, { sequence: 1 }],
    });
    expect(listRunOperationsPage).toHaveBeenNthCalledWith(1, {
      runId: "run_page",
      afterSequence: null,
      pageSize: 2,
    });
    expect(cursorPayload(first.nextCursor!)).toEqual({
      version: 1,
      kind: "run",
      targetId: "run_page",
      afterSequence: 1,
    });

    const final = await service.inspect({
      kind: "run",
      id: "run_page",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(final.operations).toEqual([
      expect.objectContaining({ sequence: 2 }),
    ]);
    expect(final.nextCursor).toBeNull();
    expect(listRunOperationsPage).toHaveBeenNthCalledWith(2, {
      runId: "run_page",
      afterSequence: 1,
      pageSize: 2,
    });
    expect(first).not.toHaveProperty("attempts");
    expect(first).not.toHaveProperty("reconciliations");
  });

  it("encodes inspect cursors as canonical JSON", async () => {
    const run = runFixture("run_canonical_cursor");
    const operations = Object.freeze([
      runOperationFixture("run_canonical_cursor", 0),
      runOperationFixture("run_canonical_cursor", 1),
    ]);
    const { storage } = storageFixture({
      runs: [run],
      runOperations: { run_canonical_cursor: operations },
    });

    const result = await new InspectService(storage).inspect({
      kind: "run",
      id: "run_canonical_cursor",
      limit: 1,
    });

    expect(result.nextCursor).not.toBeNull();
    expect(cursorText(result.nextCursor!)).toBe(
      canonicalJson({
        version: 1,
        kind: "run",
        targetId: "run_canonical_cursor",
        afterSequence: 0,
      }),
    );
  });

  it("pages attempts with a run-and-operation-bound cursor", async () => {
    const run = runFixture("run_attempts");
    const operationId = "op_attempts";
    const attempts = Object.freeze([
      attemptFixture("run_attempts", operationId, 1),
      attemptFixture("run_attempts", operationId, 2),
      attemptFixture("run_attempts", operationId, 3),
    ]);
    const {
      storage,
      listRunOperationAttemptsPage,
      listRunOperationReconciliationsPage,
    } = storageFixture({
      runs: [run],
      attempts: {
        [`run_attempts\u0000${operationId}`]: attempts,
      },
    });
    const service = new InspectService(storage);

    const first = await service.inspect({
      kind: "attempts",
      id: asRunId("run_attempts"),
      operationId,
      limit: 2,
    });
    expect(first.kind).toBe("attempts");
    if (first.kind !== "attempts")
      throw new Error("unexpected inspection kind");
    expect(first).toMatchObject({
      kind: "attempts",
      run: { id: "run_attempts" },
      operationId,
      total: 3,
      attempts: [{ attempt: 1 }, { attempt: 2 }],
    });
    expect(cursorPayload(first.nextCursor!)).toEqual({
      version: 1,
      kind: "attempts",
      runId: "run_attempts",
      operationId,
      afterAttempt: 2,
    });
    expect(listRunOperationAttemptsPage).toHaveBeenNthCalledWith(1, {
      runId: "run_attempts",
      operationId,
      afterAttempt: null,
      pageSize: 2,
    });

    const final = await service.inspect({
      kind: "attempts",
      id: asRunId("run_attempts"),
      operationId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(final.kind).toBe("attempts");
    if (final.kind !== "attempts")
      throw new Error("unexpected inspection kind");
    expect(final.attempts).toEqual([expect.objectContaining({ attempt: 3 })]);
    expect(final.nextCursor).toBeNull();
    expect(listRunOperationAttemptsPage).toHaveBeenNthCalledWith(2, {
      runId: "run_attempts",
      operationId,
      afterAttempt: 2,
      pageSize: 2,
    });
    expect(listRunOperationReconciliationsPage).not.toHaveBeenCalled();
  });

  it("pages reconciliations with a run-and-operation-bound cursor", async () => {
    const run = runFixture("run_reconciliations");
    const operationId = "op_reconciliations";
    const reconciliations = Object.freeze([
      reconciliationFixture("run_reconciliations", operationId, 1),
      reconciliationFixture("run_reconciliations", operationId, 2),
      reconciliationFixture("run_reconciliations", operationId, 3),
    ]);
    const {
      storage,
      listRunOperationAttemptsPage,
      listRunOperationReconciliationsPage,
    } = storageFixture({
      runs: [run],
      reconciliations: {
        [`run_reconciliations\u0000${operationId}`]: reconciliations,
      },
    });
    const service = new InspectService(storage);

    const first = await service.inspect({
      kind: "reconciliations",
      id: asRunId("run_reconciliations"),
      operationId,
      limit: 2,
    });
    expect(first.kind).toBe("reconciliations");
    if (first.kind !== "reconciliations") {
      throw new Error("unexpected inspection kind");
    }
    expect(first).toMatchObject({
      kind: "reconciliations",
      run: { id: "run_reconciliations" },
      operationId,
      total: 3,
      reconciliations: [{ eventSequence: 1 }, { eventSequence: 2 }],
    });
    expect(cursorPayload(first.nextCursor!)).toEqual({
      version: 1,
      kind: "reconciliations",
      runId: "run_reconciliations",
      operationId,
      afterEventSequence: 2,
    });
    expect(listRunOperationReconciliationsPage).toHaveBeenNthCalledWith(1, {
      runId: "run_reconciliations",
      operationId,
      afterEventSequence: null,
      pageSize: 2,
    });

    const final = await service.inspect({
      kind: "reconciliations",
      id: asRunId("run_reconciliations"),
      operationId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(final.kind).toBe("reconciliations");
    if (final.kind !== "reconciliations") {
      throw new Error("unexpected inspection kind");
    }
    expect(final.reconciliations).toEqual([
      expect.objectContaining({ eventSequence: 3 }),
    ]);
    expect(final.nextCursor).toBeNull();
    expect(listRunOperationReconciliationsPage).toHaveBeenNthCalledWith(2, {
      runId: "run_reconciliations",
      operationId,
      afterEventSequence: 2,
      pageSize: 2,
    });
    expect(listRunOperationAttemptsPage).not.toHaveBeenCalled();
  });

  it("rejects malformed, cross-target, and out-of-range cursors before paging", async () => {
    const plan = planFixture("plan_cursor", 3);
    const otherPlan = planFixture("plan_other", 3);
    const run = runFixture("run_cursor", "plan_cursor");
    const { storage, listRunOperationsPage } = storageFixture({
      plans: [plan, otherPlan],
      runs: [run],
      runOperations: {
        run_cursor: Object.freeze([
          runOperationFixture("run_cursor", 0),
          runOperationFixture("run_cursor", 1),
        ]),
      },
    });
    const service = new InspectService(storage);
    const validPlanCursor = cursor({
      version: 1,
      kind: "plan",
      targetId: "plan_cursor",
      afterSequence: 1,
    });
    const invalid = [
      "",
      "not+base64",
      "A",
      Buffer.from([0xff]).toString("base64url"),
      Buffer.from("{", "utf8").toString("base64url"),
      cursor("not an object"),
      cursor({
        version: 2,
        kind: "plan",
        targetId: "plan_cursor",
        afterSequence: 1,
      }),
      cursor({
        version: 1,
        kind: "plan",
        targetId: "plan_cursor",
        afterSequence: -1,
      }),
      cursor({
        version: 1,
        kind: "plan",
        targetId: "plan_cursor",
        afterSequence: 4,
      }),
      cursor({
        version: 1,
        kind: "run",
        targetId: "run_cursor",
        afterSequence: 0,
      }),
    ];
    for (const invalidCursor of invalid) {
      await expect(
        service.inspect({
          kind: "plan",
          id: "plan_cursor",
          cursor: invalidCursor,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(
      service.inspect({
        kind: "plan",
        id: "plan_other",
        cursor: validPlanCursor,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.inspect({
        kind: "run",
        id: "run_cursor",
        cursor: cursor({
          version: 1,
          kind: "run",
          targetId: "run_cursor",
          afterSequence: 2,
        }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(listRunOperationsPage).toHaveBeenCalledTimes(1);
    expect(listRunOperationsPage).toHaveBeenCalledWith({
      runId: "run_cursor",
      afterSequence: 2,
      pageSize: 50,
    });
  });

  it("rejects every non-canonical cursor JSON encoding before storage", async () => {
    const run = runFixture("run_noncanonical_cursor");
    const base = storageFixture({ runs: [run] });
    const getRun = vi.fn(base.storage.getRun);
    const service = new InspectService({
      ...base.storage,
      getRun,
    });
    const canonical = canonicalJson({
      version: 1,
      kind: "run",
      targetId: "run_noncanonical_cursor",
      afterSequence: 0,
    });
    const nonCanonical = [
      ` ${canonical}`,
      `${canonical} `,
      '{"version":1,"kind":"run","targetId":"run_noncanonical_cursor","afterSequence":0}',
      '{"afterSequence":0,"afterSequence":0,"kind":"run","targetId":"run_noncanonical_cursor","version":1}',
      '{"afterSequence":-0,"kind":"run","targetId":"run_noncanonical_cursor","version":1}',
      '{"afterSequence":0e0,"kind":"run","targetId":"run_noncanonical_cursor","version":1}',
      '{"afterSequence":0,"kind":"\\u0072un","targetId":"run_noncanonical_cursor","version":1}',
    ];

    for (const text of nonCanonical) {
      await expect(
        service.inspect({
          kind: "run",
          id: "run_noncanonical_cursor",
          cursor: cursorFromText(text),
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Inspection cursor is invalid",
      });
    }
    expect(getRun).not.toHaveBeenCalled();
    expect(base.listRunOperationsPage).not.toHaveBeenCalled();
  });

  it("binds history cursors to the exact kind, run, and operation before storage", async () => {
    const run = runFixture("run_history_cursor");
    const {
      storage,
      listRunOperationAttemptsPage,
      listRunOperationReconciliationsPage,
    } = storageFixture({ runs: [run] });
    const service = new InspectService(storage);
    const attemptCursor = cursor({
      version: 1,
      kind: "attempts",
      runId: "run_history_cursor",
      operationId: "op_a",
      afterAttempt: 1,
    });
    const reconciliationCursor = cursor({
      version: 1,
      kind: "reconciliations",
      runId: "run_history_cursor",
      operationId: "op_a",
      afterEventSequence: 1,
    });
    const invalidInputs = [
      {
        kind: "attempts",
        id: asRunId("run_history_cursor"),
        operationId: "op_b",
        cursor: attemptCursor,
      },
      {
        kind: "attempts",
        id: asRunId("run_other"),
        operationId: "op_a",
        cursor: attemptCursor,
      },
      {
        kind: "reconciliations",
        id: asRunId("run_history_cursor"),
        operationId: "op_a",
        cursor: attemptCursor,
      },
      {
        kind: "attempts",
        id: asRunId("run_history_cursor"),
        operationId: "op_a",
        cursor: reconciliationCursor,
      },
      {
        kind: "attempts",
        id: asRunId("run_history_cursor"),
        operationId: "op_a",
        cursor: cursor({
          version: 1,
          kind: "attempts",
          runId: "run_history_cursor",
          operationId: "op_a",
          afterAttempt: 1,
          extra: true,
        }),
      },
    ] as const;

    for (const input of invalidInputs) {
      await expect(service.inspect(input)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    expect(listRunOperationAttemptsPage).not.toHaveBeenCalled();
    expect(listRunOperationReconciliationsPage).not.toHaveBeenCalled();
  });

  it("maps real storage boundary rejection for forged cursors to fixed validation errors", async () => {
    const run = runFixture("run_storage_boundary");
    const rawMessage = "raw storage boundary secret";
    const base = storageFixture({ runs: [run] }).storage;
    const storage: InspectStorage = {
      ...base,
      listRunOperationsPage: () => {
        throw new AppError("VALIDATION_ERROR", rawMessage);
      },
      listRunOperationAttemptsPage: () => {
        throw new AppError("VALIDATION_ERROR", rawMessage);
      },
      listRunOperationReconciliationsPage: () => {
        throw new AppError("VALIDATION_ERROR", rawMessage);
      },
    };
    const service = new InspectService(storage);
    const inputs = [
      {
        kind: "run",
        id: "run_storage_boundary",
        cursor: cursor({
          version: 1,
          kind: "run",
          targetId: "run_storage_boundary",
          afterSequence: 99,
        }),
      },
      {
        kind: "attempts",
        id: asRunId("run_storage_boundary"),
        operationId: "op_boundary",
        cursor: cursor({
          version: 1,
          kind: "attempts",
          runId: "run_storage_boundary",
          operationId: "op_boundary",
          afterAttempt: 99,
        }),
      },
      {
        kind: "reconciliations",
        id: asRunId("run_storage_boundary"),
        operationId: "op_boundary",
        cursor: cursor({
          version: 1,
          kind: "reconciliations",
          runId: "run_storage_boundary",
          operationId: "op_boundary",
          afterEventSequence: 99,
        }),
      },
    ] as const;

    for (const input of inputs) {
      await expect(service.inspect(input)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Inspection cursor sequence exceeds its target",
      });
      await expect(service.inspect(input)).rejects.not.toMatchObject({
        message: rawMessage,
      });
    }
  });

  it("accepts an exact-end cursor as an empty final page", async () => {
    const plan = planFixture("plan_end", 3);
    const run = runFixture("run_end", "plan_end");
    const operations = Object.freeze([
      runOperationFixture("run_end", 0),
      runOperationFixture("run_end", 1),
      runOperationFixture("run_end", 2),
    ]);
    const { storage } = storageFixture({
      plans: [plan],
      runs: [run],
      runOperations: { run_end: operations },
    });
    const service = new InspectService(storage);

    const planFinal = await service.inspect({
      kind: "plan",
      id: "plan_end",
      cursor: cursor({
        version: 1,
        kind: "plan",
        targetId: "plan_end",
        afterSequence: 3,
      }),
    });
    expect(planFinal.operations).toEqual([]);
    expect(planFinal.nextCursor).toBeNull();

    const runFinal = await service.inspect({
      kind: "run",
      id: "run_end",
      cursor: cursor({
        version: 1,
        kind: "run",
        targetId: "run_end",
        afterSequence: 2,
      }),
    });
    expect(runFinal.operations).toEqual([]);
    expect(runFinal.nextCursor).toBeNull();
  });

  it("rejects a cursor for a target with no sequence", async () => {
    const plan = planFixture("plan_empty", 0);
    const run = runFixture("run_empty", "plan_empty");
    const {
      storage,
      listRunOperationAttemptsPage,
      listRunOperationReconciliationsPage,
    } = storageFixture({
      plans: [plan],
      runs: [run],
      runOperations: { run_empty: Object.freeze([]) },
    });
    const service = new InspectService(storage);

    await expect(
      service.inspect({
        kind: "plan",
        id: "plan_empty",
        cursor: cursor({
          version: 1,
          kind: "plan",
          targetId: "plan_empty",
          afterSequence: 0,
        }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.inspect({
        kind: "run",
        id: "run_empty",
        cursor: cursor({
          version: 1,
          kind: "run",
          targetId: "run_empty",
          afterSequence: 0,
        }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.inspect({
        kind: "attempts",
        id: asRunId("run_empty"),
        operationId: "op_empty",
        cursor: cursor({
          version: 1,
          kind: "attempts",
          runId: "run_empty",
          operationId: "op_empty",
          afterAttempt: 0,
        }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.inspect({
        kind: "reconciliations",
        id: asRunId("run_empty"),
        operationId: "op_empty",
        cursor: cursor({
          version: 1,
          kind: "reconciliations",
          runId: "run_empty",
          operationId: "op_empty",
          afterEventSequence: 0,
        }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(listRunOperationAttemptsPage).toHaveBeenCalledTimes(1);
    expect(listRunOperationReconciliationsPage).toHaveBeenCalledTimes(1);
  });

  it("recursively redacts the complete presentation object", async () => {
    const secret = "arbitrary-secret-value";
    const run = runFixture("run_redaction");
    const operation = runOperationFixture("run_redaction", 0, {
      headers: { authorization: `Bearer ${secret}` },
      url: { access_token: secret },
      description: { password: secret },
      nested: { cookie: secret },
    });
    const { storage } = storageFixture({
      runs: [run],
      runOperations: { run_redaction: Object.freeze([operation]) },
    });
    const result = await new InspectService(storage).inspect({
      kind: "run",
      id: "run_redaction",
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.operations[0]).toMatchObject({
      error: {
        details: {
          headers: { authorization: "[REDACTED]" },
          url: { access_token: "[REDACTED]" },
          description: { password: "[REDACTED]" },
          nested: { cookie: "[REDACTED]" },
        },
      },
    });
    expect(operation.error?.details).toMatchObject({
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.operations)).toBe(true);
  });

  it("removes GitHub tokens and Bearer credentials from every audit presentation string and key", async () => {
    const githubToken = `ghp_${"A".repeat(36)}`;
    const bearerCredential = "opaque-bearer-credential-value";
    const runId = "run_credential_redaction";
    const operationId = "op_credential_redaction";
    const details = (marker: string) =>
      Object.freeze({
        queryUrl: `https://github.com/octocat/tool?access_token=${githubToken}&marker=${marker}`,
        userinfoUrl: `https://octocat:${githubToken}@github.com/octocat/tool`,
        message: `GitHub rejected ${githubToken}`,
        description: `remote response used Bearer ${bearerCredential}`,
        [`field-${githubToken}`]: "credential-bearing object key",
        nested: Object.freeze({
          arbitrary: githubToken,
          bearer: `Bearer ${bearerCredential}`,
        }),
        headers: Object.freeze({
          authorization: `Bearer ${githubToken}`,
        }),
      });
    const run = Object.freeze({
      ...runFixture(runId),
      warnings: Object.freeze([`run message ${githubToken}`]),
    }) as ChangeRun;
    const operation = runOperationFixture(runId, 0, details("run"));
    const attempt = attemptFixture(runId, operationId, 1, details("attempt"));
    const reconciliation = reconciliationFixture(
      runId,
      operationId,
      1,
      details("reconciliation"),
    );
    const { storage } = storageFixture({
      runs: [run],
      runOperations: { [runId]: Object.freeze([operation]) },
      attempts: {
        [`${runId}\u0000${operationId}`]: Object.freeze([attempt]),
      },
      reconciliations: {
        [`${runId}\u0000${operationId}`]: Object.freeze([reconciliation]),
      },
    });
    const service = new InspectService(storage);

    const results = [
      await service.inspect({ kind: "run", id: runId }),
      await service.inspect({
        kind: "attempts",
        id: asRunId(runId),
        operationId,
      }),
      await service.inspect({
        kind: "reconciliations",
        id: asRunId(runId),
        operationId,
      }),
    ];

    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain(githubToken);
      expect(serialized).not.toContain(bearerCredential);
    }
  });

  it("fully consumes glued GitHub tokens and Bearer credentials longer than 4,096 characters", async () => {
    const classicToken = `ghp_${"A".repeat(36)}`;
    const fineGrainedToken = `github_pat_${"B".repeat(82)}`;
    const longBearerCredential = "C".repeat(5_000);
    const runId = "run_complete_credential_redaction";
    const operationId = "op_complete_credential_redaction";
    const details = (marker: string) =>
      Object.freeze({
        queryUrl: `https://github.com/octocat/tool?token=queryPrefix${fineGrainedToken}querySuffix&marker=${marker}`,
        userinfoUrl: `https://userPrefix${classicToken}userinfoSuffix@github.com/octocat/tool`,
        message: `messagePrefix${classicToken}messageSuffix`,
        description: `remote response used Bearer ${longBearerCredential}`,
        [`keyPrefix${fineGrainedToken}keySuffix`]:
          "credential-bearing object key",
        nested: Object.freeze({
          arbitrary: `nestedPrefix${fineGrainedToken}nestedSuffix`,
          bearer: `Bearer ${longBearerCredential}`,
        }),
        headers: Object.freeze({
          authorization: `Bearer ${longBearerCredential}`,
        }),
      });
    const run = Object.freeze({
      ...runFixture(runId),
      warnings: Object.freeze([
        `warningPrefix${classicToken}warningSuffix`,
        `warningPrefix${fineGrainedToken}warningSuffix`,
      ]),
    }) as ChangeRun;
    const operation = runOperationFixture(runId, 0, details("run"));
    const attempt = attemptFixture(runId, operationId, 1, details("attempt"));
    const reconciliation = reconciliationFixture(
      runId,
      operationId,
      1,
      details("reconciliation"),
    );
    const { storage } = storageFixture({
      runs: [run],
      runOperations: { [runId]: Object.freeze([operation]) },
      attempts: {
        [`${runId}\u0000${operationId}`]: Object.freeze([attempt]),
      },
      reconciliations: {
        [`${runId}\u0000${operationId}`]: Object.freeze([reconciliation]),
      },
    });
    const service = new InspectService(storage);

    const results = [
      await service.inspect({ kind: "run", id: runId }),
      await service.inspect({
        kind: "attempts",
        id: asRunId(runId),
        operationId,
      }),
      await service.inspect({
        kind: "reconciliations",
        id: asRunId(runId),
        operationId,
      }),
    ];

    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain("ghp_");
      expect(serialized).not.toContain("github_pat_");
      expect(serialized).not.toContain(classicToken);
      expect(serialized).not.toContain(fineGrainedToken);
      expect(serialized).not.toContain("C".repeat(128));
      expect(serialized).not.toContain(longBearerCredential);
    }
  });

  it("redacts, detaches, and deeply freezes history presentations", async () => {
    const secret = "history-presentation-secret";
    const details = {
      headers: { authorization: `Bearer ${secret}` },
      nested: { access_token: secret },
    };
    const run = runFixture("run_history_redaction");
    const operationId = "op_history_redaction";
    const attempt = attemptFixture(
      "run_history_redaction",
      operationId,
      1,
      details,
    );
    const { storage } = storageFixture({
      runs: [run],
      attempts: {
        [`run_history_redaction\u0000${operationId}`]: Object.freeze([attempt]),
      },
    });

    const result = await new InspectService(storage).inspect({
      kind: "attempts",
      id: asRunId("run_history_redaction"),
      operationId,
    });
    expect(result.kind).toBe("attempts");
    if (result.kind !== "attempts") {
      throw new Error("unexpected inspection kind");
    }
    details.headers.authorization = "changed after inspection";
    details.nested.access_token = "changed after inspection";

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.attempts[0]).toMatchObject({
      error: {
        details: {
          headers: { authorization: "[REDACTED]" },
          nested: { access_token: "[REDACTED]" },
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attempts)).toBe(true);
    expect(Object.isFrozen(result.attempts[0]?.error?.details)).toBe(true);
  });

  it.each([
    [{ kind: "plan", id: "plan_bounds", limit: 0 }],
    [{ kind: "plan", id: "plan_bounds", limit: 101 }],
    [{ kind: "plan", id: " plan_bounds" }],
    [{ kind: "unknown", id: "plan_bounds" }],
    [{ kind: "plan", id: "plan_bounds", extra: true }],
    [{ kind: "attempts", id: "run_bounds" }],
    [{ kind: "attempts", id: "run_bounds", operationId: "" }],
    [
      {
        kind: "reconciliations",
        id: "run_bounds",
        operationId: " op_bounds",
      },
    ],
  ])("rejects invalid input before storage access", async (input) => {
    const plan = planFixture("plan_bounds");
    const getPlan = vi.fn(() => plan);
    const storage = {
      ...storageFixture({ plans: [plan] }).storage,
      getPlan,
    };
    await expect(
      new InspectService(storage).inspect(input as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(getPlan).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND without leaking whether another target kind exists", async () => {
    const { storage } = storageFixture();
    const service = new InspectService(storage);
    await expect(
      service.inspect({ kind: "plan", id: "plan_missing" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The requested inspection target was not found",
    });
    await expect(
      service.inspect({ kind: "run", id: "run_missing" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The requested inspection target was not found",
    });
  });

  it("maps malformed plans and runs to a fixed storage failure", async () => {
    const validPlan = planFixture("plan_malformed");
    const malformedPlan = Object.freeze({
      ...validPlan,
      hash: "0".repeat(64),
    }) as ChangePlan;
    const validRun = runFixture("run_malformed", "plan_malformed");
    const malformedRun = Object.freeze({
      ...validRun,
      finishedAt: null,
    }) as ChangeRun;
    const storage = {
      ...storageFixture().storage,
      getPlan: () => malformedPlan,
      getRun: () => malformedRun,
    };
    const service = new InspectService(storage);

    await expect(
      service.inspect({ kind: "plan", id: "plan_malformed" }),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Inspection storage returned invalid data",
    });
    await expect(
      service.inspect({ kind: "run", id: "run_malformed" }),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Inspection storage returned invalid data",
    });
  });

  it("never propagates storage-thrown NOT_FOUND messages or details", async () => {
    const raw = new AppError("NOT_FOUND", "raw storage not-found secret", {
      retryable: false,
      details: { authorization: "Bearer raw-storage-token" },
    });
    const base = storageFixture().storage;
    const service = new InspectService({
      ...base,
      getPlan: () => {
        throw raw;
      },
      getRun: () => {
        throw raw;
      },
    });
    const inputs = [
      { kind: "plan", id: "plan_thrown_not_found" },
      { kind: "run", id: "run_thrown_not_found" },
      {
        kind: "attempts",
        id: asRunId("run_thrown_not_found"),
        operationId: "op_not_found",
      },
      {
        kind: "reconciliations",
        id: asRunId("run_thrown_not_found"),
        operationId: "op_not_found",
      },
    ] as const;

    for (const input of inputs) {
      await expect(service.inspect(input)).rejects.toMatchObject({
        code: "STORAGE_ERROR",
        message: "Inspection storage returned invalid data",
        retryable: false,
      });
    }
  });

  it("fails closed on thrown or malformed run audit pages", async () => {
    const run = runFixture("run_bad_page");
    const base = storageFixture({ runs: [run] }).storage;
    const cases: readonly InspectStorage[] = [
      {
        ...base,
        listRunOperationsPage: () => {
          throw new Error("raw storage secret");
        },
      },
      {
        ...base,
        listRunOperationsPage: () =>
          ({
            items: [{ invalid: true }],
            total: 1,
            nextSequence: null,
          }) as never,
      },
      {
        ...base,
        listRunOperationsPage: () => ({
          items: [],
          total: -1,
          nextSequence: null,
        }),
      },
    ];

    for (const storage of cases) {
      await expect(
        new InspectService(storage).inspect({
          kind: "run",
          id: "run_bad_page",
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_ERROR",
        message: "Inspection storage returned invalid data",
      });
    }
  });

  it.each([
    {
      name: "more items than requested",
      page: {
        items: [
          runOperationFixture("run_page_invariants", 0),
          runOperationFixture("run_page_invariants", 1),
        ],
        total: 2,
        nextSequence: null,
      },
    },
    {
      name: "row from another run",
      page: {
        items: [runOperationFixture("run_other", 0)],
        total: 1,
        nextSequence: null,
      },
    },
    {
      name: "non-contiguous sequence",
      page: {
        items: [runOperationFixture("run_page_invariants", 7)],
        total: 10,
        nextSequence: 1,
      },
    },
    {
      name: "missing has-more cursor",
      page: {
        items: [runOperationFixture("run_page_invariants", 0)],
        total: 2,
        nextSequence: null,
      },
    },
    {
      name: "cursor on an empty page",
      page: {
        items: [],
        total: 2,
        nextSequence: 0,
      },
    },
    {
      name: "unsupported page property",
      page: {
        items: [runOperationFixture("run_page_invariants", 0)],
        total: 1,
        nextSequence: null,
        authorization: "Bearer raw-page-token",
      },
    },
  ])("rejects a run page with $name", async ({ page }) => {
    const run = runFixture("run_page_invariants");
    const base = storageFixture({ runs: [run] }).storage;
    await expect(
      new InspectService({
        ...base,
        listRunOperationsPage: () => page as never,
      }).inspect({
        kind: "run",
        id: "run_page_invariants",
        limit: 1,
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Inspection storage returned invalid data",
    });
  });

  it("rejects a replayed run page instead of issuing the same cursor forever", async () => {
    const run = runFixture("run_replayed_page");
    const base = storageFixture({ runs: [run] }).storage;
    const service = new InspectService({
      ...base,
      listRunOperationsPage: () => ({
        items: [runOperationFixture("run_replayed_page", 0)],
        total: 2,
        nextSequence: 0,
      }),
    });
    const first = await service.inspect({
      kind: "run",
      id: "run_replayed_page",
      limit: 1,
    });

    await expect(
      service.inspect({
        kind: "run",
        id: "run_replayed_page",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Inspection storage returned invalid data",
    });
  });

  it.each(["total", "nextSequence"] as const)(
    "rejects a run page %s getter without invoking it",
    async (property) => {
      const run = runFixture("run_page_getter");
      const base = storageFixture({ runs: [run] }).storage;
      let getterCalls = 0;
      const page: Record<string, unknown> = {
        items: [runOperationFixture("run_page_getter", 0)],
        total: 1,
        nextSequence: null,
      };
      Object.defineProperty(page, property, {
        configurable: true,
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error(`raw ${property} getter secret`);
        },
      });

      await expect(
        new InspectService({
          ...base,
          listRunOperationsPage: () => page as never,
        }).inspect({
          kind: "run",
          id: "run_page_getter",
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_ERROR",
        message: "Inspection storage returned invalid data",
      });
      expect(getterCalls).toBe(0);
    },
  );

  it("rejects a proxied page without invoking any proxy trap", async () => {
    const run = runFixture("run_page_proxy");
    const base = storageFixture({ runs: [run] }).storage;
    let trapCalls = 0;
    const page = new Proxy(
      {
        items: [runOperationFixture("run_page_proxy", 0)],
        total: 1,
        nextSequence: null,
      },
      {
        get: () => {
          trapCalls += 1;
          throw new Error("raw proxy get secret");
        },
        getPrototypeOf: () => {
          trapCalls += 1;
          throw new Error("raw proxy prototype secret");
        },
        ownKeys: () => {
          trapCalls += 1;
          throw new Error("raw proxy ownKeys secret");
        },
      },
    );

    await expect(
      new InspectService({
        ...base,
        listRunOperationsPage: () => page,
      }).inspect({
        kind: "run",
        id: "run_page_proxy",
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Inspection storage returned invalid data",
    });
    expect(trapCalls).toBe(0);
  });

  it("rejects an exotic page even if its prototype is disguised as plain", async () => {
    const run = runFixture("run_page_exotic");
    const base = storageFixture({ runs: [run] }).storage;
    const page = new Date(CREATED_AT);
    Object.setPrototypeOf(page, Object.prototype);
    Object.defineProperties(page, {
      items: {
        configurable: true,
        enumerable: true,
        value: [runOperationFixture("run_page_exotic", 0)],
      },
      total: {
        configurable: true,
        enumerable: true,
        value: 1,
      },
      nextSequence: {
        configurable: true,
        enumerable: true,
        value: null,
      },
    });

    await expect(
      new InspectService({
        ...base,
        listRunOperationsPage: () => page as never,
      }).inspect({
        kind: "run",
        id: "run_page_exotic",
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Inspection storage returned invalid data",
    });
  });

  it("rejects custom array prototypes without invoking their map hook", async () => {
    const run = runFixture("run_page_prototype");
    const base = storageFixture({ runs: [run] }).storage;
    let mapCalls = 0;
    const items = [runOperationFixture("run_page_prototype", 0)];
    Object.setPrototypeOf(items, {
      map: () => {
        mapCalls += 1;
        return [runOperationFixture("run_page_prototype", 0)];
      },
    });

    await expect(
      new InspectService({
        ...base,
        listRunOperationsPage: () => ({
          items,
          total: 1,
          nextSequence: null,
        }),
      }).inspect({
        kind: "run",
        id: "run_page_prototype",
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "Inspection storage returned invalid data",
    });
    expect(mapCalls).toBe(0);
  });

  it.each([
    {
      kind: "attempts" as const,
      item: attemptFixture("run_history_page", "op_other", 1),
      override: "listRunOperationAttemptsPage" as const,
    },
    {
      kind: "reconciliations" as const,
      item: reconciliationFixture("run_other", "op_history", 1),
      override: "listRunOperationReconciliationsPage" as const,
    },
  ])(
    "rejects a $kind page whose row does not match its target",
    async (testCase) => {
      const run = runFixture("run_history_page");
      const base = storageFixture({ runs: [run] }).storage;
      const page =
        testCase.kind === "attempts"
          ? { items: [testCase.item], total: 1, nextAttempt: null }
          : { items: [testCase.item], total: 1, nextEventSequence: null };
      const storage = {
        ...base,
        [testCase.override]: () => page,
      };

      await expect(
        new InspectService(storage).inspect({
          kind: testCase.kind,
          id: asRunId("run_history_page"),
          operationId: "op_history",
        }),
      ).rejects.toMatchObject({
        code: "STORAGE_ERROR",
        message: "Inspection storage returned invalid data",
      });
    },
  );

  it("rejects hostile input and non-string cursor values without storage", async () => {
    const plan = planFixture("plan_hostile");
    const getPlan = vi.fn(() => plan);
    const service = new InspectService({
      ...storageFixture().storage,
      getPlan,
    });
    const hostile = new Proxy(
      { kind: "plan", id: "plan_hostile" },
      {
        ownKeys: () => {
          throw new Error("must not escape");
        },
      },
    );

    await expect(service.inspect(hostile as never)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      service.inspect({
        kind: "plan",
        id: "plan_hostile",
        cursor: 1 as never,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(getPlan).not.toHaveBeenCalled();
  });
});
