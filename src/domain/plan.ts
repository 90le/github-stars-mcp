import {
  canonicalJson,
  canonicalJsonClone,
  freezeJsonValue,
  sha256Hex,
} from "./canonical-json.js";
import { AppError } from "./errors.js";
import { parseFilter, type FilterExpression } from "./filter.js";
import {
  asPlanId,
  asRepositoryDatabaseId,
  asRepositoryId,
  asSnapshotId,
  asUserListId,
  type PlanId,
  type RepositoryDatabaseId,
  type RepositoryId,
  type SnapshotId,
  type UserListId,
} from "./ids.js";
import type { JsonValue } from "./json.js";
import type { AccountBinding, RepositoryCoordinates } from "./repository.js";
import { canonicalUtcTimestamp } from "./timestamp.js";

export type RepositorySelector =
  | {
      readonly kind: "ids";
      readonly repositoryIds: readonly RepositoryId[];
    }
  | { readonly kind: "filter"; readonly filter: FilterExpression };

export type ExistingListTarget = {
  readonly kind: "existing";
  readonly listId: UserListId;
};

export type RequestedListTarget =
  | ExistingListTarget
  | { readonly kind: "created"; readonly clientRef: string };

export type ResolvedListTarget =
  | ExistingListTarget
  | { readonly kind: "created"; readonly createOperationId: string };

export type PlanAction =
  | {
      readonly kind: "star" | "unstar";
      readonly repositories: RepositorySelector;
    }
  | {
      readonly kind: "list_create";
      readonly clientRef: string;
      readonly name: string;
      readonly description: string | null;
      readonly isPrivate: boolean;
    }
  | {
      readonly kind: "list_update";
      readonly listIds: readonly UserListId[];
      readonly name?: string;
      readonly description?: string | null;
      readonly isPrivate?: boolean;
    }
  | {
      readonly kind: "list_delete";
      readonly listIds: readonly UserListId[];
    }
  | {
      readonly kind: "list_membership_set" | "list_membership_add";
      readonly repositories: RepositorySelector;
      readonly lists: readonly RequestedListTarget[];
    }
  | {
      readonly kind: "list_membership_remove";
      readonly repositories: RepositorySelector;
      readonly lists: readonly ExistingListTarget[];
    };

export interface PlanRequest {
  readonly snapshotId: SnapshotId;
  readonly actions: readonly PlanAction[];
  readonly protectedRepositoryIds: readonly RepositoryId[];
  readonly protectedListIds: readonly UserListId[];
  readonly ttlMinutes?: number;
  readonly maxOperations?: number;
  readonly callerNote?: string;
}

export interface OperationPrecondition {
  readonly kind: string;
  readonly expected: JsonValue;
}

export interface ResolvedOperationBase {
  readonly operationId: string;
  readonly dependsOn: readonly string[];
  readonly preconditions: readonly OperationPrecondition[];
  readonly before: JsonValue;
  readonly after: JsonValue;
  readonly inverse: JsonValue;
  readonly risk: "normal" | "destructive" | "non_reversible";
}

export type ResolvedOperation =
  | Readonly<
      ResolvedOperationBase & {
        kind: "star" | "unstar";
        repositoryId: RepositoryId;
        repositoryDatabaseId: RepositoryDatabaseId;
        coordinates: RepositoryCoordinates;
      }
    >
  | Readonly<
      ResolvedOperationBase & {
        kind: "list_create";
        clientRef: string;
      }
    >
  | Readonly<
      ResolvedOperationBase & {
        kind: "list_update" | "list_delete";
        listId: UserListId;
      }
    >
  | Readonly<
      ResolvedOperationBase & {
        kind: "list_membership_set";
        repositoryId: RepositoryId;
        repositoryDatabaseId: RepositoryDatabaseId;
        coordinates: RepositoryCoordinates;
        expectedListIds: readonly UserListId[];
        targetLists: readonly ResolvedListTarget[];
      }
    >;

export interface OperationDependency {
  readonly operationId: string;
  readonly dependsOnOperationId: string;
}

export interface PlanExecutableContent {
  readonly schemaVersion: 1;
  readonly policyVersion: "1";
  readonly binding: AccountBinding;
  readonly snapshotId: SnapshotId;
  readonly protectedRepositoryIds: readonly RepositoryId[];
  readonly protectedListIds: readonly UserListId[];
  readonly operations: readonly ResolvedOperation[];
  readonly dependencies: readonly OperationDependency[];
}

