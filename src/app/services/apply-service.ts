import type { AppConfig } from "../../config.js";
import { canonicalJsonClone, sha256Hex } from "../../domain/canonical-json.js";
import {
  AppError,
  serializeError,
  type SerializedDomainError,
} from "../../domain/errors.js";
import {
  asPlanId,
  asRunId,
  asUserListId,
  type PlanId,
} from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import {
  hashPlanExecutable,
  topologicalOperationIds,
  type ChangePlan,
  type ResolvedOperation,
} from "../../domain/plan.js";
import type { AccountBinding } from "../../domain/repository.js";
import {
  parseChangeRun,
  parseRunOperation,
  type ChangeRun,
  type FailureMode,
  type RunOperation,
  type RunOperationStatus,
} from "../../domain/run.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";
import type {
  GitHubCapabilities,
  GitHubStatusReadPort,
} from "../ports/github-port.js";
import type { Clock, IdGenerator } from "../ports/runtime-port.js";
import type {
  LeaseGuard,
  StoragePort,
  StorageTransaction,
} from "../ports/storage-port.js";
import type {
  ExecutionContext,
  MutationExecutor,
  PreparedMutation,
  PrepareMutationResult,
} from "./mutation-executor.js";
import type { ExecutionOutcome, MutationPacer } from "./mutation-pacer.js";
import {
  appendCleanupDiagnostic,
  LeaseScope,
  type LeaseScheduler,
} from "./lease-scope.js";

export type ApplyInput = Readonly<{
  planId: PlanId;
  expectedHash: string;
  failureMode: FailureMode;
}>;

export type ApplyResult = Readonly<{
  run: ChangeRun;
  warnings: readonly string[];
  counts: Readonly<Record<RunOperationStatus, number>>;
  errors: readonly SerializedDomainError[];
  auditCursor: string | null;
}>;

type ApplyRuntime = Clock & Pick<IdGenerator, "requestId" | "runId">;
type ApplyExecutor = Pick<
  MutationExecutor,
  | "readCurrentState"
  | "matchesBefore"
  | "matchesAfter"
  | "prepare"
  | "dispatchPrepared"
>;
type ApplyPacer = Pick<MutationPacer, "run" | "waitForSafetyWindow">;

export type ApplyServiceOptions = Readonly<{
  github: GitHubStatusReadPort;
  storage: StoragePort;
  runtime: ApplyRuntime;
  executor: ApplyExecutor;
  pacer: ApplyPacer;
  config: Pick<AppConfig, "readOnly"> &
    Partial<Pick<AppConfig, "writeIntervalMs">>;
  instanceId: string;
  leaseScheduler?: LeaseScheduler;
}>;

const HASH = /^[a-f0-9]{64}$/u;
const DEFAULT_WRITE_INTERVAL_MS = 1_000;
const BASE_LEASE_MS = 10 * 60_000;
const LEASE_HEARTBEAT_MS = 60_000;
const MAX_ERRORS = 20;
const MAX_ATTEMPTS = 3;

type JsonRecord = Readonly<Record<string, JsonValue>>;

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function errorObject(error: unknown): Error {
  return error instanceof Error
    ? error
    : new AppError("INTERNAL_ERROR", "An unexpected apply failure occurred", {
        retryable: false,
        details: { reason: "non_error_failure" },
      });
}

function validationError(reason: string): AppError {
  return new AppError("VALIDATION_ERROR", "Apply input is invalid", {
    retryable: false,
    details: { reason },
  });
}

function storageFailure(reason: string, cause?: unknown): AppError {
  return new AppError("STORAGE_ERROR", "Apply storage failed", {
    retryable: false,
    details: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

function githubFailure(reason: string, cause?: unknown): AppError {
  return new AppError("GITHUB_UNAVAILABLE", "Apply admission failed", {
    retryable: true,
    details: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalidRuntime(reason: string): AppError {
  return new AppError("INTERNAL_ERROR", "Apply runtime returned invalid data", {
    retryable: false,
    details: { reason },
  });
}

function fixedAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signalAborted(signal)) throw fixedAbortError();
}

function jsonRecord(value: JsonValue, reason: string): JsonRecord {
  if (value === null || typeof value !== "object" || isJsonArray(value)) {
    throw validationError(reason);
  }
  return value;
}

function parseInput(input: ApplyInput): ApplyInput {
  let cloned: JsonValue;
  try {
    cloned = canonicalJsonClone(input);
  } catch {
    throw validationError("invalid_shape");
  }
  const root = jsonRecord(cloned, "invalid_shape");
  const keys = Object.keys(root);
  if (
    keys.length !== 3 ||
    keys.some(
      (key) =>
        key !== "planId" && key !== "expectedHash" && key !== "failureMode",
    ) ||
    typeof root.planId !== "string" ||
    typeof root.expectedHash !== "string" ||
    !HASH.test(root.expectedHash) ||
    (root.failureMode !== "stop" && root.failureMode !== "continue")
  ) {
    throw validationError("invalid_shape");
  }
  let planId: PlanId;
  try {
    planId = asPlanId(root.planId);
  } catch {
    throw validationError("invalid_plan_id");
  }
  return Object.freeze({
    planId,
    expectedHash: root.expectedHash,
    failureMode: root.failureMode,
  });
}

function safeNow(runtime: Clock): string {
  try {
    return canonicalUtcTimestamp(runtime.now(), "apply time");
  } catch {
    throw invalidRuntime("invalid_wall_clock");
  }
}

function stableInstanceId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw validationError("invalid_instance_id");
  }
  return value;
}

function writeInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_WRITE_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < DEFAULT_WRITE_INTERVAL_MS) {
    throw validationError("invalid_write_interval");
  }
  return interval;
}

