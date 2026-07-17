import { Buffer } from "node:buffer";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
  decodeListCursor,
  decodeRepositoryCursor,
  encodeListCursor,
  encodeRepositoryCursor,
  hashFilter,
  hashListSelection,
  hashRepositorySort,
} from "../../../src/domain/cursor.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asRepositoryId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import {
  compareRepositories,
  matchesFilter,
  normalizeSort,
  parseFilter,
  repositoryCursorPosition,
  type RepositorySort,
} from "../../../src/domain/filter.js";
import type { RepositoryView } from "../../../src/domain/repository.js";
import {
  compileCursor,
  compileFilter,
  compileOrder,
} from "../../../src/storage/filter-sql.js";
import { repositoryViewFixture } from "../../fixtures/domain.js";

const SNAPSHOT_ID = asSnapshotId("snap_1");
const DEFAULT_SORT = [{ field: "stargazer_count", direction: "desc" }] as const;

function expectValidationError(action: () => unknown, message?: RegExp): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    if (message !== undefined) {
      expect((error as Error).message).toMatch(message);
    }
    return;
  }
  throw new Error("expected validation error");
}

function createDatabase(views: readonly RepositoryView[]): Database.Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE repository_versions (
      repository_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      description TEXT,
      primary_language TEXT,
      license_spdx_id TEXT,
      visibility TEXT NOT NULL,
      stargazer_count INTEGER NOT NULL,
      is_fork INTEGER NOT NULL,
      is_archived INTEGER NOT NULL,
      is_disabled INTEGER NOT NULL,
      is_private INTEGER NOT NULL,
      pushed_at TEXT,
      updated_at TEXT NOT NULL,
      topics_json TEXT
    );
    CREATE TABLE snapshot_stars (
      snapshot_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      starred_at TEXT NOT NULL
    );
    CREATE TABLE list_memberships (
      snapshot_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      list_id TEXT NOT NULL
    );
  `);
  const insertRepository = database.prepare(`
    INSERT INTO repository_versions (
      repository_id, owner, name, full_name, description, primary_language,
      license_spdx_id, visibility, stargazer_count, is_fork, is_archived,
      is_disabled, is_private, pushed_at, updated_at, topics_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStar = database.prepare(
    "INSERT INTO snapshot_stars VALUES (?, ?, ?)",
  );
  const insertMembership = database.prepare(
    "INSERT INTO list_memberships VALUES (?, ?, ?)",
  );
  for (const view of views) {
    insertRepository.run(
      view.repositoryId,
      view.owner,
      view.name,
      view.fullName,
      view.description,
      view.primaryLanguage,
      view.licenseSpdxId,
      view.visibility,
      view.stargazerCount,
      Number(view.isFork),
      Number(view.isArchived),
      Number(view.isDisabled),
      Number(view.isPrivate),
      view.pushedAt,
      view.updatedAt,
      JSON.stringify(view.topics),
    );
    insertStar.run(SNAPSHOT_ID, view.repositoryId, view.starredAt);
    for (const listId of view.listIds) {
      insertMembership.run(SNAPSHOT_ID, view.repositoryId, listId);
    }
  }
  return database;
}

function sqlMatches(view: RepositoryView, input: unknown): boolean {
  const filter = parseFilter(input);
  const compiled = compileFilter(filter);
  const database = createDatabase([view]);
  try {
    return (
      database
        .prepare(
          `SELECT 1
           FROM repository_versions rv
           JOIN snapshot_stars ss ON ss.repository_id = rv.repository_id
           WHERE ss.snapshot_id = ? AND ${compiled.sql}`,
        )
        .get(SNAPSHOT_ID, ...compiled.params) !== undefined
    );
  } finally {
    database.close();
  }
}

function withView(
  overrides: Partial<RepositoryView>,
  suffix = "case",
): RepositoryView {
  const repositoryId = overrides.repositoryId ?? asRepositoryId(`R_${suffix}`);
  return {
    ...repositoryViewFixture,
    repositoryId,
    fullName: `owner/${suffix}`,
    description: "An MCP agent toolkit",
    primaryLanguage: "TypeScript",
    licenseSpdxId: "Apache-2.0",
    topics: ["agent", "mcp"],
    listIds: [asUserListId("UL_1")],
    ...overrides,
  };
}

