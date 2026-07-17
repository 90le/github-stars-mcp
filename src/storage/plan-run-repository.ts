import { Buffer } from "node:buffer";
import type Database from "better-sqlite3";
import type {
  AuditPage,
  FinishRunOperationInput,
  IncompleteRunSummaries,
  LeaseGuard,
  ReconcileRunOperationInput,
  RunOperationAttemptPage,
  RunOperationReconciliationPage,
} from "../app/ports/storage-port.js";
import { canonicalJson, canonicalJsonClone } from "../domain/canonical-json.js";
import { AppError } from "../domain/errors.js";
import { asPlanId, asRunId, type PlanId, type RunId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import {
  parseChangePlan,
  transitionPlanState,
  type ChangePlan,
  type PlanExecutableContent,
  type PlanState,
  type ResolvedOperation,
} from "../domain/plan.js";
import type { AccountBinding } from "../domain/repository.js";
import {
  parseChangeRun,
  parseRunOperation,
  parseRunOperationAttempt,
  parseRunOperationReconciliation,
  transitionRunState,
  type ChangeRun,
  type RunOperation,
  type RunOperationAttempt,
  type RunOperationReconciliation,
  type RunOperationStatus,
  type RunState,
} from "../domain/run.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import { LeaseRepository } from "./lease-repository.js";
import {
  runInImmediateTransaction,
  runInNewImmediateTransaction,
} from "./sqlite-transaction.js";

interface PlanRow {
  readonly plan_id: string;
  readonly state: PlanState;
  readonly host: string;
  readonly login: string;
  readonly account_id: string;
  readonly snapshot_id: string;
  readonly hash: string;
  readonly executable_json: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly caller_note: string | null;
  readonly warnings_json: string;
}

interface PlanOperationRow {
  readonly operation_json: string;
}

interface PlanDependencyRow {
  readonly operation_id: string;
  readonly depends_on_operation_id: string;
}

interface SnapshotSourceRow {
  readonly status: "building" | "complete" | "failed";
  readonly list_coverage: "collecting" | "complete" | "unavailable" | "omitted";
  readonly host: string;
  readonly login: string;
  readonly account_id: string;
}

interface RunRow {
  readonly run_id: string;
  readonly plan_id: string;
  readonly host: string;
  readonly login: string;
  readonly account_id: string;
  readonly lease_name: string;
  readonly lease_owner_id: string;
  readonly state: RunState;
  readonly failure_mode: "stop" | "continue";
  readonly warnings_json: string;
  readonly started_at: string;
  readonly finished_at: string | null;
}

interface RunOperationRow {
  readonly run_id: string;
  readonly plan_id: string;
  readonly operation_id: string;
  readonly sequence: number;
  readonly status: RunOperation["status"];
  readonly reconciliation: RunOperation["reconciliation"];
  readonly attempts: number;
  readonly before_json: string;
  readonly after_json: string;
  readonly external_request_id: string | null;
  readonly error_json: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

interface RunOperationAttemptRow {
  readonly run_id: string;
  readonly operation_id: string;
  readonly attempt: number;
  readonly status: RunOperationAttempt["status"];
  readonly reconciliation: RunOperationAttempt["reconciliation"];
  readonly before_json: string;
  readonly after_json: string;
  readonly external_request_id: string | null;
  readonly error_json: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

interface RunOperationReconciliationRow {
  readonly run_id: string;
  readonly operation_id: string;
  readonly attempt: number;
  readonly event_sequence: number;
  readonly status: RunOperationReconciliation["status"];
  readonly reconciliation: RunOperationReconciliation["reconciliation"];
  readonly after_json: string;
  readonly error_json: string | null;
  readonly observed_at: string;
}

interface CountRow {
  readonly value: number;
}

interface IncompleteRunRow extends RunRow {
  readonly pending_count: number;
  readonly running_count: number;
  readonly succeeded_count: number;
  readonly skipped_count: number;
  readonly failed_count: number;
  readonly unresolved_count: number;
}

const PLAN_COLUMNS = `
  plan_id,state,host,login,account_id,snapshot_id,hash,executable_json,
  created_at,expires_at,caller_note,warnings_json
`;

const RUN_COLUMNS = `
  run_id,plan_id,host,login,account_id,lease_name,lease_owner_id,state,
  failure_mode,warnings_json,started_at,finished_at
`;

const OPERATION_COLUMNS = `
  run_id,plan_id,operation_id,sequence,status,reconciliation,attempts,
  before_json,after_json,external_request_id,error_json,started_at,finished_at
`;

const ATTEMPT_COLUMNS = `
  run_id,operation_id,attempt,status,reconciliation,before_json,after_json,
  external_request_id,error_json,started_at,finished_at
`;

const RECONCILIATION_COLUMNS = `
  run_id,operation_id,attempt,event_sequence,status,reconciliation,after_json,
  error_json,observed_at
`;

const UTF16_SORT_FUNCTION = "__github_stars_mcp_utf16_sort_key";

function utf16SortKey(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new AppError("STORAGE_ERROR", "stored lexical key is invalid");
  }
  return Buffer.from(value, "utf16le").swap16();
}

function exactObject(
  input: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, JsonValue>> {
  const value = canonicalJsonClone(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", `${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} contains unsupported properties`,
    );
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function stableText(value: JsonValue | undefined, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new AppError("VALIDATION_ERROR", `${label} must be stable text`);
  }
  return value;
}

function integer(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function parsedGuard(value: JsonValue | undefined): LeaseGuard {
  const root = exactObject(value, ["name", "ownerId", "now"], "lease guard");
  return Object.freeze({
    name: stableText(root.name, "lease name"),
    ownerId: stableText(root.ownerId, "lease owner"),
    now: canonicalUtcTimestamp(root.now, "lease guard now"),
  });
}

function parsedBinding(value: JsonValue | undefined): AccountBinding {
  const root = exactObject(
    value,
    ["host", "login", "accountId"],
    "account binding",
  );
  const host = stableText(root.host, "account host");
  if (host !== "github.com") {
    throw new AppError("VALIDATION_ERROR", "account binding is invalid");
  }
  return Object.freeze({
    host,
    login: stableText(root.login, "account login"),
    accountId: stableText(root.accountId, "account ID"),
  });
}

function pageBoundary(
  value: JsonValue | undefined,
  label: string,
  maximum: number | undefined,
): number | null {
  if (value === null) return null;
  const boundary = integer(value, label, 0);
  if (maximum === undefined || boundary > maximum) {
    throw new AppError("VALIDATION_ERROR", `${label} is beyond the result set`);
  }
  return boundary;
}

function parseJson(text: string): JsonValue {
  return canonicalJsonClone(JSON.parse(text));
}

function storageFailure(message: string): never {
  throw new AppError("STORAGE_ERROR", message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const PENDING_RECOVERY_ERROR = Object.freeze({
  code: "INTERNAL_ERROR" as const,
  details: Object.freeze({ recovered: true }),
  message: "Operation was interrupted before dispatch; dispatch did not occur",
  retryable: true,
});

const RUNNING_RECOVERY_ERROR = Object.freeze({
  code: "RECONCILIATION_REQUIRED" as const,
  details: Object.freeze({ recovered: true }),
  message: "Dispatch outcome is unknown after interruption",
  retryable: false,
});

function planRequiresCompleteListCoverage(
  executable: PlanExecutableContent,
): boolean {
  if (executable.protectedListIds.length > 0) return true;
  for (const operation of executable.operations) {
    if (
      operation.kind === "list_create" ||
      operation.kind === "list_update" ||
      operation.kind === "list_delete" ||
      operation.kind === "list_membership_set"
    ) {
      return true;
    }
    for (const precondition of operation.preconditions) {
      if (precondition.kind !== "star_state") return true;
    }
  }
  return false;
}

function planSummary(
  operations: readonly ResolvedOperation[],
): Readonly<Record<string, number>> {
  const summary = {
    star: 0,
    unstar: 0,
    list_create: 0,
    list_update: 0,
    list_delete: 0,
    list_membership_set: 0,
  };
  for (const operation of operations) {
    switch (operation.kind) {
      case "star":
        summary.star += 1;
        break;
      case "unstar":
        summary.unstar += 1;
        break;
      case "list_create":
        summary.list_create += 1;
        break;
      case "list_update":
        summary.list_update += 1;
        break;
      case "list_delete":
        summary.list_delete += 1;
        break;
      case "list_membership_set":
        summary.list_membership_set += 1;
        break;
    }
  }
  return Object.freeze(summary);
}

export class PlanRunRepository {
  readonly #database: Database.Database;
  readonly #leases: LeaseRepository;

  constructor(database: Database.Database) {
    this.#database = database;
    this.#leases = new LeaseRepository(database);
    try {
      database.function(
        UTF16_SORT_FUNCTION,
        { deterministic: true },
        utf16SortKey,
      );
    } catch {
      throw new AppError(
        "STORAGE_ERROR",
        "storage lexical ordering could not be initialized",
      );
    }
  }

  #write<T>(operation: () => T): T {
    try {
      return runInImmediateTransaction(this.#database, operation);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("plan or run persistence failed");
    }
  }

  #planRow(id: PlanId | string): PlanRow | undefined {
    return this.#database
      .prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE plan_id=?`)
      .get(id) as PlanRow | undefined;
  }

  #planFromRow(row: PlanRow): ChangePlan {
    try {
      const executableValue = parseJson(row.executable_json);
      if (
        executableValue === null ||
        typeof executableValue !== "object" ||
        Array.isArray(executableValue)
      ) {
        return storageFailure("stored plan is invalid");
      }
      const operations = this.#database
        .prepare(
          `SELECT operation_json FROM plan_operations
           WHERE plan_id=? ORDER BY sequence`,
        )
        .all(row.plan_id) as PlanOperationRow[];
      const dependencies = this.#database
        .prepare(
          `SELECT operation_id,depends_on_operation_id
           FROM plan_operation_dependencies
           WHERE plan_id=?`,
        )
        .all(row.plan_id) as PlanDependencyRow[];
      dependencies.sort(
        (left, right) =>
          compareText(left.operation_id, right.operation_id) ||
          compareText(
            left.depends_on_operation_id,
            right.depends_on_operation_id,
          ),
      );
      const executable = {
        ...executableValue,
        operations: operations.map((operation) =>
          parseJson(operation.operation_json),
        ),
        dependencies: dependencies.map((dependency) => ({
          operationId: dependency.operation_id,
          dependsOnOperationId: dependency.depends_on_operation_id,
        })),
      };
      return parseChangePlan({
        id: row.plan_id,
        hash: row.hash,
        state: row.state,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        callerNote: row.caller_note,
        executable,
        operations: executable.operations,
        dependencies: executable.dependencies,
        warnings: parseJson(row.warnings_json),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "STORAGE_ERROR") {
        throw error;
      }
      return storageFailure("stored plan is invalid");
    }
  }

  #assertPlanSource(plan: ChangePlan): void {
    const source = this.#database
      .prepare(
        `SELECT status,list_coverage,host,login,account_id
         FROM snapshots WHERE snapshot_id=?`,
      )
      .get(plan.executable.snapshotId) as SnapshotSourceRow | undefined;
    if (source === undefined) {
      throw new AppError("NOT_FOUND", "plan source snapshot was not found");
    }
    if (source.status !== "complete") {
      throw new AppError(
        "PRECONDITION_FAILED",
        "plan source snapshot is not complete",
      );
    }
    const binding = plan.executable.binding;
    if (
      source.host !== binding.host ||
      source.login !== binding.login ||
      source.account_id !== binding.accountId
    ) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "plan binding does not match source snapshot",
      );
    }
    if (
      source.list_coverage !== "complete" &&
      planRequiresCompleteListCoverage(plan.executable)
    ) {
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "plan requires complete List coverage",
      );
    }
  }

  #runRow(id: RunId | string): RunRow | undefined {
    return this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id=?`)
      .get(id) as RunRow | undefined;
  }

  #runFromRow(row: RunRow): ChangeRun {
    try {
      return parseChangeRun({
        id: row.run_id,
        planId: row.plan_id,
        binding: {
          host: row.host,
          login: row.login,
          accountId: row.account_id,
        },
        state: row.state,
        failureMode: row.failure_mode,
        warnings: parseJson(row.warnings_json),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      });
    } catch {
      return storageFailure("stored run is invalid");
    }
  }

  #operationRow(
    runId: RunId | string,
    operationId: string,
  ): RunOperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT ${OPERATION_COLUMNS} FROM run_operations
         WHERE run_id=? AND operation_id=?`,
      )
      .get(runId, operationId) as RunOperationRow | undefined;
  }

  #operationFromRow(row: RunOperationRow): RunOperation {
    try {
      return parseRunOperation({
        runId: row.run_id,
        operationId: row.operation_id,
        sequence: row.sequence,
        status: row.status,
        reconciliation: row.reconciliation,
        attempts: row.attempts,
        before: parseJson(row.before_json),
        after: parseJson(row.after_json),
        externalRequestId: row.external_request_id,
        error: row.error_json === null ? null : parseJson(row.error_json),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      });
    } catch {
      return storageFailure("stored run operation is invalid");
    }
  }

  #attemptFromRow(row: RunOperationAttemptRow): RunOperationAttempt {
    try {
      return parseRunOperationAttempt({
        runId: row.run_id,
        operationId: row.operation_id,
        attempt: row.attempt,
        status: row.status,
        reconciliation: row.reconciliation,
        before: parseJson(row.before_json),
        after: parseJson(row.after_json),
        externalRequestId: row.external_request_id,
        error: row.error_json === null ? null : parseJson(row.error_json),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      });
    } catch {
      return storageFailure("stored run operation attempt is invalid");
    }
  }

  #reconciliationFromRow(
    row: RunOperationReconciliationRow,
  ): RunOperationReconciliation {
    try {
      return parseRunOperationReconciliation({
        runId: row.run_id,
        operationId: row.operation_id,
        attempt: row.attempt,
        eventSequence: row.event_sequence,
        status: row.status,
        reconciliation: row.reconciliation,
        after: parseJson(row.after_json),
        error: row.error_json === null ? null : parseJson(row.error_json),
        observedAt: row.observed_at,
      });
    } catch {
      return storageFailure("stored reconciliation event is invalid");
    }
  }

  #requireRun(id: RunId): RunRow {
    const row = this.#runRow(id);
    if (row === undefined) {
      throw new AppError("NOT_FOUND", "run was not found");
    }
    return row;
  }

  #requireOperation(runId: RunId, operationId: string): RunOperationRow {
    const row = this.#operationRow(runId, operationId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND", "run operation was not found");
    }
    return row;
  }

  #assertRunLease(row: RunRow, guard: LeaseGuard, allowRebind = false): void {
    this.#leases.assertLease(guard);
    if (
      !allowRebind &&
      (row.lease_name !== guard.name || row.lease_owner_id !== guard.ownerId)
    ) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "mutation lease does not own this run",
      );
    }
  }

  #planForRun(row: RunRow): ChangePlan {
    const planRow = this.#planRow(row.plan_id);
    if (planRow === undefined) {
      return storageFailure("stored run has no plan");
    }
    return this.#planFromRow(planRow);
  }

  #recoverOperation(row: RunOperationRow, now: string): void {
    runInImmediateTransaction(this.#database, () => {
      const operation = this.#operationFromRow(row);
      if (operation.status === "pending") {
        const errorJson = canonicalJson(PENDING_RECOVERY_ERROR);
        const changed = parseRunOperation({
          ...operation,
          status: "failed",
          reconciliation: "confirmed_not_applied",
          after: null,
          externalRequestId: null,
          error: PENDING_RECOVERY_ERROR,
          startedAt: null,
          finishedAt: now,
        });
        const updated = this.#database
          .prepare(
            `UPDATE run_operations SET
               status='failed',reconciliation='confirmed_not_applied',
               after_json='null',external_request_id=NULL,error_json=@error,
               started_at=NULL,finished_at=@now
             WHERE run_id=@runId AND operation_id=@operationId
               AND status='pending'
             RETURNING ${OPERATION_COLUMNS}`,
          )
          .get({
            runId: operation.runId,
            operationId: operation.operationId,
            error: errorJson,
            now,
          }) as RunOperationRow | undefined;
        if (
          updated === undefined ||
          canonicalJson(this.#operationFromRow(updated)) !==
            canonicalJson(changed)
        ) {
          throw new AppError(
            "PRECONDITION_FAILED",
            "pending operation recovery lost its expected state",
          );
        }
        return;
      }
      if (operation.status !== "running") return;
      if (operation.startedAt === null || now < operation.startedAt) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation recovery time precedes its start",
        );
      }
      const attemptRow = this.#database
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM run_operation_attempts
           WHERE run_id=? AND operation_id=? AND attempt=?`,
        )
        .get(operation.runId, operation.operationId, operation.attempts) as
        | RunOperationAttemptRow
        | undefined;
      if (attemptRow === undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "running operation has no current attempt",
        );
      }
      const attempt = this.#attemptFromRow(attemptRow);
      if (attempt.status !== "running" || now < attempt.startedAt) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "running operation has no recoverable current attempt",
        );
      }
      const errorJson = canonicalJson(RUNNING_RECOVERY_ERROR);
      const recoveredAttempt = parseRunOperationAttempt({
        ...attempt,
        status: "unresolved",
        reconciliation: "unknown",
        after: null,
        externalRequestId: null,
        error: RUNNING_RECOVERY_ERROR,
        finishedAt: now,
      });
      const attemptUpdate = this.#database
        .prepare(
          `UPDATE run_operation_attempts SET
             status='unresolved',reconciliation='unknown',after_json='null',
             external_request_id=NULL,error_json=@error,finished_at=@now
           WHERE run_id=@runId AND operation_id=@operationId
             AND attempt=@attempt AND status='running'
           RETURNING ${ATTEMPT_COLUMNS}`,
        )
        .get({
          runId: operation.runId,
          operationId: operation.operationId,
          attempt: operation.attempts,
          error: errorJson,
          now,
        }) as RunOperationAttemptRow | undefined;
      if (
        attemptUpdate === undefined ||
        canonicalJson(this.#attemptFromRow(attemptUpdate)) !==
          canonicalJson(recoveredAttempt)
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "running attempt recovery lost its expected state",
        );
      }
      const recoveredOperation = parseRunOperation({
        ...operation,
        status: "unresolved",
        reconciliation: "unknown",
        after: null,
        externalRequestId: null,
        error: RUNNING_RECOVERY_ERROR,
        finishedAt: now,
      });
      const operationUpdate = this.#database
        .prepare(
          `UPDATE run_operations SET
             status='unresolved',reconciliation='unknown',after_json='null',
             external_request_id=NULL,error_json=@error,finished_at=@now
           WHERE run_id=@runId AND operation_id=@operationId
             AND status='running'
           RETURNING ${OPERATION_COLUMNS}`,
        )
        .get({
          runId: operation.runId,
          operationId: operation.operationId,
          error: errorJson,
          now,
        }) as RunOperationRow | undefined;
      if (
        operationUpdate === undefined ||
        canonicalJson(this.#operationFromRow(operationUpdate)) !==
          canonicalJson(recoveredOperation)
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "running operation recovery lost its expected state",
        );
      }
    });
  }

  #recoverRun(row: RunRow, now: string): void {
    if (
      (row.state !== "pending" && row.state !== "running") ||
      now < row.started_at
    ) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "run recovery time precedes run start",
      );
    }
    const operations = this.#database
      .prepare(
        `SELECT ${OPERATION_COLUMNS} FROM run_operations
         WHERE run_id=? AND status IN ('pending','running')
         ORDER BY sequence`,
      )
      .all(row.run_id) as RunOperationRow[];
    for (const operation of operations) {
      this.#recoverOperation(operation, now);
    }
    const changed = this.#database
      .prepare(
        `UPDATE runs SET state='partial',finished_at=@now
         WHERE run_id=@runId AND state=@state`,
      )
      .run({ runId: row.run_id, state: row.state, now });
    if (changed.changes !== 1) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "run recovery lost its expected state",
      );
    }
    this.#database
      .prepare(
        `UPDATE plans SET state='partial'
         WHERE plan_id=? AND state='applying'`,
      )
      .run(row.plan_id);
  }

  #recoverRuns(
    now: string,
    targeted:
      | {
          readonly binding: AccountBinding;
          readonly guard: LeaseGuard;
        }
      | undefined,
  ): readonly RunId[] {
    try {
      return runInNewImmediateTransaction(this.#database, () => {
        if (targeted !== undefined) {
          this.#leases.assertLease(targeted.guard);
        }
        const binding = targeted?.binding;
        const leaseName = targeted?.guard.name;
        const rows = this.#database
          .prepare(
            `SELECT r.run_id
             FROM runs r
             WHERE r.state IN ('pending','running')
               AND (@host IS NULL OR (
                 r.host=@host AND r.login=@login AND r.account_id=@accountId
               ))
               AND (@leaseName IS NULL OR r.lease_name=@leaseName)
               AND NOT EXISTS(
                 SELECT 1 FROM leases l
                 WHERE l.name=r.lease_name
                   AND l.owner_id=r.lease_owner_id
                   AND l.expires_at>@now
               )`,
          )
          .all({
            host: binding?.host ?? null,
            login: binding?.login ?? null,
            accountId: binding?.accountId ?? null,
            leaseName: leaseName ?? null,
            now,
          }) as { readonly run_id: string }[];
        const ids = rows
          .map((row) => asRunId(row.run_id))
          .sort((left, right) => compareText(left, right));
        const frozenIds = Object.freeze([...ids]);
        for (const id of frozenIds) {
          this.#recoverRun(this.#requireRun(id), now);
        }
        return frozenIds;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("run recovery failed");
    }
  }

  savePlan(input: ChangePlan): void {
    const plan = parseChangePlan(input);
    if (plan.state !== "ready") {
      throw new AppError(
        "PRECONDITION_FAILED",
        "a new plan must be in ready state",
      );
    }
    this.#write(() => {
      this.#assertPlanSource(plan);
      const currentRow = this.#planRow(plan.id);
      if (currentRow !== undefined) {
        const current = this.#planFromRow(currentRow);
        if (
          canonicalJson({ ...current, state: "ready" }) !== canonicalJson(plan)
        ) {
          throw new AppError("PRECONDITION_FAILED", "plan_id is immutable");
        }
        return;
      }
      this.#database
        .prepare(
          `INSERT INTO plans(
             plan_id,state,host,login,account_id,snapshot_id,hash,
             executable_json,created_at,expires_at,caller_note,warnings_json,
             summary_json
           ) VALUES (
             @planId,@state,@host,@login,@accountId,@snapshotId,@hash,
             @executable,@createdAt,@expiresAt,@callerNote,@warnings,@summary
           )`,
        )
        .run({
          planId: plan.id,
          state: plan.state,
          host: plan.executable.binding.host,
          login: plan.executable.binding.login,
          accountId: plan.executable.binding.accountId,
          snapshotId: plan.executable.snapshotId,
          hash: plan.hash,
          executable: canonicalJson(plan.executable),
          createdAt: plan.createdAt,
          expiresAt: plan.expiresAt,
          callerNote: plan.callerNote,
          warnings: canonicalJson(plan.warnings),
          summary: canonicalJson(planSummary(plan.operations)),
        });
      const insertOperation = this.#database.prepare(
        `INSERT INTO plan_operations(
           plan_id,operation_id,sequence,kind,operation_json
         ) VALUES (?,?,?,?,?)`,
      );
      for (let sequence = 0; sequence < plan.operations.length; sequence += 1) {
        const operation = plan.operations[sequence]!;
        insertOperation.run(
          plan.id,
          operation.operationId,
          sequence,
          operation.kind,
          canonicalJson(operation),
        );
      }
      const insertDependency = this.#database.prepare(
        `INSERT INTO plan_operation_dependencies(
           plan_id,operation_id,depends_on_operation_id
         ) VALUES (?,?,?)`,
      );
      for (const dependency of plan.dependencies) {
        insertDependency.run(
          plan.id,
          dependency.operationId,
          dependency.dependsOnOperationId,
        );
      }
    });
  }

  getPlan(idInput: PlanId): ChangePlan | null {
    const id = asPlanId(idInput);
    try {
      const row = this.#planRow(id);
      return row === undefined ? null : this.#planFromRow(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("stored plan could not be read");
    }
  }

  compareAndSetPlanState(input: {
    readonly planId: PlanId;
    readonly expected: readonly PlanState[];
    readonly next: PlanState;
  }): ChangePlan {
    const root = exactObject(
      input,
      ["planId", "expected", "next"],
      "plan state input",
    );
    const planId = asPlanId(stableText(root.planId, "plan ID"));
    if (!Array.isArray(root.expected) || root.expected.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "expected plan states must be non-empty",
      );
    }
    const expected = (root.expected as readonly JsonValue[]).map(
      (state) => stableText(state, "expected plan state") as PlanState,
    );
    if (new Set(expected).size !== expected.length) {
      throw new AppError(
        "VALIDATION_ERROR",
        "expected plan states must be unique",
      );
    }
    const next = stableText(root.next, "next plan state") as PlanState;
    for (const state of expected) transitionPlanState(state, next);

    return this.#write(() => {
      const result = this.#database
        .prepare(
          `UPDATE plans SET state=@next
           WHERE plan_id=@planId
             AND state IN (SELECT value FROM json_each(@expected))
           RETURNING ${PLAN_COLUMNS}`,
        )
        .get({
          planId,
          next,
          expected: canonicalJson(expected),
        }) as PlanRow | undefined;
      if (result === undefined) {
        if (this.#planRow(planId) === undefined) {
          throw new AppError("NOT_FOUND", "plan was not found");
        }
        throw new AppError(
          "PRECONDITION_FAILED",
          "plan state does not match expected",
        );
      }
      return this.#planFromRow(result);
    });
  }

  createRun(input: {
    readonly run: ChangeRun;
    readonly lease: LeaseGuard;
  }): void {
    const root = exactObject(input, ["run", "lease"], "create run input");
    const run = parseChangeRun(root.run);
    const guard = parsedGuard(root.lease);
    if (run.state !== "pending" || run.finishedAt !== null) {
      throw new AppError("PRECONDITION_FAILED", "a new run must be pending");
    }
    this.#write(() => {
      this.#leases.assertLease(guard);
      const planRow = this.#planRow(run.planId);
      if (planRow === undefined) {
        throw new AppError("NOT_FOUND", "plan was not found");
      }
      const plan = this.#planFromRow(planRow);
      if (
        plan.executable.binding.host !== run.binding.host ||
        plan.executable.binding.login !== run.binding.login ||
        plan.executable.binding.accountId !== run.binding.accountId
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "run binding does not match its plan",
        );
      }
      const currentRow = this.#runRow(run.id);
      if (currentRow !== undefined) {
        const current = this.#runFromRow(currentRow);
        if (
          canonicalJson({
            ...current,
            state: "pending",
            finishedAt: null,
          }) !== canonicalJson(run)
        ) {
          throw new AppError(
            "PRECONDITION_FAILED",
            "run immutable content does not match",
          );
        }
        return;
      }
      const planRun = this.#database
        .prepare("SELECT run_id FROM runs WHERE plan_id=?")
        .get(run.planId) as { readonly run_id: string } | undefined;
      if (planRun !== undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "a plan may have only one run",
        );
      }
      if (plan.state !== "applying") {
        throw new AppError(
          "PRECONDITION_FAILED",
          "a new run requires an applying plan",
        );
      }
      this.#database
        .prepare(
          `INSERT INTO runs(
             run_id,plan_id,host,login,account_id,lease_name,lease_owner_id,
             state,failure_mode,warnings_json,started_at,finished_at
           ) VALUES (
             @runId,@planId,@host,@login,@accountId,@leaseName,@leaseOwnerId,
             @state,@failureMode,@warnings,@startedAt,@finishedAt
           )`,
        )
        .run({
          runId: run.id,
          planId: run.planId,
          host: run.binding.host,
          login: run.binding.login,
          accountId: run.binding.accountId,
          leaseName: guard.name,
          leaseOwnerId: guard.ownerId,
          state: run.state,
          failureMode: run.failureMode,
          warnings: canonicalJson(run.warnings),
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        });
    });
  }

  getRun(idInput: RunId): ChangeRun | null {
    const id = asRunId(idInput);
    try {
      const row = this.#runRow(id);
      return row === undefined ? null : this.#runFromRow(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("stored run could not be read");
    }
  }

  getLatestRunForPlan(planIdInput: PlanId): ChangeRun | null {
    const planId = asPlanId(planIdInput);
    try {
      const row = this.#database
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM runs
           WHERE plan_id=?
           ORDER BY started_at DESC,run_id DESC LIMIT 1`,
        )
        .get(planId) as RunRow | undefined;
      return row === undefined ? null : this.#runFromRow(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("stored run could not be read");
    }
  }

  compareAndSetRunState(input: {
    readonly runId: RunId;
    readonly expected: readonly RunState[];
    readonly next: RunState;
    readonly finishedAt: string | null;
    readonly lease: LeaseGuard;
  }): ChangeRun {
    const root = exactObject(
      input,
      ["runId", "expected", "next", "finishedAt", "lease"],
      "run state input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    if (!Array.isArray(root.expected) || root.expected.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "expected run states must be non-empty",
      );
    }
    const expected = (root.expected as readonly JsonValue[]).map(
      (state) => stableText(state, "expected run state") as RunState,
    );
    if (new Set(expected).size !== expected.length) {
      throw new AppError(
        "VALIDATION_ERROR",
        "expected run states must be unique",
      );
    }
    const next = stableText(root.next, "next run state") as RunState;
    for (const state of expected) transitionRunState(state, next);
    const terminal =
      next === "completed" || next === "partial" || next === "failed";
    const finishedAt =
      root.finishedAt === null
        ? null
        : canonicalUtcTimestamp(root.finishedAt, "run finishedAt");
    if (
      (terminal && finishedAt === null) ||
      (!terminal && finishedAt !== null)
    ) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "run finishedAt is invalid for the transition",
      );
    }
    const guard = parsedGuard(root.lease);

    return this.#write(() => {
      const row = this.#requireRun(runId);
      const resume = row.state === "partial" && next === "running";
      this.#assertRunLease(row, guard, resume);
      if (!expected.includes(row.state)) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "run state does not match expected",
        );
      }
      if (
        finishedAt !== null &&
        (finishedAt < row.started_at || finishedAt < guard.now)
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "run finishedAt is invalid for the transition",
        );
      }
      const changed = this.#database
        .prepare(
          `UPDATE runs SET
             state=@next,finished_at=@finishedAt,
             lease_name=CASE WHEN @resume=1 THEN @leaseName ELSE lease_name END,
             lease_owner_id=CASE WHEN @resume=1 THEN @leaseOwnerId ELSE lease_owner_id END
           WHERE run_id=@runId AND state=@current
           RETURNING ${RUN_COLUMNS}`,
        )
        .get({
          runId,
          current: row.state,
          next,
          finishedAt,
          resume: resume ? 1 : 0,
          leaseName: guard.name,
          leaseOwnerId: guard.ownerId,
        }) as RunRow | undefined;
      if (changed === undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "run state does not match expected",
        );
      }
      return this.#runFromRow(changed);
    });
  }

  createRunOperation(input: {
    readonly operation: RunOperation;
    readonly lease: LeaseGuard;
  }): void {
    const root = exactObject(
      input,
      ["operation", "lease"],
      "create run operation input",
    );
    const operation = parseRunOperation(root.operation);
    const guard = parsedGuard(root.lease);
    if (
      operation.status !== "pending" ||
      operation.reconciliation !== "not_required" ||
      operation.attempts !== 0 ||
      operation.after !== null ||
      operation.externalRequestId !== null ||
      operation.error !== null ||
      operation.startedAt !== null ||
      operation.finishedAt !== null
    ) {
      throw new AppError(
        "PRECONDITION_FAILED",
        "run operation is not canonical for creation",
      );
    }
    this.#write(() => {
      const runRow = this.#requireRun(operation.runId);
      this.#assertRunLease(runRow, guard);
      const plan = this.#planForRun(runRow);
      const expected = plan.operations[operation.sequence];
      if (
        expected === undefined ||
        expected.operationId !== operation.operationId ||
        canonicalJson(expected.before) !== canonicalJson(operation.before)
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "run operation does not match the immutable plan",
        );
      }
      const currentRow = this.#operationRow(
        operation.runId,
        operation.operationId,
      );
      if (currentRow !== undefined) {
        const current = this.#operationFromRow(currentRow);
        if (
          canonicalJson({
            runId: current.runId,
            operationId: current.operationId,
            sequence: current.sequence,
            before: current.before,
          }) !==
          canonicalJson({
            runId: operation.runId,
            operationId: operation.operationId,
            sequence: operation.sequence,
            before: operation.before,
          })
        ) {
          throw new AppError(
            "PRECONDITION_FAILED",
            "operation immutable content does not match",
          );
        }
        return;
      }
      if (plan.state !== "applying" || runRow.state !== "running") {
        throw new AppError(
          "PRECONDITION_FAILED",
          "a new operation requires an applying plan and running run",
        );
      }
      const sequenceOwner = this.#database
        .prepare(
          "SELECT operation_id FROM run_operations WHERE run_id=? AND sequence=?",
        )
        .get(operation.runId, operation.sequence) as
        | { readonly operation_id: string }
        | undefined;
      if (sequenceOwner !== undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation sequence already exists",
        );
      }
      this.#database
        .prepare(
          `INSERT INTO run_operations(
             run_id,plan_id,operation_id,sequence,status,reconciliation,
             attempts,before_json,after_json,external_request_id,error_json,
             started_at,finished_at
           ) VALUES (
             @runId,@planId,@operationId,@sequence,@status,@reconciliation,
             @attempts,@before,@after,@externalRequestId,@error,
             @startedAt,@finishedAt
           )`,
        )
        .run({
          runId: operation.runId,
          planId: runRow.plan_id,
          operationId: operation.operationId,
          sequence: operation.sequence,
          status: operation.status,
          reconciliation: operation.reconciliation,
          attempts: operation.attempts,
          before: canonicalJson(operation.before),
          after: canonicalJson(operation.after),
          externalRequestId: operation.externalRequestId,
          error:
            operation.error === null ? null : canonicalJson(operation.error),
          startedAt: operation.startedAt,
          finishedAt: operation.finishedAt,
        });
    });
  }

  startRunOperation(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly startedAt: string;
    readonly lease: LeaseGuard;
  }): RunOperation {
    const root = exactObject(
      input,
      ["runId", "operationId", "startedAt", "lease"],
      "start run operation input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    const startedAt = canonicalUtcTimestamp(
      root.startedAt,
      "operation startedAt",
    );
    const guard = parsedGuard(root.lease);
    return this.#write(() => {
      const runRow = this.#requireRun(runId);
      this.#assertRunLease(runRow, guard);
      const plan = this.#planForRun(runRow);
      const operationRow = this.#requireOperation(runId, operationId);
      if (
        runRow.state !== "running" ||
        plan.state !== "applying" ||
        operationRow.status !== "pending"
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation cannot start in its current state",
        );
      }
      if (startedAt < runRow.started_at || startedAt < guard.now) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation startedAt is not fresh",
        );
      }
      const changedRow = this.#database
        .prepare(
          `UPDATE run_operations SET
             status='running',reconciliation='pending',attempts=attempts+1,
             after_json='null',external_request_id=NULL,error_json=NULL,
             started_at=@startedAt,finished_at=NULL
           WHERE run_id=@runId AND operation_id=@operationId
             AND status='pending'
           RETURNING ${OPERATION_COLUMNS}`,
        )
        .get({ runId, operationId, startedAt }) as RunOperationRow | undefined;
      if (changedRow === undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation cannot start in its current state",
        );
      }
      const changed = this.#operationFromRow(changedRow);
      this.#database
        .prepare(
          `INSERT INTO run_operation_attempts(
             run_id,operation_id,attempt,status,reconciliation,before_json,
             after_json,external_request_id,error_json,started_at,finished_at
           ) VALUES (
             @runId,@operationId,@attempt,'running','pending',@before,
             'null',NULL,NULL,@startedAt,NULL
           )`,
        )
        .run({
          runId,
          operationId,
          attempt: changed.attempts,
          before: canonicalJson(changed.before),
          startedAt,
        });
      return changed;
    });
  }

  getRunOperation(input: {
    readonly runId: RunId;
    readonly operationId: string;
  }): RunOperation | null {
    const root = exactObject(
      input,
      ["runId", "operationId"],
      "get run operation input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    try {
      const row = this.#operationRow(runId, operationId);
      return row === undefined ? null : this.#operationFromRow(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("stored run operation could not be read");
    }
  }

  retryRunOperation(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly maxAttempts: number;
    readonly lease: LeaseGuard;
  }): RunOperation {
    const root = exactObject(
      input,
      ["runId", "operationId", "maxAttempts", "lease"],
      "retry run operation input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    const maxAttempts = integer(root.maxAttempts, "maximum attempts", 1);
    const guard = parsedGuard(root.lease);
    return this.#write(() => {
      const runRow = this.#requireRun(runId);
      this.#assertRunLease(runRow, guard);
      const plan = this.#planForRun(runRow);
      const operation = this.#operationFromRow(
        this.#requireOperation(runId, operationId),
      );
      if (
        runRow.state !== "running" ||
        plan.state !== "applying" ||
        operation.status !== "failed" ||
        operation.reconciliation !== "confirmed_not_applied" ||
        operation.error?.retryable !== true ||
        operation.attempts >= maxAttempts
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation is not eligible for retry",
        );
      }
      const changed = this.#database
        .prepare(
          `UPDATE run_operations SET
             status='pending',reconciliation='not_required',
             after_json='null',external_request_id=NULL,error_json=NULL,
             started_at=NULL,finished_at=NULL
           WHERE run_id=? AND operation_id=?
           RETURNING ${OPERATION_COLUMNS}`,
        )
        .get(runId, operationId) as RunOperationRow | undefined;
      if (changed === undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation is not eligible for retry",
        );
      }
      return this.#operationFromRow(changed);
    });
  }

  listRunOperations(runIdInput: RunId): readonly RunOperation[] {
    const runId = asRunId(runIdInput);
    try {
      const rows = this.#database
        .prepare(
          `SELECT ${OPERATION_COLUMNS} FROM run_operations
           WHERE run_id=? ORDER BY sequence`,
        )
        .all(runId) as RunOperationRow[];
      return Object.freeze(rows.map((row) => this.#operationFromRow(row)));
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("stored run operations could not be read");
    }
  }

  listRunOperationsPage(input: {
    readonly runId: RunId;
    readonly afterSequence: number | null;
    readonly pageSize: number;
  }): AuditPage {
    const root = exactObject(
      input,
      ["runId", "afterSequence", "pageSize"],
      "operation page input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const pageSize = integer(root.pageSize, "page size", 1, 100);
    try {
      const count = this.#database
        .prepare(
          `SELECT COUNT(*) AS value,MAX(sequence) AS maximum
           FROM run_operations WHERE run_id=?`,
        )
        .get(runId) as CountRow & { readonly maximum: number | null };
      const after = pageBoundary(
        root.afterSequence,
        "operation sequence boundary",
        count.maximum ?? undefined,
      );
      const rows = this.#database
        .prepare(
          `SELECT ${OPERATION_COLUMNS} FROM run_operations
           WHERE run_id=? AND (? IS NULL OR sequence>?)
           ORDER BY sequence LIMIT ?`,
        )
        .all(runId, after, after, pageSize + 1) as RunOperationRow[];
      const hasMore = rows.length > pageSize;
      const items = Object.freeze(
        rows.slice(0, pageSize).map((row) => this.#operationFromRow(row)),
      );
      return Object.freeze({
        items,
        total: count.value,
        nextSequence:
          hasMore && items.length > 0 ? items.at(-1)!.sequence : null,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("run operation page could not be read");
    }
  }

  finishRunOperation(input: FinishRunOperationInput): RunOperation {
    const cloned = canonicalJsonClone(input);
    if (
      cloned === null ||
      typeof cloned !== "object" ||
      Array.isArray(cloned)
    ) {
      throw new AppError("VALIDATION_ERROR", "finish input must be an object");
    }
    const phase = (cloned as Readonly<Record<string, JsonValue>>).phase;
    if (phase !== "before_dispatch" && phase !== "after_dispatch") {
      throw new AppError(
        "VALIDATION_ERROR",
        "finish operation phase is invalid",
      );
    }
    const keys =
      phase === "before_dispatch"
        ? [
            "phase",
            "runId",
            "operationId",
            "finishedAt",
            "lease",
            "status",
            "reconciliation",
            "error",
          ]
        : [
            "phase",
            "runId",
            "operationId",
            "externalRequestId",
            "after",
            "finishedAt",
            "lease",
            "status",
            "reconciliation",
            "error",
          ];
    const root = exactObject(cloned, keys, "finish operation input");
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    const finishedAt = canonicalUtcTimestamp(
      root.finishedAt,
      "operation finishedAt",
    );
    const guard = parsedGuard(root.lease);

    return this.#write(() => {
      const runRow = this.#requireRun(runId);
      this.#assertRunLease(runRow, guard);
      const plan = this.#planForRun(runRow);
      if (runRow.state !== "running" || plan.state !== "applying") {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation finish requires a running apply lifecycle",
        );
      }
      const operation = this.#operationFromRow(
        this.#requireOperation(runId, operationId),
      );
      if (
        finishedAt < guard.now ||
        (operation.startedAt !== null && finishedAt < operation.startedAt)
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation finishedAt is not fresh",
        );
      }
      let changed: RunOperation;
      let afterJson: string;
      let errorJson: string | null;
      if (phase === "before_dispatch") {
        if (operation.status !== "pending") {
          throw new AppError(
            "PRECONDITION_FAILED",
            "before-dispatch finish requires pending operation",
          );
        }
        changed = parseRunOperation({
          ...operation,
          status: root.status,
          reconciliation: root.reconciliation,
          after: null,
          externalRequestId: null,
          error: root.error,
          startedAt: null,
          finishedAt,
        });
        afterJson = canonicalJson(changed.after);
        errorJson =
          changed.error === null ? null : canonicalJson(changed.error);
      } else {
        if (operation.status !== "running") {
          throw new AppError(
            "PRECONDITION_FAILED",
            "after-dispatch finish requires running operation",
          );
        }
        changed = parseRunOperation({
          ...operation,
          status: root.status,
          reconciliation: root.reconciliation,
          after: root.after,
          externalRequestId: root.externalRequestId,
          error: root.error,
          finishedAt,
        });
        afterJson = canonicalJson(changed.after);
        errorJson =
          changed.error === null ? null : canonicalJson(changed.error);
        const attemptRow = this.#database
          .prepare(
            `SELECT ${ATTEMPT_COLUMNS} FROM run_operation_attempts
             WHERE run_id=? AND operation_id=? AND attempt=?`,
          )
          .get(runId, operationId, operation.attempts) as
          | RunOperationAttemptRow
          | undefined;
        if (
          attemptRow === undefined ||
          this.#attemptFromRow(attemptRow).status !== "running"
        ) {
          throw new AppError(
            "PRECONDITION_FAILED",
            "current dispatch attempt is not running",
          );
        }
        const finalizedAttempt = this.#database
          .prepare(
            `UPDATE run_operation_attempts SET
               status=@status,reconciliation=@reconciliation,
               after_json=@after,external_request_id=@externalRequestId,
               error_json=@error,finished_at=@finishedAt
             WHERE run_id=@runId AND operation_id=@operationId
               AND attempt=@attempt AND status='running'
             RETURNING ${ATTEMPT_COLUMNS}`,
          )
          .get({
            runId,
            operationId,
            attempt: operation.attempts,
            status: changed.status,
            reconciliation: changed.reconciliation,
            after: afterJson,
            externalRequestId: changed.externalRequestId,
            error: errorJson,
            finishedAt,
          }) as RunOperationAttemptRow | undefined;
        if (finalizedAttempt === undefined) {
          throw new AppError(
            "PRECONDITION_FAILED",
            "current dispatch attempt is not running",
          );
        }
        this.#attemptFromRow(finalizedAttempt);
      }
      const updated = this.#database
        .prepare(
          `UPDATE run_operations SET
             status=@status,reconciliation=@reconciliation,
             after_json=@after,external_request_id=@externalRequestId,
             error_json=@error,started_at=@startedAt,finished_at=@finishedAt
           WHERE run_id=@runId AND operation_id=@operationId
             AND status=@expectedStatus
           RETURNING ${OPERATION_COLUMNS}`,
        )
        .get({
          runId,
          operationId,
          status: changed.status,
          reconciliation: changed.reconciliation,
          after: afterJson,
          externalRequestId: changed.externalRequestId,
          error: errorJson,
          startedAt: changed.startedAt,
          finishedAt: changed.finishedAt,
          expectedStatus: phase === "before_dispatch" ? "pending" : "running",
        }) as RunOperationRow | undefined;
      if (updated === undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "operation finish lost its expected state",
        );
      }
      return this.#operationFromRow(updated);
    });
  }

  reconcileRunOperation(input: ReconcileRunOperationInput): RunOperation {
    const root = exactObject(
      input,
      [
        "runId",
        "operationId",
        "after",
        "observedAt",
        "lease",
        "status",
        "reconciliation",
        "error",
      ],
      "reconcile operation input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    const observedAt = canonicalUtcTimestamp(
      root.observedAt,
      "reconciliation observedAt",
    );
    const guard = parsedGuard(root.lease);
    return this.#write(() => {
      const runRow = this.#requireRun(runId);
      this.#assertRunLease(runRow, guard);
      const plan = this.#planForRun(runRow);
      if (runRow.state !== "running" || plan.state !== "applying") {
        throw new AppError(
          "PRECONDITION_FAILED",
          "reconciliation requires a running apply lifecycle",
        );
      }
      const operation = this.#operationFromRow(
        this.#requireOperation(runId, operationId),
      );
      if (operation.status !== "unresolved") {
        throw new AppError(
          "PRECONDITION_FAILED",
          "only an unresolved operation can be reconciled",
        );
      }
      const attemptRow = this.#database
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM run_operation_attempts
           WHERE run_id=? AND operation_id=? AND attempt=?`,
        )
        .get(runId, operationId, operation.attempts) as
        | RunOperationAttemptRow
        | undefined;
      if (attemptRow === undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "current unresolved attempt was not found",
        );
      }
      const attempt = this.#attemptFromRow(attemptRow);
      if (
        attempt.status !== "unresolved" ||
        attempt.reconciliation !== "unknown"
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "current unresolved attempt was not found",
        );
      }
      if (
        observedAt < guard.now ||
        (operation.finishedAt !== null && observedAt < operation.finishedAt) ||
        (attempt.finishedAt !== null && observedAt < attempt.finishedAt)
      ) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "reconciliation observedAt is not monotonic",
        );
      }
      const maximum = this.#database
        .prepare(
          `SELECT MAX(event_sequence) AS maximum
           FROM run_operation_reconciliations
           WHERE run_id=? AND operation_id=?`,
        )
        .get(runId, operationId) as { readonly maximum: number | null };
      const eventSequence = (maximum.maximum ?? 0) + 1;
      const event = parseRunOperationReconciliation({
        runId,
        operationId,
        attempt: operation.attempts,
        eventSequence,
        after: root.after,
        observedAt,
        status: root.status,
        reconciliation: root.reconciliation,
        error: root.error,
      });
      const changed = parseRunOperation({
        ...operation,
        status: event.status,
        reconciliation: event.reconciliation,
        after: event.after,
        error: event.error,
        finishedAt: observedAt,
      });
      const afterJson = canonicalJson(event.after);
      const errorJson =
        event.error === null ? null : canonicalJson(event.error);
      this.#database
        .prepare(
          `INSERT INTO run_operation_reconciliations(
             run_id,operation_id,attempt,event_sequence,status,reconciliation,
             after_json,error_json,observed_at
           ) VALUES (
             @runId,@operationId,@attempt,@eventSequence,@status,
             @reconciliation,@after,@error,@observedAt
           )`,
        )
        .run({
          runId,
          operationId,
          attempt: event.attempt,
          eventSequence,
          status: event.status,
          reconciliation: event.reconciliation,
          after: afterJson,
          error: errorJson,
          observedAt,
        });
      const updated = this.#database
        .prepare(
          `UPDATE run_operations SET
             status=@status,reconciliation=@reconciliation,
             after_json=@after,error_json=@error,finished_at=@observedAt
           WHERE run_id=@runId AND operation_id=@operationId
             AND status='unresolved' AND reconciliation='unknown'
           RETURNING ${OPERATION_COLUMNS}`,
        )
        .get({
          runId,
          operationId,
          status: changed.status,
          reconciliation: changed.reconciliation,
          after: afterJson,
          error: errorJson,
          observedAt,
        }) as RunOperationRow | undefined;
      if (updated === undefined) {
        throw new AppError(
          "PRECONDITION_FAILED",
          "only an unresolved operation can be reconciled",
        );
      }
      return this.#operationFromRow(updated);
    });
  }

  getRunOperationAttempt(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly attempt: number;
  }): RunOperationAttempt | null {
    const root = exactObject(
      input,
      ["runId", "operationId", "attempt"],
      "get attempt input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    const attempt = integer(root.attempt, "attempt number", 1);
    try {
      const row = this.#database
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM run_operation_attempts
           WHERE run_id=? AND operation_id=? AND attempt=?`,
        )
        .get(runId, operationId, attempt) as RunOperationAttemptRow | undefined;
      return row === undefined ? null : this.#attemptFromRow(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("stored attempt could not be read");
    }
  }

  listRunOperationAttemptsPage(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly afterAttempt: number | null;
    readonly pageSize: number;
  }): RunOperationAttemptPage {
    const root = exactObject(
      input,
      ["runId", "operationId", "afterAttempt", "pageSize"],
      "attempt page input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    const pageSize = integer(root.pageSize, "page size", 1, 100);
    try {
      const count = this.#database
        .prepare(
          `SELECT COUNT(*) AS value,MAX(attempt) AS maximum
           FROM run_operation_attempts
           WHERE run_id=? AND operation_id=?`,
        )
        .get(runId, operationId) as CountRow & {
        readonly maximum: number | null;
      };
      const after = pageBoundary(
        root.afterAttempt,
        "attempt boundary",
        count.maximum ?? undefined,
      );
      const rows = this.#database
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM run_operation_attempts
           WHERE run_id=? AND operation_id=?
             AND (? IS NULL OR attempt>?)
           ORDER BY attempt LIMIT ?`,
        )
        .all(
          runId,
          operationId,
          after,
          after,
          pageSize + 1,
        ) as RunOperationAttemptRow[];
      const hasMore = rows.length > pageSize;
      const items = Object.freeze(
        rows.slice(0, pageSize).map((row) => this.#attemptFromRow(row)),
      );
      return Object.freeze({
        items,
        total: count.value,
        nextAttempt: hasMore && items.length > 0 ? items.at(-1)!.attempt : null,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("attempt page could not be read");
    }
  }

  listRunOperationReconciliationsPage(input: {
    readonly runId: RunId;
    readonly operationId: string;
    readonly afterEventSequence: number | null;
    readonly pageSize: number;
  }): RunOperationReconciliationPage {
    const root = exactObject(
      input,
      ["runId", "operationId", "afterEventSequence", "pageSize"],
      "reconciliation page input",
    );
    const runId = asRunId(stableText(root.runId, "run ID"));
    const operationId = stableText(root.operationId, "operation ID");
    const pageSize = integer(root.pageSize, "page size", 1, 100);
    try {
      const count = this.#database
        .prepare(
          `SELECT COUNT(*) AS value,MAX(event_sequence) AS maximum
           FROM run_operation_reconciliations
           WHERE run_id=? AND operation_id=?`,
        )
        .get(runId, operationId) as CountRow & {
        readonly maximum: number | null;
      };
      const after = pageBoundary(
        root.afterEventSequence,
        "reconciliation event boundary",
        count.maximum ?? undefined,
      );
      const rows = this.#database
        .prepare(
          `SELECT ${RECONCILIATION_COLUMNS}
           FROM run_operation_reconciliations
           WHERE run_id=? AND operation_id=?
             AND (? IS NULL OR event_sequence>?)
           ORDER BY event_sequence LIMIT ?`,
        )
        .all(
          runId,
          operationId,
          after,
          after,
          pageSize + 1,
        ) as RunOperationReconciliationRow[];
      const hasMore = rows.length > pageSize;
      const items = Object.freeze(
        rows.slice(0, pageSize).map((row) => this.#reconciliationFromRow(row)),
      );
      return Object.freeze({
        items,
        total: count.value,
        nextEventSequence:
          hasMore && items.length > 0 ? items.at(-1)!.eventSequence : null,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("reconciliation page could not be read");
    }
  }

  getIncompleteRunSummaries(input: {
    readonly binding: AccountBinding;
    readonly limit: number;
  }): IncompleteRunSummaries {
    const root = exactObject(
      input,
      ["binding", "limit"],
      "incomplete run summary input",
    );
    const binding = parsedBinding(root.binding);
    const limit = integer(root.limit, "summary limit", 1, 100);
    try {
      const total = (
        this.#database
          .prepare(
            `SELECT COUNT(*) AS value FROM runs
             WHERE state IN ('pending','running','partial')
               AND host=? AND login=? AND account_id=?`,
          )
          .get(binding.host, binding.login, binding.accountId) as CountRow
      ).value;
      const rows = this.#database
        .prepare(
          `SELECT
             r.run_id,r.plan_id,r.host,r.login,r.account_id,
             r.lease_name,r.lease_owner_id,r.state,r.failure_mode,
             r.warnings_json,r.started_at,r.finished_at,
             (SELECT COUNT(*) FROM run_operations o
              WHERE o.run_id=r.run_id AND o.status='pending') AS pending_count,
             (SELECT COUNT(*) FROM run_operations o
              WHERE o.run_id=r.run_id AND o.status='running') AS running_count,
             (SELECT COUNT(*) FROM run_operations o
              WHERE o.run_id=r.run_id AND o.status='succeeded') AS succeeded_count,
             (SELECT COUNT(*) FROM run_operations o
              WHERE o.run_id=r.run_id AND o.status='skipped') AS skipped_count,
             (SELECT COUNT(*) FROM run_operations o
              WHERE o.run_id=r.run_id AND o.status='failed') AS failed_count,
             (SELECT COUNT(*) FROM run_operations o
              WHERE o.run_id=r.run_id AND o.status='unresolved') AS unresolved_count
           FROM runs r
           WHERE r.state IN ('pending','running','partial')
             AND r.host=? AND r.login=? AND r.account_id=?
           ORDER BY r.started_at,${UTF16_SORT_FUNCTION}(r.run_id)
           LIMIT ?`,
        )
        .all(
          binding.host,
          binding.login,
          binding.accountId,
          limit,
        ) as IncompleteRunRow[];
      const items = Object.freeze(
        rows.map((row) => {
          const run = this.#runFromRow(row);
          if (
            run.state !== "pending" &&
            run.state !== "running" &&
            run.state !== "partial"
          ) {
            return storageFailure("stored incomplete run is invalid");
          }
          const counts: Readonly<Record<RunOperationStatus, number>> =
            Object.freeze({
              pending: row.pending_count,
              running: row.running_count,
              succeeded: row.succeeded_count,
              skipped: row.skipped_count,
              failed: row.failed_count,
              unresolved: row.unresolved_count,
            });
          return Object.freeze({
            runId: run.id,
            planId: run.planId,
            state: run.state,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            counts,
          });
        }),
      );
      return Object.freeze({
        items,
        total,
        truncated: total > items.length,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storageFailure("incomplete run summaries could not be read");
    }
  }

  recoverAbandonedRuns(input: {
    readonly binding: AccountBinding;
    readonly lease: LeaseGuard;
  }): readonly RunId[] {
    const root = exactObject(
      input,
      ["binding", "lease"],
      "targeted run recovery input",
    );
    const binding = parsedBinding(root.binding);
    const guard = parsedGuard(root.lease);
    return this.#recoverRuns(guard.now, { binding, guard });
  }

  recoverInterruptedRuns(nowInput: string): readonly RunId[] {
    const now = canonicalUtcTimestamp(nowInput, "recovery now");
    return this.#recoverRuns(now, undefined);
  }
}
