import type { StoragePort } from "../ports/storage-port.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import type { ListSummary } from "../../domain/filter.js";
import type { RepositoryId, UserListId } from "../../domain/ids.js";
import type {
  OperationDependency,
  PlanAction,
  RequestedListTarget,
  ResolvedListTarget,
  ResolvedOperation,
} from "../../domain/plan.js";
import type {
  Repository,
  RepositoryView,
  UserList,
} from "../../domain/repository.js";
import type { Snapshot } from "../../domain/snapshot.js";

const PAGE_SIZE = 100;

export interface ResolveOperationRequestsInput {
  readonly storage: StoragePort;
  readonly snapshot: Snapshot;
  readonly actions: readonly PlanAction[];
  readonly protectedRepositoryIds: readonly RepositoryId[];
  readonly protectedListIds: readonly UserListId[];
  readonly nextOperationId: () => string;
}

export interface ResolveOperationRequestsResult {
  readonly operations: readonly ResolvedOperation[];
  readonly dependencies: readonly OperationDependency[];
  readonly warnings: readonly string[];
}

type MutableListMetadata = Readonly<{
  name: string;
  description: string | null;
  isPrivate: boolean;
}>;

type RepositoryState = Readonly<{
  repository: Repository;
  starredAt: string | null;
}>;

type RequestedTargetKey = `existing:${string}` | `created:${string}`;

type StarDraftBase = {
  key: string;
  state: RepositoryState;
  currentListIds: readonly UserListId[];
};

type StarDraft =
  | Readonly<StarDraftBase & { kind: "star" }>
  | Readonly<StarDraftBase & { kind: "unstar" }>;

type CreateDraft = Readonly<{
  key: string;
  kind: "list_create";
  clientRef: string;
  beforeListIds: readonly UserListId[];
  after: MutableListMetadata;
}>;

type UpdateDraft = Readonly<{
  key: string;
  kind: "list_update";
  list: UserList;
  before: MutableListMetadata;
  after: MutableListMetadata;
}>;

type DeleteDraft = Readonly<{
  key: string;
  kind: "list_delete";
  list: UserList;
  repositoryIds: readonly RepositoryId[];
}>;

type MembershipDraft = Readonly<{
  key: string;
  kind: "list_membership_set";
  state: RepositoryState;
  expectedListIds: readonly UserListId[];
  requestedTargets: readonly RequestedListTarget[];
}>;

type Draft =
  | StarDraft
  | CreateDraft
  | UpdateDraft
  | DeleteDraft
  | MembershipDraft;

type UpdateAccumulator = {
  readonly list: UserList;
  name?: string;
  description?: string | null;
  isPrivate?: boolean;
};

