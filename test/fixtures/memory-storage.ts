import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import type {
  AcquireLeaseInput,
  AuditPage,
  FinishRunOperationInput,
  IncompleteRunSummaries,
  Lease,
  LeaseGuard,
  ReconcileRunOperationInput,
  RunOperationAttemptPage,
  RunOperationReconciliationPage,
  StoragePort,
  StorageTransaction,
} from "../../src/app/ports/storage-port.js";
import {
  canonicalJson,
  canonicalJsonClone,
  freezeJsonValue,
  sha256Hex,
} from "../../src/domain/canonical-json.js";
import {
  createCursorCodec,
  hashFilter,
  type CursorCodec,
} from "../../src/domain/cursor.js";
import {
  AppError,
  type SerializedDomainError,
} from "../../src/domain/errors.js";
import {
  compareRepositories,
  filterRequiresListCoverage,
  matchesFilter,
  parseListMembershipQuery,
  parseListMembershipQueryPage,
  parseListQuery,
  parseListQueryPage,
  parseRepositoryQuery,
  parseRepositoryQueryPage,
  repositoryCursorPosition,
  type ListMembershipQueryPage,
  type ListQueryPage,
  type ListSummary,
  type RepositoryQueryPage,
} from "../../src/domain/filter.js";
import {
  asPlanId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
  type PlanId,
  type RepositoryDatabaseId,
  type RepositoryId,
  type RunId,
  type SnapshotId,
  type UserListId,
} from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import {
  parseChangePlan,
  transitionPlanState,
  type ChangePlan,
  type PlanState,
} from "../../src/domain/plan.js";
import {
  observedRepositoryMetadataSchema,
  repositoryFilterViewSchema,
  repositorySchema,
  repositoryViewSchema,
  type AccountBinding,
  type ObservedRepositoryMetadata,
  type Repository,
  type RepositoryFilterView,
  type RepositoryView,
  type StarRecord,
  type UserList,
} from "../../src/domain/repository.js";
import {
  parseChangeRun,
  parseRunOperation,
  parseRunOperationAttempt,
  parseRunOperationReconciliation,
  recoverRunState,
  transitionRunState,
  type ChangeRun,
  type RunOperation,
  type RunOperationAttempt,
  type RunOperationReconciliation,
  type RunOperationStatus,
  type RunState,
} from "../../src/domain/run.js";
import {
  parseSnapshot,
  parseSnapshotBatch,
  parseSnapshotCounts,
  parseSnapshotDraft,
  parseSnapshotVerificationBatch,
  type ListCoverage,
  type Snapshot,
} from "../../src/domain/snapshot.js";
import { canonicalUtcTimestamp } from "../../src/domain/timestamp.js";

/* eslint-disable @typescript-eslint/unbound-method -- Intrinsics are captured once and receiver-sensitive methods are invoked only through captured Reflect.apply. */
const objectGetOwnPropertyDescriptorAtLoad = Object.getOwnPropertyDescriptor;
const mapSizeGetterAtLoad = objectGetOwnPropertyDescriptorAtLoad(
  Map.prototype,
  "size",
)?.get;
const setSizeGetterAtLoad = objectGetOwnPropertyDescriptorAtLoad(
  Set.prototype,
  "size",
)?.get;
if (mapSizeGetterAtLoad === undefined || setSizeGetterAtLoad === undefined) {
  throw new Error("Map and Set size getters are required");
}

const freezeMemoryIntrinsics = Object.freeze;
const MEMORY_INTRINSICS = freezeMemoryIntrinsics({
  arrayIsArray: Array.isArray,
  arraySort: Array.prototype.sort,
  bufferCompare: Buffer.compare,
  bufferFrom: Buffer.from,
  mapConstructor: Map,
  mapDelete: Map.prototype.delete,
  mapForEach: Map.prototype.forEach,
  mapGet: Map.prototype.get,
  mapHas: Map.prototype.has,
  mapSet: Map.prototype.set,
  mapSizeGetter: mapSizeGetterAtLoad,
  numberMaxSafeInteger: Number.MAX_SAFE_INTEGER,
  numberIsSafeInteger: Number.isSafeInteger,
  objectCreate: Object.create,
  objectDefineProperties: Object.defineProperties,
  objectDefineProperty: Object.defineProperty,
  objectFreeze: freezeMemoryIntrinsics,
  objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  objectGetPrototypeOf: Object.getPrototypeOf,
  objectHasOwn: Object.hasOwn,
  objectIs: Object.is,
  objectKeys: Object.keys,
  objectPrototype: Object.prototype,
  proxyRevocable: Proxy.revocable,
  randomBytes,
  reflectApply: Reflect.apply,
  reflectDefineProperty: Reflect.defineProperty,
  reflectDeleteProperty: Reflect.deleteProperty,
  reflectGetPrototypeOf: Reflect.getPrototypeOf,
  reflectOwnKeys: Reflect.ownKeys,
  regexpTest: RegExp.prototype.test,
  setAdd: Set.prototype.add,
  setConstructor: Set,
  setForEach: Set.prototype.forEach,
  setHas: Set.prototype.has,
  setSizeGetter: setSizeGetterAtLoad,
  stringFromValue: String,
  stringLocaleCompare: String.prototype.localeCompare,
  stringTrim: String.prototype.trim,
  structuredClone: globalThis.structuredClone,
  uint8ArrayFill: Uint8Array.prototype.fill,
  utilIsProxy: utilTypes.isProxy,
  utilIsUint8Array: utilTypes.isUint8Array,
});
/* eslint-enable @typescript-eslint/unbound-method */

function createInternalArray<T>(): T[] {
  return [];
}

function appendInternalArray<T>(target: T[], value: T): void {
  if (
    !MEMORY_INTRINSICS.reflectDefineProperty(
      target,
      MEMORY_INTRINSICS.stringFromValue(target.length),
      {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      },
    )
  ) {
    throw new AppError("INTERNAL_ERROR", "internal array append failed");
  }
}

function arrayCopy<T>(input: readonly T[]): T[] {
  const result = createInternalArray<T>();
  for (let index = 0; index < input.length; index += 1) {
    appendInternalArray(result, input[index] as T);
  }
  return result;
}

function arrayFilter<T>(
  input: readonly T[],
  predicate: (value: T, index: number) => boolean,
): T[] {
  const result = createInternalArray<T>();
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] as T;
    if (predicate(value, index)) appendInternalArray(result, value);
  }
  return result;
}

function arrayMap<T, U>(
  input: readonly T[],
  transform: (value: T, index: number) => U,
): U[] {
  const result = createInternalArray<U>();
  for (let index = 0; index < input.length; index += 1) {
    appendInternalArray(result, transform(input[index] as T, index));
  }
  return result;
}

function arraySome<T>(
  input: readonly T[],
  predicate: (value: T, index: number) => boolean,
): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (predicate(input[index] as T, index)) return true;
  }
  return false;
}

function arrayIncludes<T>(input: readonly T[], expected: T): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] as T;
    if (value === expected || MEMORY_INTRINSICS.objectIs(value, expected)) {
      return true;
    }
  }
  return false;
}

function arraySlice<T>(input: readonly T[], start: number, end: number): T[] {
  const result = createInternalArray<T>();
  const startFromEnd = input.length + start;
  const endFromEnd = input.length + end;
  const first = start < 0 ? (startFromEnd < 0 ? 0 : startFromEnd) : start;
  const last = end < 0 ? (endFromEnd < 0 ? 0 : endFromEnd) : end;
  for (let index = first; index < input.length && index < last; index += 1) {
    appendInternalArray(result, input[index] as T);
  }
  return result;
}

function arrayAt<T>(input: readonly T[], index: number): T | undefined {
  const normalized = index < 0 ? input.length + index : index;
  return normalized < 0 || normalized >= input.length
    ? undefined
    : input[normalized];
}

function arrayIndexOf<T>(input: readonly T[], expected: T): number {
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === expected) return index;
  }
  return -1;
}

function arrayFindIndex<T>(
  input: readonly T[],
  predicate: (value: T, index: number) => boolean,
): number {
  for (let index = 0; index < input.length; index += 1) {
    if (predicate(input[index] as T, index)) return index;
  }
  return -1;
}

function arraySort<T>(
  input: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  const result = arrayCopy(input);
  MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.arraySort, result, [
    compare,
  ]);
  return result;
}

function mapGet<K, V>(target: ReadonlyMap<K, V>, key: K): V | undefined {
  return MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.mapGet, target, [
    key,
  ]) as V | undefined;
}

function mapSet<K, V>(target: Map<K, V>, key: K, value: V): void {
  MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.mapSet, target, [
    key,
    value,
  ]);
}

function mapHas<K, V>(target: ReadonlyMap<K, V>, key: K): boolean {
  return MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.mapHas, target, [
    key,
  ]);
}

function mapDelete<K, V>(target: Map<K, V>, key: K): boolean {
  return MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.mapDelete, target, [
    key,
  ]);
}

function mapSize<K, V>(target: ReadonlyMap<K, V>): number {
  return MEMORY_INTRINSICS.reflectApply(
    MEMORY_INTRINSICS.mapSizeGetter,
    target,
    [],
  ) as number;
}

function mapForEach<K, V>(
  target: ReadonlyMap<K, V>,
  callback: (value: V, key: K) => void,
): void {
  MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.mapForEach, target, [
    callback,
  ]);
}

function mapValuesArray<K, V>(target: ReadonlyMap<K, V>): V[] {
  const result = createInternalArray<V>();
  mapForEach(target, (value) => appendInternalArray(result, value));
  return result;
}

function mapKeysArray<K, V>(target: ReadonlyMap<K, V>): K[] {
  const result = createInternalArray<K>();
  mapForEach(target, (_value, key) => appendInternalArray(result, key));
  return result;
}

function mapEntriesArray<K, V>(target: ReadonlyMap<K, V>): [K, V][] {
  const result = createInternalArray<[K, V]>();
  mapForEach(target, (value, key) => appendInternalArray(result, [key, value]));
  return result;
}

function createMap<K, V>(): Map<K, V> {
  return new MEMORY_INTRINSICS.mapConstructor<K, V>();
}

function copyMap<K, V>(source: ReadonlyMap<K, V>): Map<K, V> {
  const result = createMap<K, V>();
  mapForEach(source, (value, key) => mapSet(result, key, value));
  return result;
}

function setHas<T>(target: ReadonlySet<T>, value: T): boolean {
  return MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.setHas, target, [
    value,
  ]);
}

function setAdd<T>(target: Set<T>, value: T): void {
  MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.setAdd, target, [value]);
}

function setSize<T>(target: ReadonlySet<T>): number {
  return MEMORY_INTRINSICS.reflectApply(
    MEMORY_INTRINSICS.setSizeGetter,
    target,
    [],
  ) as number;
}

function createSet<T>(): Set<T> {
  return new MEMORY_INTRINSICS.setConstructor<T>();
}

interface VerificationState {
  coverage: Exclude<ListCoverage, "collecting">;
  status: "collecting" | "finished";
  stars: Map<string, StarRecord>;
  lists: Map<string, UserList>;
  memberships: Map<string, { listId: UserListId; repositoryId: RepositoryId }>;
}

interface SnapshotRecord {
  snapshot: Snapshot;
  repositories: Map<string, ObservedRepositoryMetadata>;
  stars: Map<string, StarRecord>;
  lists: Map<string, UserList>;
  memberships: Map<string, { listId: UserListId; repositoryId: RepositoryId }>;
  verification: VerificationState | null;
  leaseName: string;
  leaseOwnerId: string;
}

interface RunRecord {
  run: ChangeRun;
  leaseName: string;
  leaseOwnerId: string;
}