export type PlanState =
  | "ready"
  | "applying"
  | "applied"
  | "partial"
  | "expired"
  | "failed"
  | "superseded";

export interface ChangePlan {
  readonly id: PlanId;
  readonly hash: string;
  readonly state: PlanState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly callerNote: string | null;
  readonly executable: PlanExecutableContent;
  readonly operations: readonly ResolvedOperation[];
  readonly dependencies: readonly OperationDependency[];
  readonly warnings: readonly string[];
}

type SafeRecord = Record<string, JsonValue>;

interface GraphOperation {
  readonly operationId: string;
  readonly dependsOn: readonly string[];
}

const MAX_IDS = 5_000;
const MAX_OPERATIONS = 5_000;
const MAX_DEPENDENCIES = 100_000;
const MAX_PRECONDITIONS = 1_000;
const MAX_STABLE_ID = 128;
const MAX_REFERENCE = 128;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 1_024;
const MAX_NOTE = 2_000;
const MAX_WARNING = 2_000;
const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_KINDS = new Set([
  "star",
  "unstar",
  "list_create",
  "list_update",
  "list_delete",
  "list_membership_set",
]);
const RISKS = new Set(["normal", "destructive", "non_reversible"]);
const PLAN_STATES = new Set<PlanState>([
  "ready",
  "applying",
  "applied",
  "partial",
  "expired",
  "failed",
  "superseded",
]);

function validationError(message: string): never {
  throw new AppError("VALIDATION_ERROR", message);
}

function record(value: JsonValue, label: string): SafeRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return validationError(`${label} must be an object`);
  }
  return value as SafeRecord;
}

function array(
  value: JsonValue,
  label: string,
  minimum: number,
  maximum: number,
): readonly JsonValue[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    return validationError(
      `${label} must contain ${String(minimum)} to ${String(maximum)} items`,
    );
  }
  return value as readonly JsonValue[];
}

function exactKeys(
  value: SafeRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
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

function nullableText(
  value: JsonValue,
  label: string,
  maximum: number,
): string | null {
  return value === null ? null : text(value, label, maximum, true);
}

function boolean(value: JsonValue, label: string): boolean {
  if (typeof value !== "boolean") {
    return validationError(`${label} must be Boolean`);
  }
  return value;
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
    return validationError(
      `${label} must be a positive safe integer no greater than ${String(maximum)}`,
    );
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

function repositoryId(value: JsonValue, label: string): RepositoryId {
  return stableId(value, label, asRepositoryId);
}

function repositoryDatabaseId(
  value: JsonValue,
  label: string,
): RepositoryDatabaseId {
  return stableId(value, label, asRepositoryDatabaseId);
}

function userListId(value: JsonValue, label: string): UserListId {
  return stableId(value, label, asUserListId);
}

function snapshotId(value: JsonValue, label: string): SnapshotId {
  return stableId(value, label, asSnapshotId);
}

function planId(value: JsonValue, label: string): PlanId {
  return stableId(value, label, asPlanId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareText(previous, current) >= 0
    ) {
      validationError(`${label} must be sorted and unique`);
    }
  }
}

function idArray<T extends string>(
  value: JsonValue,
  label: string,
  parse: (input: JsonValue, itemLabel: string) => T,
  options: {
    readonly minimum: number;
    readonly canonical: boolean;
  },
): readonly T[] {
  const input = array(value, label, options.minimum, MAX_IDS);
  const result: T[] = [];
  for (let index = 0; index < input.length; index += 1) {
    result.push(parse(input[index] as JsonValue, `${label} item`));
  }
  if (options.canonical) assertSortedUnique(result, label);
  return Object.freeze(result);
}

function stringArray(
  value: JsonValue,
  label: string,
  maximumItems: number,
  maximumLength: number,
  canonical: boolean,
): readonly string[] {
  const input = array(value, label, 0, maximumItems);
  const result: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    result.push(
      text(input[index] as JsonValue, `${label} item`, maximumLength),
    );
  }
  if (canonical) assertSortedUnique(result, label);
  return Object.freeze(result);
}

