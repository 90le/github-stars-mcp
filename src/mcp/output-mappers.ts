import { Buffer } from "node:buffer";
import type { RateLimitState } from "../app/ports/github-port.js";
import type { ApplyResult } from "../app/services/apply-service.js";
import type { DiscoveryResult } from "../app/services/discovery-service.js";
import type { EvidenceRecord } from "../app/services/evidence-service.js";
import type { InspectResult } from "../app/services/inspect-service.js";
import type { ListsQueryResult } from "../app/services/lists-query-service.js";
import type { CreatePlanResult } from "../app/services/plan-service.js";
import type { StarsQueryResult } from "../app/services/query-service.js";
import type { StatusResult } from "../app/services/status-service.js";
import type { SyncResult } from "../app/services/sync-service.js";
import { canonicalJson, canonicalJsonClone } from "../domain/canonical-json.js";
import { AppError, type SerializedDomainError } from "../domain/errors.js";
import type { JsonValue } from "../domain/json.js";
import {
  parseChangePlan,
  parseResolvedOperation,
  type ResolvedOperation,
} from "../domain/plan.js";
import {
  repositorySchema,
  type Repository,
  type UserList,
} from "../domain/repository.js";
import {
  parseChangeRun,
  parseRunOperation,
  parseRunOperationAttempt,
  parseRunOperationReconciliation,
  type ChangeRun,
  type RunOperation,
  type RunOperationAttempt,
  type RunOperationReconciliation,
} from "../domain/run.js";
import { parseSnapshot, type Snapshot } from "../domain/snapshot.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import {
  ApplyOutputDataSchema,
  DiscoveryOutputDataSchema,
  InspectOutputDataSchema,
  ListsQueryOutputDataSchema,
  PlanOutputDataSchema,
  StarsQueryOutputDataSchema,
  StatusOutputDataSchema,
  SyncOutputDataSchema,
} from "./schemas/output.js";

type PublicData = Readonly<Record<string, unknown>>;
type JsonRecord = Readonly<Record<string, JsonValue>>;
type RepositoryResolvedOperation = Extract<
  ResolvedOperation,
  { readonly repositoryId: unknown }
>;
type MembershipResolvedOperation = Extract<
  ResolvedOperation,
  { readonly expectedListIds: unknown }
>;

export type ToolServiceOutput = Readonly<{
  data: PublicData;
  warnings: readonly string[];
  rateLimit: RateLimitState | null;
  nextCursor: string | null;
}>;

const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 512;
const MAX_CURSOR_LENGTH = 4_096;
const COUNT_KEYS = [
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "unresolved",
] as const;
const OPERATION_KINDS = [
  "star",
  "unstar",
  "list_create",
  "list_update",
  "list_delete",
  "list_membership_set",
] as const;

function invalid(label: string): never {
  throw new AppError(
    "INTERNAL_ERROR",
    `${label} does not satisfy the public output contract`,
    {
      retryable: false,
      details: { reason: "malformed_application_result" },
    },
  );
}

function cloneValue(input: unknown, label: string): JsonValue {
  try {
    return canonicalJsonClone(input);
  } catch {
    return invalid(label);
  }
}

function record(input: JsonValue, label: string): JsonRecord {
  if (input === null || typeof input !== "object" || isJsonArray(input)) {
    return invalid(label);
  }
  return input;
}

function isJsonArray(input: JsonValue): input is readonly JsonValue[] {
  return Array.isArray(input);
}

function array(input: JsonValue, label: string): readonly JsonValue[] {
  if (!isJsonArray(input)) return invalid(label);
  return input;
}

function exactKeys(
  input: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(input);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(input, key))
  ) {
    invalid(label);
  }
}

function stringValue(input: JsonValue | undefined, label: string): string {
  if (typeof input !== "string") return invalid(label);
  return input;
}

function nullableString(
  input: JsonValue | undefined,
  label: string,
): string | null {
  if (input === null) return null;
  return stringValue(input, label);
}

function booleanValue(input: JsonValue | undefined, label: string): boolean {
  if (typeof input !== "boolean") return invalid(label);
  return input;
}

function nonnegative(input: JsonValue | undefined, label: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    return invalid(label);
  }
  return input;
}

function timestamp(input: JsonValue | undefined, label: string): string {
  try {
    const value = canonicalUtcTimestamp(input, label);
    if (value !== input) return invalid(label);
    return value;
  } catch {
    return invalid(label);
  }
}

