import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ApplyInputSchema,
  InspectInputSchema,
  PlanInputSchema,
  RollbackInputSchema,
} from "../../../src/mcp/schemas/change-tools.js";
import {
  CursorSchema,
  FilterExpressionSchema,
  ToolNames,
} from "../../../src/mcp/schemas/common.js";
import {
  DiscoverInputSchema,
  ListsQueryInputSchema,
  StarsQueryInputSchema,
  StatusInputSchema,
  SyncInputSchema,
} from "../../../src/mcp/schemas/read-tools.js";
import {
  toApplyInput,
  toCreatePlanInput,
  toDiscoverInput,
  toInspectInput,
  toListsQueryInput,
  toRollbackInput,
  toStarsQueryInput,
  toStatusInput,
  toSyncInput,
} from "../../../src/mcp/mappers.js";

const leaf = {
  field: "stargazers_count",
  op: "lt",
  value: 10_000,
} as const;

function nestedNot(depth: number): unknown {
  let result: unknown = leaf;
  for (let index = 1; index < depth; index += 1) {
    result = { not: result };
  }
  return result;
}

function stringSet(prefix: string, size: number): string[] {
  return Array.from({ length: size }, (_, index) => `${prefix}_${index}`);
}

describe("MCP common schemas", () => {
  it("publishes the exact nine-tool allowlist", () => {
    expect(ToolNames).toEqual([
      "github_stars_status",
      "github_stars_sync",
      "github_stars_query",
      "github_lists_query",
      "github_changes_plan",
      "github_changes_inspect",
      "github_changes_apply",
      "github_changes_rollback",
      "github_repositories_discover",
    ]);
  });

  it("bounds opaque cursors by UTF-8 bytes", () => {
    const exact = "é".repeat(2_048);
    expect(Buffer.byteLength(exact, "utf8")).toBe(4_096);
    expect(CursorSchema.parse(exact)).toBe(exact);
    expect(CursorSchema.safeParse(`${exact}é`).success).toBe(false);
  });

  it("enforces filter depth, leaf, per-set, and total-set limits", () => {
    expect(FilterExpressionSchema.safeParse(nestedNot(12)).success).toBe(true);
    expect(FilterExpressionSchema.safeParse(nestedNot(13)).success).toBe(false);
    expect(
      FilterExpressionSchema.safeParse({
        all: Array.from({ length: 100 }, () => leaf),
      }).success,
    ).toBe(true);
    expect(
      FilterExpressionSchema.safeParse({
        all: Array.from({ length: 101 }, () => leaf),
      }).success,
    ).toBe(false);
    expect(
      FilterExpressionSchema.safeParse({
        field: "topics",
        op: "in",
        value: stringSet("topic", 5_001),
      }).success,
    ).toBe(false);
    expect(
      FilterExpressionSchema.safeParse({
        all: [
          { field: "topics", op: "in", value: stringSet("a", 5_000) },
          { field: "list_ids", op: "not_in", value: stringSet("b", 5_000) },
        ],
      }).success,
    ).toBe(true);
    expect(
      FilterExpressionSchema.safeParse({
        all: [
          { field: "topics", op: "in", value: stringSet("a", 5_000) },
          { field: "list_ids", op: "not_in", value: stringSet("b", 5_000) },
          { field: "owner", op: "in", value: ["extra"] },
        ],
      }).success,
    ).toBe(false);
  });

  it("uses exact field-family operators and explicit nullable predicates", () => {
    const accepted = [
      { field: "name_with_owner", op: "ne", value: "owner/repository" },
      { field: "stargazers_count", op: "gte", value: 10_000 },
      { field: "topics", op: "not_contains", value: "archived" },
      { field: "description", op: "is_null" },
      { field: "pushed_at", op: "is_null" },
      { field: "list_ids", op: "is_null" },
    ];
    for (const candidate of accepted) {
      expect(FilterExpressionSchema.safeParse(candidate).success).toBe(true);
    }

    const rejected = [
      { field: "name_with_owner", op: "neq", value: "owner/repository" },
      { field: "topics", op: "contains", value: ["topic"] },
      { field: "name_with_owner", op: "is_null" },
      { field: "updated_at", op: "is_null" },
      { field: "description", op: "is_null", value: true },
      { field: "is_archived", op: "eq", value: true },
      { field: "stargazer_count", op: "lt", value: 10_000 },
      { field: "primary_language", op: "eq", value: "TypeScript" },
    ];
    for (const candidate of rejected) {
      expect(FilterExpressionSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects duplicate filter-set members", () => {
    expect(
      FilterExpressionSchema.safeParse({
        field: "repository_id",
        op: "in",
        value: ["R_1", "R_1"],
      }).success,
    ).toBe(false);
  });

  it("bounds scalar and set-member strings by their field domains", () => {
    const rejected = [
      { field: "repository_id", op: "eq", value: "R".repeat(129) },
      {
        field: "name_with_owner",
        op: "eq",
        value: "n".repeat(257),
      },
      {
        field: "description",
        op: "contains",
        value: "d".repeat(1_025),
      },
      { field: "topics", op: "in", value: ["t".repeat(51)] },
      { field: "list_ids", op: "contains", value: "L".repeat(129) },
    ];
    for (const candidate of rejected) {
      expect(FilterExpressionSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("serializes the bounded recursive filter into a compact JSON Schema", () => {
    const advertised = z.toJSONSchema(FilterExpressionSchema, {
      target: "draft-7",
    });
    expect(Buffer.byteLength(JSON.stringify(advertised), "utf8")).toBeLessThan(
      100_000,
    );
  });

  it("advertises every tool input as a root JSON object", () => {
    const schemas = [
      StatusInputSchema,
      SyncInputSchema,
      StarsQueryInputSchema,
      ListsQueryInputSchema,
      DiscoverInputSchema,
      PlanInputSchema,
      InspectInputSchema,
      ApplyInputSchema,
      RollbackInputSchema,
    ];
    for (const schema of schemas) {
      expect(z.toJSONSchema(schema, { target: "draft-7" }).type).toBe("object");
    }
  });
});

describe("MCP read schemas and mappers", () => {
  it("applies bounded defaults and maps status and sync explicitly", () => {
    const status = StatusInputSchema.parse({});
    const sync = SyncInputSchema.parse({});
    expect(status).toEqual({ refresh_capabilities: false });
    expect(sync).toEqual({
      mode: "incremental",
      include_lists: true,
      metadata_max_age_hours: 24,
    });
    expect(toStatusInput(status)).toEqual({ refreshCapabilities: false });
    expect(toSyncInput(sync)).toEqual({
      mode: "incremental",
      includeLists: true,
      metadataMaxAgeHours: 24,
    });
  });

  it("exposes current Stars fields, keeps list_ids filter-only, and rejects duplicates", () => {
    const parsed = StarsQueryInputSchema.parse({
      fields: [
        "name_with_owner",
        "stargazers_count",
        "fork",
        "archived",
        "disabled",
        "language",
        "license",
        "url",
      ],
    });
    expect(parsed.limit).toBe(50);
    expect(parsed.sort).toEqual([{ field: "starred_at", direction: "desc" }]);
    expect(
      toStarsQueryInput(parsed, {
        now: () => "2026-07-18T00:00:00.000Z",
      }).fields,
    ).toEqual([
      "full_name",
      "stargazer_count",
      "is_fork",
      "is_archived",
      "is_disabled",
      "primary_language",
      "license_spdx_id",
      "url",
    ]);
    expect(StarsQueryInputSchema.parse({ fields: [] }).fields).toEqual([]);
    expect(
      StarsQueryInputSchema.safeParse({ fields: ["list_ids"] }).success,
    ).toBe(false);
    expect(
      StarsQueryInputSchema.safeParse({
        fields: ["name_with_owner", "name_with_owner"],
      }).success,
    ).toBe(false);
    expect(
      StarsQueryInputSchema.safeParse({
        sort: [
          { field: "name_with_owner", direction: "asc" },
          { field: "name_with_owner", direction: "desc" },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires zero evidence_limit when evidence is none", () => {
    expect(
      StarsQueryInputSchema.safeParse({
        evidence: "none",
        evidence_limit: 1,
      }).success,
    ).toBe(false);
    expect(
      DiscoverInputSchema.safeParse({
        query: "mcp",
        evidence: "none",
        evidence_limit: 1,
      }).success,
    ).toBe(false);
  });

  it("resolves relative filters with one clock read and calendar semantics", () => {
    const now = vi.fn(() => "2024-03-31T12:30:00.000Z");
    const input = StarsQueryInputSchema.parse({
      where: {
        all: [
          {
            field: "pushed_at",
            op: "before",
            value: { ago: { amount: 1, unit: "months" } },
          },
          {
            field: "updated_at",
            op: "after",
            value: { ago: { amount: 1, unit: "years" } },
          },
          { field: "description", op: "is_null" },
          {
            field: "name_with_owner",
            op: "ne",
            value: "owner/repository",
          },
        ],
      },
    });
    const mapped = toStarsQueryInput(input, { now });
    expect(now).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mapped.filter)).not.toContain('"ago"');
    expect(mapped.filter).toEqual({
      all: [
        {
          field: "pushed_at",
          op: "before",
          value: "2024-02-29T12:30:00.000Z",
        },
        {
          field: "updated_at",
          op: "after",
          value: "2023-03-31T12:30:00.000Z",
        },
        { field: "description", op: "is_null", value: true },
        {
          field: "full_name",
          op: "neq",
          value: "owner/repository",
        },
      ],
    });
  });

  it("allows relative values only for temporal before/after comparisons", () => {
    const ago = { ago: { amount: 1, unit: "days" } };
    expect(
      FilterExpressionSchema.safeParse({
        field: "pushed_at",
        op: "before",
        value: ago,
      }).success,
    ).toBe(true);
    expect(
      FilterExpressionSchema.safeParse({
        field: "pushed_at",
        op: "eq",
        value: ago,
      }).success,
    ).toBe(false);
    expect(
      FilterExpressionSchema.safeParse({
        field: "name_with_owner",
        op: "eq",
        value: ago,
      }).success,
    ).toBe(false);
  });

  it("keeps the three Lists branches exact through mapping", () => {
    const listPage = ListsQueryInputSchema.parse({ mode: "lists" });
    const members = ListsQueryInputSchema.parse({
      mode: "memberships",
      list_id: "UL_1",
    });
    const memberships = ListsQueryInputSchema.parse({
      mode: "memberships",
      repository_id: "R_1",
    });
    expect(toListsQueryInput(listPage)).toEqual({
      mode: "lists",
      snapshotId: null,
      limit: 50,
      cursor: null,
    });
    expect(toListsQueryInput(members)).toEqual({
      mode: "memberships",
      snapshotId: null,
      listId: "UL_1",
      limit: 50,
      cursor: null,
    });
    expect(toListsQueryInput(memberships)).toEqual({
      mode: "memberships",
      snapshotId: null,
      repositoryId: "R_1",
      limit: 50,
      cursor: null,
    });
    expect(
      ListsQueryInputSchema.safeParse({
        mode: "memberships",
        list_id: "UL_1",
        repository_id: "R_1",
      }).success,
    ).toBe(false);
    expect(
      ListsQueryInputSchema.safeParse({
        mode: "lists",
        list_id: "UL_1",
      }).success,
    ).toBe(false);
  });

  it("maps discovery qualifiers, cursors, and public sort spellings", () => {
    const parsed = DiscoverInputSchema.parse({
      query: "mcp",
      qualifiers: {
        language: "TypeScript",
        topic: ["ai-agent"],
        user: "octocat",
      },
      sort: "help-wanted-issues",
      limit: 25,
      cursor: "2",
    });
    expect(toDiscoverInput(parsed)).toEqual({
      query: "mcp",
      qualifiers: {
        language: "TypeScript",
        topic: ["ai-agent"],
        user: "octocat",
      },
      sort: "help-wanted-issues",
      order: "desc",
      limit: 25,
      cursor: "2",
      evidence: "none",
      evidenceLimit: 0,
    });
    expect(
      toDiscoverInput(
        DiscoverInputSchema.parse({ query: "mcp", sort: "best-match" }),
      ).sort,
    ).toBeNull();
    expect(
      DiscoverInputSchema.safeParse({
        query: "mcp",
        qualifiers: { user: "octocat", org: "github" },
      }).success,
    ).toBe(false);
    expect(
      DiscoverInputSchema.safeParse({
        query: "mcp",
        page: 1,
        per_page: 10,
      }).success,
    ).toBe(false);
  });

  it("rejects hostile identity and transport keys at every read root", () => {
    const roots = [
      [StatusInputSchema, { token: "secret" }],
      [SyncInputSchema, { host: "github.example" }],
      [StarsQueryInputSchema, { login: "octocat" }],
      [ListsQueryInputSchema, { mode: "lists", account_id: "1" }],
      [DiscoverInputSchema, { query: "mcp", endpoint: "/search" }],
    ] as const;
    for (const [schema, candidate] of roots) {
      expect(schema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("MCP change schemas and mappers", () => {
  it("maps all eight bulk operation shapes to branded domain DTOs", () => {
    const parsed = PlanInputSchema.parse({
      snapshot_id: "snap_1",
      operations: [
        {
          kind: "list_create",
          client_ref: "ref_research",
          name: "Research",
        },
        {
          kind: "star",
          repositories: { repository_ids: ["R_2", "R_1"] },
        },
        {
          kind: "unstar",
          repositories: {
            where: { field: "stargazers_count", op: "lt", value: 100 },
          },
        },
        {
          kind: "list_update",
          list_ids: ["UL_2", "UL_1"],
          description: null,
        },
        { kind: "list_delete", list_ids: ["UL_4", "UL_3"] },
        {
          kind: "list_membership_set",
          repositories: { repository_ids: ["R_1"] },
          lists: [],
        },
        {
          kind: "list_membership_add",
          repositories: { repository_ids: ["R_1"] },
          lists: [{ client_ref: "ref_research" }, { list_id: "UL_1" }],
        },
        {
          kind: "list_membership_remove",
          repositories: { repository_ids: ["R_1"] },
          lists: [{ list_id: "UL_1" }],
        },
      ],
      protected_repository_ids: ["R_keep_2", "R_keep_1"],
      protected_list_ids: ["UL_keep_2", "UL_keep_1"],
      expires_in_minutes: 60,
      caller_note: "approved cleanup",
    });
    const mapped = toCreatePlanInput(parsed, {
      now: () => "2026-07-18T00:00:00.000Z",
    });
    expect(mapped).toEqual({
      snapshotId: "snap_1",
      actions: [
        {
          kind: "list_create",
          clientRef: "ref_research",
          name: "Research",
          description: null,
          isPrivate: false,
        },
        {
          kind: "star",
          repositories: {
            kind: "ids",
            repositoryIds: ["R_1", "R_2"],
          },
        },
        {
          kind: "unstar",
          repositories: {
            kind: "filter",
            filter: { field: "stargazer_count", op: "lt", value: 100 },
          },
        },
        {
          kind: "list_update",
          listIds: ["UL_1", "UL_2"],
          description: null,
        },
        { kind: "list_delete", listIds: ["UL_3", "UL_4"] },
        {
          kind: "list_membership_set",
          repositories: { kind: "ids", repositoryIds: ["R_1"] },
          lists: [],
        },
        {
          kind: "list_membership_add",
          repositories: { kind: "ids", repositoryIds: ["R_1"] },
          lists: [
            { kind: "existing", listId: "UL_1" },
            { kind: "created", clientRef: "ref_research" },
          ],
        },
        {
          kind: "list_membership_remove",
          repositories: { kind: "ids", repositoryIds: ["R_1"] },
          lists: [{ kind: "existing", listId: "UL_1" }],
        },
      ],
      protectedRepositoryIds: ["R_keep_1", "R_keep_2"],
      protectedListIds: ["UL_keep_1", "UL_keep_2"],
      ttlMinutes: 60,
      callerNote: "approved cleanup",
    });
  });

  it("reads the plan-mapper clock once across relative selectors", () => {
    const now = vi.fn(() => "2024-03-31T00:00:00.000Z");
    const parsed = PlanInputSchema.parse({
      snapshot_id: "snap_1",
      operations: [
        {
          kind: "star",
          repositories: {
            where: {
              field: "pushed_at",
              op: "before",
              value: { ago: { amount: 1, unit: "months" } },
            },
          },
        },
        {
          kind: "unstar",
          repositories: {
            where: {
              field: "updated_at",
              op: "after",
              value: { ago: { amount: 1, unit: "days" } },
            },
          },
        },
      ],
    });
    const mapped = toCreatePlanInput(parsed, { now });
    expect(now).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mapped)).not.toContain('"ago"');
  });

  it("enforces target/ref invariants and update metadata", () => {
    const root = {
      snapshot_id: "snap_1",
      operations: [],
    };
    const invalidOperations = [
      [
        {
          kind: "list_update",
          list_ids: ["UL_1"],
        },
      ],
      [
        {
          kind: "list_membership_add",
          repositories: { repository_ids: ["R_1"] },
          lists: [],
        },
      ],
      [
        {
          kind: "list_membership_remove",
          repositories: { repository_ids: ["R_1"] },
          lists: [{ client_ref: "ref_future" }],
        },
      ],
      [
        {
          kind: "list_membership_add",
          repositories: { repository_ids: ["R_1"] },
          lists: [{ client_ref: "ref_missing" }],
        },
      ],
      [
        {
          kind: "list_create",
          client_ref: "ref_duplicate",
          name: "A",
        },
        {
          kind: "list_create",
          client_ref: "ref_duplicate",
          name: "B",
        },
      ],
    ];
    for (const operations of invalidOperations) {
      expect(PlanInputSchema.safeParse({ ...root, operations }).success).toBe(
        false,
      );
    }
    expect(
      PlanInputSchema.safeParse({
        snapshot_id: "snap_1",
        operations: [
          {
            kind: "list_create",
            client_ref: " ref_padded",
            name: "A",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicates in selectors, targets, and protected arrays", () => {
    const candidates = [
      {
        snapshot_id: "snap_1",
        operations: [
          {
            kind: "star",
            repositories: { repository_ids: ["R_1", "R_1"] },
          },
        ],
      },
      {
        snapshot_id: "snap_1",
        operations: [
          {
            kind: "list_membership_set",
            repositories: { repository_ids: ["R_1"] },
            lists: [{ list_id: "UL_1" }, { list_id: "UL_1" }],
          },
        ],
      },
      {
        snapshot_id: "snap_1",
        operations: [
          {
            kind: "star",
            repositories: { repository_ids: ["R_1"] },
          },
        ],
        protected_repository_ids: ["R_2", "R_2"],
      },
    ];
    for (const candidate of candidates) {
      expect(PlanInputSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("maps exact inspect, apply, and rollback DTOs", () => {
    expect(
      toInspectInput(
        InspectInputSchema.parse({
          kind: "attempts",
          id: "run_1",
          operation_id: "op_1",
        }),
      ),
    ).toEqual({
      kind: "attempts",
      id: "run_1",
      operationId: "op_1",
      limit: 50,
      cursor: null,
    });
    expect(
      toApplyInput(
        ApplyInputSchema.parse({
          plan_id: "plan_1",
          expected_hash: "a".repeat(64),
          failure_mode: "continue",
        }),
      ),
    ).toEqual({
      planId: "plan_1",
      expectedHash: "a".repeat(64),
      failureMode: "continue",
    });
    expect(
      toRollbackInput(
        RollbackInputSchema.parse({
          run_id: "run_1",
          protected_repository_ids: ["R_2", "R_1"],
          protected_list_ids: ["UL_2", "UL_1"],
          expires_in_minutes: 30,
          caller_note: "restore",
        }),
      ),
    ).toEqual({
      runId: "run_1",
      protectedRepositoryIds: ["R_1", "R_2"],
      protectedListIds: ["UL_1", "UL_2"],
      ttlMinutes: 30,
      callerNote: "restore",
    });
  });

  it("rejects missing hashes, unstable IDs, and forbidden transport escape hatches", () => {
    expect(ApplyInputSchema.safeParse({ plan_id: "plan_1" }).success).toBe(
      false,
    );
    expect(RollbackInputSchema.safeParse({ run_id: " run_1" }).success).toBe(
      false,
    );
    const roots = [
      [
        PlanInputSchema,
        {
          snapshot_id: "snap_1",
          operations: [
            {
              kind: "star",
              repositories: { repository_ids: ["R_1"] },
            },
          ],
          graphql: "mutation { deleteRepository }",
        },
      ],
      [
        InspectInputSchema,
        { kind: "run", id: "run_1", raw_path: "/user/starred" },
      ],
      [
        ApplyInputSchema,
        {
          plan_id: "plan_1",
          expected_hash: "a".repeat(64),
          method: "DELETE",
        },
      ],
      [RollbackInputSchema, { run_id: "run_1", cookie: "session=secret" }],
    ] as const;
    for (const [schema, candidate] of roots) {
      expect(schema.safeParse(candidate).success).toBe(false);
    }
  });
});
