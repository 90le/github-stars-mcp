# MCP, CLI, and Codex Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the completed application services as nine safe, typed MCP tools, a protocol-clean stdio executable, diagnostics, and an optional Codex plugin.

**Architecture:** The MCP layer validates Zod input, calls application-service interfaces, and maps results into a versioned envelope; it contains no GitHub or SQL logic. The CLI owns process startup and stderr diagnostics, while the plugin contains only distribution metadata and agent instructions.

**Tech Stack:** Node.js 22/24, TypeScript 6.0.3, ESM, `@modelcontextprotocol/sdk` 1.29.0, Zod v4, Vitest v4, npm.

## Global Constraints

- Target MCP protocol revision `2025-11-25` through SDK 1.29.0.
- Reserve stdout exclusively for stdio JSON-RPC; write diagnostics to stderr or MCP logging.
- Expose exactly nine named tools and no generic REST, GraphQL, URL, browser, or shell tool.
- Return `schema_version: "1"`, concise text, and matching `structuredContent` from every tool.
- Start in read-only mode; only `github_changes_apply` can perform GitHub mutations.
- Keep the Codex plugin free of credentials and business logic.
- Published plugin configuration must use `github-stars-mcp@1.0.0`, never `@latest`.
- Support Windows, macOS, and Linux on Node 22 and 24.

## File Map

- `src/mcp/result.ts`: success/error envelopes and safe text summaries.
- `src/mcp/schemas/common.ts`: identifiers, cursor, pagination, filter, and result schemas.
- `src/mcp/schemas/read-tools.ts`: status, sync, Stars query, Lists query, and discovery input schemas.
- `src/mcp/schemas/change-tools.ts`: plan, inspect, apply, and rollback input schemas.
- `src/mcp/schemas/output.ts`: nine concrete success-envelope output schemas.
- `src/mcp/register-read-tools.ts`: five read/local-write tool registrations.
- `src/mcp/register-change-tools.ts`: four plan/apply/audit tool registrations.
- `src/mcp/create-server.ts`: server identity, instructions, and dependency injection.
- `src/cli.ts`: option parsing, startup, exit codes, and protocol-safe shutdown.
- `src/server.ts`: application composition root.
- `src/diagnostics/doctor.ts`: non-mutating runtime, database, credential, and capability checks.
- `src/logging/stderr-logger.ts`: structured redacted stderr logger.
- `test/unit/mcp/result.test.ts`: envelope and redaction behavior.
- `test/contract/mcp/server.test.ts`: in-process MCP client contract.
- `test/contract/mcp/stdio.test.ts`: spawned stdio protocol contract.
- `test/security/mcp-surface.test.ts`: exact tool allowlist and schema attack cases.
- `test/integration/cli.test.ts`: help, version, doctor, and exit behavior.
- `plugin/.codex-plugin/plugin.json`: Codex package metadata.
- `plugin/.mcp.json`: exact-package stdio server configuration.
- `plugin/skills/manage-github-stars/SKILL.md`: safe agent workflow.
- `.agents/plugins/marketplace.json`: repository-local plugin marketplace entry.

---

### Task 1: Versioned MCP result envelopes

**Files:**
- Create: `src/mcp/result.ts`
- Create: `test/unit/mcp/result.test.ts`

**Interfaces:**
- Consumes: `AppError`/`serializeError(error)` from `src/domain/errors.ts` and `redactSecrets(value)` from `src/domain/redaction.ts`.
- Produces: `toolSuccess<T>(data, options)` and `toolFailure(error, requestId)` returning MCP-compatible call results.

- [ ] **Step 1: Write the failing envelope tests**

```ts
import { describe, expect, it } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import { toolFailure, toolSuccess } from "../../../src/mcp/result.js";

describe("MCP result envelopes", () => {
  it("returns matching concise text and structured success content", () => {
    const result = toolSuccess({ total: 2 }, { requestId: "req_1", summary: "2 repositories" });
    expect(result.content).toEqual([{ type: "text", text: "2 repositories" }]);
    expect(result.structuredContent).toEqual({
      schema_version: "1",
      ok: true,
      request_id: "req_1",
      data: { total: 2 },
      warnings: [],
      rate_limit: null,
      next_cursor: null,
    });
  });

  it("marks failures as MCP errors and redacts arbitrary supplied secrets", () => {
    const arbitrarySecret = "not-pattern-matched-secret-value";
    const error = new AppError(
      "AUTH_REQUIRED",
      `credential ${arbitrarySecret} leaked`,
      {
        retryable: false,
        details: {
          authorization: `Bearer ${arbitrarySecret}`,
          cookie: arbitrarySecret,
          subprocess: { stdout: arbitrarySecret },
        },
        secrets: [arbitrarySecret],
        cause: new Error(arbitrarySecret),
      },
    );
    const result = toolFailure(error, "req_2");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(arbitrarySecret);
    expect(result.structuredContent.error.code).toBe("AUTH_REQUIRED");
  });

  it("never invokes getters while serializing unknown failures", () => {
    const hostile = Object.defineProperty({}, "token", {
      enumerable: true,
      get: () => { throw new Error("getter was invoked"); },
    });
    expect(() => toolFailure(hostile, "req_3")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npm test -- test/unit/mcp/result.test.ts`

Expected: FAIL because `src/mcp/result.ts` does not exist.

- [ ] **Step 3: Implement the result helpers**

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serializeError } from "../domain/errors.js";
import { redactSecrets } from "../domain/redaction.js";

type ResultOptions = {
  requestId: string;
  summary: string;
  warnings?: string[];
  rateLimit?: Record<string, unknown> | null;
  nextCursor?: string | null;
};

