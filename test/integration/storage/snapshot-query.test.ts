import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createCursorCodec, hashFilter } from "../../../src/domain/cursor.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asRepositoryId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import { parseSnapshotBatch } from "../../../src/domain/snapshot.js";
import { RuntimeSecretRepository } from "../../../src/storage/runtime-secret-repository.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";
import { SnapshotRepository } from "../../../src/storage/snapshot-repository.js";
import {
  createSqliteSnapshotFixture,
  publishBatch,
  repositoryBatch,
  SNAPSHOT_T0,
  SNAPSHOT_T2,
  snapshotDraft,
} from "../../fixtures/sqlite-snapshot.js";

function expectCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(code);
}

function multiRepositorySnapshot() {
  const fixture = createSqliteSnapshotFixture();
  const id = asSnapshotId("snap_query");
  const definitions = [
    {
      id: "R_1",
      databaseId: "41",
      stars: 10,
      language: "TypeScript",
      archived: false,
      fork: false,
      name: "Alpha",
    },
    {
      id: "R_2",
      databaseId: "42",
      stars: 30,
      language: null,
      archived: true,
      fork: false,
      name: "Beta",
    },
    {
      id: "R_3",
      databaseId: "43",
      stars: 20,
      language: "Go",
      archived: false,
      fork: true,
      name: "Gamma",
    },
  ] as const;
  const observations = definitions.map(
    (entry) =>
      repositoryBatch({
        repositoryId: entry.id,
        repositoryDatabaseId: entry.databaseId,
        stargazerCount: entry.stars,
        includeList: false,
        repositoryOverrides: {
          owner: "OpenAI",
          name: entry.name,
          fullName: `OpenAI/${entry.name}`,
          url: `https://github.com/OpenAI/${entry.name}`,
          primaryLanguage: entry.language,
          isArchived: entry.archived,
          isFork: entry.fork,
        },
      }).repositories[0],
  );
  const batch = parseSnapshotBatch({
    repositories: observations,
    stars: definitions.map((entry, index) => ({
      repositoryId: asRepositoryId(entry.id),
      starredAt: `2026-07-15T12:00:0${String(index)}.000Z`,
    })),
    lists: [
      {
        listId: asUserListId("L_2"),
        name: "Beta",
        slug: "beta",
        description: null,
        isPrivate: false,
        createdAt: SNAPSHOT_T0,
        updatedAt: SNAPSHOT_T0,
        lastAddedAt: null,
      },
      {
        listId: asUserListId("L_1"),
        name: "Alpha",
        slug: "alpha",
        description: "first",
        isPrivate: true,
        createdAt: SNAPSHOT_T0,
        updatedAt: SNAPSHOT_T0,
        lastAddedAt: SNAPSHOT_T0,
      },
    ],
    memberships: [
      { listId: asUserListId("L_1"), repositoryId: asRepositoryId("R_1") },
      { listId: asUserListId("L_1"), repositoryId: asRepositoryId("R_2") },
      { listId: asUserListId("L_2"), repositoryId: asRepositoryId("R_2") },
    ],
  });
  fixture.snapshots.createSnapshot({
    draft: snapshotDraft(id),
    lease: fixture.guard,
  });
  fixture.snapshots.appendSnapshotBatch({ id, batch, lease: fixture.guard });
  publishBatch(fixture, id, batch);
  return { fixture, id, batch };
}

