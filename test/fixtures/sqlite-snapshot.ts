import type Database from "better-sqlite3";
import type { LeaseGuard } from "../../src/app/ports/storage-port.js";
import {
  createCursorCodec,
  type CursorCodec,
} from "../../src/domain/cursor.js";
import { asSnapshotId, type SnapshotId } from "../../src/domain/ids.js";
import type { AccountBinding } from "../../src/domain/repository.js";
import {
  parseSnapshotBatch,
  parseSnapshotDraft,
  type ListCoverage,
  type SnapshotBatch,
} from "../../src/domain/snapshot.js";
import { LeaseRepository } from "../../src/storage/lease-repository.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../src/storage/sqlite-database.js";
import { SnapshotRepository } from "../../src/storage/snapshot-repository.js";
import {
  accountBindingFixture,
  repositoryInputFixture,
  snapshotBatchFixture,
} from "./domain.js";

export const SNAPSHOT_T0 = "2026-07-16T00:00:00.000Z";
export const SNAPSHOT_T1 = "2026-07-16T00:01:00.000Z";
export const SNAPSHOT_T2 = "2026-07-16T00:02:00.000Z";
export const SNAPSHOT_T5 = "2026-07-16T00:05:00.000Z";

export interface SqliteSnapshotFixture {
  readonly database: Database.Database;
  readonly leases: LeaseRepository;
  readonly snapshots: SnapshotRepository;
  readonly codec: CursorCodec;
  readonly guard: LeaseGuard;
}

export function createSqliteSnapshotFixture(
  database = openSqliteDatabase(":memory:"),
  key: Uint8Array = new Uint8Array(32).fill(7),
): SqliteSnapshotFixture {
  migrateSqliteDatabase(database, SNAPSHOT_T0);
  const leases = new LeaseRepository(database);
  leases.acquireLease({
    name: "sync:account",
    ownerId: "process-1",
    now: SNAPSHOT_T0,
    expiresAt: SNAPSHOT_T5,
  });
  const codec = createCursorCodec(key);
  return {
    database,
    leases,
    codec,
    snapshots: new SnapshotRepository(database, codec),
    guard: {
      name: "sync:account",
      ownerId: "process-1",
      now: SNAPSHOT_T1,
    },
  };
}

export function snapshotDraft(
  id: string,
  listCoverage: Exclude<ListCoverage, "complete"> = "collecting",
  binding: AccountBinding = accountBindingFixture,
  startedAt = SNAPSHOT_T0,
) {
  return parseSnapshotDraft({
    id: asSnapshotId(id),
    binding,
    mode: "full",
    listCoverage,
    startedAt,
  });
}

export function repositoryBatch(
  input: {
    readonly repositoryId?: string;
    readonly repositoryDatabaseId?: string;
    readonly stargazerCount?: number;
    readonly observedAt?: string;
    readonly starredAt?: string;
    readonly includeList?: boolean;
    readonly repositoryOverrides?: Readonly<Record<string, unknown>>;
  } = {},
): SnapshotBatch {
  const repositoryId = input.repositoryId ?? "R_1";
  const includeList = input.includeList ?? true;
  return parseSnapshotBatch({
    repositories: [
      {
        repository: {
          ...repositoryInputFixture,
          repositoryId,
          repositoryDatabaseId: input.repositoryDatabaseId ?? "42",
          stargazerCount: input.stargazerCount ?? 10,
          ...input.repositoryOverrides,
        },
        observedAt: input.observedAt ?? SNAPSHOT_T0,
      },
    ],
    stars: [
      {
        repositoryId,
        starredAt: input.starredAt ?? snapshotBatchFixture.stars[0]!.starredAt,
      },
    ],
    lists: includeList ? snapshotBatchFixture.lists : [],
    memberships: includeList
      ? [
          {
            listId: snapshotBatchFixture.lists[0]!.listId,
            repositoryId,
          },
        ]
      : [],
  });
}

export function publishBatch(
  fixture: SqliteSnapshotFixture,
  idInput: string | SnapshotId,
  batch: SnapshotBatch,
  listCoverage: Exclude<ListCoverage, "collecting"> = "complete",
): void {
  const id = asSnapshotId(idInput);
  fixture.snapshots.beginSnapshotVerification({
    id,
    listCoverage,
    lease: fixture.guard,
  });
  fixture.snapshots.appendSnapshotVerificationBatch({
    id,
    batch: {
      stars: batch.stars,
      lists: batch.lists,
      memberships: batch.memberships,
    },
    lease: fixture.guard,
  });
  fixture.snapshots.finishSnapshotVerification({
    id,
    lease: fixture.guard,
  });
  fixture.snapshots.completeSnapshot({
    id,
    completedAt: SNAPSHOT_T2,
    listCoverage,
    counts: {
      repositories: batch.repositories.length,
      stars: batch.stars.length,
      lists: batch.lists.length,
      memberships: batch.memberships.length,
    },
    warningCount: 0,
    sourceRateLimit: null,
    lease: fixture.guard,
  });
}