function runId(runtime: Pick<IdGenerator, "runId">) {
  try {
    return asRunId(runtime.runId());
  } catch {
    throw invalidRuntime("invalid_run_id");
  }
}

function requestId(runtime: Pick<IdGenerator, "requestId">): string {
  let value: string;
  try {
    value = runtime.requestId();
  } catch {
    throw invalidRuntime("invalid_request_id");
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw invalidRuntime("invalid_request_id");
  }
  return value;
}

function storageCall<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageFailure("storage_call_failed", error);
  }
}

function sameBinding(left: AccountBinding, right: AccountBinding): boolean {
  return (
    left.host === right.host &&
    left.login === right.login &&
    left.accountId === right.accountId
  );
}

function stableText(value: JsonValue | undefined, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw githubFailure("invalid_identity");
  }
  return value;
}

function parseBinding(value: AccountBinding): AccountBinding {
  let cloned: JsonValue;
  try {
    cloned = canonicalJsonClone(value);
  } catch {
    throw githubFailure("invalid_identity");
  }
  const root = jsonRecord(cloned, "invalid_identity");
  const keys = Object.keys(root);
  if (
    keys.length !== 3 ||
    keys.some((key) => key !== "host" && key !== "login" && key !== "accountId")
  ) {
    throw githubFailure("invalid_identity");
  }
  return Object.freeze({
    host: stableText(root.host, 253),
    login: stableText(root.login, 100),
    accountId: stableText(root.accountId, 128),
  });
}

function capability(
  value: JsonValue | undefined,
): "available" | "unavailable" | "unknown" {
  if (value !== "available" && value !== "unavailable" && value !== "unknown") {
    throw githubFailure("invalid_capabilities");
  }
  return value;
}

function parseCapabilities(value: GitHubCapabilities): GitHubCapabilities {
  let cloned: JsonValue;
  try {
    cloned = canonicalJsonClone(value);
  } catch {
    throw githubFailure("invalid_capabilities");
  }
  const root = jsonRecord(cloned, "invalid_capabilities");
  const keys = Object.keys(root);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        key !== "starRead" &&
        key !== "starWrite" &&
        key !== "listRead" &&
        key !== "listWrite",
    )
  ) {
    throw githubFailure("invalid_capabilities");
  }
  return Object.freeze({
    starRead: capability(root.starRead),
    starWrite: capability(root.starWrite),
    listRead: capability(root.listRead),
    listWrite: capability(root.listWrite),
  });
}

function assertPlanHash(plan: ChangePlan, expectedHash: string): void {
  let recomputed: string;
  try {
    recomputed = hashPlanExecutable(plan.executable);
  } catch {
    throw new AppError(
      "PLAN_HASH_MISMATCH",
      "The persisted plan executable could not be verified",
      { retryable: false },
    );
  }
  if (
    !HASH.test(plan.hash) ||
    recomputed !== plan.hash ||
    expectedHash !== plan.hash
  ) {
    throw new AppError(
      "PLAN_HASH_MISMATCH",
      "The expected and persisted plan hashes do not match",
      { retryable: false },
    );
  }
}

function assertPlanAvailable(plan: ChangePlan, now: string): void {
  if (plan.state === "expired" || now >= plan.expiresAt) {
    throw new AppError("PLAN_EXPIRED", "The change plan has expired", {
      retryable: false,
    });
  }
  if (plan.state === "failed" || plan.state === "superseded") {
    throw new AppError(
      "PRECONDITION_FAILED",
      "The change plan cannot be applied from its current state",
      {
        retryable: false,
        details: { state: plan.state },
      },
    );
  }
}

