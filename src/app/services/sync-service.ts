import type {
  GitHubCapabilities,
  GitHubListItem,
  GitHubStar,
  GitHubSyncReadPort,
  GitHubUserList,
  Page,
  RateLimitState,
} from "../ports/github-port.js";
import type { RateStateReader } from "../ports/rate-state-reader.js";
import type { Clock, IdGenerator } from "../ports/runtime-port.js";
import type { StoragePort } from "../ports/storage-port.js";
import { canonicalJsonClone, sha256Hex } from "../../domain/canonical-json.js";
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
import {
  observedRepositoryMetadataSchema,
  type AccountBinding,
  type ListMembership,
  type ObservedRepositoryMetadata,
  type StarRecord,
} from "../../domain/repository.js";
import type {
  ListCoverage,
  SnapshotBatch,
  SnapshotCounts,
  SnapshotDraft,
  SnapshotVerificationBatch,
} from "../../domain/snapshot.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";
import {
  appendCleanupDiagnostic,
  LeaseScope,
  type LeaseScheduler,
} from "./lease-scope.js";

export type SyncInput = Readonly<{
  mode: "full" | "incremental";
  includeLists: boolean;
  metadataMaxAgeHours: number;
}>;

export type SyncCounts = Readonly<{
  repositories: number;
  stars: number;
  lists: number;
  memberships: number;
  refreshedRepositories: number;
  reusedMetadata: number;
  warnings: number;
}>;

export type SyncResult = Readonly<{
  snapshotId: SnapshotId;
  counts: SyncCounts;
  warnings: readonly string[];
  rateLimit: RateLimitState | null;
  durationMs: number;
}>;

const LIST_UNAVAILABLE_WARNING =
  "GitHub User Lists are unavailable; synchronized Stars only";

type JsonRecord = Readonly<Record<string, JsonValue>>;

function validationError(): AppError {
  return new AppError("VALIDATION_ERROR", "Sync input is invalid", {
    retryable: false,
  });
}

function invalidRuntime(reason: string): AppError {
  return new AppError("INTERNAL_ERROR", "Sync runtime returned invalid data", {
    retryable: false,
    details: { reason },
  });
}

function githubFailure(reason: string): AppError {
  return new AppError("GITHUB_UNAVAILABLE", "GitHub synchronization failed", {
    retryable: true,
    details: { reason },
  });
}

function storageFailure(reason: string): AppError {
  return new AppError("STORAGE_ERROR", "Snapshot storage failed", {
    retryable: false,
    details: { reason },
  });
}

function fixedAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signalAborted(signal)) throw fixedAbortError();
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function jsonRecord(value: JsonValue): JsonRecord {
  if (value === null || typeof value !== "object" || isJsonArray(value)) {
    throw validationError();
  }
  return value;
}

function field(record: JsonRecord, key: string): JsonValue {
  const value = record[key];
  if (value === undefined) throw validationError();
  return value;
}

function parseInput(input: SyncInput): SyncInput {
  let clone: JsonValue;
  try {
    clone = canonicalJsonClone(input);
  } catch {
    throw validationError();
  }
  const root = jsonRecord(clone);
  const keys = Object.keys(root);
  if (
    keys.length !== 3 ||
    keys.some(
      (key) =>
        key !== "mode" &&
        key !== "includeLists" &&
        key !== "metadataMaxAgeHours",
    ) ||
    (root.mode !== "full" && root.mode !== "incremental") ||
    typeof root.includeLists !== "boolean" ||
    typeof root.metadataMaxAgeHours !== "number" ||
    !Number.isSafeInteger(root.metadataMaxAgeHours) ||
    root.metadataMaxAgeHours < 0 ||
    root.metadataMaxAgeHours > 8_760
  ) {
    throw validationError();
  }
  return Object.freeze({
    mode: root.mode,
    includeLists: root.includeLists,
    metadataMaxAgeHours: root.metadataMaxAgeHours,
  });
}

function stableText(value: JsonValue, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    throw githubFailure("invalid_identity");
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit <= 0x1f ||
      codeUnit === 0x7f ||
      (codeUnit >= 0xd800 && codeUnit <= 0xdfff)
    ) {
      throw githubFailure("invalid_identity");
    }
  }
  return value;
}