type MembershipAccumulator = {
  readonly state: RepositoryState;
  readonly expectedListIds: readonly UserListId[];
  setTargets: Map<RequestedTargetKey, RequestedListTarget> | null;
  readonly additions: Map<RequestedTargetKey, RequestedListTarget>;
  readonly removals: Set<UserListId>;
  readonly mentionedExisting: Set<UserListId>;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function invalid(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function notFound(message: string): never {
  throw new AppError("NOT_FOUND", message, { retryable: false });
}

function storageFailure(message: string): never {
  throw new AppError("STORAGE_ERROR", message, { retryable: false });
}

function advanceCursor(
  seen: Set<string>,
  current: string | null,
  next: string | null,
  label: string,
): string | null {
  if (next === null) return null;
  if (next === current || seen.has(next)) {
    storageFailure(`${label} cursor did not advance`);
  }
  seen.add(next);
  return next;
}

function mutableListMetadata(list: UserList): MutableListMetadata {
  return Object.freeze({
    name: list.name,
    description: list.description,
    isPrivate: list.isPrivate,
  });
}

function completeListMetadata(list: UserList) {
  return Object.freeze({
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

function requestedTargetKey(target: RequestedListTarget): RequestedTargetKey {
  return target.kind === "existing"
    ? `existing:${target.listId}`
    : `created:${target.clientRef}`;
}

function compareRequestedTargets(
  left: RequestedListTarget,
  right: RequestedListTarget,
): number {
  if (left.kind !== right.kind) return left.kind === "existing" ? -1 : 1;
  return compareText(
    left.kind === "existing" ? left.listId : left.clientRef,
    right.kind === "existing" ? right.listId : right.clientRef,
  );
}

function allRepositoriesForFilter(
  storage: StoragePort,
  snapshot: Snapshot,
  filter: Extract<
    PlanAction,
    { readonly kind: "star" | "unstar" }
  >["repositories"] & { readonly kind: "filter" },
): readonly RepositoryState[] {
  const items: RepositoryView[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = storage.queryRepositories({
      snapshotId: snapshot.id,
      filter: filter.filter,
      sort: [{ field: "full_name", direction: "asc" }],
      pageSize: PAGE_SIZE,
      cursor,
    });
    items.push(...page.items);
    cursor = advanceCursor(
      seenCursors,
      cursor,
      page.nextCursor,
      "repository query",
    );
  } while (cursor !== null);

  const unique = new Map<RepositoryId, RepositoryView>();
  for (const item of items) {
    const current = unique.get(item.repositoryId);
    if (
      current !== undefined &&
      canonicalJson(current) !== canonicalJson(item)
    ) {
      storageFailure("repository query returned conflicting stable IDs");
    }
    unique.set(item.repositoryId, item);
  }
  return Object.freeze(
    [...unique.values()]
      .sort((left, right) => compareText(left.repositoryId, right.repositoryId))
      .map((repository) =>
        Object.freeze({
          repository,
          starredAt: repository.starredAt,
        }),
      ),
  );
}

function repositoriesForSelector(
  storage: StoragePort,
  snapshot: Snapshot,
  selector: Extract<
    PlanAction,
    { readonly kind: "star" | "unstar" }
  >["repositories"],
): readonly RepositoryState[] {
  if (selector.kind === "filter") {
    return allRepositoriesForFilter(storage, snapshot, selector);
  }
  const result: RepositoryState[] = [];
  for (const repositoryId of sortedUnique(selector.repositoryIds)) {
    const view = storage.getSnapshotRepository(snapshot.id, repositoryId);
    if (view !== null) {
      result.push(
        Object.freeze({ repository: view, starredAt: view.starredAt }),
      );
      continue;
    }
    const observed = storage.getRepositoryMetadata(repositoryId);
    if (observed === null) {
      notFound(`Repository ${repositoryId} is not present in storage`);
    }
    result.push(
      Object.freeze({
        repository: observed.repository,
        starredAt: null,
      }),
    );
  }
  return Object.freeze(result);
}

function allLists(
  storage: StoragePort,
  snapshot: Snapshot,
): ReadonlyMap<UserListId, ListSummary> {
  const result = new Map<UserListId, ListSummary>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = storage.queryLists({
      snapshotId: snapshot.id,
      pageSize: PAGE_SIZE,
      cursor,
    });
    for (const list of page.items) {
      const current = result.get(list.listId);
      if (
        current !== undefined &&
        canonicalJson(current) !== canonicalJson(list)
      ) {
        storageFailure("List query returned conflicting stable IDs");
      }
      result.set(list.listId, list);
    }
    cursor = advanceCursor(seenCursors, cursor, page.nextCursor, "List query");
  } while (cursor !== null);
  return result;
}

function repositoryMemberships(
  storage: StoragePort,
  snapshot: Snapshot,
  repositoryId: RepositoryId,
): readonly UserListId[] {
  const result: UserListId[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = storage.queryListMemberships({
      snapshotId: snapshot.id,
      selector: { kind: "repository", repositoryId },
      pageSize: PAGE_SIZE,
      cursor,
    });
    if (
      page.selector.kind !== "repository" ||
      !("listIds" in page) ||
      page.selector.repositoryId !== repositoryId
    ) {
      storageFailure("membership query returned the wrong selector");
    }
    result.push(...page.listIds);
    cursor = advanceCursor(
      seenCursors,
      cursor,
      page.nextCursor,
      "membership query",
    );
  } while (cursor !== null);
  return sortedUnique(result);
}

function listMembers(
  storage: StoragePort,
  snapshot: Snapshot,
  listId: UserListId,
): readonly RepositoryId[] {
  const result: RepositoryId[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = storage.queryListMemberships({
      snapshotId: snapshot.id,
      selector: { kind: "list", listId },
      pageSize: PAGE_SIZE,
      cursor,
    });
    if (
      page.selector.kind !== "list" ||
      !("repositoryIds" in page) ||
      page.selector.listId !== listId
    ) {
      storageFailure("membership query returned the wrong selector");
    }
    result.push(...page.repositoryIds);
    cursor = advanceCursor(
      seenCursors,
      cursor,
      page.nextCursor,
      "membership query",
    );
  } while (cursor !== null);
  return sortedUnique(result);
}

function requireList(
  lists: ReadonlyMap<UserListId, ListSummary>,
  listId: UserListId,
): ListSummary {
  const list = lists.get(listId);
  if (list === undefined) {
    return notFound(`List ${listId} is not present in the snapshot`);
  }
  return list;
}

function validateRequestedTarget(
  target: RequestedListTarget,
  lists: ReadonlyMap<UserListId, ListSummary>,
): void {
  if (target.kind === "existing") requireList(lists, target.listId);
}

function mergeUpdateField<K extends "name" | "description" | "isPrivate">(
  update: UpdateAccumulator,
  field: K,
  value: UpdateAccumulator[K],
): void {
  if (Object.hasOwn(update, field) && update[field] !== value) {
    invalid(`List ${update.list.listId} has conflicting ${field} updates`);
  }
  Object.assign(update, { [field]: value });
}

function updateAfter(update: UpdateAccumulator): MutableListMetadata {
  return Object.freeze({
    name: update.name ?? update.list.name,
    description: Object.hasOwn(update, "description")
      ? (update.description ?? null)
      : update.list.description,
    isPrivate: update.isPrivate ?? update.list.isPrivate,
  });
}

function sameMutableMetadata(
  left: MutableListMetadata,
  right: MutableListMetadata,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function createMembershipAccumulator(
  state: RepositoryState,
  expectedListIds: readonly UserListId[],
): MembershipAccumulator {
  return {
    state,
    expectedListIds,
    setTargets: null,
    additions: new Map(),
    removals: new Set(),
    mentionedExisting: new Set(),
  };
}

function targetMap(
  targets: readonly RequestedListTarget[],
): Map<RequestedTargetKey, RequestedListTarget> {
  return new Map(
    targets.map((target) => [requestedTargetKey(target), target] as const),
  );
}

function sameTargetMaps(
  left: ReadonlyMap<RequestedTargetKey, RequestedListTarget>,
  right: ReadonlyMap<RequestedTargetKey, RequestedListTarget>,
): boolean {
  return (
    canonicalJson([...left.values()].sort(compareRequestedTargets)) ===
    canonicalJson([...right.values()].sort(compareRequestedTargets))
  );
}

function normalizeMembershipTargets(
  accumulator: MembershipAccumulator,
  protectedLists: ReadonlySet<UserListId>,
): readonly RequestedListTarget[] {
  for (const listId of accumulator.removals) {
    if (accumulator.additions.has(`existing:${listId}`)) {
      invalid(
        `Repository ${accumulator.state.repository.repositoryId} has conflicting membership deltas for List ${listId}`,
      );
    }
  }
  const targets =
    accumulator.setTargets === null
      ? targetMap(
          accumulator.expectedListIds.map((listId) =>
            Object.freeze({ kind: "existing" as const, listId }),
          ),
        )
      : new Map(accumulator.setTargets);
  for (const [key, target] of accumulator.additions) {
    targets.set(key, target);
  }
  for (const listId of accumulator.removals) {
    targets.delete(`existing:${listId}`);
  }
  for (const listId of accumulator.expectedListIds) {
    if (protectedLists.has(listId)) {
      targets.set(
        `existing:${listId}`,
        Object.freeze({ kind: "existing", listId }),
      );
    }
  }
  return Object.freeze([...targets.values()].sort(compareRequestedTargets));
}

function draftRank(draft: Draft): number {
  switch (draft.kind) {
    case "star":
      return 0;
    case "unstar":
      return 1;
    case "list_create":
      return 2;
    case "list_update":
      return 3;
    case "list_delete":
      return 4;
    case "list_membership_set":
      return 5;
  }
}

function compareDrafts(left: Draft, right: Draft): number {
  const byKind = draftRank(left) - draftRank(right);
  return byKind === 0 ? compareText(left.key, right.key) : byKind;
}

function repositoryFields(state: RepositoryState) {
  return {
    repositoryId: state.repository.repositoryId,
    repositoryDatabaseId: state.repository.repositoryDatabaseId,
    coordinates: Object.freeze({
      owner: state.repository.owner,
      name: state.repository.name,
    }),
  } as const;
}

function operationFromDraft(
  draft: Draft,
  operationId: string,
  operationIdByCreateRef: ReadonlyMap<string, string>,
  operationIdByStarredRepository: ReadonlyMap<RepositoryId, string>,
): ResolvedOperation {
  if (draft.kind === "star") {
    return Object.freeze({
      operationId,
      kind: "star",
      ...repositoryFields(draft.state),
      dependsOn: Object.freeze([]),
      preconditions: Object.freeze([
        Object.freeze({ kind: "star_state", expected: false }),
      ]),
      before: Object.freeze({ starred: false }),
      after: Object.freeze({ starred: true }),
      inverse: Object.freeze({ kind: "unstar" }),
      risk: "normal",
    });
  }
  if (draft.kind === "unstar") {
    return Object.freeze({
      operationId,
      kind: "unstar",
      ...repositoryFields(draft.state),
      dependsOn: Object.freeze([]),
      preconditions: Object.freeze([
        Object.freeze({ kind: "star_state", expected: true }),
      ]),
      before: Object.freeze({
        starred: true,
        starredAt: draft.state.starredAt,
        listIds: draft.currentListIds,
      }),
      after: Object.freeze({ starred: false }),
      inverse: Object.freeze({
        kind: "star",
        listIds: draft.currentListIds,
      }),
      risk: "non_reversible",
    });
  }
  if (draft.kind === "list_create") {
    return Object.freeze({
      operationId,
      kind: "list_create",
      clientRef: draft.clientRef,
      dependsOn: Object.freeze([]),
      preconditions: Object.freeze([
        Object.freeze({
          kind: "list_id_baseline",
          expected: Object.freeze({ listIds: draft.beforeListIds }),
        }),
      ]),
      before: Object.freeze({ listIds: draft.beforeListIds }),
      after: draft.after,
      inverse: Object.freeze({ kind: "list_delete" }),
      risk: "normal",
    });
  }
  if (draft.kind === "list_update") {
    return Object.freeze({
      operationId,
      kind: "list_update",
      listId: draft.list.listId,
      dependsOn: Object.freeze([]),
      preconditions: Object.freeze([
        Object.freeze({ kind: "list_metadata", expected: draft.before }),
      ]),
      before: draft.before,
      after: draft.after,
      inverse: Object.freeze({
        kind: "list_update",
        ...draft.before,
      }),
      risk: "normal",
    });
  }
  if (draft.kind === "list_delete") {
    const list = completeListMetadata(draft.list);
    const before = Object.freeze({
      list,
      repositoryIds: draft.repositoryIds,
    });
    return Object.freeze({
      operationId,
      kind: "list_delete",
      listId: draft.list.listId,
      dependsOn: Object.freeze([]),
      preconditions: Object.freeze([
        Object.freeze({
          kind: "list_metadata",
          expected: Object.freeze({ ...list }),
        }),
      ]),
      before,
      after: Object.freeze({ exists: false }),
      inverse: Object.freeze({
        kind: "list_create",
        list,
        repositoryIds: draft.repositoryIds,
      }),
      risk: "destructive",
    });
  }

  const targetLists: ResolvedListTarget[] = draft.requestedTargets.map(
    (target) => {
      if (target.kind === "existing") {
        return Object.freeze({ kind: "existing", listId: target.listId });
      }
      const createOperationId = operationIdByCreateRef.get(target.clientRef);
      if (createOperationId === undefined) {
        return invalid(
          `Created List reference ${target.clientRef} has no matching create action`,
        );
      }
      return Object.freeze({ kind: "created", createOperationId });
    },
  );
  targetLists.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "existing" ? -1 : 1;
    return compareText(
      left.kind === "existing" ? left.listId : left.createOperationId,
      right.kind === "existing" ? right.listId : right.createOperationId,
    );
  });
  const dependencies = new Set<string>();
  for (const target of targetLists) {
    if (target.kind === "created") {
      dependencies.add(target.createOperationId);
    }
  }
  if (draft.state.starredAt === null) {
    const starOperationId = operationIdByStarredRepository.get(
      draft.state.repository.repositoryId,
    );
    if (starOperationId !== undefined) dependencies.add(starOperationId);
  }
  const dependsOn = sortedUnique([...dependencies]);
  return Object.freeze({
    operationId,
    kind: "list_membership_set",
    ...repositoryFields(draft.state),
    expectedListIds: draft.expectedListIds,
    targetLists: Object.freeze(targetLists),
    dependsOn,
    preconditions: Object.freeze([
      Object.freeze({
        kind: "list_memberships",
        expected: Object.freeze({ listIds: draft.expectedListIds }),
      }),
    ]),
    before: Object.freeze({ listIds: draft.expectedListIds }),
    after: Object.freeze({
      listIds: Object.freeze(
        targetLists.map((target) =>
          target.kind === "existing"
            ? target.listId
            : Object.freeze({
                createOperationId: target.createOperationId,
              }),
        ),
      ),
    }),
    inverse: Object.freeze({
      kind: "list_membership_set",
      listIds: draft.expectedListIds,
    }),
    risk: "normal",
  });
}

function planWarnings(
  drafts: readonly Draft[],
  protectedTargetCount: number,
): readonly string[] {
  const warnings: string[] = [];
  if (protectedTargetCount > 0) {
    warnings.push(
      `${String(protectedTargetCount)} protected target changes were skipped`,
    );
  }
  const privateRepositories = new Set<RepositoryId>();
  let destructiveLists = 0;
  let nonReversible = 0;
  for (const draft of drafts) {
    if (
      (draft.kind === "star" ||
        draft.kind === "unstar" ||
        draft.kind === "list_membership_set") &&
      draft.state.repository.isPrivate
    ) {
      privateRepositories.add(draft.state.repository.repositoryId);
    }
    if (draft.kind === "list_delete") destructiveLists += 1;
    if (draft.kind === "unstar") nonReversible += 1;
  }
  if (privateRepositories.size > 0) {
    warnings.push(
      `${String(privateRepositories.size)} private repositories are affected`,
    );
  }
  if (destructiveLists > 0) {
    warnings.push(
      `${String(destructiveLists)} destructive List deletions are planned`,
    );
  }
  if (nonReversible > 0) {
    warnings.push(
      `${String(nonReversible)} unstar operations cannot restore original Star timestamps`,
    );
  }
  return Object.freeze(warnings);
}

export function resolveOperationRequests(
  input: ResolveOperationRequestsInput,
): ResolveOperationRequestsResult {
  const protectedRepositories = new Set(input.protectedRepositoryIds);
  const protectedLists = new Set(input.protectedListIds);
  const uniqueActions = [
    ...new Map(
      input.actions.map((action) => [canonicalJson(action), action] as const),
    ).values(),
  ];
  const starIntents = new Map<
    RepositoryId,
    Readonly<{ target: boolean; state: RepositoryState }>
  >();
  const creates = new Map<string, PlanAction & { kind: "list_create" }>();
  const updates = new Map<UserListId, UpdateAccumulator>();
  const deletes = new Set<UserListId>();
  const memberships = new Map<RepositoryId, MembershipAccumulator>();
  const membershipCache = new Map<RepositoryId, readonly UserListId[]>();
  let lists: ReadonlyMap<UserListId, ListSummary> | null = null;
  let protectedTargetCount = 0;

  const getLists = (): ReadonlyMap<UserListId, ListSummary> => {
    lists ??= allLists(input.storage, input.snapshot);
    return lists;
  };
  const getMemberships = (
    repositoryId: RepositoryId,
  ): readonly UserListId[] => {
    const current = membershipCache.get(repositoryId);
    if (current !== undefined) return current;
    const resolved = repositoryMemberships(
      input.storage,
      input.snapshot,
      repositoryId,
    );
    membershipCache.set(repositoryId, resolved);
    return resolved;
  };
  for (const repositoryId of sortedUnique(input.protectedRepositoryIds)) {
    if (
      input.storage.getSnapshotRepository(input.snapshot.id, repositoryId) ===
        null &&
      input.storage.getRepositoryMetadata(repositoryId) === null
    ) {
      notFound(
        `Protected repository ${repositoryId} is not present in storage`,
      );
    }
  }
  if (protectedLists.size > 0) {
    const knownLists = getLists();
    for (const listId of [...protectedLists].sort(compareText)) {
      requireList(knownLists, listId);
    }
  }

  for (const action of uniqueActions) {
    if (action.kind === "star" || action.kind === "unstar") {
      const target = action.kind === "star";
      for (const state of repositoriesForSelector(
        input.storage,
        input.snapshot,
        action.repositories,
      )) {
        const repositoryId = state.repository.repositoryId;
        if (protectedRepositories.has(repositoryId)) {
          protectedTargetCount += 1;
          continue;
        }
        const existing = starIntents.get(repositoryId);
        if (existing !== undefined && existing.target !== target) {
          invalid(`Repository ${repositoryId} has conflicting Star changes`);
        }
        starIntents.set(repositoryId, Object.freeze({ target, state }));
      }
      continue;
    }

    if (action.kind === "list_create") {
      getLists();
      const existing = creates.get(action.clientRef);
      if (
        existing !== undefined &&
        canonicalJson(existing) !== canonicalJson(action)
      ) {
        invalid(
          `List create reference ${action.clientRef} is defined more than once`,
        );
      }
      creates.set(action.clientRef, action);
      continue;
    }

    if (action.kind === "list_update") {
      const knownLists = getLists();
      for (const listId of sortedUnique(action.listIds)) {
        if (protectedLists.has(listId)) {
          protectedTargetCount += 1;
          continue;
        }
        const list = requireList(knownLists, listId);
        const update = updates.get(listId) ?? { list };
        if (Object.hasOwn(action, "name")) {
          mergeUpdateField(update, "name", action.name);
        }
        if (Object.hasOwn(action, "description")) {
          mergeUpdateField(update, "description", action.description);
        }
        if (Object.hasOwn(action, "isPrivate")) {
          mergeUpdateField(update, "isPrivate", action.isPrivate);
        }
        updates.set(listId, update);
      }
      continue;
    }

    if (action.kind === "list_delete") {
      const knownLists = getLists();
      for (const listId of sortedUnique(action.listIds)) {
        if (protectedLists.has(listId)) {
          protectedTargetCount += 1;
          continue;
        }
        requireList(knownLists, listId);
        deletes.add(listId);
      }
      continue;
    }

    if (!("lists" in action) || !("repositories" in action)) {
      invalid("Plan action is unsupported");
    }
    const knownLists = getLists();
    const normalizedTargets: RequestedListTarget[] = [];
    for (const target of action.lists) {
      validateRequestedTarget(target, knownLists);
      if (target.kind === "existing" && protectedLists.has(target.listId)) {
        protectedTargetCount += 1;
        continue;
      }
      normalizedTargets.push(target);
    }
    for (const state of repositoriesForSelector(
      input.storage,
      input.snapshot,
      action.repositories,
    )) {
      const repositoryId = state.repository.repositoryId;
      if (protectedRepositories.has(repositoryId)) {
        protectedTargetCount += 1;
        continue;
      }
      const accumulator =
        memberships.get(repositoryId) ??
        createMembershipAccumulator(state, getMemberships(repositoryId));
      for (const target of normalizedTargets) {
        if (target.kind === "existing") {
          accumulator.mentionedExisting.add(target.listId);
        }
      }
      if (action.kind === "list_membership_set") {
        const next = targetMap(normalizedTargets);
        if (
          accumulator.setTargets !== null &&
          !sameTargetMaps(accumulator.setTargets, next)
        ) {
          invalid(`Repository ${repositoryId} has conflicting membership sets`);
        }
        accumulator.setTargets = next;
      } else if (action.kind === "list_membership_add") {
        for (const target of normalizedTargets) {
          accumulator.additions.set(requestedTargetKey(target), target);
        }
      } else {
        for (const target of normalizedTargets) {
          if (target.kind !== "existing") {
            invalid("membership removal requires existing List targets");
          }
          accumulator.removals.add(target.listId);
        }
      }
      memberships.set(repositoryId, accumulator);
    }
  }

  for (const listId of deletes) {
    if (updates.has(listId)) {
      invalid(`List ${listId} cannot be updated and deleted in one plan`);
    }
    for (const membership of memberships.values()) {
      if (
        membership.mentionedExisting.has(listId) ||
        membership.expectedListIds.includes(listId)
      ) {
        invalid(
          `List ${listId} cannot be deleted and combined with membership changes`,
        );
      }
    }
  }
  for (const action of uniqueActions) {
    if (!("lists" in action) || action.kind === "list_membership_remove") {
      continue;
    }
    for (const target of action.lists) {
      if (target.kind === "created" && !creates.has(target.clientRef)) {
        invalid(
          `Created List reference ${target.clientRef} has no matching create action`,
        );
      }
    }
  }

  const drafts: Draft[] = [];
  for (const [repositoryId, intent] of starIntents) {
    const isStarred = intent.state.starredAt !== null;
    if (isStarred === intent.target) continue;
    drafts.push(
      Object.freeze({
        key: repositoryId,
        kind: intent.target ? "star" : "unstar",
        state: intent.state,
        currentListIds:
          intent.target || input.snapshot.listCoverage !== "complete"
            ? Object.freeze([])
            : getMemberships(repositoryId),
      }),
    );
  }

  const baselineListIds =
    creates.size === 0
      ? Object.freeze([] as UserListId[])
      : sortedUnique([...getLists().keys()]);
  for (const create of creates.values()) {
    drafts.push(
      Object.freeze({
        key: create.clientRef,
        kind: "list_create",
        clientRef: create.clientRef,
        beforeListIds: baselineListIds,
        after: Object.freeze({
          name: create.name,
          description: create.description,
          isPrivate: create.isPrivate,
        }),
      }),
    );
  }
  for (const [listId, update] of updates) {
    const before = mutableListMetadata(update.list);
    const after = updateAfter(update);
    if (!sameMutableMetadata(before, after)) {
      drafts.push(
        Object.freeze({
          key: listId,
          kind: "list_update",
          list: completeListMetadata(update.list),
          before,
          after,
        }),
      );
    }
  }
  for (const listId of deletes) {
    const list = requireList(getLists(), listId);
    drafts.push(
      Object.freeze({
        key: listId,
        kind: "list_delete",
        list: completeListMetadata(list),
        repositoryIds: listMembers(input.storage, input.snapshot, listId),
      }),
    );
  }
  for (const [repositoryId, membership] of memberships) {
    const requestedTargets = normalizeMembershipTargets(
      membership,
      protectedLists,
    );
    const existingTargets = requestedTargets
      .filter(
        (
          target,
        ): target is Extract<
          RequestedListTarget,
          { readonly kind: "existing" }
        > => target.kind === "existing",
      )
      .map((target) => target.listId);
    const hasCreated = requestedTargets.some(
      (target) => target.kind === "created",
    );
    if (
      !hasCreated &&
      canonicalJson(existingTargets) ===
        canonicalJson(membership.expectedListIds)
    ) {
      continue;
    }
    drafts.push(
      Object.freeze({
        key: repositoryId,
        kind: "list_membership_set",
        state: membership.state,
        expectedListIds: membership.expectedListIds,
        requestedTargets,
      }),
    );
  }

  drafts.sort(compareDrafts);
  const operationIdByKey = new Map<string, string>();
  for (const draft of drafts) {
    operationIdByKey.set(`${draft.kind}:${draft.key}`, input.nextOperationId());
  }
  const operationIdByCreateRef = new Map<string, string>();
  const operationIdByStarredRepository = new Map<RepositoryId, string>();
  for (const draft of drafts) {
    const operationId = operationIdByKey.get(`${draft.kind}:${draft.key}`);
    if (operationId === undefined) {
      storageFailure("operation ID assignment was incomplete");
    }
    if (draft.kind === "list_create") {
      operationIdByCreateRef.set(draft.clientRef, operationId);
    } else if (draft.kind === "star") {
      operationIdByStarredRepository.set(
        draft.state.repository.repositoryId,
        operationId,
      );
    }
  }
  const operations = Object.freeze(
    drafts.map((draft) => {
      const operationId = operationIdByKey.get(`${draft.kind}:${draft.key}`);
      if (operationId === undefined) {
        return storageFailure("operation ID assignment was incomplete");
      }
      return operationFromDraft(
        draft,
        operationId,
        operationIdByCreateRef,
        operationIdByStarredRepository,
      );
    }),
  );
  const dependencies: OperationDependency[] = [];
  for (const operation of operations) {
    for (const dependsOnOperationId of operation.dependsOn) {
      dependencies.push(
        Object.freeze({
          operationId: operation.operationId,
          dependsOnOperationId,
        }),
      );
    }
  }
  dependencies.sort((left, right) => {
    const byOperation = compareText(left.operationId, right.operationId);
    return byOperation === 0
      ? compareText(left.dependsOnOperationId, right.dependsOnOperationId)
      : byOperation;
  });
  return Object.freeze({
    operations,
    dependencies: Object.freeze(dependencies),
    warnings: planWarnings(drafts, protectedTargetCount),
  });
}