function parseBinding(value: JsonValue): AccountBinding {
  const input = record(value, "account binding");
  exactKeys(input, ["host", "login", "accountId"], [], "account binding");
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

function parseCoordinates(value: JsonValue): RepositoryCoordinates {
  const input = record(value, "repository coordinates");
  exactKeys(input, ["owner", "name"], [], "repository coordinates");
  return Object.freeze({
    owner: text(input.owner as JsonValue, "repository owner", MAX_NAME),
    name: text(input.name as JsonValue, "repository name", MAX_NAME),
  });
}

function parseRepositorySelector(value: JsonValue): RepositorySelector {
  const input = record(value, "repository selector");
  const kind = text(input.kind as JsonValue, "repository selector kind", 16);
  if (kind === "ids") {
    exactKeys(input, ["kind", "repositoryIds"], [], "repository ID selector");
    return Object.freeze({
      kind,
      repositoryIds: idArray(
        input.repositoryIds as JsonValue,
        "repository selector IDs",
        repositoryId,
        { minimum: 1, canonical: false },
      ),
    });
  }
  if (kind === "filter") {
    exactKeys(input, ["kind", "filter"], [], "repository filter selector");
    let parsed: FilterExpression;
    try {
      parsed = parseFilter(input.filter);
    } catch {
      return validationError("repository selector filter is invalid");
    }
    return Object.freeze({
      kind,
      filter: freezeJsonValue(parsed as JsonValue) as FilterExpression,
    });
  }
  return validationError("repository selector kind is invalid");
}

function parseRequestedTarget(
  value: JsonValue,
  resolved: boolean,
): RequestedListTarget | ResolvedListTarget {
  const input = record(value, "List target");
  const kind = text(input.kind as JsonValue, "List target kind", 16);
  if (kind === "existing") {
    exactKeys(input, ["kind", "listId"], [], "existing List target");
    return Object.freeze({
      kind,
      listId: userListId(input.listId as JsonValue, "target List ID"),
    });
  }
  if (kind === "created" && !resolved) {
    exactKeys(input, ["kind", "clientRef"], [], "requested List target");
    return Object.freeze({
      kind,
      clientRef: text(
        input.clientRef as JsonValue,
        "List client reference",
        MAX_REFERENCE,
      ),
    });
  }
  if (kind === "created" && resolved) {
    exactKeys(input, ["kind", "createOperationId"], [], "resolved List target");
    return Object.freeze({
      kind,
      createOperationId: text(
        input.createOperationId as JsonValue,
        "List create operation ID",
        MAX_REFERENCE,
      ),
    });
  }
  return validationError("List target kind or reference phase is invalid");
}

function parseRequestedTargets(
  value: JsonValue,
  minimum: number,
  existingOnly: boolean,
): readonly RequestedListTarget[] {
  const input = array(value, "requested List targets", minimum, MAX_IDS);
  const result: RequestedListTarget[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const target = parseRequestedTarget(
      input[index] as JsonValue,
      false,
    ) as RequestedListTarget;
    if (existingOnly && target.kind !== "existing") {
      return validationError(
        "membership removal accepts only existing List IDs",
      );
    }
    result.push(target);
  }
  return Object.freeze(result);
}

function parsePlanAction(value: JsonValue): PlanAction {
  const input = record(value, "plan action");
  const kind = text(input.kind as JsonValue, "plan action kind", 32);
  if (kind === "star" || kind === "unstar") {
    exactKeys(input, ["kind", "repositories"], [], `${kind} action`);
    return Object.freeze({
      kind,
      repositories: parseRepositorySelector(input.repositories as JsonValue),
    });
  }
  if (kind === "list_create") {
    exactKeys(
      input,
      ["kind", "clientRef", "name", "description", "isPrivate"],
      [],
      "List create action",
    );
    return Object.freeze({
      kind,
      clientRef: text(
        input.clientRef as JsonValue,
        "List client reference",
        MAX_REFERENCE,
      ),
      name: text(input.name as JsonValue, "List name", MAX_NAME),
      description: nullableText(
        input.description as JsonValue,
        "List description",
        MAX_DESCRIPTION,
      ),
      isPrivate: boolean(input.isPrivate as JsonValue, "List privacy"),
    });
  }
  if (kind === "list_update") {
    exactKeys(
      input,
      ["kind", "listIds"],
      ["name", "description", "isPrivate"],
      "List update action",
    );
    if (
      !Object.hasOwn(input, "name") &&
      !Object.hasOwn(input, "description") &&
      !Object.hasOwn(input, "isPrivate")
    ) {
      return validationError(
        "List update requires at least one metadata field",
      );
    }
    const result: {
      kind: "list_update";
      listIds: readonly UserListId[];
      name?: string;
      description?: string | null;
      isPrivate?: boolean;
    } = {
      kind,
      listIds: idArray(
        input.listIds as JsonValue,
        "List update IDs",
        userListId,
        { minimum: 1, canonical: false },
      ),
    };
    if (Object.hasOwn(input, "name")) {
      result.name = text(input.name as JsonValue, "List name", MAX_NAME);
    }
    if (Object.hasOwn(input, "description")) {
      result.description = nullableText(
        input.description as JsonValue,
        "List description",
        MAX_DESCRIPTION,
      );
    }
    if (Object.hasOwn(input, "isPrivate")) {
      result.isPrivate = boolean(input.isPrivate as JsonValue, "List privacy");
    }
    return Object.freeze(result);
  }
  if (kind === "list_delete") {
    exactKeys(input, ["kind", "listIds"], [], "List delete action");
    return Object.freeze({
      kind,
      listIds: idArray(
        input.listIds as JsonValue,
        "List delete IDs",
        userListId,
        { minimum: 1, canonical: false },
      ),
    });
  }
  if (
    kind === "list_membership_set" ||
    kind === "list_membership_add" ||
    kind === "list_membership_remove"
  ) {
    exactKeys(
      input,
      ["kind", "repositories", "lists"],
      [],
      "List membership action",
    );
    return Object.freeze({
      kind,
      repositories: parseRepositorySelector(input.repositories as JsonValue),
      lists: parseRequestedTargets(
        input.lists as JsonValue,
        kind === "list_membership_remove" ? 1 : 0,
        kind === "list_membership_remove",
      ),
    }) as PlanAction;
  }
  return validationError("plan action kind is unsupported");
}

export function parsePlanRequest(input: unknown): PlanRequest {
  const root = record(canonicalJsonClone(input), "plan request");
  exactKeys(
    root,
    ["snapshotId", "actions", "protectedRepositoryIds", "protectedListIds"],
    ["ttlMinutes", "maxOperations", "callerNote"],
    "plan request",
  );

  const actionInputs = array(
    root.actions as JsonValue,
    "plan actions",
    1,
    MAX_OPERATIONS,
  );
  const actions: PlanAction[] = [];
  for (let index = 0; index < actionInputs.length; index += 1) {
    actions.push(parsePlanAction(actionInputs[index] as JsonValue));
  }

  const result: {
    snapshotId: SnapshotId;
    actions: readonly PlanAction[];
    protectedRepositoryIds: readonly RepositoryId[];
    protectedListIds: readonly UserListId[];
    ttlMinutes?: number;
    maxOperations?: number;
    callerNote?: string;
  } = {
    snapshotId: snapshotId(root.snapshotId as JsonValue, "snapshot ID"),
    actions: Object.freeze(actions),
    protectedRepositoryIds: idArray(
      root.protectedRepositoryIds as JsonValue,
      "protected repository IDs",
      repositoryId,
      { minimum: 0, canonical: false },
    ),
    protectedListIds: idArray(
      root.protectedListIds as JsonValue,
      "protected List IDs",
      userListId,
      { minimum: 0, canonical: false },
    ),
  };
  if (Object.hasOwn(root, "ttlMinutes")) {
    result.ttlMinutes = positiveInteger(
      root.ttlMinutes as JsonValue,
      "plan TTL minutes",
      10_080,
    );
  }
  if (Object.hasOwn(root, "maxOperations")) {
    result.maxOperations = positiveInteger(
      root.maxOperations as JsonValue,
      "maximum operations",
      MAX_OPERATIONS,
    );
  }
  if (Object.hasOwn(root, "callerNote")) {
    result.callerNote = text(
      root.callerNote as JsonValue,
      "caller note",
      MAX_NOTE,
      true,
    );
  }
  return Object.freeze(result);
}

function parsePreconditions(
  value: JsonValue,
): readonly OperationPrecondition[] {
  const input = array(value, "operation preconditions", 0, MAX_PRECONDITIONS);
  const result: OperationPrecondition[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = record(input[index] as JsonValue, "operation precondition");
    exactKeys(item, ["kind", "expected"], [], "operation precondition");
    result.push(
      Object.freeze({
        kind: text(item.kind as JsonValue, "precondition kind", MAX_REFERENCE),
        expected: freezeJsonValue(item.expected as JsonValue),
      }),
    );
  }
  return Object.freeze(result);
}

function parseOperationBase(input: SafeRecord): ResolvedOperationBase {
  const risk = text(input.risk as JsonValue, "operation risk", 32);
  if (!RISKS.has(risk)) return validationError("operation risk is invalid");
  return {
    operationId: text(
      input.operationId as JsonValue,
      "operation ID",
      MAX_REFERENCE,
    ),
    dependsOn: stringArray(
      input.dependsOn as JsonValue,
      "operation dependencies",
      MAX_OPERATIONS,
      MAX_REFERENCE,
      true,
    ),
    preconditions: parsePreconditions(input.preconditions as JsonValue),
    before: freezeJsonValue(input.before as JsonValue),
    after: freezeJsonValue(input.after as JsonValue),
    inverse: freezeJsonValue(input.inverse as JsonValue),
    risk: risk as ResolvedOperationBase["risk"],
  };
}

const COMMON_OPERATION_KEYS = [
  "operationId",
  "kind",
  "dependsOn",
  "preconditions",
  "before",
  "after",
  "inverse",
  "risk",
] as const;

function parseResolvedOperationValue(value: JsonValue): ResolvedOperation {
  const input = record(value, "resolved operation");
  const kind = text(input.kind as JsonValue, "resolved operation kind", 32);
  if (!OPERATION_KINDS.has(kind)) {
    return validationError("resolved operation kind is unsupported");
  }

  if (kind === "star" || kind === "unstar") {
    exactKeys(
      input,
      [
        ...COMMON_OPERATION_KEYS,
        "repositoryId",
        "repositoryDatabaseId",
        "coordinates",
      ],
      [],
      `${kind} operation`,
    );
    return Object.freeze({
      ...parseOperationBase(input),
      kind,
      repositoryId: repositoryId(
        input.repositoryId as JsonValue,
        "operation repository ID",
      ),
      repositoryDatabaseId: repositoryDatabaseId(
        input.repositoryDatabaseId as JsonValue,
        "operation repository database ID",
      ),
      coordinates: parseCoordinates(input.coordinates as JsonValue),
    });
  }
  if (kind === "list_create") {
    exactKeys(
      input,
      [...COMMON_OPERATION_KEYS, "clientRef"],
      [],
      "List create operation",
    );
    return Object.freeze({
      ...parseOperationBase(input),
      kind,
      clientRef: text(
        input.clientRef as JsonValue,
        "List client reference",
        MAX_REFERENCE,
      ),
    });
  }
  if (kind === "list_update" || kind === "list_delete") {
    exactKeys(
      input,
      [...COMMON_OPERATION_KEYS, "listId"],
      [],
      `${kind} operation`,
    );
    return Object.freeze({
      ...parseOperationBase(input),
      kind,
      listId: userListId(input.listId as JsonValue, "operation List ID"),
    });
  }

  exactKeys(
    input,
    [
      ...COMMON_OPERATION_KEYS,
      "repositoryId",
      "repositoryDatabaseId",
      "coordinates",
      "expectedListIds",
      "targetLists",
    ],
    [],
    "List membership operation",
  );
  const targetInputs = array(
    input.targetLists as JsonValue,
    "resolved List targets",
    0,
    MAX_IDS,
  );
  const targetLists: ResolvedListTarget[] = [];
  for (let index = 0; index < targetInputs.length; index += 1) {
    targetLists.push(
      parseRequestedTarget(
        targetInputs[index] as JsonValue,
        true,
      ) as ResolvedListTarget,
    );
  }
  for (let index = 1; index < targetLists.length; index += 1) {
    const previous = targetLists[index - 1];
    const current = targetLists[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareResolvedTargets(previous, current) >= 0
    ) {
      return validationError("resolved List targets must be sorted and unique");
    }
  }
  return Object.freeze({
    ...parseOperationBase(input),
    kind: "list_membership_set",
    repositoryId: repositoryId(
      input.repositoryId as JsonValue,
      "operation repository ID",
    ),
    repositoryDatabaseId: repositoryDatabaseId(
      input.repositoryDatabaseId as JsonValue,
      "operation repository database ID",
    ),
    coordinates: parseCoordinates(input.coordinates as JsonValue),
    expectedListIds: idArray(
      input.expectedListIds as JsonValue,
      "expected List IDs",
      userListId,
      { minimum: 0, canonical: true },
    ),
    targetLists: Object.freeze(targetLists),
  });
}

export function parseResolvedOperation(input: unknown): ResolvedOperation {
  return parseResolvedOperationValue(canonicalJsonClone(input));
}

function compareResolvedTargets(
  left: ResolvedListTarget,
  right: ResolvedListTarget,
): number {
  if (left.kind !== right.kind) return left.kind === "existing" ? -1 : 1;
  return compareText(
    left.kind === "existing" ? left.listId : left.createOperationId,
    right.kind === "existing" ? right.listId : right.createOperationId,
  );
}

function parseDependency(value: JsonValue): OperationDependency {
  const input = record(value, "operation dependency");
  exactKeys(
    input,
    ["operationId", "dependsOnOperationId"],
    [],
    "operation dependency",
  );
  return Object.freeze({
    operationId: text(
      input.operationId as JsonValue,
      "dependent operation ID",
      MAX_REFERENCE,
    ),
    dependsOnOperationId: text(
      input.dependsOnOperationId as JsonValue,
      "prerequisite operation ID",
      MAX_REFERENCE,
    ),
  });
}

function compareDependencies(
  left: OperationDependency,
  right: OperationDependency,
): number {
  const dependent = compareText(left.operationId, right.operationId);
  return dependent === 0
    ? compareText(left.dependsOnOperationId, right.dependsOnOperationId)
    : dependent;
}

function graphOrder(
  operations: readonly GraphOperation[],
  dependencies: readonly OperationDependency[],
): readonly string[] {
  const indexes = new Map<string, number>();
  const embedded = new Map<string, Set<string>>();
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation === undefined || indexes.has(operation.operationId)) {
      return validationError("operation IDs must be unique");
    }
    indexes.set(operation.operationId, index);
    const dependsOn = new Set<string>();
    for (
      let dependencyIndex = 0;
      dependencyIndex < operation.dependsOn.length;
      dependencyIndex += 1
    ) {
      const dependency = operation.dependsOn[dependencyIndex];
      if (dependency === undefined || dependsOn.has(dependency)) {
        return validationError(
          "embedded operation dependencies must be unique",
        );
      }
      dependsOn.add(dependency);
    }
    embedded.set(operation.operationId, dependsOn);
  }

  const external = new Map<string, Set<string>>();
  const edgeKeys = new Set<string>();
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    if (dependency === undefined) {
      return validationError("operation dependency is invalid");
    }
    if (
      !indexes.has(dependency.operationId) ||
      !indexes.has(dependency.dependsOnOperationId)
    ) {
      return validationError("operation dependency endpoint is unknown");
    }
    if (dependency.operationId === dependency.dependsOnOperationId) {
      return validationError("operation cannot depend on itself");
    }
    const edgeKey = canonicalJson([
      dependency.operationId,
      dependency.dependsOnOperationId,
    ]);
    if (edgeKeys.has(edgeKey)) {
      return validationError("operation dependency edges must be unique");
    }
    edgeKeys.add(edgeKey);
    const set = external.get(dependency.operationId) ?? new Set<string>();
    set.add(dependency.dependsOnOperationId);
    external.set(dependency.operationId, set);
  }

  for (const operation of operations) {
    const expected = embedded.get(operation.operationId) ?? new Set<string>();
    const actual = external.get(operation.operationId) ?? new Set<string>();
    if (
      expected.size !== actual.size ||
      [...expected].some((dependency) => !actual.has(dependency))
    ) {
      return validationError(
        "embedded and explicit operation dependencies must match",
      );
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const operation of operations) {
    indegree.set(operation.operationId, operation.dependsOn.length);
    dependents.set(operation.operationId, []);
  }
  for (const dependency of dependencies) {
    const children = dependents.get(dependency.dependsOnOperationId);
    if (children === undefined) {
      return validationError("operation dependency endpoint is unknown");
    }
    children.push(dependency.operationId);
  }

  const emitted = new Set<string>();
  const result: string[] = [];
  while (result.length < operations.length) {
    let chosen: GraphOperation | undefined;
    for (let index = 0; index < operations.length; index += 1) {
      const candidate = operations[index];
      if (
        candidate !== undefined &&
        !emitted.has(candidate.operationId) &&
        indegree.get(candidate.operationId) === 0
      ) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === undefined) {
      return validationError("operation dependency graph contains a cycle");
    }
    emitted.add(chosen.operationId);
    result.push(chosen.operationId);
    const children = dependents.get(chosen.operationId) ?? [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      const current = indegree.get(child);
      if (current === undefined) {
        return validationError("operation dependency endpoint is unknown");
      }
      indegree.set(child, current - 1);
    }
  }
  return Object.freeze(result);
}

