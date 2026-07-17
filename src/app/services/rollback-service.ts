import type { AppConfig } from "../../config.js";
import {
  canonicalJson,
  canonicalJsonClone,
  sha256Hex,
} from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import {
  asRepositoryId,
  asRunId,
  asUserListId,
  type RepositoryDatabaseId,
  type RepositoryId,
  type RunId,
  type UserListId,
} from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  parsePlanExecutable,
  parseResolvedOperation,
  reverseDependencyOperationIds,
  topologicalOperationIds,
  type OperationDependency,
  type ResolvedListTarget,
  type ResolvedOperation,
} from "../../domain/plan.js";
import {
  repositoryViewSchema,
  type AccountBinding,
  type RepositoryCoordinates,
  type RepositoryView,
  type UserList,
} from "../../domain/repository.js";
import {
  parseChangeRun,
  parseRunOperation,
  type ChangeRun,
  type RunOperation,
} from "../../domain/run.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";
import type { Clock, IdGenerator } from "../ports/runtime-port.js";
import type { StoragePort } from "../ports/storage-port.js";
import type { CreatePlanResult } from "./plan-service.js";

export type CreateRollbackInput = Readonly<{
  runId: RunId;
  protectedRepositoryIds: readonly RepositoryId[];
  protectedListIds: readonly UserListId[];
  ttlMinutes?: number;
  callerNote?: string;
}>;

type RollbackRuntime = Pick<Clock & IdGenerator, "now" | "planId">;
type RollbackConfig = Pick<AppConfig, "maxPlanActions" | "planTtlMinutes">;
type JsonObject = Readonly<Record<string, JsonValue>>;
type CompleteListState = Readonly<UserList>;

type RepositoryIdentity = Readonly<{
  repositoryId: RepositoryId;
  repositoryDatabaseId: RepositoryDatabaseId;
  coordinates: RepositoryCoordinates;
}>;

type DraftNode = {
  operation: ResolvedOperation;
  readonly dependencies: Set<string>;
  readonly affectedRepositoryIds: Set<RepositoryId>;
  readonly affectedListIds: Set<UserListId>;
};

type Projection = {
  readonly sourceOperationId: string;
  readonly entryIds: string[];
  readonly exitIds: string[];
};

type MembershipRequest = {
  readonly sourceOperationId: string;
  readonly proposedOperationId: string;
  readonly repository: RepositoryIdentity;
  readonly expectedListIds: readonly UserListId[];
  readonly targetLists: readonly ResolvedListTarget[];
  readonly internalDependencies: readonly string[];
  readonly affectedListIds: readonly UserListId[];
};

const MAX_IDS = 5_000;
const MAX_STABLE_ID = 128;
const MAX_NOTE = 2_000;
const MAX_WARNING = 2_000;
const MAX_WARNINGS = 1_000;
const MAX_TTL_MINUTES = 10_080;
const PAGE_SIZE = 100;

function invalid(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function precondition(message: string): never {
  throw new AppError("PRECONDITION_FAILED", message, { retryable: false });
}

function notFound(message: string): never {
  throw new AppError("NOT_FOUND", message, { retryable: false });
}

function staleSnapshot(message: string): never {
  throw new AppError("STALE_SNAPSHOT", message, { retryable: false });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function record(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    invalid(`${label} contains unsupported properties`);
  }
}

function exactState(
  value: JsonValue,
  keys: readonly string[],
  label: string,
): JsonObject {
  const result = record(value, label);
  exactKeys(result, keys, [], label);
  return result;
}

function boundedText(
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
    return invalid(`${label} must be bounded trim-equal text`);
  }
  return value;
}

function stableId<T extends string>(
  value: JsonValue,
  label: string,
  parse: (input: string) => T,
): T {
  const input = boundedText(value, label, MAX_STABLE_ID);
  try {
    return parse(input);
  } catch {
    return invalid(`${label} must be a valid stable ID`);
  }
}

function idArray<T extends string>(
  value: JsonValue,
  label: string,
  parse: (input: string) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) {
    return invalid(`${label} must be a bounded array`);
  }
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    result.push(stableId(value[index] as JsonValue, `${label} item`, parse));
  }
  return sortedUnique(result);
}

function positiveInteger(
  value: JsonValue,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    return invalid(`${label} must be a bounded positive integer`);
  }
  return value;
}

function parseRollbackInput(input: unknown): CreateRollbackInput {
  const root = record(canonicalJsonClone(input), "rollback request");
  exactKeys(
    root,
    ["runId", "protectedRepositoryIds", "protectedListIds"],
    ["ttlMinutes", "callerNote"],
    "rollback request",
  );
  const result: {
    runId: RunId;
    protectedRepositoryIds: readonly RepositoryId[];
    protectedListIds: readonly UserListId[];
    ttlMinutes?: number;
    callerNote?: string;
  } = {
    runId: stableId(root.runId as JsonValue, "run ID", asRunId),
    protectedRepositoryIds: idArray(
      root.protectedRepositoryIds as JsonValue,
      "protected repository IDs",
      asRepositoryId,
    ),
    protectedListIds: idArray(
      root.protectedListIds as JsonValue,
      "protected List IDs",
      asUserListId,
    ),
  };
  if (Object.hasOwn(root, "ttlMinutes")) {
    result.ttlMinutes = positiveInteger(
      root.ttlMinutes as JsonValue,
      "rollback TTL minutes",
      MAX_TTL_MINUTES,
    );
  }
  if (Object.hasOwn(root, "callerNote")) {
    result.callerNote = boundedText(
      root.callerNote as JsonValue,
      "caller note",
      MAX_NOTE,
      true,
    );
  }
  return Object.freeze(result);
}

function parseStableIdArray(
  value: JsonValue,
  label: string,
  parse: (input: string) => UserListId | RepositoryId,
): readonly (UserListId | RepositoryId)[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) {
    return precondition(`${label} is not a bounded ID array`);
  }
  const result: Array<UserListId | RepositoryId> = [];
  for (const candidate of value as readonly JsonValue[]) {
    if (typeof candidate !== "string") {
      return precondition(`${label} contains an invalid ID`);
    }
    try {
      const parsed = parse(candidate);
      if (
        candidate.length > MAX_STABLE_ID ||
        candidate.length === 0 ||
        candidate !== candidate.trim()
      ) {
        return precondition(`${label} contains an invalid ID`);
      }
      result.push(parsed);
    } catch {
      return precondition(`${label} contains an invalid ID`);
    }
  }
  const canonical = sortedUnique(result);
  if (!sameJson(canonical, value)) {
    return precondition(`${label} must be sorted and unique`);
  }
  return canonical;
}