function nullableTimestamp(
  input: JsonValue | undefined,
  label: string,
): string | null {
  return input === null ? null : timestamp(input, label);
}

function identityText(
  input: JsonValue | undefined,
  label: string,
  maximum: number,
): string {
  const value = stringValue(input, label);
  if (value.length === 0 || value.length > maximum || value !== value.trim()) {
    return invalid(label);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return invalid(label);
    }
  }
  return value;
}

function validateBinding(input: JsonValue, label: string): void {
  const binding = record(input, label);
  exactKeys(binding, ["host", "login", "accountId"], label);
  if (identityText(binding.host, `${label} host`, 253) !== "github.com") {
    invalid(`${label} host`);
  }
  identityText(binding.login, `${label} login`, 100);
  identityText(binding.accountId, `${label} account ID`, 128);
}

function cursor(input: JsonValue | undefined): string | null {
  if (input === null) return null;
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    Buffer.byteLength(input, "utf8") > MAX_CURSOR_LENGTH
  ) {
    return invalid("cursor");
  }
  return input;
}

function rateLimit(input: JsonValue | undefined): RateLimitState | null {
  if (input === null) return null;
  const value = record(input as JsonValue, "rate limit");
  exactKeys(value, ["remaining", "resetAt"], "rate limit");
  return Object.freeze({
    remaining: nonnegative(value.remaining, "rate limit remaining"),
    resetAt: timestamp(value.resetAt, "rate limit reset"),
  });
}

function truncateText(input: string, maximum: number): string {
  if (input.length <= maximum) return input;
  let end = maximum;
  const last = input.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return input.slice(0, end);
}

function wellFormedText(input: string): string {
  let output = "";
  let segmentStart = 0;
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }
    output += `${input.slice(segmentStart, index)}\ufffd`;
    segmentStart = index + 1;
  }
  return segmentStart === 0 ? input : output + input.slice(segmentStart);
}

export function normalizeOutputWarnings(
  input: readonly string[],
): readonly string[] {
  const cloned = array(cloneValue(input, "warnings"), "warnings");
  const output: string[] = [];
  const retained =
    cloned.length > MAX_WARNINGS ? MAX_WARNINGS - 1 : cloned.length;
  for (let index = 0; index < retained; index += 1) {
    const warning = cloned[index];
    if (typeof warning !== "string") return invalid("warning");
    output.push(truncateText(wellFormedText(warning), MAX_WARNING_LENGTH));
  }
  if (cloned.length > MAX_WARNINGS) {
    output.push(`${cloned.length - retained} additional warnings omitted`);
  }
  return Object.freeze(output);
}

function output(
  schema: { parse(input: unknown): unknown },
  data: PublicData,
  warnings: readonly string[],
  currentRate: RateLimitState | null,
  nextCursor: string | null,
): ToolServiceOutput {
  const parsed = schema.parse(data);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("mapped data");
  }
  return Object.freeze({
    data: parsed as PublicData,
    warnings: normalizeOutputWarnings(warnings),
    rateLimit: currentRate,
    nextCursor,
  });
}

function mapSnapshotCounts(input: Snapshot["counts"]): PublicData {
  return {
    repositories: input.repositories,
    stars: input.stars,
    lists: input.lists,
    memberships: input.memberships,
  };
}

function mapRunCounts(input: JsonValue, label: string): PublicData {
  const value = record(input, label);
  exactKeys(value, COUNT_KEYS, label);
  return {
    pending: nonnegative(value.pending, `${label} pending`),
    running: nonnegative(value.running, `${label} running`),
    succeeded: nonnegative(value.succeeded, `${label} succeeded`),
    skipped: nonnegative(value.skipped, `${label} skipped`),
    failed: nonnegative(value.failed, `${label} failed`),
    unresolved: nonnegative(value.unresolved, `${label} unresolved`),
  };
}

function mapSnapshot(input: Snapshot): PublicData {
  if (
    input.status !== "complete" ||
    input.completedAt === null ||
    input.failedAt !== null
  ) {
    return invalid("latest complete snapshot");
  }
  return {
    snapshot_id: input.id,
    mode: input.mode,
    list_coverage: input.listCoverage,
    status: "complete",
    started_at: input.startedAt,
    completed_at: input.completedAt,
    failed_at: null,
    counts: mapSnapshotCounts(input.counts),
    warning_count: input.warningCount,
  };
}

