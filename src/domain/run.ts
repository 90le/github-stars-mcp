import { canonicalJsonClone, freezeJsonValue } from "./canonical-json.js";
import {
  APP_ERROR_CODES,
  AppError,
  type AppErrorCode,
  type SerializedDomainError,
} from "./errors.js";
import { asPlanId, asRunId, type PlanId, type RunId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { AccountBinding } from "./repository.js";
import { canonicalUtcTimestamp } from "./timestamp.js";

export type FailureMode = "stop" | "continue";
export type RunState =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed";
export type RunOperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "unresolved";
export type ReconciliationStatus =
  | "not_required"
  | "pending"
  | "confirmed_applied"
  | "confirmed_not_applied"
  | "unknown";

export interface ChangeRun {
  readonly id: RunId;
  readonly planId: PlanId;
  readonly binding: AccountBinding;
  readonly state: RunState;
  readonly failureMode: FailureMode;
  readonly warnings: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RunOperation {
  readonly runId: RunId;
  readonly operationId: string;
  readonly sequence: number;
  readonly status: RunOperationStatus;
  readonly reconciliation: ReconciliationStatus;
  readonly attempts: number;
  readonly before: JsonValue;
  readonly after: JsonValue;
  readonly externalRequestId: string | null;
  readonly error: SerializedDomainError | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export type RunOperationAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "unresolved";

interface RunOperationAttemptBase {
  readonly runId: RunId;
  readonly operationId: string;
  readonly attempt: number;
  readonly before: JsonValue;
  readonly startedAt: string;
}

export type RunOperationAttempt =
  | Readonly<
      RunOperationAttemptBase & {
        status: "running";
        reconciliation: "pending";
        after: null;
        externalRequestId: null;
        error: null;
        finishedAt: null;
      }
    >
  | Readonly<
      RunOperationAttemptBase & {
        status: "succeeded";
        reconciliation: "not_required";
        after: JsonValue;
        externalRequestId: string | null;
        error: null;
        finishedAt: string;
      }
    >
  | Readonly<
      RunOperationAttemptBase & {
        status: "failed";
        reconciliation: "confirmed_not_applied";
        after: JsonValue;
        externalRequestId: string | null;
        error: SerializedDomainError;
        finishedAt: string;
      }
    >
  | Readonly<
      RunOperationAttemptBase & {
        status: "unresolved";
        reconciliation: "unknown";
        after: JsonValue;
        externalRequestId: string | null;
        error: SerializedDomainError & { readonly retryable: false };
        finishedAt: string;
      }
    >;

interface RunOperationReconciliationBase {
  readonly runId: RunId;
  readonly operationId: string;
  readonly attempt: number;
  readonly eventSequence: number;
  readonly after: JsonValue;
  readonly observedAt: string;
}

export type RunOperationReconciliation =
  | Readonly<
      RunOperationReconciliationBase & {
        status: "succeeded";
        reconciliation: "confirmed_applied";
        error: null;
      }
    >
  | Readonly<
      RunOperationReconciliationBase & {
        status: "failed";
        reconciliation: "confirmed_not_applied";
        error: SerializedDomainError & { readonly retryable: true };
      }
    >
  | Readonly<
      RunOperationReconciliationBase & {
        status: "unresolved";
        reconciliation: "unknown";
        error: SerializedDomainError & { readonly retryable: false };
      }
    >;

type SafeRecord = Record<string, JsonValue>;

const RUN_STATES = new Set<RunState>([
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
]);
const FAILURE_MODES = new Set<FailureMode>(["stop", "continue"]);
const OPERATION_STATUSES = new Set<RunOperationStatus>([
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "unresolved",
]);
const RECONCILIATION_STATUSES = new Set<ReconciliationStatus>([
  "not_required",
  "pending",
  "confirmed_applied",
  "confirmed_not_applied",
  "unknown",
]);
const ERROR_CODES = new Set<AppErrorCode>(APP_ERROR_CODES);
const MAX_STABLE_ID = 128;
const MAX_WARNING = 2_000;
const MAX_ERROR_MESSAGE = 2_000;

function validationError(message: string): never {
  throw new AppError("VALIDATION_ERROR", message);
}

function record(value: JsonValue, label: string): SafeRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return validationError(`${label} must be an object`);
  }
  return value as SafeRecord;
}

function exactKeys(
  value: SafeRecord,
  required: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== required.length ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key))
  ) {
    validationError(`${label} contains unsupported properties`);
  }
}

