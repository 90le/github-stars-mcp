import {
  filterRequiresListCoverage,
  parseRepositoryQuery,
  parseRepositoryQueryPage,
  type FilterExpression,
  type RepositoryQueryPage,
  type RepositorySort,
} from "../../domain/filter.js";
import { canonicalJsonClone } from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import { asSnapshotId, type SnapshotId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import type {
  AccountBinding,
  RepositoryView,
} from "../../domain/repository.js";
import { parseSnapshot, type Snapshot } from "../../domain/snapshot.js";
import type { StoragePort } from "../ports/storage-port.js";
import type { EvidenceRecord, EvidenceService } from "./evidence-service.js";

export type QueryStoragePort = Pick<
  StoragePort,
  | "getCompleteSnapshot"
  | "getLatestCompleteSnapshot"
  | "queryRepositories"
  | "queryLists"
  | "queryListMemberships"
>;

export type StarsQueryField =
  | "repository_id"
  | "repository_database_id"
  | "owner"
  | "name"
  | "full_name"
  | "description"
  | "url"
  | "stargazer_count"
  | "is_fork"
  | "is_archived"
  | "is_disabled"
  | "is_private"
  | "visibility"
  | "primary_language"
  | "topics"
  | "license_spdx_id"
  | "pushed_at"
  | "updated_at"
  | "starred_at";

export type StarsQueryInput = Readonly<{
  snapshotId: SnapshotId | null;
  filter: FilterExpression | null;
  sort: readonly RepositorySort[];
  limit: number;
  cursor: string | null;
  fields: readonly StarsQueryField[] | null;
  evidence: "none" | "summary" | "readme";
  evidenceLimit: number;
}>;

export type EvidenceReader = Pick<EvidenceService, "fetch">;

export type StarsQueryResult = Readonly<{
  snapshotId: SnapshotId;
  total: number;
  aggregates: RepositoryQueryPage["aggregates"];
  items: readonly Readonly<Record<string, JsonValue>>[];
  evidence: readonly EvidenceRecord[];
  nextCursor: string | null;
}>;

const INPUT_KEYS = new Set([
  "snapshotId",
  "filter",
  "sort",
  "limit",
  "cursor",
  "fields",
  "evidence",
  "evidenceLimit",
]);
const BINDING_KEYS = new Set(["host", "login", "accountId"]);
const VALIDATION_SNAPSHOT_ID = asSnapshotId("snap_query_validation");
export const STARS_QUERY_FIELDS = Object.freeze([
  "repository_id",
  "repository_database_id",
  "owner",
  "name",
  "full_name",
  "description",
  "url",
  "stargazer_count",
  "is_fork",
  "is_archived",
  "is_disabled",
  "is_private",
  "visibility",
  "primary_language",
  "topics",
  "license_spdx_id",
  "pushed_at",
  "updated_at",
  "starred_at",
] as const satisfies readonly StarsQueryField[]);

const FIELD_LOOKUP = new Set<string>(STARS_QUERY_FIELDS);
const EMPTY_EVIDENCE = Object.freeze([]) as readonly EvidenceRecord[];

type JsonObject = Readonly<Record<string, JsonValue>>;

function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function validation(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function staleSnapshot(): never {
  throw new AppError(
    "STALE_SNAPSHOT",
    "No usable complete snapshot exists for this account",
    { retryable: false },
  );
}

export function listCoverageUnavailable(): never {
  throw new AppError(
    "CAPABILITY_UNAVAILABLE",
    "The selected snapshot does not contain complete User List coverage",
    { retryable: false },
  );
}

function plainJsonObject(input: unknown, label: string): JsonObject {
  const cloned = canonicalJsonClone(input);
  if (cloned === null || typeof cloned !== "object" || isJsonArray(cloned)) {
    return validation(`${label} must be a plain data object`);
  }
  return cloned;
}

function exactKeys(
  value: JsonObject,
  expected: ReadonlySet<string>,
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    validation(`${label} contains unsupported properties`);
  }
}

function boundedBindingText(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    return validation(`${label} is invalid`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return validation(`${label} is invalid`);
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return validation(`${label} is invalid`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return validation(`${label} is invalid`);
    }
  }
  return value;
}

export function copyQueryBinding(input: AccountBinding): AccountBinding {
  const root = plainJsonObject(input, "account binding");
  exactKeys(root, BINDING_KEYS, "account binding");
  const host = boundedBindingText(root.host, "binding host", 253);
  if (host !== "github.com") {
    return validation("binding host must be github.com");
  }
  return Object.freeze({
    host,
    login: boundedBindingText(root.login, "binding login", 100),
    accountId: boundedBindingText(root.accountId, "binding account ID", 128),
  });
}

function parsedSnapshotId(value: JsonValue | undefined): SnapshotId | null {
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

function parsedFields(
  value: JsonValue | undefined,
): readonly StarsQueryField[] {
  if (value === null) return STARS_QUERY_FIELDS;
  if (!isJsonArray(value) || value.length > STARS_QUERY_FIELDS.length) {
    return validation("fields must contain at most 19 query fields");
  }
  const fields: StarsQueryField[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const field = value[index];
    if (
      typeof field !== "string" ||
      !FIELD_LOOKUP.has(field) ||
      seen.has(field)
    ) {
      return validation("fields contain an unknown or duplicate query field");
    }
    seen.add(field);
    fields.push(field as StarsQueryField);
  }
  return Object.freeze(fields);
}

type ParsedStarsQuery = Readonly<{
  snapshotId: SnapshotId | null;
  filter: FilterExpression | null;
  sort: readonly RepositorySort[];
  limit: number;
  cursor: string | null;
  fields: readonly StarsQueryField[];
  evidence: StarsQueryInput["evidence"];
  evidenceLimit: number;
}>;

function parseStarsQueryInput(input: unknown): ParsedStarsQuery {
  const root = plainJsonObject(input, "Stars query");
  exactKeys(root, INPUT_KEYS, "Stars query");
  const snapshotId = parsedSnapshotId(root.snapshotId);
  const query = parseRepositoryQuery({
    snapshotId: snapshotId ?? VALIDATION_SNAPSHOT_ID,
    filter: root.filter,
    sort: root.sort,
    pageSize: root.limit,
    cursor: root.cursor,
  });
  const fields = parsedFields(root.fields);
  if (
    root.evidence !== "none" &&
    root.evidence !== "summary" &&
    root.evidence !== "readme"
  ) {
    return validation("evidence mode is invalid");
  }
  if (
    typeof root.evidenceLimit !== "number" ||
    !Number.isSafeInteger(root.evidenceLimit) ||
    root.evidenceLimit < 0 ||
    root.evidenceLimit > 20
  ) {
    return validation("evidenceLimit must be an integer from 0 to 20");
  }
  if (root.evidence === "none" && root.evidenceLimit !== 0) {
    return validation("evidenceLimit must be zero when evidence is none");
  }
  return Object.freeze({
    snapshotId,
    filter: query.filter,
    sort: query.sort,
    limit: query.pageSize,
    cursor: query.cursor,
    fields,
    evidence: root.evidence,
    evidenceLimit: root.evidenceLimit,
  });
}

function sameBinding(left: AccountBinding, right: AccountBinding): boolean {
  return (
    left.host === right.host &&
    left.login === right.login &&
    left.accountId === right.accountId
  );
}

export function resolveQuerySnapshot(
  storage: QueryStoragePort,
  binding: AccountBinding,
  snapshotId: SnapshotId | null,
): Snapshot {
  const candidate =
    snapshotId === null
      ? storage.getLatestCompleteSnapshot(binding)
      : storage.getCompleteSnapshot(snapshotId);
  if (candidate === null) return staleSnapshot();

  let snapshot: Snapshot;
  try {
    snapshot = parseSnapshot(candidate);
  } catch {
    return staleSnapshot();
  }
  if (
    snapshot.status !== "complete" ||
    (snapshotId !== null && snapshot.id !== snapshotId) ||
    !sameBinding(snapshot.binding, binding)
  ) {
    return staleSnapshot();
  }
  return snapshot;
}

function projectedValue(
  repository: RepositoryView,
  field: StarsQueryField,
): JsonValue {
  switch (field) {
    case "repository_id":
      return repository.repositoryId;
    case "repository_database_id":
      return repository.repositoryDatabaseId;
    case "owner":
      return repository.owner;
    case "name":
      return repository.name;
    case "full_name":
      return repository.fullName;
    case "description":
      return repository.description;
    case "url":
      return repository.url;
    case "stargazer_count":
      return repository.stargazerCount;
    case "is_fork":
      return repository.isFork;
    case "is_archived":
      return repository.isArchived;
    case "is_disabled":
      return repository.isDisabled;
    case "is_private":
      return repository.isPrivate;
    case "visibility":
      return repository.visibility;
    case "primary_language":
      return repository.primaryLanguage;
    case "topics":
      return repository.topics;
    case "license_spdx_id":
      return repository.licenseSpdxId;
    case "pushed_at":
      return repository.pushedAt;
    case "updated_at":
      return repository.updatedAt;
    case "starred_at":
      return repository.starredAt;
  }
}

function projectRepository(
  repository: RepositoryView,
  fields: readonly StarsQueryField[],
): Readonly<Record<string, JsonValue>> {
  const projected: Record<string, JsonValue> = {};
  for (const field of fields) {
    Object.defineProperty(projected, field, {
      configurable: false,
      enumerable: true,
      value: projectedValue(repository, field),
      writable: false,
    });
  }
  return Object.freeze(projected);
}

export class QueryService {
  readonly #storage: QueryStoragePort;
  readonly #binding: AccountBinding;
  readonly #evidence: EvidenceReader;

  constructor(
    storage: QueryStoragePort,
    binding: AccountBinding,
    evidence: EvidenceReader,
  ) {
    this.#storage = storage;
    this.#binding = copyQueryBinding(binding);
    this.#evidence = evidence;
  }

  async query(
    input: StarsQueryInput,
    signal?: AbortSignal,
  ): Promise<StarsQueryResult> {
    const parsed = parseStarsQueryInput(input);
    const snapshot = resolveQuerySnapshot(
      this.#storage,
      this.#binding,
      parsed.snapshotId,
    );
    if (
      snapshot.listCoverage !== "complete" &&
      filterRequiresListCoverage(parsed.filter)
    ) {
      return listCoverageUnavailable();
    }

    const page = parseRepositoryQueryPage(
      this.#storage.queryRepositories({
        snapshotId: snapshot.id,
        filter: parsed.filter,
        sort: parsed.sort,
        pageSize: parsed.limit,
        cursor: parsed.cursor,
      }),
    );
    let evidence = EMPTY_EVIDENCE;
    if (parsed.evidence !== "none") {
      if (parsed.evidenceLimit > Math.min(20, page.items.length)) {
        return validation(
          "evidenceLimit cannot exceed the selected repository page",
        );
      }
      evidence = await this.#evidence.fetch(
        page.items.slice(0, parsed.evidenceLimit),
        parsed.evidence,
        signal,
      );
    }
    const items = Object.freeze(
      page.items.map((repository) =>
        projectRepository(repository, parsed.fields),
      ),
    );
    return await Promise.resolve(
      Object.freeze({
        snapshotId: snapshot.id,
        total: page.total,
        aggregates: page.aggregates,
        items,
        evidence,
        nextCursor: page.nextCursor,
      }),
    );
  }
}
