import { canonicalJsonClone, freezeJsonValue } from "./canonical-json.js";
import { AppError } from "./errors.js";
import {
  asRepositoryId,
  asSnapshotId,
  asUserListId,
  type SnapshotId,
} from "./ids.js";
import type { JsonValue } from "./json.js";
import {
  observedRepositoryMetadataSchema,
  starRecordSchema,
  userListSchema,
  type AccountBinding,
  type ListMembership,
  type ObservedRepositoryMetadata,
  type StarRecord,
  type UserList,
} from "./repository.js";
import { canonicalUtcTimestamp } from "./timestamp.js";

export type ListCoverage =
  | "collecting"
  | "complete"
  | "unavailable"
  | "omitted";

export interface SnapshotDraft {
  readonly id: SnapshotId;
  readonly binding: AccountBinding;
  readonly mode: "full" | "incremental";
  readonly listCoverage: Exclude<ListCoverage, "complete">;
  readonly startedAt: string;
}

export interface SnapshotCounts {
  readonly repositories: number;
  readonly stars: number;
  readonly lists: number;
  readonly memberships: number;
}

export interface Snapshot extends Omit<SnapshotDraft, "listCoverage"> {
  readonly listCoverage: ListCoverage;
  readonly status: "building" | "complete" | "failed";
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly counts: SnapshotCounts;
  readonly warningCount: number;
  readonly sourceRateLimit: JsonValue | null;
}

export interface SnapshotBatch {
  readonly repositories: readonly ObservedRepositoryMetadata[];
  readonly stars: readonly StarRecord[];
  readonly lists: readonly UserList[];
  readonly memberships: readonly ListMembership[];
}

export interface SnapshotVerificationBatch {
  readonly stars: readonly StarRecord[];
  readonly lists: readonly UserList[];
  readonly memberships: readonly ListMembership[];
}

type SafeRecord = Record<string, JsonValue>;

function invalid(message: string): never {
  throw new AppError("VALIDATION_ERROR", message);
}

function object(value: JsonValue, label: string): SafeRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as SafeRecord;
}