function binding(value: AccountBinding): AccountBinding {
  let clone: JsonValue;
  try {
    clone = canonicalJsonClone(value);
  } catch {
    throw githubFailure("invalid_identity");
  }
  const root = jsonRecord(clone);
  const keys = Object.keys(root);
  if (
    keys.length !== 3 ||
    keys.some(
      (key) => key !== "host" && key !== "login" && key !== "accountId",
    ) ||
    root.host !== "github.com"
  ) {
    throw githubFailure("invalid_identity");
  }
  return Object.freeze({
    host: "github.com",
    login: stableText(field(root, "login"), 100),
    accountId: stableText(field(root, "accountId"), 128),
  });
}

function capabilityState(
  value: JsonValue,
): "available" | "unavailable" | "unknown" {
  if (value !== "available" && value !== "unavailable" && value !== "unknown") {
    throw githubFailure("invalid_capabilities");
  }
  return value;
}

function capabilities(value: GitHubCapabilities): GitHubCapabilities {
  let clone: JsonValue;
  try {
    clone = canonicalJsonClone(value);
  } catch {
    throw githubFailure("invalid_capabilities");
  }
  const root = jsonRecord(clone);
  const keys = Object.keys(root);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        key !== "starRead" &&
        key !== "starWrite" &&
        key !== "listRead" &&
        key !== "listWrite",
    )
  ) {
    throw githubFailure("invalid_capabilities");
  }
  return Object.freeze({
    starRead: capabilityState(field(root, "starRead")),
    starWrite: capabilityState(field(root, "starWrite")),
    listRead: capabilityState(field(root, "listRead")),
    listWrite: capabilityState(field(root, "listWrite")),
  });
}

function unavailableCapability(
  capability: "Star" | "List",
  retryable: boolean,
): AppError {
  return new AppError(
    "CAPABILITY_UNAVAILABLE",
    `${capability} read capability is unavailable`,
    {
      retryable,
      details: {
        reason:
          capability === "Star"
            ? "star_read_unavailable"
            : "list_read_unavailable",
      },
    },
  );
}

function safeNow(runtime: Clock): string {
  try {
    return canonicalUtcTimestamp(runtime.now(), "snapshot time");
  } catch {
    throw invalidRuntime("invalid_wall_clock");
  }
}

function monotonic(runtime: Clock): number {
  let value: number;
  try {
    value = runtime.monotonicMs();
  } catch {
    throw invalidRuntime("invalid_monotonic_clock");
  }
  if (!Number.isFinite(value) || value < 0) {
    throw invalidRuntime("invalid_monotonic_clock");
  }
  return value;
}

function duration(runtime: Clock, start: number): number {
  const end = monotonic(runtime);
  const elapsed = end - start;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw invalidRuntime("invalid_monotonic_clock");
  }
  return Math.floor(elapsed);
}

function requestId(runtime: IdGenerator): string {
  let value: string;
  try {
    value = runtime.requestId();
  } catch {
    throw invalidRuntime("invalid_request_id");
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw invalidRuntime("invalid_request_id");
  }
  return value;
}

function snapshotId(runtime: IdGenerator): SnapshotId {
  try {
    return asSnapshotId(runtime.snapshotId());
  } catch {
    throw invalidRuntime("invalid_snapshot_id");
  }
}

function rateLimit(reader: RateStateReader): RateLimitState | null {
  let clone: JsonValue;
  try {
    clone = canonicalJsonClone(reader.getState());
  } catch {
    throw githubFailure("invalid_rate_state");
  }
  if (clone === null) return null;
  const root = jsonRecord(clone);
  const keys = Object.keys(root);
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "remaining" && key !== "resetAt") ||
    typeof root.remaining !== "number" ||
    !Number.isSafeInteger(root.remaining) ||
    root.remaining < 0
  ) {
    throw githubFailure("invalid_rate_state");
  }
  let resetAt: string;
  try {
    resetAt = canonicalUtcTimestamp(root.resetAt, "rate limit resetAt");
  } catch {
    throw githubFailure("invalid_rate_state");
  }
  return Object.freeze({ remaining: root.remaining, resetAt });
}

const EMPTY = Object.freeze([]) as readonly never[];
const PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 4_096;

type CollectionKind = "star" | "list" | "membership";

type MutableCounts = {
  repositories: number;
  stars: number;
  lists: number;
  memberships: number;
  refreshedRepositories: number;
  reusedMetadata: number;
};

type ParsedPage<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;