describe("repository and List snapshot queries", () => {
  test("paginates repositories without duplicates and keeps totals/aggregates cursor-independent", () => {
    const { fixture, id } = multiRepositorySnapshot();
    const input = {
      snapshotId: id,
      filter: null,
      sort: [{ field: "stargazer_count", direction: "desc" }] as const,
      pageSize: 2,
      cursor: null,
    };
    const first = fixture.snapshots.queryRepositories(input);
    expect(first.items.map((item) => item.repositoryId)).toEqual([
      "R_2",
      "R_3",
    ]);
    expect(first.total).toBe(3);
    expect(first.aggregates).toEqual({
      languages: [
        { language: null, count: 1 },
        { language: "Go", count: 1 },
        { language: "TypeScript", count: 1 },
      ],
      archived: 1,
      forks: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    const second = fixture.snapshots.queryRepositories({
      ...input,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.repositoryId)).toEqual(["R_1"]);
    expect(second.total).toBe(first.total);
    expect(second.aggregates).toEqual(first.aggregates);
    expect(
      new Set(
        [...first.items, ...second.items].map((item) => item.repositoryId),
      ).size,
    ).toBe(3);
    fixture.database.close();
  });

  test("authenticates cursor bytes, resource, snapshot, filter, and sort context", () => {
    const { fixture, id } = multiRepositorySnapshot();
    const base = {
      snapshotId: id,
      filter: null,
      sort: [{ field: "full_name", direction: "asc" }] as const,
      pageSize: 1,
      cursor: null,
    };
    const cursor = fixture.snapshots.queryRepositories(base).nextCursor!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    expectCode(
      () => fixture.snapshots.queryRepositories({ ...base, cursor: tampered }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        fixture.snapshots.queryRepositories({
          ...base,
          snapshotId: asSnapshotId("other_snapshot"),
          cursor,
        }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        fixture.snapshots.queryRepositories({
          ...base,
          filter: { field: "is_archived", op: "eq", value: true },
          cursor,
        }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        fixture.snapshots.queryLists({
          snapshotId: id,
          pageSize: 1,
          cursor,
        }),
      "VALIDATION_ERROR",
    );
    fixture.database.close();
  });

  test("rejects signed repository cursors whose boundary is absent, forged, or filtered out", () => {
    const { fixture, id } = multiRepositorySnapshot();
    const sort = [{ field: "full_name", direction: "asc" }] as const;
    const context = {
      kind: "repositories",
      snapshotId: id,
      filterHash: hashFilter(null),
      sort,
    } as const;
    const missing = fixture.codec.encodeRepository(context, {
      values: ["OpenAI/Missing"],
      nulls: [false],
      repositoryId: asRepositoryId("R_missing"),
    });
    expectCode(
      () =>
        fixture.snapshots.queryRepositories({
          snapshotId: id,
          filter: null,
          sort,
          pageSize: 10,
          cursor: missing,
        }),
      "VALIDATION_ERROR",
    );
    const forged = fixture.codec.encodeRepository(context, {
      values: ["OpenAI/Forged"],
      nulls: [false],
      repositoryId: asRepositoryId("R_1"),
    });
    expectCode(
      () =>
        fixture.snapshots.queryRepositories({
          snapshotId: id,
          filter: null,
          sort,
          pageSize: 10,
          cursor: forged,
        }),
      "VALIDATION_ERROR",
    );
    const filter = { field: "is_archived", op: "eq", value: true } as const;
    const excluded = fixture.codec.encodeRepository(
      {
        ...context,
        filterHash: hashFilter(filter),
      },
      {
        values: ["OpenAI/Alpha"],
        nulls: [false],
        repositoryId: asRepositoryId("R_1"),
      },
    );
    expectCode(
      () =>
        fixture.snapshots.queryRepositories({
          snapshotId: id,
          filter,
          sort,
          pageSize: 10,
          cursor: excluded,
        }),
      "VALIDATION_ERROR",
    );
    fixture.database.close();
  });

  test("queries Lists in fixed binary order and memberships in both directions", () => {
    const { fixture, id } = multiRepositorySnapshot();
    const firstListPage = fixture.snapshots.queryLists({
      snapshotId: id,
      pageSize: 1,
      cursor: null,
    });
    expect(firstListPage.items).toMatchObject([
      { listId: "L_1", name: "Alpha", repositoryCount: 2 },
    ]);
    const secondListPage = fixture.snapshots.queryLists({
      snapshotId: id,
      pageSize: 1,
      cursor: firstListPage.nextCursor,
    });
    expect(secondListPage.items).toMatchObject([
      { listId: "L_2", name: "Beta", repositoryCount: 1 },
    ]);

    const byList = fixture.snapshots.queryListMemberships({
      snapshotId: id,
      selector: { kind: "list", listId: asUserListId("L_1") },
      pageSize: 100,
      cursor: null,
    });
    expect("repositoryIds" in byList && byList.repositoryIds).toEqual([
      "R_1",
      "R_2",
    ]);
    const byRepository = fixture.snapshots.queryListMemberships({
      snapshotId: id,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_2"),
      },
      pageSize: 100,
      cursor: null,
    });
    expect("listIds" in byRepository && byRepository.listIds).toEqual([
      "L_1",
      "L_2",
    ]);
    fixture.database.close();
  });

  test("allows non-List repository queries for unavailable coverage and fails List-dependent paths closed", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_unavailable_query");
    const batch = repositoryBatch({ includeList: false });
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id, "unavailable"),
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({ id, batch, lease: fixture.guard });
    publishBatch(fixture, id, batch, "unavailable");
    expect(
      fixture.snapshots.queryRepositories({
        snapshotId: id,
        filter: { field: "is_archived", op: "eq", value: false },
        sort: [],
        pageSize: 10,
        cursor: null,
      }).total,
    ).toBe(1);
    expectCode(
      () =>
        fixture.snapshots.queryRepositories({
          snapshotId: id,
          filter: { field: "list_ids", op: "contains", value: "L_1" },
          sort: [],
          pageSize: 10,
          cursor: null,
        }),
      "CAPABILITY_UNAVAILABLE",
    );
    expectCode(
      () =>
        fixture.snapshots.queryLists({
          snapshotId: id,
          pageSize: 10,
          cursor: null,
        }),
      "CAPABILITY_UNAVAILABLE",
    );
    expectCode(
      () =>
        fixture.snapshots.queryListMemberships({
          snapshotId: id,
          selector: { kind: "list", listId: asUserListId("L_1") },
          pageSize: 10,
          cursor: null,
        }),
      "CAPABILITY_UNAVAILABLE",
    );
    fixture.database.close();
  });
});

describe("large membership privacy and durable cursors", () => {
  test("never exposes listIds on repository views and paginates 101 memberships as 100 plus 1", () => {
    const fixture = createSqliteSnapshotFixture();
    const id = asSnapshotId("snap_101");
    const repository = repositoryBatch({ includeList: false });
    const lists = Array.from({ length: 101 }, (_, index) => ({
      listId: asUserListId(`L_${String(index).padStart(3, "0")}`),
      name: `List ${String(index).padStart(3, "0")}`,
      slug: `list-${String(index).padStart(3, "0")}`,
      description: null,
      isPrivate: false,
      createdAt: SNAPSHOT_T0,
      updatedAt: SNAPSHOT_T0,
      lastAddedAt: null,
    }));
    const memberships = lists.map((list) => ({
      listId: list.listId,
      repositoryId: asRepositoryId("R_1"),
    }));
    fixture.snapshots.createSnapshot({
      draft: snapshotDraft(id),
      lease: fixture.guard,
    });
    const first = parseSnapshotBatch({
      repositories: repository.repositories,
      stars: repository.stars,
      lists: lists.slice(0, 100),
      memberships: memberships.slice(0, 100),
    });
    const second = parseSnapshotBatch({
      repositories: [],
      stars: [],
      lists: lists.slice(100),
      memberships: memberships.slice(100),
    });
    fixture.snapshots.appendSnapshotBatch({
      id,
      batch: first,
      lease: fixture.guard,
    });
    fixture.snapshots.appendSnapshotBatch({
      id,
      batch: second,
      lease: fixture.guard,
    });
    fixture.snapshots.beginSnapshotVerification({
      id,
      listCoverage: "complete",
      lease: fixture.guard,
    });
    for (const batch of [first, second]) {
      fixture.snapshots.appendSnapshotVerificationBatch({
        id,
        batch: {
          stars: batch.stars,
          lists: batch.lists,
          memberships: batch.memberships,
        },
        lease: fixture.guard,
      });
    }
    fixture.snapshots.finishSnapshotVerification({
      id,
      lease: fixture.guard,
    });
    fixture.snapshots.completeSnapshot({
      id,
      completedAt: SNAPSHOT_T2,
      listCoverage: "complete",
      counts: { repositories: 1, stars: 1, lists: 101, memberships: 101 },
      warningCount: 0,
      sourceRateLimit: null,
      lease: fixture.guard,
    });

    const view = fixture.snapshots.getSnapshotRepository(
      id,
      asRepositoryId("R_1"),
    )!;
    expect(Object.hasOwn(view, "listIds")).toBe(false);
    const queried = fixture.snapshots.queryRepositories({
      snapshotId: id,
      filter: null,
      sort: [],
      pageSize: 10,
      cursor: null,
    }).items[0]!;
    expect(Object.hasOwn(queried, "listIds")).toBe(false);

    const page1 = fixture.snapshots.queryListMemberships({
      snapshotId: id,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
      pageSize: 100,
      cursor: null,
    });
    expect("listIds" in page1 && page1.listIds).toHaveLength(100);
    expect(page1.total).toBe(101);
    const page2 = fixture.snapshots.queryListMemberships({
      snapshotId: id,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
      pageSize: 100,
      cursor: page1.nextCursor,
    });
    expect("listIds" in page2 && page2.listIds).toHaveLength(1);
    fixture.database.close();
  });

  test("keeps authenticated repository cursors valid after database reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-cursor-"));
    const path = join(root, "state.sqlite3");
    try {
      const database = openSqliteDatabase(path);
      migrateSqliteDatabase(database, SNAPSHOT_T0);
      const key = new RuntimeSecretRepository(
        database,
      ).getOrCreateCursorSigningKey("2026-07-16T00:00:01.000Z");
      const fixture = createSqliteSnapshotFixture(database, key);
      const id = asSnapshotId("snap_reopen");
      const firstRepo = repositoryBatch({ includeList: false });
      const secondRepo = repositoryBatch({
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
        repositories: [...firstRepo.repositories, ...secondRepo.repositories],
        stars: [...firstRepo.stars, ...secondRepo.stars],
        lists: [],
        memberships: [],
      });
      fixture.snapshots.createSnapshot({
        draft: snapshotDraft(id, "omitted"),
        lease: fixture.guard,
      });
      fixture.snapshots.appendSnapshotBatch({
        id,
        batch,
        lease: fixture.guard,
      });
      publishBatch(fixture, id, batch, "omitted");
      const input = {
        snapshotId: id,
        filter: null,
        sort: [{ field: "full_name", direction: "asc" }] as const,
        pageSize: 1,
        cursor: null,
      };
      const first = fixture.snapshots.queryRepositories(input);
      database.close();

      const reopened = openSqliteDatabase(path);
      migrateSqliteDatabase(reopened, "2026-07-16T00:03:00.000Z");
      const reopenedKey = new RuntimeSecretRepository(
        reopened,
      ).getOrCreateCursorSigningKey("2026-07-16T00:03:01.000Z");
      const repository = new SnapshotRepository(
        reopened,
        createCursorCodec(reopenedKey),
      );
      expect(
        repository.queryRepositories({
          ...input,
          cursor: first.nextCursor,
        }).items,
      ).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