const STRING_FIELDS = {
  repository_id: "R_matrix",
  owner: "OpenAI",
  name: "SDK",
  full_name: "OpenAI/SDK",
  description: "An MCP agent toolkit",
  primary_language: "TypeScript",
  license_spdx_id: "Apache-2.0",
  visibility: "public",
} as const;

const NULLABLE_STRING_FIELDS = new Set([
  "description",
  "primary_language",
  "license_spdx_id",
]);

type FilterCase = readonly [label: string, input: unknown];

const stringCases: readonly FilterCase[] = Object.entries(
  STRING_FIELDS,
).flatMap(([field, actual]): readonly FilterCase[] => {
  const base = [
    [`${field}/eq`, { field, op: "eq", value: actual }],
    [`${field}/neq`, { field, op: "neq", value: `${actual}-other` }],
    [`${field}/contains`, { field, op: "contains", value: actual.slice(0, 2) }],
    [`${field}/in`, { field, op: "in", value: ["missing", actual] }],
    [`${field}/not_in`, { field, op: "not_in", value: ["missing", "other"] }],
  ] as const;
  return NULLABLE_STRING_FIELDS.has(field)
    ? [...base, [`${field}/is_null`, { field, op: "is_null", value: false }]]
    : base;
});

const scalarCases: readonly FilterCase[] = [
  ...stringCases,
  ["stargazer_count/eq", { field: "stargazer_count", op: "eq", value: 10 }],
  ["stargazer_count/neq", { field: "stargazer_count", op: "neq", value: 11 }],
  ["stargazer_count/lt", { field: "stargazer_count", op: "lt", value: 11 }],
  ["stargazer_count/lte", { field: "stargazer_count", op: "lte", value: 10 }],
  ["stargazer_count/gt", { field: "stargazer_count", op: "gt", value: 9 }],
  ["stargazer_count/gte", { field: "stargazer_count", op: "gte", value: 10 }],
  [
    "stargazer_count/in",
    { field: "stargazer_count", op: "in", value: [9, 10] },
  ],
  [
    "stargazer_count/not_in",
    { field: "stargazer_count", op: "not_in", value: [8, 9] },
  ],
  ["is_fork/eq", { field: "is_fork", op: "eq", value: false }],
  ["is_fork/neq", { field: "is_fork", op: "neq", value: true }],
  ["is_archived/eq", { field: "is_archived", op: "eq", value: false }],
  ["is_archived/neq", { field: "is_archived", op: "neq", value: true }],
  ["is_disabled/eq", { field: "is_disabled", op: "eq", value: false }],
  ["is_disabled/neq", { field: "is_disabled", op: "neq", value: true }],
  ["is_private/eq", { field: "is_private", op: "eq", value: false }],
  ["is_private/neq", { field: "is_private", op: "neq", value: true }],
  [
    "pushed_at/before",
    {
      field: "pushed_at",
      op: "before",
      value: "2026-07-17T00:00:00.000Z",
    },
  ],
  [
    "pushed_at/after",
    {
      field: "pushed_at",
      op: "after",
      value: "2026-07-15T00:00:00.000Z",
    },
  ],
  [
    "pushed_at/eq",
    {
      field: "pushed_at",
      op: "eq",
      value: "2026-07-16T00:00:00.000Z",
    },
  ],
  ["pushed_at/is_null", { field: "pushed_at", op: "is_null", value: false }],
  [
    "updated_at/before",
    {
      field: "updated_at",
      op: "before",
      value: "2026-07-17T00:00:00.000Z",
    },
  ],
  [
    "updated_at/after",
    {
      field: "updated_at",
      op: "after",
      value: "2026-07-16T00:30:00.000Z",
    },
  ],
  [
    "updated_at/eq",
    {
      field: "updated_at",
      op: "eq",
      value: "2026-07-16T01:00:00.000Z",
    },
  ],
  [
    "starred_at/before",
    {
      field: "starred_at",
      op: "before",
      value: "2026-07-16T00:00:00.000Z",
    },
  ],
  [
    "starred_at/after",
    {
      field: "starred_at",
      op: "after",
      value: "2026-07-15T00:00:00.000Z",
    },
  ],
  [
    "starred_at/eq",
    {
      field: "starred_at",
      op: "eq",
      value: "2026-07-15T12:00:00.000Z",
    },
  ],
  ["topics/contains", { field: "topics", op: "contains", value: "mcp" }],
  [
    "topics/not_contains",
    { field: "topics", op: "not_contains", value: "missing" },
  ],
  ["topics/in", { field: "topics", op: "in", value: ["missing", "mcp"] }],
  ["topics/not_in", { field: "topics", op: "not_in", value: ["missing"] }],
  ["topics/is_null", { field: "topics", op: "is_null", value: false }],
  ["list_ids/contains", { field: "list_ids", op: "contains", value: "UL_1" }],
  [
    "list_ids/not_contains",
    { field: "list_ids", op: "not_contains", value: "UL_missing" },
  ],
  [
    "list_ids/in",
    { field: "list_ids", op: "in", value: ["UL_missing", "UL_1"] },
  ],
  [
    "list_ids/not_in",
    { field: "list_ids", op: "not_in", value: ["UL_missing"] },
  ],
  ["list_ids/is_null", { field: "list_ids", op: "is_null", value: false }],
  ["is_unclassified/eq", { field: "is_unclassified", op: "eq", value: false }],
  ["is_unclassified/neq", { field: "is_unclassified", op: "neq", value: true }],
];

