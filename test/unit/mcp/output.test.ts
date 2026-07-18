import { describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_ERROR_CODES } from "../../../src/domain/errors.js";
import { hashPlanExecutable } from "../../../src/domain/plan.js";
import {
  parseChangeRun,
  parseRunOperation,
  parseRunOperationAttempt,
  parseRunOperationReconciliation,
} from "../../../src/domain/run.js";
import { ToolNames } from "../../../src/mcp/schemas/common.js";
import {
  ApplyOutputDataSchema,
  DiscoveryOutputDataSchema,
  InspectOutputDataSchema,
  ListsQueryOutputDataSchema,
  PlanOutputDataSchema,
  PublicJsonValueSchema,
  StarsQueryOutputDataSchema,
  StatusOutputDataSchema,
  SyncOutputDataSchema,
  ToolFailureStructuredContentSchema,
  ToolOutputSchemas,
} from "../../../src/mcp/schemas/output.js";
import {
  normalizeOutputWarnings,
  toApplyOutput,
  toDiscoveryOutput,
  toCandidatesOutput,
  toInspectOutput,
  toListsQueryOutput,
  toPlanOutput,
  toRollbackOutput,
  toStarsQueryOutput,
  toStatusOutput,
  toSyncOutput,
} from "../../../src/mcp/output-mappers.js";
import { toolSuccess } from "../../../src/mcp/result.js";

const NOW = "2026-07-16T00:00:00.000Z";
const LATER = "2026-07-16T00:01:00.000Z";

function repository(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    repositoryId: "repo_1",
    repositoryDatabaseId: "42",
    owner: "octocat",
    name: "hello-world",
    fullName: "octocat/hello-world",
    description: "Example repository",
    url: "https://github.com/octocat/hello-world",
    stargazerCount: 12_345,
    isFork: false,
    isArchived: false,
    isDisabled: false,
    isPrivate: false,
    visibility: "public",
    primaryLanguage: "TypeScript",
    topics: ["mcp", "stars"],
    licenseSpdxId: "MIT",
    pushedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function evidence() {
  return {
    repositoryId: "repo_1",
    kind: "untrusted_external_text",
    text: "Untrusted README excerpt",
    sourceUrl:
      "https://raw.githubusercontent.com/octocat/hello-world/main/README.md",
    sha: "deadbeef",
    byteLength: 24,
    truncated: false,
    missing: false,
  };
}

function run(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "run_1",
    planId: "plan_1",
    binding: {
      host: "github.com",
      login: "octocat",
      accountId: "account-secret",
    },
    state: "completed",
    failureMode: "continue",
    warnings: ["run warning"],
    startedAt: NOW,
    finishedAt: LATER,
    ...overrides,
  };
}

function runOperation(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    runId: "run_1",
    operationId: "op_1",
    sequence: 0,
    status: "succeeded",
    reconciliation: "not_required",
    attempts: 1,
    before: { starred: false },
    after: { starred: true },
    externalRequestId: "request_1",
    error: null,
    startedAt: NOW,
    finishedAt: LATER,
    ...overrides,
  };
}

function resolvedCreateOperation() {
  return {
    operationId: "op_1",
    kind: "list_create",
    dependsOn: [],
    preconditions: [{ kind: "list_absent", expected: true }],
    before: null,
    after: { name: "AI" },
    inverse: { kind: "list_delete" },
    risk: "normal",
    clientRef: "ref_ai",
  };
}

function planResult(warnings: readonly string[] = ["plan warning"]) {
  const operation = resolvedCreateOperation();
  const executable = {
    schemaVersion: 1,
    policyVersion: "1",
    binding: {
      host: "github.com",
      login: "octocat",
      accountId: "account-secret",
    },
    snapshotId: "snap_1",
    protectedRepositoryIds: ["repo_protected"],
    protectedListIds: ["list_protected"],
    operations: [operation],
    dependencies: [],
  };
  return {
    plan: {
      id: "plan_1",
      hash: hashPlanExecutable(executable),
      state: "ready",
      createdAt: NOW,
      expiresAt: "2026-07-17T00:00:00.000Z",
      callerNote: "private planning note",
      executable,
      operations: [operation],
      dependencies: [],
      warnings,
    },
    summary: {
      star: 0,
      unstar: 0,
      list_create: 1,
      list_update: 0,
      list_delete: 0,
      list_membership_set: 0,
    },
  };
}

function envelope(data: unknown, options?: Readonly<Record<string, unknown>>) {
  return {
    schema_version: "1",
    ok: true,
    request_id: "req_1",
    data,
    warnings: [],
    rate_limit: null,
    next_cursor: null,
    ...options,
  };
}