export function toStatusOutput(input: StatusResult): ToolServiceOutput {
  const root = record(cloneValue(input, "status result"), "status result");
  exactKeys(
    root,
    [
      "serverVersion",
      "host",
      "login",
      "credentialSource",
      "capabilities",
      "databaseSchemaVersion",
      "latestCompleteSnapshot",
      "incompleteRuns",
      "rateLimit",
    ],
    "status result",
  );
  const capabilities = record(root.capabilities as JsonValue, "capabilities");
  exactKeys(
    capabilities,
    ["starRead", "starWrite", "listRead", "listWrite"],
    "capabilities",
  );
  const snapshot =
    root.latestCompleteSnapshot === null
      ? null
      : parseSnapshot(root.latestCompleteSnapshot);
  const incomplete = record(
    root.incompleteRuns as JsonValue,
    "incomplete runs",
  );
  exactKeys(incomplete, ["items", "total", "truncated"], "incomplete runs");
  const incompleteItems = array(
    incomplete.items as JsonValue,
    "incomplete run items",
  ).map((candidate) => {
    const item = record(candidate, "incomplete run");
    exactKeys(
      item,
      ["runId", "planId", "state", "startedAt", "finishedAt", "counts"],
      "incomplete run",
    );
    return {
      run_id: stringValue(item.runId, "run ID"),
      plan_id: stringValue(item.planId, "plan ID"),
      state: stringValue(item.state, "run state"),
      started_at: timestamp(item.startedAt, "run startedAt"),
      finished_at: nullableTimestamp(item.finishedAt, "run finishedAt"),
      counts: mapRunCounts(item.counts as JsonValue, "run counts"),
    };
  });
  const data = {
    server_version: stringValue(root.serverVersion, "server version"),
    host: stringValue(root.host, "host"),
    login: stringValue(root.login, "login"),
    credential_source: stringValue(root.credentialSource, "credential source"),
    capabilities: {
      star_read: stringValue(capabilities.starRead, "star read capability"),
      star_write: stringValue(capabilities.starWrite, "star write capability"),
      list_read: stringValue(capabilities.listRead, "List read capability"),
      list_write: stringValue(capabilities.listWrite, "List write capability"),
    },
    database_schema_version: nonnegative(
      root.databaseSchemaVersion,
      "database schema version",
    ),
    latest_complete_snapshot: snapshot === null ? null : mapSnapshot(snapshot),
    incomplete_runs: {
      items: incompleteItems,
      total: nonnegative(incomplete.total, "incomplete run total"),
      truncated: booleanValue(
        incomplete.truncated,
        "incomplete run truncation",
      ),
    },
  };
  return output(
    StatusOutputDataSchema,
    data,
    [],
    rateLimit(root.rateLimit),
    null,
  );
}

export function toSyncOutput(input: SyncResult): ToolServiceOutput {
  const root = record(cloneValue(input, "sync result"), "sync result");
  exactKeys(
    root,
    ["snapshotId", "counts", "warnings", "rateLimit", "durationMs"],
    "sync result",
  );
  const counts = record(root.counts as JsonValue, "sync counts");
  exactKeys(
    counts,
    [
      "repositories",
      "stars",
      "lists",
      "memberships",
      "refreshedRepositories",
      "reusedMetadata",
      "warnings",
    ],
    "sync counts",
  );
  const warnings = array(root.warnings as JsonValue, "sync warnings");
  const data = {
    snapshot_id: stringValue(root.snapshotId, "snapshot ID"),
    counts: {
      repositories: nonnegative(counts.repositories, "repository count"),
      stars: nonnegative(counts.stars, "Star count"),
      lists: nonnegative(counts.lists, "List count"),
      memberships: nonnegative(counts.memberships, "membership count"),
      refreshed_repositories: nonnegative(
        counts.refreshedRepositories,
        "refreshed repository count",
      ),
      reused_metadata: nonnegative(
        counts.reusedMetadata,
        "reused metadata count",
      ),
      warnings: nonnegative(counts.warnings, "warning count"),
    },
    duration_ms: nonnegative(root.durationMs, "sync duration"),
  };
  return output(
    SyncOutputDataSchema,
    data,
    warnings as readonly string[],
    rateLimit(root.rateLimit),
    null,
  );
}

function mapEvidence(input: EvidenceRecord): PublicData {
  return {
    repository_id: input.repositoryId,
    kind: input.kind,
    text: input.text,
    source_url: input.sourceUrl,
    sha: input.sha,
    byte_length: input.byteLength,
    truncated: input.truncated,
    missing: input.missing,
  };
}

