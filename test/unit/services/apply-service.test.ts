import { describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  sha256Hex,
} from "../../../src/domain/canonical-json.js";
import { AppError } from "../../../src/domain/errors.js";
import type { PlanAction } from "../../../src/domain/plan.js";
import type { GitHubCapabilities } from "../../../src/app/ports/github-port.js";
import {
  applyFixture,
  plannerBinding,
} from "../../support/change-service-fixtures.js";

type Fixture = Awaited<ReturnType<typeof applyFixture>>;

async function createPlan(fixture: Fixture, actions: readonly PlanAction[]) {
  return fixture.planner.service.create({
    ...fixture.planner.validInput,
    actions,
  });
}

async function twoUnstars(fixture: Fixture) {
  return createPlan(fixture, [
    {
      kind: "unstar",
      repositories: {
        kind: "ids",
        repositoryIds: [
          fixture.planner.ids.keepRepository,
          fixture.planner.ids.removeRepository,
        ],
      },
    },
  ]);
}

async function dependentListPlan(fixture: Fixture, includeIndependent = true) {
  return createPlan(fixture, [
    {
      kind: "list_create",
      clientRef: "created-target",
      name: "Created Target",
      description: null,
      isPrivate: false,
    },
    {
      kind: "list_membership_add",
      repositories: {
        kind: "ids",
        repositoryIds: [fixture.planner.ids.removeRepository],
      },
      lists: [{ kind: "created", clientRef: "created-target" }],
    },
    ...(includeIndependent
      ? ([
          {
            kind: "unstar",
            repositories: {
              kind: "ids",
              repositoryIds: [fixture.planner.ids.keepRepository],
            },
          },
        ] satisfies readonly PlanAction[])
      : []),
  ]);
}

async function admissionRejection(
  fixture: Fixture,
  promise: Promise<unknown>,
  expected: Readonly<Record<string, unknown>>,
): Promise<void> {
  const before = fixture.rawStorage.getPlan(fixture.plan.id);

  await expect(promise).rejects.toMatchObject(expected);

  expect(fixture.rawStorage.getPlan(fixture.plan.id)).toEqual(before);
  expect(fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)).toBeNull();
  expect(fixture.github.mutationCalls).toEqual([]);
  expect(fixture.tracking.acquireLease).toEqual([]);
}