function exact(
  value: SafeRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} contains unsupported properties`);
  }
}

function boundedText(value: JsonValue, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    return invalid(`${label} must be bounded trim-equal text`);
  }
  return value;
}

function snapshotId(value: string): SnapshotId {
  try {
    return asSnapshotId(value);
  } catch {
    return invalid("snapshot ID is invalid");
  }
}

function repositoryId(value: string) {
  try {
    return asRepositoryId(value);
  } catch {
    return invalid("repository ID is invalid");
  }
}

function listId(value: string) {
  try {
    return asUserListId(value);
  } catch {
    return invalid("List ID is invalid");
  }
}

function parseBinding(value: JsonValue): AccountBinding {
  const input = object(value, "snapshot binding");
  exact(input, ["host", "login", "accountId"], "snapshot binding");
  const host = boundedText(input.host as JsonValue, "binding host", 253);
  if (host !== "github.com") {
    return invalid("binding host must be github.com");
  }
  return Object.freeze({
    host,
    login: boundedText(input.login as JsonValue, "binding login", 100),
    accountId: boundedText(
      input.accountId as JsonValue,
      "binding account ID",
      128,
    ),
  });
}

function nonnegative(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function parseCountsValue(value: JsonValue): SnapshotCounts {
  const input = object(value, "snapshot counts");
  exact(
    input,
    ["repositories", "stars", "lists", "memberships"],
    "snapshot counts",
  );
  return Object.freeze({
    repositories: nonnegative(
      input.repositories as JsonValue,
      "repository count",
    ),
    stars: nonnegative(input.stars as JsonValue, "Star count"),
    lists: nonnegative(input.lists as JsonValue, "List count"),
    memberships: nonnegative(
      input.memberships as JsonValue,
      "membership count",
    ),
  });
}

function parseCoverage(value: JsonValue, allowComplete: boolean): ListCoverage {
  if (
    value !== "collecting" &&
    value !== "complete" &&
    value !== "unavailable" &&
    value !== "omitted"
  ) {
    return invalid("snapshot List coverage is invalid");
  }
  if (!allowComplete && value === "complete") {
    return invalid("snapshot draft List coverage cannot be complete");
  }
  return value;
}

export function parseSnapshotDraft(input: unknown): SnapshotDraft {
  const root = object(canonicalJsonClone(input), "snapshot draft");
  exact(
    root,
    ["id", "binding", "mode", "listCoverage", "startedAt"],
    "snapshot draft",
  );
  if (root.mode !== "full" && root.mode !== "incremental") {
    return invalid("snapshot mode is invalid");
  }
  if (typeof root.id !== "string") return invalid("snapshot ID is invalid");
  return Object.freeze({
    id: snapshotId(root.id),
    binding: parseBinding(root.binding as JsonValue),
    mode: root.mode,
    listCoverage: parseCoverage(root.listCoverage as JsonValue, false) as
      | "collecting"
      | "unavailable"
      | "omitted",
    startedAt: canonicalUtcTimestamp(root.startedAt, "snapshot startedAt"),
  });
}

export function parseSnapshotCounts(input: unknown): SnapshotCounts {
  return parseCountsValue(canonicalJsonClone(input));
}

export function parseSnapshot(input: unknown): Snapshot {
  const root = object(canonicalJsonClone(input), "snapshot");
  exact(
    root,
    [
      "id",
      "binding",
      "mode",
      "listCoverage",
      "startedAt",
      "status",
      "completedAt",
      "failedAt",
      "counts",
      "warningCount",
      "sourceRateLimit",
    ],
    "snapshot",
  );
  if (typeof root.id !== "string") return invalid("snapshot ID is invalid");
  if (root.mode !== "full" && root.mode !== "incremental") {
    return invalid("snapshot mode is invalid");
  }
  if (
    root.status !== "building" &&
    root.status !== "complete" &&
    root.status !== "failed"
  ) {
    return invalid("snapshot status is invalid");
  }
  const listCoverage = parseCoverage(root.listCoverage as JsonValue, true);
  const startedAt = canonicalUtcTimestamp(root.startedAt, "snapshot startedAt");
  const completedAt =
    root.completedAt === null
      ? null
      : canonicalUtcTimestamp(root.completedAt, "snapshot completedAt");
  const failedAt =
    root.failedAt === null
      ? null
      : canonicalUtcTimestamp(root.failedAt, "snapshot failedAt");
  const counts = parseCountsValue(root.counts as JsonValue);
  if (
    (root.status === "building" &&
      (completedAt !== null ||
        failedAt !== null ||
        listCoverage === "complete")) ||
    (root.status === "complete" &&
      (completedAt === null ||
        failedAt !== null ||
        listCoverage === "collecting")) ||
    (root.status === "failed" &&
      (completedAt !== null ||
        failedAt === null ||
        listCoverage === "complete"))
  ) {
    return invalid("snapshot lifecycle fields are inconsistent");
  }
  const terminalAt = completedAt ?? failedAt;
  if (terminalAt !== null && terminalAt < startedAt) {
    return invalid("snapshot terminal timestamp cannot precede startedAt");
  }
  if (
    (listCoverage === "unavailable" || listCoverage === "omitted") &&
    (counts.lists !== 0 || counts.memberships !== 0)
  ) {
    return invalid("snapshot without List coverage cannot contain List rows");
  }
  return Object.freeze({
    id: snapshotId(root.id),
    binding: parseBinding(root.binding as JsonValue),
    mode: root.mode,
    listCoverage,
    startedAt,
    status: root.status,
    completedAt,
    failedAt,
    counts,
    warningCount: nonnegative(
      root.warningCount as JsonValue,
      "snapshot warning count",
    ),
    sourceRateLimit:
      root.sourceRateLimit === null
        ? null
        : freezeJsonValue(root.sourceRateLimit as JsonValue),
  });
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function array(value: JsonValue, label: string): readonly JsonValue[] {
  if (!isJsonArray(value) || value.length > 100) {
    return invalid(`${label} must be a dense array of at most 100 items`);
  }
  return value;
}

function parseMembership(value: JsonValue): ListMembership {
  const input = object(value, "List membership");
  exact(input, ["listId", "repositoryId"], "List membership");
  if (
    typeof input.listId !== "string" ||
    typeof input.repositoryId !== "string"
  ) {
    return invalid("List membership IDs must be strings");
  }
  return Object.freeze({
    listId: listId(input.listId),
    repositoryId: repositoryId(input.repositoryId),
  });
}

function parseBatchRoot(
  input: unknown,
  verification: boolean,
): SnapshotBatch | SnapshotVerificationBatch {
  const root = object(
    canonicalJsonClone(input),
    verification ? "snapshot verification batch" : "snapshot batch",
  );
  exact(
    root,
    verification
      ? ["stars", "lists", "memberships"]
      : ["repositories", "stars", "lists", "memberships"],
    verification ? "snapshot verification batch" : "snapshot batch",
  );
  const repositories = verification
    ? []
    : array(root.repositories as JsonValue, "repository batch").map((entry) =>
        observedRepositoryMetadataSchema.parse(entry),
      );
  const stars = array(root.stars as JsonValue, "Star batch").map((entry) =>
    starRecordSchema.parse(entry),
  );
  const lists = array(root.lists as JsonValue, "List batch").map((entry) =>
    userListSchema.parse(entry),
  );
  const memberships = array(
    root.memberships as JsonValue,
    "membership batch",
  ).map(parseMembership);
  const result = {
    ...(verification ? {} : { repositories }),
    stars,
    lists,
    memberships,
  };
  return freezeJsonValue(canonicalJsonClone(result)) as unknown as
    | SnapshotBatch
    | SnapshotVerificationBatch;
}

export function parseSnapshotBatch(input: unknown): SnapshotBatch {
  try {
    return parseBatchRoot(input, false) as SnapshotBatch;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalid("snapshot batch contains invalid records");
  }
}

export function parseSnapshotVerificationBatch(
  input: unknown,
): SnapshotVerificationBatch {
  try {
    return parseBatchRoot(input, true);
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalid("snapshot verification batch contains invalid records");
  }
}