interface MemoryState {
  leases: Map<string, Lease>;
  snapshots: Map<string, SnapshotRecord>;
  repositoryMetadata: Map<string, ObservedRepositoryMetadata>;
  repositoryVersions: Map<string, Repository>;
  repositoryDatabaseIds: Map<string, RepositoryDatabaseId>;
  repositoryIdsByDatabaseId: Map<string, RepositoryId>;
  plans: Map<string, ChangePlan>;
  runs: Map<string, RunRecord>;
  runByPlan: Map<string, string>;
  operations: Map<string, Map<string, RunOperation>>;
  attempts: Map<string, Map<number, RunOperationAttempt>>;
  reconciliations: Map<string, RunOperationReconciliation[]>;
}

export interface MemoryStorageOptions {
  readonly cursorKey?: Uint8Array;
}

type TransactionMethodName = keyof StorageTransaction;

const TRANSACTION_METHODS = MEMORY_INTRINSICS.objectFreeze([
  "assertLease",
  "createSnapshot",
  "appendSnapshotBatch",
  "beginSnapshotVerification",
  "appendSnapshotVerificationBatch",
  "finishSnapshotVerification",
  "completeSnapshot",
  "failSnapshot",
  "getCompleteSnapshot",
  "getLatestCompleteSnapshot",
  "getRepositoryMetadata",
  "getSnapshotRepository",
  "getSnapshotListSummary",
  "queryRepositories",
  "queryLists",
  "queryListMemberships",
  "hasStar",
  "savePlan",
  "getPlan",
  "compareAndSetPlanState",
  "createRun",
  "getRun",
  "getLatestRunForPlan",
  "compareAndSetRunState",
  "createRunOperation",
  "startRunOperation",
  "getRunOperation",
  "retryRunOperation",
  "listRunOperations",
  "listRunOperationsPage",
  "finishRunOperation",
  "reconcileRunOperation",
  "getRunOperationAttempt",
  "listRunOperationAttemptsPage",
  "listRunOperationReconciliationsPage",
  "acquireLease",
  "renewLease",
  "releaseLease",
] satisfies readonly TransactionMethodName[]);

function failure(
  code:
    | "VALIDATION_ERROR"
    | "NOT_FOUND"
    | "PRECONDITION_FAILED"
    | "CAPABILITY_UNAVAILABLE"
    | "STORAGE_ERROR",
  message: string,
  retryable = false,
  details: JsonValue = {},
): never {
  throw new AppError(code, message, { retryable, details });
}

function collectionChanged(message: string): never {
  return failure("PRECONDITION_FAILED", message, false, {
    reason: "collection_changed",
  });
}

function safeObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, JsonValue> {
  const clone = canonicalJsonClone(value);
  if (
    clone === null ||
    typeof clone !== "object" ||
    MEMORY_INTRINSICS.arrayIsArray(clone)
  ) {
    return failure("VALIDATION_ERROR", `${label} must be an object`);
  }
  const actual = MEMORY_INTRINSICS.objectKeys(clone);
  if (
    actual.length !== keys.length ||
    arraySome(actual, (key) => !arrayIncludes(keys, key))
  ) {
    return failure(
      "VALIDATION_ERROR",
      `${label} contains unsupported properties`,
    );
  }
  return clone as Record<string, JsonValue>;
}

function stableText(value: JsonValue, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !==
      MEMORY_INTRINSICS.reflectApply(MEMORY_INTRINSICS.stringTrim, value, [])
  ) {
    return failure("VALIDATION_ERROR", `${label} must be stable text`);
  }
  return value;
}

function stableSnapshotId(value: JsonValue): SnapshotId {
  try {
    return asSnapshotId(stableText(value, "snapshot ID"));
  } catch {
    return failure("VALIDATION_ERROR", "snapshot ID is invalid");
  }
}

function stablePlanId(value: JsonValue): PlanId {
  try {
    return asPlanId(stableText(value, "plan ID"));
  } catch {
    return failure("VALIDATION_ERROR", "plan ID is invalid");
  }
}

function stableRunId(value: JsonValue): RunId {
  try {
    return asRunId(stableText(value, "run ID"));
  } catch {
    return failure("VALIDATION_ERROR", "run ID is invalid");
  }
}

function integer(
  value: JsonValue,
  label: string,
  minimum: number,
  maximum = MEMORY_INTRINSICS.numberMaxSafeInteger,
): number {
  if (
    typeof value !== "number" ||
    !MEMORY_INTRINSICS.numberIsSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return failure(
      "VALIDATION_ERROR",
      `${label} must be an integer from ${MEMORY_INTRINSICS.stringFromValue(minimum)} to ${MEMORY_INTRINSICS.stringFromValue(maximum)}`,
    );
  }
  return value;
}

function nullableText(value: JsonValue, label: string): string | null {
  return value === null ? null : stableText(value, label);
}

function frozenClone<T>(value: T): T {
  return freezeJsonValue(canonicalJsonClone(value)) as unknown as T;
}

function cloneSnapshot(value: Snapshot): Snapshot {
  return parseSnapshot(value);
}

function clonePlan(value: ChangePlan): ChangePlan {
  return parseChangePlan(value);
}

function cloneRun(value: ChangeRun): ChangeRun {
  return parseChangeRun(value);
}

function cloneOperation(value: RunOperation): RunOperation {
  return parseRunOperation(value);
}

function cloneAttempt(value: RunOperationAttempt): RunOperationAttempt {
  return parseRunOperationAttempt(value);
}

function cloneReconciliation(
  value: RunOperationReconciliation,
): RunOperationReconciliation {
  return parseRunOperationReconciliation(value);
}

function emptyState(): MemoryState {
  return {
    leases: createMap(),
    snapshots: createMap(),
    repositoryMetadata: createMap(),
    repositoryVersions: createMap(),
    repositoryDatabaseIds: createMap(),
    repositoryIdsByDatabaseId: createMap(),
    plans: createMap(),
    runs: createMap(),
    runByPlan: createMap(),
    operations: createMap(),
    attempts: createMap(),
    reconciliations: createMap(),
  };
}

function bindingKey(binding: AccountBinding): string {
  return canonicalJson(binding);
}

function sameBinding(left: AccountBinding, right: AccountBinding): boolean {
  return bindingKey(left) === bindingKey(right);
}

function parseBinding(input: JsonValue): AccountBinding {
  const root = safeObject(
    input,
    ["host", "login", "accountId"],
    "account binding",
  );
  const host = stableText(root.host as JsonValue, "account host");
  if (host !== "github.com") {
    return failure("VALIDATION_ERROR", "account host must be github.com");
  }
  return MEMORY_INTRINSICS.objectFreeze({
    host,
    login: stableText(root.login as JsonValue, "account login"),
    accountId: stableText(root.accountId as JsonValue, "account ID"),
  });
}

function parseGuard(input: JsonValue): LeaseGuard {
  const root = safeObject(input, ["name", "ownerId", "now"], "lease guard");
  return MEMORY_INTRINSICS.objectFreeze({
    name: stableText(root.name as JsonValue, "lease name"),
    ownerId: stableText(root.ownerId as JsonValue, "lease owner"),
    now: canonicalUtcTimestamp(root.now, "lease guard now"),
  });
}

function parseAcquire(input: unknown): AcquireLeaseInput {
  const root = safeObject(
    input,
    ["name", "ownerId", "now", "expiresAt"],
    "lease input",
  );
  const now = canonicalUtcTimestamp(root.now, "lease now");
  const expiresAt = canonicalUtcTimestamp(root.expiresAt, "lease expiresAt");
  if (expiresAt <= now) {
    return failure("VALIDATION_ERROR", "lease expiry must be later than now");
  }
  return MEMORY_INTRINSICS.objectFreeze({
    name: stableText(root.name as JsonValue, "lease name"),
    ownerId: stableText(root.ownerId as JsonValue, "lease owner"),
    now,
    expiresAt,
  });
}

function assertLeaseCore(state: MemoryState, input: unknown): Lease {
  const guard = parseGuard(canonicalJsonClone(input));
  const lease = mapGet(state.leases, guard.name);
  if (
    lease === undefined ||
    lease.ownerId !== guard.ownerId ||
    lease.expiresAt <= guard.now
  ) {
    return failure(
      "PRECONDITION_FAILED",
      "lease is missing, expired, or owned by another caller",
    );
  }
  if (guard.now < lease.heartbeatAt) {
    return failure("PRECONDITION_FAILED", "lease time cannot move backward");
  }
  return frozenClone(lease);
}

function assertRecordLease(
  state: MemoryState,
  guardInput: JsonValue,
  record: { leaseName: string; leaseOwnerId: string },
): LeaseGuard {
  const guard = parseGuard(guardInput);
  assertLeaseCore(state, guard);
  if (
    record.leaseName !== guard.name ||
    record.leaseOwnerId !== guard.ownerId
  ) {
    return failure(
      "PRECONDITION_FAILED",
      "mutation lease does not own this record",
    );
  }
  return guard;
}

function snapshotRecord(state: MemoryState, id: SnapshotId): SnapshotRecord {
  const record = mapGet(state.snapshots, id);
  if (record === undefined) {
    return failure("NOT_FOUND", "snapshot was not found");
  }
  return record;
}

function completeSnapshotRecord(
  state: MemoryState,
  id: SnapshotId,
): SnapshotRecord {
  const record = mapGet(state.snapshots, id);
  if (record === undefined || record.snapshot.status !== "complete") {
    return failure("NOT_FOUND", "complete snapshot was not found");
  }
  return record;
}

function membershipKey(listId: UserListId, repositoryId: RepositoryId): string {
  return canonicalJson([listId, repositoryId]);
}

function binaryCompare(left: string, right: string): number {
  return MEMORY_INTRINSICS.bufferCompare(
    MEMORY_INTRINSICS.bufferFrom(left, "utf8"),
    MEMORY_INTRINSICS.bufferFrom(right, "utf8"),
  );
}

function metadataClone(
  input: ObservedRepositoryMetadata,
): ObservedRepositoryMetadata {
  return frozenClone(observedRepositoryMetadataSchema.parse(input));
}

function repositoryVersionHash(
  observation: ObservedRepositoryMetadata,
): string {
  return sha256Hex(canonicalJson(observation.repository));
}

function repositoryVersionKey(
  repositoryId: RepositoryId,
  versionHash: string,
): string {
  return canonicalJson([repositoryId, versionHash]);
}

function registerRepositoryVersion(
  versions: Map<string, Repository>,
  input: Repository,
  versionHash: string,
): Repository {
  if (
    !MEMORY_INTRINSICS.reflectApply(
      MEMORY_INTRINSICS.regexpTest,
      /^[0-9a-f]{64}$/u,
      [versionHash],
    )
  ) {
    return failure(
      "VALIDATION_ERROR",
      "repository metadata version hash is invalid",
    );
  }
  const repository = frozenClone(repositorySchema.parse(input));
  const key = repositoryVersionKey(repository.repositoryId, versionHash);
  const existing = mapGet(versions, key);
  if (
    existing !== undefined &&
    canonicalJson(existing) !== canonicalJson(repository)
  ) {
    return failure(
      "PRECONDITION_FAILED",
      "repository metadata version collision has different exact content",
    );
  }
  if (existing !== undefined) return existing;
  mapSet(versions, key, repository);
  return repository;
}

export function registerRepositoryVersionForTest(
  versions: Map<string, Repository>,
  repository: Repository,
  versionHash: string,
): Repository {
  return registerRepositoryVersion(versions, repository, versionHash);
}