function collectionChanged(): AppError {
  return new AppError(
    "PRECONDITION_FAILED",
    "GitHub collection changed during synchronization",
    {
      retryable: false,
      details: { reason: "collection_changed" },
    },
  );
}

function collectionUnstable(): AppError {
  return new AppError(
    "GITHUB_UNAVAILABLE",
    "GitHub collection did not stabilize",
    {
      retryable: true,
      details: { reason: "collection_unstable" },
    },
  );
}

function listCapabilityFailure(reason: string): AppError {
  return new AppError(
    "CAPABILITY_UNAVAILABLE",
    "GitHub User Lists could not be synchronized safely",
    {
      retryable: false,
      details: { reason },
    },
  );
}

function isCollectionChanged(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "PRECONDITION_FAILED" &&
    error.details !== null &&
    typeof error.details === "object" &&
    !isJsonArray(error.details) &&
    error.details.reason === "collection_changed"
  );
}

function safeIncrement(
  counts: MutableCounts,
  key: keyof MutableCounts,
  amount: number,
): void {
  const next = counts[key] + amount;
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(next) ||
    next < counts[key]
  ) {
    throw githubFailure("collection_too_large");
  }
  counts[key] = next;
}

function parsePage<T>(value: Page<T>, kind: CollectionKind): ParsedPage<T> {
  try {
    if (value === null || typeof value !== "object") {
      throw githubFailure("invalid_page");
    }
    const items = value.items;
    if (!Array.isArray(items) || items.length > PAGE_SIZE) {
      throw githubFailure("invalid_page");
    }
    for (let index = 0; index < items.length; index += 1) {
      if (!Object.hasOwn(items, index)) {
        throw githubFailure("invalid_page");
      }
    }
    const warnings = value.warnings;
    if (!Array.isArray(warnings)) {
      throw githubFailure("invalid_page");
    }
    if (warnings.length > 0) {
      if (kind === "list" || kind === "membership") {
        throw listCapabilityFailure("unexpected_list_warning");
      }
      throw githubFailure("unexpected_star_warning");
    }
    const nextCursor = value.nextCursor;
    if (
      nextCursor !== null &&
      (typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        nextCursor.length > MAX_CURSOR_LENGTH ||
        nextCursor !== nextCursor.trim())
    ) {
      throw githubFailure("invalid_page");
    }
    return Object.freeze({ items, nextCursor });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw githubFailure("invalid_page");
  }
}

function repositoryId(value: GitHubStar | GitHubListItem): RepositoryId {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      !("repository" in value) ||
      value.repository === null ||
      typeof value.repository !== "object" ||
      typeof value.repository.repositoryId !== "string"
    ) {
      throw new Error("invalid repository identity");
    }
    return asRepositoryId(value.repository.repositoryId);
  } catch {
    throw githubFailure("invalid_repository_identity");
  }
}

function listId(value: GitHubUserList): UserListId {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.listId !== "string"
    ) {
      throw new Error("invalid List identity");
    }
    return asUserListId(value.listId);
  } catch {
    throw githubFailure("invalid_list_identity");
  }
}

function nextCursor(
  current: string | null,
  next: string | null,
  seen: Set<string>,
): string | null {
  if (next !== null && (next === current || seen.has(next))) {
    throw collectionChanged();
  }
  if (next !== null) seen.add(next);
  return next;
}

function observationFor(
  remote: GitHubStar,
  startedAt: string,
  input: SyncInput,
  storage: StoragePort,
): Readonly<{
  observation: ObservedRepositoryMetadata;
  reused: boolean;
}> {
  const id = repositoryId(remote);
  if (input.mode === "incremental") {
    let stored: ObservedRepositoryMetadata | null;
    try {
      stored = storage.getRepositoryMetadata(id);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storageFailure("snapshot_storage_failure");
    }
    if (stored !== null) {
      try {
        const parsed = observedRepositoryMetadataSchema.parse(stored);
        const started = Date.parse(startedAt);
        const observed = Date.parse(parsed.observedAt);
        const maximumAge = input.metadataMaxAgeHours * 60 * 60_000;
        const age = started - observed;
        if (
          parsed.repository.repositoryId === id &&
          Number.isFinite(age) &&
          age >= 0 &&
          age <= maximumAge
        ) {
          return Object.freeze({ observation: parsed, reused: true });
        }
      } catch {
        // Invalid local metadata is safely refreshed from the remote Star.
      }
    }
  }
  return Object.freeze({
    observation: Object.freeze({
      repository: remote.repository,
      observedAt: startedAt,
    }),
    reused: false,
  });
}