function parseGraphOnly(input: unknown): {
  readonly operations: readonly GraphOperation[];
  readonly dependencies: readonly OperationDependency[];
} {
  const root = record(canonicalJsonClone(input), "operation graph");
  exactKeys(root, ["operations", "dependencies"], [], "operation graph");
  const operationInputs = array(
    root.operations as JsonValue,
    "graph operations",
    0,
    MAX_OPERATIONS,
  );
  const operations: GraphOperation[] = [];
  for (let index = 0; index < operationInputs.length; index += 1) {
    const operation = record(
      operationInputs[index] as JsonValue,
      "graph operation",
    );
    if (
      !Object.hasOwn(operation, "operationId") ||
      !Object.hasOwn(operation, "dependsOn")
    ) {
      return validationError("graph operation lacks dependency fields");
    }
    operations.push(
      Object.freeze({
        operationId: text(
          operation.operationId as JsonValue,
          "graph operation ID",
          MAX_REFERENCE,
        ),
        dependsOn: stringArray(
          operation.dependsOn as JsonValue,
          "embedded operation dependencies",
          MAX_OPERATIONS,
          MAX_REFERENCE,
          false,
        ),
      }),
    );
  }
  const dependencyInputs = array(
    root.dependencies as JsonValue,
    "graph dependencies",
    0,
    MAX_DEPENDENCIES,
  );
  const dependencies: OperationDependency[] = [];
  for (let index = 0; index < dependencyInputs.length; index += 1) {
    dependencies.push(parseDependency(dependencyInputs[index] as JsonValue));
  }
  return {
    operations: Object.freeze(operations),
    dependencies: Object.freeze(dependencies),
  };
}

