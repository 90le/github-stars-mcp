import type { AppConfig } from "../../config.js";
import { AppError } from "../../domain/errors.js";
import { filterRequiresListCoverage } from "../../domain/filter.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  parsePlanExecutable,
  parsePlanRequest,
  topologicalOperationIds,
  type ChangePlan,
  type PlanRequest,
  type ResolvedOperation,
} from "../../domain/plan.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";
import type { Clock, IdGenerator } from "../ports/runtime-port.js";
import type { StoragePort } from "../ports/storage-port.js";
import {
  resolveOperationRequests,
  type ResolveOperationRequestsInput,
  type ResolveOperationRequestsResult,
} from "./operation-resolver.js";

export type CreatePlanInput = PlanRequest;

export type CreatePlanResult = Readonly<{
  plan: ChangePlan;
  summary: Readonly<Record<ResolvedOperation["kind"], number>>;
}>;

type PlanRuntime = Pick<Clock & IdGenerator, "now" | "planId">;
type PlanConfig = Pick<AppConfig, "maxPlanActions" | "planTtlMinutes">;
export type OperationResolver = (
  input: ResolveOperationRequestsInput,
) => ResolveOperationRequestsResult;

function invalid(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function expiresAt(createdAt: string, ttlMinutes: number): string {
  const milliseconds = Date.parse(createdAt) + ttlMinutes * 60_000;
  if (!Number.isSafeInteger(milliseconds)) {
    return invalid("plan expiry is outside the supported timestamp range");
  }
  const value = new Date(milliseconds);
  if (!Number.isFinite(value.getTime())) {
    return invalid("plan expiry is outside the supported timestamp range");
  }
  return canonicalUtcTimestamp(value.toISOString(), "plan expiresAt");
}

function operationSummary(
  operations: readonly ResolvedOperation[],
): Readonly<Record<ResolvedOperation["kind"], number>> {
  const result: Record<ResolvedOperation["kind"], number> = {
    star: 0,
    unstar: 0,
    list_create: 0,
    list_update: 0,
    list_delete: 0,
    list_membership_set: 0,
  };
  for (const operation of operations) result[operation.kind] += 1;
  return Object.freeze(result);
}

function requiresCompleteListCoverage(request: PlanRequest): boolean {
  if (request.protectedListIds.length > 0) return true;
  return request.actions.some((action) => {
    if (action.kind !== "star" && action.kind !== "unstar") return true;
    return (
      action.repositories.kind === "filter" &&
      filterRequiresListCoverage(action.repositories.filter)
    );
  });
}

export class PlanService {
  readonly #storage: StoragePort;
  readonly #runtime: PlanRuntime;
  readonly #config: PlanConfig;
  readonly #resolve: OperationResolver;

  constructor(
    storage: StoragePort,
    runtime: PlanRuntime,
    config: PlanConfig,
    resolver: OperationResolver = resolveOperationRequests,
  ) {
    this.#storage = storage;
    this.#runtime = runtime;
    this.#config = Object.freeze({ ...config });
    this.#resolve = resolver;
  }

  create(input: CreatePlanInput): Promise<CreatePlanResult> {
    return Promise.resolve().then(() => this.#createSync(input));
  }

  #createSync(input: CreatePlanInput): CreatePlanResult {
    const request = parsePlanRequest(input);
    const snapshot = this.#storage.getCompleteSnapshot(request.snapshotId);
    if (snapshot === null) {
      throw new AppError(
        "STALE_SNAPSHOT",
        "Planning requires an existing complete snapshot",
        { retryable: false },
      );
    }
    if (
      requiresCompleteListCoverage(request) &&
      snapshot.listCoverage !== "complete"
    ) {
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "Planning this change requires complete List coverage",
        { retryable: false },
      );
    }

    const ttlMinutes = request.ttlMinutes ?? this.#config.planTtlMinutes;
    if (ttlMinutes > this.#config.planTtlMinutes) {
      invalid("caller plan TTL cannot exceed the configured plan TTL");
    }
    const maximumOperations =
      request.maxOperations ?? this.#config.maxPlanActions;
    if (maximumOperations > this.#config.maxPlanActions) {
      invalid(
        "caller maximum operations cannot exceed the configured plan ceiling",
      );
    }

    let operationSequence = 0;
    const resolved = this.#resolve({
      storage: this.#storage,
      snapshot,
      actions: request.actions,
      protectedRepositoryIds: request.protectedRepositoryIds,
      protectedListIds: request.protectedListIds,
      nextOperationId: () => {
        operationSequence += 1;
        return `op_${String(operationSequence).padStart(6, "0")}`;
      },
    });
    if (resolved.operations.length > maximumOperations) {
      throw new AppError(
        "PLAN_TOO_LARGE",
        "Resolved plan exceeds the effective operation limit",
        { retryable: false },
      );
    }
    topologicalOperationIds(resolved.operations, resolved.dependencies);

    const executable = parsePlanExecutable({
      schemaVersion: 1,
      policyVersion: "1",
      binding: snapshot.binding,
      snapshotId: snapshot.id,
      protectedRepositoryIds: Object.freeze(
        [...new Set(request.protectedRepositoryIds)].sort(),
      ),
      protectedListIds: Object.freeze(
        [...new Set(request.protectedListIds)].sort(),
      ),
      operations: resolved.operations,
      dependencies: resolved.dependencies,
    });
    topologicalOperationIds(executable.operations, executable.dependencies);
    const createdAt = canonicalUtcTimestamp(
      this.#runtime.now(),
      "plan createdAt",
    );
    const plan = parseChangePlan({
      id: this.#runtime.planId(),
      hash: hashPlanExecutable(executable),
      state: "ready",
      createdAt,
      expiresAt: expiresAt(createdAt, ttlMinutes),
      callerNote: request.callerNote ?? null,
      executable,
      operations: executable.operations,
      dependencies: executable.dependencies,
      warnings: resolved.warnings,
    });
    this.#storage.withTransaction((transaction) => {
      transaction.savePlan(plan);
    });
    return Object.freeze({
      plan,
      summary: operationSummary(plan.operations),
    });
  }
}