export function toolSuccess<T extends Record<string, unknown>>(
  data: T,
  options: ResultOptions,
): CallToolResult {
  const structuredContent = {
    schema_version: "1",
    ok: true,
    request_id: options.requestId,
    data,
    warnings: options.warnings ?? [],
    rate_limit: options.rateLimit ?? null,
    next_cursor: options.nextCursor ?? null,
  };
  return { content: [{ type: "text", text: options.summary }], structuredContent };
}

export function toolFailure(error: unknown, requestId: string): CallToolResult {
  const appError = serializeError(error);
  const message = redactSecrets(appError.message);
  const structuredContent = {
    schema_version: "1",
    ok: false,
    request_id: requestId,
    error: {
      code: appError.code,
      message,
      retryable: appError.retryable,
      details: redactSecrets(appError.details ?? {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: `${appError.code}: ${message}` }],
    structuredContent,
  };
}
```

- [ ] **Step 4: Run the focused tests**

Run: `npm test -- test/unit/mcp/result.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/result.ts test/unit/mcp/result.test.ts
git commit -m "feat: add MCP result envelopes"
```

### Task 2: Shared MCP schemas and service contract

**Files:**
- Create: `src/mcp/schemas/common.ts`
- Create: `src/mcp/schemas/read-tools.ts`
- Create: `src/mcp/schemas/change-tools.ts`
- Create: `src/mcp/schemas/output.ts`
- Create: `src/mcp/mappers.ts`
- Create: `src/app/services/service-registry.ts`
- Create: `test/unit/mcp/schemas.test.ts`

**Interfaces:**
- Consumes: `FilterExpression`, `PlanRequest`, and application result types from plans 01 through 03.
- Produces: `ServiceRegistry`, all nine input schemas, nine concrete success-envelope output schemas, exact public tool-name constants, and explicit snake-case MCP to camel-case application DTO mappers.

- [ ] **Step 1: Write schema boundary tests**

```ts
import { describe, expect, it } from "vitest";
import { ToolNames } from "../../../src/mcp/schemas/common.js";
import { ApplyInputSchema } from "../../../src/mcp/schemas/change-tools.js";
import { SyncInputSchema } from "../../../src/mcp/schemas/read-tools.js";
import { ToolOutputSchemas } from "../../../src/mcp/schemas/output.js";
import { toApplyInput } from "../../../src/mcp/mappers.js";

describe("MCP schemas", () => {
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

  it("rejects unbounded pages and apply without a hash", () => {
    expect(SyncInputSchema.parse({})).toEqual({ mode: "incremental", include_lists: true, metadata_max_age_hours: 24 });
    expect(() => ApplyInputSchema.parse({ plan_id: "plan_1" })).toThrow();
  });

  it("maps public apply fields without accepting caller account identity", () => {
    expect(toApplyInput({
      plan_id: "plan_1",
      expected_hash: "a".repeat(64),
      failure_mode: "continue",
    })).toEqual({
      planId: "plan_1",
      expectedHash: "a".repeat(64),
      failureMode: "continue",
    });
  });

  it("exposes a concrete output schema for every public tool", () => {
    expect(Object.keys(ToolOutputSchemas).sort()).toEqual([...ToolNames].sort());
    for (const name of ToolNames) expect(ToolOutputSchemas[name]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- test/unit/mcp/schemas.test.ts`

Expected: FAIL because the schema modules do not exist.

- [ ] **Step 3: Implement exact shared schemas and registry signatures**

```ts
// src/mcp/schemas/common.ts
import { z } from "zod";

export const ToolNames = [
  "github_stars_status", "github_stars_sync", "github_stars_query", "github_lists_query",
  "github_changes_plan", "github_changes_inspect", "github_changes_apply",
  "github_changes_rollback", "github_repositories_discover",
] as const;

export const CursorSchema = z.string().min(1).max(2048);
export const PageSizeSchema = z.number().int().min(1).max(100).default(50);
export const RepositoryIdSchema = z.string().min(1).max(128);
export const UserListIdSchema = z.string().min(1).max(128);
export const SnapshotIdSchema = z.string().min(1).max(128);
export const QueryFieldSchema = z.enum([
  "repository_id", "repository_database_id", "name_with_owner", "owner", "name",
  "description", "url", "stargazers_count", "fork", "archived", "disabled",
  "visibility", "is_private", "language", "topics", "license", "pushed_at",
  "updated_at", "starred_at", "list_ids",
]);
export const SortFieldSchema = z.enum([
  "stargazers_count", "pushed_at", "updated_at", "starred_at", "name_with_owner",
]);
export const FieldsSchema = z.array(QueryFieldSchema).max(32);

const FilterFieldSchema = z.enum([
  "repository_id", "name_with_owner", "owner", "name", "stargazers_count",
  "pushed_at", "updated_at", "starred_at", "language", "topics", "license",
  "list_ids", "is_unclassified", "archived", "disabled", "fork", "visibility",
  "is_private", "description",
]);
const FilterValueSchema = z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(z.union([z.string(), z.number().finite(), z.boolean()])).max(5_000),
  z.object({
    ago: z.object({
      amount: z.number().int().min(1).max(10_000),
      unit: z.enum(["hours", "days", "weeks", "months", "years"]),
    }).strict(),
  }).strict(),
]);
const ComparisonSchema = z.object({
  field: FilterFieldSchema,
  op: z.enum(["eq", "ne", "in", "not_in", "contains", "gt", "gte", "lt", "lte", "before", "after", "is_null"]),
  value: FilterValueSchema.optional(),
}).strict();
export const FilterExpressionSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  ComparisonSchema,
  z.object({ all: z.array(FilterExpressionSchema).min(1).max(64) }).strict(),
  z.object({ any: z.array(FilterExpressionSchema).min(1).max(64) }).strict(),
  z.object({ not: FilterExpressionSchema }).strict(),
]));
export const RepositorySelectorSchema = z.union([
  z.object({ repository_ids: z.array(RepositoryIdSchema).min(1).max(5_000) }).strict(),
  z.object({ where: FilterExpressionSchema }).strict(),
]);
export const ResultEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) => z.object({
  schema_version: z.literal("1"),
  ok: z.literal(true),
  request_id: z.string().min(1),
  data,
  warnings: z.array(z.string()),
  rate_limit: z.record(z.string(), z.unknown()).nullable(),
  next_cursor: z.string().nullable(),
}).strict();
```

```ts
// src/mcp/schemas/read-tools.ts
import { z } from "zod";
import {
  CursorSchema, FieldsSchema, FilterExpressionSchema, PageSizeSchema, SnapshotIdSchema,
  SortFieldSchema, UserListIdSchema,
} from "./common.js";