function listIdsState(value: JsonValue, label: string): readonly UserListId[] {
  const state = exactState(value, ["listIds"], label);
  return parseStableIdArray(
    state.listIds as JsonValue,
    `${label} List IDs`,
    asUserListId,
  ) as readonly UserListId[];
}

function metadataState(value: JsonValue, label: string): JsonObject {
  const state = exactState(value, ["name", "description", "isPrivate"], label);
  if (
    typeof state.name !== "string" ||
    state.name.length === 0 ||
    state.name !== state.name.trim() ||
    (state.description !== null && typeof state.description !== "string") ||
    typeof state.isPrivate !== "boolean"
  ) {
    return precondition(`${label} is not complete List metadata`);
  }
  return Object.freeze({
    name: state.name,
    description: state.description,
    isPrivate: state.isPrivate,
  });
}

function completeListState(value: JsonValue, label: string): CompleteListState {
  const state = exactState(
    value,
    [
      "listId",
      "name",
      "slug",
      "description",
      "isPrivate",
      "createdAt",
      "updatedAt",
      "lastAddedAt",
    ],
    label,
  );
  const listId = stableId(
    state.listId as JsonValue,
    `${label} List ID`,
    asUserListId,
  );
  const name = boundedText(state.name as JsonValue, `${label} name`, 255);
  const slug = boundedText(state.slug as JsonValue, `${label} slug`, 255);
  if (
    state.description !== null &&
    (typeof state.description !== "string" || state.description.length > 8_192)
  ) {
    return precondition(`${label} description is invalid`);
  }
  if (typeof state.isPrivate !== "boolean") {
    return precondition(`${label} privacy is invalid`);
  }
  const createdAt = canonicalUtcTimestamp(
    state.createdAt,
    `${label} createdAt`,
  );
  const updatedAt = canonicalUtcTimestamp(
    state.updatedAt,
    `${label} updatedAt`,
  );
  const lastAddedAt =
    state.lastAddedAt === null
      ? null
      : canonicalUtcTimestamp(state.lastAddedAt, `${label} lastAddedAt`);
  return Object.freeze({
    listId,
    name,
    slug,
    description: state.description,
    isPrivate: state.isPrivate,
    createdAt,
    updatedAt,
    lastAddedAt,
  });
}

function repositoryIdsFromDelete(
  operation: Extract<ResolvedOperation, { readonly listId: UserListId }>,
): readonly RepositoryId[] {
  if (operation.kind !== "list_delete") {
    return precondition("source operation is not a List deletion");
  }
  const before = exactState(
    operation.before,
    ["list", "repositoryIds"],
    `source operation ${operation.operationId} before`,
  );
  const list = completeListState(
    before.list as JsonValue,
    `source operation ${operation.operationId} deleted List`,
  );
  if (list.listId !== operation.listId) {
    return precondition("source List delete audit identity is contradictory");
  }
  return parseStableIdArray(
    before.repositoryIds as JsonValue,
    `source operation ${operation.operationId} repository IDs`,
    asRepositoryId,
  ) as readonly RepositoryId[];
}

function completeDeletedList(
  operation: Extract<ResolvedOperation, { readonly listId: UserListId }>,
): CompleteListState {
  if (operation.kind !== "list_delete") {
    return precondition("source operation is not a List deletion");
  }
  const before = exactState(
    operation.before,
    ["list", "repositoryIds"],
    `source operation ${operation.operationId} before`,
  );
  return completeListState(
    before.list as JsonValue,
    `source operation ${operation.operationId} deleted List`,
  );
}

function repositoryIdentity(
  operation: Extract<
    ResolvedOperation,
    { kind: "star" | "unstar" | "list_membership_set" }
  >,
): RepositoryIdentity {
  return Object.freeze({
    repositoryId: operation.repositoryId,
    repositoryDatabaseId: operation.repositoryDatabaseId,
    coordinates: Object.freeze({
      owner: operation.coordinates.owner,
      name: operation.coordinates.name,
    }),
  });
}

function repositoryIdentityFromSnapshot(
  repository: RepositoryView,
): RepositoryIdentity {
  return Object.freeze({
    repositoryId: repository.repositoryId,
    repositoryDatabaseId: repository.repositoryDatabaseId,
    coordinates: Object.freeze({
      owner: repository.owner,
      name: repository.name,
    }),
  });
}

function validatedSnapshotRepository(
  value: unknown,
  repositoryId: RepositoryId,
): RepositoryView {
  try {
    const parsed = repositoryViewSchema.safeParse(value);
    if (!parsed.success || parsed.data.repositoryId !== repositoryId) {
      return precondition(
        "Source snapshot repository identity is corrupt or key-mismatched",
      );
    }
    return parsed.data;
  } catch {
    return precondition(
      "Source snapshot repository identity is corrupt or key-mismatched",
    );
  }
}

function sameBinding(left: AccountBinding, right: AccountBinding): boolean {
  return sameJson(left, right);
}

function sourceAudit(
  planOperations: readonly ResolvedOperation[],
  dependencies: readonly OperationDependency[],
  rows: readonly RunOperation[],
  run: ChangeRun,
): ReadonlyMap<string, RunOperation> {
  const allowsUnscheduledSuffix =
    run.state === "partial" && run.failureMode === "stop";
  if (
    rows.length > planOperations.length ||
    rows.length > MAX_IDS ||
    (!allowsUnscheduledSuffix && rows.length !== planOperations.length)
  ) {
    return precondition(
      "source run audit rows do not match the source operation set",
    );
  }
  const sourceById = new Map(
    planOperations.map((operation, sequence) => [
      operation.operationId,
      { operation, sequence },
    ]),
  );
  const result = new Map<string, RunOperation>();
  for (const rawRow of rows) {
    let row: RunOperation;
    try {
      row = parseRunOperation(rawRow);
    } catch {
      return precondition("source run contains a corrupt operation row");
    }
    const source = sourceById.get(row.operationId);
    if (
      source === undefined ||
      row.runId !== run.id ||
      row.sequence !== source.sequence ||
      !sameJson(row.before, source.operation.before) ||
      result.has(row.operationId)
    ) {
      return precondition(
        "source run operation audit is contradictory or duplicated",
      );
    }
    result.set(row.operationId, row);
  }
  if (!allowsUnscheduledSuffix && result.size !== planOperations.length) {
    return precondition("source run audit is missing operation rows");
  }
  if (allowsUnscheduledSuffix) {
    const scheduledPrefix = topologicalOperationIds(
      planOperations,
      dependencies,
    ).slice(0, rows.length);
    if (
      result.size !== rows.length ||
      scheduledPrefix.some((operationId) => !result.has(operationId))
    ) {
      return precondition(
        "source stop-mode run audit is not an exact scheduled prefix",
      );
    }
    for (let index = 0; index + 1 < scheduledPrefix.length; index += 1) {
      const row = result.get(scheduledPrefix[index]!);
      if (row?.status !== "succeeded" && row?.status !== "skipped") {
        return precondition(
          "source stop-mode run audit contains rows after its stop boundary",
        );
      }
    }
  }
  return result;
}