function registerRepositoryIdentity(
  databaseIds: Map<string, RepositoryDatabaseId>,
  repositoryIds: Map<string, RepositoryId>,
  repository: Repository,
): void {
  const knownDatabaseId = mapGet(databaseIds, repository.repositoryId);
  if (
    knownDatabaseId !== undefined &&
    knownDatabaseId !== repository.repositoryDatabaseId
  ) {
    failure(
      "PRECONDITION_FAILED",
      "repository node ID has an immutable database identity",
    );
  }
  const knownRepositoryId = mapGet(
    repositoryIds,
    repository.repositoryDatabaseId,
  );
  if (
    knownRepositoryId !== undefined &&
    knownRepositoryId !== repository.repositoryId
  ) {
    failure(
      "PRECONDITION_FAILED",
      "repository database ID is already bound to another node ID",
    );
  }
  mapSet(databaseIds, repository.repositoryId, repository.repositoryDatabaseId);
  mapSet(
    repositoryIds,
    repository.repositoryDatabaseId,
    repository.repositoryId,
  );
}

function metadataIsNewer(
  candidate: ObservedRepositoryMetadata,
  current: ObservedRepositoryMetadata,
): boolean {
  return (
    candidate.observedAt > current.observedAt ||
    (candidate.observedAt === current.observedAt &&
      repositoryVersionHash(candidate) > repositoryVersionHash(current))
  );
}

function buildRepositoryFilterView(
  record: SnapshotRecord,
  repositoryId: RepositoryId,
): RepositoryFilterView | null {
  const observation = mapGet(record.repositories, repositoryId);
  const star = mapGet(record.stars, repositoryId);
  if (observation === undefined || star === undefined) return null;
  const listIds = arraySort(
    arrayMap(
      arrayFilter(
        mapValuesArray(record.memberships),
        (entry) => entry.repositoryId === repositoryId,
      ),
      (entry) => entry.listId,
    ),
    binaryCompare,
  );
  return frozenClone(
    repositoryFilterViewSchema.parse({
      ...observation.repository,
      starredAt: star.starredAt,
      listIds,
    }),
  );
}

function publicRepositoryView(view: RepositoryFilterView): RepositoryView {
  const publicView: Record<string, unknown> = { ...view };
  MEMORY_INTRINSICS.reflectDeleteProperty(publicView, "listIds");
  return frozenClone(repositoryViewSchema.parse(publicView));
}

function requireListCoverage(record: SnapshotRecord): void {
  if (record.snapshot.listCoverage !== "complete") {
    failure(
      "CAPABILITY_UNAVAILABLE",
      "this snapshot does not have complete List coverage",
    );
  }
}

function setEqual<T>(
  left: Map<string, T>,
  right: Map<string, T>,
  serialize: (value: T) => string,
): boolean {
  if (mapSize(left) !== mapSize(right)) return false;
  const entries = mapEntriesArray(left);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as [string, T];
    const key = entry[0];
    const value = entry[1];
    const candidate = mapGet(right, key);
    if (candidate === undefined || serialize(value) !== serialize(candidate)) {
      return false;
    }
  }
  return true;
}

function exactSnapshotSets(record: SnapshotRecord): boolean {
  const verification = record.verification;
  return (
    verification !== null &&
    verification.status === "finished" &&
    setEqual(record.stars, verification.stars, canonicalJson) &&
    setEqual(record.lists, verification.lists, canonicalJson) &&
    setEqual(record.memberships, verification.memberships, canonicalJson)
  );
}

function parseError(value: unknown): SerializedDomainError {
  const probe = parseRunOperation({
    runId: "validation",
    operationId: "validation",
    sequence: 0,
    status: "failed",
    reconciliation: "confirmed_not_applied",
    attempts: 0,
    before: null,
    after: null,
    externalRequestId: null,
    error: value,
    startedAt: null,
    finishedAt: "2000-01-01T00:00:00.000Z",
  });
  if (probe.error === null) {
    return failure("VALIDATION_ERROR", "serialized error is required");
  }
  return probe.error;
}

function operationKey(runId: RunId, operationId: string): string {
  return canonicalJson([runId, operationId]);
}

function operationsFor(
  state: MemoryState,
  runId: RunId,
): Map<string, RunOperation> {
  return mapGet(state.operations, runId) ?? createMap<string, RunOperation>();
}

function operationRecord(
  state: MemoryState,
  runId: RunId,
  operationId: string,
): RunOperation {
  const operations = mapGet(state.operations, runId);
  const operation =
    operations === undefined ? undefined : mapGet(operations, operationId);
  if (operation === undefined) {
    return failure("NOT_FOUND", "run operation was not found");
  }
  return operation;
}

function runRecord(state: MemoryState, id: RunId): RunRecord {
  const record = mapGet(state.runs, id);
  if (record === undefined) return failure("NOT_FOUND", "run was not found");
  return record;
}

function planRecord(state: MemoryState, id: PlanId): ChangePlan {
  const plan = mapGet(state.plans, id);
  if (plan === undefined) return failure("NOT_FOUND", "plan was not found");
  return plan;
}

function assertRunMutationLease(
  state: MemoryState,
  record: RunRecord,
  guardInput: JsonValue,
): LeaseGuard {
  return assertRecordLease(state, guardInput, record);
}

function parsePageBoundary(
  value: JsonValue,
  label: string,
  maximum: number | undefined,
): number | null {
  if (value === null) return null;
  const boundary = integer(value, label, 0);
  if (maximum === undefined || boundary > maximum) {
    return failure("VALIDATION_ERROR", `${label} is beyond the result set`);
  }
  return boundary;
}

function pageResult<T>(
  all: readonly T[],
  after: number | null,
  pageSize: number,
  sequence: (item: T) => number,
): { items: readonly T[]; next: number | null } {
  const remaining =
    after === null
      ? arrayCopy(all)
      : arrayFilter(all, (item) => sequence(item) > after);
  const items = arraySlice(remaining, 0, pageSize);
  return {
    items,
    next:
      remaining.length > items.length && items.length > 0
        ? sequence(arrayAt(items, -1) as T)
        : null,
  };
}

function recoveryError(kind: "pending" | "running"): SerializedDomainError {
  return MEMORY_INTRINSICS.objectFreeze({
    code: kind === "running" ? "RECONCILIATION_REQUIRED" : "INTERNAL_ERROR",
    message:
      kind === "running"
        ? "Dispatch outcome is unknown after interruption"
        : "Operation was interrupted before dispatch; dispatch did not occur",
    retryable: kind === "pending",
    details: MEMORY_INTRINSICS.objectFreeze({ recovered: true }),
  });
}

function recoverRun(state: MemoryState, record: RunRecord, now: string): void {
  const runId = record.run.id;
  const operations = mapGet(state.operations, runId);
  if (operations !== undefined) {
    const operationEntries = mapEntriesArray(operations);
    for (let index = 0; index < operationEntries.length; index += 1) {
      const entry = operationEntries[index] as [string, RunOperation];
      const id = entry[0];
      const operation = entry[1];
      if (operation.status === "pending") {
        mapSet(
          operations,
          id,
          parseRunOperation({
            ...operation,
            status: "failed",
            reconciliation: "confirmed_not_applied",
            after: null,
            externalRequestId: null,
            error: recoveryError("pending"),
            startedAt: null,
            finishedAt: now,
          }),
        );
      } else if (operation.status === "running") {
        const error = recoveryError("running");
        const recovered = parseRunOperation({
          ...operation,
          status: "unresolved",
          reconciliation: "unknown",
          after: null,
          externalRequestId: null,
          error,
          finishedAt: now,
        });
        mapSet(operations, id, recovered);
        const attempts = mapGet(state.attempts, operationKey(runId, id));
        const attempt =
          attempts === undefined
            ? undefined
            : mapGet(attempts, operation.attempts);
        if (attempts !== undefined && attempt?.status === "running") {
          mapSet(
            attempts,
            operation.attempts,
            parseRunOperationAttempt({
              ...attempt,
              status: "unresolved",
              reconciliation: "unknown",
              after: null,
              externalRequestId: null,
              error,
              finishedAt: now,
            }),
          );
        }
      }
    }
  }
  record.run = parseChangeRun({
    ...record.run,
    state: recoverRunState(
      record.run.state as Extract<RunState, "pending" | "running">,
    ),
    finishedAt: now,
  });
  const plan = mapGet(state.plans, record.run.planId);
  if (plan?.state === "applying") {
    mapSet(
      state.plans,
      plan.id,
      parseChangePlan({ ...plan, state: "partial" }),
    );
  }
}

function hasActiveStoredLease(
  state: MemoryState,
  record: { leaseName: string; leaseOwnerId: string },
  now: string,
): boolean {
  const lease = mapGet(state.leases, record.leaseName);
  return (
    lease !== undefined &&
    lease.ownerId === record.leaseOwnerId &&
    lease.expiresAt > now
  );
}