function snapshotCounts(counts: MutableCounts): SnapshotCounts {
  return Object.freeze({
    repositories: counts.repositories,
    stars: counts.stars,
    lists: counts.lists,
    memberships: counts.memberships,
  });
}

function publicCounts(counts: MutableCounts, warningCount: number): SyncCounts {
  return Object.freeze({
    ...snapshotCounts(counts),
    refreshedRepositories: counts.refreshedRepositories,
    reusedMetadata: counts.reusedMetadata,
    warnings: warningCount,
  });
}

function sanitizeCollectionError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return fixedAbortError();
  }
  return githubFailure("collection_failed");
}

function storageCall<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageFailure("snapshot_storage_failure");
  }
}

type AttemptContext = Readonly<{
  github: GitHubSyncReadPort;
  storage: StoragePort;
  scope: LeaseScope;
  id: SnapshotId;
  startedAt: string;
  input: SyncInput;
  counts: MutableCounts;
}>;

async function remotePage<T>(
  scope: LeaseScope,
  kind: CollectionKind,
  read: (signal: AbortSignal) => Promise<Page<T>>,
): Promise<ParsedPage<T>> {
  scope.assertActive();
  try {
    const page = await read(scope.signal);
    scope.assertActive();
    return parsePage(page, kind);
  } catch (error) {
    scope.assertActive();
    if (error instanceof AppError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw fixedAbortError();
    }
    throw githubFailure("collection_read_failed");
  }
}

function appendSnapshot(context: AttemptContext, batch: SnapshotBatch): void {
  if (
    batch.repositories.length === 0 &&
    batch.stars.length === 0 &&
    batch.lists.length === 0 &&
    batch.memberships.length === 0
  ) {
    return;
  }
  context.scope.assertActive();
  storageCall(() =>
    context.storage.appendSnapshotBatch({
      id: context.id,
      batch,
      lease: context.scope.freshGuard(),
    }),
  );
}

function appendVerification(
  context: AttemptContext,
  batch: SnapshotVerificationBatch,
): void {
  if (
    batch.stars.length === 0 &&
    batch.lists.length === 0 &&
    batch.memberships.length === 0
  ) {
    return;
  }
  context.scope.assertActive();
  storageCall(() =>
    context.storage.appendSnapshotVerificationBatch({
      id: context.id,
      batch,
      lease: context.scope.freshGuard(),
    }),
  );
}

function starRecord(star: GitHubStar, id: RepositoryId): StarRecord {
  try {
    return Object.freeze({
      repositoryId: id,
      starredAt: canonicalUtcTimestamp(star.starredAt, "Star time"),
    });
  } catch {
    throw githubFailure("invalid_star_record");
  }
}

async function collectStars(
  context: AttemptContext,
  verification: boolean,
): Promise<void> {
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await remotePage(context.scope, "star", (activeSignal) =>
      context.github.listStarredRepositories(cursor, activeSignal),
    );
    const stars: StarRecord[] = [];
    const repositories: ObservedRepositoryMetadata[] = [];
    let refreshed = 0;
    let reused = 0;
    for (const star of page.items) {
      context.scope.assertActive();
      const id = repositoryId(star);
      if (seenIds.has(id)) throw collectionChanged();
      seenIds.add(id);
      stars.push(starRecord(star, id));
      if (!verification) {
        const selected = observationFor(
          star,
          context.startedAt,
          context.input,
          context.storage,
        );
        repositories.push(selected.observation);
        if (selected.reused) {
          reused += 1;
        } else {
          refreshed += 1;
        }
      }
    }
    if (verification) {
      appendVerification(context, {
        stars: Object.freeze(stars),
        lists: EMPTY,
        memberships: EMPTY,
      });
    } else {
      appendSnapshot(context, {
        repositories: Object.freeze(repositories),
        stars: Object.freeze(stars),
        lists: EMPTY,
        memberships: EMPTY,
      });
      safeIncrement(context.counts, "repositories", stars.length);
      safeIncrement(context.counts, "stars", stars.length);
      safeIncrement(context.counts, "refreshedRepositories", refreshed);
      safeIncrement(context.counts, "reusedMetadata", reused);
    }
    cursor = nextCursor(cursor, page.nextCursor, seenCursors);
    if (cursor === null) return;
  }
}