function validateSucceededAudit(
  successfulOperations: readonly ResolvedOperation[],
  rowById: ReadonlyMap<string, RunOperation>,
): ReadonlyMap<string, CompleteListState> {
  const createdLists = new Map<string, CompleteListState>();
  for (const operation of successfulOperations) {
    const row = rowById.get(operation.operationId);
    if (row?.status !== "succeeded") {
      return precondition("successful source operation audit is missing");
    }
    switch (operation.kind) {
      case "star":
      case "unstar": {
        if (!sameJson(row.after, operation.after)) {
          return precondition("source Star audit after state is contradictory");
        }
        break;
      }
      case "list_create": {
        const list = completeListState(
          row.after,
          `source operation ${operation.operationId} created List`,
        );
        const sourceBaseline = listIdsState(
          operation.before,
          `source operation ${operation.operationId} List baseline`,
        );
        if (
          !sameJson(
            Object.freeze({
              name: list.name,
              description: list.description,
              isPrivate: list.isPrivate,
            }),
            metadataState(
              operation.after,
              `source operation ${operation.operationId} expected metadata`,
            ),
          )
        ) {
          return precondition(
            "source List create audit metadata is contradictory",
          );
        }
        if (sourceBaseline.includes(list.listId)) {
          return precondition(
            "source List create audit reused an ID from its source baseline",
          );
        }
        if (
          [...createdLists.values()].some(
            (candidate) => candidate.listId === list.listId,
          )
        ) {
          return precondition(
            "source List create audit reused an actual List ID",
          );
        }
        createdLists.set(operation.operationId, list);
        break;
      }
      case "list_update": {
        const after = exactState(
          row.after,
          ["listId", "name", "description", "isPrivate"],
          `source operation ${operation.operationId} after`,
        );
        if (
          after.listId !== operation.listId ||
          !sameJson(
            {
              name: after.name,
              description: after.description,
              isPrivate: after.isPrivate,
            },
            metadataState(
              operation.after,
              `source operation ${operation.operationId} expected metadata`,
            ),
          )
        ) {
          return precondition(
            "source List update audit after state is contradictory",
          );
        }
        metadataState(
          {
            name: after.name as JsonValue,
            description: after.description as JsonValue,
            isPrivate: after.isPrivate as JsonValue,
          },
          `source operation ${operation.operationId} after metadata`,
        );
        break;
      }
      case "list_delete": {
        const after = exactState(
          row.after,
          ["exists"],
          `source operation ${operation.operationId} after`,
        );
        if (after.exists !== false) {
          return precondition(
            "source List delete audit after state is contradictory",
          );
        }
        completeDeletedList(operation);
        repositoryIdsFromDelete(operation);
        break;
      }
      case "list_membership_set":
        listIdsState(
          row.after,
          `source operation ${operation.operationId} after`,
        );
        listIdsState(
          operation.before,
          `source operation ${operation.operationId} before`,
        );
        break;
    }
  }

  for (const operation of successfulOperations) {
    if (operation.kind !== "list_membership_set") continue;
    const expected: UserListId[] = [];
    for (const target of operation.targetLists) {
      if (target.kind === "existing") {
        expected.push(target.listId);
        continue;
      }
      const created = createdLists.get(target.createOperationId);
      if (created === undefined) {
        return precondition(
          "successful membership audit lacks its successful List creation",
        );
      }
      expected.push(created.listId);
    }
    const row = rowById.get(operation.operationId);
    if (
      row === undefined ||
      !sameJson(
        listIdsState(
          row.after,
          `source operation ${operation.operationId} after`,
        ),
        sortedUnique(expected),
      )
    ) {
      return precondition(
        "source List membership audit after state is contradictory",
      );
    }
  }
  return createdLists;
}

