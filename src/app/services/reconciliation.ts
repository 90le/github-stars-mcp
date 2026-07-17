import {
  canonicalJson,
  canonicalJsonClone,
  freezeJsonValue,
} from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import type { JsonValue } from "../../domain/json.js";
import type { ResolvedOperation } from "../../domain/plan.js";
import type { UserList } from "../../domain/repository.js";
import type {
  ExecutionContext,
  MutationExecutor,
} from "./mutation-executor.js";

export type ReconciliationDecision =
  | Readonly<{ kind: "confirmed_applied"; state: JsonValue }>
  | Readonly<{ kind: "confirmed_not_applied"; state: JsonValue }>
  | Readonly<{ kind: "unknown"; state: JsonValue }>;

type JsonRecord = Readonly<Record<string, JsonValue>>;

function frozen<T extends JsonValue>(value: T): T {
  return freezeJsonValue(canonicalJsonClone(value)) as T;
}

function unknown(reason: string): ReconciliationDecision {
  return Object.freeze({
    kind: "unknown",
    state: frozen({ reason }),
  });
}

function decision(
  kind: "confirmed_applied" | "confirmed_not_applied",
  state: JsonValue,
): ReconciliationDecision {
  return Object.freeze({ kind, state: frozen(state) });
}

function cancellation(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  let aborted = false;
  try {
    aborted = signal?.aborted === true;
  } catch {
    aborted = true;
  }
  if (aborted) return true;
  return (
    error instanceof AppError &&
    error.code === "GITHUB_UNAVAILABLE" &&
    error.details !== null &&
    typeof error.details === "object" &&
    !Array.isArray(error.details) &&
    (error.details as Readonly<Record<string, JsonValue>>).reason ===
      "cancelled"
  );
}

function jsonRecord(value: JsonValue): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function same(left: JsonValue, right: JsonValue): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function metadata(value: JsonValue): JsonValue | null {
  const record = jsonRecord(value);
  if (
    record === null ||
    typeof record.name !== "string" ||
    (record.description !== null && typeof record.description !== "string") ||
    typeof record.isPrivate !== "boolean"
  ) {
    return null;
  }
  return frozen({
    name: record.name,
    description: record.description,
    isPrivate: record.isPrivate,
  });
}

function listMetadata(list: UserList): JsonValue {
  return frozen({
    name: list.name,
    description: list.description,
    isPrivate: list.isPrivate,
  });
}

function completeListState(list: UserList): JsonValue {
  return frozen({
    listId: list.listId,
    name: list.name,
    slug: list.slug,
    description: list.description,
    isPrivate: list.isPrivate,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
    lastAddedAt: list.lastAddedAt,
  });
}

function baselineIds(operation: ResolvedOperation): ReadonlySet<string> | null {
  const before = jsonRecord(operation.before);
  const listIds = before?.listIds;
  if (
    !Array.isArray(listIds) ||
    listIds.length > 5_000 ||
    listIds.some((value) => typeof value !== "string")
  ) {
    return null;
  }
  return new Set(listIds as readonly string[]);
}

async function reconcileCreate(
  executor: MutationExecutor,
  operation: Extract<ResolvedOperation, { kind: "list_create" }>,
  context: ExecutionContext,
  signal: AbortSignal | undefined,
): Promise<ReconciliationDecision> {
  const validationContext: ExecutionContext = {
    createdListIdsByOperationId: new Map(),
  };
  if (
    !executor.matchesBefore(
      operation,
      frozen({ exists: false }),
      validationContext,
    )
  ) {
    return unknown("invalid_operation");
  }
  const baseline = baselineIds(operation);
  const expected = metadata(operation.after);
  if (baseline === null || expected === null) {
    return unknown("invalid_operation");
  }
  const lists = await executor.readAllUserLists(signal);
  const matches = lists.filter(
    (list) => !baseline.has(list.listId) && same(listMetadata(list), expected),
  );
  const state = frozen({
    matchingListIds: matches.map((list) => list.listId).sort(),
  });
  if (matches.length === 0) {
    return decision("confirmed_not_applied", state);
  }
  if (matches.length !== 1) return unknown("ambiguous_created_list");
  const matched = matches[0]!;
  context.createdListIdsByOperationId.set(
    operation.operationId,
    matched.listId,
  );
  return decision("confirmed_applied", completeListState(matched));
}

export async function reconcileOperation(
  executor: MutationExecutor,
  operation: ResolvedOperation,
  context: ExecutionContext,
  signal?: AbortSignal,
): Promise<ReconciliationDecision> {
  try {
    if (operation.kind === "list_create") {
      return await reconcileCreate(executor, operation, context, signal);
    }
    const state = await executor.readCurrentState(operation, context, signal);
    if (executor.matchesAfter(operation, state, context)) {
      return decision("confirmed_applied", state);
    }
    if (executor.matchesBefore(operation, state, context)) {
      return decision("confirmed_not_applied", state);
    }
    return Object.freeze({ kind: "unknown", state: frozen(state) });
  } catch (error) {
    if (cancellation(error, signal)) throw error;
    return unknown("read_failed");
  }
}