export function createMemoryStorage(
  options: MemoryStorageOptions = {},
): StoragePort {
  let state = emptyState();
  let migrated = false;
  let closed = false;
  let transactionActive = false;
  let transactionPoisoned = false;
  let codec: CursorCodec | null = null;
  let injectedKey: Uint8Array | null = null;
  let cursorKeyInput: Uint8Array | undefined;
  try {
    if (
      MEMORY_INTRINSICS.utilIsProxy(options) ||
      MEMORY_INTRINSICS.reflectGetPrototypeOf(options) !==
        MEMORY_INTRINSICS.objectPrototype
    ) {
      return failure("VALIDATION_ERROR", "storage options must be plain data");
    }
    const descriptors =
      MEMORY_INTRINSICS.objectGetOwnPropertyDescriptors(options);
    const keys = MEMORY_INTRINSICS.reflectOwnKeys(descriptors);
    if (
      arraySome(keys, (key) => key !== "cursorKey") ||
      (descriptors.cursorKey !== undefined &&
        (!MEMORY_INTRINSICS.objectHasOwn(descriptors.cursorKey, "value") ||
          descriptors.cursorKey.enumerable !== true))
    ) {
      return failure("VALIDATION_ERROR", "storage options must be plain data");
    }
    const descriptorValue: unknown = descriptors.cursorKey?.value;
    cursorKeyInput =
      descriptorValue === undefined
        ? undefined
        : (descriptorValue as Uint8Array);
  } catch (error) {
    if (error instanceof AppError) throw error;
    return failure("VALIDATION_ERROR", "storage options must be plain data");
  }
  if (cursorKeyInput !== undefined) {
    try {
      if (
        MEMORY_INTRINSICS.utilIsProxy(cursorKeyInput) ||
        !MEMORY_INTRINSICS.utilIsUint8Array(cursorKeyInput)
      ) {
        return failure("VALIDATION_ERROR", "cursor key must be a Uint8Array");
      }
      injectedKey = new Uint8Array(cursorKeyInput);
    } catch {
      return failure("VALIDATION_ERROR", "cursor key must be a Uint8Array");
    }
  }

  function ensureReady(): void {
    if (!migrated || closed) {
      failure("STORAGE_ERROR", "memory storage is not open and migrated");
    }
  }

  function ensureRoot(): void {
    if (transactionActive) {
      transactionPoisoned = true;
      failure(
        "PRECONDITION_FAILED",
        "root storage cannot be used during a transaction",
      );
    }
  }

  function requireCodec(): CursorCodec {
    if (codec === null) {
      return failure("STORAGE_ERROR", "cursor codec is not initialized");
    }
    return codec;
  }

  function callCore(
    name: TransactionMethodName,
    target: MemoryState,
    args: readonly unknown[],
  ): unknown {
    switch (name) {
      case "assertLease":
        return assertLeaseCore(target, args[0]);
      case "acquireLease": {
        const input = parseAcquire(args[0]);
        const existing = mapGet(target.leases, input.name);
        if (existing !== undefined && existing.expiresAt > input.now) {
          return null;
        }
        const lease = MEMORY_INTRINSICS.objectFreeze({
          name: input.name,
          ownerId: input.ownerId,
          acquiredAt: input.now,
          heartbeatAt: input.now,
          expiresAt: input.expiresAt,
        });
        mapSet(target.leases, input.name, lease);
        return frozenClone(lease);
      }
      case "renewLease": {
        const input = parseAcquire(args[0]);
        const existing = mapGet(target.leases, input.name);
        if (existing === undefined) {
          return failure("NOT_FOUND", "lease was not found");
        }
        if (
          existing.ownerId !== input.ownerId ||
          existing.expiresAt <= input.now ||
          input.now < existing.heartbeatAt ||
          input.expiresAt <= existing.expiresAt
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "lease cannot be renewed by this owner or time",
          );
        }
        const lease = MEMORY_INTRINSICS.objectFreeze({
          ...existing,
          heartbeatAt: input.now,
          expiresAt: input.expiresAt,
        });
        mapSet(target.leases, input.name, lease);
        return frozenClone(lease);
      }
      case "releaseLease": {
        const input = safeObject(
          args[0],
          ["name", "ownerId"],
          "release lease input",
        );
        const nameValue = stableText(input.name as JsonValue, "lease name");
        const ownerId = stableText(input.ownerId as JsonValue, "lease owner");
        const existing = mapGet(target.leases, nameValue);
        if (existing === undefined) {
          return failure("NOT_FOUND", "lease was not found");
        }
        if (existing.ownerId !== ownerId) {
          return failure(
            "PRECONDITION_FAILED",
            "lease belongs to another owner",
          );
        }
        mapDelete(target.leases, nameValue);
        return undefined;
      }
      case "createSnapshot": {
        const input = safeObject(
          args[0],
          ["draft", "lease"],
          "create snapshot input",
        );
        const draft = parseSnapshotDraft(input.draft);
        const guard = parseGuard(input.lease as JsonValue);
        assertLeaseCore(target, guard);
        if (mapHas(target.snapshots, draft.id)) {
          return failure("PRECONDITION_FAILED", "snapshot ID already exists");
        }
        const snapshot = parseSnapshot({
          ...draft,
          status: "building",
          completedAt: null,
          failedAt: null,
          counts: { repositories: 0, stars: 0, lists: 0, memberships: 0 },
          warningCount: 0,
          sourceRateLimit: null,
        });
        mapSet(target.snapshots, draft.id, {
          snapshot,
          repositories: createMap<string, ObservedRepositoryMetadata>(),
          stars: createMap<string, StarRecord>(),
          lists: createMap<string, UserList>(),
          memberships: createMap<
            string,
            { listId: UserListId; repositoryId: RepositoryId }
          >(),
          verification: null,
          leaseName: guard.name,
          leaseOwnerId: guard.ownerId,
        });
        return cloneSnapshot(snapshot);
      }
      case "appendSnapshotBatch": {
        const input = safeObject(
          args[0],
          ["id", "batch", "lease"],
          "append snapshot batch input",
        );
        const id = stableSnapshotId(input.id as JsonValue);
        const record = snapshotRecord(target, id);
        assertRecordLease(target, input.lease as JsonValue, record);
        if (record.snapshot.status !== "building") {
          return failure(
            "PRECONDITION_FAILED",
            "only a building snapshot accepts batches",
          );
        }
        const batch = parseSnapshotBatch(input.batch);
        if (
          record.snapshot.listCoverage !== "collecting" &&
          (batch.lists.length > 0 || batch.memberships.length > 0)
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "snapshot without List collection cannot accept List rows",
          );
        }
        const seenRepositories = createSet<string>();
        const seenStars = createSet<string>();
        const seenLists = createSet<string>();
        const seenMemberships = createSet<string>();
        const stagedVersions = copyMap(target.repositoryVersions);
        const stagedDatabaseIds = copyMap(target.repositoryDatabaseIds);
        const stagedRepositoryIds = copyMap(target.repositoryIdsByDatabaseId);
        const stagedObservations =
          createInternalArray<ObservedRepositoryMetadata>();
        for (let index = 0; index < batch.repositories.length; index += 1) {
          const observation = batch.repositories[
            index
          ] as ObservedRepositoryMetadata;
          const idValue = observation.repository.repositoryId;
          if (
            mapHas(record.repositories, idValue) ||
            setHas(seenRepositories, idValue)
          ) {
            return failure(
              "PRECONDITION_FAILED",
              "duplicate repository observation in snapshot",
            );
          }
          setAdd(seenRepositories, idValue);
          registerRepositoryIdentity(
            stagedDatabaseIds,
            stagedRepositoryIds,
            observation.repository,
          );
          const repository = registerRepositoryVersion(
            stagedVersions,
            observation.repository,
            repositoryVersionHash(observation),
          );
          appendInternalArray(
            stagedObservations,
            metadataClone({
              repository,
              observedAt: observation.observedAt,
            }),
          );
        }
        for (let index = 0; index < batch.stars.length; index += 1) {
          const star = batch.stars[index] as StarRecord;
          if (
            mapHas(record.stars, star.repositoryId) ||
            setHas(seenStars, star.repositoryId)
          ) {
            return failure("PRECONDITION_FAILED", "duplicate Star in snapshot");
          }
          setAdd(seenStars, star.repositoryId);
        }
        for (let index = 0; index < batch.lists.length; index += 1) {
          const list = batch.lists[index] as UserList;
          if (
            mapHas(record.lists, list.listId) ||
            setHas(seenLists, list.listId)
          ) {
            return failure("PRECONDITION_FAILED", "duplicate List in snapshot");
          }
          setAdd(seenLists, list.listId);
        }
        for (let index = 0; index < batch.memberships.length; index += 1) {
          const membership = batch.memberships[index] as {
            listId: UserListId;
            repositoryId: RepositoryId;
          };
          const key = membershipKey(membership.listId, membership.repositoryId);
          if (mapHas(record.memberships, key) || setHas(seenMemberships, key)) {
            return failure(
              "PRECONDITION_FAILED",
              "duplicate List membership in snapshot",
            );
          }
          setAdd(seenMemberships, key);
        }
        target.repositoryVersions = stagedVersions;
        target.repositoryDatabaseIds = stagedDatabaseIds;
        target.repositoryIdsByDatabaseId = stagedRepositoryIds;
        for (let index = 0; index < stagedObservations.length; index += 1) {
          const cloned = stagedObservations[
            index
          ] as ObservedRepositoryMetadata;
          const idValue = cloned.repository.repositoryId;
          mapSet(record.repositories, idValue, cloned);
          const current = mapGet(target.repositoryMetadata, idValue);
          if (current === undefined || metadataIsNewer(cloned, current)) {
            mapSet(target.repositoryMetadata, idValue, cloned);
          }
        }
        for (let index = 0; index < batch.stars.length; index += 1) {
          const star = batch.stars[index] as StarRecord;
          mapSet(record.stars, star.repositoryId, frozenClone(star));
        }
        for (let index = 0; index < batch.lists.length; index += 1) {
          const list = batch.lists[index] as UserList;
          mapSet(record.lists, list.listId, frozenClone(list));
        }
        for (let index = 0; index < batch.memberships.length; index += 1) {
          const membership = batch.memberships[index] as {
            listId: UserListId;
            repositoryId: RepositoryId;
          };
          mapSet(
            record.memberships,
            membershipKey(membership.listId, membership.repositoryId),
            frozenClone(membership),
          );
        }
        return undefined;
      }
      case "beginSnapshotVerification": {
        const input = safeObject(
          args[0],
          ["id", "listCoverage", "lease"],
          "begin snapshot verification input",
        );
        const id = stableSnapshotId(input.id as JsonValue);
        const record = snapshotRecord(target, id);
        assertRecordLease(target, input.lease as JsonValue, record);
        if (
          record.snapshot.status !== "building" ||
          record.verification !== null
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "snapshot verification cannot begin in this state",
          );
        }
        const coverage = input.listCoverage;
        if (
          coverage !== "complete" &&
          coverage !== "unavailable" &&
          coverage !== "omitted"
        ) {
          return failure("VALIDATION_ERROR", "final List coverage is invalid");
        }
        const legal =
          (record.snapshot.listCoverage === "collecting" &&
            coverage === "complete") ||
          (record.snapshot.listCoverage === "unavailable" &&
            coverage === "unavailable") ||
          (record.snapshot.listCoverage === "omitted" &&
            coverage === "omitted");
        if (!legal) {
          return failure(
            "PRECONDITION_FAILED",
            "List coverage transition is not allowed",
          );
        }
        record.verification = {
          coverage,
          status: "collecting",
          stars: createMap<string, StarRecord>(),
          lists: createMap<string, UserList>(),
          memberships: createMap<
            string,
            { listId: UserListId; repositoryId: RepositoryId }
          >(),
        };
        return undefined;
      }
      case "appendSnapshotVerificationBatch": {
        const input = safeObject(
          args[0],
          ["id", "batch", "lease"],
          "append snapshot verification input",
        );
        const id = stableSnapshotId(input.id as JsonValue);
        const record = snapshotRecord(target, id);
        assertRecordLease(target, input.lease as JsonValue, record);
        const verification = record.verification;
        if (
          record.snapshot.status !== "building" ||
          verification === null ||
          verification.status !== "collecting"
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "verification does not accept batches",
          );
        }
        const batch = parseSnapshotVerificationBatch(input.batch);
        if (
          verification.coverage !== "complete" &&
          (batch.lists.length > 0 || batch.memberships.length > 0)
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "verification without List coverage cannot accept List rows",
          );
        }
        const seenStars = createSet<string>();
        const seenLists = createSet<string>();
        const seenMemberships = createSet<string>();
        for (let index = 0; index < batch.stars.length; index += 1) {
          const star = batch.stars[index] as StarRecord;
          if (
            mapHas(verification.stars, star.repositoryId) ||
            setHas(seenStars, star.repositoryId)
          ) {
            return collectionChanged(
              "collection changed: duplicate verification Star",
            );
          }
          setAdd(seenStars, star.repositoryId);
        }
        for (let index = 0; index < batch.lists.length; index += 1) {
          const list = batch.lists[index] as UserList;
          if (
            mapHas(verification.lists, list.listId) ||
            setHas(seenLists, list.listId)
          ) {
            return collectionChanged(
              "collection changed: duplicate verification List",
            );
          }
          setAdd(seenLists, list.listId);
        }
        for (let index = 0; index < batch.memberships.length; index += 1) {
          const membership = batch.memberships[index] as {
            listId: UserListId;
            repositoryId: RepositoryId;
          };
          const key = membershipKey(membership.listId, membership.repositoryId);
          if (
            mapHas(verification.memberships, key) ||
            setHas(seenMemberships, key)
          ) {
            return collectionChanged(
              "collection changed: duplicate verification membership",
            );
          }
          setAdd(seenMemberships, key);
        }
        for (let index = 0; index < batch.stars.length; index += 1) {
          const star = batch.stars[index] as StarRecord;
          mapSet(verification.stars, star.repositoryId, frozenClone(star));
        }
        for (let index = 0; index < batch.lists.length; index += 1) {
          const list = batch.lists[index] as UserList;
          mapSet(verification.lists, list.listId, frozenClone(list));
        }
        for (let index = 0; index < batch.memberships.length; index += 1) {
          const membership = batch.memberships[index] as {
            listId: UserListId;
            repositoryId: RepositoryId;
          };
          mapSet(
            verification.memberships,
            membershipKey(membership.listId, membership.repositoryId),
            frozenClone(membership),
          );
        }
        return undefined;
      }
      case "finishSnapshotVerification": {
        const input = safeObject(
          args[0],
          ["id", "lease"],
          "finish snapshot verification input",
        );
        const id = stableSnapshotId(input.id as JsonValue);
        const record = snapshotRecord(target, id);
        assertRecordLease(target, input.lease as JsonValue, record);
        if (record.verification?.status !== "collecting") {
          return failure(
            "PRECONDITION_FAILED",
            "verification is not collecting",
          );
        }
        record.verification.status = "finished";
        return undefined;
      }
      case "completeSnapshot": {
        const input = safeObject(
          args[0],
          [
            "id",
            "completedAt",
            "listCoverage",
            "counts",
            "warningCount",
            "sourceRateLimit",
            "lease",
          ],
          "complete snapshot input",
        );
        const id = stableSnapshotId(input.id as JsonValue);
        const record = snapshotRecord(target, id);
        assertRecordLease(target, input.lease as JsonValue, record);
        if (
          record.snapshot.status !== "building" ||
          record.verification?.status !== "finished" ||
          record.verification.coverage !== input.listCoverage
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "snapshot is not ready for publication",
          );
        }
        const counts = parseSnapshotCounts(input.counts);
        const actual = {
          repositories: mapSize(record.repositories),
          stars: mapSize(record.stars),
          lists: mapSize(record.lists),
          memberships: mapSize(record.memberships),
        };
        if (canonicalJson(counts) !== canonicalJson(actual)) {
          return failure(
            "PRECONDITION_FAILED",
            "snapshot counts do not match staged rows",
          );
        }
        if (!exactSnapshotSets(record)) {
          return collectionChanged(
            "collection changed during snapshot verification",
          );
        }
        const repositoryIds = mapKeysArray(record.stars);
        for (let index = 0; index < repositoryIds.length; index += 1) {
          const repositoryId = repositoryIds[index] as string;
          if (!mapHas(record.repositories, repositoryId)) {
            return failure(
              "PRECONDITION_FAILED",
              "Star lacks pinned repository metadata",
            );
          }
        }
        const memberships = mapValuesArray(record.memberships);
        for (let index = 0; index < memberships.length; index += 1) {
          const membership = memberships[index] as {
            listId: UserListId;
            repositoryId: RepositoryId;
          };
          if (
            !mapHas(record.stars, membership.repositoryId) ||
            !mapHas(record.lists, membership.listId)
          ) {
            return failure(
              "PRECONDITION_FAILED",
              "membership endpoint is missing",
            );
          }
        }
        const completedAt = canonicalUtcTimestamp(
          input.completedAt,
          "snapshot completedAt",
        );
        const warningCount = integer(
          input.warningCount as JsonValue,
          "warning count",
          0,
        );
        record.snapshot = parseSnapshot({
          ...record.snapshot,
          status: "complete",
          listCoverage: input.listCoverage,
          completedAt,
          failedAt: null,
          counts,
          warningCount,
          sourceRateLimit: input.sourceRateLimit,
        });
        record.verification = null;
        return cloneSnapshot(record.snapshot);
      }
      case "failSnapshot": {
        const input = safeObject(
          args[0],
          ["id", "failedAt", "sourceRateLimit", "lease"],
          "fail snapshot input",
        );
        const id = stableSnapshotId(input.id as JsonValue);
        const record = snapshotRecord(target, id);
        assertRecordLease(target, input.lease as JsonValue, record);
        if (record.snapshot.status !== "building") {
          return failure(
            "PRECONDITION_FAILED",
            "only a building snapshot can fail",
          );
        }
        record.snapshot = parseSnapshot({
          ...record.snapshot,
          status: "failed",
          completedAt: null,
          failedAt: canonicalUtcTimestamp(input.failedAt, "snapshot failedAt"),
          counts: {
            repositories: mapSize(record.repositories),
            stars: mapSize(record.stars),
            lists: mapSize(record.lists),
            memberships: mapSize(record.memberships),
          },
          sourceRateLimit: input.sourceRateLimit,
        });
        record.verification = null;
        return cloneSnapshot(record.snapshot);
      }
      case "getCompleteSnapshot": {
        const id = asSnapshotId(
          stableText(args[0] as JsonValue, "snapshot ID"),
        );
        const record = mapGet(target.snapshots, id);
        return record?.snapshot.status === "complete"
          ? cloneSnapshot(record.snapshot)
          : null;
      }
      case "getLatestCompleteSnapshot": {
        const binding = parseBinding(canonicalJsonClone(args[0]));
        const candidates = arraySort(
          arrayFilter(
            mapValuesArray(target.snapshots),
            (record) =>
              record.snapshot.status === "complete" &&
              sameBinding(record.snapshot.binding, binding),
          ),
          (left, right) => {
            const byTime = MEMORY_INTRINSICS.reflectApply(
              MEMORY_INTRINSICS.stringLocaleCompare,
              right.snapshot.completedAt as string,
              [left.snapshot.completedAt as string],
            );
            return byTime === 0
              ? binaryCompare(right.snapshot.id, left.snapshot.id)
              : byTime;
          },
        );
        return candidates[0] === undefined
          ? null
          : cloneSnapshot(candidates[0].snapshot);
      }
      case "getRepositoryMetadata": {
        const id = asRepositoryId(
          stableText(args[0] as JsonValue, "repository ID"),
        );
        const metadata = mapGet(target.repositoryMetadata, id);
        return metadata === undefined ? null : metadataClone(metadata);
      }
      case "getSnapshotRepository": {
        const snapshotId = asSnapshotId(
          stableText(args[0] as JsonValue, "snapshot ID"),
        );
        const repositoryId = asRepositoryId(
          stableText(args[1] as JsonValue, "repository ID"),
        );
        const record = mapGet(target.snapshots, snapshotId);
        if (record?.snapshot.status !== "complete") return null;
        const view = buildRepositoryFilterView(record, repositoryId);
        return view === null ? null : publicRepositoryView(view);
      }
      case "getSnapshotListSummary": {
        const snapshotId = asSnapshotId(
          stableText(args[0] as JsonValue, "snapshot ID"),
        );
        const listId = asUserListId(
          stableText(args[1] as JsonValue, "List ID"),
        );
        const record = mapGet(target.snapshots, snapshotId);
        if (record?.snapshot.status !== "complete") return null;
        requireListCoverage(record);
        const list = mapGet(record.lists, listId);
        if (list === undefined) return null;
        return frozenClone({
          ...list,
          repositoryCount: arrayFilter(
            mapValuesArray(record.memberships),
            (membership) => membership.listId === listId,
          ).length,
        } satisfies ListSummary);
      }
      case "queryRepositories":
        return queryRepositoriesCore(target, args[0], requireCodec());
      case "queryLists":
        return queryListsCore(target, args[0], requireCodec());
      case "queryListMemberships":
        return queryMembershipsCore(target, args[0], requireCodec());
      case "hasStar": {
        const snapshotId = asSnapshotId(
          stableText(args[0] as JsonValue, "snapshot ID"),
        );
        const repositoryId = asRepositoryId(
          stableText(args[1] as JsonValue, "repository ID"),
        );
        const record = mapGet(target.snapshots, snapshotId);
        return (
          record?.snapshot.status === "complete" &&
          mapHas(record.stars, repositoryId)
        );
      }
      case "savePlan": {
        const plan = parseChangePlan(args[0]);
        if (plan.state !== "ready") {
          return failure(
            "PRECONDITION_FAILED",
            "a new plan must be in ready state",
          );
        }
        const current = mapGet(target.plans, plan.id);
        if (current !== undefined) {
          if (
            canonicalJson({ ...current, state: "ready" }) !==
            canonicalJson(plan)
          ) {
            return failure(
              "PRECONDITION_FAILED",
              "plan immutable content does not match",
            );
          }
          return undefined;
        }
        mapSet(target.plans, plan.id, plan);
        return undefined;
      }
      case "getPlan": {
        const id = asPlanId(stableText(args[0] as JsonValue, "plan ID"));
        const plan = mapGet(target.plans, id);
        return plan === undefined ? null : clonePlan(plan);
      }
      case "compareAndSetPlanState": {
        const input = safeObject(
          args[0],
          ["planId", "expected", "next"],
          "plan state input",
        );
        const planId = stablePlanId(input.planId as JsonValue);
        if (
          !MEMORY_INTRINSICS.arrayIsArray(input.expected) ||
          input.expected.length === 0
        ) {
          return failure(
            "VALIDATION_ERROR",
            "expected plan states must be non-empty",
          );
        }
        const expected = arrayMap(
          input.expected as readonly JsonValue[],
          (value) => stableText(value, "expected plan state") as PlanState,
        );
        const uniqueExpected = createSet<PlanState>();
        for (let index = 0; index < expected.length; index += 1) {
          setAdd(uniqueExpected, expected[index] as PlanState);
        }
        if (setSize(uniqueExpected) !== expected.length) {
          return failure(
            "VALIDATION_ERROR",
            "expected plan states must be unique",
          );
        }
        const next = stableText(
          input.next as JsonValue,
          "next plan state",
        ) as PlanState;
        for (let index = 0; index < expected.length; index += 1) {
          transitionPlanState(expected[index] as PlanState, next);
        }
        const current = planRecord(target, planId);
        if (!arrayIncludes(expected, current.state)) {
          return failure(
            "PRECONDITION_FAILED",
            "plan state does not match expected",
          );
        }
        const changed = parseChangePlan({ ...current, state: next });
        mapSet(target.plans, planId, changed);
        return clonePlan(changed);
      }
      case "createRun": {
        const input = safeObject(args[0], ["run", "lease"], "create run input");
        const run = parseChangeRun(input.run);
        const guard = parseGuard(input.lease as JsonValue);
        assertLeaseCore(target, guard);
        if (run.state !== "pending" || run.finishedAt !== null) {
          return failure("PRECONDITION_FAILED", "a new run must be pending");
        }
        const plan = planRecord(target, run.planId);
        if (!sameBinding(plan.executable.binding, run.binding)) {
          return failure(
            "PRECONDITION_FAILED",
            "run binding does not match its plan",
          );
        }
        const existingPlanRun = mapGet(target.runByPlan, run.planId);
        if (existingPlanRun !== undefined && existingPlanRun !== run.id) {
          return failure("PRECONDITION_FAILED", "a plan may have only one run");
        }
        const current = mapGet(target.runs, run.id);
        if (current !== undefined) {
          if (
            canonicalJson({
              ...current.run,
              state: "pending",
              finishedAt: null,
            }) !== canonicalJson(run)
          ) {
            return failure(
              "PRECONDITION_FAILED",
              "run immutable content does not match",
            );
          }
          return undefined;
        }
        if (plan.state !== "applying") {
          return failure(
            "PRECONDITION_FAILED",
            "a new run requires an applying plan",
          );
        }
        mapSet(target.runs, run.id, {
          run,
          leaseName: guard.name,
          leaseOwnerId: guard.ownerId,
        });
        mapSet(target.runByPlan, run.planId, run.id);
        mapSet(target.operations, run.id, createMap<string, RunOperation>());
        return undefined;
      }
      case "getRun": {
        const id = asRunId(stableText(args[0] as JsonValue, "run ID"));
        const run = mapGet(target.runs, id);
        return run === undefined ? null : cloneRun(run.run);
      }
      case "getLatestRunForPlan": {
        const planId = asPlanId(stableText(args[0] as JsonValue, "plan ID"));
        const runId = mapGet(target.runByPlan, planId);
        const run =
          runId === undefined ? undefined : mapGet(target.runs, runId);
        return run === undefined ? null : cloneRun(run.run);
      }
      case "compareAndSetRunState": {
        const input = safeObject(
          args[0],
          ["runId", "expected", "next", "finishedAt", "lease"],
          "run state input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        if (
          !MEMORY_INTRINSICS.arrayIsArray(input.expected) ||
          input.expected.length === 0
        ) {
          return failure(
            "VALIDATION_ERROR",
            "expected run states must be non-empty",
          );
        }
        const expected = arrayMap(
          input.expected as readonly JsonValue[],
          (value) => stableText(value, "expected run state") as RunState,
        );
        const uniqueExpected = createSet<RunState>();
        for (let index = 0; index < expected.length; index += 1) {
          setAdd(uniqueExpected, expected[index] as RunState);
        }
        if (setSize(uniqueExpected) !== expected.length) {
          return failure(
            "VALIDATION_ERROR",
            "expected run states must be unique",
          );
        }
        const next = stableText(
          input.next as JsonValue,
          "next run state",
        ) as RunState;
        for (let index = 0; index < expected.length; index += 1) {
          transitionRunState(expected[index] as RunState, next);
        }
        const record = runRecord(target, runId);
        const guard = parseGuard(input.lease as JsonValue);
        assertLeaseCore(target, guard);
        const isResume = record.run.state === "partial" && next === "running";
        if (
          record.leaseName !== guard.name ||
          (!isResume && record.leaseOwnerId !== guard.ownerId)
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "mutation lease does not own this run",
          );
        }
        if (!arrayIncludes(expected, record.run.state)) {
          return failure(
            "PRECONDITION_FAILED",
            "run state does not match expected",
          );
        }
        const terminal =
          next === "completed" || next === "partial" || next === "failed";
        const finishedAt =
          input.finishedAt === null
            ? null
            : canonicalUtcTimestamp(input.finishedAt, "run finishedAt");
        if (
          (terminal &&
            (finishedAt === null ||
              finishedAt < record.run.startedAt ||
              finishedAt < guard.now)) ||
          (!terminal && finishedAt !== null)
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "run finishedAt is invalid for the transition",
          );
        }
        record.run = parseChangeRun({
          ...record.run,
          state: next,
          finishedAt,
        });
        if (record.run.state === "running") {
          record.leaseName = guard.name;
          record.leaseOwnerId = guard.ownerId;
        }
        return cloneRun(record.run);
      }
      case "createRunOperation": {
        const input = safeObject(
          args[0],
          ["operation", "lease"],
          "create run operation input",
        );
        const operation = parseRunOperation(input.operation);
        const record = runRecord(target, operation.runId);
        assertRunMutationLease(target, record, input.lease as JsonValue);
        const plan = planRecord(target, record.run.planId);
        if (
          operation.status !== "pending" ||
          operation.reconciliation !== "not_required" ||
          operation.attempts !== 0
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "run operation is not canonical for creation",
          );
        }
        const expected = plan.operations[operation.sequence];
        if (
          expected === undefined ||
          expected.operationId !== operation.operationId ||
          canonicalJson(expected.before) !== canonicalJson(operation.before)
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "run operation does not match the immutable plan",
          );
        }
        const operations = mapGet(target.operations, operation.runId) as Map<
          string,
          RunOperation
        >;
        const current = mapGet(operations, operation.operationId);
        if (current !== undefined) {
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
            return failure(
              "PRECONDITION_FAILED",
              "operation immutable content does not match",
            );
          }
          return undefined;
        }
        if (plan.state !== "applying" || record.run.state !== "running") {
          return failure(
            "PRECONDITION_FAILED",
            "a new operation requires an applying plan and running run",
          );
        }
        if (
          arraySome(
            mapValuesArray(operations),
            (candidate) => candidate.sequence === operation.sequence,
          )
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "operation sequence already exists",
          );
        }
        mapSet(operations, operation.operationId, operation);
        return undefined;
      }
      case "startRunOperation": {
        const input = safeObject(
          args[0],
          ["runId", "operationId", "startedAt", "lease"],
          "start run operation input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        const operationId = stableText(
          input.operationId as JsonValue,
          "operation ID",
        );
        const record = runRecord(target, runId);
        const guard = assertRunMutationLease(
          target,
          record,
          input.lease as JsonValue,
        );
        const plan = planRecord(target, record.run.planId);
        const operation = operationRecord(target, runId, operationId);
        if (
          record.run.state !== "running" ||
          plan.state !== "applying" ||
          operation.status !== "pending"
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "operation cannot start in its current state",
          );
        }
        const startedAt = canonicalUtcTimestamp(
          input.startedAt,
          "operation startedAt",
        );
        if (startedAt < record.run.startedAt || startedAt < guard.now) {
          return failure(
            "PRECONDITION_FAILED",
            "operation startedAt is not fresh",
          );
        }
        const changed = parseRunOperation({
          ...operation,
          status: "running",
          reconciliation: "pending",
          attempts: operation.attempts + 1,
          after: null,
          externalRequestId: null,
          error: null,
          startedAt,
          finishedAt: null,
        });
        const attempt = parseRunOperationAttempt({
          runId,
          operationId,
          attempt: changed.attempts,
          before: operation.before,
          startedAt,
          status: "running",
          reconciliation: "pending",
          after: null,
          externalRequestId: null,
          error: null,
          finishedAt: null,
        });
        const runOperations = mapGet(target.operations, runId);
        if (runOperations !== undefined) {
          mapSet(runOperations, operationId, changed);
        }
        const key = operationKey(runId, operationId);
        const attempts =
          mapGet(target.attempts, key) ??
          createMap<number, RunOperationAttempt>();
        if (mapHas(attempts, changed.attempts)) {
          return failure(
            "PRECONDITION_FAILED",
            "attempt number already exists",
          );
        }
        mapSet(attempts, changed.attempts, attempt);
        mapSet(target.attempts, key, attempts);
        return cloneOperation(changed);
      }
      case "getRunOperation": {
        const input = safeObject(
          args[0],
          ["runId", "operationId"],
          "get run operation input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        const operationId = stableText(
          input.operationId as JsonValue,
          "operation ID",
        );
        const runOperations = mapGet(target.operations, runId);
        const operation =
          runOperations === undefined
            ? undefined
            : mapGet(runOperations, operationId);
        return operation === undefined ? null : cloneOperation(operation);
      }
      case "retryRunOperation": {
        const input = safeObject(
          args[0],
          ["runId", "operationId", "maxAttempts", "lease"],
          "retry run operation input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        const operationId = stableText(
          input.operationId as JsonValue,
          "operation ID",
        );
        const maxAttempts = integer(
          input.maxAttempts as JsonValue,
          "maximum attempts",
          1,
        );
        const record = runRecord(target, runId);
        assertRunMutationLease(target, record, input.lease as JsonValue);
        const operation = operationRecord(target, runId, operationId);
        const plan = planRecord(target, record.run.planId);
        if (
          record.run.state !== "running" ||
          plan.state !== "applying" ||
          operation.status !== "failed" ||
          operation.reconciliation !== "confirmed_not_applied" ||
          operation.error?.retryable !== true ||
          operation.attempts >= maxAttempts
        ) {
          return failure(
            "PRECONDITION_FAILED",
            "operation is not eligible for retry",
          );
        }
        const changed = parseRunOperation({
          ...operation,
          status: "pending",
          reconciliation: "not_required",
          after: null,
          externalRequestId: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        });
        const runOperations = mapGet(target.operations, runId);
        if (runOperations !== undefined) {
          mapSet(runOperations, operationId, changed);
        }
        return cloneOperation(changed);
      }
      case "listRunOperations": {
        const runId = asRunId(stableText(args[0] as JsonValue, "run ID"));
        return MEMORY_INTRINSICS.objectFreeze(
          arrayMap(
            arraySort(
              mapValuesArray(operationsFor(target, runId)),
              (left, right) => left.sequence - right.sequence,
            ),
            cloneOperation,
          ),
        );
      }
      case "listRunOperationsPage": {
        const input = safeObject(
          args[0],
          ["runId", "afterSequence", "pageSize"],
          "operation page input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        const pageSize = integer(
          input.pageSize as JsonValue,
          "page size",
          1,
          100,
        );
        const all = arraySort(
          mapValuesArray(operationsFor(target, runId)),
          (left, right) => left.sequence - right.sequence,
        );
        const maximum = arrayAt(all, -1)?.sequence;
        const after = parsePageBoundary(
          input.afterSequence as JsonValue,
          "operation sequence boundary",
          maximum,
        );
        const page = pageResult(all, after, pageSize, (item) => item.sequence);
        return frozenClone({
          items: arrayMap(page.items, cloneOperation),
          total: all.length,
          nextSequence: page.next,
        } satisfies AuditPage);
      }
      case "finishRunOperation":
        return finishOperationCore(target, args[0]);
      case "reconcileRunOperation":
        return reconcileOperationCore(target, args[0]);
      case "getRunOperationAttempt": {
        const input = safeObject(
          args[0],
          ["runId", "operationId", "attempt"],
          "get attempt input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        const operationId = stableText(
          input.operationId as JsonValue,
          "operation ID",
        );
        const attemptNumber = integer(
          input.attempt as JsonValue,
          "attempt number",
          1,
        );
        const attempts = mapGet(
          target.attempts,
          operationKey(runId, operationId),
        );
        const attempt =
          attempts === undefined ? undefined : mapGet(attempts, attemptNumber);
        return attempt === undefined ? null : cloneAttempt(attempt);
      }
      case "listRunOperationAttemptsPage": {
        const input = safeObject(
          args[0],
          ["runId", "operationId", "afterAttempt", "pageSize"],
          "attempt page input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        const operationId = stableText(
          input.operationId as JsonValue,
          "operation ID",
        );
        const pageSize = integer(
          input.pageSize as JsonValue,
          "page size",
          1,
          100,
        );
        const attempts = mapGet(
          target.attempts,
          operationKey(runId, operationId),
        );
        const all = arraySort(
          attempts === undefined
            ? createInternalArray<RunOperationAttempt>()
            : mapValuesArray(attempts),
          (left, right) => left.attempt - right.attempt,
        );
        const after = parsePageBoundary(
          input.afterAttempt as JsonValue,
          "attempt boundary",
          arrayAt(all, -1)?.attempt,
        );
        const page = pageResult(all, after, pageSize, (item) => item.attempt);
        return frozenClone({
          items: arrayMap(page.items, cloneAttempt),
          total: all.length,
          nextAttempt: page.next,
        } satisfies RunOperationAttemptPage);
      }
      case "listRunOperationReconciliationsPage": {
        const input = safeObject(
          args[0],
          ["runId", "operationId", "afterEventSequence", "pageSize"],
          "reconciliation page input",
        );
        const runId = stableRunId(input.runId as JsonValue);
        const operationId = stableText(
          input.operationId as JsonValue,
          "operation ID",
        );
        const pageSize = integer(
          input.pageSize as JsonValue,
          "page size",
          1,
          100,
        );
        const stored = mapGet(
          target.reconciliations,
          operationKey(runId, operationId),
        );
        const all = arraySort(
          stored === undefined
            ? createInternalArray<RunOperationReconciliation>()
            : arrayCopy(stored),
          (left, right) => left.eventSequence - right.eventSequence,
        );
        const after = parsePageBoundary(
          input.afterEventSequence as JsonValue,
          "reconciliation event boundary",
          arrayAt(all, -1)?.eventSequence,
        );
        const page = pageResult(
          all,
          after,
          pageSize,
          (item) => item.eventSequence,
        );
        return frozenClone({
          items: arrayMap(page.items, cloneReconciliation),
          total: all.length,
          nextEventSequence: page.next,
        } satisfies RunOperationReconciliationPage);
      }
    }
  }

  function queryRepositoriesCore(
    target: MemoryState,
    raw: unknown,
    cursorCodec: CursorCodec,
  ): RepositoryQueryPage {
    const query = parseRepositoryQuery(raw);
    const record = completeSnapshotRecord(target, query.snapshotId);
    if (filterRequiresListCoverage(query.filter)) requireListCoverage(record);
    const unsorted = createInternalArray<RepositoryFilterView>();
    const starredRepositoryIds = mapKeysArray(record.stars);
    for (let index = 0; index < starredRepositoryIds.length; index += 1) {
      const view = buildRepositoryFilterView(
        record,
        asRepositoryId(starredRepositoryIds[index] as string),
      );
      if (
        view !== null &&
        (query.filter === null || matchesFilter(view, query.filter))
      ) {
        appendInternalArray(unsorted, view);
      }
    }
    const selected = arraySort(unsorted, (left, right) =>
      compareRepositories(left, right, query.sort),
    );
    const languageCounts = createMap<string | null, number>();
    for (let index = 0; index < selected.length; index += 1) {
      const view = selected[index] as RepositoryFilterView;
      mapSet(
        languageCounts,
        view.primaryLanguage,
        (mapGet(languageCounts, view.primaryLanguage) ?? 0) + 1,
      );
    }
    const languages = arrayMap(
      arraySort(mapEntriesArray(languageCounts), (left, right) => {
        const leftLanguage = left[0];
        const rightLanguage = right[0];
        return leftLanguage === null
          ? -1
          : rightLanguage === null
            ? 1
            : binaryCompare(leftLanguage, rightLanguage);
      }),
      (entry) => ({ language: entry[0], count: entry[1] }),
    );
    let start = 0;
    const context = {
      kind: "repositories",
      snapshotId: query.snapshotId,
      filterHash: hashFilter(query.filter),
      sort: query.sort,
    } as const;
    if (query.cursor !== null) {
      const decoded = cursorCodec.decodeRepository(query.cursor, context);
      const index = arrayFindIndex(selected, (view) => {
        const position = repositoryCursorPosition(view, query.sort);
        return (
          view.repositoryId === decoded.repositoryId &&
          canonicalJson(position.values) === canonicalJson(decoded.values) &&
          canonicalJson(position.nulls) === canonicalJson(decoded.nulls)
        );
      });
      if (index < 0) {
        return failure(
          "VALIDATION_ERROR",
          "repository cursor boundary is not in this snapshot",
        );
      }
      start = index + 1;
    }
    const items = arraySlice(selected, start, start + query.pageSize);
    const nextCursor =
      start + items.length < selected.length && items.length > 0
        ? cursorCodec.encodeRepository(
            context,
            repositoryCursorPosition(
              arrayAt(items, -1) as RepositoryFilterView,
              query.sort,
            ),
          )
        : null;
    return parseRepositoryQueryPage({
      items: arrayMap(items, publicRepositoryView),
      total: selected.length,
      aggregates: {
        languages,
        archived: arrayFilter(selected, (view) => view.isArchived).length,
        forks: arrayFilter(selected, (view) => view.isFork).length,
      },
      nextCursor,
    });
  }

  function queryListsCore(
    target: MemoryState,
    raw: unknown,
    cursorCodec: CursorCodec,
  ): ListQueryPage {
    const query = parseListQuery(raw);
    const record = completeSnapshotRecord(target, query.snapshotId);
    requireListCoverage(record);
    const membershipValues = mapValuesArray(record.memberships);
    const lists = arraySort(
      arrayMap(mapValuesArray(record.lists), (list) => ({
        ...list,
        repositoryCount: arrayFilter(
          membershipValues,
          (membership) => membership.listId === list.listId,
        ).length,
      })),
      (left, right) => {
        const name = binaryCompare(left.name, right.name);
        return name === 0 ? binaryCompare(left.listId, right.listId) : name;
      },
    );
    const context = {
      v: 1,
      kind: "lists",
      snapshotId: query.snapshotId,
    } as const;
    let start = 0;
    if (query.cursor !== null) {
      const decoded = cursorCodec.decodeList(query.cursor, context);
      const index = arrayFindIndex(
        lists,
        (list) =>
          list.listId === decoded.listId &&
          canonicalJson([list.name]) === canonicalJson(decoded.values),
      );
      if (index < 0) {
        return failure(
          "VALIDATION_ERROR",
          "List cursor boundary is not in this snapshot",
        );
      }
      start = index + 1;
    }
    const items = arraySlice(lists, start, start + query.pageSize);
    return parseListQueryPage({
      coverage: "complete",
      items,
      total: lists.length,
      nextCursor:
        start + items.length < lists.length && items.length > 0
          ? cursorCodec.encodeList(context, {
              values: [(arrayAt(items, -1) as ListSummary).name],
              listId: (arrayAt(items, -1) as ListSummary).listId,
            })
          : null,
    });
  }

  function queryMembershipsCore(
    target: MemoryState,
    raw: unknown,
    cursorCodec: CursorCodec,
  ): ListMembershipQueryPage {
    const query = parseListMembershipQuery(raw);
    const record = completeSnapshotRecord(target, query.snapshotId);
    requireListCoverage(record);
    if (query.selector.kind === "list") {
      const selector = query.selector;
      const context = {
        v: 1,
        kind: "list_memberships",
        snapshotId: query.snapshotId,
        selector,
      } as const;
      const ids = arraySort(
        arrayMap(
          arrayFilter(
            mapValuesArray(record.memberships),
            (entry) => entry.listId === selector.listId,
          ),
          (entry) => entry.repositoryId,
        ),
        binaryCompare,
      );
      let start = 0;
      if (query.cursor !== null) {
        const decoded = cursorCodec.decodeListMembership(query.cursor, context);
        if (!("boundaryRepositoryId" in decoded)) {
          return failure("VALIDATION_ERROR", "membership cursor is invalid");
        }
        const index = arrayIndexOf(ids, decoded.boundaryRepositoryId);
        if (index < 0) {
          return failure(
            "VALIDATION_ERROR",
            "membership cursor boundary was not found",
          );
        }
        start = index + 1;
      }
      const repositoryIds = arraySlice(ids, start, start + query.pageSize);
      return parseListMembershipQueryPage({
        coverage: "complete",
        selector,
        repositoryIds,
        total: ids.length,
        nextCursor:
          start + repositoryIds.length < ids.length && repositoryIds.length > 0
            ? cursorCodec.encodeListMembership(context, {
                selector,
                boundaryRepositoryId: arrayAt(
                  repositoryIds,
                  -1,
                ) as RepositoryId,
              })
            : null,
      });
    }
    const selector = query.selector;
    const context = {
      v: 1,
      kind: "list_memberships",
      snapshotId: query.snapshotId,
      selector,
    } as const;
    const ids = arraySort(
      arrayMap(
        arrayFilter(
          mapValuesArray(record.memberships),
          (entry) => entry.repositoryId === selector.repositoryId,
        ),
        (entry) => entry.listId,
      ),
      binaryCompare,
    );
    let start = 0;
    if (query.cursor !== null) {
      const decoded = cursorCodec.decodeListMembership(query.cursor, context);
      if (!("boundaryListId" in decoded)) {
        return failure("VALIDATION_ERROR", "membership cursor is invalid");
      }
      const index = arrayIndexOf(ids, decoded.boundaryListId);
      if (index < 0) {
        return failure(
          "VALIDATION_ERROR",
          "membership cursor boundary was not found",
        );
      }
      start = index + 1;
    }
    const listIds = arraySlice(ids, start, start + query.pageSize);
    return parseListMembershipQueryPage({
      coverage: "complete",
      selector,
      listIds,
      total: ids.length,
      nextCursor:
        start + listIds.length < ids.length && listIds.length > 0
          ? cursorCodec.encodeListMembership(context, {
              selector,
              boundaryListId: arrayAt(listIds, -1) as UserListId,
            })
          : null,
    });
  }

  function finishOperationCore(
    target: MemoryState,
    raw: unknown,
  ): RunOperation {
    const root = canonicalJsonClone(raw);
    if (
      root === null ||
      typeof root !== "object" ||
      MEMORY_INTRINSICS.arrayIsArray(root)
    ) {
      return failure("VALIDATION_ERROR", "finish input must be an object");
    }
    const phase = (root as Record<string, JsonValue>).phase;
    if (phase !== "before_dispatch" && phase !== "after_dispatch") {
      return failure("VALIDATION_ERROR", "finish operation phase is invalid");
    }
    const input = root as unknown as FinishRunOperationInput;
    const expectedKeys =
      input.phase === "before_dispatch"
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
    safeObject(root, expectedKeys, "finish operation input");
    const runId = asRunId(stableText(input.runId, "run ID"));
    const operationId = stableText(input.operationId, "operation ID");
    const record = runRecord(target, runId);
    const guard = assertRunMutationLease(
      target,
      record,
      input.lease as unknown as JsonValue,
    );
    const plan = planRecord(target, record.run.planId);
    if (record.run.state !== "running" || plan.state !== "applying") {
      return failure(
        "PRECONDITION_FAILED",
        "operation finish requires a running apply lifecycle",
      );
    }
    const operation = operationRecord(target, runId, operationId);
    const finishedAt = canonicalUtcTimestamp(
      input.finishedAt,
      "operation finishedAt",
    );
    if (finishedAt < guard.now) {
      return failure(
        "PRECONDITION_FAILED",
        "operation finishedAt is not fresh",
      );
    }
    let changed: RunOperation;
    if (input.phase === "before_dispatch") {
      if (operation.status !== "pending") {
        return failure(
          "PRECONDITION_FAILED",
          "before-dispatch finish requires pending operation",
        );
      }
      changed = parseRunOperation({
        ...operation,
        status: input.status,
        reconciliation: input.reconciliation,
        after: null,
        externalRequestId: null,
        error: input.error === null ? null : parseError(input.error),
        startedAt: null,
        finishedAt,
      });
    } else {
      if (operation.status !== "running") {
        return failure(
          "PRECONDITION_FAILED",
          "after-dispatch finish requires running operation",
        );
      }
      const error = input.error === null ? null : parseError(input.error);
      changed = parseRunOperation({
        ...operation,
        status: input.status,
        reconciliation: input.reconciliation,
        after: input.after,
        externalRequestId: nullableText(
          input.externalRequestId,
          "external request ID",
        ),
        error,
        finishedAt,
      });
      const key = operationKey(runId, operationId);
      const attempts = mapGet(target.attempts, key);
      const attempt =
        attempts === undefined
          ? undefined
          : mapGet(attempts, operation.attempts);
      if (attempt?.status !== "running") {
        return failure(
          "PRECONDITION_FAILED",
          "current dispatch attempt is not running",
        );
      }
      if (attempts !== undefined) {
        mapSet(
          attempts,
          operation.attempts,
          parseRunOperationAttempt({
            ...attempt,
            status: input.status,
            reconciliation: input.reconciliation,
            after: input.after,
            externalRequestId: input.externalRequestId,
            error,
            finishedAt,
          }),
        );
      }
    }
    const operations = mapGet(target.operations, runId);
    if (operations !== undefined) {
      mapSet(operations, operationId, changed);
    }
    return cloneOperation(changed);
  }

  function reconcileOperationCore(
    target: MemoryState,
    raw: unknown,
  ): RunOperation {
    const input = safeObject(
      raw,
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
    ) as unknown as ReconcileRunOperationInput;
    const runId = asRunId(stableText(input.runId, "run ID"));
    const operationId = stableText(input.operationId, "operation ID");
    const record = runRecord(target, runId);
    const guard = assertRunMutationLease(
      target,
      record,
      input.lease as unknown as JsonValue,
    );
    const plan = planRecord(target, record.run.planId);
    if (record.run.state !== "running" || plan.state !== "applying") {
      return failure(
        "PRECONDITION_FAILED",
        "reconciliation requires a running apply lifecycle",
      );
    }
    const operation = operationRecord(target, runId, operationId);
    if (operation.status !== "unresolved") {
      return failure(
        "PRECONDITION_FAILED",
        "only an unresolved operation can be reconciled",
      );
    }
    const observedAt = canonicalUtcTimestamp(
      input.observedAt,
      "reconciliation observedAt",
    );
    if (
      observedAt < guard.now ||
      (operation.finishedAt !== null && observedAt < operation.finishedAt)
    ) {
      return failure(
        "PRECONDITION_FAILED",
        "reconciliation observedAt is not monotonic",
      );
    }
    const error = input.error === null ? null : parseError(input.error);
    const key = operationKey(runId, operationId);
    const events =
      mapGet(target.reconciliations, key) ??
      createInternalArray<RunOperationReconciliation>();
    const event = parseRunOperationReconciliation({
      runId,
      operationId,
      attempt: operation.attempts,
      eventSequence: events.length + 1,
      after: input.after,
      observedAt,
      status: input.status,
      reconciliation: input.reconciliation,
      error,
    });
    const changed = parseRunOperation({
      ...operation,
      status: input.status,
      reconciliation: input.reconciliation,
      after: input.after,
      error,
      finishedAt: observedAt,
    });
    appendInternalArray(events, event);
    mapSet(target.reconciliations, key, events);
    const operations = mapGet(target.operations, runId);
    if (operations !== undefined) {
      mapSet(operations, operationId, changed);
    }
    return cloneOperation(changed);
  }

  function rootCall(
    name: TransactionMethodName,
    args: readonly unknown[],
  ): unknown {
    ensureRoot();
    ensureReady();
    return callCore(name, state, args);
  }

  type PreparedTransactionResult =
    | { readonly accepted: true; readonly value: unknown }
    | { readonly accepted: false };

  function prepareTransactionResult(value: unknown): PreparedTransactionResult {
    if (value === undefined) {
      return { accepted: true, value: undefined };
    }
    try {
      return {
        accepted: true,
        value: freezeJsonValue(canonicalJsonClone(value)),
      };
    } catch {
      return { accepted: false };
    }
  }

  function withTransaction<T>(fn: (tx: StorageTransaction) => T): T {
    ensureRoot();
    ensureReady();
    if (typeof fn !== "function") {
      return failure(
        "VALIDATION_ERROR",
        "transaction callback must be synchronous",
      );
    }
    transactionActive = true;
    transactionPoisoned = false;
    const working = MEMORY_INTRINSICS.structuredClone(state);
    const token = { active: true };
    const methodCache = createMap<
      PropertyKey,
      (...args: unknown[]) => unknown
    >();
    const target = MEMORY_INTRINSICS.objectCreate(null) as object;
    const revocable = MEMORY_INTRINSICS.proxyRevocable(target, {
      get(_target, property) {
        if (!token.active) {
          return failure(
            "PRECONDITION_FAILED",
            "transaction facade is revoked",
          );
        }
        if (
          typeof property !== "string" ||
          !arrayIncludes(TRANSACTION_METHODS, property as TransactionMethodName)
        ) {
          return undefined;
        }
        const cached = mapGet(methodCache, property);
        if (cached !== undefined) return cached;
        const method = (...args: unknown[]): unknown => {
          if (!token.active) {
            return failure(
              "PRECONDITION_FAILED",
              "transaction facade is revoked",
            );
          }
          return callCore(property as TransactionMethodName, working, args);
        };
        mapSet(methodCache, property, method);
        return method;
      },
      has(_target, property) {
        return (
          typeof property === "string" &&
          arrayIncludes(TRANSACTION_METHODS, property as TransactionMethodName)
        );
      },
    });
    const facade = revocable.proxy as StorageTransaction;
    const revoke = revocable.revoke;
    try {
      const result = fn(facade);
      const preparedResult = prepareTransactionResult(result);
      if (transactionPoisoned) {
        return failure(
          "PRECONDITION_FAILED",
          "root storage reentry invalidated the transaction",
        );
      }
      if (!preparedResult.accepted) {
        return failure(
          "PRECONDITION_FAILED",
          "transaction return value must be bounded canonical synchronous data",
        );
      }
      state = working;
      return preparedResult.value as T;
    } finally {
      token.active = false;
      try {
        revoke();
      } finally {
        transactionActive = false;
        transactionPoisoned = false;
      }
    }
  }

  function recoverSnapshots(
    target: MemoryState,
    binding: AccountBinding | null,
    now: string,
    leaseName: string | null,
  ): readonly SnapshotId[] {
    const recovered = createInternalArray<SnapshotId>();
    const candidates = arrayFilter(
      mapValuesArray(target.snapshots),
      (record) =>
        record.snapshot.status === "building" &&
        (binding === null || sameBinding(record.snapshot.binding, binding)) &&
        (leaseName === null || record.leaseName === leaseName) &&
        !hasActiveStoredLease(target, record, now),
    );
    for (let index = 0; index < candidates.length; index += 1) {
      const record = candidates[index] as SnapshotRecord;
      record.snapshot = parseSnapshot({
        ...record.snapshot,
        status: "failed",
        failedAt: now,
        completedAt: null,
        counts: {
          repositories: mapSize(record.repositories),
          stars: mapSize(record.stars),
          lists: mapSize(record.lists),
          memberships: mapSize(record.memberships),
        },
      });
      record.verification = null;
      appendInternalArray(recovered, record.snapshot.id);
    }
    return MEMORY_INTRINSICS.objectFreeze(arraySort(recovered, binaryCompare));
  }

  function recoverRuns(
    target: MemoryState,
    binding: AccountBinding | null,
    now: string,
    leaseName: string | null,
  ): readonly RunId[] {
    const recovered = createInternalArray<RunId>();
    const candidates = arrayFilter(
      mapValuesArray(target.runs),
      (record) =>
        (record.run.state === "pending" || record.run.state === "running") &&
        (binding === null || sameBinding(record.run.binding, binding)) &&
        (leaseName === null || record.leaseName === leaseName) &&
        !hasActiveStoredLease(target, record, now),
    );
    for (let index = 0; index < candidates.length; index += 1) {
      const record = candidates[index] as RunRecord;
      recoverRun(target, record, now);
      appendInternalArray(recovered, record.run.id);
    }
    return MEMORY_INTRINSICS.objectFreeze(arraySort(recovered, binaryCompare));
  }

  const root = MEMORY_INTRINSICS.objectCreate(null) as Record<string, unknown>;
  for (let index = 0; index < TRANSACTION_METHODS.length; index += 1) {
    const name = TRANSACTION_METHODS[index] as TransactionMethodName;
    MEMORY_INTRINSICS.objectDefineProperty(root, name, {
      enumerable: true,
      value: (...args: unknown[]) => rootCall(name, args),
    });
  }
  MEMORY_INTRINSICS.objectDefineProperties(root, {
    migrate: {
      enumerable: true,
      value: () => {
        ensureRoot();
        if (closed) {
          failure("STORAGE_ERROR", "closed storage cannot be migrated");
        }
        if (migrated) return;
        const temporaryKey =
          injectedKey === null
            ? MEMORY_INTRINSICS.randomBytes(32)
            : injectedKey;
        try {
          codec = createCursorCodec(temporaryKey);
        } finally {
          MEMORY_INTRINSICS.reflectApply(
            MEMORY_INTRINSICS.uint8ArrayFill,
            temporaryKey,
            [0],
          );
          injectedKey = null;
        }
        migrated = true;
      },
    },
    getSchemaVersion: {
      enumerable: true,
      value: () => {
        ensureRoot();
        ensureReady();
        return 1;
      },
    },
    withTransaction: {
      enumerable: true,
      value: withTransaction,
    },
    getIncompleteRunSummaries: {
      enumerable: true,
      value: (raw: unknown): IncompleteRunSummaries => {
        ensureRoot();
        ensureReady();
        const input = safeObject(
          raw,
          ["binding", "limit"],
          "incomplete run summary input",
        );
        const binding = parseBinding(input.binding as JsonValue);
        const limit = integer(
          input.limit as JsonValue,
          "summary limit",
          1,
          100,
        );
        const runs = arraySort(
          arrayFilter(
            mapValuesArray(state.runs),
            (record) =>
              (record.run.state === "pending" ||
                record.run.state === "running" ||
                record.run.state === "partial") &&
              sameBinding(record.run.binding, binding),
          ),
          (left, right) => {
            const time = MEMORY_INTRINSICS.reflectApply(
              MEMORY_INTRINSICS.stringLocaleCompare,
              left.run.startedAt,
              [right.run.startedAt],
            );
            return time === 0 ? binaryCompare(left.run.id, right.run.id) : time;
          },
        );
        const items = arrayMap(arraySlice(runs, 0, limit), ({ run }) => {
          const counts: Record<RunOperationStatus, number> = {
            pending: 0,
            running: 0,
            succeeded: 0,
            skipped: 0,
            failed: 0,
            unresolved: 0,
          };
          const operationValues = mapValuesArray(operationsFor(state, run.id));
          for (let index = 0; index < operationValues.length; index += 1) {
            const operation = operationValues[index] as RunOperation;
            counts[operation.status] += 1;
          }
          const incompleteState: "pending" | "running" | "partial" =
            run.state === "pending"
              ? "pending"
              : run.state === "running"
                ? "running"
                : "partial";
          return {
            runId: run.id,
            planId: run.planId,
            state: incompleteState,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            counts,
          };
        });
        return frozenClone({
          items,
          total: runs.length,
          truncated: runs.length > items.length,
        });
      },
    },
    recoverAbandonedSnapshots: {
      enumerable: true,
      value: (raw: unknown): readonly SnapshotId[] => {
        ensureRoot();
        ensureReady();
        const input = safeObject(
          raw,
          ["binding", "lease"],
          "targeted snapshot recovery input",
        );
        const binding = parseBinding(input.binding as JsonValue);
        const guard = parseGuard(input.lease as JsonValue);
        assertLeaseCore(state, guard);
        const working = MEMORY_INTRINSICS.structuredClone(state);
        const recovered = recoverSnapshots(
          working,
          binding,
          guard.now,
          guard.name,
        );
        state = working;
        return recovered;
      },
    },
    recoverAbandonedRuns: {
      enumerable: true,
      value: (raw: unknown): readonly RunId[] => {
        ensureRoot();
        ensureReady();
        const input = safeObject(
          raw,
          ["binding", "lease"],
          "targeted run recovery input",
        );
        const binding = parseBinding(input.binding as JsonValue);
        const guard = parseGuard(input.lease as JsonValue);
        assertLeaseCore(state, guard);
        const working = MEMORY_INTRINSICS.structuredClone(state);
        const recovered = recoverRuns(working, binding, guard.now, guard.name);
        state = working;
        return recovered;
      },
    },
    recoverIncompleteSnapshots: {
      enumerable: true,
      value: (rawNow: unknown): readonly SnapshotId[] => {
        ensureRoot();
        ensureReady();
        const now = canonicalUtcTimestamp(rawNow, "recovery now");
        const working = MEMORY_INTRINSICS.structuredClone(state);
        const recovered = recoverSnapshots(working, null, now, null);
        state = working;
        return recovered;
      },
    },
    recoverInterruptedRuns: {
      enumerable: true,
      value: (rawNow: unknown): readonly RunId[] => {
        ensureRoot();
        ensureReady();
        const now = canonicalUtcTimestamp(rawNow, "recovery now");
        const working = MEMORY_INTRINSICS.structuredClone(state);
        const recovered = recoverRuns(working, null, now, null);
        state = working;
        return recovered;
      },
    },
    close: {
      enumerable: true,
      value: () => {
        ensureRoot();
        if (closed) return;
        closed = true;
        codec = null;
        if (injectedKey !== null) {
          MEMORY_INTRINSICS.reflectApply(
            MEMORY_INTRINSICS.uint8ArrayFill,
            injectedKey,
            [0],
          );
        }
        injectedKey = null;
      },
    },
  });
  return MEMORY_INTRINSICS.objectFreeze(root) as unknown as StoragePort;
}