describe("ApplyService admission", () => {
  it.each([
    {
      label: "read-only mode",
      fixture: () => applyFixture({ readOnly: true }),
      invoke: (fixture: Fixture) => fixture.service.apply(fixture.input),
      error: {
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
        details: { reason: "read_only" },
      },
    },
    {
      label: "malformed expected hash",
      fixture: () => applyFixture(),
      invoke: (fixture: Fixture) =>
        fixture.service.apply({
          ...fixture.input,
          expectedHash: "A".repeat(64),
        }),
      error: { code: "VALIDATION_ERROR", retryable: false },
    },
    {
      label: "recomputed and stored hash mismatch",
      fixture: () =>
        applyFixture({
          transformLoadedPlan: (plan) => ({
            ...plan,
            hash: "a".repeat(64),
          }),
        }),
      invoke: (fixture: Fixture) => fixture.service.apply(fixture.input),
      error: { code: "PLAN_HASH_MISMATCH", retryable: false },
    },
    {
      label: "expected and stored hash mismatch",
      fixture: () => applyFixture({ expectedHash: "b".repeat(64) }),
      invoke: (fixture: Fixture) => fixture.service.apply(fixture.input),
      error: { code: "PLAN_HASH_MISMATCH", retryable: false },
    },
    {
      label: "expired plan",
      fixture: () =>
        applyFixture({
          planTtlMinutes: 1,
          now: "2026-07-16T02:00:00.000Z",
        }),
      invoke: (fixture: Fixture) => fixture.service.apply(fixture.input),
      error: { code: "PLAN_EXPIRED", retryable: false },
    },
    {
      label: "plan already marked expired",
      fixture: () => applyFixture({ planState: "expired" }),
      invoke: (fixture: Fixture) => fixture.service.apply(fixture.input),
      error: { code: "PLAN_EXPIRED", retryable: false },
    },
    {
      label: "failed plan",
      fixture: () => applyFixture({ planState: "failed" }),
      invoke: (fixture: Fixture) => fixture.service.apply(fixture.input),
      error: { code: "PRECONDITION_FAILED", retryable: false },
    },
    {
      label: "superseded plan",
      fixture: () => applyFixture({ planState: "superseded" }),
      invoke: (fixture: Fixture) => fixture.service.apply(fixture.input),
      error: { code: "PRECONDITION_FAILED", retryable: false },
    },
  ])(
    "rejects $label with zero durable or remote mutation",
    async ({ fixture: build, invoke, error }) => {
      const fixture = await build();
      await admissionRejection(fixture, invoke(fixture), error);
    },
  );

  it.each([
    ["host", { ...plannerBinding, host: "github.example" }],
    ["login", { ...plannerBinding, login: "different-login" }],
    ["account ID", { ...plannerBinding, accountId: "U_different" }],
  ] as const)(
    "requires the exact persisted %s binding",
    async (_label, binding) => {
      const fixture = await applyFixture({
        binding,
      });
      await admissionRejection(fixture, fixture.service.apply(fixture.input), {
        code: "PLAN_ACCOUNT_MISMATCH",
        retryable: false,
      });
    },
  );

  it.each(["starWrite", "listWrite"] as const)(
    "rejects an explicitly unavailable required %s capability",
    async (capability) => {
      const capabilities: GitHubCapabilities = Object.freeze({
        starRead: "available",
        starWrite: "available",
        listRead: "available",
        listWrite: "available",
        [capability]: "unavailable",
      });
      const fixture = await applyFixture({ capabilities });
      if (capability === "listWrite") {
        const listPlan = await fixture.planner.service.create({
          ...fixture.planner.validInput,
          actions: [
            {
              kind: "list_create",
              clientRef: "required-list-write",
              name: "Required List",
              description: null,
              isPrivate: false,
            },
          ],
        });
        const input = {
          ...fixture.input,
          planId: listPlan.plan.id,
          expectedHash: listPlan.plan.hash,
        };
        await admissionRejection(
          { ...fixture, plan: listPlan.plan },
          fixture.service.apply(input),
          {
            code: "CAPABILITY_UNAVAILABLE",
            retryable: false,
          },
        );
        return;
      }

      await admissionRejection(fixture, fixture.service.apply(fixture.input), {
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
      });
    },
  );

  it("rejects an already-aborted signal before admission changes state", async () => {
    const fixture = await applyFixture();
    const controller = new AbortController();
    controller.abort();
    await admissionRejection(
      fixture,
      fixture.service.apply(fixture.input, controller.signal),
      { name: "AbortError" },
    );
    expect(fixture.github.statusCalls).toEqual([]);
  });
});