describe("MCP output schemas", () => {
  it("publishes strict root-object contracts for exactly ten tools", () => {
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
      "github_repositories_candidates",
    ]);
    expect(Object.keys(ToolOutputSchemas).sort()).toEqual(
      [...ToolNames].sort(),
    );
    for (const name of ToolNames) {
      expect(ToolOutputSchemas[name].type).toBe("object");
      expect(z.toJSONSchema(ToolOutputSchemas[name])).toMatchObject({
        type: "object",
      });
    }
  });

  it("uses the exact snake-case rate-limit contract", () => {
    const valid = envelope(
      { snapshot_id: "snap_1", counts: syncCounts(), duration_ms: 1 },
      {
        rate_limit: { remaining: 10, reset_at: LATER },
      },
    );
    expect(ToolOutputSchemas.github_stars_sync.safeParse(valid).success).toBe(
      true,
    );
    expect(
      ToolOutputSchemas.github_stars_sync.safeParse({
        ...valid,
        rate_limit: { remaining: 10, resetAt: LATER },
      }).success,
    ).toBe(false);
  });

  it("bounds next cursors by 4096 UTF-8 bytes", () => {
    const atLimit = "\u00e9".repeat(2_048);
    const overLimit = "\u00e9".repeat(2_049);
    const queryData = {
      snapshot_id: "snap_1",
      total: 0,
      aggregates: { languages: [], archived: 0, forks: 0 },
      items: [],
      evidence: [],
    };
    expect(
      ToolOutputSchemas.github_stars_query.safeParse(
        envelope(queryData, { next_cursor: atLimit }),
      ).success,
    ).toBe(true);
    expect(
      ToolOutputSchemas.github_stars_query.safeParse(
        envelope(queryData, { next_cursor: overLimit }),
      ).success,
    ).toBe(false);
    expect(
      JSON.stringify(z.toJSONSchema(ToolOutputSchemas.github_stars_query)),
    ).toContain("4096 UTF-8 bytes");
    expect(
      toStarsQueryOutput({
        snapshotId: "snap_1",
        total: 0,
        aggregates: { languages: [], archived: 0, forks: 0 },
        items: [],
        evidence: [],
        nextCursor: atLimit,
      } as never).nextCursor,
    ).toBe(atLimit);
    expect(() =>
      toStarsQueryOutput({
        snapshotId: "snap_1",
        total: 0,
        aggregates: { languages: [], archived: 0, forks: 0 },
        items: [],
        evidence: [],
        nextCursor: overLimit,
      } as never),
    ).toThrow();
  });

  it("rejects non-canonical timestamps and reversed lifecycle chronology", () => {
    const validPlan = toPlanOutput(planResult() as never).data;
    for (const invalid of [
      "2026-13-01T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-07-16T24:00:00.000Z",
    ]) {
      expect(
        PlanOutputDataSchema.safeParse({
          ...validPlan,
          created_at: invalid,
        }).success,
      ).toBe(false);
    }
    expect(
      PlanOutputDataSchema.safeParse({
        ...validPlan,
        expires_at: NOW,
      }).success,
    ).toBe(false);

    const statusData = {
      server_version: "1.0.0",
      host: "github.com",
      login: "octocat",
      credential_source: "gh",
      capabilities: {
        star_read: "available",
        star_write: "available",
        list_read: "available",
        list_write: "available",
      },
      database_schema_version: 2,
      latest_complete_snapshot: {
        snapshot_id: "snap_1",
        mode: "full",
        list_coverage: "complete",
        status: "complete",
        started_at: LATER,
        completed_at: NOW,
        failed_at: null,
        counts: { repositories: 0, stars: 0, lists: 0, memberships: 0 },
        warning_count: 0,
      },
      incomplete_runs: { items: [], total: 0, truncated: false },
    };
    expect(StatusOutputDataSchema.safeParse(statusData).success).toBe(false);
    expect(
      StatusOutputDataSchema.safeParse({
        ...statusData,
        latest_complete_snapshot: null,
        incomplete_runs: {
          items: [
            {
              run_id: "run_1",
              plan_id: "plan_1",
              state: "partial",
              started_at: LATER,
              finished_at: NOW,
              counts: {
                pending: 0,
                running: 0,
                succeeded: 1,
                skipped: 0,
                failed: 0,
                unresolved: 0,
              },
            },
          ],
          total: 1,
          truncated: false,
        },
      }).success,
    ).toBe(false);

    const publicRun = {
      run_id: "run_1",
      plan_id: "plan_1",
      state: "completed",
      failure_mode: "continue",
      started_at: LATER,
      finished_at: NOW,
    };
    expect(
      InspectOutputDataSchema.safeParse({
        kind: "run",
        run: publicRun,
        operations: [],
        total: 0,
      }).success,
    ).toBe(false);
    expect(
      InspectOutputDataSchema.safeParse({
        kind: "run",
        run: {
          ...publicRun,
          started_at: NOW,
          finished_at: LATER,
        },
        operations: [
          {
            run_id: "run_1",
            operation_id: "op_1",
            sequence: 0,
            status: "succeeded",
            reconciliation: "not_required",
            attempts: 1,
            before: {},
            after: {},
            external_request_id: null,
            error: null,
            started_at: LATER,
            finished_at: NOW,
          },
        ],
        total: 1,
      }).success,
    ).toBe(false);
    expect(
      InspectOutputDataSchema.safeParse({
        kind: "attempts",
        run: {
          ...publicRun,
          started_at: NOW,
          finished_at: LATER,
        },
        operation_id: "op_1",
        attempts: [
          {
            run_id: "run_1",
            operation_id: "op_1",
            attempt: 1,
            status: "succeeded",
            reconciliation: "not_required",
            before: {},
            after: {},
            external_request_id: null,
            error: null,
            started_at: LATER,
            finished_at: NOW,
          },
        ],
        total: 1,
      }).success,
    ).toBe(false);
    expect(
      ApplyOutputDataSchema.safeParse({
        ...publicRun,
        counts: {
          pending: 0,
          running: 0,
          succeeded: 0,
          skipped: 0,
          failed: 0,
          unresolved: 0,
        },
        errors: [],
        audit_cursor: null,
      }).success,
    ).toBe(false);
  });

  it("enforces service-derived aggregate, error, audit, and discovery totals", () => {
    const starsData = {
      snapshot_id: "snap_1",
      total: 2,
      aggregates: {
        languages: [
          { language: null, count: 1 },
          { language: "TypeScript", count: 1 },
        ],
        archived: 1,
        forks: 1,
      },
      items: [],
      evidence: [],
    };
    expect(StarsQueryOutputDataSchema.safeParse(starsData).success).toBe(true);
    expect(
      StarsQueryOutputDataSchema.safeParse({
        ...starsData,
        aggregates: { ...starsData.aggregates, archived: 3 },
      }).success,
    ).toBe(false);
    expect(
      StarsQueryOutputDataSchema.safeParse({
        ...starsData,
        aggregates: {
          ...starsData.aggregates,
          languages: [
            { language: "TypeScript", count: 1 },
            { language: null, count: 1 },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      StarsQueryOutputDataSchema.safeParse({
        ...starsData,
        aggregates: {
          ...starsData.aggregates,
          languages: [
            { language: "TypeScript", count: 1 },
            { language: "TypeScript", count: 1 },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      StarsQueryOutputDataSchema.safeParse({
        ...starsData,
        aggregates: { ...starsData.aggregates, forks: 3 },
      }).success,
    ).toBe(false);
    expect(
      StarsQueryOutputDataSchema.safeParse({
        ...starsData,
        aggregates: {
          ...starsData.aggregates,
          languages: [{ language: "TypeScript", count: 1 }],
        },
      }).success,
    ).toBe(true);
    expect(() =>
      toStarsQueryOutput({
        snapshotId: "snap_1",
        total: 2,
        aggregates: {
          languages: [{ language: "TypeScript", count: 1 }],
          archived: 0,
          forks: 0,
        },
        items: [],
        evidence: [],
        nextCursor: null,
      } as never),
    ).toThrow();
    const allLanguages = Array.from({ length: 101 }, (_, index) => ({
      language: `Language${String(index).padStart(3, "0")}`,
      count: 1,
    }));
    const truncatedLanguages = toStarsQueryOutput({
      snapshotId: "snap_1",
      total: allLanguages.length,
      aggregates: {
        languages: allLanguages,
        archived: 0,
        forks: 0,
      },
      items: [],
      evidence: [],
      nextCursor: null,
    } as never);
    expect(
      (
        truncatedLanguages.data.aggregates as {
          readonly languages: readonly unknown[];
        }
      ).languages,
    ).toHaveLength(100);
    expect(truncatedLanguages.warnings).toEqual([
      "language aggregates truncated; 1 group omitted",
    ]);

    const error = {
      code: "PRECONDITION_FAILED",
      message: "operation failed",
      retryable: false,
      details: { operation_id: "op_1" },
    } as const;
    const applyData = {
      run_id: "run_1",
      plan_id: "plan_1",
      state: "partial",
      failure_mode: "continue",
      started_at: NOW,
      finished_at: LATER,
      counts: {
        pending: 0,
        running: 0,
        succeeded: 0,
        skipped: 0,
        failed: 1,
        unresolved: 0,
      },
      errors: [error],
      audit_cursor: "run_1",
    };
    expect(ApplyOutputDataSchema.safeParse(applyData).success).toBe(true);
    expect(
      ApplyOutputDataSchema.safeParse({ ...applyData, errors: [] }).success,
    ).toBe(false);
    expect(
      ApplyOutputDataSchema.safeParse({
        ...applyData,
        counts: {
          pending: 0,
          running: 0,
          succeeded: 0,
          skipped: 0,
          failed: 0,
          unresolved: 0,
        },
        errors: [],
      }).success,
    ).toBe(false);
    expect(
      ApplyOutputDataSchema.safeParse({
        ...applyData,
        audit_cursor: null,
      }).success,
    ).toBe(false);
    expect(
      ApplyOutputDataSchema.safeParse({
        ...applyData,
        audit_cursor: "run_other",
      }).success,
    ).toBe(false);
    expect(
      ApplyOutputDataSchema.safeParse({
        ...applyData,
        counts: {
          pending: 0,
          running: 0,
          succeeded: 0,
          skipped: 0,
          failed: 21,
          unresolved: 0,
        },
        errors: Array.from({ length: 20 }, () => error),
      }).success,
    ).toBe(true);

    const discoveryData = {
      items: [],
      evidence: [],
      reported_total: 1_001,
      capped_total: 1_000,
      incomplete_results: false,
    };
    expect(DiscoveryOutputDataSchema.safeParse(discoveryData).success).toBe(
      true,
    );
    expect(
      DiscoveryOutputDataSchema.safeParse({
        ...discoveryData,
        capped_total: 999,
      }).success,
    ).toBe(false);
  });

  it("advertises a strict bounded failure envelope", () => {
    expect(() =>
      ToolFailureStructuredContentSchema.parse({
        schema_version: "1",
        ok: false,
        request_id: "req_1",
        error: {
          code: APP_ERROR_CODES[0],
          message: "authentication required",
          retryable: false,
          details: { safe: true },
        },
      }),
    ).not.toThrow();
    expect(() =>
      ToolFailureStructuredContentSchema.parse({
        schema_version: "1",
        ok: false,
        request_id: "req_1",
        error: {
          code: "NOT_A_REAL_CODE",
          message: "invalid",
          retryable: false,
          details: {},
        },
      }),
    ).toThrow();
  });

  it("bounds JSON subtrees with the domain JSON limits", () => {
    expect(JSON.stringify(z.toJSONSchema(PublicJsonValueSchema))).toContain(
      '"anyOf"',
    );
    expect(
      PublicJsonValueSchema.safeParse({ nested: [true, null] }).success,
    ).toBe(true);
    expect(PublicJsonValueSchema.safeParse("x".repeat(1_048_577)).success).toBe(
      false,
    );
    let nested: unknown = null;
    for (let depth = 0; depth < 70; depth += 1) nested = [nested];
    expect(PublicJsonValueSchema.safeParse(nested).success).toBe(false);
  });
});

function syncCounts() {
  return {
    repositories: 1,
    stars: 1,
    lists: 1,
    memberships: 1,
    refreshed_repositories: 1,
    reused_metadata: 0,
    warnings: 0,
  };
}

describe("read-side output mappers", () => {
  it("maps status identity facts but omits binding and snapshot source state", () => {
    const output = toStatusOutput({
      serverVersion: "1.0.0",
      host: "github.com",
      login: "octocat",
      credentialSource: "gh",
      capabilities: {
        starRead: "available",
        starWrite: "available",
        listRead: "unknown",
        listWrite: "unavailable",
      },
      databaseSchemaVersion: 2,
      latestCompleteSnapshot: {
        id: "snap_1",
        binding: {
          host: "github.com",
          login: "octocat",
          accountId: "account-secret",
        },
        mode: "full",
        listCoverage: "complete",
        status: "complete",
        startedAt: NOW,
        completedAt: LATER,
        failedAt: null,
        counts: { repositories: 2, stars: 2, lists: 1, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: {
          authorization: "Bearer secret",
          resetAt: LATER,
        },
      },
      incompleteRuns: {
        items: [
          {
            runId: "run_1",
            planId: "plan_1",
            state: "running",
            startedAt: NOW,
            finishedAt: null,
            counts: {
              pending: 1,
              running: 0,
              succeeded: 1,
              skipped: 0,
              failed: 1,
              unresolved: 0,
            },
          },
        ],
        total: 1,
        truncated: false,
      },
      rateLimit: { remaining: 4_999, resetAt: LATER },
    } as never);

    expect(output).toEqual({
      data: {
        server_version: "1.0.0",
        host: "github.com",
        login: "octocat",
        credential_source: "gh",
        capabilities: {
          star_read: "available",
          star_write: "available",
          list_read: "unknown",
          list_write: "unavailable",
        },
        database_schema_version: 2,
        latest_complete_snapshot: {
          snapshot_id: "snap_1",
          mode: "full",
          list_coverage: "complete",
          status: "complete",
          started_at: NOW,
          completed_at: LATER,
          failed_at: null,
          counts: { repositories: 2, stars: 2, lists: 1, memberships: 1 },
          warning_count: 0,
        },
        incomplete_runs: {
          items: [
            {
              run_id: "run_1",
              plan_id: "plan_1",
              state: "running",
              started_at: NOW,
              finished_at: null,
              counts: {
                pending: 1,
                running: 0,
                succeeded: 1,
                skipped: 0,
                failed: 1,
                unresolved: 0,
              },
            },
          ],
          total: 1,
          truncated: false,
        },
      },
      warnings: [],
      rateLimit: { remaining: 4_999, resetAt: LATER },
      nextCursor: null,
    });
    expect(StatusOutputDataSchema.parse(output.data)).toEqual(output.data);
    expect(JSON.stringify(output.data)).not.toMatch(
      /account-secret|sourceRateLimit|source_rate_limit|binding/i,
    );
  });

  it("maps sync counts and normalizes warnings outside data", () => {
    const warnings = [
      "x".repeat(600),
      ...Array.from({ length: 24 }, (_, index) => `warning ${index}`),
    ];
    const output = toSyncOutput({
      snapshotId: "snap_1",
      counts: {
        repositories: 1,
        stars: 1,
        lists: 1,
        memberships: 1,
        refreshedRepositories: 1,
        reusedMetadata: 0,
        warnings: 25,
      },
      warnings,
      rateLimit: null,
      durationMs: 25,
    } as never);

    expect(output.data).toEqual({
      snapshot_id: "snap_1",
      counts: { ...syncCounts(), warnings: 25 },
      duration_ms: 25,
    });
    expect(output.warnings).toHaveLength(20);
    expect(output.warnings[0]).toHaveLength(512);
    expect(output.warnings[19]).toBe("6 additional warnings omitted");
    expect(SyncOutputDataSchema.parse(output.data)).toEqual(output.data);
  });

  it("preserves only returned Stars projection fields", () => {
    const output = toStarsQueryOutput({
      snapshotId: "snap_1",
      total: 1,
      aggregates: {
        languages: [{ language: "TypeScript", count: 1 }],
        archived: 0,
        forks: 0,
      },
      items: [
        {
          repository_id: "repo_1",
          full_name: "octocat/hello-world",
          description: null,
          stargazer_count: 12_345,
          is_fork: false,
          is_archived: false,
          is_disabled: false,
          primary_language: "TypeScript",
          license_spdx_id: "MIT",
          topics: ["mcp"],
        },
      ],
      evidence: [evidence()],
      nextCursor: "cursor_2",
    } as never);

    expect(output.data).toEqual({
      snapshot_id: "snap_1",
      total: 1,
      aggregates: {
        languages: [{ language: "TypeScript", count: 1 }],
        archived: 0,
        forks: 0,
      },
      items: [
        {
          repository_id: "repo_1",
          name_with_owner: "octocat/hello-world",
          description: null,
          stargazers_count: 12_345,
          fork: false,
          archived: false,
          disabled: false,
          language: "TypeScript",
          license: "MIT",
          topics: ["mcp"],
        },
      ],
      evidence: [
        {
          repository_id: "repo_1",
          kind: "untrusted_external_text",
          text: "Untrusted README excerpt",
          source_url:
            "https://raw.githubusercontent.com/octocat/hello-world/main/README.md",
          sha: "deadbeef",
          byte_length: 24,
          truncated: false,
          missing: false,
        },
      ],
    });
    expect(output.nextCursor).toBe("cursor_2");
    expect(StarsQueryOutputDataSchema.parse(output.data)).toEqual(output.data);
  });

  it("maps all three closed Lists branches", () => {
    const lists = toListsQueryOutput({
      snapshotId: "snap_1",
      coverage: "complete",
      items: [
        {
          listId: "list_1",
          name: "AI",
          slug: "ai",
          description: null,
          isPrivate: false,
          createdAt: NOW,
          updatedAt: LATER,
          lastAddedAt: null,
          repositoryCount: 2,
        },
      ],
      total: 1,
      nextCursor: null,
    } as never);
    const byList = toListsQueryOutput({
      snapshotId: "snap_1",
      coverage: "complete",
      selector: { kind: "list", listId: "list_1" },
      repositoryIds: ["repo_1"],
      total: 1,
      nextCursor: "cursor_2",
    } as never);
    const byRepository = toListsQueryOutput({
      snapshotId: "snap_1",
      coverage: "complete",
      selector: { kind: "repository", repositoryId: "repo_1" },
      listIds: ["list_1"],
      total: 1,
      nextCursor: null,
    } as never);

    expect(lists.data).toMatchObject({ mode: "lists", total: 1 });
    expect(byList.data).toEqual({
      mode: "memberships",
      snapshot_id: "snap_1",
      coverage: "complete",
      selector: { kind: "list", list_id: "list_1" },
      repository_ids: ["repo_1"],
      total: 1,
    });
    expect(byRepository.data).toEqual({
      mode: "memberships",
      snapshot_id: "snap_1",
      coverage: "complete",
      selector: { kind: "repository", repository_id: "repo_1" },
      list_ids: ["list_1"],
      total: 1,
    });
    for (const candidate of [lists.data, byList.data, byRepository.data]) {
      expect(ListsQueryOutputDataSchema.safeParse(candidate).success).toBe(
        true,
      );
    }
    expect(
      ListsQueryOutputDataSchema.safeParse({
        ...byList.data,
        list_ids: ["list_1"],
      }).success,
    ).toBe(false);
  });

  it("maps discovery repository fields and evidence explicitly", () => {
    const output = toDiscoveryOutput({
      items: [{ repository: repository(), alreadyStarred: true }],
      evidence: [evidence()],
      reportedTotal: 1_500,
      cappedTotal: 1_000,
      incompleteResults: true,
      nextCursor: "2",
      rateLimit: { remaining: 29, resetAt: LATER },
    } as never);

    expect(output.data).toMatchObject({
      items: [
        {
          repository: {
            repository_id: "repo_1",
            repository_database_id: "42",
            name_with_owner: "octocat/hello-world",
            stargazers_count: 12_345,
          },
          already_starred: true,
        },
      ],
      reported_total: 1_500,
      capped_total: 1_000,
      incomplete_results: true,
    });
    expect(output.rateLimit).toEqual({ remaining: 29, resetAt: LATER });
    expect(output.nextCursor).toBe("2");
    expect(DiscoveryOutputDataSchema.parse(output.data)).toEqual(output.data);
    expect(JSON.stringify(output.data)).not.toMatch(
      /full_name|stargazer_count|is_fork|is_archived|is_disabled|primary_language|license_spdx_id/,
    );
  });

  it("accepts the bounded text sizes guaranteed by the GitHub adapter", () => {
    const discovery = toDiscoveryOutput({
      items: [
        {
          repository: repository({
            description: "d".repeat(8_192),
            topics: ["t".repeat(100)],
          }),
          alreadyStarred: false,
        },
      ],
      evidence: [],
      reportedTotal: 1,
      cappedTotal: 1,
      incompleteResults: false,
      nextCursor: null,
      rateLimit: null,
    } as never);
    const lists = toListsQueryOutput({
      snapshotId: "snap_1",
      coverage: "complete",
      items: [
        {
          listId: "list_1",
          name: "n".repeat(255),
          slug: "s".repeat(255),
          description: "d".repeat(8_192),
          isPrivate: false,
          createdAt: NOW,
          updatedAt: LATER,
          lastAddedAt: null,
          repositoryCount: 0,
        },
      ],
      total: 1,
      nextCursor: null,
    } as never);

    expect(DiscoveryOutputDataSchema.safeParse(discovery.data).success).toBe(
      true,
    );
    expect(ListsQueryOutputDataSchema.safeParse(lists.data).success).toBe(true);
  });
});

describe("change-side output mappers", () => {
  it("maps Plan and Rollback to the same compact, identity-free summary", () => {
    const input = planResult();
    const planned = toPlanOutput(input as never);
    const rolledBack = toRollbackOutput(input as never);

    expect(planned.data).toEqual({
      plan_id: "plan_1",
      plan_hash: input.plan.hash,
      state: "ready",
      snapshot_id: "snap_1",
      created_at: NOW,
      expires_at: "2026-07-17T00:00:00.000Z",
      operation_count: 1,
      dependency_count: 0,
      operation_counts: {
        star: 0,
        unstar: 0,
        list_create: 1,
        list_update: 0,
        list_delete: 0,
        list_membership_set: 0,
      },
      risk_counts: { normal: 1, destructive: 0, non_reversible: 0 },
      affected_repository_ids: [],
      affected_list_ids: [],
      created_client_refs: ["ref_ai"],
      protected_repository_ids: ["repo_protected"],
      protected_list_ids: ["list_protected"],
    });
    expect(rolledBack.data).toEqual(planned.data);
    expect(planned.warnings).toEqual(["plan warning"]);
    expect(PlanOutputDataSchema.parse(planned.data)).toEqual(planned.data);
    expect(
      PlanOutputDataSchema.safeParse({
        ...planned.data,
        plan_id: " plan_1",
      }).success,
    ).toBe(false);
    expect(JSON.stringify(planned.data)).not.toMatch(
      /account-secret|octocat|github\.com|callerNote|caller_note|binding/i,
    );
  });

  it("maps all four Inspect branches without account identity", () => {
    const plan = planResult().plan;
    const planOutput = toInspectOutput({
      kind: "plan",
      plan: {
        id: plan.id,
        hash: plan.hash,
        state: plan.state,
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
        callerNote: plan.callerNote,
        binding: plan.executable.binding,
        snapshotId: plan.executable.snapshotId,
        schemaVersion: 1,
        policyVersion: "1",
        protectedRepositoryIds: plan.executable.protectedRepositoryIds,
        protectedListIds: plan.executable.protectedListIds,
        warnings: plan.warnings,
        operationCount: 1,
        dependencyCount: 0,
      },
      operations: [{ sequence: 0, operation: resolvedCreateOperation() }],
      total: 1,
      nextCursor: null,
    } as never);
    const runOutput = toInspectOutput({
      kind: "run",
      run: run(),
      operations: [runOperation()],
      total: 1,
      nextCursor: "next_run",
    } as never);
    const attemptsOutput = toInspectOutput({
      kind: "attempts",
      run: run(),
      operationId: "op_1",
      attempts: [
        {
          runId: "run_1",
          operationId: "op_1",
          attempt: 1,
          before: { starred: false },
          status: "succeeded",
          reconciliation: "not_required",
          after: { starred: true },
          externalRequestId: "request_1",
          error: null,
          startedAt: NOW,
          finishedAt: LATER,
        },
      ],
      total: 1,
      nextCursor: null,
    } as never);
    const reconciliationsOutput = toInspectOutput({
      kind: "reconciliations",
      run: run(),
      operationId: "op_1",
      reconciliations: [
        {
          runId: "run_1",
          operationId: "op_1",
          attempt: 1,
          eventSequence: 1,
          status: "succeeded",
          reconciliation: "confirmed_applied",
          after: { starred: true },
          error: null,
          observedAt: LATER,
        },
      ],
      total: 1,
      nextCursor: null,
    } as never);

    for (const output of [
      planOutput,
      runOutput,
      attemptsOutput,
      reconciliationsOutput,
    ]) {
      expect(InspectOutputDataSchema.safeParse(output.data).success).toBe(true);
      expect(JSON.stringify(output.data)).not.toMatch(
        /account-secret|binding|account_id|accountId/i,
      );
    }
    expect(planOutput.data).toMatchObject({
      kind: "plan",
      plan: {
        plan_id: "plan_1",
        plan_hash: plan.hash,
        caller_note: "private planning note",
      },
    });
    expect(runOutput.nextCursor).toBe("next_run");
    expect(attemptsOutput.data).toMatchObject({
      kind: "attempts",
      operation_id: "op_1",
    });
    expect(reconciliationsOutput.data).toMatchObject({
      kind: "reconciliations",
      reconciliations: [{ event_sequence: 1 }],
    });
  });

  it("rejects malformed hidden bindings and inconsistent Inspect totals", () => {
    const plan = planResult().plan;
    expect(() =>
      toInspectOutput({
        kind: "plan",
        plan: {
          id: plan.id,
          hash: plan.hash,
          state: plan.state,
          createdAt: plan.createdAt,
          expiresAt: plan.expiresAt,
          callerNote: plan.callerNote,
          binding: {
            host: "evil.example",
            login: "octocat",
            accountId: "account-secret",
          },
          snapshotId: plan.executable.snapshotId,
          schemaVersion: 1,
          policyVersion: "1",
          protectedRepositoryIds: [],
          protectedListIds: [],
          warnings: [],
          operationCount: 0,
          dependencyCount: 0,
        },
        operations: [],
        total: 0,
        nextCursor: null,
      } as never),
    ).toThrow();

    expect(
      InspectOutputDataSchema.safeParse({
        kind: "run",
        run: {
          run_id: "run_1",
          plan_id: "plan_1",
          state: "completed",
          failure_mode: "continue",
          started_at: NOW,
          finished_at: LATER,
        },
        operations: [
          {
            run_id: "run_1",
            operation_id: "op_1",
            sequence: 0,
            status: "succeeded",
            reconciliation: "not_required",
            attempts: 1,
            before: {},
            after: {},
            external_request_id: null,
            error: null,
            started_at: NOW,
            finished_at: LATER,
          },
        ],
        total: 0,
      }).success,
    ).toBe(false);

    expect(
      InspectOutputDataSchema.safeParse({
        kind: "attempts",
        run: {
          run_id: "run_1",
          plan_id: "plan_1",
          state: "completed",
          failure_mode: "continue",
          started_at: NOW,
          finished_at: LATER,
        },
        operation_id: "op_1",
        attempts: [
          {
            run_id: "run_1",
            operation_id: "op_1",
            attempt: 1,
            status: "succeeded",
            reconciliation: "unknown",
            before: {},
            after: {},
            external_request_id: null,
            error: null,
            started_at: NOW,
            finished_at: LATER,
          },
        ],
        total: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts every lifecycle row accepted by the domain run parsers", () => {
    const retryableError = {
      code: "RATE_LIMITED",
      message: "retry later",
      retryable: true,
      details: { operation_id: "op_1" },
    } as const;
    const terminalError = {
      code: "PRECONDITION_FAILED",
      message: "manual review required",
      retryable: false,
      details: { operation_id: "op_1" },
    } as const;
    const operationBase = {
      runId: "run_1",
      operationId: "op_1",
      sequence: 0,
      before: { starred: false },
    } as const;
    const operationRows = [
      {
        ...operationBase,
        status: "pending",
        reconciliation: "not_required",
        attempts: 0,
        after: null,
        externalRequestId: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
      {
        ...operationBase,
        status: "running",
        reconciliation: "pending",
        attempts: 1,
        after: null,
        externalRequestId: null,
        error: null,
        startedAt: NOW,
        finishedAt: null,
      },
      {
        ...operationBase,
        status: "skipped",
        reconciliation: "not_required",
        attempts: 0,
        after: null,
        externalRequestId: null,
        error: null,
        startedAt: null,
        finishedAt: LATER,
      },
      {
        ...operationBase,
        status: "succeeded",
        reconciliation: "not_required",
        attempts: 1,
        after: { starred: true },
        externalRequestId: "request_1",
        error: null,
        startedAt: NOW,
        finishedAt: LATER,
      },
      {
        ...operationBase,
        status: "succeeded",
        reconciliation: "confirmed_applied",
        attempts: 1,
        after: { starred: true },
        externalRequestId: "request_1",
        error: null,
        startedAt: NOW,
        finishedAt: LATER,
      },
      {
        ...operationBase,
        status: "failed",
        reconciliation: "confirmed_not_applied",
        attempts: 0,
        after: null,
        externalRequestId: null,
        error: retryableError,
        startedAt: null,
        finishedAt: LATER,
      },
      {
        ...operationBase,
        status: "failed",
        reconciliation: "confirmed_not_applied",
        attempts: 1,
        after: { starred: false },
        externalRequestId: "request_1",
        error: retryableError,
        startedAt: NOW,
        finishedAt: LATER,
      },
      {
        ...operationBase,
        status: "unresolved",
        reconciliation: "unknown",
        attempts: 1,
        after: { starred: true },
        externalRequestId: "request_1",
        error: terminalError,
        startedAt: NOW,
        finishedAt: LATER,
      },
    ].map(parseRunOperation);
    const activeRun = parseChangeRun(
      run({ state: "running", finishedAt: null }),
    );
    const operationOutput = toInspectOutput({
      kind: "run",
      run: activeRun,
      operations: operationRows,
      total: operationRows.length,
      nextCursor: null,
    });
    expect(
      InspectOutputDataSchema.safeParse(operationOutput.data).success,
    ).toBe(true);

    const attemptBase = {
      runId: "run_1",
      operationId: "op_1",
      attempt: 1,
      before: { starred: false },
      startedAt: NOW,
    } as const;
    const attemptRows = [
      {
        ...attemptBase,
        status: "running",
        reconciliation: "pending",
        after: null,
        externalRequestId: null,
        error: null,
        finishedAt: null,
      },
      {
        ...attemptBase,
        status: "succeeded",
        reconciliation: "not_required",
        after: { starred: true },
        externalRequestId: "request_1",
        error: null,
        finishedAt: LATER,
      },
      {
        ...attemptBase,
        status: "failed",
        reconciliation: "confirmed_not_applied",
        after: { starred: false },
        externalRequestId: "request_1",
        error: retryableError,
        finishedAt: LATER,
      },
      {
        ...attemptBase,
        status: "unresolved",
        reconciliation: "unknown",
        after: { starred: true },
        externalRequestId: "request_1",
        error: terminalError,
        finishedAt: LATER,
      },
    ].map(parseRunOperationAttempt);
    const attemptsOutput = toInspectOutput({
      kind: "attempts",
      run: activeRun,
      operationId: "op_1",
      attempts: attemptRows,
      total: attemptRows.length,
      nextCursor: null,
    });
    expect(InspectOutputDataSchema.safeParse(attemptsOutput.data).success).toBe(
      true,
    );

    const reconciliationBase = {
      runId: "run_1",
      operationId: "op_1",
      attempt: 1,
      eventSequence: 1,
      after: { starred: true },
      observedAt: LATER,
    } as const;
    const reconciliationRows = [
      {
        ...reconciliationBase,
        status: "succeeded",
        reconciliation: "confirmed_applied",
        error: null,
      },
      {
        ...reconciliationBase,
        status: "failed",
        reconciliation: "confirmed_not_applied",
        error: retryableError,
      },
      {
        ...reconciliationBase,
        status: "unresolved",
        reconciliation: "unknown",
        error: terminalError,
      },
    ].map(parseRunOperationReconciliation);
    const reconciliationsOutput = toInspectOutput({
      kind: "reconciliations",
      run: activeRun,
      operationId: "op_1",
      reconciliations: reconciliationRows,
      total: reconciliationRows.length,
      nextCursor: null,
    });
    expect(
      InspectOutputDataSchema.safeParse(reconciliationsOutput.data).success,
    ).toBe(true);
  });

  it("maps Apply actual fields and keeps its audit cursor out of paging", () => {
    const output = toApplyOutput({
      run: run({ state: "partial", warnings: ["apply warning"] }),
      warnings: ["apply warning"],
      counts: {
        pending: 0,
        running: 0,
        succeeded: 1,
        skipped: 0,
        failed: 1,
        unresolved: 0,
      },
      errors: [
        {
          code: "PARTIAL_FAILURE",
          message: "one operation failed",
          retryable: false,
          details: { operation_id: "op_2" },
        },
      ],
      auditCursor: "run_1",
    } as never);

    expect(output.data).toEqual({
      run_id: "run_1",
      plan_id: "plan_1",
      state: "partial",
      failure_mode: "continue",
      started_at: NOW,
      finished_at: LATER,
      counts: {
        pending: 0,
        running: 0,
        succeeded: 1,
        skipped: 0,
        failed: 1,
        unresolved: 0,
      },
      errors: [
        {
          code: "PARTIAL_FAILURE",
          message: "one operation failed",
          retryable: false,
          details: { operation_id: "op_2" },
        },
      ],
      audit_cursor: "run_1",
    });
    expect(output.nextCursor).toBeNull();
    expect(output.warnings).toEqual(["apply warning"]);
    expect(ApplyOutputDataSchema.parse(output.data)).toEqual(output.data);
    expect(JSON.stringify(output.data)).not.toMatch(
      /account-secret|binding|duration|reconciliation/i,
    );
  });
});

describe("output boundary rejection", () => {
  it("rejects malformed or oversized application DTOs instead of leaking them", () => {
    expect(() =>
      toStarsQueryOutput({
        snapshotId: "snap_1",
        total: 1,
        aggregates: { languages: [], archived: 0, forks: 0 },
        items: [
          {
            repository_id: "repo_1",
            binding: { accountId: "must-not-leak" },
          },
        ],
        evidence: [],
        nextCursor: null,
      } as never),
    ).toThrow();

    expect(() =>
      toDiscoveryOutput({
        items: Array.from({ length: 101 }, () => ({
          repository: repository(),
          alreadyStarred: false,
        })),
        evidence: [],
        reportedTotal: 101,
        cappedTotal: 101,
        incompleteResults: false,
        nextCursor: null,
        rateLimit: null,
      } as never),
    ).toThrow();

    expect(() =>
      toApplyOutput({
        run: run(),
        warnings: [],
        counts: {
          pending: 0,
          running: 0,
          succeeded: 0,
          skipped: 0,
          failed: 21,
          unresolved: 0,
        },
        errors: Array.from({ length: 21 }, () => ({
          code: "PARTIAL_FAILURE",
          message: "failed",
          retryable: false,
          details: {},
        })),
        auditCursor: null,
      } as never),
    ).toThrow();

    expect(() =>
      toApplyOutput({
        run: run(),
        warnings: ["run warning"],
        counts: {
          pending: 0,
          running: 0,
          succeeded: 0,
          skipped: 0,
          failed: 1,
          unresolved: 0,
        },
        errors: [
          {
            code: "PARTIAL_FAILURE",
            message: "failed",
            retryable: false,
            details: {
              binding: {
                host: "github.com",
                login: "octocat",
                accountId: "must-not-leak",
              },
            },
          },
        ],
        auditCursor: null,
      } as never),
    ).toThrow();
  });

  it("normalizes warnings deterministically without accepting non-strings", () => {
    expect(normalizeOutputWarnings(["one", "two"])).toEqual(["one", "two"]);
    expect(normalizeOutputWarnings(["broken \ud800 warning"])).toEqual([
      "broken \ufffd warning",
    ]);
    expect(() => normalizeOutputWarnings(["safe", 2] as never)).toThrow();
  });

  it("keeps every mapped success data object accepted by its advertised schema", () => {
    const status = toStatusOutput({
      serverVersion: "1.0.0",
      host: "github.com",
      login: "octocat",
      credentialSource: "gh",
      capabilities: {
        starRead: "available",
        starWrite: "available",
        listRead: "available",
        listWrite: "available",
      },
      databaseSchemaVersion: 2,
      latestCompleteSnapshot: null,
      incompleteRuns: { items: [], total: 0, truncated: false },
      rateLimit: null,
    } as never);
    const sync = toSyncOutput({
      snapshotId: "snap_1",
      counts: {
        repositories: 1,
        stars: 1,
        lists: 0,
        memberships: 0,
        refreshedRepositories: 1,
        reusedMetadata: 0,
        warnings: 0,
      },
      warnings: [],
      rateLimit: null,
      durationMs: 1,
    } as never);
    const stars = toStarsQueryOutput({
      snapshotId: "snap_1",
      total: 0,
      aggregates: { languages: [], archived: 0, forks: 0 },
      items: [],
      evidence: [],
      nextCursor: null,
    } as never);
    const lists = toListsQueryOutput({
      snapshotId: "snap_1",
      coverage: "complete",
      items: [],
      total: 0,
      nextCursor: null,
    } as never);
    const plan = toPlanOutput(planResult([]) as never);
    const inspect = toInspectOutput({
      kind: "run",
      run: run({ warnings: [] }),
      operations: [],
      total: 0,
      nextCursor: null,
    } as never);
    const apply = toApplyOutput({
      run: run({ warnings: [] }),
      warnings: [],
      counts: {
        pending: 0,
        running: 0,
        succeeded: 0,
        skipped: 0,
        failed: 0,
        unresolved: 0,
      },
      errors: [],
      auditCursor: null,
    } as never);
    const rollback = toRollbackOutput(planResult([]) as never);
    const discovery = toDiscoveryOutput({
      items: [],
      evidence: [],
      reportedTotal: 0,
      cappedTotal: 0,
      incompleteResults: false,
      nextCursor: null,
      rateLimit: null,
    });

    const outputs = {
      github_stars_status: status,
      github_stars_sync: sync,
      github_stars_query: stars,
      github_lists_query: lists,
      github_changes_plan: plan,
      github_changes_inspect: inspect,
      github_changes_apply: apply,
      github_changes_rollback: rollback,
      github_repositories_discover: discovery,
      github_repositories_candidates: toCandidatesOutput({
        items: [],
        total: 0,
        nextCursor: null,
      }),
    } as const;

    for (const name of ToolNames) {
      const output = outputs[name];
      const rendered = toolSuccess(output.data, {
        requestId: "req_1",
        summary: "Mapped output",
        warnings: output.warnings,
        rateLimit: output.rateLimit,
        nextCursor: output.nextCursor,
      });
      expect(
        ToolOutputSchemas[name].safeParse(rendered.structuredContent).success,
      ).toBe(true);
    }
  });
});
