import { describe, expect, it, vi } from "vitest";
import type { StoragePort } from "../../../src/app/ports/storage-port.js";
import { InspectService } from "../../../src/app/services/inspect-service.js";
import {
  asPlanId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import {
  hashPlanExecutable,
  type ChangePlan,
  type ResolvedOperation,
} from "../../../src/domain/plan.js";
import type { AccountBinding } from "../../../src/domain/repository.js";
import type { ChangeRun, RunOperation } from "../../../src/domain/run.js";

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

type InspectStorage = Pick<
  StoragePort,
  "getPlan" | "getRun" | "listRunOperationsPage"
>;

function storageFixture(input?: {
  readonly plans?: readonly ChangePlan[];
  readonly runs?: readonly ChangeRun[];
  readonly runOperations?: Readonly<Record<string, readonly RunOperation[]>>;
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
  const storage: InspectStorage = {
    getPlan: (id) => plans.get(String(id)) ?? null,
    getRun: (id) => runs.get(String(id)) ?? null,
    listRunOperationsPage,
  };
  return { storage, listRunOperationsPage };
}

function cursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function cursorPayload(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
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
    const { storage } = storageFixture({
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

  it.each([
    [{ kind: "plan", id: "plan_bounds", limit: 0 }],
    [{ kind: "plan", id: "plan_bounds", limit: 101 }],
    [{ kind: "plan", id: " plan_bounds" }],
    [{ kind: "unknown", id: "plan_bounds" }],
    [{ kind: "plan", id: "plan_bounds", extra: true }],
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