describe("ApplyService account lease", () => {
  it("releases an acquired lease when heartbeat scheduling cannot start", async () => {
    const fixture = await applyFixture({
      leaseScheduler: {
        setInterval() {
          throw new Error("scheduler unavailable");
        },
        clearInterval: vi.fn(),
      },
    });

    await expect(fixture.service.apply(fixture.input)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false,
      details: { reason: "lease_scheduler_failure" },
    });

    expect(fixture.tracking.acquireLease).toHaveLength(1);
    expect(fixture.tracking.releaseLease).toEqual([
      {
        name: fixture.tracking.acquireLease[0]?.name,
        ownerId: "apply-instance-1:request_apply_1",
      },
    ]);
    expect(fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)).toBeNull();
    expect(fixture.github.mutationCalls).toEqual([]);
  });

  it("does not collapse different account IDs that share one login", async () => {
    const first = await applyFixture({
      planBinding: { ...plannerBinding, accountId: "U_account_one" },
    });
    const second = await applyFixture({
      planBinding: { ...plannerBinding, accountId: "U_account_two" },
    });

    await first.service.apply(first.input);
    await second.service.apply(second.input);

    expect(first.tracking.acquireLease[0]?.name).toBe(
      `apply:github.com:${sha256Hex("U_account_one").slice(0, 16)}`,
    );
    expect(second.tracking.acquireLease[0]?.name).toBe(
      `apply:github.com:${sha256Hex("U_account_two").slice(0, 16)}`,
    );
    expect(first.tracking.acquireLease[0]?.name).not.toBe(
      second.tracking.acquireLease[0]?.name,
    );
  });

  it("derives the lease from host and a stable account-ID hash, renews before mutation, and releases after the safety window", async () => {
    const fixture = await applyFixture({ instanceId: "process-alpha" });
    fixture.runtime.onWait = () => {
      fixture.tracking.events.push("safety:wait");
      const acquired = fixture.tracking.acquireLease[0]!;
      fixture.rawStorage.assertLease({
        name: acquired.name,
        ownerId: acquired.ownerId,
        now: fixture.runtime.now(),
      });
    };

    await expect(fixture.service.apply(fixture.input)).resolves.toMatchObject({
      run: { state: "completed" },
    });

    const expectedName = `apply:${plannerBinding.host}:${sha256Hex(
      plannerBinding.accountId,
    ).slice(0, 16)}`;
    expect(fixture.tracking.acquireLease).toMatchObject([
      { name: expectedName, ownerId: "process-alpha:request_apply_1" },
    ]);
    expect(fixture.tracking.recovery).toHaveLength(1);
    expect(fixture.tracking.recovery[0]?.binding).toEqual(plannerBinding);

    const events = fixture.tracking.events;
    const mutation = events.indexOf("mutation:unstar");
    const renewals = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === "lease:renew")
      .map(({ index }) => index);
    const safety = events.indexOf("safety:wait");
    const release = events.indexOf("lease:release");
    expect(renewals.some((index) => index < mutation)).toBe(true);
    expect(renewals.some((index) => index > mutation && index < safety)).toBe(
      true,
    );
    expect(mutation).toBeLessThan(safety);
    expect(safety).toBeLessThan(release);
  });

  it("retains the lease until expiry when the safety window wait fails", async () => {
    const fixture = await applyFixture({ instanceId: "safety-process" });
    const secondPlan = await fixture.planner.service.create(
      fixture.planner.validInput,
    );
    const safetyFailure = new Error("fixture safety wait failed");
    fixture.runtime.onWait = () => {
      throw safetyFailure;
    };

    await expect(fixture.service.apply(fixture.input)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      details: { reason: "mutation_pacing_wait_failed" },
    });
    const firstLease = fixture.tracking.acquireLease[0]!;
    expect(fixture.github.mutationCalls).toHaveLength(1);
    expect(fixture.tracking.releaseLease).not.toContainEqual({
      name: firstLease.name,
      ownerId: firstLease.ownerId,
    });

    fixture.runtime.onWait = null;
    const secondInput = {
      planId: secondPlan.plan.id,
      expectedHash: secondPlan.plan.hash,
      failureMode: "stop" as const,
    };
    await expect(
      fixture.createService("competing-process").apply(secondInput),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "lease_held" },
    });
    expect(
      fixture.rawStorage.getLatestRunForPlan(secondPlan.plan.id),
    ).toBeNull();

    fixture.runtime.setNow("2026-07-16T03:00:00.000Z");
    await expect(
      fixture.createService("takeover-process").apply(secondInput),
    ).resolves.toMatchObject({ run: { state: "completed" } });
  });

  it("keeps one owner and heartbeat while rejecting a second process for the same account", async () => {
    const fixture = await applyFixture({ instanceId: "process-first" });
    let releaseMutation!: () => void;
    fixture.github.mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const first = fixture.service.apply(fixture.input);
    await vi.waitFor(() => {
      expect(fixture.github.mutationCalls).toHaveLength(1);
    });

    fixture.scheduler.tick();
    expect(fixture.tracking.renewLease.at(-1)).toMatchObject({
      ownerId: "process-first:request_apply_1",
    });

    const secondPlan = await fixture.planner.service.create(
      fixture.planner.validInput,
    );
    const second = fixture.createService("process-second").apply({
      planId: secondPlan.plan.id,
      expectedHash: secondPlan.plan.hash,
      failureMode: "stop",
    });
    await expect(second).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_held" },
    });
    expect(
      fixture.rawStorage.getLatestRunForPlan(secondPlan.plan.id),
    ).toBeNull();

    releaseMutation();
    await expect(first).resolves.toMatchObject({
      run: { state: "completed" },
    });
  });

  it("uses a unique owner for each invocation of the same service", async () => {
    const fixture = await applyFixture({ instanceId: "same-process" });
    const secondPlan = await fixture.planner.service.create(
      fixture.planner.validInput,
    );

    await fixture.service.apply(fixture.input);
    await fixture.service.apply({
      planId: secondPlan.plan.id,
      expectedHash: secondPlan.plan.hash,
      failureMode: "stop",
    });

    expect(fixture.tracking.acquireLease.map(({ ownerId }) => ownerId)).toEqual(
      ["same-process:request_apply_1", "same-process:request_apply_2"],
    );
  });

  it("prevents a stale heartbeat and cleanup from touching a takeover owner", async () => {
    const fixture = await applyFixture({ instanceId: "aba-process" });
    let releaseMutation!: () => void;
    fixture.github.mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const running = fixture.service.apply(fixture.input);
    await vi.waitFor(() => {
      expect(fixture.github.mutationCalls).toHaveLength(1);
    });
    const stale = fixture.tracking.acquireLease[0]!;
    expect(stale.ownerId).toBe("aba-process:request_apply_1");

    const takeoverNow = "2026-07-16T03:00:00.000Z";
    fixture.runtime.setNow(takeoverNow);
    const takeover = fixture.rawStorage.acquireLease({
      name: stale.name,
      ownerId: "aba-process:request_apply_2",
      now: takeoverNow,
      expiresAt: "2026-07-16T03:10:00.000Z",
    })!;

    fixture.scheduler.tick();
    expect(
      fixture.rawStorage.assertLease({
        name: takeover.name,
        ownerId: takeover.ownerId,
        now: takeoverNow,
      }).ownerId,
    ).toBe("aba-process:request_apply_2");

    releaseMutation();
    await expect(running).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "lease_lost" },
    });
    expect(
      fixture.rawStorage.assertLease({
        name: takeover.name,
        ownerId: takeover.ownerId,
        now: takeoverNow,
      }).ownerId,
    ).toBe("aba-process:request_apply_2");
    expect(fixture.tracking.releaseLease).not.toContainEqual({
      name: takeover.name,
      ownerId: takeover.ownerId,
    });
  });
});