export const StatusInputSchema = z.object({
  refresh_capabilities: z.boolean().default(false),
}).strict();
export const SyncInputSchema = z.object({
  mode: z.enum(["full", "incremental"]).default("incremental"),
  include_lists: z.boolean().default(true),
  metadata_max_age_hours: z.number().int().min(0).max(8760).default(24),
}).strict();
export const StarsQueryInputSchema = z.object({
  snapshot_id: SnapshotIdSchema.optional(),
  where: FilterExpressionSchema.optional(),
  sort: z.array(z.object({
    field: SortFieldSchema,
    direction: z.enum(["asc", "desc"]),
  }).strict()).min(1).max(4).default([{ field: "starred_at", direction: "desc" }]),
  limit: PageSizeSchema,
  cursor: CursorSchema.optional(),
  fields: FieldsSchema.optional(),
  evidence: z.enum(["none", "summary", "readme"]).default("none"),
  evidence_limit: z.number().int().min(0).max(20).default(0),
}).strict();
export const ListsQueryInputSchema = z.object({
  snapshot_id: SnapshotIdSchema.optional(),
  list_ids: z.array(UserListIdSchema).max(100).optional(),
  include_memberships: z.boolean().default(true),
  limit: PageSizeSchema,
  cursor: CursorSchema.optional(),
}).strict();
export const DiscoverInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
  sort: z.enum(["best-match", "stars", "forks", "help-wanted-issues", "updated"]).default("best-match"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).max(10).default(1),
  per_page: z.number().int().min(1).max(100).default(30),
  evidence: z.enum(["none", "summary", "readme"]).default("none"),
  evidence_limit: z.number().int().min(0).max(20).default(0),
}).strict();

export type StatusInput = z.infer<typeof StatusInputSchema>;
export type SyncInput = z.infer<typeof SyncInputSchema>;
export type StarsQueryInput = z.infer<typeof StarsQueryInputSchema>;
export type ListsQueryInput = z.infer<typeof ListsQueryInputSchema>;
export type DiscoverInput = z.infer<typeof DiscoverInputSchema>;
```

```ts
// src/mcp/schemas/change-tools.ts
import { z } from "zod";
import {
  CursorSchema, FilterExpressionSchema, PageSizeSchema, RepositoryIdSchema,
  RepositorySelectorSchema, SnapshotIdSchema, UserListIdSchema,
} from "./common.js";

const ListRefSchema = z.string().regex(/^ref_[A-Za-z0-9_-]{1,64}$/);
const ListSelectorSchema = z.object({
  list_ids: z.array(UserListIdSchema).min(1).max(5_000),
}).strict();
const PlanOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("star"), selector: RepositorySelectorSchema }).strict(),
  z.object({ kind: z.literal("unstar"), selector: RepositorySelectorSchema }).strict(),
  z.object({
    kind: z.literal("list_create"),
    client_ref: ListRefSchema,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1024).nullable().default(null),
    is_private: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("list_update"),
    selector: ListSelectorSchema,
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(1024).nullable().optional(),
    is_private: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal("list_delete"), selector: ListSelectorSchema }).strict(),
  z.object({
    kind: z.literal("list_membership_set"),
    repository_id: RepositoryIdSchema,
    list_ids: z.array(UserListIdSchema).max(5_000).default([]),
    list_refs: z.array(ListRefSchema).max(5_000).default([]),
  }).strict(),
  z.object({
    kind: z.literal("list_membership_add"),
    repository_id: RepositoryIdSchema,
    list_ids: z.array(UserListIdSchema).max(5_000).default([]),
    list_refs: z.array(ListRefSchema).max(5_000).default([]),
  }).strict(),
  z.object({
    kind: z.literal("list_membership_remove"),
    repository_id: RepositoryIdSchema,
    list_ids: z.array(UserListIdSchema).min(1).max(5_000),
  }).strict(),
]);

export const PlanInputSchema = z.object({
  snapshot_id: SnapshotIdSchema,
  operations: z.array(PlanOperationSchema).min(1).max(5_000),
  protected_repository_ids: z.array(RepositoryIdSchema).max(5_000).default([]),
  protected_list_ids: z.array(UserListIdSchema).max(5_000).default([]),
  expires_in_minutes: z.number().int().min(1).max(10_080).optional(),
  caller_note: z.string().max(2_000).optional(),
}).strict();
export const InspectInputSchema = z.object({
  kind: z.enum(["plan", "run"]),
  id: z.string().min(1).max(128),
  limit: PageSizeSchema,
  cursor: CursorSchema.optional(),
}).strict();

export const ApplyInputSchema = z.object({
  plan_id: z.string().min(1),
  expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
  failure_mode: z.enum(["stop", "continue"]).default("stop"),
}).strict();
export const RollbackInputSchema = z.object({
  run_id: z.string().min(1).max(128),
  protected_repository_ids: z.array(RepositoryIdSchema).max(5_000).default([]),
  protected_list_ids: z.array(UserListIdSchema).max(5_000).default([]),
}).strict();

