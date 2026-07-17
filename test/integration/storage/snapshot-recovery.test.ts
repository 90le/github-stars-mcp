import { describe, expect, test } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import { asSnapshotId } from "../../../src/domain/ids.js";
import { accountBindingFixture } from "../../fixtures/domain.js";
import {
  createSqliteSnapshotFixture,
  repositoryBatch,
  SNAPSHOT_T2,
  SNAPSHOT_T5,
  snapshotDraft,
} from "../../fixtures/sqlite-snapshot.js";

describe("snapshot recovery", () => {
  test("does not recover a snapshot guarded by an exact unexpired lease", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_active");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    expect(fixture.snapshots.recoverIncompleteSnapshots(SNAPSHOT_T2)).toEqual(
      [],
    );
    expect(
      fixture.database
        .prepare("SELECT status FROM snapshots WHERE snapshot_id=?")
        .pluck()
        .get(id),
    ).toBe("building");
    fixture.database.close();
  });

  test("does not mis-recover when recovery now precedes the active lease heartbeat", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_clock_rollback");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    fixture.leases.renewLease({
      name: fixture.guard.name,
      ownerId: fixture.guard.ownerId,
      now: SNAPSHOT_T2,
      expiresAt: "2026-07-16T00:06:00.000Z",
    });
    expect(
      fixture.snapshots.recoverIncompleteSnapshots("2026-07-16T00:01:30.000Z"),
    ).toEqual([]);
    expect(
      fixture.database
        .prepare("SELECT status FROM snapshots WHERE snapshot_id=?")
        .pluck()
        .get(id),
    ).toBe("building");
    fixture.database.close();
  });

  test("recovers at exact lease expiry, clears verification, and retains first-pass audit rows", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_expired");
    const batch = repositoryBatch();
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({
      id,
      batch,
      lease: fixture.guard,
    });
    fixture.snapshots.beginSnapshotVerification({
      id,
      listCoverage: "complete",
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

    expect(fixture.snapshots.recoverIncompleteSnapshots(SNAPSHOT_T5)).toEqual([
      id,
    ]);
    const row = fixture.snapshots.getCompleteSnapshot(id);
    expect(row).toBeNull();
    expect(
      fixture.database
        .prepare(
          `SELECT status,repositories_count,stars_count,lists_count,
                  memberships_count
           FROM snapshots WHERE snapshot_id=?`,
        )
        .get(id),
    ).toEqual({
      status: "failed",
      repositories_count: 1,
      stars_count: 1,
      lists_count: 1,
      memberships_count: 1,
    });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_verifications WHERE snapshot_id=?",
        )
        .pluck()
        .get(id),
    ).toBe(0);
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_star_staging WHERE snapshot_id=?",
        )
        .pluck()
        .get(id),
    ).toBe(1);
    fixture.database.close();
  });

  test("targeted takeover recovers only old-owner snapshots for the exact binding and lease name", () => {
    const fixture = createSqliteSnapshotFixture();
    const oldId = asSnapshotId("snap_old_owner");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(oldId),
      lease: fixture.guard,
    });
    const takeover = fixture.leases.acquireLease({
      name: fixture.guard.name,
      ownerId: "process-2",
      now: SNAPSHOT_T5,
      expiresAt: "2026-07-16T00:06:00.000Z",
    });
    expect(takeover?.ownerId).toBe("process-2");
    const takeoverGuard = {
      name: fixture.guard.name,
      ownerId: "process-2",
      now: SNAPSHOT_T5,
    } as const;
    const currentId = asSnapshotId("snap_current_owner");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(currentId),
      lease: takeoverGuard,
    });

    expect(
      fixture.snapshots.recoverAbandonedSnapshots({
        binding: accountBindingFixture,
        lease: takeoverGuard,
      }),
    ).toEqual([oldId]);
    expect(
      fixture.database
        .prepare("SELECT status FROM snapshots WHERE snapshot_id=?")
        .pluck()
        .get(currentId),
    ).toBe("building");
    fixture.database.close();
  });

  test("recovery is all-or-nothing when any terminal timestamp would precede start", () => {
    const fixture = createSqliteSnapshotFixture();
    const normalId = asSnapshotId("a_normal");
    const futureId = asSnapshotId("z_future");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(normalId),
      lease: fixture.guard,
    });
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(
        futureId,
        "collecting",
        accountBindingFixture,
        "2026-07-16T00:04:00.000Z",
      ),
      lease: fixture.guard,
    });
    fixture.leases.releaseLease({
      name: fixture.guard.name,
      ownerId: fixture.guard.ownerId,
    });

    let thrown: unknown;
    try {
      fixture.snapshots.recoverIncompleteSnapshots(SNAPSHOT_T2);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("PRECONDITION_FAILED");
    expect(
      fixture.database
        .prepare(
          `SELECT snapshot_id,status FROM snapshots
           WHERE snapshot_id IN (?,?) ORDER BY snapshot_id`,
        )
        .all(normalId, futureId),
    ).toEqual([
      { snapshot_id: normalId, status: "building" },
      { snapshot_id: futureId, status: "building" },
    ]);
    fixture.database.close();
  });
});