function mapEvidenceValue(input: JsonValue): PublicData {
  const value = record(input, "evidence");
  exactKeys(
    value,
    [
      "repositoryId",
      "kind",
      "text",
      "sourceUrl",
      "sha",
      "byteLength",
      "truncated",
      "missing",
    ],
    "evidence",
  );
  return mapEvidence(value as unknown as EvidenceRecord);
}

function mapProjection(input: JsonValue): PublicData {
  const value = record(input, "repository projection");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    switch (key) {
      case "repository_id":
      case "repository_database_id":
      case "owner":
      case "name":
      case "description":
      case "url":
      case "is_private":
      case "visibility":
      case "topics":
      case "pushed_at":
      case "updated_at":
      case "starred_at":
        result[key] = value[key];
        break;
      case "full_name":
        result.name_with_owner = value.full_name;
        break;
      case "stargazer_count":
        result.stargazers_count = value.stargazer_count;
        break;
      case "is_fork":
        result.fork = value.is_fork;
        break;
      case "is_archived":
        result.archived = value.is_archived;
        break;
      case "is_disabled":
        result.disabled = value.is_disabled;
        break;
      case "primary_language":
        result.language = value.primary_language;
        break;
      case "license_spdx_id":
        result.license = value.license_spdx_id;
        break;
      default:
        invalid("repository projection");
    }
  }
  return result;
}

export function toStarsQueryOutput(input: StarsQueryResult): ToolServiceOutput {
  const root = record(cloneValue(input, "Stars query result"), "Stars result");
  exactKeys(
    root,
    ["snapshotId", "total", "aggregates", "items", "evidence", "nextCursor"],
    "Stars result",
  );
  const aggregates = record(root.aggregates as JsonValue, "query aggregates");
  exactKeys(aggregates, ["languages", "archived", "forks"], "query aggregates");
  const languages = array(
    aggregates.languages as JsonValue,
    "language aggregates",
  ).map((candidate) => {
    const item = record(candidate, "language aggregate");
    exactKeys(item, ["language", "count"], "language aggregate");
    return {
      language:
        item.language === null
          ? null
          : stringValue(item.language, "aggregate language"),
      count: nonnegative(item.count, "aggregate count"),
    };
  });
  const data = {
    snapshot_id: stringValue(root.snapshotId, "snapshot ID"),
    total: nonnegative(root.total, "query total"),
    aggregates: {
      languages,
      archived: nonnegative(aggregates.archived, "archived aggregate"),
      forks: nonnegative(aggregates.forks, "fork aggregate"),
    },
    items: array(root.items as JsonValue, "query items").map(mapProjection),
    evidence: array(root.evidence as JsonValue, "query evidence").map(
      mapEvidenceValue,
    ),
  };
  return output(
    StarsQueryOutputDataSchema,
    data,
    [],
    null,
    cursor(root.nextCursor),
  );
}

function mapList(input: UserList & { readonly repositoryCount: number }) {
  return {
    list_id: input.listId,
    name: input.name,
    slug: input.slug,
    description: input.description,
    is_private: input.isPrivate,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    last_added_at: input.lastAddedAt,
    repository_count: input.repositoryCount,
  };
}

