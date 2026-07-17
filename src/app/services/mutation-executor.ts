import { Buffer } from "node:buffer";
import type {
  CreateUserListInput,
  GitHubLiveReadPort,
  GitHubMutationPort,
  MutationReceipt,
  RepositoryIdentity,
  UpdateUserListInput,
  UserListMutationResult,
} from "../ports/github-port.js";
import {
  canonicalJson,
  canonicalJsonClone,
  freezeJsonValue,
} from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import type { RepositoryId, UserListId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import {
  parseResolvedOperation,
  type ResolvedOperation,
} from "../../domain/plan.js";
import type {
  RepositoryCoordinates,
  UserList,
} from "../../domain/repository.js";
import type { ExecutionOutcome } from "./mutation-pacer.js";

export type ExecutionContext = {
  readonly createdListIdsByOperationId: Map<string, UserListId>;
};

type PreparedStarMutation = Readonly<{
  kind: "star" | "unstar";
  coordinates: RepositoryCoordinates;
}>;

type PreparedCreateMutation = Readonly<{
  kind: "createUserList";
  input: CreateUserListInput;
}>;

type PreparedUpdateMutation = Readonly<{
  kind: "updateUserList";
  listId: UserListId;
  input: UpdateUserListInput;
}>;

type PreparedDeleteMutation = Readonly<{
  kind: "deleteUserList";
  listId: UserListId;
}>;

type PreparedMembershipMutation = Readonly<{
  kind: "setRepositoryListIds";
  repositoryId: RepositoryId;
  listIds: readonly UserListId[];
}>;

export type AllowlistedPreparedMutation =
  | PreparedStarMutation
  | PreparedCreateMutation
  | PreparedUpdateMutation
  | PreparedDeleteMutation
  | PreparedMembershipMutation;

export interface PreparedMutation {
  readonly operation: ResolvedOperation;
  readonly before: JsonValue;
  readonly mutation: AllowlistedPreparedMutation;
}

export type PrepareMutationResult =
  | Readonly<{
      kind: "skipped";
      outcome: ExecutionOutcome;
    }>
  | Readonly<{
      kind: "dispatch";
      prepared: PreparedMutation;
    }>;

type JsonObject = Readonly<{ [key: string]: JsonValue }>;

type PreparedRegistration = {
  readonly context: ExecutionContext;
  used: boolean;
};

type DispatchCompletion = Readonly<{
  receipt: MutationReceipt;
  createdListId: UserListId | null;
}>;

const OPERATION_KINDS = new Set<ResolvedOperation["kind"]>([
  "star",
  "unstar",
  "list_create",
  "list_update",
  "list_delete",
  "list_membership_set",
]);
const MAX_OPERATION_ID = 128;

function validationError(reason: string): AppError {
  return new AppError("VALIDATION_ERROR", "Prepared mutation is invalid", {
    retryable: false,
    details: { reason },
  });
}

function preconditionFailed(
  operation: ResolvedOperation,
  reason: string,
): AppError {
  return new AppError(
    "PRECONDITION_FAILED",
    "The live GitHub state no longer satisfies the operation precondition",
    {
      retryable: false,
      details: {
        operationId: operation.operationId,
        mutationName: operation.kind,
        reason,
      },
    },
  );
}

function cancelled(): AppError {
  return new AppError(
    "GITHUB_UNAVAILABLE",
    "Mutation execution was cancelled",
    {
      retryable: false,
      details: { reason: "cancelled" },
    },
  );
}

function reconciliationRequired(
  operation: ResolvedOperation,
  mutationName: AllowlistedPreparedMutation["kind"],
  cause?: unknown,
): AppError {
  return new AppError(
    "RECONCILIATION_REQUIRED",
    "The mutation completed without an exact verified after state",
    {
      retryable: false,
      details: {
        operationId: operation.operationId,
        mutationName,
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signalIsAborted(signal)) throw cancelled();
}

function frozenJson<T extends JsonValue>(value: T): T {
  return freezeJsonValue(canonicalJsonClone(value)) as T;
}

function jsonObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function safeJsonObject(value: JsonValue): JsonObject | null {
  try {
    return jsonObject(canonicalJsonClone(value));
  } catch {
    return null;
  }
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validOperationId(value: string): boolean {
  if (
    value.length <= 3 ||
    value.length > MAX_OPERATION_ID ||
    !value.startsWith("op_") ||
    value !== value.trim()
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return false;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function metadataState(value: JsonValue): JsonObject | null {
  const record = safeJsonObject(value);
  if (
    record === null ||
    typeof record.name !== "string" ||
    (record.description !== null && typeof record.description !== "string") ||
    typeof record.isPrivate !== "boolean"
  ) {
    return null;
  }
  return frozenJson({
    name: record.name,
    description: record.description,
    isPrivate: record.isPrivate,
  });
}

function completeListState(list: UserList): JsonObject {
  return frozenJson({
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

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedUniqueIds<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(utf8Compare));
}

function listIdsState(value: JsonValue): readonly UserListId[] | null {
  const record = safeJsonObject(value);
  const listIds = record?.listIds;
  if (
    !Array.isArray(listIds) ||
    listIds.some((candidate) => typeof candidate !== "string")
  ) {
    return null;
  }
  return sortedUniqueIds(listIds as readonly UserListId[]);
}

function stringArray(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (candidate) => typeof candidate === "string" && candidate.length > 0,
    )
  );
}

function validCoordinates(value: JsonValue | undefined): boolean {
  const record = value === undefined ? null : jsonObject(value);
  return (
    record !== null && text(record.owner) !== null && text(record.name) !== null
  );
}

function validCompleteList(value: JsonValue | undefined): boolean {
  const record = value === undefined ? null : jsonObject(value);
  return (
    record !== null &&
    text(record.listId) !== null &&
    text(record.name) !== null &&
    text(record.slug) !== null &&
    (record.description === null || typeof record.description === "string") &&
    typeof record.isPrivate === "boolean" &&
    text(record.createdAt) !== null &&
    text(record.updatedAt) !== null &&
    (record.lastAddedAt === null || typeof record.lastAddedAt === "string")
  );
}

function validMembershipTargets(value: JsonValue | undefined): boolean {
  if (!Array.isArray(value)) return false;
  return (value as readonly JsonValue[]).every((candidate) => {
    const target = jsonObject(candidate);
    if (target === null) return false;
    return target.kind === "existing"
      ? text(target.listId) !== null
      : target.kind === "created" &&
          typeof target.createOperationId === "string" &&
          validOperationId(target.createOperationId);
  });
}

function validMembershipAfterIds(value: JsonValue | undefined): boolean {
  if (!Array.isArray(value)) return false;
  return (value as readonly JsonValue[]).every((candidate) => {
    if (typeof candidate === "string") return candidate.length > 0;
    const reference = jsonObject(candidate);
    return (
      reference !== null &&
      typeof reference.createOperationId === "string" &&
      validOperationId(reference.createOperationId)
    );
  });
}

function operationShapeIsValid(record: JsonObject): boolean {
  if (
    typeof record.operationId !== "string" ||
    !validOperationId(record.operationId) ||
    typeof record.kind !== "string" ||
    !OPERATION_KINDS.has(record.kind as ResolvedOperation["kind"])
  ) {
    return false;
  }

  if (record.kind === "star" || record.kind === "unstar") {
    const before = jsonObject(record.before);
    const after = jsonObject(record.after);
    return (
      text(record.repositoryId) !== null &&
      typeof record.repositoryDatabaseId === "string" &&
      /^(0|[1-9]\d*)$/u.test(record.repositoryDatabaseId) &&
      validCoordinates(record.coordinates) &&
      before !== null &&
      typeof before.starred === "boolean" &&
      after !== null &&
      typeof after.starred === "boolean"
    );
  }

  if (record.kind === "list_create") {
    return (
      text(record.clientRef) !== null &&
      record.after !== undefined &&
      metadataState(record.after) !== null
    );
  }

  if (record.kind === "list_update") {
    return (
      text(record.listId) !== null &&
      record.before !== undefined &&
      metadataState(record.before) !== null &&
      record.after !== undefined &&
      metadataState(record.after) !== null
    );
  }

  if (record.kind === "list_delete") {
    const before = jsonObject(record.before);
    const after = jsonObject(record.after);
    return (
      text(record.listId) !== null &&
      before !== null &&
      validCompleteList(before.list) &&
      after !== null &&
      after.exists === false
    );
  }

  const before = jsonObject(record.before);
  const after = jsonObject(record.after);
  return (
    text(record.repositoryId) !== null &&
    typeof record.repositoryDatabaseId === "string" &&
    /^(0|[1-9]\d*)$/u.test(record.repositoryDatabaseId) &&
    validCoordinates(record.coordinates) &&
    stringArray(record.expectedListIds) &&
    validMembershipTargets(record.targetLists) &&
    before !== null &&
    stringArray(before.listIds) &&
    after !== null &&
    validMembershipAfterIds(after.listIds)
  );
}

function operationSnapshot(operation: ResolvedOperation): ResolvedOperation {
  const parsed = parseResolvedOperation(operation);
  const record = jsonObject(parsed as unknown as JsonValue);
  if (record === null || !operationShapeIsValid(record)) {
    throw validationError("invalid_operation");
  }
  if (parsed.dependsOn.some((operationId) => !validOperationId(operationId))) {
    throw validationError("invalid_operation");
  }
  return parsed;
}

function validContext(context: ExecutionContext): boolean {
  try {
    return (
      context !== null &&
      typeof context === "object" &&
      context.createdListIdsByOperationId instanceof Map
    );
  } catch {
    return false;
  }
}

function createdListId(
  context: ExecutionContext,
  operationId: string,
): UserListId | undefined {
  try {
    return context.createdListIdsByOperationId.get(operationId);
  } catch {
    throw validationError("invalid_execution_context");
  }
}

function hasCreatedListId(
  context: ExecutionContext,
  operationId: string,
): boolean {
  try {
    return context.createdListIdsByOperationId.has(operationId);
  } catch {
    throw validationError("invalid_execution_context");
  }
}

function repositoryIdentityMatches(
  operation: Extract<
    ResolvedOperation,
    { kind: "star" | "unstar" | "list_membership_set" }
  >,
  identity: RepositoryIdentity | null,
): boolean {
  return (
    identity !== null &&
    identity.repositoryId === operation.repositoryId &&
    identity.repositoryDatabaseId === operation.repositoryDatabaseId &&
    identity.coordinates.owner === operation.coordinates.owner &&
    identity.coordinates.name === operation.coordinates.name
  );
}

function targetListIds(
  operation: Extract<ResolvedOperation, { kind: "list_membership_set" }>,
  context: ExecutionContext,
): readonly UserListId[] {
  const ids: UserListId[] = [];
  for (const target of operation.targetLists) {
    if (target.kind === "existing") {
      ids.push(target.listId);
      continue;
    }
    const id = createdListId(context, target.createOperationId);
    if (id === undefined) {
      throw preconditionFailed(operation, "created_list_unresolved");
    }
    ids.push(id);
  }
  return sortedUniqueIds(ids);
}

function preparedMutation(
  operation: ResolvedOperation,
  context: ExecutionContext,
): AllowlistedPreparedMutation {
  if (operation.kind === "star" || operation.kind === "unstar") {
    return Object.freeze({
      kind: operation.kind,
      coordinates: Object.freeze({
        owner: operation.coordinates.owner,
        name: operation.coordinates.name,
      }),
    });
  }
  if (operation.kind === "list_create") {
    const after = metadataState(operation.after);
    if (after === null) throw validationError("invalid_create_after_state");
    return Object.freeze({
      kind: "createUserList",
      input: Object.freeze({
        name: after.name as string,
        description: after.description as string | null,
        isPrivate: after.isPrivate as boolean,
      }),
    });
  }
  if (operation.kind === "list_update") {
    const after = metadataState(operation.after);
    if (after === null) throw validationError("invalid_update_after_state");
    return Object.freeze({
      kind: "updateUserList",
      listId: operation.listId,
      input: Object.freeze({
        name: after.name as string,
        description: after.description as string | null,
        isPrivate: after.isPrivate as boolean,
      }),
    });
  }
  if (operation.kind === "list_delete") {
    return Object.freeze({
      kind: "deleteUserList",
      listId: operation.listId,
    });
  }
  if (operation.kind === "list_membership_set") {
    return Object.freeze({
      kind: "setRepositoryListIds",
      repositoryId: operation.repositoryId,
      listIds: targetListIds(operation, context),
    });
  }
  throw validationError("unsupported_operation");
}

function skippedOutcome(state: JsonValue): ExecutionOutcome {
  return Object.freeze({
    kind: "skipped",
    before: state,
    after: state,
    receipt: null,
  });
}

function succeededOutcome(
  before: JsonValue,
  after: JsonValue,
  receipt: MutationReceipt,
): ExecutionOutcome {
  const copiedReceipt = canonicalJsonClone(receipt);
  const receiptRecord = jsonObject(copiedReceipt);
  if (
    receiptRecord === null ||
    (receiptRecord.requestId !== null &&
      typeof receiptRecord.requestId !== "string") ||
    (receiptRecord.clientMutationId !== null &&
      typeof receiptRecord.clientMutationId !== "string")
  ) {
    throw validationError("invalid_mutation_receipt");
  }
  return Object.freeze({
    kind: "succeeded",
    before,
    after,
    receipt: Object.freeze({
      requestId: receiptRecord.requestId,
      clientMutationId: receiptRecord.clientMutationId,
    }),
  });
}

export class MutationExecutor {
  readonly #reads: GitHubLiveReadPort;
  readonly #mutations: GitHubMutationPort;
  readonly #prepared = new WeakMap<PreparedMutation, PreparedRegistration>();

  constructor(reads: GitHubLiveReadPort, mutations: GitHubMutationPort) {
    this.#reads = reads;
    this.#mutations = mutations;
  }

  async readCurrentState(
    operationInput: ResolvedOperation,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (!validContext(context)) {
      throw validationError("invalid_execution_context");
    }
    const operation = operationSnapshot(operationInput);
    throwIfAborted(signal);

    if (operation.kind === "star" || operation.kind === "unstar") {
      const identity = await this.#reads.getRepositoryIdentity(
        operation.coordinates,
        signal,
      );
      throwIfAborted(signal);
      if (!repositoryIdentityMatches(operation, identity)) {
        throw preconditionFailed(operation, "repository_identity_changed");
      }
      const starred = await this.#reads.checkStar(
        operation.coordinates,
        signal,
      );
      throwIfAborted(signal);
      return frozenJson({ starred });
    }

    if (operation.kind === "list_membership_set") {
      const identity = await this.#reads.getRepositoryIdentity(
        operation.coordinates,
        signal,
      );
      throwIfAborted(signal);
      if (!repositoryIdentityMatches(operation, identity)) {
        throw preconditionFailed(operation, "repository_identity_changed");
      }
      const ids = await this.#reads.getRepositoryListIds(
        operation.repositoryId,
        signal,
      );
      throwIfAborted(signal);
      return frozenJson({ listIds: sortedUniqueIds(ids) });
    }

    if (operation.kind === "list_create") {
      const id = createdListId(context, operation.operationId);
      if (id === undefined) return frozenJson({ exists: false });
      const list = await this.#reads.getUserList(id, signal);
      throwIfAborted(signal);
      return list === null
        ? frozenJson({ exists: false, listId: id })
        : completeListState(list);
    }

    if (operation.kind === "list_update" || operation.kind === "list_delete") {
      const list = await this.#reads.getUserList(operation.listId, signal);
      throwIfAborted(signal);
      if (list === null) return frozenJson({ exists: false });
      if (operation.kind === "list_update") {
        return frozenJson({
          listId: list.listId,
          name: list.name,
          description: list.description,
          isPrivate: list.isPrivate,
        });
      }
      return frozenJson({ list: completeListState(list) });
    }
    throw validationError("unsupported_operation");
  }

  matchesBefore(
    operationInput: ResolvedOperation,
    state: JsonValue,
    context: ExecutionContext,
  ): boolean {
    if (!validContext(context)) return false;
    let operation: ResolvedOperation;
    try {
      operation = operationSnapshot(operationInput);
    } catch {
      return false;
    }
    const actual = safeJsonObject(state);
    if (actual === null) return false;

    if (operation.kind === "star" || operation.kind === "unstar") {
      const before = safeJsonObject(operation.before);
      return (
        before !== null &&
        typeof before.starred === "boolean" &&
        actual.starred === before.starred
      );
    }

    if (operation.kind === "list_create") {
      return (
        !hasCreatedListId(context, operation.operationId) &&
        actual.exists === false
      );
    }

    if (operation.kind === "list_update") {
      const expected = metadataState(operation.before);
      const current = metadataState(state);
      return (
        actual.listId === operation.listId &&
        expected !== null &&
        current !== null &&
        sameJson(expected, current)
      );
    }

    if (operation.kind === "list_delete") {
      const before = safeJsonObject(operation.before);
      const expected = before?.list;
      return (
        expected !== undefined &&
        actual.list !== undefined &&
        sameJson(expected, actual.list)
      );
    }

    if (operation.kind === "list_membership_set") {
      const currentIds = listIdsState(state);
      return (
        currentIds !== null &&
        sameJson(currentIds, sortedUniqueIds(operation.expectedListIds))
      );
    }
    return false;
  }

  matchesAfter(
    operationInput: ResolvedOperation,
    state: JsonValue,
    context: ExecutionContext,
  ): boolean {
    if (!validContext(context)) return false;
    let operation: ResolvedOperation;
    try {
      operation = operationSnapshot(operationInput);
    } catch {
      return false;
    }
    const actual = safeJsonObject(state);
    if (actual === null) return false;

    if (operation.kind === "star" || operation.kind === "unstar") {
      const after = safeJsonObject(operation.after);
      return (
        after !== null &&
        typeof after.starred === "boolean" &&
        actual.starred === after.starred
      );
    }

    if (operation.kind === "list_create") {
      const id = createdListId(context, operation.operationId);
      const expected = metadataState(operation.after);
      const current = metadataState(state);
      return (
        id !== undefined &&
        actual.listId === id &&
        expected !== null &&
        current !== null &&
        sameJson(expected, current)
      );
    }

    if (operation.kind === "list_update") {
      const expected = metadataState(operation.after);
      const current = metadataState(state);
      return (
        actual.listId === operation.listId &&
        expected !== null &&
        current !== null &&
        sameJson(expected, current)
      );
    }

    if (operation.kind === "list_delete") {
      return actual.exists === false;
    }

    if (operation.kind === "list_membership_set") {
      const currentIds = listIdsState(state);
      if (currentIds === null) return false;
      try {
        return sameJson(currentIds, targetListIds(operation, context));
      } catch {
        return false;
      }
    }
    return false;
  }

  async prepare(
    operationInput: ResolvedOperation,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<PrepareMutationResult> {
    if (!validContext(context)) {
      throw validationError("invalid_execution_context");
    }
    throwIfAborted(signal);
    const operation = operationSnapshot(operationInput);
    const state = await this.readCurrentState(operation, context, signal);
    throwIfAborted(signal);

    if (this.matchesAfter(operation, state, context)) {
      return Object.freeze({
        kind: "skipped",
        outcome: skippedOutcome(state),
      });
    }
    if (!this.matchesBefore(operation, state, context)) {
      throw preconditionFailed(operation, "live_state_changed");
    }

    const prepared = Object.freeze({
      operation,
      before: state,
      mutation: preparedMutation(operation, context),
    });
    this.#prepared.set(prepared, { context, used: false });
    return Object.freeze({ kind: "dispatch", prepared });
  }

  dispatchPrepared(
    prepared: PreparedMutation,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const registration = this.#prepared.get(prepared);
    if (
      registration === undefined ||
      registration.context !== context ||
      registration.used
    ) {
      return Promise.reject(validationError("invalid_prepared_mutation"));
    }
    registration.used = true;
    if (signalIsAborted(signal)) return Promise.reject(cancelled());

    let dispatched: Promise<DispatchCompletion>;
    try {
      dispatched = this.#invokeMutation(prepared, signal);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new AppError(
              "INTERNAL_ERROR",
              "Mutation dispatch failed unexpectedly",
              {
                retryable: false,
                details: { reason: "unexpected_dispatch_failure" },
                cause: error,
              },
            ),
      );
    }
    return dispatched.then((completion) =>
      this.#verifyAfterState(prepared, context, completion, signal),
    );
  }

  #invokeMutation(
    prepared: PreparedMutation,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCompletion> {
    const { operation, mutation } = prepared;
    if (mutation.kind === "star") {
      return this.#mutations
        .star(mutation.coordinates, operation.operationId, signal)
        .then((receipt) => Object.freeze({ receipt, createdListId: null }));
    }
    if (mutation.kind === "unstar") {
      return this.#mutations
        .unstar(mutation.coordinates, operation.operationId, signal)
        .then((receipt) => Object.freeze({ receipt, createdListId: null }));
    }
    if (mutation.kind === "createUserList") {
      return this.#mutations
        .createUserList(mutation.input, operation.operationId, signal)
        .then((result: UserListMutationResult) =>
          Object.freeze({
            receipt: result.receipt,
            createdListId: result.list.listId,
          }),
        );
    }
    if (mutation.kind === "updateUserList") {
      return this.#mutations
        .updateUserList(
          mutation.listId,
          mutation.input,
          operation.operationId,
          signal,
        )
        .then((result: UserListMutationResult) =>
          Object.freeze({
            receipt: result.receipt,
            createdListId: null,
          }),
        );
    }
    if (mutation.kind === "deleteUserList") {
      return this.#mutations
        .deleteUserList(mutation.listId, operation.operationId, signal)
        .then((receipt) => Object.freeze({ receipt, createdListId: null }));
    }
    if (mutation.kind === "setRepositoryListIds") {
      return this.#mutations
        .setRepositoryListIds(
          mutation.repositoryId,
          mutation.listIds,
          operation.operationId,
          signal,
        )
        .then((receipt) => Object.freeze({ receipt, createdListId: null }));
    }
    return Promise.reject(validationError("unsupported_prepared_mutation"));
  }

  async #readCreatedListState(
    id: UserListId,
    signal: AbortSignal | undefined,
  ): Promise<JsonValue> {
    throwIfAborted(signal);
    const list = await this.#reads.getUserList(id, signal);
    throwIfAborted(signal);
    return list === null
      ? frozenJson({ exists: false, listId: id })
      : completeListState(list);
  }

  async #verifyAfterState(
    prepared: PreparedMutation,
    context: ExecutionContext,
    completion: DispatchCompletion,
    signal: AbortSignal | undefined,
  ): Promise<ExecutionOutcome> {
    const { operation, mutation } = prepared;
    try {
      if (
        operation.kind === "list_create" &&
        completion.createdListId !== null
      ) {
        const state = await this.#readCreatedListState(
          completion.createdListId,
          signal,
        );
        const expected = metadataState(operation.after);
        const current = metadataState(state);
        const record = safeJsonObject(state);
        if (
          record === null ||
          record.listId !== completion.createdListId ||
          expected === null ||
          current === null ||
          !sameJson(expected, current)
        ) {
          throw reconciliationRequired(operation, mutation.kind);
        }
        context.createdListIdsByOperationId.set(
          operation.operationId,
          completion.createdListId,
        );
        return succeededOutcome(prepared.before, state, completion.receipt);
      }

      const state = await this.readCurrentState(operation, context, signal);
      if (!this.matchesAfter(operation, state, context)) {
        throw reconciliationRequired(operation, mutation.kind);
      }
      return succeededOutcome(prepared.before, state, completion.receipt);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === "RECONCILIATION_REQUIRED"
      ) {
        throw error;
      }
      throw reconciliationRequired(operation, mutation.kind, error);
    }
  }
}