export type PlanInput = z.infer<typeof PlanInputSchema>;
export type InspectInput = z.infer<typeof InspectInputSchema>;
export type ApplyInput = z.infer<typeof ApplyInputSchema>;
export type RollbackInput = z.infer<typeof RollbackInputSchema>;
```

```ts
// src/mcp/schemas/output.ts
const ToolSuccessBase = z.object({
  schema_version: z.literal("1"),
  ok: z.literal(true),
  request_id: z.string().min(1),
  warnings: z.array(z.string()),
  rate_limit: z.record(z.string(), z.unknown()).nullable(),
  next_cursor: z.string().nullable(),
}).strict();

const ToolFailureEnvelope = z.object({
  schema_version: z.literal("1"),
  ok: z.literal(false),
  request_id: z.string().min(1),
  error: z.object({
    code: z.enum(APP_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown(),
  }).strict(),
}).strict();

const outputEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion("ok", [
    ToolSuccessBase.extend({ data }),
    ToolFailureEnvelope,
  ]);

export const ToolOutputSchemas = {
  github_stars_status: outputEnvelope(StatusOutputDataSchema),
  github_stars_sync: outputEnvelope(SyncOutputDataSchema),
  github_stars_query: outputEnvelope(StarsQueryOutputDataSchema),
  github_lists_query: outputEnvelope(ListsQueryOutputDataSchema),
  github_changes_plan: outputEnvelope(PlanOutputDataSchema),
  github_changes_inspect: outputEnvelope(InspectOutputDataSchema),
  github_changes_apply: outputEnvelope(ApplyOutputDataSchema),
  github_changes_rollback: outputEnvelope(RollbackOutputDataSchema),
  github_repositories_discover: outputEnvelope(DiscoveryOutputDataSchema),
} as const satisfies Record<(typeof ToolNames)[number], z.ZodTypeAny>;
```

Each named `*OutputDataSchema` is strict, bounded, and mirrors its application
result DTO; repository/List arrays use `.max(100)`, evidence uses `.max(20)`,
and apply error summaries use `.max(100)`. Every schema is a discriminated
success/failure union, so `ok:false` structured errors are valid advertised
output too. The common registration helper attaches the complete
`outputSchema: ToolOutputSchemas[name]` to every
`server.registerTool` call. Contract tests list all nine tools, assert both
`inputSchema` and `outputSchema` are non-empty JSON Schemas, call every tool,
and validate both successful and forced-error `structuredContent` with the
matching Zod schema.

```ts
// src/mcp/mappers.ts
export function toCreatePlanInput(input: PlanInput): CreatePlanInput {
  return {
    snapshotId: asSnapshotId(input.snapshot_id),
    actions: input.operations.map(toPlanAction),
    protectedRepositoryIds: input.protected_repository_ids.map(asRepositoryId),
    protectedListIds: input.protected_list_ids.map(asUserListId),
    ...(input.expires_in_minutes === undefined ? {} : { ttlMinutes: input.expires_in_minutes }),
    ...(input.caller_note === undefined ? {} : { callerNote: input.caller_note }),
  };
}

export function toApplyInput(input: ApplyInput): ApplyServiceInput {
  return {
    planId: asPlanId(input.plan_id),
    expectedHash: input.expected_hash,
    failureMode: input.failure_mode,
  };
}

export function toRollbackInput(input: RollbackInput): CreateRollbackInput {
  return {
    runId: asRunId(input.run_id),
    protectedRepositoryIds: input.protected_repository_ids.map(asRepositoryId),
    protectedListIds: input.protected_list_ids.map(asUserListId),
  };
}

export function toInspectInput(input: InspectInput): InspectServiceInput {
  return { kind: input.kind, id: input.id, limit: input.limit, cursor: input.cursor ?? null };
}
```

`toPlanAction` must exhaustively switch over the eight public request kinds,
convert every node ID through its branded constructor, preserve `client_ref`,
and convert snake-case List properties to domain camel case. The query mapper
must also map the public names (`name_with_owner`, `stargazers_count`,
`language`, `license`, `archived`, `disabled`, `fork`, and `is_unclassified`)
to the closed Plan 01 domain fields or derived predicates, and map `ne` /
`not_in` to the domain operator names. Add equivalent explicit mappers for
sync, Stars query, Lists query, and discovery. No public schema contains host,
login, account ID, or token; services derive identity from the bound
snapshot/run and the injected GitHub adapter.

```ts
// src/app/services/service-registry.ts
import type { ApplyService } from "./apply-service.js";
import type { DiscoveryService } from "./discovery-service.js";
import type { InspectService } from "./inspect-service.js";
import type { ListsQueryService } from "./lists-query-service.js";
import type { PlanService } from "./plan-service.js";
import type { QueryService } from "./query-service.js";
import type { RollbackService } from "./rollback-service.js";
import type { StatusService } from "./status-service.js";
import type { SyncService } from "./sync-service.js";

export type ServiceRegistry = Readonly<{
  status: StatusService;
  sync: SyncService;
  query: QueryService;
  listsQuery: ListsQueryService;
  discover: DiscoveryService;
  plan: PlanService;
  inspect: InspectService;
  apply: ApplyService;
  rollback: RollbackService;
}>;
```

Add schema-level refinements that reject an empty List update, reject duplicate
`client_ref` values within one plan, require at least one `list_id` or
`list_ref` for membership add, reject `value` for `is_null`, and require
`value` for every other filter operator. Relative `{ago:...}` values are valid
only for temporal `before`/`after` comparisons and are resolved with the
injected request clock before query execution or plan resolution.
Registration callbacks consume only `z.infer` types and perform no casts from
unvalidated input.

- [ ] **Step 4: Run schema tests and type checking**

Run: `npm test -- test/unit/mcp/schemas.test.ts && npm run typecheck`

Expected: PASS; TypeScript reports zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/schemas src/mcp/mappers.ts src/app/services/service-registry.ts test/unit/mcp/schemas.test.ts
git commit -m "feat: define MCP tool schemas"
```

### Task 3: Register five read and local-write tools

**Files:**
- Create: `src/mcp/register-read-tools.ts`
- Create: `test/contract/mcp/read-tools.test.ts`
- Create: `test/fixtures/fake-services.ts`

**Interfaces:**
- Consumes: `ServiceRegistry`, read-tool Zod schemas, `toolSuccess`, `toolFailure`, and `newRequestId()`.
- Produces: `registerReadTools(server, services)` registering status, sync, Stars query, Lists query, and discovery.

- [ ] **Step 1: Write an in-process registration contract**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerReadTools } from "../../../src/mcp/register-read-tools.js";
import { fakeServices } from "../../fixtures/fake-services.js";