describe("ApplyService durable orchestration", () => {
  it("persists one stable redacted warning for an unknown required capability", async () => {
    const fixture = await applyFixture({
      capabilities: Object.freeze({
        starRead: "available",
        starWrite: "unknown",
        listRead: "available",
        listWrite: "available",
      }),
    });

    const result = await fixture.service.apply(fixture.input);
    const stored = fixture.rawStorage.getRun(result.run.id);

    expect(result.warnings).toBe(result.run.warnings);
    expect(
      result.warnings.filter((warning) =>
        /Star write capability is unknown/u.test(warning),
      ),
    ).toHaveLength(1);
    expect(result.warnings.join(" ")).not.toContain(plannerBinding.login);
    expect(result.warnings.join(" ")).not.toContain(plannerBinding.accountId);
    expect(stored?.warnings).toEqual(result.warnings);
  });

  it("writes pending before the callback, starts exactly one attempt, and claims/finalizes in synchronous transactions", async () => {
    const fixture = await applyFixture();
    const observed: unknown[] = [];
    fixture.github.onMutation = (call) => {
      const run = fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)!;
      observed.push(
        fixture.rawStorage.getRunOperation({
          runId: run.id,
          operationId: call.operationId,
        }),
      );
    };

    const result = await fixture.service.apply(fixture.input);
    const row = fixture.rawStorage.listRunOperations(result.run.id)[0];

    expect(observed).toMatchObject([
      { status: "running", attempts: 1, reconciliation: "pending" },
    ]);
    expect(row).toMatchObject({
      status: "succeeded",
      attempts: 1,
      externalRequestId: "REQ-1",
    });
    expect(
      fixture.rawStorage.listRunOperationAttemptsPage({
        runId: result.run.id,
        operationId: row!.operationId,
        afterAttempt: null,
        pageSize: 10,
      }).items,
    ).toMatchObject([{ attempt: 1, status: "succeeded" }]);
    expect(fixture.tracking.transactions).toBe(2);
    expect(fixture.tracking.globalRecoveries).toBe(0);
  });

  it("records a storage-triggered abort after attempt start without entering remote dispatch", async () => {
    const fixture = await applyFixture();
    const controller = new AbortController();
    fixture.tracking.afterStartRunOperation = () => controller.abort();

    await expect(
      fixture.service.apply(fixture.input, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    const run = fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)!;
    expect(run.state).toBe("partial");
    expect(fixture.rawStorage.listRunOperations(run.id)).toMatchObject([
      {
        status: "failed",
        attempts: 1,
        reconciliation: "confirmed_not_applied",
        error: {
          retryable: true,
          details: { reason: "cancelled_before_dispatch" },
        },
      },
    ]);
    expect(fixture.github.mutationCalls).toEqual([]);
  });

  it("recovers a successful remote mutation after its audit finish write fails", async () => {
    const fixture = await applyFixture();
    const finishFailure = new AppError(
      "STORAGE_ERROR",
      "fixture audit finish failed",
      {
        retryable: false,
        details: { reason: "fixture_finish_failure" },
      },
    );
    fixture.tracking.finishRunOperationFailure = finishFailure;

    await expect(fixture.service.apply(fixture.input)).rejects.toBe(
      finishFailure,
    );

    const abandoned = fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)!;
    expect(abandoned.state).toBe("running");
    expect(fixture.rawStorage.listRunOperations(abandoned.id)).toMatchObject([
      { status: "running", attempts: 1, reconciliation: "pending" },
    ]);
    expect(fixture.github.mutationCalls).toHaveLength(1);

    const resumed = await fixture
      .createService("audit-recovery-process")
      .apply(fixture.input);
    const rows = fixture.rawStorage.listRunOperations(resumed.run.id);

    expect(resumed.run.id).toBe(abandoned.id);
    expect(resumed.run.state).toBe("completed");
    expect(rows).toMatchObject([
      {
        status: "succeeded",
        attempts: 1,
        reconciliation: "confirmed_applied",
      },
    ]);
    expect(rows.some((row) => row.status === "running")).toBe(false);
    expect(fixture.github.mutationCalls).toHaveLength(1);
  });

  it("returns the persisted completed run idempotently without a second mutation", async () => {
    const fixture = await applyFixture();

    const first = await fixture.service.apply(fixture.input);
    const mutationCount = fixture.github.mutationCalls.length;
    const second = await fixture.service.apply(fixture.input);

    expect(second).toEqual(first);
    expect(second.run.id).toBe(first.run.id);
    expect(fixture.github.mutationCalls).toHaveLength(mutationCount);
  });

  it("replays an applied run before expiry, capability, failure-mode, lease, or recovery checks", async () => {
    const fixture = await applyFixture();
    const first = await fixture.service.apply(fixture.input);
    const leaseName = fixture.tracking.acquireLease[0]!.name;
    const expiredNow = "2030-01-01T00:00:00.000Z";
    fixture.runtime.setNow(expiredNow);
    fixture.github.capabilities = Object.freeze({
      starRead: "available",
      starWrite: "unavailable",
      listRead: "available",
      listWrite: "unavailable",
    });
    fixture.github.statusCalls.length = 0;
    fixture.tracking.acquireLease.length = 0;
    fixture.tracking.recovery.length = 0;
    fixture.rawStorage.acquireLease({
      name: leaseName,
      ownerId: "competing-replay-owner",
      now: expiredNow,
      expiresAt: "2030-01-01T00:10:00.000Z",
    });

    const replay = await fixture.service.apply({
      ...fixture.input,
      failureMode: "continue",
    });

    expect(replay).toEqual(first);
    expect(replay.run).toEqual(first.run);
    expect(fixture.github.statusCalls).toEqual(["getViewer"]);
    expect(fixture.tracking.acquireLease).toEqual([]);
    expect(fixture.tracking.recovery).toEqual([]);
    expect(fixture.github.mutationCalls).toHaveLength(1);
  });

  it("audits the first real permission rejection as nonretryable without retry", async () => {
    const fixture = await applyFixture({
      capabilities: Object.freeze({
        starRead: "available",
        starWrite: "unknown",
        listRead: "available",
        listWrite: "available",
      }),
    });
    fixture.github.failNextMutation(
      new AppError(
        "INSUFFICIENT_PERMISSION",
        "GitHub rejected the fixed mutation",
        {
          retryable: false,
          details: { reason: "permission_rejected" },
        },
      ),
      { kind: "unstar" },
    );

    const result = await fixture.service.apply(fixture.input);
    const row = fixture.rawStorage.listRunOperations(result.run.id)[0];

    expect(result.run.state).toBe("partial");
    expect(row).toMatchObject({
      status: "failed",
      reconciliation: "confirmed_not_applied",
      attempts: 1,
      error: {
        code: "INSUFFICIENT_PERMISSION",
        retryable: false,
      },
    });
    expect(fixture.github.mutationCalls).toHaveLength(1);
  });

  it("stop leaves later operations unscheduled and both run and plan partial", async () => {
    const fixture = await applyFixture();
    const planned = await twoUnstars(fixture);
    fixture.github.failNextMutation(
      new AppError("INSUFFICIENT_PERMISSION", "stop here", {
        retryable: false,
      }),
    );

    const result = await fixture.service.apply({
      planId: planned.plan.id,
      expectedHash: planned.plan.hash,
      failureMode: "stop",
    });
    const rows = fixture.rawStorage.listRunOperations(result.run.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(result.run.state).toBe("partial");
    expect(fixture.rawStorage.getPlan(planned.plan.id)?.state).toBe("partial");
  });

  it("continue runs independent work but records a blocked dependency without dispatch", async () => {
    const fixture = await applyFixture();
    const planned = await dependentListPlan(fixture);
    fixture.github.failNextMutation(
      new AppError("GITHUB_UNAVAILABLE", "confirmed pre-dispatch failure", {
        retryable: true,
      }),
      { kind: "createUserList" },
    );

    const result = await fixture.service.apply({
      planId: planned.plan.id,
      expectedHash: planned.plan.hash,
      failureMode: "continue",
    });
    const rows = fixture.rawStorage.listRunOperations(result.run.id);
    const rowById = new Map(rows.map((row) => [row.operationId, row]));
    const create = planned.plan.operations.find(
      (operation) => operation.kind === "list_create",
    )!;
    const independent = planned.plan.operations.find(
      (operation) => operation.kind === "unstar",
    )!;
    const dependent = planned.plan.operations.find(
      (operation) => operation.kind === "list_membership_set",
    )!;

    expect(rowById.get(create.operationId)).toMatchObject({
      status: "failed",
      error: { retryable: true },
    });
    expect(rowById.get(independent.operationId)?.status).toBe("succeeded");
    expect(rowById.get(dependent.operationId)).toMatchObject({
      status: "failed",
      reconciliation: "confirmed_not_applied",
      attempts: 0,
      error: {
        retryable: true,
        details: { reason: "dependency_blocked" },
      },
    });
    expect(
      fixture.github.mutationCalls.filter(
        ({ kind }) => kind === "setRepositoryListIds",
      ),
    ).toEqual([]);
    expect(result.run.state).toBe("partial");
  });

  it("reconciles retryable failures, preserves original warnings, and retries the dependent row after its prerequisite succeeds", async () => {
    const fixture = await applyFixture({
      capabilities: Object.freeze({
        starRead: "available",
        starWrite: "available",
        listRead: "available",
        listWrite: "unknown",
      }),
    });
    const planned = await dependentListPlan(fixture);
    fixture.github.failNextMutation(
      new AppError("GITHUB_UNAVAILABLE", "safe to retry", {
        retryable: true,
      }),
      { kind: "createUserList" },
    );
    const input = {
      planId: planned.plan.id,
      expectedHash: planned.plan.hash,
      failureMode: "continue" as const,
    };

    const first = await fixture.service.apply(input);
    fixture.github.capabilities = Object.freeze({
      starRead: "available",
      starWrite: "available",
      listRead: "available",
      listWrite: "available",
    });
    const second = await fixture.service.apply(input);
    const rows = fixture.rawStorage.listRunOperations(second.run.id);
    const byKind = new Map(
      planned.plan.operations.map((operation) => [
        operation.kind,
        rows.find((row) => row.operationId === operation.operationId)!,
      ]),
    );

    expect(second.run.id).toBe(first.run.id);
    expect(second.run.state).toBe("completed");
    expect(second.warnings).toEqual(first.warnings);
    expect(
      second.warnings.filter((warning) =>
        /List write capability is unknown/u.test(warning),
      ),
    ).toHaveLength(1);
    expect(byKind.get("list_create")).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
    expect(byKind.get("list_membership_set")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(fixture.rawStorage.getPlan(planned.plan.id)?.state).toBe("applied");
  });

  it("rejects a conflicting failure mode when resuming the same partial run", async () => {
    const fixture = await applyFixture();
    fixture.github.failNextMutation(
      new AppError("GITHUB_UNAVAILABLE", "safe failure", { retryable: true }),
    );
    const first = await fixture.service.apply(fixture.input);
    const beforeMutations = fixture.github.mutationCalls.length;

    await expect(
      fixture.service.apply({
        ...fixture.input,
        failureMode: "continue",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reason: "failure_mode_conflict" },
    });
    expect(fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)?.id).toBe(
      first.run.id,
    );
    expect(fixture.github.mutationCalls).toHaveLength(beforeMutations);
  });

  it("leaves an abandoned running run byte-for-byte unchanged when claim validation fails", async () => {
    const fixture = await applyFixture({ instanceId: "atomic-recovery" });
    fixture.tracking.loseLeaseOnNextRenew = true;
    await expect(fixture.service.apply(fixture.input)).rejects.toMatchObject({
      details: { reason: "lease_lost" },
    });
    const run = fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)!;
    expect(run.state).toBe("running");
    const storedState = () =>
      canonicalJson({
        plan: fixture.rawStorage.getPlan(fixture.plan.id),
        run: fixture.rawStorage.getRun(run.id),
        operations: fixture.rawStorage.listRunOperations(run.id),
      });
    const before = storedState();
    fixture.runtime.setNow("2026-07-16T03:00:00.000Z");

    await expect(
      fixture.service.apply({
        ...fixture.input,
        failureMode: "continue",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reason: "failure_mode_conflict" },
    });

    expect(storedState()).toBe(before);
  });

  it("reconciles an unknown applied outcome without dispatching twice", async () => {
    const fixture = await applyFixture();
    fixture.github.failNextMutation(
      new AppError("RECONCILIATION_REQUIRED", "connection ended after apply", {
        retryable: false,
      }),
      { kind: "unstar", afterApply: true },
    );

    const first = await fixture.service.apply(fixture.input);
    expect(fixture.rawStorage.listRunOperations(first.run.id)[0]).toMatchObject(
      {
        status: "unresolved",
        reconciliation: "unknown",
        attempts: 1,
      },
    );
    const second = await fixture.service.apply(fixture.input);

    expect(second.run.state).toBe("completed");
    expect(fixture.github.mutationCalls).toHaveLength(1);
    expect(
      fixture.rawStorage.listRunOperations(second.run.id)[0],
    ).toMatchObject({
      status: "succeeded",
      reconciliation: "confirmed_applied",
      attempts: 1,
    });
  });

  it("keeps an unresolved row partial when live reconciliation is unavailable", async () => {
    const fixture = await applyFixture();
    fixture.github.failNextMutation(
      new AppError("RECONCILIATION_REQUIRED", "outcome unknown", {
        retryable: false,
      }),
      { kind: "unstar" },
    );

    const first = await fixture.service.apply(fixture.input);
    fixture.github.checkStar = () =>
      Promise.reject(new Error("live state unavailable"));
    const second = await fixture
      .createService("reconciliation-process")
      .apply(fixture.input);
    const row = fixture.rawStorage.listRunOperations(second.run.id)[0];

    expect(second.run.id).toBe(first.run.id);
    expect(second.run.state).toBe("partial");
    expect(row).toMatchObject({
      status: "unresolved",
      reconciliation: "unknown",
      attempts: 1,
      error: {
        code: "RECONCILIATION_REQUIRED",
        retryable: false,
        details: { reason: "reconciliation_inconclusive" },
      },
    });
    expect(fixture.github.mutationCalls).toHaveLength(1);
  });

  it("audits abort after write-ahead and later rebuilds created IDs to resume the dependent mutation", async () => {
    const fixture = await applyFixture();
    const planned = await dependentListPlan(fixture, false);
    const input = {
      planId: planned.plan.id,
      expectedHash: planned.plan.hash,
      failureMode: "continue" as const,
    };
    const controller = new AbortController();
    fixture.runtime.onWait = () => controller.abort();

    await expect(
      fixture.service.apply(input, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const partial = fixture.rawStorage.getLatestRunForPlan(planned.plan.id)!;
    const firstRows = fixture.rawStorage.listRunOperations(partial.id);
    const create = planned.plan.operations.find(
      (operation) => operation.kind === "list_create",
    )!;
    const dependent = planned.plan.operations.find(
      (operation) => operation.kind === "list_membership_set",
    )!;
    expect(
      firstRows.find((row) => row.operationId === create.operationId),
    ).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(
      firstRows.find((row) => row.operationId === dependent.operationId),
    ).toMatchObject({
      status: "failed",
      attempts: 0,
      reconciliation: "confirmed_not_applied",
      error: { retryable: true },
    });
    expect(partial.state).toBe("partial");

    fixture.runtime.onWait = null;
    const resumed = await fixture.createService("resume-process").apply(input);
    expect(resumed.run.id).toBe(partial.id);
    expect(resumed.run.state).toBe("completed");
    expect(
      fixture.rawStorage.getRunOperation({
        runId: resumed.run.id,
        operationId: dependent.operationId,
      }),
    ).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("uses targeted recovery after lease loss and resumes the same run through the same service", async () => {
    const fixture = await applyFixture({ instanceId: "losing-process" });
    fixture.tracking.loseLeaseOnNextRenew = true;

    await expect(fixture.service.apply(fixture.input)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_lost" },
    });
    expect(fixture.github.mutationCalls).toEqual([]);
    expect(fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)?.state).toBe(
      "running",
    );

    fixture.runtime.setNow("2026-07-16T03:00:00.000Z");
    const recovered = await fixture.service.apply(fixture.input);

    expect(recovered.run.state).toBe("completed");
    expect(recovered.run.id).toBe(
      fixture.rawStorage.getLatestRunForPlan(fixture.plan.id)?.id,
    );
    expect(fixture.tracking.acquireLease[0]?.ownerId).not.toBe(
      fixture.tracking.acquireLease.at(-1)?.ownerId,
    );
    expect(fixture.tracking.recovery.length).toBeGreaterThanOrEqual(2);
    expect(fixture.tracking.globalRecoveries).toBe(0);
    expect(fixture.github.mutationCalls).toHaveLength(1);
  });

  it("bounds returned errors while preserving aggregate counts and an audit cursor", async () => {
    const fixture = await applyFixture();
    const actions = Array.from(
      { length: 25 },
      (_, index): PlanAction => ({
        kind: "list_create",
        clientRef: `bounded-${String(index).padStart(2, "0")}`,
        name: `Bounded ${String(index)}`,
        description: null,
        isPrivate: false,
      }),
    );
    const planned = await createPlan(fixture, actions);
    fixture.github.failEveryMutation(
      new AppError("INSUFFICIENT_PERMISSION", "bounded failure", {
        retryable: false,
      }),
      "createUserList",
    );

    const result = await fixture.service.apply({
      planId: planned.plan.id,
      expectedHash: planned.plan.hash,
      failureMode: "continue",
    });

    expect(result.counts).toEqual({
      pending: 0,
      running: 0,
      succeeded: 0,
      skipped: 0,
      failed: 25,
      unresolved: 0,
    });
    expect(result.errors).toHaveLength(20);
    expect(result.auditCursor).toBe(result.run.id);
    expect(result.warnings).toBe(result.run.warnings);
    expect(fixture.rawStorage.listRunOperations(result.run.id)).toHaveLength(
      25,
    );
  });
});
