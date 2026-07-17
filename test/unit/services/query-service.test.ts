import { describe, expect, it, vi } from "vitest";
import {
  ListsQueryService,
  type ListsQueryInput,
} from "../../../src/app/services/lists-query-service.js";
import {
  QueryService,
  type QueryStoragePort,
  type StarsQueryInput,
} from "../../../src/app/services/query-service.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import type {
  ListMembershipQueryPage,
  ListQueryPage,
  RepositoryQueryPage,
} from "../../../src/domain/filter.js";
import {
  asRepositoryDatabaseId,
  asRepositoryId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import {
  repositoryViewSchema,
  type AccountBinding,
  type RepositoryView,
} from "../../../src/domain/repository.js";
import { parseSnapshot, type Snapshot } from "../../../src/domain/snapshot.js";

const binding = Object.freeze({
  host: "github.com",
  login: "octocat",
  accountId: "U_account",
}) satisfies AccountBinding;

const allFields = [
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
] as const;

function completeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return parseSnapshot({
    id: overrides.id ?? asSnapshotId("snap_1"),
    binding: overrides.binding ?? binding,
    mode: overrides.mode ?? "full",
    listCoverage: overrides.listCoverage ?? "complete",
    startedAt: overrides.startedAt ?? "2026-07-17T00:00:00.000Z",
    status: overrides.status ?? "complete",
    completedAt:
      overrides.completedAt === undefined
        ? "2026-07-17T00:05:00.000Z"
        : overrides.completedAt,
    failedAt: overrides.failedAt ?? null,
    counts: overrides.counts ?? {
      repositories: 2,
      stars: 2,
      lists: 1,
      memberships: 1,
    },
    warningCount: overrides.warningCount ?? 0,
    sourceRateLimit: overrides.sourceRateLimit ?? null,
  });
}

function repositoryView(
  suffix: string,
  overrides: Partial<RepositoryView> = {},
): RepositoryView {
  const owner = overrides.owner ?? "owner";
  const name = overrides.name ?? `repo-${suffix}`;
  return repositoryViewSchema.parse({
    repositoryId: overrides.repositoryId ?? asRepositoryId(`R_${suffix}`),
    repositoryDatabaseId:
      overrides.repositoryDatabaseId ??
      asRepositoryDatabaseId(String(1_000 + Number(suffix))),
    owner,
    name,
    fullName: overrides.fullName ?? `${owner}/${name}`,
    description: overrides.description ?? `description ${suffix}`,
    url: overrides.url ?? `https://github.com/${owner}/${name}`,
    stargazerCount: overrides.stargazerCount ?? 100 + Number(suffix),
    isFork: overrides.isFork ?? false,
    isArchived: overrides.isArchived ?? false,
    isDisabled: overrides.isDisabled ?? false,
    isPrivate: overrides.isPrivate ?? false,
    visibility: overrides.visibility ?? "public",
    primaryLanguage: overrides.primaryLanguage ?? "TypeScript",
    topics: overrides.topics ?? ["mcp", "stars"],
    licenseSpdxId: overrides.licenseSpdxId ?? "MIT",
    pushedAt: overrides.pushedAt ?? "2026-07-15T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-16T00:00:00.000Z",
    starredAt: overrides.starredAt ?? "2026-07-17T00:00:00.000Z",
  });
}

function baseStarsInput(
  overrides: Partial<StarsQueryInput> = {},
): StarsQueryInput {
  return {
    snapshotId: null,
    filter: null,
    sort: [{ field: "starred_at", direction: "desc" }],
    limit: 50,
    cursor: null,
    fields: null,
    evidence: "none",
    evidenceLimit: 0,
    ...overrides,
  };
}

function listSummary() {
  return {
    listId: asUserListId("UL_1"),
    name: "Useful",
    slug: "useful",
    description: null,
    isPrivate: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    lastAddedAt: null,
    repositoryCount: 2,
  } as const;
}