function querySnapshotListIds(
  storage: StoragePort,
  snapshotId: Parameters<StoragePort["queryLists"]>[0]["snapshotId"],
): readonly UserListId[] {
  const result: UserListId[] = [];
  let cursor: string | null = null;
  let expectedTotal: number | null = null;
  do {
    const page = storage.queryLists({
      snapshotId,
      pageSize: PAGE_SIZE,
      cursor,
    });
    if (page.coverage !== "complete") {
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "Rollback requires complete persisted List coverage",
        { retryable: false },
      );
    }
    const pageItems = page.items;
    if (pageItems.length > PAGE_SIZE) {
      return precondition("source snapshot List page is not bounded");
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      expectedTotal !== page.total ||
      page.total > MAX_IDS
    ) {
      return precondition("source snapshot List pagination is contradictory");
    }
    for (const list of pageItems) result.push(list.listId);
    if (result.length > expectedTotal || result.length > MAX_IDS) {
      return precondition("source snapshot List pagination exceeded its bound");
    }
    if (
      page.nextCursor !== null &&
      (page.nextCursor === cursor || pageItems.length === 0)
    ) {
      return precondition("source snapshot List pagination did not advance");
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  const canonical = sortedUnique(result);
  if (
    canonical.length !== expectedTotal ||
    canonical.length !== result.length
  ) {
    return precondition(
      "source snapshot List rows are incomplete or duplicate",
    );
  }
  return canonical;
}

function querySnapshotMemberships(
  storage: StoragePort,
  snapshotId: Parameters<StoragePort["queryListMemberships"]>[0]["snapshotId"],
  repositoryId: RepositoryId,
): readonly UserListId[] {
  const result: UserListId[] = [];
  let cursor: string | null = null;
  let expectedTotal: number | null = null;
  do {
    const page = storage.queryListMemberships({
      snapshotId,
      selector: { kind: "repository", repositoryId },
      pageSize: PAGE_SIZE,
      cursor,
    });
    if (
      page.coverage !== "complete" ||
      page.selector.kind !== "repository" ||
      page.selector.repositoryId !== repositoryId ||
      !("listIds" in page)
    ) {
      return precondition(
        "source snapshot membership selector echo is contradictory",
      );
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (expectedTotal !== page.total || page.total > MAX_IDS) {
      return precondition(
        "source snapshot membership pagination is contradictory",
      );
    }
    result.push(...page.listIds);
    if (
      page.nextCursor !== null &&
      (page.nextCursor === cursor || page.listIds.length === 0)
    ) {
      return precondition(
        "source snapshot membership pagination did not advance",
      );
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  const canonical = sortedUnique(result);
  if (
    canonical.length !== expectedTotal ||
    canonical.length !== result.length
  ) {
    return precondition(
      "source snapshot membership rows are incomplete or duplicate",
    );
  }
  return canonical;
}

function inverseId(
  sourceOperationId: string,
  kind: ResolvedOperation["kind"] | null,
  sequence: number,
  allocated: Set<string>,
): string {
  const suffix =
    kind === null ? "" : `_${kind}_${String(sequence).padStart(6, "0")}`;
  const preferred = `undo_${sourceOperationId}${suffix}`;
  const identity = Object.freeze({
    sourceOperationId,
    kind,
    sequence,
  });
  let candidate =
    preferred.length <= MAX_STABLE_ID
      ? preferred
      : `undo_${sha256Hex(canonicalJson(identity))}`;
  let collisionSequence = 0;
  while (allocated.has(candidate)) {
    collisionSequence += 1;
    candidate = `undo_${sha256Hex(
      canonicalJson({ ...identity, collisionSequence }),
    )}`;
  }
  allocated.add(candidate);
  return candidate;
}

function rollbackClientRef(sourceOperationId: string): string {
  const preferred = `rollback_${sourceOperationId}`;
  return preferred.length <= MAX_STABLE_ID
    ? preferred
    : `rollback_${sha256Hex(sourceOperationId)}`;
}

function targetKey(target: ResolvedListTarget): string {
  return target.kind === "existing"
    ? `existing:${target.listId}`
    : `created:${target.createOperationId}`;
}

function compareTarget(
  left: ResolvedListTarget,
  right: ResolvedListTarget,
): number {
  if (left.kind !== right.kind) return left.kind === "existing" ? -1 : 1;
  return compareText(
    left.kind === "existing" ? left.listId : left.createOperationId,
    right.kind === "existing" ? right.listId : right.createOperationId,
  );
}

function sortedTargets(
  targets: readonly ResolvedListTarget[],
): readonly ResolvedListTarget[] {
  const byKey = new Map<string, ResolvedListTarget>();
  for (const target of targets) byKey.set(targetKey(target), target);
  return Object.freeze([...byKey.values()].sort(compareTarget));
}

function membershipAfter(targets: readonly ResolvedListTarget[]): JsonValue {
  return Object.freeze({
    listIds: Object.freeze(
      targets.map((target) =>
        target.kind === "existing"
          ? target.listId
          : Object.freeze({ createOperationId: target.createOperationId }),
      ),
    ),
  });
}

function addNode(
  nodes: Map<string, DraftNode>,
  operation: ResolvedOperation,
  affectedRepositoryIds: readonly RepositoryId[],
  affectedListIds: readonly UserListId[],
): void {
  if (nodes.has(operation.operationId)) {
    return precondition("rollback operation ID allocation collided");
  }
  nodes.set(operation.operationId, {
    operation,
    dependencies: new Set(operation.dependsOn),
    affectedRepositoryIds: new Set(affectedRepositoryIds),
    affectedListIds: new Set(affectedListIds),
  });
}

function warningList(warnings: Iterable<string>): readonly string[] {
  const canonical = sortedUnique(
    [...warnings].map((warning) =>
      warning.length <= MAX_WARNING
        ? warning
        : `${warning.slice(0, MAX_WARNING - 1)}…`,
    ),
  );
  if (canonical.length <= MAX_WARNINGS) return canonical;
  const omitted = canonical.length - (MAX_WARNINGS - 1);
  return sortedUnique([
    ...canonical.slice(0, MAX_WARNINGS - 1),
    `Additional rollback warnings omitted: ${String(omitted)}.`,
  ]);
}

function expiry(createdAt: string, ttlMinutes: number): string {
  const milliseconds = Date.parse(createdAt) + ttlMinutes * 60_000;
  if (!Number.isSafeInteger(milliseconds)) {
    return invalid("rollback plan expiry is outside the supported range");
  }
  const value = new Date(milliseconds);
  if (!Number.isFinite(value.getTime())) {
    return invalid("rollback plan expiry is outside the supported range");
  }
  return canonicalUtcTimestamp(value.toISOString(), "rollback plan expiresAt");
}

function operationSummary(
  operations: readonly ResolvedOperation[],
): CreatePlanResult["summary"] {
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

export class RollbackService {
  readonly #storage: StoragePort;
  readonly #runtime: RollbackRuntime;
  readonly #config: RollbackConfig;

  constructor(
    storage: StoragePort,
    runtime: RollbackRuntime,
    config: RollbackConfig,
  ) {
    this.#storage = storage;
    this.#runtime = runtime;
    this.#config = Object.freeze({ ...config });
  }

  createRollback(input: CreateRollbackInput): Promise<CreatePlanResult> {
    return Promise.resolve().then(() => this.#createSync(input));
  }

  #createSync(input: CreateRollbackInput): CreatePlanResult {
    const request = parseRollbackInput(input);
    const rawRun = this.#storage.getRun(request.runId);
    if (rawRun === null) return notFound("Source run was not found");
    let run;
    try {
      run = parseChangeRun(rawRun);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return precondition("Source run is corrupt");
    }
    if (run.state !== "completed" && run.state !== "partial") {
      return precondition(
        "Rollback requires a completed or partial source run",
      );
    }

    const rawPlan = this.#storage.getPlan(run.planId);
    if (rawPlan === null) return notFound("Source plan was not found");
    let sourcePlan;
    try {
      sourcePlan = parseChangePlan(rawPlan);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return precondition("Source plan is corrupt");
    }
    if (
      sourcePlan.id !== run.planId ||
      (run.state === "completed" && sourcePlan.state !== "applied") ||
      (run.state === "partial" && sourcePlan.state !== "partial")
    ) {
      return precondition(
        "Source run lifecycle does not match its source plan",
      );
    }
    if (!sameBinding(run.binding, sourcePlan.executable.binding)) {
      return precondition(
        "Source run binding does not match its source plan executable",
      );
    }

    const snapshot = this.#storage.getCompleteSnapshot(
      sourcePlan.executable.snapshotId,
    );
    if (snapshot === null) {
      return staleSnapshot(
        "Rollback requires the persisted complete source snapshot",
      );
    }
    if (!sameBinding(snapshot.binding, sourcePlan.executable.binding)) {
      return precondition(
        "Source snapshot binding does not match the source executable",
      );
    }
    if (snapshot.listCoverage !== "complete") {
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        "Rollback requires complete persisted List coverage",
        { retryable: false },
      );
    }

    let rawRows: readonly RunOperation[];
    try {
      rawRows = this.#storage.listRunOperations(run.id);
      if (!Array.isArray(rawRows)) {
        return precondition("Source run audit is not an array");
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      return precondition("Source run audit could not be read");
    }
    const rowById = sourceAudit(
      sourcePlan.operations,
      sourcePlan.dependencies,
      rawRows,
      run,
    );
    const successfulOperations = sourcePlan.operations.filter(
      (operation) => rowById.get(operation.operationId)?.status === "succeeded",
    );
    const successfulIds = new Set(
      successfulOperations.map((operation) => operation.operationId),
    );
    let createdListsBySourceOperation: ReadonlyMap<string, CompleteListState>;
    try {
      createdListsBySourceOperation = validateSucceededAudit(
        successfulOperations,
        rowById,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
        return precondition("Source successful audit state is corrupt");
      }
      throw error;
    }

    const warnings = new Set<string>();
    if (run.state === "partial") {
      warnings.add(
        `Source run ${run.id} is partial; rollback includes only succeeded operations.`,
      );
    }
    for (const operation of sourcePlan.operations) {
      const row = rowById.get(operation.operationId);
      if (row === undefined) continue;
      if (row.status !== "succeeded") {
        warnings.add(
          `Source operation ${operation.operationId} was non-succeeded (${row.status}) and is not included.`,
        );
      }
    }
    const unscheduledCount = sourcePlan.operations.length - rowById.size;
    if (unscheduledCount > 0) {
      warnings.add(
        `Source run ${run.id} has ${String(unscheduledCount)} unscheduled operations without audit rows; they are not included.`,
      );
    }

    const snapshotListIds = querySnapshotListIds(this.#storage, snapshot.id);
    const repositoryIdentities = new Map<RepositoryId, RepositoryIdentity>();
    const relevantRepositoryIds = new Set<RepositoryId>();
    for (const operation of successfulOperations) {
      if (
        operation.kind === "star" ||
        operation.kind === "unstar" ||
        operation.kind === "list_membership_set"
      ) {
        const identity = repositoryIdentity(operation);
        const current = repositoryIdentities.get(identity.repositoryId);
        if (current !== undefined && !sameJson(current, identity)) {
          return precondition(
            "Source operations contradict repository stable identity",
          );
        }
        repositoryIdentities.set(identity.repositoryId, identity);
        relevantRepositoryIds.add(identity.repositoryId);
      }
      if (operation.kind === "list_delete") {
        for (const repositoryId of repositoryIdsFromDelete(operation)) {
          relevantRepositoryIds.add(repositoryId);
        }
      }
    }
    for (const repositoryId of relevantRepositoryIds) {
      if (repositoryIdentities.has(repositoryId)) continue;
      const repository = this.#storage.getSnapshotRepository(
        snapshot.id,
        repositoryId,
      );
      if (repository === null) {
        return precondition(
          "Source snapshot lacks stable identity for a restored repository",
        );
      }
      repositoryIdentities.set(
        repositoryId,
        repositoryIdentityFromSnapshot(
          validatedSnapshotRepository(repository, repositoryId),
        ),
      );
    }

    const snapshotMemberships = new Map<RepositoryId, readonly UserListId[]>();
    const postMemberships = new Map<RepositoryId, readonly UserListId[]>();
    for (const repositoryId of [...relevantRepositoryIds].sort(compareText)) {
      const memberships = querySnapshotMemberships(
        this.#storage,
        snapshot.id,
        repositoryId,
      );
      snapshotMemberships.set(repositoryId, memberships);
      postMemberships.set(repositoryId, memberships);
    }
    const snapshotListIdSet = new Set<UserListId>(snapshotListIds);
    const postListIds = new Set<UserListId>(snapshotListIds);
    const successfulRows = successfulOperations
      .map((operation) => ({
        operation,
        row: rowById.get(operation.operationId)!,
      }))
      .sort((left, right) => left.row.sequence - right.row.sequence);
    for (const { operation, row } of successfulRows) {
      switch (operation.kind) {
        case "star":
        case "list_update":
          break;
        case "unstar":
          postMemberships.set(operation.repositoryId, Object.freeze([]));
          break;
        case "list_create": {
          const created = createdListsBySourceOperation.get(
            operation.operationId,
          );
          if (created === undefined) {
            return precondition("Source List creation audit is missing");
          }
          if (
            snapshotListIdSet.has(created.listId) ||
            postListIds.has(created.listId)
          ) {
            return precondition(
              "Source List creation audit reused an existing List ID",
            );
          }
          postListIds.add(created.listId);
          break;
        }
        case "list_delete":
          postListIds.delete(operation.listId);
          for (const repositoryId of relevantRepositoryIds) {
            postMemberships.set(
              repositoryId,
              Object.freeze(
                (postMemberships.get(repositoryId) ?? []).filter(
                  (listId) => listId !== operation.listId,
                ),
              ),
            );
          }
          break;
        case "list_membership_set":
          postMemberships.set(
            operation.repositoryId,
            listIdsState(
              row.after,
              `source operation ${operation.operationId} after`,
            ),
          );
          break;
      }
    }

    const inducedOperations = successfulOperations
      .map((operation) => ({
        ...operation,
        dependsOn: Object.freeze(
          operation.dependsOn
            .filter((dependency) => successfulIds.has(dependency))
            .sort(compareText),
        ),
      }))
      .sort((left, right) => compareText(left.operationId, right.operationId));
    const inducedDependencies = sourcePlan.dependencies
      .filter(
        (dependency) =>
          successfulIds.has(dependency.operationId) &&
          successfulIds.has(dependency.dependsOnOperationId),
      )
      .sort((left, right) => {
        const dependent = compareText(left.operationId, right.operationId);
        return dependent === 0
          ? compareText(left.dependsOnOperationId, right.dependsOnOperationId)
          : dependent;
      });
    const reverseOrder = reverseDependencyOperationIds(
      inducedOperations,
      inducedDependencies,
    );
    const sourceById = new Map(
      successfulOperations.map((operation) => [
        operation.operationId,
        operation,
      ]),
    );

    const allocatedIds = new Set<string>();
    const nodes = new Map<string, DraftNode>();
    const projections = new Map<string, Projection>();
    const membershipRequests: MembershipRequest[] = [];
    const recreatedByOldListId = new Map<
      UserListId,
      { readonly operationId: string; readonly sourceOperationId: string }
    >();
    for (const sourceOperationId of reverseOrder) {
      const operation = sourceById.get(sourceOperationId);
      if (operation?.kind !== "list_delete") continue;
      const createId = inverseId(operation.operationId, null, 0, allocatedIds);
      if (recreatedByOldListId.has(operation.listId)) {
        return precondition(
          "Source audit contains duplicate successful deletion of one List",
        );
      }
      recreatedByOldListId.set(operation.listId, {
        operationId: createId,
        sourceOperationId: operation.operationId,
      });
    }

    const targetsForListIds = (
      listIds: readonly UserListId[],
    ): readonly ResolvedListTarget[] =>
      sortedTargets(
        listIds.map((listId) => {
          const recreated = recreatedByOldListId.get(listId);
          return recreated === undefined
            ? Object.freeze({ kind: "existing" as const, listId })
            : Object.freeze({
                kind: "created" as const,
                createOperationId: recreated.operationId,
              });
        }),
      );

    const changedListIds = (
      expected: readonly UserListId[],
      targets: readonly ResolvedListTarget[],
    ): readonly UserListId[] => {
      const expectedKeys = new Set(expected.map((listId) => `id:${listId}`));
      const targetKeys = new Set(
        targets.map((target) =>
          target.kind === "existing"
            ? `id:${target.listId}`
            : `create:${target.createOperationId}`,
        ),
      );
      const result: UserListId[] = [];
      for (const listId of expected) {
        if (!targetKeys.has(`id:${listId}`)) result.push(listId);
      }
      for (const target of targets) {
        if (target.kind === "existing") {
          if (!expectedKeys.has(`id:${target.listId}`)) {
            result.push(target.listId);
          }
          continue;
        }
        const old = [...recreatedByOldListId.entries()].find(
          ([, recreated]) => recreated.operationId === target.createOperationId,
        )?.[0];
        if (old !== undefined) result.push(old);
      }
      return sortedUnique(result);
    };

    for (const sourceOperationId of reverseOrder) {
      const operation = sourceById.get(sourceOperationId);
      const row = rowById.get(sourceOperationId);
      if (operation === undefined || row?.status !== "succeeded") {
        return precondition("Successful induced source graph is incomplete");
      }
      const primaryId =
        operation.kind === "list_delete"
          ? recreatedByOldListId.get(operation.listId)!.operationId
          : inverseId(operation.operationId, null, 0, allocatedIds);
      let additionalSequence = 0;
      const additionalId = (kind: ResolvedOperation["kind"]): string => {
        additionalSequence += 1;
        return inverseId(
          operation.operationId,
          kind,
          additionalSequence,
          allocatedIds,
        );
      };

      switch (operation.kind) {
        case "star": {
          const listIds = postMemberships.get(operation.repositoryId) ?? [];
          const starredAt = canonicalUtcTimestamp(
            row.finishedAt ?? run.finishedAt,
            "successful Star audit finishedAt",
          );
          addNode(
            nodes,
            {
              operationId: primaryId,
              kind: "unstar",
              repositoryId: operation.repositoryId,
              repositoryDatabaseId: operation.repositoryDatabaseId,
              coordinates: operation.coordinates,
              dependsOn: Object.freeze([]),
              preconditions: Object.freeze([
                Object.freeze({ kind: "star_state", expected: true }),
              ]),
              before: Object.freeze({
                starred: true,
                starredAt,
                listIds,
              }),
              after: Object.freeze({ starred: false }),
              inverse: Object.freeze({ kind: "star", listIds }),
              risk: "non_reversible",
            },
            [operation.repositoryId],
            listIds,
          );
          projections.set(operation.operationId, {
            sourceOperationId: operation.operationId,
            entryIds: [primaryId],
            exitIds: [primaryId],
          });
          warnings.add(
            `Rollback operation ${primaryId} cannot preserve GitHub starred_at.`,
          );
          break;
        }
        case "unstar": {
          const sourceBefore = exactState(
            operation.before,
            ["starred", "starredAt", "listIds"],
            `source operation ${operation.operationId} before`,
          );
          if (
            sourceBefore.starred !== true ||
            typeof sourceBefore.starredAt !== "string"
          ) {
            return precondition("Source unstar before state is contradictory");
          }
          canonicalUtcTimestamp(
            sourceBefore.starredAt,
            `source operation ${operation.operationId} starredAt`,
          );
          const originalListIds = parseStableIdArray(
            sourceBefore.listIds as JsonValue,
            `source operation ${operation.operationId} before List IDs`,
            asUserListId,
          ) as readonly UserListId[];
          addNode(
            nodes,
            {
              operationId: primaryId,
              kind: "star",
              repositoryId: operation.repositoryId,
              repositoryDatabaseId: operation.repositoryDatabaseId,
              coordinates: operation.coordinates,
              dependsOn: Object.freeze([]),
              preconditions: Object.freeze([
                Object.freeze({ kind: "star_state", expected: false }),
              ]),
              before: Object.freeze({ starred: false }),
              after: Object.freeze({ starred: true }),
              inverse: Object.freeze({ kind: "unstar" }),
              risk: "normal",
            },
            [operation.repositoryId],
            [],
          );
          const membershipId = additionalId("list_membership_set");
          const targets = targetsForListIds(originalListIds);
          membershipRequests.push({
            sourceOperationId: operation.operationId,
            proposedOperationId: membershipId,
            repository: repositoryIdentity(operation),
            expectedListIds: postMemberships.get(operation.repositoryId) ?? [],
            targetLists: targets,
            internalDependencies: [primaryId],
            affectedListIds: changedListIds(
              postMemberships.get(operation.repositoryId) ?? [],
              targets,
            ),
          });
          projections.set(operation.operationId, {
            sourceOperationId: operation.operationId,
            entryIds: [primaryId],
            exitIds: [membershipId],
          });
          warnings.add(
            `Rollback operation ${primaryId} recreates a Star but cannot restore its original starred_at.`,
          );
          break;
        }
        case "list_create": {
          const created = createdListsBySourceOperation.get(
            operation.operationId,
          );
          if (created === undefined) {
            return precondition("Source List creation audit is missing");
          }
          const repositoryIds = sortedUnique(
            [...postMemberships.entries()]
              .filter(([, listIds]) => listIds.includes(created.listId))
              .map(([repositoryId]) => repositoryId),
          );
          addNode(
            nodes,
            {
              operationId: primaryId,
              kind: "list_delete",
              listId: created.listId,
              dependsOn: Object.freeze([]),
              preconditions: Object.freeze([
                Object.freeze({
                  kind: "list_metadata",
                  expected: created,
                }),
              ]),
              before: Object.freeze({
                list: created,
                repositoryIds,
              }),
              after: Object.freeze({ exists: false }),
              inverse: Object.freeze({
                kind: "list_create",
                list: created,
                repositoryIds,
              }),
              risk: "destructive",
            },
            [],
            [created.listId],
          );
          projections.set(operation.operationId, {
            sourceOperationId: operation.operationId,
            entryIds: [primaryId],
            exitIds: [primaryId],
          });
          break;
        }
        case "list_update": {
          const sourceBefore = metadataState(
            operation.before,
            `source operation ${operation.operationId} before`,
          );
          const auditAfter = exactState(
            row.after,
            ["listId", "name", "description", "isPrivate"],
            `source operation ${operation.operationId} after`,
          );
          const currentMetadata = metadataState(
            {
              name: auditAfter.name as JsonValue,
              description: auditAfter.description as JsonValue,
              isPrivate: auditAfter.isPrivate as JsonValue,
            },
            `source operation ${operation.operationId} after metadata`,
          );
          addNode(
            nodes,
            {
              operationId: primaryId,
              kind: "list_update",
              listId: operation.listId,
              dependsOn: Object.freeze([]),
              preconditions: Object.freeze([
                Object.freeze({
                  kind: "list_metadata",
                  expected: currentMetadata,
                }),
              ]),
              before: currentMetadata,
              after: sourceBefore,
              inverse: Object.freeze({
                kind: "list_update",
                name: currentMetadata.name as string,
                description: currentMetadata.description as string | null,
                isPrivate: currentMetadata.isPrivate as boolean,
              }),
              risk: "normal",
            },
            [],
            [operation.listId],
          );
          projections.set(operation.operationId, {
            sourceOperationId: operation.operationId,
            entryIds: [primaryId],
            exitIds: [primaryId],
          });
          break;
        }
        case "list_delete": {
          const deleted = completeDeletedList(operation);
          const repositoryIds = repositoryIdsFromDelete(operation);
          const baseline = sortedUnique([...postListIds]);
          addNode(
            nodes,
            {
              operationId: primaryId,
              kind: "list_create",
              clientRef: rollbackClientRef(operation.operationId),
              dependsOn: Object.freeze([]),
              preconditions: Object.freeze([
                Object.freeze({
                  kind: "list_id_baseline",
                  expected: Object.freeze({ listIds: baseline }),
                }),
              ]),
              before: Object.freeze({ listIds: baseline }),
              after: Object.freeze({
                name: deleted.name,
                description: deleted.description,
                isPrivate: deleted.isPrivate,
              }),
              inverse: Object.freeze({ kind: "list_delete" }),
              risk: "normal",
            },
            [],
            [operation.listId],
          );
          const exits: string[] = [];
          for (const repositoryId of repositoryIds) {
            const identity = repositoryIdentities.get(repositoryId);
            if (identity === undefined) {
              return precondition(
                "Source snapshot lacks a repository identity for restoration",
              );
            }
            const membershipId = additionalId("list_membership_set");
            const targets = targetsForListIds(
              snapshotMemberships.get(repositoryId) ?? [],
            );
            membershipRequests.push({
              sourceOperationId: operation.operationId,
              proposedOperationId: membershipId,
              repository: identity,
              expectedListIds: postMemberships.get(repositoryId) ?? [],
              targetLists: targets,
              internalDependencies: [primaryId],
              affectedListIds: changedListIds(
                postMemberships.get(repositoryId) ?? [],
                targets,
              ),
            });
            exits.push(membershipId);
          }
          projections.set(operation.operationId, {
            sourceOperationId: operation.operationId,
            entryIds: [primaryId],
            exitIds: exits.length === 0 ? [primaryId] : exits,
          });
          warnings.add(
            `Rollback recreates List ${operation.listId}; GitHub will assign a new List ID.`,
          );
          break;
        }
        case "list_membership_set": {
          const desiredListIds = listIdsState(
            operation.before,
            `source operation ${operation.operationId} before`,
          );
          const targets = targetsForListIds(desiredListIds);
          membershipRequests.push({
            sourceOperationId: operation.operationId,
            proposedOperationId: primaryId,
            repository: repositoryIdentity(operation),
            expectedListIds: postMemberships.get(operation.repositoryId) ?? [],
            targetLists: targets,
            internalDependencies: targets
              .filter(
                (
                  target,
                ): target is Extract<
                  ResolvedListTarget,
                  { readonly kind: "created" }
                > => target.kind === "created",
              )
              .map((target) => target.createOperationId),
            affectedListIds: changedListIds(
              postMemberships.get(operation.repositoryId) ?? [],
              targets,
            ),
          });
          projections.set(operation.operationId, {
            sourceOperationId: operation.operationId,
            entryIds: [primaryId],
            exitIds: [primaryId],
          });
          break;
        }
      }
    }

    const membershipByRepository = new Map<RepositoryId, MembershipRequest[]>();
    for (const requestItem of membershipRequests) {
      const group =
        membershipByRepository.get(requestItem.repository.repositoryId) ?? [];
      group.push(requestItem);
      membershipByRepository.set(requestItem.repository.repositoryId, group);
    }
    const membershipIdRemap = new Map<string, string>();
    for (const [repositoryId, group] of [
      ...membershipByRepository.entries(),
    ].sort(([left], [right]) => compareText(left, right))) {
      group.sort((left, right) =>
        compareText(left.proposedOperationId, right.proposedOperationId),
      );
      const first = group[0];
      if (first === undefined) continue;
      const desired = canonicalJson(first.targetLists);
      const expected = canonicalJson(first.expectedListIds);
      for (const item of group) {
        if (
          canonicalJson(item.targetLists) !== desired ||
          canonicalJson(item.expectedListIds) !== expected ||
          !sameJson(item.repository, first.repository)
        ) {
          return precondition(
            `Rollback has conflicting complete membership restorations for repository ${repositoryId}`,
          );
        }
      }
      const chosenId = first.proposedOperationId;
      for (const item of group) {
        membershipIdRemap.set(item.proposedOperationId, chosenId);
      }
      const dependencies = sortedUnique(
        group.flatMap((item) => item.internalDependencies),
      );
      const affectedListIds = sortedUnique(
        group.flatMap((item) => item.affectedListIds),
      );
      addNode(
        nodes,
        {
          operationId: chosenId,
          kind: "list_membership_set",
          repositoryId: first.repository.repositoryId,
          repositoryDatabaseId: first.repository.repositoryDatabaseId,
          coordinates: first.repository.coordinates,
          expectedListIds: first.expectedListIds,
          targetLists: first.targetLists,
          dependsOn: dependencies,
          preconditions: Object.freeze([
            Object.freeze({
              kind: "list_memberships",
              expected: Object.freeze({
                listIds: first.expectedListIds,
              }),
            }),
          ]),
          before: Object.freeze({ listIds: first.expectedListIds }),
          after: membershipAfter(first.targetLists),
          inverse: Object.freeze({
            kind: "list_membership_set",
            listIds: first.expectedListIds,
          }),
          risk: "normal",
        },
        [repositoryId],
        affectedListIds,
      );
    }

    const remap = (operationId: string): string =>
      membershipIdRemap.get(operationId) ?? operationId;
    for (const projection of projections.values()) {
      projection.entryIds.splice(
        0,
        projection.entryIds.length,
        ...sortedUnique(projection.entryIds.map(remap)),
      );
      projection.exitIds.splice(
        0,
        projection.exitIds.length,
        ...sortedUnique(projection.exitIds.map(remap)),
      );
    }
    for (const node of nodes.values()) {
      const remapped = sortedUnique([...node.dependencies].map(remap));
      node.dependencies.clear();
      for (const dependency of remapped) {
        if (dependency !== node.operation.operationId) {
          node.dependencies.add(dependency);
        }
      }
    }

    for (const dependency of inducedDependencies) {
      const inversePrerequisite = projections.get(
        dependency.dependsOnOperationId,
      );
      const inverseDependent = projections.get(dependency.operationId);
      if (inversePrerequisite === undefined || inverseDependent === undefined) {
        return precondition(
          "Successful source dependency projection is missing",
        );
      }
      for (const entry of inversePrerequisite.entryIds) {
        const node = nodes.get(entry);
        if (node === undefined) {
          return precondition("Rollback projection entry is missing");
        }
        for (const exit of inverseDependent.exitIds) {
          if (entry !== exit) node.dependencies.add(exit);
        }
      }
    }

    const protectedRepositoryIds = new Set(request.protectedRepositoryIds);
    const protectedListIds = new Set(request.protectedListIds);
    const removed = new Set<string>();
    const directlyProtected = new Set<string>();
    for (const [operationId, node] of nodes) {
      if (
        [...node.affectedRepositoryIds].some((repositoryId) =>
          protectedRepositoryIds.has(repositoryId),
        ) ||
        [...node.affectedListIds].some((listId) => protectedListIds.has(listId))
      ) {
        removed.add(operationId);
        directlyProtected.add(operationId);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [operationId, node] of nodes) {
        if (
          !removed.has(operationId) &&
          [...node.dependencies].some((dependency) => removed.has(dependency))
        ) {
          removed.add(operationId);
          changed = true;
        }
      }
    }
    for (const operationId of [...removed].sort(compareText)) {
      warnings.add(
        directlyProtected.has(operationId)
          ? `Skipped protected rollback operation ${operationId}.`
          : `Skipped rollback operation ${operationId} because it requires protected work.`,
      );
      nodes.delete(operationId);
    }

    const operations = [...nodes.values()]
      .map((node) => {
        const dependencies = sortedUnique(
          [...node.dependencies].filter((dependency) => nodes.has(dependency)),
        );
        return parseResolvedOperation({
          ...node.operation,
          dependsOn: dependencies,
        });
      })
      .sort((left, right) => compareText(left.operationId, right.operationId));
    if (operations.length > this.#config.maxPlanActions) {
      throw new AppError(
        "PLAN_TOO_LARGE",
        "Rollback projection exceeds the configured operation limit",
        { retryable: false },
      );
    }
    const dependencies: OperationDependency[] = operations
      .flatMap((operation) =>
        operation.dependsOn.map((dependsOnOperationId) =>
          Object.freeze({
            operationId: operation.operationId,
            dependsOnOperationId,
          }),
        ),
      )
      .sort((left, right) => {
        const dependent = compareText(left.operationId, right.operationId);
        return dependent === 0
          ? compareText(left.dependsOnOperationId, right.dependsOnOperationId)
          : dependent;
      });
    topologicalOperationIds(operations, dependencies);

    const executable = parsePlanExecutable({
      schemaVersion: 1,
      policyVersion: "1",
      binding: run.binding,
      snapshotId: sourcePlan.executable.snapshotId,
      protectedRepositoryIds: request.protectedRepositoryIds,
      protectedListIds: request.protectedListIds,
      operations,
      dependencies,
    });
    topologicalOperationIds(executable.operations, executable.dependencies);
    const ttlMinutes = request.ttlMinutes ?? this.#config.planTtlMinutes;
    if (ttlMinutes > this.#config.planTtlMinutes) {
      return invalid(
        "caller rollback TTL cannot exceed the configured plan TTL",
      );
    }
    const createdAt = canonicalUtcTimestamp(
      this.#runtime.now(),
      "rollback plan createdAt",
    );
    const plan = parseChangePlan({
      id: this.#runtime.planId(),
      hash: hashPlanExecutable(executable),
      state: "ready",
      createdAt,
      expiresAt: expiry(createdAt, ttlMinutes),
      callerNote: request.callerNote ?? null,
      executable,
      operations: executable.operations,
      dependencies: executable.dependencies,
      warnings: warningList(warnings),
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