async function collectListMetadata(
  context: AttemptContext,
  verification: boolean,
): Promise<ReadonlySet<UserListId>> {
  const seenIds = new Set<UserListId>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await remotePage(context.scope, "list", (activeSignal) =>
      context.github.listUserLists(cursor, activeSignal),
    );
    const lists: GitHubUserList[] = [];
    for (const list of page.items) {
      const id = listId(list);
      if (seenIds.has(id)) throw collectionChanged();
      seenIds.add(id);
      lists.push(list);
    }
    if (verification) {
      appendVerification(context, {
        stars: EMPTY,
        lists: Object.freeze(lists),
        memberships: EMPTY,
      });
    } else {
      appendSnapshot(context, {
        repositories: EMPTY,
        stars: EMPTY,
        lists: Object.freeze(lists),
        memberships: EMPTY,
      });
      safeIncrement(context.counts, "lists", lists.length);
    }
    cursor = nextCursor(cursor, page.nextCursor, seenCursors);
    if (cursor === null) return seenIds;
  }
}

async function collectMemberships(
  context: AttemptContext,
  list: UserListId,
  verification: boolean,
): Promise<void> {
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    let page: ParsedPage<GitHubListItem>;
    try {
      page = await remotePage(context.scope, "membership", (activeSignal) =>
        context.github.listUserListItems(list, cursor, activeSignal),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        throw collectionChanged();
      }
      throw error;
    }
    const memberships: ListMembership[] = [];
    for (const item of page.items) {
      if (
        item === null ||
        typeof item !== "object" ||
        item.kind !== "repository"
      ) {
        throw listCapabilityFailure("unsupported_list_item");
      }
      const id = repositoryId(item);
      if (seenIds.has(id)) throw collectionChanged();
      seenIds.add(id);
      memberships.push(Object.freeze({ listId: list, repositoryId: id }));
    }
    if (verification) {
      appendVerification(context, {
        stars: EMPTY,
        lists: EMPTY,
        memberships: Object.freeze(memberships),
      });
    } else {
      appendSnapshot(context, {
        repositories: EMPTY,
        stars: EMPTY,
        lists: EMPTY,
        memberships: Object.freeze(memberships),
      });
      safeIncrement(context.counts, "memberships", memberships.length);
    }
    cursor = nextCursor(cursor, page.nextCursor, seenCursors);
    if (cursor === null) return;
  }
}

async function collectLists(
  context: AttemptContext,
  verification: boolean,
): Promise<void> {
  const listIds = await collectListMetadata(context, verification);
  for (const id of listIds) {
    await collectMemberships(context, id, verification);
  }
}

export class SyncService {
  readonly #github: GitHubSyncReadPort;
  readonly #storage: StoragePort;
  readonly #runtime: Clock & IdGenerator;
  readonly #rateStateReader: RateStateReader;
  readonly #leaseScheduler: LeaseScheduler | undefined;

  constructor(
    github: GitHubSyncReadPort,
    storage: StoragePort,
    runtime: Clock & IdGenerator,
    rateStateReader: RateStateReader,
    leaseScheduler?: LeaseScheduler,
  ) {
    this.#github = github;
    this.#storage = storage;
    this.#runtime = runtime;
    this.#rateStateReader = rateStateReader;
    this.#leaseScheduler = leaseScheduler;
  }

