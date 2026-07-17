import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import {
  assertValidatedListMembershipCursorPayload,
  createCursorCodec,
  hashFilter,
  hashListSelection,
  hashRepositorySort,
} from "../../../src/domain/cursor.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
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
  parseRepositoryQuery,
  repositoryCursorPosition,
  type FilterExpression,
  type RepositorySort,
} from "../../../src/domain/filter.js";
import type { RepositoryFilterView } from "../../../src/domain/repository.js";
import { canonicalUtcTimestamp } from "../../../src/domain/timestamp.js";
import {
  compileCursor,
  compileFilter,
  compileOrder,
} from "../../../src/storage/filter-sql.js";
import { repositoryViewFixture } from "../../fixtures/domain.js";

const SNAPSHOT_ID = asSnapshotId("snap_1");
const DEFAULT_SORT = [{ field: "stargazer_count", direction: "desc" }] as const;
const CURSOR_CODEC = createCursorCodec(new Uint8Array(32).fill(3));

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

function createDatabase(
  views: readonly RepositoryFilterView[],
): Database.Database {
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

function sqlMatches(view: RepositoryFilterView, input: unknown): boolean {
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
  overrides: Partial<RepositoryFilterView>,
  suffix = "case",
): RepositoryFilterView {
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

  test("deep-freezes canonical nested filters returned in repository queries", () => {
    const query = parseRepositoryQuery({
      snapshotId: SNAPSHOT_ID,
      filter: {
        all: [
          {
            any: [
              {
                not: {
                  field: "is_archived",
                  op: "eq",
                  value: true,
                },
              },
            ],
          },
          {
            field: "owner",
            op: "in",
            value: ["Other", "OpenAI"],
          },
        ],
      },
      sort: [],
      pageSize: 10,
      cursor: null,
    });
    const filter = query.filter as Extract<
      FilterExpression,
      { readonly all: readonly FilterExpression[] }
    >;
    const anyNode = filter.all[0] as Extract<
      FilterExpression,
      { readonly any: readonly FilterExpression[] }
    >;
    const notNode = anyNode.any[0] as Extract<
      FilterExpression,
      { readonly not: FilterExpression }
    >;
    const setLeaf = filter.all[1] as {
      readonly field: "owner";
      readonly op: "in";
      readonly value: readonly string[];
    };
    const setValues = setLeaf.value;

    expect(
      [
        query,
        query.sort,
        filter,
        filter.all,
        anyNode,
        anyNode.any,
        notNode,
        notNode.not,
        setLeaf,
        setValues,
      ].every((value) => Object.isFrozen(value)),
    ).toBe(true);
    expect(setValues).toEqual(["OpenAI", "Other"]);
    expect(() =>
      (filter.all as FilterExpression[]).push({
        field: "owner",
        op: "eq",
        value: "mutated",
      }),
    ).toThrow(TypeError);
    expect(() => (setValues as string[]).push("mutated")).toThrow(TypeError);
    expect(() => Object.assign(notNode.not, { value: false })).toThrow(
      TypeError,
    );
    expect(
      matchesFilter(withView({ owner: "OpenAI" }, "immutable"), filter),
    ).toBe(true);
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
    expectValidationError(() =>
      parseFilter({
        field: "pushed_at",
        op: "eq",
        value: "2026-07-16T00:00:00.123456Z",
      }),
    );
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
      expect(
        compiled.params.some((parameter) =>
          String(parameter).includes(hostile),
        ),
      ).toBe(true);
    }
  });

  test("normalizes bounded sets and compiles each through one JSON bind", () => {
    const stringSet = parseFilter({
      field: "owner",
      op: "in",
      value: ["\u{10000}", "é", "a", "\uE000", "é"],
    });
    expect(stringSet).toEqual({
      field: "owner",
      op: "in",
      value: ["a", "é", "\uE000", "\u{10000}"],
    });
    expect(
      parseFilter({
        field: "stargazer_count",
        op: "not_in",
        value: [10, -2, 10, 1],
      }),
    ).toEqual({
      field: "stargazer_count",
      op: "not_in",
      value: [-2, 1, 10],
    });

    for (const input of [
      { field: "owner", op: "in", value: ["OpenAI", "Other"] },
      { field: "stargazer_count", op: "not_in", value: [8, 9] },
      { field: "topics", op: "in", value: ["mcp", "agent"] },
      { field: "list_ids", op: "not_in", value: ["UL_2", "UL_3"] },
    ]) {
      const compiled = compileFilter(parseFilter(input));
      expect(compiled.sql).toContain("json_each(?)");
      expect(compiled.params).toHaveLength(1);
      expect(JSON.parse(String(compiled.params[0]))).toBeInstanceOf(Array);
    }
  });

  test("accepts and executes 5,000 set members with bounded SQL parameters", () => {
    const values = Array.from(
      { length: 4_999 },
      (_, index) => `owner-${index}`,
    );
    values.push("OpenAI");
    const input = { field: "owner", op: "in", value: values };
    const filter = parseFilter(input);
    const compiled = compileFilter(filter);

    expect(compiled.params).toHaveLength(1);
    expect(compiled.sql.match(/\?/gu)).toHaveLength(1);
    expect(sqlMatches(withView({ owner: "OpenAI" }, "large-set"), input)).toBe(
      true,
    );
  });

  test("rejects oversized individual and aggregate filter sets", () => {
    expectValidationError(
      () =>
        parseFilter({
          field: "owner",
          op: "in",
          value: Array.from({ length: 5_001 }, (_, index) => `owner-${index}`),
        }),
      /5,?000|set/iu,
    );

    expectValidationError(
      () =>
        parseFilter({
          all: [
            {
              field: "owner",
              op: "in",
              value: Array.from(
                { length: 5_000 },
                (_, index) => `owner-${index}`,
              ),
            },
            {
              field: "topics",
              op: "not_in",
              value: Array.from(
                { length: 5_000 },
                (_, index) => `topic-${index}`,
              ),
            },
            { field: "list_ids", op: "in", value: ["UL_over_budget"] },
          ],
        }),
      /10,?000|set/iu,
    );
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
          pushedAt: "2026-07-16T00:00:00.000Z",
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
          pushedAt: "2026-07-17T00:00:00.000Z",
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
          pushedAt: "2026-07-16T00:00:00.000Z",
        },
        "A",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_B"),
          fullName: "same/name",
          stargazerCount: 10,
          pushedAt: "2026-07-16T00:00:00.000Z",
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
          pushedAt: "2026-07-17T00:00:00.000Z",
        },
        "E",
      ),
    ].sort((left, right) => compareRepositories(left, right, sort));
    const filterHash = hashFilter(null);
    const cursorContext = {
      kind: "repositories",
      snapshotId: SNAPSHOT_ID,
      filterHash,
      sort,
    } as const;
    const database = createDatabase(views);
    try {
      for (const boundary of [1, 2, 3, 4]) {
        const position = repositoryCursorPosition(views[boundary]!, sort);
        const cursor = CURSOR_CODEC.encodeRepository(cursorContext, position);
        const compiled = compileCursor(
          sort,
          CURSOR_CODEC.decodeRepository(cursor, cursorContext),
        );
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
      const finalCursor = CURSOR_CODEC.encodeRepository(
        cursorContext,
        finalPosition,
      );
      const finalCompiled = compileCursor(
        sort,
        CURSOR_CODEC.decodeRepository(finalCursor, cursorContext),
      );
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

describe("authenticated versioned cursors", () => {
  const filterHash = "f".repeat(64);
  const sort = [
    { field: "stargazer_count", direction: "desc" },
    { field: "pushed_at", direction: "asc" },
  ] as const;
  const repositoryContext = {
    kind: "repositories",
    snapshotId: SNAPSHOT_ID,
    filterHash,
    sort,
  } as const;
  const listContext = {
    v: 1,
    kind: "lists",
    snapshotId: SNAPSHOT_ID,
  } as const;

  function repositoryCursor(): string {
    return CURSOR_CODEC.encodeRepository(repositoryContext, {
      values: [12, null, "openai/sdk"],
      nulls: [false, true, false],
      repositoryId: asRepositoryId("R_9"),
    });
  }

  test("round-trips canonical repository and list cursors", () => {
    const cursor = repositoryCursor();
    expect(
      CURSOR_CODEC.decodeRepository(cursor, repositoryContext),
    ).toMatchObject({
      v: 1,
      kind: "repositories",
      values: [12, null, "openai/sdk"],
      nulls: [false, true, false],
      repositoryId: "R_9",
    });

    const listCursor = CURSOR_CODEC.encodeList(listContext, {
      values: ["agents", "2026-07-16T00:00:00.000Z"],
      listId: asUserListId("UL_1"),
    });
    expect(CURSOR_CODEC.decodeList(listCursor, listContext)).toMatchObject({
      v: 1,
      kind: "lists",
      values: ["agents", "2026-07-16T00:00:00.000Z"],
      listId: "UL_1",
    });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(listCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  test.each([
    ["snapshot", { ...repositoryContext, snapshotId: asSnapshotId("snap_2") }],
    ["filter", { ...repositoryContext, filterHash: "a".repeat(64) }],
    [
      "sort",
      {
        ...repositoryContext,
        sort: [{ field: "full_name", direction: "desc" }] as const,
      },
    ],
  ] as const)(
    "rejects repository cursor reuse across %s",
    (boundary, expected) => {
      expectValidationError(
        () => CURSOR_CODEC.decodeRepository(repositoryCursor(), expected),
        new RegExp(`cursor.*${boundary}`, "iu"),
      );
    },
  );

  test("rejects resource reuse, corruption, noncanonical JSON, and oversized data", () => {
    const cursor = repositoryCursor();
    const changed = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    expectValidationError(() =>
      CURSOR_CODEC.decodeRepository(changed, repositoryContext),
    );

    const listCursor = CURSOR_CODEC.encodeList(listContext, {
      values: ["agents"],
      listId: asUserListId("UL_1"),
    });
    expectValidationError(() =>
      CURSOR_CODEC.decodeRepository(listCursor, repositoryContext),
    );

    const noncanonical = Buffer.from(
      JSON.stringify({
        payload: { kind: "repositories", v: 1 },
        mac: "0".repeat(64),
      }),
    ).toString("base64url");
    expectValidationError(() =>
      CURSOR_CODEC.decodeRepository(noncanonical, repositoryContext),
    );

    expectValidationError(() =>
      CURSOR_CODEC.encodeRepository(repositoryContext, {
        values: [12, null, "x".repeat(5_000)],
        nulls: [false, true, false],
        repositoryId: asRepositoryId("R_9"),
      }),
    );
  });

  test("rejects malformed marker/value pairs and wrong list selections", () => {
    expectValidationError(() =>
      CURSOR_CODEC.encodeRepository(repositoryContext, {
        values: [12, null, "openai/sdk"],
        nulls: [false, false, false],
        repositoryId: asRepositoryId("R_9"),
      }),
    );
    const listCursor = CURSOR_CODEC.encodeList(listContext, {
      values: ["agents"],
      listId: asUserListId("UL_1"),
    });
    expectValidationError(() =>
      CURSOR_CODEC.decodeList(listCursor, {
        ...listContext,
        snapshotId: asSnapshotId("snap_other"),
      }),
    );
  });

  test("rejects cross-resource and extended encode inputs", () => {
    expectValidationError(() =>
      CURSOR_CODEC.encodeRepository(
        { ...repositoryContext, rawSql: "1=1" } as typeof repositoryContext,
        {
          values: [12, null, "openai/sdk"],
          nulls: [false, true, false],
          repositoryId: asRepositoryId("R_9"),
        },
      ),
    );
    expectValidationError(() =>
      CURSOR_CODEC.decodeRepository(repositoryCursor(), {
        ...repositoryContext,
        kind: "lists",
      } as unknown as typeof repositoryContext),
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

  test("locks derived List selection hashes and runtime-brands membership cursors", () => {
    const listCursor = CURSOR_CODEC.encodeList(
      { v: 1, kind: "lists", snapshotId: SNAPSHOT_ID },
      { values: ["AI"], listId: asUserListId("L_1") },
    );
    const listEnvelope = JSON.parse(
      Buffer.from(listCursor, "base64url").toString("utf8"),
    ) as { payload: { selectionHash: string } };
    expect(listEnvelope.payload.selectionHash).toBe(
      "ebacad18c114f59f8b4a83de0dd9a0d62b4b336beccaaa64a36fbe7f5ea17230",
    );

    const listMembershipContext = {
      v: 1,
      kind: "list_memberships",
      snapshotId: SNAPSHOT_ID,
      selector: { kind: "list", listId: asUserListId("L_1") },
    } as const;
    const listMembershipCursor = CURSOR_CODEC.encodeListMembership(
      listMembershipContext,
      {
        selector: listMembershipContext.selector,
        boundaryRepositoryId: asRepositoryId("R_1"),
      },
    );
    const listMembership = CURSOR_CODEC.decodeListMembership(
      listMembershipCursor,
      listMembershipContext,
    );
    expect(listMembership.selectionHash).toBe(
      "0ca224c01b214e4f2b666ebad73a4031237f8623aa9a5da850d9c13394ee76b9",
    );
    expect(() =>
      assertValidatedListMembershipCursorPayload(listMembership),
    ).not.toThrow();
    expectValidationError(() =>
      assertValidatedListMembershipCursorPayload({ ...listMembership }),
    );

    const repositoryMembershipContext = {
      v: 1,
      kind: "list_memberships",
      snapshotId: SNAPSHOT_ID,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
    } as const;
    const repositoryMembershipCursor = CURSOR_CODEC.encodeListMembership(
      repositoryMembershipContext,
      {
        selector: repositoryMembershipContext.selector,
        boundaryListId: asUserListId("L_1"),
      },
    );
    expect(
      CURSOR_CODEC.decodeListMembership(
        repositoryMembershipCursor,
        repositoryMembershipContext,
      ).selectionHash,
    ).toBe("44f61d13268a2be2b6b420fe28536027f1ce9f6f05c62e9753cd4ad64bf992f9");
    expectValidationError(() =>
      CURSOR_CODEC.decodeListMembership(
        listMembershipCursor,
        repositoryMembershipContext,
      ),
    );
  });
});

describe("review hardening regressions", () => {
  const signingKey = new Uint8Array(32).fill(7);
  const codec = createCursorCodec(signingKey);
  const repositoryContext = {
    kind: "repositories",
    snapshotId: SNAPSHOT_ID,
    filterHash: "f".repeat(64),
    sort: [
      { field: "stargazer_count", direction: "desc" },
      { field: "pushed_at", direction: "asc" },
    ],
  } as const;
  const repositoryPosition = {
    values: [12, null, "openai/sdk"],
    nulls: [false, true, false],
    repositoryId: asRepositoryId("R_9"),
  } as const;

  function resignRepositoryCursor(
    cursor: string,
    mutate: (payload: {
      values: (string | number | null)[];
      nulls: boolean[];
    }) => void,
  ): string {
    const envelope = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as {
      mac: string;
      payload: {
        values: (string | number | null)[];
        nulls: boolean[];
      };
    };
    mutate(envelope.payload);
    envelope.mac = createHmac("sha256", signingKey)
      .update(JSON.stringify(envelope.payload))
      .digest("hex");
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  }

  test("authenticates canonical cursors and rejects re-encoded payload mutations", () => {
    const cursor = codec.encodeRepository(
      repositoryContext,
      repositoryPosition,
    );
    const decoded = codec.decodeRepository(cursor, repositoryContext);
    expect(decoded).toMatchObject(repositoryPosition);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.values)).toBe(true);

    const envelope = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as {
      mac: string;
      payload: { repositoryId: string };
    };
    envelope.payload.repositoryId = "R_ATTACKER";
    const changed = Buffer.from(JSON.stringify(envelope), "utf8").toString(
      "base64url",
    );
    expectValidationError(
      () => codec.decodeRepository(changed, repositoryContext),
      /cursor.*authentic/iu,
    );
  });

  test("requires complete decode context and a runtime-branded compiler payload", () => {
    const cursor = codec.encodeRepository(
      repositoryContext,
      repositoryPosition,
    );
    for (const context of [
      { ...repositoryContext, snapshotId: asSnapshotId("snap_2") },
      { ...repositoryContext, filterHash: "a".repeat(64) },
      {
        ...repositoryContext,
        sort: [{ field: "full_name", direction: "desc" }] as const,
      },
    ]) {
      expectValidationError(() => codec.decodeRepository(cursor, context));
    }

    const decoded = codec.decodeRepository(cursor, repositoryContext);
    expect(() => compileCursor(repositoryContext.sort, decoded)).not.toThrow();
    expectValidationError(() =>
      compileCursor(repositoryContext.sort, { ...decoded }),
    );
    expectValidationError(
      () => compileCursor([{ field: "full_name", direction: "desc" }], decoded),
      /cursor.*sort/iu,
    );
  });

  test("never invokes accessors while normalizing sorts or encoding cursors", () => {
    let directionGetterCalls = 0;
    const sortTerm = Object.defineProperties(
      {},
      {
        field: { enumerable: true, value: "full_name" },
        direction: {
          enumerable: true,
          get() {
            directionGetterCalls += 1;
            return directionGetterCalls === 1
              ? "asc"
              : "ASC; DROP TABLE repository_versions; --";
          },
        },
      },
    );
    expectValidationError(() =>
      compileOrder([sortTerm] as unknown as readonly RepositorySort[]),
    );
    expect(directionGetterCalls).toBe(0);

    let valueGetterCalls = 0;
    const values = [12, null, "openai/sdk"];
    Object.defineProperty(values, 0, {
      enumerable: true,
      get() {
        valueGetterCalls += 1;
        return 12;
      },
    });
    expectValidationError(() =>
      codec.encodeRepository(repositoryContext, {
        ...repositoryPosition,
        values,
      }),
    );
    expect(valueGetterCalls).toBe(0);

    let contextGetterCalls = 0;
    const accessorContext = Object.defineProperties(
      {},
      {
        kind: { enumerable: true, value: "repositories" },
        snapshotId: { enumerable: true, value: SNAPSHOT_ID },
        filterHash: {
          enumerable: true,
          get() {
            contextGetterCalls += 1;
            return "f".repeat(64);
          },
        },
        sort: { enumerable: true, value: repositoryContext.sort },
      },
    );
    expectValidationError(() =>
      codec.encodeRepository(
        accessorContext as typeof repositoryContext,
        repositoryPosition,
      ),
    );
    expect(contextGetterCalls).toBe(0);
  });

  test("rejects short and hostile signing keys without disclosing key material", () => {
    const shortKey = new Uint8Array(31).fill(0xab);
    let failure: unknown;
    try {
      createCursorCodec(shortKey);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    const serialized = JSON.stringify(serializeError(failure));
    expect(serialized).toContain("VALIDATION_ERROR");
    expect(serialized).not.toContain(Buffer.from(shortKey).toString("hex"));
    expect(serialized).not.toContain([...shortKey].join(","));

    const hostile = Proxy.revocable(new Uint8Array(32).fill(0xcd), {});
    hostile.revoke();
    expectValidationError(() => createCursorCodec(hostile.proxy));

    const detachedKey = new Uint8Array(32).fill(0xdd);
    structuredClone(detachedKey, { transfer: [detachedKey.buffer] });
    expectValidationError(() => createCursorCodec(detachedKey));

    const mutableKey = new Uint8Array(32).fill(0x19);
    const copiedKeyCodec = createCursorCodec(mutableKey);
    mutableKey.fill(0x20);
    const listContext = {
      v: 1,
      kind: "lists",
      snapshotId: SNAPSHOT_ID,
    } as const;
    const cursor = copiedKeyCodec.encodeList(listContext, {
      values: ["agents"],
      listId: asUserListId("UL_KEY"),
    });
    expect(() =>
      createCursorCodec(new Uint8Array(32).fill(0x19)).decodeList(
        cursor,
        listContext,
      ),
    ).not.toThrow();
  });

  test("uses intrinsic key length and rejects forged typed-array metadata", () => {
    class LyingShortKey extends Uint8Array {
      override get byteLength(): number {
        return 64;
      }

      override get length(): number {
        return 64;
      }
    }
    class LyingFullKey extends Uint8Array {
      override get byteLength(): number {
        return 0;
      }

      override get length(): number {
        return 0;
      }
    }

    expectValidationError(() => createCursorCodec(new LyingShortKey(8)));
    expect(() => createCursorCodec(new LyingFullKey(32))).not.toThrow();
  });

  test("copies signing keys outside Buffer slabs without retaining source bytes", () => {
    const pooledKey = Buffer.allocUnsafe(32).fill(0x6d);
    expect(pooledKey.buffer.byteLength).toBeGreaterThan(pooledKey.byteLength);
    const bufferFrom = vi.spyOn(Buffer, "from");
    let isolatedCodec: ReturnType<typeof createCursorCodec>;
    try {
      isolatedCodec = createCursorCodec(pooledKey);
      expect(bufferFrom).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
    }

    pooledKey.fill(0);
    const listContext = {
      v: 1,
      kind: "lists",
      snapshotId: SNAPSHOT_ID,
    } as const;
    const cursor = isolatedCodec.encodeList(listContext, {
      values: ["isolated"],
      listId: asUserListId("UL_ISOLATED"),
    });
    expect(() =>
      createCursorCodec(new Uint8Array(32).fill(0x6d)).decodeList(
        cursor,
        listContext,
      ),
    ).not.toThrow();
  });

  test("rejects proxies, custom prototypes, cycles, and invalid canonical values", () => {
    const { proxy, revoke } = Proxy.revocable(
      [{ field: "full_name", direction: "asc" }],
      {},
    );
    revoke();
    expectValidationError(() =>
      normalizeSort(proxy as readonly RepositorySort[]),
    );
    expectValidationError(() =>
      normalizeSort([
        Object.create(
          { inherited: true },
          {
            field: { enumerable: true, value: "full_name" },
            direction: { enumerable: true, value: "asc" },
          },
        ),
      ] as readonly RepositorySort[]),
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectValidationError(() => hashListSelection(cyclic as never));
    expectValidationError(() =>
      hashListSelection({ invalid: undefined } as never),
    );
    expectValidationError(() => hashListSelection({ invalid: Number.NaN }));

    let deeplyNested: unknown = {};
    for (let index = 0; index < 1_000; index += 1) {
      deeplyNested = { child: deeplyNested };
    }
    expectValidationError(() => hashListSelection(deeplyNested as never));
  });

  test("uses strict millisecond UTC timestamps and bounded relative arithmetic", () => {
    expect(canonicalUtcTimestamp("2026-07-16T00:00:00Z")).toBe(
      "2026-07-16T00:00:00.000Z",
    );
    expect(canonicalUtcTimestamp("2026-07-16T00:00:00.1Z")).toBe(
      "2026-07-16T00:00:00.100Z",
    );
    for (const timestamp of [
      "2026-07-16T00:00:00.1234Z",
      "2026-07-16T00:00:00.1235Z",
      "2026-07-16T00:00:00.9999Z",
      "2026-02-29T00:00:00Z",
      "2026-07-16T08:00:00+08:00",
      "-000001-01-01T00:00:00.000Z",
      "+010000-01-01T00:00:00.000Z",
    ]) {
      expectValidationError(() => canonicalUtcTimestamp(timestamp));
    }
    expectValidationError(() =>
      parseFilter(
        {
          field: "pushed_at",
          op: "before",
          value: { ago: { amount: 1, unit: "years" } },
        },
        { now: "0000-01-01T00:00:00.000Z" },
      ),
    );
  });

  test("requires canonical temporal positions and nonnegative safe stargazers", () => {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectValidationError(() =>
        codec.encodeRepository(repositoryContext, {
          ...repositoryPosition,
          values: [invalid, null, "openai/sdk"],
        }),
      );
    }
    for (const invalid of [
      "Thu, 01 Jan 1970 00:00:00 GMT",
      "0",
      "2026-07-16T00:00:00Z",
      "2026-07-16T00:00:00.1234Z",
    ]) {
      expectValidationError(() =>
        codec.encodeRepository(repositoryContext, {
          ...repositoryPosition,
          values: [12, invalid, "openai/sdk"],
          nulls: [false, false, false],
        }),
      );
    }

    const validCursor = codec.encodeRepository(
      repositoryContext,
      repositoryPosition,
    );
    for (const invalid of [
      "Thu, 01 Jan 1970 00:00:00 GMT",
      "0",
      "2026-07-16T00:00:00Z",
      "2026-07-16T00:00:00.1234Z",
    ]) {
      const signedMalformed = resignRepositoryCursor(validCursor, (payload) => {
        payload.values[1] = invalid;
        payload.nulls[1] = false;
      });
      expectValidationError(() =>
        codec.decodeRepository(signedMalformed, repositoryContext),
      );
    }
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const signedMalformed = resignRepositoryCursor(validCursor, (payload) => {
        payload.values[0] = invalid;
      });
      expectValidationError(() =>
        codec.decodeRepository(signedMalformed, repositoryContext),
      );
    }
  });

  test("matches SQLite BINARY UTF-8 ordering for non-BMP text", () => {
    const supplementary = withView(
      { repositoryId: asRepositoryId("R_UTF8_A"), fullName: "\u{10000}" },
      "UTF8_A",
    );
    const privateUse = withView(
      { repositoryId: asRepositoryId("R_UTF8_B"), fullName: "\uE000" },
      "UTF8_B",
    );
    const sort = [{ field: "full_name", direction: "asc" }] as const;
    expect(
      compareRepositories(supplementary, privateUse, sort),
    ).toBeGreaterThan(0);

    const database = createDatabase([supplementary, privateUse]);
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
      const memoryOrder = [supplementary, privateUse]
        .sort((left, right) => compareRepositories(left, right, sort))
        .map((view) => view.repositoryId);
      expect(memoryOrder).toEqual(sqlOrder);
    } finally {
      database.close();
    }
  });

  test("canonicalizes manually constructed temporal views for ordering and cursors", () => {
    const views = [
      withView(
        {
          repositoryId: asRepositoryId("R_TIME_A"),
          fullName: "time/a",
          updatedAt: "2026-07-16T00:00:00Z",
        },
        "TIME_A",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_TIME_B"),
          fullName: "time/b",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
        "TIME_B",
      ),
      withView(
        {
          repositoryId: asRepositoryId("R_TIME_C"),
          fullName: "time/c",
          updatedAt: "2026-07-16T00:00:01.000Z",
        },
        "TIME_C",
      ),
    ];
    const sort = [{ field: "updated_at", direction: "asc" }] as const;
    const memoryOrder = [...views].sort((left, right) =>
      compareRepositories(left, right, sort),
    );
    expect(memoryOrder.map((view) => view.repositoryId)).toEqual([
      "R_TIME_A",
      "R_TIME_B",
      "R_TIME_C",
    ]);

    const position = repositoryCursorPosition(memoryOrder[0]!, sort);
    expect(position.values[0]).toBe("2026-07-16T00:00:00.000Z");
    const context = {
      kind: "repositories",
      snapshotId: SNAPSHOT_ID,
      filterHash: hashFilter(null),
      sort,
    } as const;
    const cursor = codec.encodeRepository(context, position);
    const compiled = compileCursor(
      sort,
      codec.decodeRepository(cursor, context),
    );
    const database = createDatabase(views);
    try {
      const sqlOrder = (
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
      expect(sqlOrder).toEqual(["R_TIME_B", "R_TIME_C"]);
    } finally {
      database.close();
    }

    const invalid = withView(
      { updatedAt: "Thu, 01 Jan 1970 00:00:00 GMT" },
      "invalid-time",
    );
    expectValidationError(() => compareRepositories(invalid, views[0]!, sort));
    expectValidationError(() => repositoryCursorPosition(invalid, sort));
  });
});