it("lists and calls the five read-side tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({name:"read-contract",version:"0.0.0"});
  registerReadTools(server, fakeServices());
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain("github_stars_sync");
  const result = await client.callTool({ name: "github_stars_status", arguments: {} });
  expect(result.structuredContent).toMatchObject({ schema_version: "1", ok: true });
});
```

- [ ] **Step 2: Run the contract and verify the missing registration failure**

Run: `npm test -- test/contract/mcp/read-tools.test.ts`

Expected: FAIL because `createMcpServer` and read registrations do not exist.

- [ ] **Step 3: Register all five tools through one typed helper**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceRegistry } from "../app/services/service-registry.js";
import { toolFailure, toolSuccess } from "./result.js";
import { newRequestId } from "../domain/ids.js";
import { ReadToolDefinitions } from "./schemas/read-tools.js";

export function registerReadTools(server: McpServer, services: ServiceRegistry): void {
  for (const definition of ReadToolDefinitions(services)) {
    server.registerTool(definition.name, definition.config, async (input, context) => {
      const requestId = newRequestId();
      try {
        const output = await definition.execute(input, context.signal);
        return toolSuccess(output.data, {
          requestId,
          summary: output.summary,
          warnings: output.warnings,
          rateLimit: output.rateLimit,
          nextCursor: output.nextCursor,
        });
      } catch (error) {
        return toolFailure(error, requestId);
      }
    });
  }
}
```

`ReadToolDefinitions` must contain five explicit entries. Mark status, Stars query, Lists query, and discovery `readOnlyHint: true`; mark sync `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`. Each description must say whether it reads the network, writes only local state, or may fetch untrusted README data.

Each entry must call its explicit mapper from `src/mcp/mappers.ts` before the service: `toStatusInput`, `toSyncInput`, `toStarsQueryInput`, `toListsQueryInput`, or `toDiscoverInput`. Do not bind a service method directly to an MCP callback; the public schemas use snake case while application DTOs use camel case.
Every entry passes its exact `ToolOutputSchemas[name]` to the registration
helper. The contract must assert the advertised output JSON Schema exists and
the successful call's `structuredContent` validates against it.
Task 3 deliberately constructs a bare SDK `McpServer`; the production
`createMcpServer` composition root is not needed until Task 5.

- [ ] **Step 4: Run read contracts**

Run: `npm test -- test/contract/mcp/read-tools.test.ts`

Expected: PASS and list exactly the expected read-side names.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/register-read-tools.ts src/mcp/schemas/read-tools.ts test/contract/mcp/read-tools.test.ts test/fixtures/fake-services.ts
git commit -m "feat: expose read-side MCP tools"
```

### Task 4: Register plan, inspect, apply, and rollback tools

**Files:**
- Create: `src/mcp/register-change-tools.ts`
- Create: `test/contract/mcp/change-tools.test.ts`
- Create: `test/security/mcp-surface.test.ts`

**Interfaces:**
- Consumes: plan, inspect, apply, and rollback services from `ServiceRegistry`.
- Produces: `registerChangeTools(server, services)` and a negative surface contract.

- [ ] **Step 1: Write change-tool and attack-surface tests**

```ts
const fake = fakeServices();
const server = new McpServer({name:"change-contract",version:"0.0.0"});
registerReadTools(server, fake);
registerChangeTools(server, fake);
const client = await connectInMemory(server);

it("requires plan_id and expected_hash before apply reaches the service", async () => {
  const result = await client.callTool({ name: "github_changes_apply", arguments: { plan_id: "plan_1" } });
  expect(result.isError).toBe(true);
  expect(fake.apply.apply).not.toHaveBeenCalled();
});