describe("closed repository filter language", () => {
  test.each(scalarCases)(
    "keeps evaluator and parameterized SQL equivalent for %s",
    (_label, input) => {
      const view = withView(
        {
          repositoryId: asRepositoryId("R_matrix"),
          owner: "OpenAI",
          name: "SDK",
          fullName: "OpenAI/SDK",
        },
        "matrix",
      );
      const filter = parseFilter(input);
      expect(matchesFilter(view, filter)).toBe(true);
      expect(sqlMatches(view, input)).toBe(true);
    },
  );

  test.each([
    [
      "description",
      { field: "description", op: "eq", value: "anything" },
      { description: null },
      false,
    ],
    [
      "nullable neq",
      { field: "description", op: "neq", value: "anything" },
      { description: null },
      false,
    ],
    [
      "nullable not_in",
      { field: "license_spdx_id", op: "not_in", value: ["MIT"] },
      { licenseSpdxId: null },
      false,
    ],
    [
      "negated nullable comparison",
      { not: { field: "description", op: "eq", value: "anything" } },
      { description: null },
      true,
    ],
    [
      "pushed null",
      { field: "pushed_at", op: "is_null", value: true },
      { pushedAt: null },
      true,
    ],
    [
      "topics empty",
      { field: "topics", op: "is_null", value: true },
      { topics: [] },
      true,
    ],
    [
      "lists empty",
      { field: "list_ids", op: "is_null", value: true },
      { listIds: [] },
      true,
    ],
    [
      "unclassified",
      { field: "is_unclassified", op: "eq", value: true },
      { listIds: [] },
      true,
    ],
    [
      "classified via neq",
      { field: "is_unclassified", op: "neq", value: false },
      { listIds: [] },
      true,
    ],
  ] as const)(
    "preserves SQL null/collection semantics for %s",
    (_label, input, overrides, expected) => {
      const view = withView(overrides, "nulls");
      expect(matchesFilter(view, parseFilter(input))).toBe(expected);
      expect(sqlMatches(view, input)).toBe(expected);
    },
  );

  test("evaluates recursive all, any, and not expressions", () => {
    const input = {
      all: [
        { field: "stargazer_count", op: "lt", value: 100 },
        {
          any: [
            { field: "owner", op: "eq", value: "OpenAI" },
            { field: "owner", op: "eq", value: "Other" },
          ],
        },
        { not: { field: "is_archived", op: "eq", value: true } },
      ],
    };
    const filter = parseFilter(input);
    const view = withView({ owner: "OpenAI" }, "recursive");
    expect(matchesFilter(view, filter)).toBe(true);
    expect(sqlMatches(view, input)).toBe(true);
  });

  test.each([
    ["unknown field", { field: "html_url", op: "eq", value: "x" }],
    ["unknown operator", { field: "owner", op: "like", value: "%" }],
    ["wrong scalar", { field: "owner", op: "eq", value: 1 }],
    ["wrong array", { field: "owner", op: "in", value: [1] }],
    ["empty array", { field: "owner", op: "in", value: [] }],
    ["nonfinite number", { field: "stargazer_count", op: "eq", value: NaN }],
    ["boolean mismatch", { field: "is_fork", op: "eq", value: 0 }],
    ["nonnull is_null", { field: "owner", op: "is_null", value: true }],
    ["nonnull timestamp", { field: "updated_at", op: "is_null", value: true }],
    ["invalid timestamp", { field: "pushed_at", op: "before", value: "later" }],
    [
      "offset timestamp",
      {
        field: "pushed_at",
        op: "before",
        value: "2026-07-16T08:00:00+08:00",
      },
    ],
    ["empty all", { all: [] }],
    ["empty any", { any: [] }],
    [
      "mixed node",
      {
        all: [{ field: "owner", op: "eq", value: "OpenAI" }],
        any: [{ field: "owner", op: "eq", value: "OpenAI" }],
      },
    ],
    [
      "extra leaf key",
      { field: "owner", op: "eq", value: "OpenAI", rawSql: "1=1" },
    ],
    ["not missing child", { not: undefined }],
    ["array root", []],
    ["null root", null],
  ] as const)("rejects %s", (_label, input) => {
    expectValidationError(() => parseFilter(input));
  });

  test("bounds recursive depth and leaf count", () => {
    let tooDeep: unknown = { field: "owner", op: "eq", value: "OpenAI" };
    for (let index = 0; index < 12; index += 1) tooDeep = { not: tooDeep };
    expectValidationError(() => parseFilter(tooDeep), /depth/iu);

    const tooMany = {
      all: Array.from({ length: 101 }, () => ({
        field: "owner",
        op: "eq",
        value: "OpenAI",
      })),
    };
    expectValidationError(() => parseFilter(tooMany), /100/iu);

    const sparseChildren = new Array<unknown>(1);
    expectValidationError(
      () => parseFilter({ all: sparseChildren }),
      /child|dense|sparse/iu,
    );
  });

  test("resolves injected relative times before returning a filter", () => {
    expect(
      parseFilter(
        {
          field: "pushed_at",
          op: "before",
          value: { ago: { amount: 3, unit: "years" } },
        },
        { now: "2026-07-16T00:00:00.000Z" },
      ),
    ).toEqual({
      field: "pushed_at",
      op: "before",
      value: "2023-07-16T00:00:00.000Z",
    });
    expect(
      parseFilter(
        {
          field: "updated_at",
          op: "after",
          value: { ago: { amount: 1, unit: "months" } },
        },
        { now: "2024-03-31T10:15:30.000Z" },
      ),
    ).toMatchObject({ value: "2024-02-29T10:15:30.000Z" });
    expect(
      parseFilter(
        {
          field: "starred_at",
          op: "after",
          value: { ago: { amount: 2, unit: "weeks" } },
        },
        { now: () => "2026-07-16T00:00:00.000Z" },
      ),
    ).toMatchObject({ value: "2026-07-02T00:00:00.000Z" });
    expect(
      parseFilter({
        field: "pushed_at",
        op: "eq",
        value: "2026-07-16T00:00:00.123456Z",
      }),
    ).toMatchObject({ value: "2026-07-16T00:00:00.123Z" });
  });

  test.each([
    [{ amount: 0, unit: "days" }, { now: "2026-07-16T00:00:00.000Z" }],
    [{ amount: 10_001, unit: "days" }, { now: "2026-07-16T00:00:00.000Z" }],
    [{ amount: 1.5, unit: "days" }, { now: "2026-07-16T00:00:00.000Z" }],
    [{ amount: 1, unit: "minutes" }, { now: "2026-07-16T00:00:00.000Z" }],
    [{ amount: 1, unit: "days" }, undefined],
    [{ amount: 1, unit: "days" }, { now: "invalid" }],
  ] as const)("rejects invalid relative time %#", (ago, context) => {
    expectValidationError(() =>
      parseFilter(
        { field: "pushed_at", op: "before", value: { ago } },
        context,
      ),
    );
  });

  test("keeps all caller text out of generated SQL", () => {
    const hostile = "x' OR 1=1 -- ? /*";
    for (const input of [
      { field: "owner", op: "eq", value: hostile },
      { field: "description", op: "contains", value: hostile },
      { field: "topics", op: "contains", value: hostile },
      { field: "list_ids", op: "in", value: [hostile] },
    ]) {
      const compiled = compileFilter(parseFilter(input));
      expect(compiled.sql).not.toContain(hostile);
      expect(compiled.params).toContain(hostile);
    }
  });
});