function requiredWriteCapabilities(
  plan: ChangePlan,
): readonly ("starWrite" | "listWrite")[] {
  let star = false;
  let list = false;
  for (const operation of plan.operations) {
    if (operation.kind === "star" || operation.kind === "unstar") {
      star = true;
    } else {
      list = true;
    }
  }
  return Object.freeze([
    ...(star ? (["starWrite"] as const) : []),
    ...(list ? (["listWrite"] as const) : []),
  ]);
}

function capabilityWarning(name: "starWrite" | "listWrite"): string {
  return name === "starWrite"
    ? "GitHub Star write capability is unknown; the first mutation will verify permission"
    : "GitHub User List write capability is unknown; the first mutation will verify permission";
}

function capabilityUnavailable(name: "starWrite" | "listWrite"): AppError {
  return new AppError(
    "CAPABILITY_UNAVAILABLE",
    name === "starWrite"
      ? "GitHub Star write capability is unavailable"
      : "GitHub User List write capability is unavailable",
    {
      retryable: false,
      details: {
        reason:
          name === "starWrite"
            ? "star_write_unavailable"
            : "list_write_unavailable",
      },
    },
  );
}

function warningsFor(
  plan: ChangePlan,
  capabilities: GitHubCapabilities,
): readonly string[] {
  const warnings = [...plan.warnings];
  for (const name of requiredWriteCapabilities(plan)) {
    if (capabilities[name] === "unavailable") {
      throw capabilityUnavailable(name);
    }
    if (capabilities[name] === "unknown") {
      const warning = capabilityWarning(name);
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  return Object.freeze(warnings);
}

function completedReplay(
  storage: StoragePort,
  plan: ChangePlan,
  binding: AccountBinding,
): ChangeRun | null {
  if (plan.state !== "applied") return null;
  const run = storageCall(() => storage.getLatestRunForPlan(plan.id));
  if (
    run === null ||
    run.state !== "completed" ||
    run.planId !== plan.id ||
    !sameBinding(run.binding, binding)
  ) {
    throw new AppError(
      "PRECONDITION_FAILED",
      "The applied plan does not have a valid completed run",
      {
        retryable: false,
        details: { reason: "completed_replay_invalid" },
      },
    );
  }
  return run;
}

type Claim = Readonly<{
  plan: ChangePlan;
  run: ChangeRun;
  completed: boolean;
}>;

function revalidateClaimPlan(
  plan: ChangePlan | null,
  input: ApplyInput,
  binding: AccountBinding,
  now: string,
): ChangePlan {
  if (plan === null) {
    throw new AppError("NOT_FOUND", "The change plan was not found", {
      retryable: false,
    });
  }
  assertPlanHash(plan, input.expectedHash);
  assertPlanAvailable(plan, now);
  if (!sameBinding(plan.executable.binding, binding)) {
    throw new AppError(
      "PLAN_ACCOUNT_MISMATCH",
      "The authenticated account does not match the change plan",
      { retryable: false },
    );
  }
  return plan;
}

function claimRun(
  tx: StorageTransaction,
  input: ApplyInput,
  admittedPlan: ChangePlan,
  binding: AccountBinding,
  warnings: readonly string[],
  runtime: ApplyRuntime,
  guard: LeaseGuard,
): Claim {
  const plan = revalidateClaimPlan(
    tx.getPlan(input.planId),
    input,
    binding,
    safeNow(runtime),
  );
  if (plan.hash !== admittedPlan.hash) {
    throw new AppError(
      "PLAN_HASH_MISMATCH",
      "The change plan changed during admission",
      { retryable: false },
    );
  }
  const existing = tx.getLatestRunForPlan(plan.id);
  if (existing !== null) {
    if (existing.failureMode !== input.failureMode) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "A resumed apply must preserve its original failure mode",
        {
          retryable: false,
          details: { reason: "failure_mode_conflict" },
        },
      );
    }
    if (existing.state === "completed" && plan.state === "applied") {
      return Object.freeze({ plan, run: existing, completed: true });
    }
    if (existing.state !== "partial" || plan.state !== "partial") {
      throw new AppError(
        "PRECONDITION_FAILED",
        "The existing apply run is not resumable",
        {
          retryable: false,
          details: { reason: "run_not_resumable" },
        },
      );
    }
    tx.compareAndSetPlanState({
      planId: plan.id,
      expected: ["partial"],
      next: "applying",
    });
    const run = tx.compareAndSetRunState({
      runId: existing.id,
      expected: ["partial"],
      next: "running",
      finishedAt: null,
      lease: guard,
    });
    return Object.freeze({
      plan: Object.freeze({ ...plan, state: "applying" }),
      run,
      completed: false,
    });
  }

  if (plan.state !== "ready") {
    throw new AppError(
      "PRECONDITION_FAILED",
      "The change plan is not ready to apply",
      {
        retryable: false,
        details: { state: plan.state },
      },
    );
  }
  tx.compareAndSetPlanState({
    planId: plan.id,
    expected: ["ready"],
    next: "applying",
  });
  const pending = parseChangeRun({
    id: runId(runtime),
    planId: plan.id,
    binding,
    state: "pending",
    failureMode: input.failureMode,
    warnings,
    startedAt: safeNow(runtime),
    finishedAt: null,
  });
  tx.createRun({ run: pending, lease: guard });
  const run = tx.compareAndSetRunState({
    runId: pending.id,
    expected: ["pending"],
    next: "running",
    finishedAt: null,
    lease: guard,
  });
  return Object.freeze({
    plan: Object.freeze({ ...plan, state: "applying" }),
    run,
    completed: false,
  });
}

