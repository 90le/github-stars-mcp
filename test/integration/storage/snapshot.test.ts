import { describe, expect, test } from "vitest";
import { createCursorCodec } from "../../../src/domain/cursor.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";
import { LeaseRepository } from "../../../src/storage/lease-repository.js";
import { SnapshotRepository } from "../../../src/storage/snapshot-repository.js";
import {
  snapshotBatchFixture,
  snapshotDraftFixture,
} from "../../fixtures/domain.js";

const acquiredAt = "2026-07-16T00:00:00.000Z";
const guard = {
  name: "sync:account",
  ownerId: "process-1",
  now: "2026-07-16T00:01:00.000Z",
} as const;

describe("snapshot publication and leases", () => {
  test("hides building rows and atomically publishes verified sets", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, acquiredAt);
    const leases = new LeaseRepository(database);
    leases.acquireLease({
      name: guard.name,
      ownerId: guard.ownerId,
      now: acquiredAt,
      expiresAt: "2026-07-16T00:05:00.000Z",
    });
    const snapshots = new SnapshotRepository(
      database,
      createCursorCodec(new Uint8Array(32).fill(7)),
    );

    snapshots.createSnapshot({ draft: snapshotDraftFixture, lease: guard });
    snapshots.appendSnapshotBatch({
      id: snapshotDraftFixture.id,
      batch: snapshotBatchFixture,
      lease: guard,
    });
    expect(snapshots.getCompleteSnapshot(snapshotDraftFixture.id)).toBeNull();
    expect(
      snapshots.getSnapshotRepository(
        snapshotDraftFixture.id,
        snapshotBatchFixture.repositories[0]!.repository.repositoryId,
      ),
    ).toBeNull();

    snapshots.beginSnapshotVerification({
      id: snapshotDraftFixture.id,
      listCoverage: "complete",
      lease: guard,
    });
    snapshots.appendSnapshotVerificationBatch({
      id: snapshotDraftFixture.id,
      batch: {
        stars: snapshotBatchFixture.stars,
        lists: snapshotBatchFixture.lists,
        memberships: snapshotBatchFixture.memberships,
      },
      lease: guard,
    });
    snapshots.finishSnapshotVerification({
      id: snapshotDraftFixture.id,
      lease: guard,
    });
    const complete = snapshots.completeSnapshot({
      id: snapshotDraftFixture.id,
      completedAt: "2026-07-16T00:02:00.000Z",
      listCoverage: "complete",
      counts: { repositories: 1, stars: 1, lists: 1, memberships: 1 },
      warningCount: 0,
      sourceRateLimit: null,
      lease: guard,
    });

    expect(complete.status).toBe("complete");
    expect(
      snapshots.getSnapshotRepository(
        snapshotDraftFixture.id,
        snapshotBatchFixture.repositories[0]!.repository.repositoryId,
      )?.stargazerCount,
    ).toBe(10);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_verifications WHERE snapshot_id = ?",
        )
        .pluck()
        .get(snapshotDraftFixture.id),
    ).toBe(0);
    database.close();
  });

  test("does not let an active owner reacquire a lease", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, acquiredAt);
    const leases = new LeaseRepository(database);
    expect(
      leases.acquireLease({
        name: "sync",
        ownerId: "process-1",
        now: acquiredAt,
        expiresAt: "2026-07-16T00:05:00.000Z",
      })?.ownerId,
    ).toBe("process-1");
    expect(
      leases.acquireLease({
        name: "sync",
        ownerId: "process-1",
        now: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
      }),
    ).toBeNull();
    database.close();
  });
});