export function toListsQueryOutput(input: ListsQueryResult): ToolServiceOutput {
  const root = record(cloneValue(input, "Lists query result"), "Lists result");
  if (Object.hasOwn(root, "items")) {
    exactKeys(
      root,
      ["snapshotId", "coverage", "items", "total", "nextCursor"],
      "List page",
    );
    const items = array(root.items as JsonValue, "List items").map(
      (candidate) => {
        const item = record(candidate, "List summary");
        exactKeys(
          item,
          [
            "listId",
            "name",
            "slug",
            "description",
            "isPrivate",
            "createdAt",
            "updatedAt",
            "lastAddedAt",
            "repositoryCount",
          ],
          "List summary",
        );
        return mapList(
          item as unknown as UserList & {
            readonly repositoryCount: number;
          },
        );
      },
    );
    return output(
      ListsQueryOutputDataSchema,
      {
        mode: "lists",
        snapshot_id: stringValue(root.snapshotId, "snapshot ID"),
        coverage: stringValue(root.coverage, "List coverage"),
        items,
        total: nonnegative(root.total, "List total"),
      },
      [],
      null,
      cursor(root.nextCursor),
    );
  }

  exactKeys(
    root,
    [
      "snapshotId",
      "coverage",
      "selector",
      "total",
      "nextCursor",
      Object.hasOwn(root, "repositoryIds") ? "repositoryIds" : "listIds",
    ],
    "membership page",
  );
  const selector = record(root.selector as JsonValue, "membership selector");
  const kind = stringValue(selector.kind, "membership selector kind");
  if (kind === "list") {
    exactKeys(selector, ["kind", "listId"], "List membership selector");
    return output(
      ListsQueryOutputDataSchema,
      {
        mode: "memberships",
        snapshot_id: stringValue(root.snapshotId, "snapshot ID"),
        coverage: stringValue(root.coverage, "List coverage"),
        selector: {
          kind: "list",
          list_id: stringValue(selector.listId, "List ID"),
        },
        repository_ids: array(
          root.repositoryIds as JsonValue,
          "repository IDs",
        ),
        total: nonnegative(root.total, "membership total"),
      },
      [],
      null,
      cursor(root.nextCursor),
    );
  }
  if (kind !== "repository") return invalid("membership selector");
  exactKeys(
    selector,
    ["kind", "repositoryId"],
    "repository membership selector",
  );
  return output(
    ListsQueryOutputDataSchema,
    {
      mode: "memberships",
      snapshot_id: stringValue(root.snapshotId, "snapshot ID"),
      coverage: stringValue(root.coverage, "List coverage"),
      selector: {
        kind: "repository",
        repository_id: stringValue(selector.repositoryId, "repository ID"),
      },
      list_ids: array(root.listIds as JsonValue, "List IDs"),
      total: nonnegative(root.total, "membership total"),
    },
    [],
    null,
    cursor(root.nextCursor),
  );
}

function mapRepository(input: Repository): PublicData {
  return {
    repository_id: input.repositoryId,
    repository_database_id: input.repositoryDatabaseId,
    owner: input.owner,
    name: input.name,
    name_with_owner: input.fullName,
    description: input.description,
    url: input.url,
    stargazers_count: input.stargazerCount,
    fork: input.isFork,
    archived: input.isArchived,
    disabled: input.isDisabled,
    is_private: input.isPrivate,
    visibility: input.visibility,
    language: input.primaryLanguage,
    topics: input.topics,
    license: input.licenseSpdxId,
    pushed_at: input.pushedAt,
    updated_at: input.updatedAt,
  };
}

export function toDiscoveryOutput(input: DiscoveryResult): ToolServiceOutput {
  const root = record(
    cloneValue(input, "discovery result"),
    "discovery result",
  );
  exactKeys(
    root,
    [
      "items",
      "evidence",
      "reportedTotal",
      "cappedTotal",
      "incompleteResults",
      "nextCursor",
      "rateLimit",
    ],
    "discovery result",
  );
  const items = array(root.items as JsonValue, "discovery items").map(
    (candidate) => {
      const item = record(candidate, "discovery item");
      exactKeys(item, ["repository", "alreadyStarred"], "discovery item");
      return {
        repository: mapRepository(repositorySchema.parse(item.repository)),
        already_starred: booleanValue(item.alreadyStarred, "already starred"),
      };
    },
  );
  const data = {
    items,
    evidence: array(root.evidence as JsonValue, "discovery evidence").map(
      mapEvidenceValue,
    ),
    reported_total: nonnegative(root.reportedTotal, "reported total"),
    capped_total: nonnegative(root.cappedTotal, "capped total"),
    incomplete_results: booleanValue(
      root.incompleteResults,
      "incomplete results",
    ),
  };
  return output(
    DiscoveryOutputDataSchema,
    data,
    [],
    rateLimit(root.rateLimit),
    cursor(root.nextCursor),
  );
}