function pendingOperation(
  run: ChangeRun,
  operation: ResolvedOperation,
  sequence: number,
): RunOperation {
  return parseRunOperation({
    runId: run.id,
    operationId: operation.operationId,
    sequence,
    status: "pending",
    reconciliation: "not_required",
    attempts: 0,
    before: operation.before,
    after: null,
    externalRequestId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  });
}

function retryableCancellation(): SerializedDomainError {
  return serializeError(
    new AppError(
      "GITHUB_UNAVAILABLE",
      "Mutation dispatch was cancelled before it started",
      {
        retryable: true,
        details: { reason: "cancelled_before_dispatch" },
      },
    ),
  );
}

function unknownDispatchError(error: unknown): SerializedDomainError & {
  readonly retryable: false;
} {
  const serialized = serializeError(
    error instanceof AppError && error.code === "RECONCILIATION_REQUIRED"
      ? error
      : new AppError(
          "RECONCILIATION_REQUIRED",
          "The mutation outcome requires reconciliation",
          {
            retryable: false,
            details: { reason: "dispatch_outcome_unknown" },
            cause: error,
          },
        ),
  );
  return Object.freeze({ ...serialized, retryable: false });
}

function isCancellation(error: unknown, signal: AbortSignal | undefined) {
  return (
    signalAborted(signal) ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof AppError &&
      error.code === "GITHUB_UNAVAILABLE" &&
      typeof error.details === "object" &&
      error.details !== null &&
      !isJsonArray(error.details) &&
      error.details.reason === "cancelled")
  );
}