it("exposes no generic or repository-administration tool", async () => {
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toHaveLength(9);
  expect(names.join(" ")).not.toMatch(/graphql|request|shell|delete_repository|contents|archive|transfer/i);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm test -- test/contract/mcp/change-tools.test.ts test/security/mcp-surface.test.ts`

Expected: FAIL because change tools are not registered.

- [ ] **Step 3: Implement explicit change registrations**

```ts
export function registerChangeTools(server: McpServer, services: ServiceRegistry): void {
  register(server, "github_changes_plan", ChangeSchemas.plan, (input) =>
    services.plan.create(toCreatePlanInput(input)), {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  });
  register(server, "github_changes_inspect", ChangeSchemas.inspect, (input) =>
    services.inspect.inspect(toInspectInput(input)), {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  register(server, "github_changes_apply", ChangeSchemas.apply, (input, signal) =>
    services.apply.apply(toApplyInput(input), signal), {
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  });
  register(server, "github_changes_rollback", ChangeSchemas.rollback, (input) =>
    services.rollback.createRollback(toRollbackInput(input)), {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  });
}
```

The local `register` helper must parse with the supplied strict Zod schema, create a request ID, pass `context.signal`, and map through `toolSuccess`/`toolFailure`. It must not accept a URL, host, token, raw path, REST method, or GraphQL text in any schema.
It also receives and advertises the exact named output schema; a test calls all
four change tools and validates successful structured content, so none can
fall back to an untyped generic object.

- [ ] **Step 4: Run contracts and security tests**

Run: `npm test -- test/contract/mcp/change-tools.test.ts test/security/mcp-surface.test.ts`

Expected: PASS; tool count is exactly 9 and invalid apply never reaches the service.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/register-change-tools.ts src/mcp/schemas/change-tools.ts test/contract/mcp/change-tools.test.ts test/security/mcp-surface.test.ts
git commit -m "feat: expose safe change MCP tools"
```

### Task 5: Compose the MCP server and protocol-clean CLI

**Files:**
- Create: `src/mcp/create-server.ts`
- Create: `src/server.ts`
- Create: `src/cli.ts`
- Create: `src/logging/stderr-logger.ts`
- Create: `src/diagnostics/doctor.ts`
- Modify: `tsconfig.build.json`
- Modify: `package.json`
- Create: `test/contract/mcp/stdio.test.ts`
- Create: `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: `createServices(config)`, `loadConfig(env)`, `CredentialProvider`, and `SQLiteStore` from prior plans.
- Produces: `createMcpServer(services)`, `runServer(options)`, `runDoctor(options)`, and executable `github-stars-mcp`.

- [ ] **Step 1: Write spawned-process tests**

```ts
it("keeps --help on stdout but stdio logs off stdout", async () => {
  const help = await runCli(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("github-stars-mcp");

  const session = await startStdioCli({ GITHUB_STARS_MCP_READ_ONLY: "true" });
  const initialized = await session.initialize();
  expect(initialized.serverInfo.name).toBe("github-stars-mcp");
  expect(session.nonJsonStdout()).toEqual([]);
  await session.close();
});

it("runs doctor without a GitHub mutation", async () => {
  const result = await runCli(["--doctor", "--json"], fakeEnvironment());
  expect(JSON.parse(result.stdout).checks.map((check: { name: string }) => check.name)).toEqual([
    "runtime", "database", "gh", "credentials", "network", "capabilities",
  ]);
  expect(fakeGitHub.mutationCalls).toBe(0);
});

it("recovers interrupted runs before accepting the first MCP request", async () => {
  const session = await startStdioCliWithStore({
    buildingSnapshot: "snap_interrupted",
    interruptedRun: "run_interrupted",
    env: { GITHUB_STARS_MCP_READ_ONLY: "true" },
  });
  await session.initialize();
  expect(session.storeEvents()).toEqual([
    "migrate",
    "recoverIncompleteSnapshots",
    "recoverInterruptedRuns",
    "connectTransport",
  ]);
  expect(session.snapshot("snap_interrupted").status).toBe("failed");
  expect(session.run("run_interrupted").state).toBe("partial");
  await session.close();
});

it("ships one root-level executable whose version matches package.json", async () => {
  await buildProject();
  expect(await firstLine("dist/cli.js")).toBe("#!/usr/bin/env node");
  expect(packageJson().bin).toEqual({ "github-stars-mcp": "dist/cli.js" });
  expect(await runBuiltCli(["--version"])).toMatchObject({
    exitCode: 0,
    stdout: `${packageJson().version}\n`,
  });
});

it.each([
  ["all healthy", healthyDoctorEnvironment(), 0],
  ["optional Lists unavailable", degradedDoctorEnvironment(), 2],
  ["authentication unusable", brokenDoctorEnvironment(), 1],
])("returns the documented doctor status for %s", async (_name, env, code) => {
  expect((await runCli(["--doctor", "--json"], env)).exitCode).toBe(code);
});

it("rejects apply in default read-only mode and closes protocol-cleanly on signals", async () => {
  const session = await startStdioCli({});
  expect((await session.callApply(validApplyArguments())).isError).toBe(true);
  await session.sendSignal("SIGTERM");
  expect(session.nonJsonStdout()).toEqual([]);
  expect(session.auditWasFlushed()).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify missing CLI failures**

Run: `npm test -- test/contract/mcp/stdio.test.ts test/integration/cli.test.ts`

Expected: FAIL because CLI and composition modules do not exist.

- [ ] **Step 3: Implement server identity, instructions, and CLI modes**

```ts
// src/mcp/create-server.ts
export function createMcpServer(services: ServiceRegistry): McpServer {
  const server = new McpServer(
    { name: "github-stars-mcp", version: PACKAGE_VERSION },
    {
      instructions:
        "Sync before querying or planning. Protect explicit repository IDs for subjective exceptions. " +
        "Inspect the immutable plan and hash before apply. Apply only with user authorization. " +
        "This server manages Stars and Star Lists only; repository administration and contents are unavailable. " +
        "Paginate until next_cursor is null. Rollback creates another reviewed plan and cannot restore original " +
        "starred_at timestamps or deleted List IDs. Respect rate-limit reset metadata. Code inactivity uses " +
        "pushed_at; updated_at also changes for metadata.",
    },
  );
  registerReadTools(server, services);
  registerChangeTools(server, services);
  return server;
}
```

```ts
// src/cli.ts
#!/usr/bin/env node

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const options = parseCli(argv);
  if (options.help) return printHelp(process.stdout);
  if (options.version) return printVersion(process.stdout);
  if (options.doctor) return runDoctorCli(options, env, process.stdout, process.stderr);
  return runStdioCli(env, process.stderr);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
```

Keep the Plan 01 build config's `rootDir: "src"` / `outDir: "dist"` contract
and ensure it includes the new CLI sources. Add
`"bin": { "github-stars-mcp": "dist/cli.js" }`, and have `src/version.ts`
derive the runtime version from the generated/package build metadata so
`--version` always equals `package.json.version`.

`runStdioCli` must open the database, call `store.migrate()`, then call
`store.recoverIncompleteSnapshots(clock.now())`, then
`store.recoverInterruptedRuns(clock.now())` before it builds services or
connects `StdioServerTransport`. Only after that startup recovery may it accept MCP calls.
It must install `SIGINT`/`SIGTERM` handlers, stop scheduling work, flush audit
state, close the store, and emit no direct stdout writes. `--doctor` must return
exit 0 for all-pass, 2 for degraded optional capabilities, and 1 for unusable
runtime/auth/database.

- [ ] **Step 4: Run CLI, stdio, and full type checks**

Run: `npm run build && npm test -- test/contract/mcp/stdio.test.ts test/integration/cli.test.ts && npm run typecheck`

Expected: PASS; spawned stdio contains JSON-RPC only.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/create-server.ts src/server.ts src/cli.ts src/logging src/diagnostics tsconfig.build.json package.json src/version.ts test/contract/mcp/stdio.test.ts test/integration/cli.test.ts
git commit -m "feat: add stdio server and diagnostics"
```

### Task 6: Package the optional Codex plugin

**Files:**
- Create: `plugin/.codex-plugin/plugin.json`
- Create: `plugin/.mcp.json`
- Create: `plugin/skills/manage-github-stars/SKILL.md`
- Create: `.agents/plugins/marketplace.json`
- Create: `scripts/validate-plugin.mjs`
- Modify: `package.json`
- Create: `test/contract/plugin/plugin.test.ts`

**Interfaces:**
- Consumes: published executable contract `npx -y github-stars-mcp@1.0.0 --stdio`.
- Produces: installable Codex plugin `github-stars-mcp` with one workflow skill and no duplicated runtime code.

- [ ] **Step 1: Write plugin manifest and safety tests**

```ts
it("pins the MCP package and contains no credential", async () => {
  const manifest = await readJson("plugin/.codex-plugin/plugin.json");
  const mcp = await readJson("plugin/.mcp.json");
  expect(manifest.name).toBe("github-stars-mcp");
  expect(manifest.mcpServers).toBe("./.mcp.json");
  expect(mcp.mcpServers["github-stars-mcp"].args).toContain("github-stars-mcp@1.0.0");
  expect(JSON.stringify({ manifest, mcp })).not.toMatch(/ghp_|github_stars_token.*:/i);
  expect(await glob("plugin/**/*.{ts,js,mjs,cjs}")).toEqual([]);
});
```

- [ ] **Step 2: Run the plugin test and verify missing files**

Run: `npm test -- test/contract/plugin/plugin.test.ts`

Expected: FAIL because plugin metadata is absent.

- [ ] **Step 3: Create exact plugin metadata and MCP launcher configuration**

```json
{
  "name": "github-stars-mcp",
  "version": "1.0.0",
  "description": "Let AI agents discover, organize, audit, and safely manage GitHub Stars and Star Lists.",
  "author": { "name": "90le", "url": "https://github.com/90le" },
  "homepage": "https://github.com/90le/github-stars-mcp",
  "repository": "https://github.com/90le/github-stars-mcp",
  "license": "Apache-2.0",
  "keywords": ["github", "stars", "mcp", "ai-agent", "codex"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "GitHub Stars MCP",
    "shortDescription": "Safely manage GitHub Stars with AI",
    "longDescription": "Discover repositories, organize Star Lists, create immutable change plans, apply approved changes, and keep a local audit trail.",
    "developerName": "90le",
    "category": "Developer Tools",
    "capabilities": ["Interactive", "Write"],
    "websiteURL": "https://github.com/90le/github-stars-mcp",
    "defaultPrompt": ["Inspect and safely organize my GitHub Stars using a reviewed change plan"],
    "brandColor": "#F5B301"
  }
}
```

```json
{
  "mcpServers": {
    "github-stars-mcp": {
      "command": "npx",
      "args": ["-y", "github-stars-mcp@1.0.0", "--stdio"],
      "env_vars": [
        "GITHUB_STARS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_HOST",
        "GITHUB_STARS_MCP_DATA_DIR", "GITHUB_STARS_MCP_READ_ONLY",
        "GITHUB_STARS_MCP_AUTH_MODE", "GITHUB_STARS_MCP_LOG_LEVEL",
        "GITHUB_STARS_MCP_MAX_READ_CONCURRENCY",
        "GITHUB_STARS_MCP_WRITE_INTERVAL_MS",
        "GITHUB_STARS_MCP_MAX_PLAN_ACTIONS",
        "GITHUB_STARS_MCP_PLAN_TTL_MINUTES"
      ],
      "tool_timeout_sec": 900
    }
  }
}
```

```json
{
  "name": "github-stars-mcp",
  "interface": { "displayName": "GitHub Stars MCP" },
  "plugins": [
    {
      "name": "github-stars-mcp",
      "source": { "source": "local", "path": "./plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Developer Tools"
    }
  ]
}
```

The skill must contain the workflow `status -> sync -> query -> plan -> inspect -> apply -> audit`, require explicit protected IDs before subjective cleanup, state that rollback creates another plan, and state that repository deletion, archive, transfer, visibility, and content changes are impossible. It must never tell an agent to extract cookies or create a broad token.

`scripts/validate-plugin.mjs` supplies `npm run plugin:validate`. It parses the
manifest, MCP configuration, marketplace entry, and skill frontmatter; verifies
every referenced path; asserts the manifest links `./.mcp.json`; compares
`env_vars` byte-for-byte with the documented configuration allowlist; rejects
credentials/runtime source; and validates a copied plugin through a temporary
`codex plugin marketplace add` plus `codex plugin add` when Codex is installed.
Brand asset fields are intentionally absent here. Plan 05 Task 6 creates the
files and adds those fields in the same tested commit.

- [ ] **Step 4: Validate plugin JSON and skill contract**

Run: `npm test -- test/contract/plugin/plugin.test.ts && npm run plugin:validate`

Expected: PASS; no plugin runtime source files and exact package pin is present.

- [ ] **Step 5: Commit**

```bash
git add plugin .agents/plugins/marketplace.json scripts/validate-plugin.mjs package.json test/contract/plugin/plugin.test.ts
git commit -m "feat: add Codex plugin package"
```

### Task 7: Run MCP Inspector and real Codex load smoke tests

**Files:**
- Create: `scripts/mcp-inspector-smoke.mjs`
- Create: `scripts/codex-plugin-smoke.mjs`
- Modify: `package.json`
- Create: `test/contract/plugin/local.mcp.template.json`

**Interfaces:**
- Consumes: built package tarball, `dist/cli.js`, plugin metadata, installed `codex` and MCP Inspector CLIs.
- Produces: `npm run smoke:mcp` and `npm run smoke:codex-plugin` release gates.

- [ ] **Step 1: Write smoke-script self-tests**

```ts
it("rewrites only the test copy of plugin MCP config to the packed local CLI", async () => {
  const fixture = await createLocalPluginFixture("./artifacts/github-stars-mcp.tgz");
  const config = await readJson(path.join(fixture, ".mcp.json"));
  expect(config.mcpServers["github-stars-mcp"].command).toBe(process.execPath);
  expect(config.mcpServers["github-stars-mcp"].args[0]).toMatch(/dist[/\\]cli\.js$/);
  expect(await readJson("plugin/.mcp.json")).toMatchObject({
    mcpServers: { "github-stars-mcp": { command: "npx" } },
  });
});
```

- [ ] **Step 2: Run and verify the smoke helper is missing**

Run: `npm test -- test/contract/plugin/local-plugin-fixture.test.ts`

Expected: FAIL because the local plugin fixture helper does not exist.

- [ ] **Step 3: Implement deterministic smoke commands**

```js
// scripts/mcp-inspector-smoke.mjs
const pack = JSON.parse(await run("npm", ["pack", "--json", "--pack-destination", temp]))[0];
const tarball = resolve(temp, pack.filename);
await run("npm", ["init", "-y"], { cwd: installRoot });
await run("npm", ["install", tarball], { cwd: installRoot });
const cli = resolveInstalledBin(installRoot, "github-stars-mcp");
const output = await run(
  "npx",
  [
    "-y", "@modelcontextprotocol/inspector@0.22.0", "--cli",
    process.execPath, cli, "--stdio", "--method", "tools/list",
  ],
  {
    env: { ...process.env, GITHUB_STARS_MCP_READ_ONLY: "true" },
    rejectNonJsonStdout: true,
  },
);
const listed = JSON.parse(output).tools.map((tool) => tool.name).sort();
assert.deepEqual(listed, [...EXPECTED_TOOL_NAMES].sort());
```

The real implementation wraps all temporary directories in `try/finally`,
parses `npm pack --json` instead of guessing a tarball name, and fails if the
Inspector emits protocol noise or a non-exact tool set.

`codex-plugin-smoke.mjs` must install the same exact packed tarball into a
temporary project, copy `.agents/plugins/marketplace.json` and `plugin/` to a
temporary marketplace root, replace only that copy's MCP command with
`process.execPath` plus the installed package's root-level `dist/cli.js`, set
`CODEX_HOME` to a second empty temporary directory, and run these exact commands:

```text
codex plugin marketplace add "$TEMP_MARKETPLACE_ROOT" --json
codex plugin add github-stars-mcp@github-stars-mcp --json
codex plugin list --json
codex mcp list --json
```

The script must parse every JSON response, require the plugin to be installed, and require `github-stars-mcp` to appear in the MCP server list with the rewritten local command. MCP Inspector remains the independent gate that starts the process and lists all nine tools. Delete both temporary directories in `finally`; never mutate the committed plugin configuration or the user's normal `CODEX_HOME`.

- [ ] **Step 4: Run packed MCP and Codex smoke gates**

Run: `npm run build && npm run smoke:mcp && npm run smoke:codex-plugin`

Expected: MCP Inspector initializes the server and enumerates exactly nine tools; Codex installs the local marketplace plugin and recognizes its MCP server. If Codex is absent, the local developer command exits 77 with a clear skip; release CI installs Codex and treats a skip as failure.

- [ ] **Step 5: Commit**

```bash
git add scripts/mcp-inspector-smoke.mjs scripts/codex-plugin-smoke.mjs test/contract/plugin package.json
git commit -m "test: add MCP and Codex smoke gates"
```

## Plan Acceptance

- `npm run build` creates an executable ESM CLI with declarations and source maps.
- An in-process MCP client and a spawned stdio client list exactly nine tools.
- Every tool returns the versioned envelope and concise text.
- Invalid inputs return `isError: true` and never reach application services.
- Stdio stdout contains JSON-RPC only during startup, calls, errors, and shutdown.
- `--doctor` performs no GitHub mutation and exposes no token.
- The Codex plugin pins version 1.0.0, contains no runtime logic, and loads in a real Codex smoke test.
- Security tests prove no generic request or repository-administration tool exists.