function fakeStorage(
  options: {
    latest?: Snapshot | null;
    explicit?: Snapshot | null;
    repositoryPage?: unknown;
    listPage?: unknown;
    membershipPage?: unknown;
  } = {},
) {
  const snapshot = completeSnapshot();
  const getCompleteSnapshot = vi.fn(() =>
    options.explicit === undefined ? snapshot : options.explicit,
  );
  const getLatestCompleteSnapshot = vi.fn(() =>
    options.latest === undefined ? snapshot : options.latest,
  );
  const queryRepositories = vi.fn(
    () =>
      (options.repositoryPage ?? {
        items: [repositoryView("1"), repositoryView("2")],
        total: 9,
        aggregates: {
          languages: [
            { language: "TypeScript", count: 7 },
            { language: null, count: 2 },
          ],
          archived: 1,
          forks: 3,
        },
        nextCursor: "repository_cursor",
      }) as RepositoryQueryPage,
  );
  const queryLists = vi.fn(
    () =>
      (options.listPage ?? {
        coverage: "complete",
        items: [listSummary()],
        total: 4,
        nextCursor: "list_cursor",
      }) as ListQueryPage,
  );
  const queryListMemberships = vi.fn(
    () =>
      (options.membershipPage ?? {
        coverage: "complete",
        selector: { kind: "list", listId: asUserListId("UL_1") },
        repositoryIds: [asRepositoryId("R_1"), asRepositoryId("R_2")],
        total: 2,
        nextCursor: null,
      }) as ListMembershipQueryPage,
  );
  const port: QueryStoragePort = {
    getCompleteSnapshot,
    getLatestCompleteSnapshot,
    queryRepositories,
    queryLists,
    queryListMemberships,
  };
  return {
    port,
    getCompleteSnapshot,
    getLatestCompleteSnapshot,
    queryRepositories,
    queryLists,
    queryListMemberships,
  };
}

function expectCode(action: () => unknown, code: string) {
  return Promise.resolve()
    .then(action)
    .then(
      () => {
        throw new Error(`Expected ${code}`);
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect(serializeError(error).code).toBe(code);
      },
    );
}