export function topologicalOperationIds(
  operations: readonly ResolvedOperation[],
  dependencies: readonly OperationDependency[],
): readonly string[] {
  const parsed = parseGraphOnly({ operations, dependencies });
  return graphOrder(parsed.operations, parsed.dependencies);
}

export function reverseDependencyOperationIds(
  operations: readonly ResolvedOperation[],
  dependencies: readonly OperationDependency[],
): readonly string[] {
  return Object.freeze(
    [...topologicalOperationIds(operations, dependencies)].reverse(),
  );
}

function parsePlanExecutableSafe(value: JsonValue): PlanExecutableContent {
  const root = record(value, "plan executable");
  exactKeys(
    root,
    [
      "schemaVersion",
      "policyVersion",
      "binding",
      "snapshotId",
      "protectedRepositoryIds",
      "protectedListIds",
      "operations",
      "dependencies",
    ],
    [],
    "plan executable",
  );
  if (root.schemaVersion !== 1 || root.policyVersion !== "1") {
    return validationError("plan executable version is unsupported");
  }

  const operationInputs = array(
    root.operations as JsonValue,
    "resolved operations",
    0,
    MAX_OPERATIONS,
  );
  const operations: ResolvedOperation[] = [];
  for (let index = 0; index < operationInputs.length; index += 1) {
    operations.push(
      parseResolvedOperationValue(operationInputs[index] as JsonValue),
    );
  }

  const dependencyInputs = array(
    root.dependencies as JsonValue,
    "operation dependencies",
    0,
    MAX_DEPENDENCIES,
  );
  const dependencies: OperationDependency[] = [];
  for (let index = 0; index < dependencyInputs.length; index += 1) {
    dependencies.push(parseDependency(dependencyInputs[index] as JsonValue));
  }
  for (let index = 1; index < dependencies.length; index += 1) {
    const previous = dependencies[index - 1];
    const current = dependencies[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareDependencies(previous, current) >= 0
    ) {
      return validationError(
        "operation dependencies must be sorted and unique",
      );
    }
  }
  graphOrder(operations, dependencies);

  const operationById = new Map(
    operations.map((operation) => [operation.operationId, operation] as const),
  );
  const clientReferences = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "list_create") {
      if (clientReferences.has(operation.clientRef)) {
        return validationError("List create client references must be unique");
      }
      clientReferences.add(operation.clientRef);
    }
    if (operation.kind === "list_membership_set") {
      for (const target of operation.targetLists) {
        if (target.kind !== "created") continue;
        const creator = operationById.get(target.createOperationId);
        if (
          creator?.kind !== "list_create" ||
          !operation.dependsOn.includes(target.createOperationId)
        ) {
          return validationError(
            "created List targets require their List create dependency",
          );
        }
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    policyVersion: "1",
    binding: parseBinding(root.binding as JsonValue),
    snapshotId: snapshotId(root.snapshotId as JsonValue, "snapshot ID"),
    protectedRepositoryIds: idArray(
      root.protectedRepositoryIds as JsonValue,
      "protected repository IDs",
      repositoryId,
      { minimum: 0, canonical: true },
    ),
    protectedListIds: idArray(
      root.protectedListIds as JsonValue,
      "protected List IDs",
      userListId,
      { minimum: 0, canonical: true },
    ),
    operations: Object.freeze(operations),
    dependencies: Object.freeze(dependencies),
  });
}

