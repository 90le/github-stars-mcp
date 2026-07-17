import type Database from "better-sqlite3";
import type {
  CompleteSnapshotInput,
  FailSnapshotInput,
  LeaseGuard,
} from "../app/ports/storage-port.js";
import {
  canonicalJson,
  canonicalJsonClone,
  sha256Hex,
} from "../domain/canonical-json.js";
import {
  hashFilter,
  type CursorCodec,
  type ListMembershipCursorContext,
  type ValidatedRepositoryCursorPayload,
} from "../domain/cursor.js";
import { AppError } from "../domain/errors.js";
import {
  filterRequiresListCoverage,
  parseListMembershipQuery,
  parseListMembershipQueryPage,
  parseListQuery,
  parseListQueryPage,
  parseRepositoryQuery,
  parseRepositoryQueryPage,
  repositoryCursorPosition,
  type ListMembershipQuery,
  type ListMembershipQueryPage,
  type ListQuery,
  type ListQueryPage,
  type ListSummary,
  type RepositoryQuery,
  type RepositoryQueryPage,
} from "../domain/filter.js";
import {
  asRepositoryId,
  asSnapshotId,
  asUserListId,
  type RepositoryId,
  type SnapshotId,
  type UserListId,
} from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import {
  observedRepositoryMetadataSchema,
  repositorySchema,
  repositoryViewSchema,
  type AccountBinding,
  type ObservedRepositoryMetadata,
  type Repository,
  type RepositoryView,
  type UserList,
} from "../domain/repository.js";
import {
  parseSnapshot,
  parseSnapshotBatch,
  parseSnapshotCounts,
  parseSnapshotDraft,
  parseSnapshotVerificationBatch,
  type ListCoverage,
  type Snapshot,
  type SnapshotBatch,
  type SnapshotCounts,
  type SnapshotDraft,
  type SnapshotVerificationBatch,
} from "../domain/snapshot.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import {
  compileCursor,
  compileFilter,
  compileOrder,
  type SqlFragment,
} from "./filter-sql.js";
import { LeaseRepository } from "./lease-repository.js";
import { runInImmediateTransaction } from "./sqlite-transaction.js";

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly host: string;
  readonly login: string;
  readonly account_id: string;
  readonly mode: "full" | "incremental";
  readonly status: "building" | "complete" | "failed";
  readonly list_coverage: ListCoverage;
  readonly lease_name: string;
  readonly lease_owner_id: string;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly failed_at: string | null;
  readonly repositories_count: number;
  readonly stars_count: number;
  readonly lists_count: number;
  readonly memberships_count: number;
  readonly warning_count: number;
  readonly source_rate_limit_json: string | null;
}

interface RepositoryRow {
  readonly repository_id: string;
  readonly repository_database_id: string;
  readonly owner: string;
  readonly name: string;
  readonly full_name: string;
  readonly description: string | null;
  readonly url: string;
  readonly stargazer_count: number;
  readonly is_fork: number;
  readonly is_archived: number;
  readonly is_disabled: number;
  readonly is_private: number;
  readonly visibility: "public" | "private" | "internal";
  readonly primary_language: string | null;
  readonly topics_json: string;
  readonly license_spdx_id: string | null;
  readonly pushed_at: string | null;
  readonly updated_at: string;
  readonly starred_at?: string;
  readonly observed_at?: string;
}

interface ListRow {
  readonly list_id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly is_private: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_added_at: string | null;
  readonly repository_count?: number;
}

interface CountRow {
  readonly value: number;
}

const SNAPSHOT_COLUMNS = `
  snapshot_id,host,login,account_id,mode,status,list_coverage,
  lease_name,lease_owner_id,started_at,completed_at,failed_at,
  repositories_count,stars_count,lists_count,memberships_count,
  warning_count,source_rate_limit_json
`;

const REPOSITORY_COLUMNS = `
  rv.repository_id,r.repository_database_id,rv.owner,rv.name,rv.full_name,
  rv.description,rv.url,rv.stargazer_count,rv.is_fork,rv.is_archived,
  rv.is_disabled,rv.is_private,rv.visibility,rv.primary_language,
  rv.topics_json,rv.license_spdx_id,rv.pushed_at,rv.updated_at
`;

function parseJson(text: string): JsonValue {
  return canonicalJsonClone(JSON.parse(text));
}

function snapshotFromRow(row: SnapshotRow): Snapshot {
  return parseSnapshot({
    id: row.snapshot_id,
    binding: {
      host: row.host,
      login: row.login,
      accountId: row.account_id,
    },
    mode: row.mode,
    listCoverage: row.list_coverage,
    startedAt: row.started_at,
    status: row.status,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    counts: {
      repositories: row.repositories_count,
      stars: row.stars_count,
      lists: row.lists_count,
      memberships: row.memberships_count,
    },
    warningCount: row.warning_count,
    sourceRateLimit:
      row.source_rate_limit_json === null
        ? null
        : parseJson(row.source_rate_limit_json),
  });
}

function repositoryFromRow(row: RepositoryRow): Repository {
  return repositorySchema.parse({
    repositoryId: row.repository_id,
    repositoryDatabaseId: row.repository_database_id,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    description: row.description,
    url: row.url,
    stargazerCount: row.stargazer_count,
    isFork: row.is_fork === 1,
    isArchived: row.is_archived === 1,
    isDisabled: row.is_disabled === 1,
    isPrivate: row.is_private === 1,
    visibility: row.visibility,
    primaryLanguage: row.primary_language,
    topics: parseJson(row.topics_json),
    licenseSpdxId: row.license_spdx_id,
    pushedAt: row.pushed_at,
    updatedAt: row.updated_at,
  });
}

function repositoryViewFromRow(row: RepositoryRow): RepositoryView {
  return repositoryViewSchema.parse({
    ...repositoryFromRow(row),
    starredAt: row.starred_at,
  });
}