describe("QueryService", () => {
  it("resolves the latest snapshot, delegates one stable query, and forwards page metadata", async () => {
    const storage = fakeStorage();
    const input = baseStarsInput({
      filter: {
        field: "stargazer_count",
        op: "lt",
        value: 10_000,
      },
      sort: [{ field: "stargazer_count", direction: "desc" }],
      limit: 2,
      cursor: "opaque",
      fields: ["repository_id", "full_name"],
    });

    const result = await new QueryService(storage.port, binding).query(input);

    expect(storage.getLatestCompleteSnapshot).toHaveBeenCalledWith(binding);
    expect(storage.getCompleteSnapshot).not.toHaveBeenCalled();
    expect(storage.queryRepositories).toHaveBeenCalledOnce();
    expect(storage.queryRepositories).toHaveBeenCalledWith({
      snapshotId: asSnapshotId("snap_1"),
      filter: input.filter,
      sort: [...input.sort, { field: "full_name", direction: "asc" }],
      pageSize: 2,
      cursor: "opaque",
    });
    expect(result).toEqual({
      snapshotId: asSnapshotId("snap_1"),
      total: 9,
      aggregates: {
        languages: [
          { language: "TypeScript", count: 7 },
          { language: null, count: 2 },
        ],
        archived: 1,
        forks: 3,
      },
      items: [
        { repository_id: "R_1", full_name: "owner/repo-1" },
        { repository_id: "R_2", full_name: "owner/repo-2" },
      ],
      evidence: [],
      nextCursor: "repository_cursor",
    });
  });

  it("uses an explicit snapshot without consulting latest", async () => {
    const storage = fakeStorage({
      explicit: completeSnapshot({ id: asSnapshotId("snap_explicit") }),
    });

    const result = await new QueryService(storage.port, binding).query(
      baseStarsInput({ snapshotId: asSnapshotId("snap_explicit") }),
    );

    expect(result.snapshotId).toBe("snap_explicit");
    expect(storage.getCompleteSnapshot).toHaveBeenCalledWith("snap_explicit");
    expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
  });

  it("rejects storage returning the wrong explicit snapshot ID", async () => {
    const storage = fakeStorage({
      explicit: completeSnapshot({ id: asSnapshotId("snap_other") }),
    });

    await expectCode(
      () =>
        new QueryService(storage.port, binding).query(
          baseStarsInput({ snapshotId: asSnapshotId("snap_requested") }),
        ),
      "STALE_SNAPSHOT",
    );
    expect(storage.queryRepositories).not.toHaveBeenCalled();
  });

  it("returns all safe fields by default and never projects list_ids", async () => {
    const storage = fakeStorage();
    const result = await new QueryService(storage.port, binding).query(
      baseStarsInput(),
    );

    expect(Object.keys(result.items[0]!)).toEqual(allFields);
    expect(result.items[0]).not.toHaveProperty("list_ids");
  });

  it("allows an empty field list for aggregate-only paging", async () => {
    const storage = fakeStorage();
    const result = await new QueryService(storage.port, binding).query(
      baseStarsInput({ fields: [] }),
    );

    expect(result.items).toEqual([{}, {}]);
    expect(result.total).toBe(9);
    expect(result.aggregates.archived).toBe(1);
  });

  it("preserves requested projection order and detached collection fields", async () => {
    const mutable = repositoryView("1", { topics: ["alpha", "beta"] });
    const storage = fakeStorage({
      repositoryPage: {
        items: [mutable],
        total: 1,
        aggregates: { languages: [], archived: 0, forks: 0 },
        nextCursor: null,
      },
    });
    const result = await new QueryService(storage.port, binding).query(
      baseStarsInput({
        fields: ["topics", "name", "repository_database_id"],
      }),
    );

    expect(Object.keys(result.items[0]!)).toEqual([
      "topics",
      "name",
      "repository_database_id",
    ]);
    expect(result.items[0]).toEqual({
      topics: ["alpha", "beta"],
      name: "repo-1",
      repository_database_id: "1001",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Object.isFrozen(result.items[0]!.topics)).toBe(true);
  });

  it.each([
    ["limit zero", { limit: 0 }],
    ["fractional limit", { limit: 1.5 }],
    ["limit over maximum", { limit: 101 }],
    ["empty cursor", { cursor: "" }],
    ["oversized cursor", { cursor: "x".repeat(4_097) }],
    ["duplicate fields", { fields: ["name", "name"] }],
    ["unknown field", { fields: ["list_ids"] }],
    ["too many fields", { fields: [...allFields, "name"] }],
    ["invalid evidence limit", { evidenceLimit: 21 }],
    ["none with evidence limit", { evidenceLimit: 1 }],
  ])("rejects invalid input before storage: %s", async (_label, patch) => {
    const storage = fakeStorage();
    await expectCode(
      () =>
        new QueryService(storage.port, binding).query(
          baseStarsInput(patch as Partial<StarsQueryInput>),
        ),
      "VALIDATION_ERROR",
    );
    expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
    expect(storage.getCompleteSnapshot).not.toHaveBeenCalled();
    expect(storage.queryRepositories).not.toHaveBeenCalled();
  });

  it("rejects unknown top-level fields before storage", async () => {
    const storage = fakeStorage();
    const input = {
      ...baseStarsInput(),
      authorization: "must-not-cross",
    };

    await expectCode(
      () => new QueryService(storage.port, binding).query(input),
      "VALIDATION_ERROR",
    );
    expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
  });

  it("fails non-none evidence explicitly before storage until Task 7", async () => {
    const storage = fakeStorage();

    await expectCode(
      () =>
        new QueryService(storage.port, binding).query(
          baseStarsInput({ evidence: "summary", evidenceLimit: 2 }),
        ),
      "CAPABILITY_UNAVAILABLE",
    );
    expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    [
      "building",
      completeSnapshot({
        status: "building",
        completedAt: null,
        listCoverage: "collecting",
      }),
    ],
    [
      "failed",
      completeSnapshot({
        status: "failed",
        completedAt: null,
        failedAt: "2026-07-17T00:05:00.000Z",
        listCoverage: "omitted",
        counts: { repositories: 2, stars: 2, lists: 0, memberships: 0 },
      }),
    ],
    [
      "cross-account",
      completeSnapshot({
        binding: { ...binding, accountId: "U_other" },
      }),
    ],
  ])(
    "rejects an unusable %s snapshot without querying",
    async (_label, value) => {
      const storage = fakeStorage({ latest: value });
      await expectCode(
        () => new QueryService(storage.port, binding).query(baseStarsInput()),
        "STALE_SNAPSHOT",
      );
      expect(storage.queryRepositories).not.toHaveBeenCalled();
    },
  );

  it.each(["unavailable", "omitted"] as const)(
    "permits ordinary filters but rejects List-dependent filters for %s coverage",
    async (listCoverage) => {
      const snapshot = completeSnapshot({
        listCoverage,
        counts: { repositories: 2, stars: 2, lists: 0, memberships: 0 },
      });
      const ordinary = fakeStorage({ latest: snapshot });
      await new QueryService(ordinary.port, binding).query(
        baseStarsInput({
          filter: { field: "is_archived", op: "eq", value: false },
        }),
      );
      expect(ordinary.queryRepositories).toHaveBeenCalledOnce();

      const dependent = fakeStorage({ latest: snapshot });
      await expectCode(
        () =>
          new QueryService(dependent.port, binding).query(
            baseStarsInput({
              filter: {
                field: "is_unclassified",
                op: "eq",
                value: true,
              },
            }),
          ),
        "CAPABILITY_UNAVAILABLE",
      );
      expect(dependent.queryRepositories).not.toHaveBeenCalled();

      const listIdFilter = fakeStorage({ latest: snapshot });
      await expectCode(
        () =>
          new QueryService(listIdFilter.port, binding).query(
            baseStarsInput({
              filter: {
                field: "list_ids",
                op: "contains",
                value: "UL_1",
              },
            }),
          ),
        "CAPABILITY_UNAVAILABLE",
      );
      expect(listIdFilter.queryRepositories).not.toHaveBeenCalled();
    },
  );

  it("propagates sanitized storage cursor errors", async () => {
    const storage = fakeStorage();
    storage.queryRepositories.mockImplementationOnce(() => {
      throw new AppError("VALIDATION_ERROR", "cursor is invalid");
    });

    await expectCode(
      () =>
        new QueryService(storage.port, binding).query(
          baseStarsInput({ cursor: "opaque" }),
        ),
      "VALIDATION_ERROR",
    );
  });

  it("rejects hostile input without invoking caller code or storage", async () => {
    let getterCalls = 0;
    let proxyCalls = 0;
    const getter = Object.defineProperty(baseStarsInput(), "fields", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return ["name"];
      },
    });
    const proxy = new Proxy(baseStarsInput(), {
      ownKeys: () => {
        proxyCalls += 1;
        return [];
      },
    });
    const storage = fakeStorage();

    await expectCode(
      () => new QueryService(storage.port, binding).query(getter),
      "VALIDATION_ERROR",
    );
    await expectCode(
      () => new QueryService(storage.port, binding).query(proxy),
      "VALIDATION_ERROR",
    );
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
    expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed on a hostile storage page instead of returning mutable data", async () => {
    const storage = fakeStorage({
      repositoryPage: new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("hostile storage output");
          },
        },
      ),
    });

    await expectCode(
      () => new QueryService(storage.port, binding).query(baseStarsInput()),
      "VALIDATION_ERROR",
    );
  });
});