function text(
  value: JsonValue,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && value.length === 0) ||
    value !== value.trim()
  ) {
    return validationError(`${label} must be bounded trim-equal text`);
  }
  return value;
}

function stableId<T>(
  value: JsonValue,
  label: string,
  parse: (input: string) => T,
): T {
  const input = text(value, label, MAX_STABLE_ID);
  try {
    return parse(input);
  } catch {
    return validationError(`${label} must be a valid stable ID`);
  }
}

function parseBinding(value: JsonValue): AccountBinding {
  const input = record(value, "account binding");
  exactKeys(input, ["host", "login", "accountId"], "account binding");
  const host = text(input.host as JsonValue, "account host", 253);
  if (host !== "github.com") {
    return validationError("account host must be github.com");
  }
  return Object.freeze({
    host,
    login: text(input.login as JsonValue, "account login", 100),
    accountId: text(input.accountId as JsonValue, "account ID", MAX_STABLE_ID),
  });
}

function parseWarnings(value: JsonValue): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    return validationError("warnings must be a bounded array");
  }
  const warnings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    warnings.push(
      text(value[index] as JsonValue, "warning", MAX_WARNING, true),
    );
  }
  return Object.freeze(warnings);
}

function runState(value: JsonValue): RunState {
  const parsed = text(value, "run state", 16);
  if (!RUN_STATES.has(parsed as RunState)) {
    return validationError("run state is invalid");
  }
  return parsed as RunState;
}

function failureMode(value: JsonValue): FailureMode {
  const parsed = text(value, "failure mode", 16);
  if (!FAILURE_MODES.has(parsed as FailureMode)) {
    return validationError("failure mode is invalid");
  }
  return parsed as FailureMode;
}

function nullableTimestamp(value: JsonValue, label: string): string | null {
  return value === null ? null : canonicalUtcTimestamp(value, label);
}

export function parseChangeRun(input: unknown): ChangeRun {
  const root = record(canonicalJsonClone(input), "change run");
  exactKeys(
    root,
    [
      "id",
      "planId",
      "binding",
      "state",
      "failureMode",
      "warnings",
      "startedAt",
      "finishedAt",
    ],
    "change run",
  );
  const state = runState(root.state as JsonValue);
  const startedAt = canonicalUtcTimestamp(root.startedAt, "run startedAt");
  const finishedAt = nullableTimestamp(
    root.finishedAt as JsonValue,
    "run finishedAt",
  );
  if (
    ((state === "pending" || state === "running") && finishedAt !== null) ||
    ((state === "completed" || state === "partial" || state === "failed") &&
      finishedAt === null)
  ) {
    return validationError("run finishedAt does not match its lifecycle state");
  }
  if (finishedAt !== null && finishedAt < startedAt) {
    return validationError("run finishedAt cannot precede startedAt");
  }

  return Object.freeze({
    id: stableId(root.id as JsonValue, "run ID", asRunId),
    planId: stableId(root.planId as JsonValue, "plan ID", asPlanId),
    binding: parseBinding(root.binding as JsonValue),
    state,
    failureMode: failureMode(root.failureMode as JsonValue),
    warnings: parseWarnings(root.warnings as JsonValue),
    startedAt,
    finishedAt,
  });
}

