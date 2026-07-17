import { describe, expect, test } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import {
  asRepositoryId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import {
  parseSnapshotBatch,
  type SnapshotBatch,
  type SnapshotVerificationBatch,
} from "../../../src/domain/snapshot.js";
import {
  createSqliteSnapshotFixture,
  repositoryBatch,
  SNAPSHOT_T2,
  snapshotDraft,
} from "../../fixtures/sqlite-snapshot.js";

function error(operation: () => unknown): AppError | undefined {
  try {
    operation();
    return undefined;
  } catch (thrown) {
    return thrown instanceof AppError ? thrown : undefined;
  }
}

function prepared(idText = "snap_verify") {
  const fixture = createSqliteSnapshotFixture();
  const id = asSnapshotId(idText);
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
  return { fixture, id, batch };
}

function finishAndComplete(
  state: ReturnType<typeof prepared>,
  verification: SnapshotVerificationBatch,
  counts = { repositories: 1, stars: 1, lists: 1, memberships: 1 },
) {
  state.fixture.snapshots.appendSnapshotVerificationBatch({
    id: state.id,
    batch: verification,
    lease: state.fixture.guard,
  });
  state.fixture.snapshots.finishSnapshotVerification({
    id: state.id,
    lease: state.fixture.guard,
  });
  return state.fixture.snapshots.completeSnapshot({
    id: state.id,
    completedAt: SNAPSHOT_T2,
    listCoverage: "complete",
    counts,
    warningCount: 0,
    sourceRateLimit: null,
    lease: state.fixture.guard,
  });
}

function verificationOf(batch: SnapshotBatch): SnapshotVerificationBatch {
  return {
    stars: batch.stars,
    lists: batch.lists,
    memberships: batch.memberships,
  };
}

describe("snapshot exact-set verification", () => {
  test("accepts reordered Stars, Lists, and memberships", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_reordered");
    const first = repositoryBatch({ includeList: false });
    const second = repositoryBatch({
      repositoryId: "R_2",
      repositoryDatabaseId: "43",
      includeList: false,
      repositoryOverrides: {
        name: "SDK-2",
        fullName: "OpenAI/SDK-2",
        url: "https://github.com/OpenAI/SDK-2",
      },
    });
    const batch = parseSnapshotBatch({
      repositories: [...first.repositories, ...second.repositories],
      stars: [...first.stars, ...second.stars],
      lists: [
        {
          listId: asUserListId("L_1"),
          name: "Alpha",
          slug: "alpha",
          description: null,
          isPrivate: false,
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          lastAddedAt: null,
        },
        {
          listId: asUserListId("L_2"),
          name: "Beta",
          slug: "beta",
          description: "B",
          isPrivate: true,
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          lastAddedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      memberships: [
        { listId: asUserListId("L_1"), repositoryId: asRepositoryId("R_1") },
        { listId: asUserListId("L_2"), repositoryId: asRepositoryId("R_2") },
      ],
    });
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({ id, batch, lease: fixture.guard });
    fixture.snapshots.beginSnapshotVerification({
      id,
      listCoverage: "complete",
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotVerificationBatch({
      id,
      batch: {
        stars: [...batch.stars].reverse(),
        lists: [...batch.lists].reverse(),
        memberships: [...batch.memberships].reverse(),
      },
      lease: fixture.guard,
    });
    fixture.snapshots.finishSnapshotVerification({
      id,
      lease: fixture.guard,
    });
    expect(
      fixture.snapshots.completeSnapshot({
        id,
        completedAt: SNAPSHOT_T2,
        listCoverage: "complete",
        counts: { repositories: 2, stars: 2, lists: 2, memberships: 2 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: fixture.guard,
      }).status,
    ).toBe("complete");
    fixture.database.close();
  });

  test("classifies duplicate verification identities as collection_changed and rolls back the batch", () => {
    const state = prepared("snap_verification_duplicate");
    state.fixture.snapshots.appendSnapshotVerificationBatch({
      id: state.id,
      batch: verificationOf(state.batch),
      lease: state.fixture.guard,
    });
    const duplicate = error(() =>
      state.fixture.snapshots.appendSnapshotVerificationBatch({
        id: state.id,
        batch: {
          stars: [
            {
              repositoryId: asRepositoryId("R_new"),
              starredAt: "2026-07-15T12:00:00.000Z",
            },
          ],
          lists: [],
          memberships: state.batch.memberships,
        },
        lease: state.fixture.guard,
      }),
    );
    expect(duplicate?.code).toBe("PRECONDITION_FAILED");
    expect(duplicate?.details).toEqual({ reason: "collection_changed" });
    expect(
      state.fixture.database
        .prepare(
          `SELECT COUNT(*) FROM snapshot_verification_stars
           WHERE snapshot_id=? AND repository_id='R_new'`,
        )
        .pluck()
        .get(state.id),
    ).toBe(0);
    state.fixture.database.close();
  });

  test("rejects changed Star timestamps without partial publication", () => {
    const state = prepared("snap_changed_star");
    const verification = verificationOf(state.batch);
    const changed = {
      ...verification,
      stars: [
        {
          ...verification.stars[0]!,
          starredAt: "2026-07-15T13:00:00.000Z",
        },
      ],
    };
    const mismatch = error(() => finishAndComplete(state, changed));
    expect(mismatch?.details).toEqual({ reason: "collection_changed" });
    expect(state.fixture.snapshots.getCompleteSnapshot(state.id)).toBeNull();
    expect(
      state.fixture.database
        .prepare("SELECT COUNT(*) FROM snapshot_stars WHERE snapshot_id=?")
        .pluck()
        .get(state.id),
    ).toBe(0);
    expect(
      state.fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_verifications WHERE snapshot_id=?",
        )
        .pluck()
        .get(state.id),
    ).toBe(1);
    state.fixture.database.close();
  });

  test.each([
    [
      "added Star",
      (verification: SnapshotVerificationBatch): SnapshotVerificationBatch => ({
        ...verification,
        stars: [
          ...verification.stars,
          {
            repositoryId: asRepositoryId("R_added"),
            starredAt: "2026-07-15T14:00:00.000Z",
          },
        ],
      }),
    ],
    [
      "removed Star",
      (verification: SnapshotVerificationBatch): SnapshotVerificationBatch => ({
        ...verification,
        stars: [],
      }),
    ],
    [
      "added List identity",
      (verification: SnapshotVerificationBatch): SnapshotVerificationBatch => ({
        ...verification,
        lists: [
          ...verification.lists,
          {
            listId: asUserListId("L_added"),
            name: "Added",
            slug: "added",
            description: null,
            isPrivate: false,
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-16T00:00:00.000Z",
            lastAddedAt: null,
          },
        ],
      }),
    ],
    [
      "removed List identity",
      (verification: SnapshotVerificationBatch): SnapshotVerificationBatch => ({
        ...verification,
        lists: [],
      }),
    ],
    [
      "added membership",
      (verification: SnapshotVerificationBatch): SnapshotVerificationBatch => ({
        ...verification,
        memberships: [
          ...verification.memberships,
          {
            listId: verification.lists[0]!.listId,
            repositoryId: asRepositoryId("R_added"),
          },
        ],
      }),
    ],
  ] as const)("rejects an isolated %s exact-set change", (label, change) => {
    const state = prepared(`snap_set_${label.replaceAll(" ", "_")}`);
    const mismatch = error(() =>
      finishAndComplete(state, change(verificationOf(state.batch))),
    );
    expect(mismatch?.details).toEqual({ reason: "collection_changed" });
    expect(state.fixture.snapshots.getCompleteSnapshot(state.id)).toBeNull();
    state.fixture.database.close();
  });

  test.each([
    ["name", "Changed"],
    ["slug", "changed"],
    ["description", "Changed description"],
    ["isPrivate", true],
    ["createdAt", "2026-07-14T00:00:00.000Z"],
    ["updatedAt", "2026-07-17T00:00:00.000Z"],
    ["lastAddedAt", null],
  ] as const)("rejects a changed normalized List %s field", (field, value) => {
    const state = prepared(`snap_list_${field}`);
    const verification = verificationOf(state.batch);
    const changedList = { ...verification.lists[0]!, [field]: value };
    const mismatch = error(() =>
      finishAndComplete(state, {
        ...verification,
        lists: [changedList],
      }),
    );
    expect(mismatch?.details).toEqual({ reason: "collection_changed" });
    expect(state.fixture.snapshots.getCompleteSnapshot(state.id)).toBeNull();
    state.fixture.database.close();
  });

  test("rejects changed membership sets", () => {
    const state = prepared("snap_membership_changed");
    const verification = verificationOf(state.batch);
    const mismatch = error(() =>
      finishAndComplete(state, { ...verification, memberships: [] }),
    );
    expect(mismatch?.details).toEqual({ reason: "collection_changed" });
    state.fixture.database.close();
  });

  test("rejects count mismatches before materialization", () => {
    const state = prepared("snap_count_changed");
    const mismatch = error(() =>
      finishAndComplete(state, verificationOf(state.batch), {
        repositories: 2,
        stars: 1,
        lists: 1,
        memberships: 1,
      }),
    );
    expect(mismatch?.details).toEqual({ reason: "collection_changed" });
    expect(
      state.fixture.database
        .prepare("SELECT COUNT(*) FROM snapshot_stars WHERE snapshot_id=?")
        .pluck()
        .get(state.id),
    ).toBe(0);
    state.fixture.database.close();
  });

  test("rejects a staged Star without same-snapshot metadata", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_orphan_star");
    const batch = parseSnapshotBatch({
      repositories: [],
      stars: [
        {
          repositoryId: asRepositoryId("R_missing"),
          starredAt: "2026-07-15T12:00:00.000Z",
        },
      ],
      lists: [],
      memberships: [],
    });
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({ id, batch, lease: fixture.guard });
    fixture.snapshots.beginSnapshotVerification({
      id,
      listCoverage: "complete",
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotVerificationBatch({
      id,
      batch: verificationOf(batch),
      lease: fixture.guard,
    });
    fixture.snapshots.finishSnapshotVerification({ id, lease: fixture.guard });
    const mismatch = error(() =>
      fixture.snapshots.completeSnapshot({
        id,
        completedAt: SNAPSHOT_T2,
        listCoverage: "complete",
        counts: { repositories: 0, stars: 1, lists: 0, memberships: 0 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: fixture.guard,
      }),
    );
    expect(mismatch?.details).toEqual({ reason: "collection_changed" });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) FROM snapshot_stars WHERE snapshot_id=?")
        .pluck()
        .get(id),
    ).toBe(0);
    fixture.database.close();
  });

  test("rejects a staged membership without same-snapshot List and Star endpoints", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_orphan_membership");
    const batch = parseSnapshotBatch({
      repositories: [],
      stars: [],
      lists: [],
      memberships: [
        {
          listId: asUserListId("L_missing"),
          repositoryId: asRepositoryId("R_missing"),
        },
      ],
    });
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({ id, batch, lease: fixture.guard });
    fixture.snapshots.beginSnapshotVerification({
      id,
      listCoverage: "complete",
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotVerificationBatch({
      id,
      batch: verificationOf(batch),
      lease: fixture.guard,
    });
    fixture.snapshots.finishSnapshotVerification({ id, lease: fixture.guard });
    const mismatch = error(() =>
      fixture.snapshots.completeSnapshot({
        id,
        completedAt: SNAPSHOT_T2,
        listCoverage: "complete",
        counts: { repositories: 0, stars: 0, lists: 0, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: fixture.guard,
      }),
    );
    expect(mismatch?.details).toEqual({ reason: "collection_changed" });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) FROM list_memberships WHERE snapshot_id=?")
        .pluck()
        .get(id),
    ).toBe(0);
    fixture.database.close();
  });
});

describe("snapshot terminal cleanup and coverage", () => {
  test("failure clears verification but retains first-pass rows and actual counts", () => {
    const state = prepared("snap_failed");
    state.fixture.snapshots.appendSnapshotVerificationBatch({
      id: state.id,
      batch: verificationOf(state.batch),
      lease: state.fixture.guard,
    });
    const failed = state.fixture.snapshots.failSnapshot({
      id: state.id,
      failedAt: SNAPSHOT_T2,
      sourceRateLimit: { remaining: 0 },
      lease: state.fixture.guard,
    });
    expect(failed.status).toBe("failed");
    expect(failed.counts).toEqual({
      repositories: 1,
      stars: 1,
      lists: 1,
      memberships: 1,
    });
    expect(
      state.fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_verifications WHERE snapshot_id=?",
        )
        .pluck()
        .get(state.id),
    ).toBe(0);
    expect(
      state.fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_star_staging WHERE snapshot_id=?",
        )
        .pluck()
        .get(state.id),
    ).toBe(1);
    state.fixture.database.close();
  });

  test.each(["unavailable", "omitted"] as const)(
    "publishes %s coverage with zero List rows",
    (coverage) => {
      const fixture = createSqliteSnapshotFixture();
      const id = asSnapshotId(`snap_${coverage}`);
      const batch = repositoryBatch({ includeList: false });
      fixture.snapshots.createSnapshot({
        draft: snapshotDraft(id, coverage),
        lease: fixture.guard,
      });
      fixture.snapshots.appendSnapshotBatch({
        id,
        batch,
        lease: fixture.guard,
      });
      fixture.snapshots.beginSnapshotVerification({
        id,
        listCoverage: coverage,
        lease: fixture.guard,
      });
      fixture.snapshots.appendSnapshotVerificationBatch({
        id,
        batch: verificationOf(batch),
        lease: fixture.guard,
      });
      fixture.snapshots.finishSnapshotVerification({
        id,
        lease: fixture.guard,
      });
      expect(
        fixture.snapshots.completeSnapshot({
          id,
          completedAt: SNAPSHOT_T2,
          listCoverage: coverage,
          counts: {
            repositories: 1,
            stars: 1,
            lists: 0,
            memberships: 0,
          },
          warningCount: 0,
          sourceRateLimit: null,
          lease: fixture.guard,
        }).listCoverage,
      ).toBe(coverage);
      fixture.database.close();
    },
  );
});