function listFromRow(row: ListRow): UserList {
  return Object.freeze({
    listId: asUserListId(row.list_id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    isPrivate: row.is_private === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAddedAt: row.last_added_at,
  });
}

function listSummaryFromRow(row: ListRow): ListSummary {
  return Object.freeze({
    ...listFromRow(row),
    repositoryCount: row.repository_count ?? 0,
  });
}

function constraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("constraint") ||
      error.message.includes("UNIQUE") ||
      error.message.includes("FOREIGN KEY"))
  );
}

function precondition(message: string, reason?: string): never {
  throw new AppError("PRECONDITION_FAILED", message, {
    ...(reason === undefined ? {} : { details: { reason } }),
  });
}

function completeNotFound(): never {
  throw new AppError("NOT_FOUND", "complete snapshot was not found");
}

function capability(): never {
  throw new AppError(
    "CAPABILITY_UNAVAILABLE",
    "this snapshot does not have complete List coverage",
  );
}

function exactObject(
  input: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, JsonValue>> {
  const cloned = canonicalJsonClone(input);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new AppError("VALIDATION_ERROR", `${label} must be an object`);
  }
  const actual = Object.keys(cloned);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} contains unsupported properties`,
    );
  }
  return cloned as Readonly<Record<string, JsonValue>>;
}

function stableText(value: JsonValue | undefined, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new AppError("VALIDATION_ERROR", `${label} must be stable text`);
  }
  return value;
}

function parsedGuard(input: unknown): LeaseGuard {
  const root = exactObject(
    input,
    ["name", "ownerId", "now"],
    "snapshot lease guard",
  );
  return Object.freeze({
    name: stableText(root.name, "lease name"),
    ownerId: stableText(root.ownerId, "lease owner"),
    now: canonicalUtcTimestamp(root.now, "lease guard now"),
  });
}

function finalCoverage(
  value: JsonValue | undefined,
): Exclude<ListCoverage, "collecting"> {
  if (value !== "complete" && value !== "unavailable" && value !== "omitted") {
    throw new AppError("VALIDATION_ERROR", "final List coverage is invalid");
  }
  return value;
}

function stableBinding(input: unknown): AccountBinding {
  const root = exactObject(
    input,
    ["host", "login", "accountId"],
    "account binding",
  );
  const host = stableText(root.host, "account host");
  const login = stableText(root.login, "account login");
  const accountId = stableText(root.accountId, "account ID");
  if (host !== "github.com") {
    throw new AppError("VALIDATION_ERROR", "account binding is invalid");
  }
  return Object.freeze({ host, login, accountId });
}

export class SnapshotRepository {
  readonly #database: Database.Database;
  readonly #codec: CursorCodec;
  readonly #leases: LeaseRepository;

  constructor(database: Database.Database, cursorCodec: CursorCodec) {
    this.#database = database;
    this.#codec = cursorCodec;
    this.#leases = new LeaseRepository(database);
  }

  #write<T>(operation: () => T): T {
    return runInImmediateTransaction(this.#database, operation);
  }

  #snapshotRow(id: SnapshotId | string): SnapshotRow | undefined {
    return this.#database
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE snapshot_id=?`)
      .get(id) as SnapshotRow | undefined;
  }

  #assertMutation(id: SnapshotId, guard: LeaseGuard): SnapshotRow {
    const row = this.#snapshotRow(id);
    if (row === undefined) {
      throw new AppError("NOT_FOUND", "snapshot was not found");
    }
    if (row.status !== "building") {
      return precondition("snapshot is not building");
    }
    const lease = this.#leases.assertLease(guard);
    if (row.lease_name !== lease.name || row.lease_owner_id !== lease.ownerId) {
      return precondition("snapshot lease binding does not match");
    }
    return row;
  }

  #requireComplete(id: SnapshotId): SnapshotRow {
    const row = this.#snapshotRow(id);
    if (row === undefined || row.status !== "complete") {
      return completeNotFound();
    }
    return row;
  }

  #counts(id: SnapshotId): SnapshotCounts {
    const count = (table: string): number =>
      (
        this.#database
          .prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE snapshot_id=?`)
          .get(id) as CountRow
      ).value;
    return Object.freeze({
      repositories: count("snapshot_repositories"),
      stars: count("snapshot_star_staging"),
      lists: count("user_lists"),
      memberships: count("list_membership_staging"),
    });
  }

  #saveRepository(
    snapshotId: SnapshotId,
    observation: ObservedRepositoryMetadata,
  ): void {
    const repository = observation.repository;
    const versionHash = sha256Hex(canonicalJson(repository));
    const existingIdentity = this.#database
      .prepare(
        `SELECT repository_id,repository_database_id,current_version_hash,observed_at
         FROM repositories WHERE repository_id=?`,
      )
      .get(repository.repositoryId) as
      | {
          readonly repository_id: string;
          readonly repository_database_id: string;
          readonly current_version_hash: string;
          readonly observed_at: string;
        }
      | undefined;
    const databaseIdentity = this.#database
      .prepare(
        "SELECT repository_id FROM repositories WHERE repository_database_id=?",
      )
      .get(repository.repositoryDatabaseId) as
      | { readonly repository_id: string }
      | undefined;

    if (
      (existingIdentity !== undefined &&
        existingIdentity.repository_database_id !==
          repository.repositoryDatabaseId) ||
      (databaseIdentity !== undefined &&
        databaseIdentity.repository_id !== repository.repositoryId)
    ) {
      return precondition("repository node/database identity is immutable");
    }

    if (existingIdentity === undefined) {
      this.#database
        .prepare(
          `INSERT INTO repositories(
             repository_id,repository_database_id,current_version_hash,observed_at
           ) VALUES (?,?,?,?)`,
        )
        .run(
          repository.repositoryId,
          repository.repositoryDatabaseId,
          versionHash,
          observation.observedAt,
        );
    }

    const existingVersion = this.#database
      .prepare(
        `SELECT ${REPOSITORY_COLUMNS}
         FROM repository_versions rv
         JOIN repositories r ON r.repository_id=rv.repository_id
         WHERE rv.repository_id=? AND rv.version_hash=?`,
      )
      .get(repository.repositoryId, versionHash) as RepositoryRow | undefined;
    if (existingVersion === undefined) {
      this.#database
        .prepare(
          `INSERT INTO repository_versions(
             repository_id,version_hash,owner,name,full_name,description,url,
             stargazer_count,is_fork,is_archived,is_disabled,is_private,
             visibility,primary_language,topics_json,license_spdx_id,pushed_at,
             updated_at
           ) VALUES (
             @repositoryId,@versionHash,@owner,@name,@fullName,@description,@url,
             @stargazerCount,@isFork,@isArchived,@isDisabled,@isPrivate,
             @visibility,@primaryLanguage,@topicsJson,@licenseSpdxId,@pushedAt,
             @updatedAt
           )`,
        )
        .run({
          ...repository,
          versionHash,
          isFork: Number(repository.isFork),
          isArchived: Number(repository.isArchived),
          isDisabled: Number(repository.isDisabled),
          isPrivate: Number(repository.isPrivate),
          topicsJson: JSON.stringify(repository.topics),
        });
    } else if (
      canonicalJson(repositoryFromRow(existingVersion)) !==
      canonicalJson(repository)
    ) {
      return precondition("repository metadata hash collision");
    }

    const identity = existingIdentity;
    if (
      identity === undefined ||
      observation.observedAt > identity.observed_at ||
      (observation.observedAt === identity.observed_at &&
        versionHash > identity.current_version_hash)
    ) {
      this.#database
        .prepare(
          `UPDATE repositories
           SET current_version_hash=?,observed_at=?
           WHERE repository_id=?`,
        )
        .run(versionHash, observation.observedAt, repository.repositoryId);
    }
    this.#database
      .prepare(
        `INSERT INTO snapshot_repositories(
           snapshot_id,repository_id,version_hash,observed_at
         ) VALUES (?,?,?,?)`,
      )
      .run(
        snapshotId,
        repository.repositoryId,
        versionHash,
        observation.observedAt,
      );
  }

  createSnapshot(input: {
    readonly draft: SnapshotDraft;
    readonly lease: LeaseGuard;
  }): Snapshot {
    const root = exactObject(
      input,
      ["draft", "lease"],
      "create snapshot input",
    );
    const draft = parseSnapshotDraft(root.draft);
    const guard = parsedGuard(root.lease);
    return this.#write(() => {
      const lease = this.#leases.assertLease(guard);
      try {
        this.#database
          .prepare(
            `INSERT INTO accounts(host,login,account_id)
             VALUES (?,?,?)
             ON CONFLICT(host,account_id) DO NOTHING`,
          )
          .run(
            draft.binding.host,
            draft.binding.login,
            draft.binding.accountId,
          );
        const account = this.#database
          .prepare("SELECT login FROM accounts WHERE host=? AND account_id=?")
          .get(draft.binding.host, draft.binding.accountId) as
          | { readonly login: string }
          | undefined;
        if (account?.login !== draft.binding.login) {
          return precondition("account binding conflicts with stored identity");
        }
        this.#database
          .prepare(
            `INSERT INTO snapshots(
               snapshot_id,host,login,account_id,mode,status,list_coverage,
               lease_name,lease_owner_id,started_at
             ) VALUES (?,?,?,?,?,'building',?,?,?,?)`,
          )
          .run(
            draft.id,
            draft.binding.host,
            draft.binding.login,
            draft.binding.accountId,
            draft.mode,
            draft.listCoverage,
            lease.name,
            lease.ownerId,
            draft.startedAt,
          );
      } catch (error) {
        if (constraintError(error)) {
          return precondition("snapshot or account identity already exists");
        }
        throw error;
      }
      return snapshotFromRow(this.#snapshotRow(draft.id)!);
    });
  }

  appendSnapshotBatch(input: {
    readonly id: SnapshotId;
    readonly batch: SnapshotBatch;
    readonly lease: LeaseGuard;
  }): void {
    const root = exactObject(
      input,
      ["id", "batch", "lease"],
      "append snapshot batch input",
    );
    const id = asSnapshotId(stableText(root.id, "snapshot ID"));
    const batch = parseSnapshotBatch(root.batch);
    const guard = parsedGuard(root.lease);
    this.#write(() => {
      const snapshot = this.#assertMutation(id, guard);
      if (
        snapshot.list_coverage !== "collecting" &&
        (batch.lists.length > 0 || batch.memberships.length > 0)
      ) {
        return precondition(
          "snapshot without List coverage cannot accept List rows",
        );
      }
      try {
        for (const observation of batch.repositories) {
          this.#saveRepository(id, observation);
        }
        const starInsert = this.#database.prepare(
          `INSERT INTO snapshot_star_staging(snapshot_id,repository_id,starred_at)
           VALUES (?,?,?)`,
        );
        for (const star of batch.stars) {
          starInsert.run(id, star.repositoryId, star.starredAt);
        }
        const listInsert = this.#database.prepare(
          `INSERT INTO user_lists(
             snapshot_id,list_id,name,slug,description,is_private,
             created_at,updated_at,last_added_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
        );
        for (const list of batch.lists) {
          listInsert.run(
            id,
            list.listId,
            list.name,
            list.slug,
            list.description,
            Number(list.isPrivate),
            list.createdAt,
            list.updatedAt,
            list.lastAddedAt,
          );
        }
        const membershipInsert = this.#database.prepare(
          `INSERT INTO list_membership_staging(snapshot_id,list_id,repository_id)
           VALUES (?,?,?)`,
        );
        for (const membership of batch.memberships) {
          membershipInsert.run(id, membership.listId, membership.repositoryId);
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (constraintError(error)) {
          return precondition(
            "snapshot batch contains duplicate or conflicting rows",
          );
        }
        throw error;
      }
    });
  }

  beginSnapshotVerification(input: {
    readonly id: SnapshotId;
    readonly listCoverage: Exclude<ListCoverage, "collecting">;
    readonly lease: LeaseGuard;
  }): void {
    const root = exactObject(
      input,
      ["id", "listCoverage", "lease"],
      "begin snapshot verification input",
    );
    const id = asSnapshotId(stableText(root.id, "snapshot ID"));
    const listCoverage = finalCoverage(root.listCoverage);
    const guard = parsedGuard(root.lease);
    this.#write(() => {
      const snapshot = this.#assertMutation(id, guard);
      const legal =
        (snapshot.list_coverage === "collecting" &&
          listCoverage === "complete") ||
        snapshot.list_coverage === listCoverage;
      if (!legal)
        return precondition("snapshot List coverage transition is invalid");
      try {
        this.#database
          .prepare(
            `INSERT INTO snapshot_verifications(snapshot_id,status,list_coverage)
             VALUES (?,'collecting',?)`,
          )
          .run(id, listCoverage);
      } catch (error) {
        if (constraintError(error)) {
          return precondition("snapshot verification already exists");
        }
        throw error;
      }
    });
  }

  appendSnapshotVerificationBatch(input: {
    readonly id: SnapshotId;
    readonly batch: SnapshotVerificationBatch;
    readonly lease: LeaseGuard;
  }): void {
    const root = exactObject(
      input,
      ["id", "batch", "lease"],
      "append snapshot verification batch input",
    );
    const id = asSnapshotId(stableText(root.id, "snapshot ID"));
    const batch = parseSnapshotVerificationBatch(root.batch);
    const guard = parsedGuard(root.lease);
    this.#write(() => {
      this.#assertMutation(id, guard);
      const marker = this.#database
        .prepare(
          `SELECT status,list_coverage FROM snapshot_verifications
           WHERE snapshot_id=?`,
        )
        .get(id) as
        | {
            readonly status: "collecting" | "verified";
            readonly list_coverage: Exclude<ListCoverage, "collecting">;
          }
        | undefined;
      if (marker?.status !== "collecting") {
        return precondition("snapshot verification is not collecting");
      }
      if (
        marker.list_coverage !== "complete" &&
        (batch.lists.length > 0 || batch.memberships.length > 0)
      ) {
        return precondition(
          "verification without List coverage cannot contain List rows",
        );
      }
      try {
        const starInsert = this.#database.prepare(
          `INSERT INTO snapshot_verification_stars(
             snapshot_id,repository_id,starred_at
           ) VALUES (?,?,?)`,
        );
        for (const star of batch.stars) {
          starInsert.run(id, star.repositoryId, star.starredAt);
        }
        const listInsert = this.#database.prepare(
          `INSERT INTO snapshot_verification_lists(
             snapshot_id,list_id,name,slug,description,is_private,
             created_at,updated_at,last_added_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
        );
        for (const list of batch.lists) {
          listInsert.run(
            id,
            list.listId,
            list.name,
            list.slug,
            list.description,
            Number(list.isPrivate),
            list.createdAt,
            list.updatedAt,
            list.lastAddedAt,
          );
        }
        const membershipInsert = this.#database.prepare(
          `INSERT INTO snapshot_verification_memberships(
             snapshot_id,list_id,repository_id
           ) VALUES (?,?,?)`,
        );
        for (const membership of batch.memberships) {
          membershipInsert.run(id, membership.listId, membership.repositoryId);
        }
      } catch (error) {
        if (constraintError(error)) {
          return precondition(
            "verification collection changed",
            "collection_changed",
          );
        }
        throw error;
      }
    });
  }

  finishSnapshotVerification(input: {
    readonly id: SnapshotId;
    readonly lease: LeaseGuard;
  }): void {
    const root = exactObject(
      input,
      ["id", "lease"],
      "finish snapshot verification input",
    );
    const id = asSnapshotId(stableText(root.id, "snapshot ID"));
    const guard = parsedGuard(root.lease);
    this.#write(() => {
      this.#assertMutation(id, guard);
      const result = this.#database
        .prepare(
          `UPDATE snapshot_verifications SET status='verified'
           WHERE snapshot_id=? AND status='collecting'`,
        )
        .run(id);
      if (result.changes !== 1) {
        return precondition("snapshot verification is not collecting");
      }
    });
  }

  #hasDifference(
    id: SnapshotId,
    left: string,
    right: string,
    columns: string,
  ): boolean {
    const row = this.#database
      .prepare(
        `SELECT EXISTS(
           SELECT ${columns} FROM ${left} WHERE snapshot_id=?
           EXCEPT
           SELECT ${columns} FROM ${right} WHERE snapshot_id=?
         ) AS value`,
      )
      .get(id, id) as CountRow;
    return row.value === 1;
  }

  completeSnapshot(input: CompleteSnapshotInput): Snapshot {
    const root = exactObject(
      input,
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
    const id = asSnapshotId(stableText(root.id, "snapshot ID"));
    const completedAt = canonicalUtcTimestamp(
      root.completedAt,
      "snapshot completedAt",
    );
    const listCoverage = finalCoverage(root.listCoverage);
    const counts = parseSnapshotCounts(root.counts);
    if (
      typeof root.warningCount !== "number" ||
      !Number.isSafeInteger(root.warningCount) ||
      root.warningCount < 0
    ) {
      throw new AppError("VALIDATION_ERROR", "warning count is invalid");
    }
    const warningCount = root.warningCount;
    const source =
      root.sourceRateLimit === null
        ? null
        : canonicalJson(root.sourceRateLimit);
    const guard = parsedGuard(root.lease);
    return this.#write(() => {
      const snapshot = this.#assertMutation(id, guard);
      if (completedAt < snapshot.started_at) {
        return precondition("snapshot completion precedes its start");
      }
      const marker = this.#database
        .prepare(
          `SELECT status,list_coverage FROM snapshot_verifications
           WHERE snapshot_id=?`,
        )
        .get(id) as
        | {
            readonly status: "collecting" | "verified";
            readonly list_coverage: Exclude<ListCoverage, "collecting">;
          }
        | undefined;
      if (
        marker?.status !== "verified" ||
        marker.list_coverage !== listCoverage
      ) {
        return precondition("snapshot verification is incomplete");
      }
      const legal =
        (snapshot.list_coverage === "collecting" &&
          listCoverage === "complete") ||
        snapshot.list_coverage === listCoverage;
      if (!legal)
        return precondition("snapshot List coverage transition is invalid");

      const actual = this.#counts(id);
      if (
        actual.repositories !== counts.repositories ||
        actual.stars !== counts.stars ||
        actual.lists !== counts.lists ||
        actual.memberships !== counts.memberships
      ) {
        return precondition(
          "snapshot counts changed during collection",
          "collection_changed",
        );
      }
      if (
        listCoverage !== "complete" &&
        (actual.lists !== 0 || actual.memberships !== 0)
      ) {
        return precondition(
          "snapshot without List coverage contains List rows",
          "collection_changed",
        );
      }

      const orphanStar = this.#database
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM snapshot_star_staging s
             LEFT JOIN snapshot_repositories r
               ON r.snapshot_id=s.snapshot_id AND r.repository_id=s.repository_id
             WHERE s.snapshot_id=? AND r.repository_id IS NULL
           ) AS value`,
        )
        .get(id) as CountRow;
      const orphanMembership = this.#database
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM list_membership_staging m
             LEFT JOIN user_lists l
               ON l.snapshot_id=m.snapshot_id AND l.list_id=m.list_id
             LEFT JOIN snapshot_star_staging s
               ON s.snapshot_id=m.snapshot_id AND s.repository_id=m.repository_id
             WHERE m.snapshot_id=?
               AND (l.list_id IS NULL OR s.repository_id IS NULL)
           ) AS value`,
        )
        .get(id) as CountRow;
      if (orphanStar.value === 1 || orphanMembership.value === 1) {
        return precondition(
          "snapshot contains unresolved staged relationships",
          "collection_changed",
        );
      }

      const changed =
        this.#hasDifference(
          id,
          "snapshot_star_staging",
          "snapshot_verification_stars",
          "repository_id,starred_at",
        ) ||
        this.#hasDifference(
          id,
          "snapshot_verification_stars",
          "snapshot_star_staging",
          "repository_id,starred_at",
        ) ||
        this.#hasDifference(
          id,
          "user_lists",
          "snapshot_verification_lists",
          "list_id,name,slug,description,is_private,created_at,updated_at,last_added_at",
        ) ||
        this.#hasDifference(
          id,
          "snapshot_verification_lists",
          "user_lists",
          "list_id,name,slug,description,is_private,created_at,updated_at,last_added_at",
        ) ||
        this.#hasDifference(
          id,
          "list_membership_staging",
          "snapshot_verification_memberships",
          "list_id,repository_id",
        ) ||
        this.#hasDifference(
          id,
          "snapshot_verification_memberships",
          "list_membership_staging",
          "list_id,repository_id",
        );
      if (changed) {
        return precondition(
          "verification collection changed",
          "collection_changed",
        );
      }

      this.#database
        .prepare(
          `INSERT INTO snapshot_stars(snapshot_id,repository_id,starred_at)
           SELECT snapshot_id,repository_id,starred_at
           FROM snapshot_star_staging WHERE snapshot_id=?`,
        )
        .run(id);
      this.#database
        .prepare(
          `INSERT INTO list_memberships(snapshot_id,list_id,repository_id)
           SELECT snapshot_id,list_id,repository_id
           FROM list_membership_staging WHERE snapshot_id=?`,
        )
        .run(id);
      const result = this.#database
        .prepare(
          `UPDATE snapshots SET
             status='complete',list_coverage=@coverage,completed_at=@completedAt,
             repositories_count=@repositories,stars_count=@stars,
             lists_count=@lists,memberships_count=@memberships,
             warning_count=@warningCount,source_rate_limit_json=@source
           WHERE snapshot_id=@id AND status='building'`,
        )
        .run({
          id,
          coverage: listCoverage,
          completedAt,
          ...counts,
          warningCount,
          source,
        });
      if (result.changes !== 1) {
        return precondition("snapshot publication lost lifecycle ownership");
      }
      this.#database
        .prepare("DELETE FROM snapshot_verifications WHERE snapshot_id=?")
        .run(id);
      this.#database
        .prepare("DELETE FROM snapshot_star_staging WHERE snapshot_id=?")
        .run(id);
      this.#database
        .prepare("DELETE FROM list_membership_staging WHERE snapshot_id=?")
        .run(id);
      return snapshotFromRow(this.#snapshotRow(id)!);
    });
  }

  failSnapshot(input: FailSnapshotInput): Snapshot {
    const root = exactObject(
      input,
      ["id", "failedAt", "sourceRateLimit", "lease"],
      "fail snapshot input",
    );
    const id = asSnapshotId(stableText(root.id, "snapshot ID"));
    const failedAt = canonicalUtcTimestamp(root.failedAt, "snapshot failedAt");
    const source =
      root.sourceRateLimit === null
        ? null
        : canonicalJson(root.sourceRateLimit);
    const guard = parsedGuard(root.lease);
    return this.#write(() => {
      const snapshot = this.#assertMutation(id, guard);
      if (failedAt < snapshot.started_at) {
        return precondition("snapshot failure precedes its start");
      }
      const counts = this.#counts(id);
      this.#database
        .prepare(
          `UPDATE snapshots SET
             status='failed',failed_at=@failedAt,
             repositories_count=@repositories,stars_count=@stars,
             lists_count=@lists,memberships_count=@memberships,
             source_rate_limit_json=@source
           WHERE snapshot_id=@id AND status='building'`,
        )
        .run({ id, failedAt, ...counts, source });
      this.#database
        .prepare("DELETE FROM snapshot_verifications WHERE snapshot_id=?")
        .run(id);
      return snapshotFromRow(this.#snapshotRow(id)!);
    });
  }

  getCompleteSnapshot(idInput: SnapshotId): Snapshot | null {
    const id = asSnapshotId(idInput);
    const row = this.#snapshotRow(id);
    return row?.status === "complete" ? snapshotFromRow(row) : null;
  }

  getLatestCompleteSnapshot(bindingInput: AccountBinding): Snapshot | null {
    const binding = stableBinding(bindingInput);
    const row = this.#database
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
         WHERE host=? AND login=? AND account_id=? AND status='complete'
         ORDER BY completed_at DESC,snapshot_id COLLATE BINARY DESC LIMIT 1`,
      )
      .get(binding.host, binding.login, binding.accountId) as
      | SnapshotRow
      | undefined;
    return row === undefined ? null : snapshotFromRow(row);
  }

  getRepositoryMetadata(
    idInput: RepositoryId,
  ): ObservedRepositoryMetadata | null {
    const id = asRepositoryId(idInput);
    const row = this.#database
      .prepare(
        `SELECT ${REPOSITORY_COLUMNS},r.observed_at
         FROM repositories r
         JOIN repository_versions rv
           ON rv.repository_id=r.repository_id
          AND rv.version_hash=r.current_version_hash
         WHERE r.repository_id=?`,
      )
      .get(id) as RepositoryRow | undefined;
    return row === undefined
      ? null
      : observedRepositoryMetadataSchema.parse({
          repository: repositoryFromRow(row),
          observedAt: row.observed_at,
        });
  }

  getSnapshotRepository(
    snapshotIdInput: SnapshotId,
    repositoryIdInput: RepositoryId,
  ): RepositoryView | null {
    const snapshotId = asSnapshotId(snapshotIdInput);
    const repositoryId = asRepositoryId(repositoryIdInput);
    const row = this.#database
      .prepare(
        `SELECT ${REPOSITORY_COLUMNS},ss.starred_at
         FROM snapshots s
         JOIN snapshot_stars ss ON ss.snapshot_id=s.snapshot_id
         JOIN snapshot_repositories sr
           ON sr.snapshot_id=ss.snapshot_id
          AND sr.repository_id=ss.repository_id
         JOIN repository_versions rv
           ON rv.repository_id=sr.repository_id
          AND rv.version_hash=sr.version_hash
         JOIN repositories r ON r.repository_id=rv.repository_id
         WHERE s.snapshot_id=? AND s.status='complete'
           AND ss.repository_id=?`,
      )
      .get(snapshotId, repositoryId) as RepositoryRow | undefined;
    return row === undefined ? null : repositoryViewFromRow(row);
  }

  getSnapshotListSummary(
    snapshotIdInput: SnapshotId,
    listIdInput: UserListId,
  ): ListSummary | null {
    const snapshotId = asSnapshotId(snapshotIdInput);
    const listId = asUserListId(listIdInput);
    const snapshot = this.#snapshotRow(snapshotId);
    if (snapshot?.status !== "complete") return null;
    if (snapshot.list_coverage !== "complete") return capability();
    const row = this.#database
      .prepare(
        `SELECT l.list_id,l.name,l.slug,l.description,l.is_private,
                l.created_at,l.updated_at,l.last_added_at,
                COUNT(m.repository_id) AS repository_count
         FROM user_lists l
         LEFT JOIN list_memberships m
           ON m.snapshot_id=l.snapshot_id AND m.list_id=l.list_id
         WHERE l.snapshot_id=? AND l.list_id=?
         GROUP BY l.snapshot_id,l.list_id`,
      )
      .get(snapshotId, listId) as ListRow | undefined;
    return row === undefined ? null : listSummaryFromRow(row);
  }

  #queryBase(filter: SqlFragment): string {
    return `
      FROM snapshot_stars ss
      JOIN snapshot_repositories sr
        ON sr.snapshot_id=ss.snapshot_id AND sr.repository_id=ss.repository_id
      JOIN repository_versions rv
        ON rv.repository_id=sr.repository_id AND rv.version_hash=sr.version_hash
      JOIN repositories r ON r.repository_id=rv.repository_id
      WHERE ss.snapshot_id=? AND (${filter.sql})
    `;
  }

  queryRepositories(input: RepositoryQuery): RepositoryQueryPage {
    const query = parseRepositoryQuery(input);
    const context = {
      kind: "repositories",
      snapshotId: query.snapshotId,
      filterHash: hashFilter(query.filter),
      sort: query.sort,
    } as const;
    const decoded: ValidatedRepositoryCursorPayload | null =
      query.cursor === null
        ? null
        : this.#codec.decodeRepository(query.cursor, context);
    const snapshot = this.#requireComplete(query.snapshotId);
    if (
      filterRequiresListCoverage(query.filter) &&
      snapshot.list_coverage !== "complete"
    ) {
      return capability();
    }
    const filter =
      query.filter === null
        ? { sql: "1 = 1", params: [] }
        : compileFilter(query.filter);
    const base = this.#queryBase(filter);
    if (decoded !== null) {
      const boundaryRow = this.#database
        .prepare(
          `SELECT ${REPOSITORY_COLUMNS},ss.starred_at
           ${base} AND ss.repository_id=?`,
        )
        .get(query.snapshotId, ...filter.params, decoded.repositoryId) as
        | RepositoryRow
        | undefined;
      if (boundaryRow === undefined) {
        throw new AppError(
          "VALIDATION_ERROR",
          "repository cursor boundary is not in this snapshot selection",
        );
      }
      const position = repositoryCursorPosition(
        repositoryViewFromRow(boundaryRow),
        query.sort,
      );
      if (
        canonicalJson(position.values) !== canonicalJson(decoded.values) ||
        canonicalJson(position.nulls) !== canonicalJson(decoded.nulls)
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          "repository cursor boundary values do not match the snapshot",
        );
      }
    }
    const cursor = compileCursor(query.sort, decoded);
    const rows = this.#database
      .prepare(
        `SELECT ${REPOSITORY_COLUMNS},ss.starred_at
         ${base} AND (${cursor.sql})
         ORDER BY ${compileOrder(query.sort)}
         LIMIT ?`,
      )
      .all(
        query.snapshotId,
        ...filter.params,
        ...cursor.params,
        query.pageSize + 1,
      ) as RepositoryRow[];
    const hasMore = rows.length > query.pageSize;
    const visible = rows.slice(0, query.pageSize).map(repositoryViewFromRow);
    const count = this.#database
      .prepare(`SELECT COUNT(*) AS value ${base}`)
      .get(query.snapshotId, ...filter.params) as CountRow;
    const aggregate = this.#database
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN rv.is_archived=1 THEN 1 ELSE 0 END),0) AS archived,
           COALESCE(SUM(CASE WHEN rv.is_fork=1 THEN 1 ELSE 0 END),0) AS forks
         ${base}`,
      )
      .get(query.snapshotId, ...filter.params) as {
      readonly archived: number;
      readonly forks: number;
    };
    const languages = this.#database
      .prepare(
        `SELECT rv.primary_language AS language,COUNT(*) AS count
         ${base}
         GROUP BY rv.primary_language
         ORDER BY CASE WHEN rv.primary_language IS NULL THEN 0 ELSE 1 END,
                  rv.primary_language COLLATE BINARY`,
      )
      .all(query.snapshotId, ...filter.params) as {
      readonly language: string | null;
      readonly count: number;
    }[];
    const last = visible.at(-1);
    return parseRepositoryQueryPage({
      items: visible,
      total: count.value,
      aggregates: {
        languages,
        archived: aggregate.archived,
        forks: aggregate.forks,
      },
      nextCursor:
        hasMore && last !== undefined
          ? this.#codec.encodeRepository(
              context,
              repositoryCursorPosition(last, query.sort),
            )
          : null,
    });
  }

  queryLists(input: ListQuery): ListQueryPage {
    const query = parseListQuery(input);
    const context = {
      v: 1,
      kind: "lists",
      snapshotId: query.snapshotId,
    } as const;
    const decoded =
      query.cursor === null
        ? null
        : this.#codec.decodeList(query.cursor, context);
    const snapshot = this.#requireComplete(query.snapshotId);
    if (snapshot.list_coverage !== "complete") return capability();
    let boundarySql = "1=1";
    const params: (string | number)[] = [query.snapshotId];
    if (decoded !== null) {
      if (
        decoded.values.length !== 1 ||
        typeof decoded.values[0] !== "string"
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          "List cursor boundary is invalid",
        );
      }
      const exists = this.#database
        .prepare(
          `SELECT 1 FROM user_lists
           WHERE snapshot_id=? AND list_id=? AND name=?`,
        )
        .get(query.snapshotId, decoded.listId, decoded.values[0]);
      if (exists === undefined) {
        throw new AppError(
          "VALIDATION_ERROR",
          "List cursor boundary is not in this snapshot",
        );
      }
      boundarySql = "(l.name COLLATE BINARY>? OR (l.name=? AND l.list_id>?))";
      params.push(decoded.values[0], decoded.values[0], decoded.listId);
    }
    params.push(query.pageSize + 1);
    const rows = this.#database
      .prepare(
        `SELECT l.list_id,l.name,l.slug,l.description,l.is_private,
                l.created_at,l.updated_at,l.last_added_at,
                COUNT(m.repository_id) AS repository_count
         FROM user_lists l
         LEFT JOIN list_memberships m
           ON m.snapshot_id=l.snapshot_id AND m.list_id=l.list_id
         WHERE l.snapshot_id=? AND ${boundarySql}
         GROUP BY l.snapshot_id,l.list_id
         ORDER BY l.name COLLATE BINARY,l.list_id
         LIMIT ?`,
      )
      .all(...params) as ListRow[];
    const hasMore = rows.length > query.pageSize;
    const items = rows.slice(0, query.pageSize).map(listSummaryFromRow);
    const total = (
      this.#database
        .prepare("SELECT COUNT(*) AS value FROM user_lists WHERE snapshot_id=?")
        .get(query.snapshotId) as CountRow
    ).value;
    const last = items.at(-1);
    return parseListQueryPage({
      coverage: "complete",
      items,
      total,
      nextCursor:
        hasMore && last !== undefined
          ? this.#codec.encodeList(context, {
              values: [last.name],
              listId: last.listId,
            })
          : null,
    });
  }

  queryListMemberships(input: ListMembershipQuery): ListMembershipQueryPage {
    const query = parseListMembershipQuery(input);
    const context = {
      v: 1,
      kind: "list_memberships",
      snapshotId: query.snapshotId,
      selector: query.selector,
    } as ListMembershipCursorContext;
    const decoded =
      query.cursor === null
        ? null
        : this.#codec.decodeListMembership(query.cursor, context);
    const snapshot = this.#requireComplete(query.snapshotId);
    if (snapshot.list_coverage !== "complete") return capability();

    if (query.selector.kind === "list") {
      let boundary: string | null = null;
      if (decoded !== null) {
        if (!("boundaryRepositoryId" in decoded)) {
          throw new AppError(
            "VALIDATION_ERROR",
            "membership cursor is invalid",
          );
        }
        boundary = decoded.boundaryRepositoryId;
        const exists = this.#database
          .prepare(
            `SELECT 1 FROM list_memberships
             WHERE snapshot_id=? AND list_id=? AND repository_id=?`,
          )
          .get(query.snapshotId, query.selector.listId, boundary);
        if (exists === undefined) {
          throw new AppError(
            "VALIDATION_ERROR",
            "membership cursor boundary was not found",
          );
        }
      }
      const rows = this.#database
        .prepare(
          `SELECT repository_id FROM list_memberships
           WHERE snapshot_id=? AND list_id=?
             AND (? IS NULL OR repository_id>?)
           ORDER BY repository_id COLLATE BINARY LIMIT ?`,
        )
        .all(
          query.snapshotId,
          query.selector.listId,
          boundary,
          boundary,
          query.pageSize + 1,
        ) as { readonly repository_id: string }[];
      const hasMore = rows.length > query.pageSize;
      const repositoryIds = rows
        .slice(0, query.pageSize)
        .map((row) => asRepositoryId(row.repository_id));
      const total = (
        this.#database
          .prepare(
            `SELECT COUNT(*) AS value FROM list_memberships
             WHERE snapshot_id=? AND list_id=?`,
          )
          .get(query.snapshotId, query.selector.listId) as CountRow
      ).value;
      const last = repositoryIds.at(-1);
      return parseListMembershipQueryPage({
        coverage: "complete",
        selector: query.selector,
        repositoryIds,
        total,
        nextCursor:
          hasMore && last !== undefined
            ? this.#codec.encodeListMembership(context, {
                selector: query.selector,
                boundaryRepositoryId: last,
              })
            : null,
      });
    }

    let boundary: string | null = null;
    if (decoded !== null) {
      if (!("boundaryListId" in decoded)) {
        throw new AppError("VALIDATION_ERROR", "membership cursor is invalid");
      }
      boundary = decoded.boundaryListId;
      const exists = this.#database
        .prepare(
          `SELECT 1 FROM list_memberships
           WHERE snapshot_id=? AND repository_id=? AND list_id=?`,
        )
        .get(query.snapshotId, query.selector.repositoryId, boundary);
      if (exists === undefined) {
        throw new AppError(
          "VALIDATION_ERROR",
          "membership cursor boundary was not found",
        );
      }
    }
    const rows = this.#database
      .prepare(
        `SELECT list_id FROM list_memberships
         WHERE snapshot_id=? AND repository_id=?
           AND (? IS NULL OR list_id>?)
         ORDER BY list_id COLLATE BINARY LIMIT ?`,
      )
      .all(
        query.snapshotId,
        query.selector.repositoryId,
        boundary,
        boundary,
        query.pageSize + 1,
      ) as { readonly list_id: string }[];
    const hasMore = rows.length > query.pageSize;
    const listIds = rows
      .slice(0, query.pageSize)
      .map((row) => asUserListId(row.list_id));
    const total = (
      this.#database
        .prepare(
          `SELECT COUNT(*) AS value FROM list_memberships
           WHERE snapshot_id=? AND repository_id=?`,
        )
        .get(query.snapshotId, query.selector.repositoryId) as CountRow
    ).value;
    const last = listIds.at(-1);
    return parseListMembershipQueryPage({
      coverage: "complete",
      selector: query.selector,
      listIds,
      total,
      nextCursor:
        hasMore && last !== undefined
          ? this.#codec.encodeListMembership(context, {
              selector: query.selector,
              boundaryListId: last,
            })
          : null,
    });
  }

  hasStar(
    snapshotIdInput: SnapshotId,
    repositoryIdInput: RepositoryId,
  ): boolean {
    const snapshotId = asSnapshotId(snapshotIdInput);
    const repositoryId = asRepositoryId(repositoryIdInput);
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM snapshot_stars ss
           JOIN snapshots s ON s.snapshot_id=ss.snapshot_id
           WHERE ss.snapshot_id=? AND ss.repository_id=? AND s.status='complete'`,
        )
        .get(snapshotId, repositoryId) !== undefined
    );
  }

  #recoverRows(
    rows: readonly SnapshotRow[],
    failedAt: string,
  ): readonly SnapshotId[] {
    const ids: SnapshotId[] = [];
    for (const row of rows) {
      if (failedAt < row.started_at) {
        return precondition("snapshot recovery time precedes snapshot start");
      }
      const id = asSnapshotId(row.snapshot_id);
      const counts = this.#counts(id);
      this.#database
        .prepare(
          `UPDATE snapshots SET status='failed',failed_at=@failedAt,
             repositories_count=@repositories,stars_count=@stars,
             lists_count=@lists,memberships_count=@memberships
           WHERE snapshot_id=@id AND status='building'`,
        )
        .run({ id, failedAt, ...counts });
      this.#database
        .prepare("DELETE FROM snapshot_verifications WHERE snapshot_id=?")
        .run(id);
      ids.push(id);
    }
    return Object.freeze(ids);
  }

  recoverIncompleteSnapshots(nowInput: string): readonly SnapshotId[] {
    const now = canonicalUtcTimestamp(nowInput, "snapshot recovery now");
    return this.#write(() => {
      const rows = this.#database
        .prepare(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots s
           WHERE s.status='building'
             AND NOT EXISTS(
               SELECT 1 FROM leases l
               WHERE l.name=s.lease_name
                 AND l.owner_id=s.lease_owner_id
                 AND l.expires_at>?
             )
           ORDER BY s.snapshot_id COLLATE BINARY`,
        )
        .all(now) as SnapshotRow[];
      return this.#recoverRows(rows, now);
    });
  }

  recoverAbandonedSnapshots(input: {
    readonly binding: AccountBinding;
    readonly lease: LeaseGuard;
  }): readonly SnapshotId[] {
    const root = exactObject(
      input,
      ["binding", "lease"],
      "targeted snapshot recovery input",
    );
    const binding = stableBinding(root.binding);
    const guard = parsedGuard(root.lease);
    return this.#write(() => {
      const lease = this.#leases.assertLease(guard);
      const rows = this.#database
        .prepare(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots s
           WHERE s.status='building'
             AND s.host=? AND s.login=? AND s.account_id=?
             AND s.lease_name=?
             AND NOT EXISTS(
               SELECT 1 FROM leases l
               WHERE l.name=s.lease_name
                 AND l.owner_id=s.lease_owner_id
                 AND l.expires_at>?
             )
           ORDER BY s.snapshot_id COLLATE BINARY`,
        )
        .all(
          binding.host,
          binding.login,
          binding.accountId,
          lease.name,
          guard.now,
        ) as SnapshotRow[];
      return this.#recoverRows(rows, guard.now);
    });
  }
}