describe("ListsQueryService", () => {
  it("returns a bounded List page from the latest complete-coverage snapshot", async () => {
    const storage = fakeStorage();
    const input: ListsQueryInput = {
      mode: "lists",
      snapshotId: null,
      limit: 25,
      cursor: null,
    };

    const result = await new ListsQueryService(storage.port, binding).query(
      input,
    );

    expect(storage.queryLists).toHaveBeenCalledWith({
      snapshotId: asSnapshotId("snap_1"),
      pageSize: 25,
      cursor: null,
    });
    expect(result).toEqual({
      snapshotId: asSnapshotId("snap_1"),
      coverage: "complete",
      items: [listSummary()],
      total: 4,
      nextCursor: "list_cursor",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect("items" in result).toBe(true);
    if (!("items" in result)) throw new Error("Expected List page");
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it("queries memberships by exactly one List selector", async () => {
    const storage = fakeStorage();
    const result = await new ListsQueryService(storage.port, binding).query({
      mode: "memberships",
      snapshotId: null,
      listId: asUserListId("UL_1"),
      limit: 100,
      cursor: null,
    });

    expect(storage.queryListMemberships).toHaveBeenCalledWith({
      snapshotId: asSnapshotId("snap_1"),
      selector: { kind: "list", listId: asUserListId("UL_1") },
      pageSize: 100,
      cursor: null,
    });
    expect(result).toMatchObject({
      snapshotId: asSnapshotId("snap_1"),
      selector: { kind: "list", listId: asUserListId("UL_1") },
      repositoryIds: ["R_1", "R_2"],
      total: 2,
    });
  });

  it("queries memberships by exactly one repository selector", async () => {
    const storage = fakeStorage({
      membershipPage: {
        coverage: "complete",
        selector: {
          kind: "repository",
          repositoryId: asRepositoryId("R_1"),
        },
        listIds: [asUserListId("UL_1")],
        total: 1,
        nextCursor: null,
      },
    });
    const result = await new ListsQueryService(storage.port, binding).query({
      mode: "memberships",
      snapshotId: null,
      repositoryId: asRepositoryId("R_1"),
      limit: 10,
      cursor: null,
    });

    expect(storage.queryListMemberships).toHaveBeenCalledWith({
      snapshotId: asSnapshotId("snap_1"),
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
      pageSize: 10,
      cursor: null,
    });
    expect(result).toMatchObject({
      listIds: ["UL_1"],
      total: 1,
    });
  });

  it("fails closed when storage returns a different membership selector", async () => {
    const storage = fakeStorage({
      membershipPage: {
        coverage: "complete",
        selector: {
          kind: "repository",
          repositoryId: asRepositoryId("R_wrong"),
        },
        listIds: [],
        total: 0,
        nextCursor: null,
      },
    });

    await expectCode(
      () =>
        new ListsQueryService(storage.port, binding).query({
          mode: "memberships",
          snapshotId: null,
          repositoryId: asRepositoryId("R_requested"),
          limit: 10,
          cursor: null,
        }),
      "VALIDATION_ERROR",
    );
  });

  it.each([
    {
      mode: "memberships",
      snapshotId: null,
      limit: 10,
      cursor: null,
    },
    {
      mode: "memberships",
      snapshotId: null,
      listId: "UL_1",
      repositoryId: "R_1",
      limit: 10,
      cursor: null,
    },
    {
      mode: "lists",
      snapshotId: null,
      listId: "UL_1",
      limit: 10,
      cursor: null,
    },
  ])("rejects malformed selector shapes before storage", async (input) => {
    const storage = fakeStorage();
    await expectCode(
      () =>
        new ListsQueryService(storage.port, binding).query(
          input as ListsQueryInput,
        ),
      "VALIDATION_ERROR",
    );
    expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
    expect(storage.queryListMemberships).not.toHaveBeenCalled();
    expect(storage.queryLists).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "omitted"] as const)(
    "rejects all List modes when coverage is %s",
    async (listCoverage) => {
      const storage = fakeStorage({
        latest: completeSnapshot({
          listCoverage,
          counts: { repositories: 2, stars: 2, lists: 0, memberships: 0 },
        }),
      });

      await expectCode(
        () =>
          new ListsQueryService(storage.port, binding).query({
            mode: "lists",
            snapshotId: null,
            limit: 10,
            cursor: null,
          }),
        "CAPABILITY_UNAVAILABLE",
      );
      expect(storage.queryLists).not.toHaveBeenCalled();
    },
  );
});