describe("stable repository sorts and keyset cursors", () => {
  test("deduplicates caller sorts and appends deterministic tie breakers", () => {
    expect(
      normalizeSort([
        { field: "stargazer_count", direction: "desc" },
        { field: "stargazer_count", direction: "asc" },
        { field: "pushed_at", direction: "desc" },
      ]),
    ).toEqual([
      { field: "stargazer_count", direction: "desc" },
      { field: "pushed_at", direction: "desc" },
      { field: "full_name", direction: "asc" },
      { field: "repository_id", direction: "asc" },
    ]);
    expectValidationError(() =>
      normalizeSort([
        { field: "owner", direction: "asc" },
      ] as unknown as readonly RepositorySort[]),
    );
    expectValidationError(() =>
      normalizeSort([
        { field: "full_name", direction: "sideways" },
      ] as unknown as readonly RepositorySort[]),
    );
  });

  test("uses explicit nulls-last ordering in both directions", () => {
    for (const direction of ["asc", "desc"] as const) {
      const order = compileOrder([{ field: "pushed_at", direction }]);
      expect(order).toContain(
        "CASE WHEN rv.pushed_at IS NULL THEN 1 ELSE 0 END ASC",
      );
      expect(order).toContain(
        `julianday(rv.pushed_at) ${direction.toUpperCase()}`,
      );
      expect(order).toContain("rv.full_name ASC");
      expect(order).toContain("ss.repository_id ASC");
    }
  });

  test("matches SQLite order across nulls, ties, and stable IDs", () => {
    const views = [
      withView(
        {
          repositoryId: asRepositoryId("R_2"),
          fullName: "same/name",
          stargazerCount: 10,
          pushedAt: "2026-07-16T00:00:00Z",
        },
        "2",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_1"),
          fullName: "same/name",
          stargazerCount: 10,
          pushedAt: "2026-07-16T00:00:00.000Z",
        },
        "1",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_3"),
          fullName: "other/name",
          stargazerCount: 10,
          pushedAt: null,
        },
        "3",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_4"),
          fullName: "last/name",
          stargazerCount: 9,
          pushedAt: "2026-07-17T00:00:00Z",
        },
        "4",
      ),
    ];
    const sort = [
      { field: "stargazer_count", direction: "desc" },
      { field: "pushed_at", direction: "desc" },
    ] as const;
    const memoryOrder = [...views]
      .sort((left, right) => compareRepositories(left, right, sort))
      .map((view) => view.repositoryId);
    const database = createDatabase(views);
    try {
      const sqlOrder = (
        database
          .prepare(
            `SELECT ss.repository_id AS repositoryId
             FROM repository_versions rv
             JOIN snapshot_stars ss ON ss.repository_id = rv.repository_id
             ORDER BY ${compileOrder(sort)}`,
          )
          .all() as { repositoryId: string }[]
      ).map((row) => row.repositoryId);
      expect(sqlOrder).toEqual(memoryOrder);
      expect(memoryOrder).toEqual(["R_1", "R_2", "R_3", "R_4"]);
    } finally {
      database.close();
    }
  });

  test("paginates after null and duplicate boundaries without gaps", () => {
    const sort = [
      { field: "stargazer_count", direction: "desc" },
      { field: "pushed_at", direction: "desc" },
    ] as const;
    const views = [
      withView(
        {
          repositoryId: asRepositoryId("R_A"),
          fullName: "same/name",
          stargazerCount: 10,
          pushedAt: "2026-07-16T00:00:00Z",
        },
        "A",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_B"),
          fullName: "same/name",
          stargazerCount: 10,
          pushedAt: "2026-07-16T00:00:00Z",
        },
        "B",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_C"),
          fullName: "null/name",
          stargazerCount: 10,
          pushedAt: null,
        },
        "C",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_D"),
          fullName: "null/name",
          stargazerCount: 10,
          pushedAt: null,
        },
        "D",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_E"),
          fullName: "lower/name",
          stargazerCount: 9,
          pushedAt: "2026-07-17T00:00:00Z",
        },
        "E",
      ),
    ].sort((left, right) => compareRepositories(left, right, sort));
    const filterHash = hashFilter(null);
    const sortHash = hashRepositorySort(sort);
    const database = createDatabase(views);
    try {
      for (const boundary of [1, 2, 3, 4]) {
        const position = repositoryCursorPosition(views[boundary]!, sort);
        const cursor = encodeRepositoryCursor({
          kind: "repositories",
          snapshotId: SNAPSHOT_ID,
          filterHash,
          sortHash,
          ...position,
        });
        const compiled = compileCursor(sort, cursor);
        const actual = (
          database
            .prepare(
              `SELECT ss.repository_id AS repositoryId
               FROM repository_versions rv
               JOIN snapshot_stars ss ON ss.repository_id = rv.repository_id
               WHERE ${compiled.sql}
               ORDER BY ${compileOrder(sort)}`,
            )
            .all(...compiled.params) as { repositoryId: string }[]
        ).map((row) => row.repositoryId);
        expect(actual).toEqual(
          views.slice(boundary + 1).map((view) => view.repositoryId),
        );
      }
      const finalPosition = repositoryCursorPosition(views.at(-1)!, sort);
      const finalCursor = encodeRepositoryCursor({
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
        ...finalPosition,
      });
      const finalCompiled = compileCursor(sort, finalCursor);
      expect(
        database
          .prepare(
            `SELECT 1
             FROM repository_versions rv
             JOIN snapshot_stars ss ON ss.repository_id = rv.repository_id
             WHERE ${finalCompiled.sql}`,
          )
          .all(...finalCompiled.params),
      ).toEqual([]);
      expect(compileCursor(sort, null)).toEqual({ sql: "1 = 1", params: [] });
    } finally {
      database.close();
    }
  });
});