export function parsePlanExecutable(input: unknown): PlanExecutableContent {
  return parsePlanExecutableSafe(canonicalJsonClone(input));
}

export function hashPlanExecutable(input: unknown): string {
  return sha256Hex(canonicalJson(parsePlanExecutable(input)));
}

function parseWarnings(value: JsonValue): readonly string[] {
  return stringArray(value, "warnings", 1_000, MAX_WARNING, false);
}

function parsePlanState(value: JsonValue): PlanState {
  const state = text(value, "plan state", 16);
  if (!PLAN_STATES.has(state as PlanState)) {
    return validationError("plan state is invalid");
  }
  return state as PlanState;
}

export function parseChangePlan(input: unknown): ChangePlan {
  const root = record(canonicalJsonClone(input), "change plan");
  exactKeys(
    root,
    [
      "id",
      "hash",
      "state",
      "createdAt",
      "expiresAt",
      "callerNote",
      "executable",
      "operations",
      "dependencies",
      "warnings",
    ],
    [],
    "change plan",
  );
  const executable = parsePlanExecutableSafe(root.executable as JsonValue);
  if (
    canonicalJson(root.operations) !== canonicalJson(executable.operations) ||
    canonicalJson(root.dependencies) !== canonicalJson(executable.dependencies)
  ) {
    return validationError(
      "change plan operation views must equal its executable content",
    );
  }
  const hash = text(root.hash as JsonValue, "plan hash", 64);
  if (!HASH.test(hash)) {
    return validationError("plan hash must be lowercase SHA-256 hex");
  }
  const expectedHash = sha256Hex(canonicalJson(executable));
  if (hash !== expectedHash) {
    throw new AppError(
      "PLAN_HASH_MISMATCH",
      "The supplied plan hash does not match its executable content",
    );
  }
  const createdAt = canonicalUtcTimestamp(root.createdAt, "plan createdAt");
  const expiresAt = canonicalUtcTimestamp(root.expiresAt, "plan expiresAt");
  if (expiresAt <= createdAt) {
    return validationError("plan expiry must be later than creation");
  }
  return Object.freeze({
    id: planId(root.id as JsonValue, "plan ID"),
    hash,
    state: parsePlanState(root.state as JsonValue),
    createdAt,
    expiresAt,
    callerNote:
      root.callerNote === null
        ? null
        : text(root.callerNote as JsonValue, "caller note", MAX_NOTE, true),
    executable,
    operations: executable.operations,
    dependencies: executable.dependencies,
    warnings: parseWarnings(root.warnings as JsonValue),
  });
}

const PLAN_TRANSITIONS = new Map<PlanState, ReadonlySet<PlanState>>([
  ["ready", new Set(["applying", "expired", "superseded"])],
  ["applying", new Set(["applied", "partial", "failed"])],
  ["partial", new Set(["applying"])],
  ["applied", new Set()],
  ["expired", new Set()],
  ["failed", new Set()],
  ["superseded", new Set()],
]);

export function transitionPlanState(
  current: PlanState,
  next: PlanState,
): PlanState {
  if (
    !PLAN_STATES.has(current) ||
    !PLAN_STATES.has(next) ||
    !PLAN_TRANSITIONS.get(current)?.has(next)
  ) {
    throw new AppError(
      "PRECONDITION_FAILED",
      "The requested plan state transition is not allowed",
    );
  }
  return next;
}