function nonnegativeInteger(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return validationError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function operationStatus(value: JsonValue): RunOperationStatus {
  const parsed = text(value, "run operation status", 32);
  if (!OPERATION_STATUSES.has(parsed as RunOperationStatus)) {
    return validationError("run operation status is invalid");
  }
  return parsed as RunOperationStatus;
}

function reconciliationStatus(value: JsonValue): ReconciliationStatus {
  const parsed = text(value, "reconciliation status", 32);
  if (!RECONCILIATION_STATUSES.has(parsed as ReconciliationStatus)) {
    return validationError("reconciliation status is invalid");
  }
  return parsed as ReconciliationStatus;
}

function serializedError(value: JsonValue): SerializedDomainError | null {
  if (value === null) return null;
  const input = record(value, "serialized domain error");
  exactKeys(
    input,
    ["code", "message", "retryable", "details"],
    "serialized domain error",
  );
  const code = text(input.code as JsonValue, "error code", 64);
  if (!ERROR_CODES.has(code as AppErrorCode)) {
    return validationError("serialized domain error code is invalid");
  }
  if (typeof input.retryable !== "boolean") {
    return validationError("serialized domain error retryable must be Boolean");
  }
  return Object.freeze({
    code: code as AppErrorCode,
    message: text(
      input.message as JsonValue,
      "serialized domain error message",
      MAX_ERROR_MESSAGE,
    ),
    retryable: input.retryable,
    details: freezeJsonValue(input.details as JsonValue),
  });
}

export function parseRunOperation(input: unknown): RunOperation {
  const root = record(canonicalJsonClone(input), "run operation");
  exactKeys(
    root,
    [
      "runId",
      "operationId",
      "sequence",
      "status",
      "reconciliation",
      "attempts",
      "before",
      "after",
      "externalRequestId",
      "error",
      "startedAt",
      "finishedAt",
    ],
    "run operation",
  );
  const status = operationStatus(root.status as JsonValue);
  const reconciliation = reconciliationStatus(root.reconciliation as JsonValue);
  const attempts = nonnegativeInteger(
    root.attempts as JsonValue,
    "operation attempts",
  );
  const startedAt = nullableTimestamp(
    root.startedAt as JsonValue,
    "operation startedAt",
  );
  const finishedAt = nullableTimestamp(
    root.finishedAt as JsonValue,
    "operation finishedAt",
  );
  const externalRequestId =
    root.externalRequestId === null
      ? null
      : text(
          root.externalRequestId as JsonValue,
          "external request ID",
          MAX_STABLE_ID,
        );
  const error = serializedError(root.error as JsonValue);
  const after = freezeJsonValue(root.after as JsonValue);
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) {
    return validationError("run operation finishedAt cannot precede startedAt");
  }

  const pending =
    status === "pending" &&
    reconciliation === "not_required" &&
    startedAt === null &&
    finishedAt === null &&
    externalRequestId === null &&
    error === null &&
    after === null;
  const running =
    status === "running" &&
    reconciliation === "pending" &&
    attempts >= 1 &&
    startedAt !== null &&
    finishedAt === null &&
    externalRequestId === null &&
    error === null &&
    after === null;
  const skipped =
    status === "skipped" &&
    reconciliation === "not_required" &&
    attempts === 0 &&
    startedAt === null &&
    finishedAt !== null &&
    externalRequestId === null &&
    error === null &&
    after === null;
  const succeeded =
    status === "succeeded" &&
    (reconciliation === "not_required" ||
      reconciliation === "confirmed_applied") &&
    attempts >= 1 &&
    startedAt !== null &&
    finishedAt !== null &&
    error === null;
  const failedWithoutDispatch =
    status === "failed" &&
    reconciliation === "confirmed_not_applied" &&
    startedAt === null &&
    finishedAt !== null &&
    externalRequestId === null &&
    after === null &&
    error !== null;
  const failedAfterDispatch =
    status === "failed" &&
    reconciliation === "confirmed_not_applied" &&
    attempts >= 1 &&
    startedAt !== null &&
    finishedAt !== null &&
    error !== null;
  const unresolved =
    status === "unresolved" &&
    reconciliation === "unknown" &&
    attempts >= 1 &&
    startedAt !== null &&
    finishedAt !== null &&
    error !== null &&
    error.retryable === false;
  if (
    !pending &&
    !running &&
    !skipped &&
    !succeeded &&
    !failedWithoutDispatch &&
    !failedAfterDispatch &&
    !unresolved
  ) {
    return validationError(
      "run operation fields do not match a legal lifecycle matrix row",
    );
  }

  return Object.freeze({
    runId: stableId(root.runId as JsonValue, "run ID", asRunId),
    operationId: text(
      root.operationId as JsonValue,
      "operation ID",
      MAX_STABLE_ID,
    ),
    sequence: nonnegativeInteger(
      root.sequence as JsonValue,
      "operation sequence",
    ),
    status,
    reconciliation,
    attempts,
    before: freezeJsonValue(root.before as JsonValue),
    after,
    externalRequestId,
    error,
    startedAt,
    finishedAt,
  });
}

function positiveInteger(value: JsonValue, label: string): number {
  const parsed = nonnegativeInteger(value, label);
  if (parsed < 1) return validationError(`${label} must be positive`);
  return parsed;
}

