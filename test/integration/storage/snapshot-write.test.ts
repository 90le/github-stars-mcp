import {
  canonicalJson,
  sha256Hex,
} from "../../../src/domain/canonical-json.js";
import { AppError } from "../../../src/domain/errors.js";
import { asRepositoryId, asSnapshotId } from "../../../src/domain/ids.js";
import { parseSnapshotBatch } from "../../../src/domain/snapshot.js";
import {
  createSqliteSnapshotFixture,
  publishBatch,
  repositoryBatch,
  SNAPSHOT_T0,
  snapshotDraft,
} from "../../fixtures/sqlite-snapshot.js";
import { describe, expect, test } from "vitest";

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : "non-app-error";
  }
}

describe("snapshot staging writes", () => {
  test("accepts independent out-of-order Repository, Star, List, and membership batches", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_out_of_order");
    const complete = repositoryBatch();
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    for (const partial of [
      parseSnapshotBatch({
        repositories: [],
        stars: [],
        lists: [],
        memberships: complete.memberships,
      }),
      parseSnapshotBatch({
        repositories: [],
        stars: complete.stars,
        lists: [],
        memberships: [],
      }),
      parseSnapshotBatch({
        repositories: [],
        stars: [],
        lists: complete.lists,
        memberships: [],
      }),
      parseSnapshotBatch({
        repositories: complete.repositories,
        stars: [],
        lists: [],
        memberships: [],
      }),
    ]) {
      fixture.snapshots.appendSnapshotBatch({
        id,
        batch: partial,
        lease: fixture.guard,
      });
    }
    publishBatch(fixture, id, complete);
    expect(
      fixture.snapshots.getSnapshotRepository(id, asRepositoryId("R_1"))
        ?.fullName,
    ).toBe("OpenAI/SDK");
    fixture.database.close();
  });

  test("rolls back the whole batch after a late duplicate", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_atomic");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    const valid = repositoryBatch();
    const duplicate = parseSnapshotBatch({
      repositories: valid.repositories,
      stars: [valid.stars[0], valid.stars[0]],
      lists: [],
      memberships: [],
    });
    expect(
      errorCode(() =>
        fixture.snapshots.appendSnapshotBatch({
          id,
          batch: duplicate,
          lease: fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      fixture.snapshots.getRepositoryMetadata(asRepositoryId("R_1")),
    ).toBeNull();
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_repositories WHERE snapshot_id=?",
        )
        .pluck()
        .get(id),
    ).toBe(0);
    fixture.database.close();
  });

  test("uses a savepoint so a caught batch failure cannot leak rows through an outer commit", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_outer_atomic");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    const valid = repositoryBatch();
    const duplicate = parseSnapshotBatch({
      repositories: valid.repositories,
      stars: [valid.stars[0], valid.stars[0]],
      lists: [],
      memberships: [],
    });
    fixture.database.exec("BEGIN IMMEDIATE");
    expect(
      errorCode(() =>
        fixture.snapshots.appendSnapshotBatch({
          id,
          batch: duplicate,
          lease: fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    fixture.database.exec("COMMIT");
    expect(
      fixture.snapshots.getRepositoryMetadata(asRepositoryId("R_1")),
    ).toBeNull();
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_star_staging WHERE snapshot_id=?",
        )
        .pluck()
        .get(id),
    ).toBe(0);
    fixture.database.close();
  });

  test("rejects duplicate identities across batches without changing prior rows", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_duplicate");
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
    expect(
      errorCode(() =>
        fixture.snapshots.appendSnapshotBatch({
          id,
          batch,
          lease: fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) FROM snapshot_repositories WHERE snapshot_id=?",
        )
        .pluck()
        .get(id),
    ).toBe(1);
    fixture.database.close();
  });

  test("enforces global node/database identity immutability", () => {
    const fixture = createSqliteSnapshotFixture();
    const firstId = asSnapshotId("snap_identity_1");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(firstId),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({
      id: firstId,
      batch: repositoryBatch(),
      lease: fixture.guard,
    });

    for (const [id, batch] of [
      ["snap_identity_2", repositoryBatch({ repositoryDatabaseId: "43" })],
      [
        "snap_identity_3",
        repositoryBatch({
          repositoryId: "R_2",
          repositoryDatabaseId: "42",
          repositoryOverrides: {
            fullName: "OpenAI/SDK-2",
            name: "SDK-2",
            url: "https://github.com/OpenAI/SDK-2",
          },
        }),
      ],
    ] as const) {
      const snapshotId = asSnapshotId(id);
      fixture.snapshots.createSnapshot({
        draft: snapshotDraft(snapshotId),
        lease: fixture.guard,
      });
      expect(
        errorCode(() =>
          fixture.snapshots.appendSnapshotBatch({
            id: snapshotId,
            batch,
            lease: fixture.guard,
          }),
        ),
      ).toBe("PRECONDITION_FAILED");
    }
    fixture.database.close();
  });

  test("pins immutable metadata versions in completed snapshots", () => {
    const fixture = createSqliteSnapshotFixture();
    const firstId = asSnapshotId("snap_pinned_1");
    const first = repositoryBatch({ stargazerCount: 10 });
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(firstId),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({
      id: firstId,
      batch: first,
      lease: fixture.guard,
    });
    publishBatch(fixture, firstId, first);

    const secondId = asSnapshotId("snap_pinned_2");
    const second = repositoryBatch({
      stargazerCount: 20,
      observedAt: "2026-07-17T00:00:00.000Z",
    });
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(secondId),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({
      id: secondId,
      batch: second,
      lease: fixture.guard,
    });
    publishBatch(fixture, secondId, second);

    expect(
      fixture.snapshots.getSnapshotRepository(firstId, asRepositoryId("R_1"))
        ?.stargazerCount,
    ).toBe(10);
    expect(
      fixture.snapshots.getSnapshotRepository(secondId, asRepositoryId("R_1"))
        ?.stargazerCount,
    ).toBe(20);
    expect(
      fixture.snapshots.getRepositoryMetadata(asRepositoryId("R_1"))?.repository
        .stargazerCount,
    ).toBe(20);
    fixture.database.close();
  });

  test("uses version hash as the deterministic equal-time metadata tiebreaker", () => {
    const lowOrHigh = (stars: number) =>
      repositoryBatch({ stargazerCount: stars }).repositories[0]!;
    const left = lowOrHigh(10);
    const right = lowOrHigh(20);
    const leftHash = sha256Hex(canonicalJson(left.repository));
    const rightHash = sha256Hex(canonicalJson(right.repository));
    const expectedStars =
      leftHash > rightHash
        ? left.repository.stargazerCount
        : right.repository.stargazerCount;

    for (const order of [
      [left, right],
      [right, left],
    ]) {
      const fixture = createSqliteSnapshotFixture();
      for (const [index, observation] of order.entries()) {
        const id = asSnapshotId(`snap_tie_${String(index)}`);
        fixture.snapshots.createSnapshot({
          draft: snapshotDraft(id),
          lease: fixture.guard,
        });
        fixture.snapshots.appendSnapshotBatch({
          id,
          batch: parseSnapshotBatch({
            repositories: [observation],
            stars: [],
            lists: [],
            memberships: [],
          }),
          lease: fixture.guard,
        });
      }
      expect(
        fixture.snapshots.getRepositoryMetadata(asRepositoryId("R_1"))
          ?.repository.stargazerCount,
      ).toBe(expectedStars);
      fixture.database.close();
    }
  });

  test("detects exact-content mismatch under an existing version hash", () => {
    const fixture = createSqliteSnapshotFixture();
    const batch = repositoryBatch();
    const repository = batch.repositories[0]!.repository;
    const hash = sha256Hex(canonicalJson(repository));
    fixture.database.exec("BEGIN");
    fixture.database
      .prepare(
        `INSERT INTO repositories(
           repository_id,repository_database_id,current_version_hash,observed_at
         ) VALUES (?,?,?,?)`,
      )
      .run(
        repository.repositoryId,
        repository.repositoryDatabaseId,
        hash,
        SNAPSHOT_T0,
      );
    fixture.database
      .prepare(
        `INSERT INTO repository_versions(
           repository_id,version_hash,owner,name,full_name,description,url,
           stargazer_count,is_fork,is_archived,is_disabled,is_private,
           visibility,primary_language,topics_json,license_spdx_id,pushed_at,updated_at
         ) VALUES (
           ?,?,'OpenAI','SDK','OpenAI/SDK',NULL,'https://github.com/OpenAI/SDK',
           999,0,0,0,0,'public','TypeScript','["agent","mcp"]',
           'Apache-2.0',?,?
         )`,
      )
      .run(
        repository.repositoryId,
        hash,
        repository.pushedAt,
        repository.updatedAt,
      );
    fixture.database.exec("COMMIT");
    const id = asSnapshotId("snap_collision");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    expect(
      errorCode(() =>
        fixture.snapshots.appendSnapshotBatch({
          id,
          batch,
          lease: fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    fixture.database.close();
  });

  test("rejects List rows when coverage is unavailable", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_unavailable_write");
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id, "unavailable"),
      lease: fixture.guard,
    });
    expect(
      errorCode(() =>
        fixture.snapshots.appendSnapshotBatch({
          id,
          batch: parseSnapshotBatch({
            repositories: [],
            stars: [],
            lists: repositoryBatch().lists,
            memberships: [],
          }),
          lease: fixture.guard,
        }),
      ),
    ).toBe("PRECONDITION_FAILED");
    fixture.database.close();
  });

  test("rejects unknown outer fields and snapshots accessor-free inputs once", () => {
    const fixture = createSqliteSnapshotFixture();
    expect(
      errorCode(() =>
        fixture.snapshots.createSnapshot({
          draft: snapshotDraft("snap_extra"),
          lease: fixture.guard,
          extra: true,
        } as never),
      ),
    ).toBe("VALIDATION_ERROR");
    let reads = 0;
    const hostile = Object.defineProperty({ lease: fixture.guard }, "draft", {
      enumerable: true,
      get() {
        reads += 1;
        return snapshotDraft("snap_getter");
      },
    });
    expect(
      errorCode(() => fixture.snapshots.createSnapshot(hostile as never)),
    ).toBe("VALIDATION_ERROR");
    expect(reads).toBe(0);
    fixture.database.close();
  });
});