async function executePendingOperation(input: {
  storage: StoragePort;
  runtime: ApplyRuntime;
  executor: ApplyExecutor;
  pacer: ApplyPacer;
  lease: LeaseScope;
  run: ChangeRun;
  operation: ResolvedOperation;
  sequence: number;
  context: ExecutionContext;
  createWriteAhead: boolean;
  callerSignal?: AbortSignal;
}): Promise<RunOperation> {
  if (input.createWriteAhead) {
    const row = pendingOperation(input.run, input.operation, input.sequence);
    storageCall(() =>
      input.storage.createRunOperation({
        operation: row,
        lease: input.lease.freshGuard(),
      }),
    );
  } else {
    const queued = storageCall(() =>
      input.storage.getRunOperation({
        runId: input.run.id,
        operationId: input.operation.operationId,
      }),
    );
    if (queued?.status !== "pending") {
      throw storageFailure("retry_was_not_queued");
    }
  }

  let attemptStarted = false;
  let remoteDispatchEntered = false;
  let executionOutcomeAvailable = false;
  let prepared: PreparedMutation | null = null;
  try {
    const outcome = await input.pacer.run({
      signal: input.lease.signal,
      prepare: async (): Promise<PrepareMutationResult> => {
        const value = await input.executor.prepare(
          input.operation,
          input.context,
          input.lease.signal,
        );
        if (value.kind === "dispatch") prepared = value.prepared;
        return value;
      },
      dispatch: (value: PreparedMutation): Promise<ExecutionOutcome> => {
        input.lease.assertActive();
        const guard = input.lease.renew();
        storageCall(() =>
          input.storage.startRunOperation({
            runId: input.run.id,
            operationId: input.operation.operationId,
            startedAt: safeNow(input.runtime),
            lease: guard,
          }),
        );
        attemptStarted = true;
        input.lease.assertActive();
        remoteDispatchEntered = true;
        return input.executor.dispatchPrepared(
          value,
          input.context,
          input.lease.signal,
        );
      },
    });
    executionOutcomeAvailable = true;

    if (outcome.kind === "skipped") {
      const guard = input.lease.freshGuard();
      return storageCall(() =>
        input.storage.finishRunOperation({
          phase: "before_dispatch",
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "skipped",
          reconciliation: "not_required",
          error: null,
          finishedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
    }
    const guard = input.lease.freshGuard();
    return storageCall(() =>
      input.storage.finishRunOperation({
        phase: "after_dispatch",
        runId: input.run.id,
        operationId: input.operation.operationId,
        status: "succeeded",
        reconciliation: "not_required",
        externalRequestId: outcome.receipt.requestId,
        after: outcome.after,
        error: null,
        finishedAt: safeNow(input.runtime),
        lease: guard,
      }),
    );
  } catch (error) {
    if (executionOutcomeAvailable) throw error;
    const cancelled = isCancellation(error, input.callerSignal);
    let finished: RunOperation;
    if (!attemptStarted) {
      const guard = input.lease.freshGuard();
      finished = storageCall(() =>
        input.storage.finishRunOperation({
          phase: "before_dispatch",
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          error: cancelled ? retryableCancellation() : serializeError(error),
          finishedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
    } else if (!remoteDispatchEntered) {
      const guard = input.lease.freshGuard();
      finished = storageCall(() =>
        input.storage.finishRunOperation({
          phase: "after_dispatch",
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          externalRequestId: null,
          after: prepared?.before ?? null,
          error: cancelled ? retryableCancellation() : serializeError(error),
          finishedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
    } else if (
      error instanceof AppError &&
      error.code !== "RECONCILIATION_REQUIRED" &&
      !cancelled
    ) {
      const guard = input.lease.freshGuard();
      finished = storageCall(() =>
        input.storage.finishRunOperation({
          phase: "after_dispatch",
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          externalRequestId: null,
          after: prepared?.before ?? null,
          error: serializeError(error),
          finishedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
    } else {
      const guard = input.lease.freshGuard();
      finished = storageCall(() =>
        input.storage.finishRunOperation({
          phase: "after_dispatch",
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "unresolved",
          reconciliation: "unknown",
          externalRequestId: null,
          after: null,
          error: unknownDispatchError(error),
          finishedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
    }
    if (cancelled) throw fixedAbortError();
    return finished;
  }
}

function dependencyBlockedError(
  operation: ResolvedOperation,
): SerializedDomainError {
  return serializeError(
    new AppError(
      "PRECONDITION_FAILED",
      "The operation is blocked by an incomplete dependency",
      {
        retryable: true,
        details: {
          reason: "dependency_blocked",
          operationId: operation.operationId,
          dependsOn: operation.dependsOn,
        },
      },
    ),
  );
}

function recordDependencyBlocked(input: {
  storage: StoragePort;
  runtime: ApplyRuntime;
  lease: LeaseScope;
  run: ChangeRun;
  operation: ResolvedOperation;
  sequence: number;
  existing: RunOperation | null;
}): RunOperation {
  if (input.existing !== null) return input.existing;
  storageCall(() =>
    input.storage.createRunOperation({
      operation: pendingOperation(input.run, input.operation, input.sequence),
      lease: input.lease.freshGuard(),
    }),
  );
  const guard = input.lease.freshGuard();
  return storageCall(() =>
    input.storage.finishRunOperation({
      phase: "before_dispatch",
      runId: input.run.id,
      operationId: input.operation.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      error: dependencyBlockedError(input.operation),
      finishedAt: safeNow(input.runtime),
      lease: guard,
    }),
  );
}

function createdListIdFrom(row: RunOperation, operation: ResolvedOperation) {
  if (operation.kind !== "list_create" || row.status !== "succeeded") {
    return null;
  }
  if (
    row.after === null ||
    typeof row.after !== "object" ||
    isJsonArray(row.after) ||
    typeof row.after.listId !== "string"
  ) {
    throw storageFailure("succeeded_list_create_missing_list_id");
  }
  try {
    return asUserListId(row.after.listId);
  } catch {
    throw storageFailure("succeeded_list_create_missing_list_id");
  }
}

function rebuildExecutionContext(
  plan: ChangePlan,
  rows: readonly RunOperation[],
): ExecutionContext {
  const operations = new Map(
    plan.operations.map((operation) => [operation.operationId, operation]),
  );
  const createdListIdsByOperationId = new Map<
    string,
    ReturnType<typeof asUserListId>
  >();
  for (const row of rows) {
    const operation = operations.get(row.operationId);
    if (operation === undefined) {
      throw storageFailure("run_operation_not_in_plan");
    }
    const listId = createdListIdFrom(row, operation);
    if (listId !== null) {
      createdListIdsByOperationId.set(operation.operationId, listId);
    }
  }
  return { createdListIdsByOperationId };
}

function reconciliationUnknown(
  error: unknown,
): SerializedDomainError & { readonly retryable: false } {
  const serialized = serializeError(
    new AppError(
      "RECONCILIATION_REQUIRED",
      "The live state could not confirm the previous mutation outcome",
      {
        retryable: false,
        details: { reason: "reconciliation_inconclusive" },
        cause: error,
      },
    ),
  );
  return Object.freeze({ ...serialized, retryable: false });
}

function reconciliationNotApplied(): SerializedDomainError & {
  readonly retryable: true;
} {
  const serialized = serializeError(
    new AppError(
      "GITHUB_UNAVAILABLE",
      "Reconciliation confirmed that the mutation was not applied",
      {
        retryable: true,
        details: { reason: "reconciled_not_applied" },
      },
    ),
  );
  return Object.freeze({ ...serialized, retryable: true });
}

type ResumeDecision = Readonly<{
  row: RunOperation;
  execute: boolean;
}>;

async function reconcileForResume(input: {
  storage: StoragePort;
  runtime: ApplyRuntime;
  executor: ApplyExecutor;
  lease: LeaseScope;
  run: ChangeRun;
  operation: ResolvedOperation;
  row: RunOperation;
  context: ExecutionContext;
  callerSignal?: AbortSignal;
}): Promise<ResumeDecision> {
  if (
    input.row.status !== "unresolved" &&
    !(input.row.status === "failed" && input.row.error?.retryable === true)
  ) {
    return Object.freeze({ row: input.row, execute: false });
  }
  if (input.row.attempts >= MAX_ATTEMPTS) {
    return Object.freeze({ row: input.row, execute: false });
  }

  let state: JsonValue;
  try {
    input.lease.assertActive();
    state = await input.executor.readCurrentState(
      input.operation,
      input.context,
      input.lease.signal,
    );
    input.lease.assertActive();
  } catch (error) {
    if (isCancellation(error, input.callerSignal)) throw fixedAbortError();
    input.lease.assertActive();
    if (input.row.status === "unresolved") {
      const guard = input.lease.freshGuard();
      const row = storageCall(() =>
        input.storage.reconcileRunOperation({
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "unresolved",
          reconciliation: "unknown",
          after: input.row.after,
          error: reconciliationUnknown(error),
          observedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
      return Object.freeze({ row, execute: false });
    }
    return Object.freeze({ row: input.row, execute: false });
  }

  const matchesAfter = input.executor.matchesAfter(
    input.operation,
    state,
    input.context,
  );
  const matchesBefore = input.executor.matchesBefore(
    input.operation,
    state,
    input.context,
  );
  if (input.row.status === "unresolved") {
    if (matchesAfter) {
      const guard = input.lease.freshGuard();
      const row = storageCall(() =>
        input.storage.reconcileRunOperation({
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "succeeded",
          reconciliation: "confirmed_applied",
          after: state,
          error: null,
          observedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
      return Object.freeze({ row, execute: false });
    }
    if (
      !matchesBefore ||
      (input.operation.kind === "list_create" &&
        !input.context.createdListIdsByOperationId.has(
          input.operation.operationId,
        ))
    ) {
      const guard = input.lease.freshGuard();
      const row = storageCall(() =>
        input.storage.reconcileRunOperation({
          runId: input.run.id,
          operationId: input.operation.operationId,
          status: "unresolved",
          reconciliation: "unknown",
          after: state,
          error: reconciliationUnknown(input.row.error),
          observedAt: safeNow(input.runtime),
          lease: guard,
        }),
      );
      return Object.freeze({ row, execute: false });
    }
    const guard = input.lease.freshGuard();
    input.row = storageCall(() =>
      input.storage.reconcileRunOperation({
        runId: input.run.id,
        operationId: input.operation.operationId,
        status: "failed",
        reconciliation: "confirmed_not_applied",
        after: state,
        error: reconciliationNotApplied(),
        observedAt: safeNow(input.runtime),
        lease: guard,
      }),
    );
  } else if (!matchesBefore && !matchesAfter) {
    return Object.freeze({ row: input.row, execute: false });
  }

  const guard = input.lease.freshGuard();
  const queued = storageCall(() =>
    input.storage.retryRunOperation({
      runId: input.run.id,
      operationId: input.operation.operationId,
      maxAttempts: MAX_ATTEMPTS,
      lease: guard,
    }),
  );
  return Object.freeze({ row: queued, execute: true });
}

function aggregateCounts(
  operations: readonly RunOperation[],
): Readonly<Record<RunOperationStatus, number>> {
  const counts: Record<RunOperationStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    unresolved: 0,
  };
  for (const operation of operations) counts[operation.status] += 1;
  return Object.freeze(counts);
}

function resultFor(storage: StoragePort, run: ChangeRun): ApplyResult {
  const operations = storageCall(() => storage.listRunOperations(run.id));
  const errors = Object.freeze(
    operations
      .map((operation) => operation.error)
      .filter((error): error is SerializedDomainError => error !== null)
      .slice(0, MAX_ERRORS),
  );
  return Object.freeze({
    run,
    warnings: run.warnings,
    counts: aggregateCounts(operations),
    errors,
    auditCursor: operations.length === 0 ? null : run.id,
  });
}

function finalizeRun(input: {
  storage: StoragePort;
  runtime: ApplyRuntime;
  lease: LeaseScope;
  plan: ChangePlan;
  run: ChangeRun;
}): ChangeRun {
  const guard = input.lease.freshGuard();
  return storageCall(() =>
    input.storage.withTransaction((tx) => {
      const rows = tx.listRunOperations(input.run.id);
      if (
        rows.some((row) => row.status === "pending" || row.status === "running")
      ) {
        throw storageFailure("run_operations_in_flight");
      }
      const complete =
        rows.length === input.plan.operations.length &&
        rows.every(
          (row) => row.status === "succeeded" || row.status === "skipped",
        );
      const finishedAt = safeNow(input.runtime);
      const run = tx.compareAndSetRunState({
        runId: input.run.id,
        expected: ["running"],
        next: complete ? "completed" : "partial",
        finishedAt,
        lease: guard,
      });
      tx.compareAndSetPlanState({
        planId: input.plan.id,
        expected: ["applying"],
        next: complete ? "applied" : "partial",
      });
      return run;
    }),
  );
}

export class ApplyService {
  readonly #github: GitHubStatusReadPort;
  readonly #storage: StoragePort;
  readonly #runtime: ApplyRuntime;
  readonly #executor: ApplyExecutor;
  readonly #pacer: ApplyPacer;
  readonly #readOnly: boolean;
  readonly #writeIntervalMs: number;
  readonly #instanceId: string;
  readonly #leaseScheduler: LeaseScheduler | undefined;

  constructor(options: ApplyServiceOptions) {
    this.#github = options.github;
    this.#storage = options.storage;
    this.#runtime = options.runtime;
    this.#executor = options.executor;
    this.#pacer = options.pacer;
    this.#readOnly = options.config.readOnly;
    this.#writeIntervalMs = writeInterval(options.config.writeIntervalMs);
    this.#instanceId = stableInstanceId(options.instanceId);
    this.#leaseScheduler = options.leaseScheduler;
  }

  async apply(input: ApplyInput, signal?: AbortSignal): Promise<ApplyResult> {
    if (this.#readOnly) {
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "Apply is disabled while the server is read-only",
        {
          retryable: false,
          details: { reason: "read_only" },
        },
      );
    }
    assertNotAborted(signal);
    const parsed = parseInput(input);
    const plan = storageCall(() => this.#storage.getPlan(parsed.planId));
    if (plan === null) {
      throw new AppError("NOT_FOUND", "The change plan was not found", {
        retryable: false,
      });
    }
    assertPlanHash(plan, parsed.expectedHash);

    let viewer: AccountBinding;
    try {
      viewer = parseBinding(await this.#github.getViewer(signal));
      assertNotAborted(signal);
    } catch (error) {
      assertNotAborted(signal);
      if (error instanceof AppError) throw error;
      throw githubFailure("admission_failed", error);
    }
    if (!sameBinding(plan.executable.binding, viewer)) {
      throw new AppError(
        "PLAN_ACCOUNT_MISMATCH",
        "The authenticated account does not match the change plan",
        { retryable: false },
      );
    }
    const replay = completedReplay(this.#storage, plan, viewer);
    if (replay !== null) return resultFor(this.#storage, replay);
    assertPlanAvailable(plan, safeNow(this.#runtime));

    let capabilities: GitHubCapabilities;
    try {
      capabilities = parseCapabilities(
        await this.#github.probeCapabilities(signal),
      );
      assertNotAborted(signal);
    } catch (error) {
      assertNotAborted(signal);
      if (error instanceof AppError) throw error;
      throw githubFailure("admission_failed", error);
    }
    const warnings = warningsFor(plan, capabilities);
    const leaseName = `apply:${viewer.host}:${sha256Hex(viewer.accountId).slice(
      0,
      16,
    )}`;
    const durationMs = Math.max(
      BASE_LEASE_MS,
      this.#writeIntervalMs + LEASE_HEARTBEAT_MS,
    );
    const scope = LeaseScope.acquire({
      storage: this.#storage,
      runtime: this.#runtime,
      name: leaseName,
      ownerId: `${this.#instanceId}:${requestId(this.#runtime)}`,
      ttlMs: durationMs,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#leaseScheduler === undefined
        ? {}
        : { scheduler: this.#leaseScheduler }),
    });

    return scope.run(async (lease) => {
      let primary: unknown;
      let result: ApplyResult | undefined;
      try {
        lease.assertActive();
        const claimGuard = lease.freshGuard();
        const claim = storageCall(() =>
          this.#storage.withTransaction((tx) => {
            tx.recoverAbandonedRuns({
              binding: viewer,
              lease: claimGuard,
            });
            return claimRun(
              tx,
              parsed,
              plan,
              viewer,
              warnings,
              this.#runtime,
              claimGuard,
            );
          }),
        );
        if (claim.completed) {
          result = resultFor(this.#storage, claim.run);
        } else {
          const existingRows = storageCall(() =>
            this.#storage.listRunOperations(claim.run.id),
          );
          const context = rebuildExecutionContext(claim.plan, existingRows);
          const rowsById = new Map(
            existingRows.map((row) => [row.operationId, row]),
          );
          const byId = new Map(
            claim.plan.operations.map((operation) => [
              operation.operationId,
              operation,
            ]),
          );
          const sequenceById = new Map(
            claim.plan.operations.map((operation, sequence) => [
              operation.operationId,
              sequence,
            ]),
          );
          let operationFailure: unknown;
          for (const operationId of topologicalOperationIds(
            claim.plan.operations,
            claim.plan.dependencies,
          )) {
            const operation = byId.get(operationId);
            const sequence = sequenceById.get(operationId);
            if (operation === undefined || sequence === undefined) {
              throw storageFailure("plan_operation_missing");
            }
            let current = rowsById.get(operation.operationId) ?? null;
            if (
              current?.status === "succeeded" ||
              current?.status === "skipped"
            ) {
              continue;
            }
            const dependenciesComplete = operation.dependsOn.every(
              (dependencyId) => {
                const dependency = rowsById.get(dependencyId);
                return (
                  dependency?.status === "succeeded" ||
                  dependency?.status === "skipped"
                );
              },
            );
            if (!dependenciesComplete) {
              current = recordDependencyBlocked({
                storage: this.#storage,
                runtime: this.#runtime,
                lease,
                run: claim.run,
                operation,
                sequence,
                existing: current,
              });
              rowsById.set(operation.operationId, current);
              if (parsed.failureMode === "stop") break;
              continue;
            }

            let createWriteAhead = current === null;
            if (current !== null) {
              const decision = await reconcileForResume({
                storage: this.#storage,
                runtime: this.#runtime,
                executor: this.#executor,
                lease,
                run: claim.run,
                operation,
                row: current,
                context,
                ...(signal === undefined ? {} : { callerSignal: signal }),
              });
              current = decision.row;
              rowsById.set(operation.operationId, current);
              if (!decision.execute) {
                if (
                  parsed.failureMode === "stop" &&
                  current.status !== "succeeded" &&
                  current.status !== "skipped"
                ) {
                  break;
                }
                continue;
              }
              createWriteAhead = false;
            }
            try {
              const finished = await executePendingOperation({
                storage: this.#storage,
                runtime: this.#runtime,
                executor: this.#executor,
                pacer: this.#pacer,
                lease,
                run: claim.run,
                operation,
                sequence,
                context,
                createWriteAhead,
                ...(signal === undefined ? {} : { callerSignal: signal }),
              });
              rowsById.set(operation.operationId, finished);
              if (
                parsed.failureMode === "stop" &&
                finished.status !== "succeeded" &&
                finished.status !== "skipped"
              ) {
                break;
              }
            } catch (error) {
              operationFailure = error;
              break;
            }
          }
          if (operationFailure !== undefined) {
            const interruptedRows = storageCall(() =>
              this.#storage.listRunOperations(claim.run.id),
            );
            if (
              interruptedRows.some(
                (row) => row.status === "pending" || row.status === "running",
              )
            ) {
              throw errorObject(operationFailure);
            }
          }
          const run = finalizeRun({
            storage: this.#storage,
            runtime: this.#runtime,
            lease,
            plan: claim.plan,
            run: claim.run,
          });
          if (operationFailure !== undefined)
            throw errorObject(operationFailure);
          result = resultFor(this.#storage, run);
        }
      } catch (error) {
        primary = error;
      }

      let cleanup: unknown;
      let safetyLeaseRenewed = false;
      try {
        lease.renew(this.#writeIntervalMs + LEASE_HEARTBEAT_MS);
        safetyLeaseRenewed = true;
        await this.#pacer.waitForSafetyWindow();
      } catch (error) {
        if (safetyLeaseRenewed) lease.retainUntilExpiry();
        cleanup = error;
      }
      if (primary !== undefined) {
        if (cleanup !== undefined) appendCleanupDiagnostic(primary, cleanup);
        throw errorObject(primary);
      }
      if (cleanup !== undefined) throw errorObject(cleanup);
      return result as ApplyResult;
    });
  }
}