describe("versioned bound cursors", () => {
  const filterHash = "f".repeat(64);
  const sortHash = "s".repeat(64);
  const selectionHash = "l".repeat(64);

  function repositoryCursor(): string {
    return encodeRepositoryCursor({
      kind: "repositories",
      snapshotId: SNAPSHOT_ID,
      filterHash,
      sortHash,
      values: [12, null],
      nulls: [false, true],
      repositoryId: asRepositoryId("R_9"),
    });
  }

  test("round-trips canonical repository and list cursors", () => {
    const cursor = repositoryCursor();
    expect(
      decodeRepositoryCursor(cursor, {
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
      }),
    ).toMatchObject({
      v: 1,
      kind: "repositories",
      values: [12, null],
      nulls: [false, true],
      repositoryId: "R_9",
    });

    const listCursor = encodeListCursor({
      kind: "lists",
      snapshotId: SNAPSHOT_ID,
      selectionHash,
      values: ["agents", "2026-07-16T00:00:00.000Z"],
      listId: asUserListId("UL_1"),
    });
    expect(
      decodeListCursor(listCursor, {
        kind: "lists",
        snapshotId: SNAPSHOT_ID,
        selectionHash,
      }),
    ).toMatchObject({
      v: 1,
      kind: "lists",
      values: ["agents", "2026-07-16T00:00:00.000Z"],
      listId: "UL_1",
    });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(listCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  test.each([
    [
      "snapshot",
      {
        kind: "repositories",
        snapshotId: asSnapshotId("snap_2"),
        filterHash,
        sortHash,
      },
    ],
    [
      "filter",
      {
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash: "x".repeat(64),
        sortHash,
      },
    ],
    [
      "sort",
      {
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash: "x".repeat(64),
      },
    ],
  ] as const)(
    "rejects repository cursor reuse across %s",
    (boundary, expected) => {
      expectValidationError(
        () => decodeRepositoryCursor(repositoryCursor(), expected),
        new RegExp(`cursor.*${boundary}`, "iu"),
      );
    },
  );

  test("rejects resource reuse, corruption, noncanonical JSON, and oversized data", () => {
    const cursor = repositoryCursor();
    const changed = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    expectValidationError(() =>
      decodeRepositoryCursor(changed, {
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
      }),
    );

    const listCursor = encodeListCursor({
      kind: "lists",
      snapshotId: SNAPSHOT_ID,
      selectionHash,
      values: ["agents"],
      listId: asUserListId("UL_1"),
    });
    expectValidationError(() =>
      decodeRepositoryCursor(listCursor, {
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
      }),
    );

    const noncanonical = Buffer.from(
      JSON.stringify({
        kind: "repositories",
        v: 1,
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
        values: [12, null],
        nulls: [false, true],
        repositoryId: "R_9",
      }),
    ).toString("base64url");
    expectValidationError(() =>
      decodeRepositoryCursor(noncanonical, {
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
      }),
    );

    expectValidationError(() =>
      encodeRepositoryCursor({
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
        values: ["x".repeat(5_000)],
        nulls: [false],
        repositoryId: asRepositoryId("R_9"),
      }),
    );
  });

  test("rejects malformed marker/value pairs and wrong list selections", () => {
    expectValidationError(() =>
      encodeRepositoryCursor({
        kind: "repositories",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
        values: [null],
        nulls: [false],
        repositoryId: asRepositoryId("R_9"),
      }),
    );
    const listCursor = encodeListCursor({
      kind: "lists",
      snapshotId: SNAPSHOT_ID,
      selectionHash,
      values: ["agents"],
      listId: asUserListId("UL_1"),
    });
    expectValidationError(
      () =>
        decodeListCursor(listCursor, {
          kind: "lists",
          snapshotId: SNAPSHOT_ID,
          selectionHash: "x".repeat(64),
        }),
      /cursor.*selection/iu,
    );
  });

  test("rejects non-v1, cross-resource, and extended encode inputs", () => {
    const validInput = {
      kind: "repositories",
      snapshotId: SNAPSHOT_ID,
      filterHash,
      sortHash,
      values: [12],
      nulls: [false],
      repositoryId: asRepositoryId("R_9"),
    } as const;
    for (const input of [
      { ...validInput, v: 2 },
      { ...validInput, kind: "lists" },
      { ...validInput, rawSql: "1=1" },
    ]) {
      expectValidationError(() =>
        encodeRepositoryCursor(
          input as unknown as Parameters<typeof encodeRepositoryCursor>[0],
        ),
      );
    }
    expectValidationError(() =>
      decodeRepositoryCursor(repositoryCursor(), {
        kind: "lists",
        snapshotId: SNAPSHOT_ID,
        filterHash,
        sortHash,
      } as unknown as Parameters<typeof decodeRepositoryCursor>[1]),
    );
  });

  test("computes canonical filter, sort, and selection hashes", () => {
    const relative = parseFilter(
      {
        field: "pushed_at",
        op: "before",
        value: { ago: { amount: 1, unit: "years" } },
      },
      { now: "2026-07-16T00:00:00.000Z" },
    );
    const absolute = parseFilter({
      field: "pushed_at",
      op: "before",
      value: "2025-07-16T00:00:00.000Z",
    });
    expect(hashFilter(relative)).toBe(hashFilter(absolute));
    expect(hashFilter(relative)).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      hashRepositorySort([
        ...DEFAULT_SORT,
        { field: "stargazer_count", direction: "asc" },
      ]),
    ).toBe(hashRepositorySort(DEFAULT_SORT));
    expect(hashListSelection({ b: 2, a: 1 })).toBe(
      hashListSelection({ a: 1, b: 2 }),
    );
  });

  test("rejects a cursor compiled against a different normalized sort", () => {
    const sort = [{ field: "full_name", direction: "asc" }] as const;
    const position = repositoryCursorPosition(repositoryViewFixture, sort);
    const cursor = encodeRepositoryCursor({
      kind: "repositories",
      snapshotId: SNAPSHOT_ID,
      filterHash: hashFilter(null),
      sortHash: hashRepositorySort(sort),
      ...position,
    });
    expectValidationError(
      () => compileCursor([{ field: "full_name", direction: "desc" }], cursor),
      /cursor.*sort/iu,
    );
  });
});
