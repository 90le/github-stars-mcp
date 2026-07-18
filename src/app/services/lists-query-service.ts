import {
  parseListMembershipQuery,
  parseListMembershipQueryPage,
  parseListQuery,
  parseListQueryPage,
  type ListMembershipQueryPage,
  type ListQueryPage,
} from "../../domain/filter.js";
import { canonicalJsonClone } from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import {
  asRepositoryId,
  asSnapshotId,
  asUserListId,
  type RepositoryId,
  type SnapshotId,
  type UserListId,
} from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import type { AccountBinding } from "../../domain/repository.js";
import {
  copyQueryBinding,
  listCoverageUnavailable,
  resolveQuerySnapshot,
  type QueryStoragePort,
} from "./query-service.js";

export type ListsQueryInput =
  | Readonly<{
      mode: "lists";
      snapshotId: SnapshotId | null;
      limit: number;
      cursor: string | null;
    }>
  | Readonly<{
      mode: "memberships";
      snapshotId: SnapshotId | null;
      listId: UserListId;
      limit: number;
      cursor: string | null;
    }>
  | Readonly<{
      mode: "memberships";
      snapshotId: SnapshotId | null;
      repositoryId: RepositoryId;
      limit: number;
      cursor: string | null;
    }>;

export type ListsQueryResult =
  | Readonly<ListQueryPage & { snapshotId: SnapshotId }>
  | Readonly<ListMembershipQueryPage & { snapshotId: SnapshotId }>;

const LIST_KEYS = new Set(["mode", "snapshotId", "limit", "cursor"]);
const LIST_MEMBERSHIP_KEYS = new Set([
  "mode",
  "snapshotId",
  "listId",
  "limit",
  "cursor",
]);
const REPOSITORY_MEMBERSHIP_KEYS = new Set([
  "mode",
  "snapshotId",
  "repositoryId",
  "limit",
  "cursor",
]);
const VALIDATION_SNAPSHOT_ID = asSnapshotId("snap_list_query_validation");

type JsonObject = Readonly<Record<string, JsonValue>>;

function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function validation(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function plainObject(input: unknown): JsonObject {
  const cloned = canonicalJsonClone(input);
  if (cloned === null || typeof cloned !== "object" || isJsonArray(cloned)) {
    return validation("Lists query must be a plain data object");
  }
  return cloned;
}

function hasExactKeys(
  root: JsonObject,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(root);
  return (
    keys.length === expected.size && keys.every((key) => expected.has(key))
  );
}

function snapshotId(value: JsonValue | undefined): SnapshotId | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    return validation("snapshotId must be null or a stable ID");
  }
  try {
    return asSnapshotId(value);
  } catch {
    return validation("snapshotId must be null or a stable ID");
  }
}

type ParsedListQuery =
  | Readonly<{
      mode: "lists";
      snapshotId: SnapshotId | null;
      limit: number;
      cursor: string | null;
    }>
  | Readonly<{
      mode: "memberships";
      snapshotId: SnapshotId | null;
      selector:
        | { readonly kind: "list"; readonly listId: UserListId }
        | {
            readonly kind: "repository";
            readonly repositoryId: RepositoryId;
          };
      limit: number;
      cursor: string | null;
    }>;

function parseListsInput(input: unknown): ParsedListQuery {
  const root = plainObject(input);
  const selectedSnapshotId = snapshotId(root.snapshotId);
  if (root.mode === "lists") {
    if (!hasExactKeys(root, LIST_KEYS)) {
      return validation("List query contains unsupported properties");
    }
    const query = parseListQuery({
      snapshotId: selectedSnapshotId ?? VALIDATION_SNAPSHOT_ID,
      pageSize: root.limit,
      cursor: root.cursor,
    });
    return Object.freeze({
      mode: "lists",
      snapshotId: selectedSnapshotId,
      limit: query.pageSize,
      cursor: query.cursor,
    });
  }

  if (root.mode !== "memberships") {
    return validation("List query mode is invalid");
  }
  if (hasExactKeys(root, LIST_MEMBERSHIP_KEYS)) {
    if (typeof root.listId !== "string") {
      return validation("listId must be a stable ID");
    }
    let listId: UserListId;
    try {
      listId = asUserListId(root.listId);
    } catch {
      return validation("listId must be a stable ID");
    }
    const query = parseListMembershipQuery({
      snapshotId: selectedSnapshotId ?? VALIDATION_SNAPSHOT_ID,
      selector: { kind: "list", listId },
      pageSize: root.limit,
      cursor: root.cursor,
    });
    return Object.freeze({
      mode: "memberships",
      snapshotId: selectedSnapshotId,
      selector: query.selector,
      limit: query.pageSize,
      cursor: query.cursor,
    });
  }
  if (hasExactKeys(root, REPOSITORY_MEMBERSHIP_KEYS)) {
    if (typeof root.repositoryId !== "string") {
      return validation("repositoryId must be a stable ID");
    }
    let repositoryId: RepositoryId;
    try {
      repositoryId = asRepositoryId(root.repositoryId);
    } catch {
      return validation("repositoryId must be a stable ID");
    }
    const query = parseListMembershipQuery({
      snapshotId: selectedSnapshotId ?? VALIDATION_SNAPSHOT_ID,
      selector: { kind: "repository", repositoryId },
      pageSize: root.limit,
      cursor: root.cursor,
    });
    return Object.freeze({
      mode: "memberships",
      snapshotId: selectedSnapshotId,
      selector: query.selector,
      limit: query.pageSize,
      cursor: query.cursor,
    });
  }
  return validation(
    "Membership query requires exactly one List or repository selector",
  );
}

function sameSelector(
  left: ParsedListQuery & { readonly mode: "memberships" },
  right: ListMembershipQueryPage["selector"],
): boolean {
  return left.selector.kind === "list" && right.kind === "list"
    ? left.selector.listId === right.listId
    : left.selector.kind === "repository" && right.kind === "repository"
      ? left.selector.repositoryId === right.repositoryId
      : false;
}

export class ListsQueryService {
  readonly #storage: QueryStoragePort;
  readonly #binding: AccountBinding;

  constructor(storage: QueryStoragePort, binding: AccountBinding) {
    this.#storage = storage;
    this.#binding = copyQueryBinding(binding);
  }

  async query(input: ListsQueryInput): Promise<ListsQueryResult> {
    const parsed = parseListsInput(input);
    const snapshot = resolveQuerySnapshot(
      this.#storage,
      this.#binding,
      parsed.snapshotId,
    );
    if (snapshot.listCoverage !== "complete") {
      return listCoverageUnavailable();
    }

    if (parsed.mode === "lists") {
      const page = parseListQueryPage(
        this.#storage.queryLists({
          snapshotId: snapshot.id,
          pageSize: parsed.limit,
          cursor: parsed.cursor,
        }),
      );
      return await Promise.resolve(
        Object.freeze({ snapshotId: snapshot.id, ...page }),
      );
    }

    const page = parseListMembershipQueryPage(
      this.#storage.queryListMemberships({
        snapshotId: snapshot.id,
        selector: parsed.selector,
        pageSize: parsed.limit,
        cursor: parsed.cursor,
      }),
    );
    if (!sameSelector(parsed, page.selector)) {
      return validation("Membership page selector does not match the query");
    }
    return await Promise.resolve(
      Object.freeze({ snapshotId: snapshot.id, ...page }),
    );
  }
}