function operationCounts(
  input: JsonValue,
): Record<(typeof OPERATION_KINDS)[number], number> {
  const value = record(input, "operation summary");
  exactKeys(value, OPERATION_KINDS, "operation summary");
  return {
    star: nonnegative(value.star, "star operation count"),
    unstar: nonnegative(value.unstar, "unstar operation count"),
    list_create: nonnegative(value.list_create, "List create operation count"),
    list_update: nonnegative(value.list_update, "List update operation count"),
    list_delete: nonnegative(value.list_delete, "List delete operation count"),
    list_membership_set: nonnegative(
      value.list_membership_set,
      "membership operation count",
    ),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compactPlan(input: CreatePlanResult): {
  readonly data: PublicData;
  readonly warnings: readonly string[];
} {
  const root = record(cloneValue(input, "plan result"), "plan result");
  exactKeys(root, ["plan", "summary"], "plan result");
  const plan = parseChangePlan(root.plan);
  const suppliedCounts = operationCounts(root.summary as JsonValue);
  const computedCounts = {
    star: 0,
    unstar: 0,
    list_create: 0,
    list_update: 0,
    list_delete: 0,
    list_membership_set: 0,
  };
  const riskCounts = { normal: 0, destructive: 0, non_reversible: 0 };
  const repositories = new Set<string>();
  const lists = new Set<string>();
  const createdRefs = new Set<string>();
  for (const operation of plan.operations) {
    computedCounts[operation.kind] += 1;
    riskCounts[operation.risk] += 1;
    if (
      operation.kind === "star" ||
      operation.kind === "unstar" ||
      operation.kind === "list_membership_set"
    ) {
      repositories.add(operation.repositoryId);
    }
    if (operation.kind === "list_update" || operation.kind === "list_delete") {
      lists.add(operation.listId);
    } else if (operation.kind === "list_create") {
      createdRefs.add(operation.clientRef);
    } else if (operation.kind === "list_membership_set") {
      for (const listId of operation.expectedListIds) lists.add(listId);
      for (const target of operation.targetLists) {
        if (target.kind === "existing") lists.add(target.listId);
      }
    }
  }
  if (canonicalJson(suppliedCounts) !== canonicalJson(computedCounts)) {
    return invalid("operation summary");
  }
  return {
    data: {
      plan_id: plan.id,
      plan_hash: plan.hash,
      state: plan.state,
      snapshot_id: plan.executable.snapshotId,
      created_at: plan.createdAt,
      expires_at: plan.expiresAt,
      operation_count: plan.operations.length,
      dependency_count: plan.dependencies.length,
      operation_counts: computedCounts,
      risk_counts: riskCounts,
      affected_repository_ids: Array.from(repositories).sort(compareText),
      affected_list_ids: Array.from(lists).sort(compareText),
      created_client_refs: Array.from(createdRefs).sort(compareText),
      protected_repository_ids: plan.executable.protectedRepositoryIds,
      protected_list_ids: plan.executable.protectedListIds,
    },
    warnings: plan.warnings,
  };
}

export function toPlanOutput(input: CreatePlanResult): ToolServiceOutput {
  const mapped = compactPlan(input);
  return output(PlanOutputDataSchema, mapped.data, mapped.warnings, null, null);
}

export function toRollbackOutput(input: CreatePlanResult): ToolServiceOutput {
  const mapped = compactPlan(input);
  return output(PlanOutputDataSchema, mapped.data, mapped.warnings, null, null);
}

function mapSerializedError(
  input: SerializedDomainError | null,
): PublicData | null {
  if (input === null) return null;
  return {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    details: input.details,
  };
}

function mapRun(input: ChangeRun): PublicData {
  return {
    run_id: input.id,
    plan_id: input.planId,
    state: input.state,
    failure_mode: input.failureMode,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
  };
}

function mapResolvedOperation(input: ResolvedOperation): PublicData {
  const common = {
    operation_id: input.operationId,
    depends_on: input.dependsOn,
    preconditions: input.preconditions.map((precondition) => ({
      kind: precondition.kind,
      expected: precondition.expected,
    })),
    before: input.before,
    after: input.after,
    inverse: input.inverse,
    risk: input.risk,
  };
  if (input.kind === "star" || input.kind === "unstar") {
    const operation = input as RepositoryResolvedOperation;
    return {
      operation_id: common.operation_id,
      depends_on: common.depends_on,
      preconditions: common.preconditions,
      before: common.before,
      after: common.after,
      inverse: common.inverse,
      risk: common.risk,
      kind: input.kind,
      repository_id: operation.repositoryId,
      repository_database_id: operation.repositoryDatabaseId,
      coordinates: {
        owner: operation.coordinates.owner,
        name: operation.coordinates.name,
      },
    };
  }
  if (input.kind === "list_create") {
    return {
      operation_id: common.operation_id,
      depends_on: common.depends_on,
      preconditions: common.preconditions,
      before: common.before,
      after: common.after,
      inverse: common.inverse,
      risk: common.risk,
      kind: input.kind,
      client_ref: input.clientRef,
    };
  }
  if (input.kind === "list_update" || input.kind === "list_delete") {
    return {
      operation_id: common.operation_id,
      depends_on: common.depends_on,
      preconditions: common.preconditions,
      before: common.before,
      after: common.after,
      inverse: common.inverse,
      risk: common.risk,
      kind: input.kind,
      list_id: input.listId,
    };
  }
  const operation = input as MembershipResolvedOperation;
  return {
    operation_id: common.operation_id,
    depends_on: common.depends_on,
    preconditions: common.preconditions,
    before: common.before,
    after: common.after,
    inverse: common.inverse,
    risk: common.risk,
    kind: operation.kind,
    repository_id: operation.repositoryId,
    repository_database_id: operation.repositoryDatabaseId,
    coordinates: {
      owner: operation.coordinates.owner,
      name: operation.coordinates.name,
    },
    expected_list_ids: operation.expectedListIds,
    target_lists: operation.targetLists.map((target) =>
      target.kind === "existing"
        ? { kind: "existing", list_id: target.listId }
        : {
            kind: "created",
            create_operation_id: target.createOperationId,
          },
    ),
  };
}

function mapRunOperation(input: RunOperation): PublicData {
  return {
    run_id: input.runId,
    operation_id: input.operationId,
    sequence: input.sequence,
    status: input.status,
    reconciliation: input.reconciliation,
    attempts: input.attempts,
    before: input.before,
    after: input.after,
    external_request_id: input.externalRequestId,
    error: mapSerializedError(input.error),
    started_at: input.startedAt,
    finished_at: input.finishedAt,
  };
}

function mapAttempt(input: RunOperationAttempt): PublicData {
  return {
    run_id: input.runId,
    operation_id: input.operationId,
    attempt: input.attempt,
    status: input.status,
    reconciliation: input.reconciliation,
    before: input.before,
    after: input.after,
    external_request_id: input.externalRequestId,
    error: mapSerializedError(input.error),
    started_at: input.startedAt,
    finished_at: input.finishedAt,
  };
}

function mapReconciliation(input: RunOperationReconciliation): PublicData {
  return {
    run_id: input.runId,
    operation_id: input.operationId,
    attempt: input.attempt,
    event_sequence: input.eventSequence,
    status: input.status,
    reconciliation: input.reconciliation,
    after: input.after,
    error: mapSerializedError(input.error),
    observed_at: input.observedAt,
  };
}

function inspectRoot(input: InspectResult): JsonRecord {
  return record(cloneValue(input, "inspect result"), "inspect result");
}

export function toInspectOutput(input: InspectResult): ToolServiceOutput {
  const root = inspectRoot(input);
  const kind = stringValue(root.kind, "inspect kind");
  if (kind === "plan") {
    exactKeys(
      root,
      ["kind", "plan", "operations", "total", "nextCursor"],
      "plan inspection",
    );
    const metadata = record(root.plan as JsonValue, "plan metadata");
    exactKeys(
      metadata,
      [
        "id",
        "hash",
        "state",
        "createdAt",
        "expiresAt",
        "callerNote",
        "binding",
        "snapshotId",
        "schemaVersion",
        "policyVersion",
        "protectedRepositoryIds",
        "protectedListIds",
        "warnings",
        "operationCount",
        "dependencyCount",
      ],
      "plan metadata",
    );
    validateBinding(metadata.binding as JsonValue, "plan binding");
    const operations = array(
      root.operations as JsonValue,
      "plan inspection operations",
    ).map((candidate) => {
      const row = record(candidate, "plan inspection operation");
      exactKeys(row, ["sequence", "operation"], "plan inspection operation");
      return {
        sequence: nonnegative(row.sequence, "operation sequence"),
        operation: mapResolvedOperation(parseResolvedOperation(row.operation)),
      };
    });
    const data = {
      kind: "plan",
      plan: {
        plan_id: stringValue(metadata.id, "plan ID"),
        plan_hash: stringValue(metadata.hash, "plan hash"),
        state: stringValue(metadata.state, "plan state"),
        created_at: timestamp(metadata.createdAt, "plan createdAt"),
        expires_at: timestamp(metadata.expiresAt, "plan expiresAt"),
        caller_note: nullableString(metadata.callerNote, "caller note"),
        snapshot_id: stringValue(metadata.snapshotId, "snapshot ID"),
        schema_version: nonnegative(
          metadata.schemaVersion,
          "plan schema version",
        ),
        policy_version: stringValue(metadata.policyVersion, "policy version"),
        protected_repository_ids: array(
          metadata.protectedRepositoryIds as JsonValue,
          "protected repository IDs",
        ),
        protected_list_ids: array(
          metadata.protectedListIds as JsonValue,
          "protected List IDs",
        ),
        operation_count: nonnegative(
          metadata.operationCount,
          "operation count",
        ),
        dependency_count: nonnegative(
          metadata.dependencyCount,
          "dependency count",
        ),
      },
      operations,
      total: nonnegative(root.total, "inspection total"),
    };
    return output(
      InspectOutputDataSchema,
      data,
      array(
        metadata.warnings as JsonValue,
        "plan warnings",
      ) as readonly string[],
      null,
      cursor(root.nextCursor),
    );
  }

  if (kind === "run") {
    exactKeys(
      root,
      ["kind", "run", "operations", "total", "nextCursor"],
      "run inspection",
    );
    const parsedRun = parseChangeRun(root.run);
    const operations = array(
      root.operations as JsonValue,
      "run operations",
    ).map((candidate) => parseRunOperation(candidate));
    if (operations.some((operation) => operation.runId !== parsedRun.id)) {
      return invalid("run operation identity");
    }
    return output(
      InspectOutputDataSchema,
      {
        kind: "run",
        run: mapRun(parsedRun),
        operations: operations.map(mapRunOperation),
        total: nonnegative(root.total, "inspection total"),
      },
      parsedRun.warnings,
      null,
      cursor(root.nextCursor),
    );
  }

  if (kind === "attempts") {
    exactKeys(
      root,
      ["kind", "run", "operationId", "attempts", "total", "nextCursor"],
      "attempt inspection",
    );
    const parsedRun = parseChangeRun(root.run);
    const operationId = stringValue(root.operationId, "operation ID");
    const attempts = array(root.attempts as JsonValue, "attempts").map(
      (candidate) => parseRunOperationAttempt(candidate),
    );
    if (
      attempts.some(
        (attempt) =>
          attempt.runId !== parsedRun.id || attempt.operationId !== operationId,
      )
    ) {
      return invalid("attempt identity");
    }
    return output(
      InspectOutputDataSchema,
      {
        kind: "attempts",
        run: mapRun(parsedRun),
        operation_id: operationId,
        attempts: attempts.map(mapAttempt),
        total: nonnegative(root.total, "attempt total"),
      },
      parsedRun.warnings,
      null,
      cursor(root.nextCursor),
    );
  }

  if (kind !== "reconciliations") return invalid("inspect kind");
  exactKeys(
    root,
    ["kind", "run", "operationId", "reconciliations", "total", "nextCursor"],
    "reconciliation inspection",
  );
  const parsedRun = parseChangeRun(root.run);
  const operationId = stringValue(root.operationId, "operation ID");
  const reconciliations = array(
    root.reconciliations as JsonValue,
    "reconciliations",
  ).map((candidate) => parseRunOperationReconciliation(candidate));
  if (
    reconciliations.some(
      (event) =>
        event.runId !== parsedRun.id || event.operationId !== operationId,
    )
  ) {
    return invalid("reconciliation identity");
  }
  return output(
    InspectOutputDataSchema,
    {
      kind: "reconciliations",
      run: mapRun(parsedRun),
      operation_id: operationId,
      reconciliations: reconciliations.map(mapReconciliation),
      total: nonnegative(root.total, "reconciliation total"),
    },
    parsedRun.warnings,
    null,
    cursor(root.nextCursor),
  );
}

export function toApplyOutput(input: ApplyResult): ToolServiceOutput {
  const root = record(cloneValue(input, "apply result"), "apply result");
  exactKeys(
    root,
    ["run", "warnings", "counts", "errors", "auditCursor"],
    "apply result",
  );
  const parsedRun = parseChangeRun(root.run);
  const warnings = array(root.warnings as JsonValue, "apply warnings");
  if (canonicalJson(warnings) !== canonicalJson(parsedRun.warnings)) {
    return invalid("apply warnings");
  }
  const errors = array(root.errors as JsonValue, "apply errors").map(
    (candidate) => {
      const error = record(candidate, "apply error");
      exactKeys(
        error,
        ["code", "message", "retryable", "details"],
        "apply error",
      );
      return {
        code: stringValue(error.code, "error code"),
        message: stringValue(error.message, "error message"),
        retryable: booleanValue(error.retryable, "error retryability"),
        details: error.details as JsonValue,
      };
    },
  );
  return output(
    ApplyOutputDataSchema,
    {
      run_id: parsedRun.id,
      plan_id: parsedRun.planId,
      state: parsedRun.state,
      failure_mode: parsedRun.failureMode,
      started_at: parsedRun.startedAt,
      finished_at: parsedRun.finishedAt,
      counts: mapRunCounts(root.counts as JsonValue, "apply counts"),
      errors,
      audit_cursor: cursor(root.auditCursor),
    },
    warnings as readonly string[],
    null,
    null,
  );
}