export function parseRunOperationAttempt(input: unknown): RunOperationAttempt {
  const root = record(canonicalJsonClone(input), "run operation attempt");
  exactKeys(
    root,
    [
      "runId",
      "operationId",
      "attempt",
      "before",
      "startedAt",
      "status",
      "reconciliation",
      "after",
      "externalRequestId",
      "error",
      "finishedAt",
    ],
    "run operation attempt",
  );
  const status = operationStatus(root.status as JsonValue);
  if (status === "pending" || status === "skipped") {
    return validationError("attempt status is invalid");
  }
  const reconciliation = reconciliationStatus(root.reconciliation as JsonValue);
  const startedAt = canonicalUtcTimestamp(root.startedAt, "attempt startedAt");
  const finishedAt = nullableTimestamp(
    root.finishedAt as JsonValue,
    "attempt finishedAt",
  );
  if (finishedAt !== null && finishedAt < startedAt) {
    return validationError("attempt finishedAt cannot precede startedAt");
  }
  const externalRequestId =
    root.externalRequestId === null
      ? null
      : text(
          root.externalRequestId as JsonValue,
          "external request ID",
          MAX_STABLE_ID,
        );
  const error = serializedError(root.error as JsonValue);
  const after = freezeJsonValue(root.after as JsonValue);
  const valid =
    (status === "running" &&
      reconciliation === "pending" &&
      after === null &&
      externalRequestId === null &&
      error === null &&
      finishedAt === null) ||
    (status === "succeeded" &&
      reconciliation === "not_required" &&
      error === null &&
      finishedAt !== null) ||
    (status === "failed" &&
      reconciliation === "confirmed_not_applied" &&
      error !== null &&
      finishedAt !== null) ||
    (status === "unresolved" &&
      reconciliation === "unknown" &&
      error !== null &&
      error.retryable === false &&
      finishedAt !== null);
  if (!valid) {
    return validationError("attempt fields do not match a legal matrix row");
  }
  return Object.freeze({
    runId: stableId(root.runId as JsonValue, "run ID", asRunId),
    operationId: text(
      root.operationId as JsonValue,
      "operation ID",
      MAX_STABLE_ID,
    ),
    attempt: positiveInteger(root.attempt as JsonValue, "attempt number"),
    before: freezeJsonValue(root.before as JsonValue),
    startedAt,
    status,
    reconciliation,
    after,
    externalRequestId,
    error,
    finishedAt,
  }) as RunOperationAttempt;
}

export function parseRunOperationReconciliation(
  input: unknown,
): RunOperationReconciliation {
  const root = record(
    canonicalJsonClone(input),
    "run operation reconciliation",
  );
  exactKeys(
    root,
    [
      "runId",
      "operationId",
      "attempt",
      "eventSequence",
      "after",
      "observedAt",
      "status",
      "reconciliation",
      "error",
    ],
    "run operation reconciliation",
  );
  const status = operationStatus(root.status as JsonValue);
  const reconciliation = reconciliationStatus(root.reconciliation as JsonValue);
  const error = serializedError(root.error as JsonValue);
  const valid =
    (status === "succeeded" &&
      reconciliation === "confirmed_applied" &&
      error === null) ||
    (status === "failed" &&
      reconciliation === "confirmed_not_applied" &&
      error?.retryable === true) ||
    (status === "unresolved" &&
      reconciliation === "unknown" &&
      error?.retryable === false);
  if (!valid) {
    return validationError(
      "reconciliation fields do not match a legal matrix row",
    );
  }
  return Object.freeze({
    runId: stableId(root.runId as JsonValue, "run ID", asRunId),
    operationId: text(
      root.operationId as JsonValue,
      "operation ID",
      MAX_STABLE_ID,
    ),
    attempt: positiveInteger(root.attempt as JsonValue, "attempt number"),
    eventSequence: nonnegativeInteger(
      root.eventSequence as JsonValue,
      "reconciliation event sequence",
    ),
    after: freezeJsonValue(root.after as JsonValue),
    observedAt: canonicalUtcTimestamp(
      root.observedAt,
      "reconciliation observedAt",
    ),
    status,
    reconciliation,
    error,
  }) as RunOperationReconciliation;
}

const RUN_TRANSITIONS = new Map<RunState, ReadonlySet<RunState>>([
  ["pending", new Set(["running"])],
  ["running", new Set(["completed", "partial", "failed"])],
  ["partial", new Set(["running"])],
  ["completed", new Set()],
  ["failed", new Set()],
]);

export function transitionRunState(
  current: RunState,
  next: RunState,
): RunState {
  if (
    !RUN_STATES.has(current) ||
    !RUN_STATES.has(next) ||
    !RUN_TRANSITIONS.get(current)?.has(next)
  ) {
    throw new AppError(
      "PRECONDITION_FAILED",
      "The requested run state transition is not allowed",
    );
  }
  return next;
}

export function recoverRunState(state: "pending" | "running"): "partial" {
  if (state !== "pending" && state !== "running") {
    throw new AppError(
      "PRECONDITION_FAILED",
      "Only an interrupted pending or running run can recover to partial",
    );
  }
  return "partial";
}