  async sync(input: SyncInput, signal?: AbortSignal): Promise<SyncResult> {
    const parsedInput = parseInput(input);
    assertNotAborted(signal);
    const start = monotonic(this.#runtime);

    let verifiedBinding: AccountBinding;
    let capabilityState: GitHubCapabilities;
    try {
      const viewer = await this.#github.getViewer(signal);
      assertNotAborted(signal);
      verifiedBinding = binding(viewer);
      const probed = await this.#github.probeCapabilities(signal);
      assertNotAborted(signal);
      capabilityState = capabilities(probed);
    } catch (error) {
      assertNotAborted(signal);
      if (error instanceof AppError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw fixedAbortError();
      }
      throw githubFailure("admission_failed");
    }

    if (capabilityState.starRead !== "available") {
      throw unavailableCapability(
        "Star",
        capabilityState.starRead === "unknown",
      );
    }
    if (parsedInput.includeLists && capabilityState.listRead === "unknown") {
      throw unavailableCapability("List", true);
    }
    assertNotAborted(signal);

    const requestedListsUnavailable =
      parsedInput.includeLists && capabilityState.listRead === "unavailable";
    const warnings = Object.freeze(
      requestedListsUnavailable ? [LIST_UNAVAILABLE_WARNING] : [],
    );
    const finalCoverage: Exclude<ListCoverage, "collecting"> =
      parsedInput.includeLists
        ? requestedListsUnavailable
          ? "unavailable"
          : "complete"
        : "omitted";
    const draftCoverage: Exclude<ListCoverage, "complete"> =
      finalCoverage === "complete" ? "collecting" : finalCoverage;
    const leaseName = `sync:${verifiedBinding.host}:${sha256Hex(
      verifiedBinding.accountId,
    ).slice(0, 16)}`;
    const scope = LeaseScope.acquire({
      storage: this.#storage,
      runtime: this.#runtime,
      name: leaseName,
      ownerId: `sync:${requestId(this.#runtime)}`,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#leaseScheduler === undefined
        ? {}
        : { scheduler: this.#leaseScheduler }),
    });

    return scope.run(async (active) => {
      active.assertActive();
      storageCall(() =>
        this.#storage.recoverAbandonedSnapshots({
          binding: verifiedBinding,
          lease: active.freshGuard(),
        }),
      );
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const id = snapshotId(this.#runtime);
        const startedAt = safeNow(this.#runtime);
        const draft: SnapshotDraft = Object.freeze({
          id,
          binding: verifiedBinding,
          mode: parsedInput.mode,
          listCoverage: draftCoverage,
          startedAt,
        });
        const counts: MutableCounts = {
          repositories: 0,
          stars: 0,
          lists: 0,
          memberships: 0,
          refreshedRepositories: 0,
          reusedMetadata: 0,
        };
        const context: AttemptContext = Object.freeze({
          github: this.#github,
          storage: this.#storage,
          scope: active,
          id,
          startedAt,
          input: parsedInput,
          counts,
        });
        let created = false;
        try {
          active.assertActive();
          storageCall(() =>
            this.#storage.createSnapshot({
              draft,
              lease: active.freshGuard(),
            }),
          );
          created = true;

          await collectStars(context, false);
          if (finalCoverage === "complete") {
            await collectLists(context, false);
          }

          active.assertActive();
          storageCall(() =>
            this.#storage.beginSnapshotVerification({
              id,
              listCoverage: finalCoverage,
              lease: active.freshGuard(),
            }),
          );

          if (finalCoverage === "complete") {
            await collectLists(context, true);
          }
          await collectStars(context, true);

          active.assertActive();
          storageCall(() =>
            this.#storage.finishSnapshotVerification({
              id,
              lease: active.freshGuard(),
            }),
          );
          const finalRate = rateLimit(this.#rateStateReader);
          const durationMs = duration(this.#runtime, start);
          const finalCounts = publicCounts(counts, warnings.length);
          active.assertActive();
          storageCall(() =>
            this.#storage.completeSnapshot({
              id,
              completedAt: safeNow(this.#runtime),
              listCoverage: finalCoverage,
              counts: snapshotCounts(counts),
              warningCount: warnings.length,
              sourceRateLimit: finalRate,
              lease: active.freshGuard(),
            }),
          );
          return Object.freeze({
            snapshotId: id,
            counts: finalCounts,
            warnings,
            rateLimit: finalRate,
            durationMs,
          });
        } catch (error) {
          const primary = sanitizeCollectionError(error);
          if (created) {
            let guard;
            try {
              guard = active.tryFreshGuard();
            } catch (cleanup) {
              appendCleanupDiagnostic(primary, cleanup);
              throw primary;
            }
            if (guard === null) {
              active.assertActive();
              throw primary;
            }
            try {
              storageCall(() =>
                this.#storage.failSnapshot({
                  id,
                  failedAt: safeNow(this.#runtime),
                  sourceRateLimit: rateLimit(this.#rateStateReader),
                  lease: guard,
                }),
              );
            } catch (cleanup) {
              appendCleanupDiagnostic(primary, cleanup);
              throw primary;
            }
          }
          if (isCollectionChanged(primary)) {
            if (attempt < 3) continue;
            throw collectionUnstable();
          }
          throw primary;
        }
      }
      throw invalidRuntime("consistency_attempt_limit");
    });
  }
}
