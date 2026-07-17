# Foundation, Domain, and Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the strict TypeScript foundation, deterministic domain contracts, filter/query engine, immutable plan/run model, and crash-safe SQLite store required by every later GitHub Stars MCP subsystem.

**Architecture:** Pure domain modules own validated IDs, records, filters, canonical hashes, and lifecycle rules without importing MCP, GitHub, or SQLite. Application services depend on one synchronous `StoragePort`; `SQLiteStore` composes focused repositories over one `better-sqlite3` connection and never keeps a transaction open across an `await`.

**Tech Stack:** TypeScript 6.0.3 strict ESM, Node.js 22/24, Zod v4, `better-sqlite3`, Vitest v4, ESLint, Prettier, npm with `npm-shrinkwrap.json`.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-07-16-github-stars-mcp-design.md`.
- Runtime support: Node 22 and 24 on Windows, macOS, and Linux; `engines.node` is `>=22`.
- Source uses strict TypeScript ESM and emitted `.js` suffixes in relative imports.
- GraphQL IDs are branded non-empty strings; REST repository numeric IDs are branded decimal strings.
- `repository_id` means GraphQL node ID; `repository_database_id` means REST numeric ID as decimal text.
- SQLite uses WAL for file databases, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, and numbered migrations.
- Sync creates a `building` snapshot, appends bounded page batches, then atomically publishes `complete`; interrupted work remains unreadable and startup recovery marks it `failed`.
- Canonical JSON accepts JSON values only, sorts keys recursively, preserves array order, rejects non-finite numbers, and hashes UTF-8 with SHA-256.
- Executable plan content includes account, snapshot, protected IDs, resolved operations, and dependencies; lifecycle metadata and caller note are excluded.
- Credentials never enter config values, errors, logs, persistence, plans, runs, or fixtures.
- Defaults: read-only `true`, plan TTL 1,440 minutes, maximum 5,000 actions, minimum write interval 1,000 ms.
- Each task uses five-step TDD: failing test, observed failure, minimum implementation, passing verification, focused commit.

## Exact File Map

```text
package.json; npm-shrinkwrap.json                    pinned package and dependency graph
tsconfig*.json; eslint.config.js; .prettier*         strict ESM checks and formatting
vitest.config.ts; src/version.ts                     tests, coverage, package identity
src/domain/{ids,json,repository,snapshot}.ts         normalized identity and snapshot records
src/app/ports/runtime-port.ts                        Clock and IdGenerator seams
src/domain/{errors,redaction}.ts; src/config.ts      safe errors and token-free config
src/domain/{filter,cursor}.ts; src/storage/filter-sql.ts
src/domain/{canonical-json,plan,run}.ts               immutable plan/run contracts
src/app/ports/storage-port.ts                        synchronous persistence boundary
src/storage/migrations{,/001-initial}.ts             schema and migration runner
src/storage/{sqlite-database,snapshot-repository,lease-repository}.ts
src/storage/{plan-run-repository,sqlite-store}.ts    audit, recovery, facade
test/{fixtures,unit,integration/storage}/**           fakes and executable verification
```

## Locked Cross-Plan Names

Operations are exactly `star`, `unstar`, `list_create`, `list_update`, `list_delete`, and `list_membership_set`. Request-only membership actions `list_membership_add` and `list_membership_remove` resolve to `list_membership_set`. `ChangePlan` uses `id`; `ChangeRun` uses `id`; `ResolvedOperation` uses `operationId`. Repository names are routing data, never mutation identity.

### Task 1: Establish the reproducible strict-ESM project

**Files:**
- Create: `package.json`, `npm-shrinkwrap.json`, `tsconfig.json`, `tsconfig.build.json`, `tsconfig.eslint.json`
- Create: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`
- Create: `src/version.ts`, `test/unit/project-setup.test.ts`

**Interfaces:**
- Consumes: Node.js 22/24 and npm.
- Produces: `PACKAGE_NAME`, `PACKAGE_VERSION`; scripts `build`, `typecheck`, `lint`, `format`, `format:check`, `test`, `test:coverage`, `verify`.

- [ ] **Step 1: Create package configuration and the failing import test**

Pin dependencies: `@modelcontextprotocol/sdk@1.29.0`, `better-sqlite3@12.4.1`, `octokit@5.0.5`, `zod@4.1.12`. Pin dev dependencies: `@eslint/js@9.39.2`, `@types/better-sqlite3@7.6.13`, `@types/node@24.10.1`, `@vitest/coverage-v8@4.0.18`, `eslint@9.39.2`, `prettier@3.7.4`, `typescript@6.0.3`, `typescript-eslint@8.64.0`, `vitest@4.0.18`. This exact TypeScript/typescript-eslint pair is the newest mutually supported stable pair resolved from npm on 2026-07-17; never use `--force` or legacy peer-dependency bypasses.

```json
{
  "name": "github-stars-mcp", "version": "0.1.0", "type": "module",
  "private": false, "license": "Apache-2.0", "engines": {"node": ">=22"},
  "files": ["dist", "plugin", "README.md", "LICENSE"],
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0", "better-sqlite3": "12.4.1",
    "octokit": "5.0.5", "zod": "4.1.12"
  },
  "devDependencies": {
    "@eslint/js": "9.39.2", "@types/better-sqlite3": "7.6.13",
    "@types/node": "24.10.1", "@vitest/coverage-v8": "4.0.18",
    "eslint": "9.39.2", "prettier": "3.7.4", "typescript": "6.0.3",
    "typescript-eslint": "8.64.0", "vitest": "4.0.18"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json", "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint . --max-warnings 0", "format": "prettier --write .",
    "format:check": "prettier --check .", "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "verify": "npm run format:check && npm run lint && npm run typecheck && npm run test:coverage && npm run build"
  }
}
```

```ts
// test/unit/project-setup.test.ts
import { expect, test } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../src/version.js";
test("exports package identity", () => {
  expect(PACKAGE_NAME).toBe("github-stars-mcp");
  expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
});
```

Set the shared compiler options to `module`/`moduleResolution: NodeNext`, target
`ES2023`, and enable `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, and
`verbatimModuleSyntax`. `tsconfig.json` type-checks both `src/**/*.ts` and
`test/**/*.ts` with `noEmit`. `tsconfig.build.json` extends it, includes only
`src/**/*.ts`, uses `rootDir: "src"` and `outDir: "dist"`, and enables
declarations and source maps. No test can emit under `dist/`. Configure Vitest
for Node, `test/**/*.test.ts`, and coverage thresholds 90% lines/functions and
85% branches. Coverage must explicitly include `src/**/*.ts`, including files
that no test imports. The generated shrinkwrap may contain only official
`https://registry.npmjs.org/` registry resolution URLs—never a developer's
machine-specific mirror.

- [ ] **Step 2: Install and prove the source module is missing**
Run `npm install && npm test -- test/unit/project-setup.test.ts`; expect install success followed by failure loading `../../src/version.js`.

- [ ] **Step 3: Add the minimum identity and freeze dependencies**

```ts
export const PACKAGE_NAME = "github-stars-mcp";
export const PACKAGE_VERSION = "0.1.0";
```

Run `npm shrinkwrap`; verify lockfile version 3, exact direct versions, and no
non-official registry resolution URL.

- [ ] **Step 4: Verify foundation behavior**
Run `npm run format && npm run lint && npm run typecheck && npm test -- test/unit/project-setup.test.ts && npm run build && npm pack --dry-run`; expect all exit 0, three passing tests, and no `src`, `test`, or `.env` in the tarball.

- [ ] **Step 5: Commit**

```bash
git add package.json npm-shrinkwrap.json tsconfig.json tsconfig.build.json tsconfig.eslint.json eslint.config.js .prettierrc.json .prettierignore vitest.config.ts src/version.ts test/unit/project-setup.test.ts
git commit -m "build: establish strict TypeScript foundation"
```

### Task 2: Add validated identifiers, runtime seams, and normalized records

**Files:**
- Create: `src/domain/ids.ts`, `src/app/ports/runtime-port.ts`, `src/domain/json.ts`
- Create: `src/domain/repository.ts`, `src/domain/snapshot.ts`
- Create: `test/fixtures/domain.ts`, `test/unit/domain/records.test.ts`

**Interfaces:**
- Consumes: `crypto.randomUUID`, Zod.
- Produces: all branded IDs and constructors; `Clock`, `IdGenerator`; normalized Repository/Star/List/Snapshot/query records.

- [ ] **Step 1: Write failing ID and record tests**

```ts
import { expect, test } from "vitest";
import { asRepositoryDatabaseId, asRepositoryId, newSnapshotId } from "../../../src/domain/ids.js";
import { repositorySchema } from "../../../src/domain/repository.js";
test("validates stable identities and normalizes topics", () => {
  expect(() => asRepositoryId(" ")).toThrow(/repository_id/u);
  expect(() => asRepositoryDatabaseId("1.5")).toThrow(/decimal/u);
  expect(asRepositoryDatabaseId("9007199254740993")).toBe("9007199254740993");
  expect(newSnapshotId()).toMatch(/^snap_[0-9a-f-]{36}$/u);
  const repository = repositorySchema.parse({
    repositoryId: "R_1", repositoryDatabaseId: "42", owner: "OpenAI", name: "SDK",
    fullName: "OpenAI/SDK", description: null, url: "https://github.com/OpenAI/SDK",
    stargazerCount: 10, isFork: false, isArchived: false, isDisabled: false, isPrivate: false, visibility: "public",
    primaryLanguage: "TypeScript", topics: ["MCP", "mcp", " Agent "],
    licenseSpdxId: "Apache-2.0", pushedAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T01:00:00Z"
  });
  expect(repository.topics).toEqual(["agent", "mcp"]);
});
```

- [ ] **Step 2: Prove the domain modules are missing**
Run `npm test -- test/unit/domain/records.test.ts`; expect FAIL resolving `src/domain/ids.ts`.

- [ ] **Step 3: Implement the exact contracts**

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
export type RepositoryId = Brand<string, "RepositoryId">;
export type RepositoryDatabaseId = Brand<string, "RepositoryDatabaseId">;
export type UserListId = Brand<string, "UserListId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type PlanId = Brand<string, "PlanId">;
export type RunId = Brand<string, "RunId">;
```

Export `asRepositoryId`, `asRepositoryDatabaseId`, `asUserListId`, `asSnapshotId`, `asPlanId`, `asRunId`; nonnumeric IDs trim-equal and non-empty, database IDs match `^(0|[1-9]\d*)$`. Export UUID-prefixed `newSnapshotId`, `newPlanId`, `newRunId`, `newRequestId`, `newOperationId`.

```ts
export interface Clock { now(): string; monotonicMs(): number }
export interface IdGenerator {
  snapshotId(): SnapshotId; planId(): PlanId; runId(): RunId;
  requestId(): string; operationId(): string;
}
export class SystemRuntime implements Clock, IdGenerator {
  now() { return new Date().toISOString(); } monotonicMs() { return performance.now(); }
  snapshotId() { return newSnapshotId(); } planId() { return newPlanId(); }
  runId() { return newRunId(); } requestId() { return newRequestId(); }
  operationId() { return newOperationId(); }
}
```

```ts
export interface AccountBinding { readonly host: string; readonly login: string; readonly accountId: string }
export interface RepositoryCoordinates { readonly owner: string; readonly name: string }
export interface Repository extends RepositoryCoordinates {
  readonly repositoryId: RepositoryId; readonly repositoryDatabaseId: RepositoryDatabaseId;
  readonly fullName: string; readonly description: string | null; readonly url: string;
  readonly stargazerCount: number; readonly isFork: boolean; readonly isArchived: boolean;
  readonly isDisabled: boolean; readonly isPrivate: boolean;
  readonly visibility: "public" | "private" | "internal"; readonly primaryLanguage: string | null;
  readonly topics: readonly string[]; readonly licenseSpdxId: string | null;
  readonly pushedAt: string | null; readonly updatedAt: string;
}
export interface StarRecord { readonly repositoryId: RepositoryId; readonly starredAt: string }
export interface UserList { readonly listId: UserListId; readonly name: string; readonly slug: string; readonly description: string | null; readonly isPrivate: boolean; readonly createdAt: string; readonly updatedAt: string; readonly lastAddedAt: string | null }
export interface ListMembership { readonly listId: UserListId; readonly repositoryId: RepositoryId }
export interface RepositoryView extends Repository { readonly starredAt: string; readonly listIds: readonly UserListId[] }
export interface ObservedRepositoryMetadata { readonly repository: Repository; readonly observedAt: string }
```

`repositorySchema` has output type `Repository`, so parsed fields and topic
arrays remain readonly at compile time. It trims names, preserves ID case,
lowercases/trims/deduplicates/sorts topics, requires an HTTPS GitHub URL,
nonnegative integer stars, and canonical UTC ISO timestamps ending in `Z`;
numeric-offset timestamps are rejected rather than stored in mixed forms.

```ts
export interface SnapshotDraft { readonly id: SnapshotId; readonly binding: AccountBinding; readonly mode: "full" | "incremental"; readonly startedAt: string }
export interface SnapshotCounts { readonly repositories: number; readonly stars: number; readonly lists: number; readonly memberships: number }
export interface Snapshot extends SnapshotDraft { readonly status: "building" | "complete" | "failed"; readonly completedAt: string | null; readonly failedAt: string | null; readonly counts: SnapshotCounts; readonly warningCount: number; readonly sourceRateLimit: JsonValue|null }
export interface SnapshotBatch { readonly repositories: readonly ObservedRepositoryMetadata[]; readonly stars: readonly StarRecord[]; readonly lists: readonly UserList[]; readonly memberships: readonly ListMembership[] }
```

- [ ] **Step 4: Verify records and types**
Run `npm test -- test/unit/domain/records.test.ts && npm run typecheck && npm run lint`; expect one passing test and zero static-check errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/ids.ts src/app/ports/runtime-port.ts src/domain/json.ts src/domain/repository.ts src/domain/snapshot.ts test/fixtures/domain.ts test/unit/domain/records.test.ts
git commit -m "feat: add normalized Star domain records"
```

### Task 3: Add safe errors, recursive redaction, and validated config

**Files:**
- Create: `src/domain/errors.ts`, `src/domain/redaction.ts`, `src/config.ts`
- Create: `test/unit/domain/errors-config.test.ts`

**Interfaces:**
- Consumes: `JsonValue`, raw `NodeJS.ProcessEnv`.
- Produces: `AppErrorCode`, `AppError`, `SerializedDomainError`, `serializeError`, `redactSecrets`, `AppConfig`, `loadConfig`.

- [ ] **Step 1: Write failing safety tests**

```ts
import { expect, test } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { APP_ERROR_CODES, AppError, serializeError } from "../../../src/domain/errors.js";
test("redacts nested secrets and defaults read-only", () => {
  const error = new AppError("AUTH_REQUIRED", "bad ghp_secret", {
    details: { authorization: "Bearer ghp_secret", nested: ["ghp_secret"] }, secrets: ["ghp_secret"]
  });
  expect(JSON.stringify(serializeError(error))).not.toContain("ghp_secret");
  const config = loadConfig({ GITHUB_STARS_MCP_DATA_DIR: "C:\\state" }, "win32");
  expect(config.readOnly).toBe(true); expect(config.writeIntervalMs).toBe(1000);
  expect(APP_ERROR_CODES).toHaveLength(18);
  expect(Object.keys(config)).not.toContain("token");
  expect(() => loadConfig({ GITHUB_STARS_MCP_WRITE_INTERVAL_MS: "999" }, "linux")).toThrow(/1000/u);
});
```

- [ ] **Step 2: Prove both imports fail**
Run `npm test -- test/unit/domain/errors-config.test.ts`; expect FAIL resolving `src/config.ts` or `src/domain/errors.ts`.

- [ ] **Step 3: Implement safe public values**

`AppErrorCode` is exactly the 18 codes in specification 16.1.
`APP_ERROR_CODES` is runtime-frozen, and validation uses a private immutable
lookup that exported callers cannot mutate. `AppError` stores `code`,
`retryable`, JSON `details`, secret strings, and an optional cause. Registered
secrets are non-enumerable, and `JSON.stringify(AppError)` delegates to the
same redacted public serialization rather than exposing raw details or the
secret registry. `SerializedDomainError` is:

```ts
export const APP_ERROR_CODES = ["AUTH_REQUIRED","INSUFFICIENT_PERMISSION","CAPABILITY_UNAVAILABLE","VALIDATION_ERROR","NOT_FOUND","RATE_LIMITED","SECONDARY_RATE_LIMITED","GITHUB_UNAVAILABLE","STALE_SNAPSHOT","PLAN_EXPIRED","PLAN_HASH_MISMATCH","PLAN_ACCOUNT_MISMATCH","PLAN_TOO_LARGE","PRECONDITION_FAILED","PARTIAL_FAILURE","RECONCILIATION_REQUIRED","STORAGE_ERROR","INTERNAL_ERROR"] as const;
export type AppErrorCode = typeof APP_ERROR_CODES[number];
export interface SerializedDomainError {
  readonly code: AppErrorCode; readonly message: string;
  readonly retryable: boolean; readonly details: JsonValue;
}
```

`redactSecrets` recursively clones arrays and plain data properties, caps
depth at 20, replaces secret substrings and values under case-insensitive
`authorization`, `token`, `access_token`, `password`, `cookie` with
`[REDACTED]`, never invokes getters, and stringifies unsupported values.
Secret-array inspection examines every numeric index descriptor regardless of
enumerability and fails closed for holes, accessors, or malformed entries.
`AppError` snapshots a valid registry through that same descriptor-only path;
it never spreads, iterates, or indexes the caller's array. Invalid registries
remain invalid through an internal frozen sentinel so both `serializeError`
and direct JSON serialization fully redact without invoking getters or custom
iterators.
Redacted arrays are dense `JsonValue[]` values: sparse, non-enumerable, or
accessor indices become a JSON-safe marker without invoking accessors.
`serializeError` omits stack/cause and maps unknown errors to `INTERNAL_ERROR`.

```ts
export interface AppConfig {
  readonly host: "github.com"; readonly authMode: "auto" | "env" | "gh";
  readonly dataDir: string; readonly logLevel: "debug" | "info" | "warning" | "error";
  readonly readOnly: boolean; readonly maxReadConcurrency: number;
  readonly writeIntervalMs: number; readonly maxPlanActions: number; readonly planTtlMinutes: number;
}
export function loadConfig(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): AppConfig;
```

Resolve data directory from `GITHUB_STARS_MCP_DATA_DIR`, `%LOCALAPPDATA%\github-stars-mcp`, `$XDG_STATE_HOME/github-stars-mcp`, or `~/.local/state/github-stars-mcp`. Reject non-`github.com`, relative paths, concurrency outside 1–8, interval below 1,000, actions outside 1–5,000, TTL outside 1–10,080, and invalid booleans. Never read credential variables.

- [ ] **Step 4: Verify no secret appears**
Run `npm test -- test/unit/domain/errors-config.test.ts && npm run typecheck && npm run lint`; expect all focused tests to pass, no `ghp_secret` output, and clean static checks.

- [ ] **Step 5: Commit**

```bash
git add src/domain/errors.ts src/domain/redaction.ts src/config.ts test/unit/domain/errors-config.test.ts
git commit -m "feat: add safe errors and configuration"
```

### Task 4: Implement recursive filters, stable cursors, and safe SQL

**Files:**
- Create: `src/domain/filter.ts`, `src/domain/cursor.ts`, `src/storage/filter-sql.ts`
- Create: `test/unit/domain/filter.test.ts`

**Interfaces:**
- Consumes: `RepositoryView`, `SnapshotId`, branded IDs, `AppError`.
- Produces: `FilterExpression`, `RepositorySort`, `RepositoryQuery`, `RepositoryQueryPage`, `ListQuery`, `ListQueryPage`, evaluators and SQL compiler.

- [ ] **Step 1: Write failing equivalence, injection, and cursor tests**

```ts
import { expect, test } from "vitest";
import { decodeRepositoryCursor, encodeRepositoryCursor } from "../../../src/domain/cursor.js";
import { matchesFilter, parseFilter } from "../../../src/domain/filter.js";
import { compileFilter } from "../../../src/storage/filter-sql.js";
import { repositoryViewFixture } from "../../fixtures/domain.js";
test("evaluates filters while parameterizing caller text", () => {
  const nested = parseFilter({ all: [
    { field: "stargazer_count", op: "lt", value: 10000 },
    { field: "pushed_at", op: "before", value: "2023-07-16T00:00:00Z" }
  ] });
  expect(matchesFilter(repositoryViewFixture, nested)).toBe(true);
  for (const input of [
    {field:"repository_id",op:"in",value:["R_1"]},
    {field:"is_disabled",op:"eq",value:false},{field:"is_private",op:"eq",value:false},
    {field:"visibility",op:"eq",value:"public"},{field:"license_spdx_id",op:"eq",value:"Apache-2.0"},
    {field:"topics",op:"contains",value:"mcp"},{field:"is_fork",op:"eq",value:false},
    {field:"is_archived",op:"eq",value:false},{field:"primary_language",op:"eq",value:"TypeScript"},
    {field:"is_unclassified",op:"eq",value:false},{field:"description",op:"is_null",value:true}
  ]) expect(() => parseFilter(input)).not.toThrow();
  expect(parseFilter(
    {field:"pushed_at",op:"before",value:{ago:{amount:3,unit:"years"}}},
    {now:"2026-07-16T00:00:00.000Z"},
  )).toEqual({field:"pushed_at",op:"before",value:"2023-07-16T00:00:00.000Z"});
  const sql = compileFilter(parseFilter({ field: "owner", op: "eq", value: "x' OR 1=1 --" }));
  expect(sql.sql).not.toContain("OR 1=1"); expect(sql.params).toEqual(["x' OR 1=1 --"]);
  const cursor = encodeRepositoryCursor({
    kind:"repositories",snapshotId:"snap_1",filterHash:"f".repeat(64),
    sortHash:"s".repeat(64),values:[12,null],nulls:[false,true],repositoryId:"R_9",
  });
  expect(decodeRepositoryCursor(cursor, {
    kind:"repositories",snapshotId:"snap_1",filterHash:"f".repeat(64),sortHash:"s".repeat(64),
  })).toMatchObject({values:[12,null],nulls:[false,true],repositoryId:"R_9"});
  expect(() => decodeRepositoryCursor(cursor, {
    kind:"repositories",snapshotId:"snap_2",filterHash:"f".repeat(64),sortHash:"s".repeat(64),
  })).toThrow(/cursor.*snapshot/iu);
});
```

- [ ] **Step 2: Prove filter modules are absent**
Run `npm test -- test/unit/domain/filter.test.ts`; expect FAIL resolving `src/domain/filter.ts`.

- [ ] **Step 3: Implement the closed query language**

```ts
export type FilterExpression =
  | { readonly all: readonly FilterExpression[] } | { readonly any: readonly FilterExpression[] }
  | { readonly not: FilterExpression }
  | { readonly field: "repository_id"|"owner"|"name"|"full_name"|"description"|"primary_language"|"license_spdx_id"|"visibility"; readonly op: "eq"|"neq"|"contains"|"in"|"not_in"|"is_null"; readonly value: string|readonly string[]|boolean }
  | { readonly field: "stargazer_count"; readonly op: "eq"|"neq"|"lt"|"lte"|"gt"|"gte"|"in"|"not_in"; readonly value: number|readonly number[] }
  | { readonly field: "is_fork"|"is_archived"|"is_disabled"|"is_private"; readonly op: "eq"|"neq"; readonly value: boolean }
  | { readonly field: "pushed_at"|"updated_at"|"starred_at"; readonly op: "before"|"after"|"eq"|"is_null"; readonly value: string|boolean }
  | { readonly field: "topics"|"list_ids"; readonly op: "contains"|"not_contains"|"in"|"not_in"|"is_null"; readonly value: string|readonly string[]|boolean }
  | { readonly field: "is_unclassified"; readonly op: "eq"|"neq"; readonly value:boolean };
export interface RepositorySort { readonly field: "stargazer_count"|"pushed_at"|"updated_at"|"starred_at"|"full_name"; readonly direction: "asc"|"desc" }
export interface RepositoryQuery { readonly snapshotId: SnapshotId; readonly filter: FilterExpression|null; readonly sort: readonly RepositorySort[]; readonly pageSize: number; readonly cursor: string|null }
export interface RepositoryQueryPage { readonly items: readonly RepositoryView[]; readonly total: number; readonly aggregates: { readonly byLanguage: Readonly<Record<string, number>>; readonly archived: number; readonly forks: number }; readonly nextCursor: string|null }
export interface ListView extends UserList { readonly repositoryIds: readonly RepositoryId[] }
export interface ListQuery { readonly snapshotId: SnapshotId; readonly pageSize: number; readonly cursor: string|null }
export interface ListQueryPage { readonly items: readonly ListView[]; readonly total: number; readonly nextCursor: string|null }
```

`parseFilter(input, { now })` limits depth to 12 and leaves to 100, rejects
empty groups and mismatched field/operators, and validates timestamps. For
temporal comparisons it also accepts
`{ ago: { amount: 1..10000, unit: "hours"|"days"|"weeks"|"months"|"years" } }`
and immediately resolves it, using the injected UTC `now`, to the absolute ISO
timestamp present in the returned `FilterExpression`. Calendar months/years
use UTC calendar arithmetic; all other units use exact duration arithmetic.
No unresolved relative value reaches SQL or an executable plan.
`is_unclassified` means `listIds.length === 0`. Null checks are accepted only
for nullable fields/collections and use a Boolean value. `normalizeSort`
deduplicates then appends `full_name ASC` and internal `repository_id ASC`.

```ts
export interface SqlFragment { readonly sql: string; readonly params: readonly (string|number)[] }
export function compileFilter(filter: FilterExpression): SqlFragment;
export function compileOrder(sort: readonly RepositorySort[]): string;
export function compileCursor(sort: readonly RepositorySort[], cursor: string|null): SqlFragment;
```

Map fields only to fixed columns. Topics use `EXISTS (SELECT 1 FROM
json_each(rv.topics_json) WHERE value=?)`; Lists use `EXISTS (SELECT 1 FROM
list_memberships m WHERE m.snapshot_id=ss.snapshot_id AND
m.repository_id=ss.repository_id AND m.list_id=?)`. Unit tests run a
table-driven evaluator/SQL equivalence case for every allowed field/operator
pair, including nulls and `is_unclassified`.

Repository cursors are max-4-KiB base64url canonical JSON with
`{v:1,kind:"repositories",snapshotId,filterHash,sortHash,values,nulls,repositoryId}`.
List cursors use
`{v:1,kind:"lists",snapshotId,selectionHash,values,listId}`. Decode requires
the expected resource kind, snapshot, canonical filter/selection hash, and
normalized sort hash; reuse across any boundary raises `VALIDATION_ERROR`.
Every nullable sort uses explicit `NULLS LAST` semantics in both directions,
encoded null markers, and a stable ID final key. Tests cover null/non-null
boundaries, duplicate sort values, empty final pages, cursor tampering, and
cross-snapshot/filter/sort/resource reuse.

- [ ] **Step 4: Verify behavior and SQL safety**
Run `npm test -- test/unit/domain/filter.test.ts && npm run typecheck && npm run lint`; expect one pass, hostile text only in parameters, and clean static checks.

- [ ] **Step 5: Commit**

```bash
git add src/domain/filter.ts src/domain/cursor.ts src/storage/filter-sql.ts test/unit/domain/filter.test.ts test/fixtures/domain.ts
git commit -m "feat: add deterministic repository filters"
```

### Task 5: Define canonical plans, dependency order, and run state

**Files:**
- Create: `src/domain/canonical-json.ts`, `src/domain/plan.ts`, `src/domain/run.ts`
- Create: `test/unit/domain/plan-run.test.ts`

**Interfaces:**
- Consumes: IDs, account/coordinates, filters, `JsonValue`, `SerializedDomainError`.
- Produces: exact immutable plan/run interfaces consumed by plans 03/04.

- [ ] **Step 1: Write failing canonical, graph, and transition tests**

```ts
import { expect, test } from "vitest";
import { canonicalJson, hashPlanExecutable } from "../../../src/domain/canonical-json.js";
import { asRepositoryDatabaseId, asRepositoryId, asSnapshotId } from "../../../src/domain/ids.js";
import { topologicalOperationIds, transitionPlanState, type ResolvedOperation } from "../../../src/domain/plan.js";
import { transitionRunState } from "../../../src/domain/run.js";
test("canonicalizes, orders dependencies, and guards terminals", () => {
  expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
  const create:ResolvedOperation = { operationId:"create",kind:"list_create",dependsOn:[],preconditions:[],before:null,after:{clientRef:"x"},inverse:{kind:"list_delete"},risk:"normal",clientRef:"x" };
  const assign:ResolvedOperation = { operationId:"assign",kind:"list_membership_set",dependsOn:["create"],preconditions:[],before:{listIds:[]},after:{targets:[{kind:"created",createOperationId:"create"}]},inverse:{listIds:[]},risk:"normal",repositoryId:asRepositoryId("R_1"),repositoryDatabaseId:asRepositoryDatabaseId("1"),coordinates:{owner:"o",name:"r"},expectedListIds:[],targetLists:[{kind:"created",createOperationId:"create"}] };
  expect(topologicalOperationIds([assign, create], [{ operationId:"assign", dependsOnOperationId:"create" }])).toEqual(["create","assign"]);
  expect(transitionPlanState("ready", "applying")).toBe("applying");
  expect(() => transitionRunState("completed", "running")).toThrow(/transition/u);
  expect(hashPlanExecutable({ schemaVersion:1,policyVersion:"1",binding:{host:"github.com",login:"u",accountId:"1"},snapshotId:asSnapshotId("snap_1"),protectedRepositoryIds:[],protectedListIds:[],operations:[],dependencies:[] })).toHaveLength(64);
});
```

- [ ] **Step 2: Prove plan modules are absent**
Run `npm test -- test/unit/domain/plan-run.test.ts`; expect FAIL resolving `src/domain/canonical-json.ts`.

- [ ] **Step 3: Implement exact request, operation, plan, and run types**

```ts
export type RepositorySelector = { readonly kind:"ids"; readonly repositoryIds:readonly RepositoryId[] } | { readonly kind:"filter"; readonly filter:FilterExpression };
export type ListTarget = { readonly kind:"existing"; readonly listId:UserListId } | { readonly kind:"created"; readonly createOperationId:string };
export type PlanAction =
  | { readonly kind:"star"|"unstar"; readonly repositories:RepositorySelector }
  | { readonly kind:"list_create"; readonly clientRef:string; readonly name:string; readonly description:string|null; readonly isPrivate:boolean }
  | { readonly kind:"list_update"; readonly listId:UserListId; readonly name?:string; readonly description?:string|null; readonly isPrivate?:boolean }
  | { readonly kind:"list_delete"; readonly listIds:readonly UserListId[] }
  | { readonly kind:"list_membership_set"|"list_membership_add"|"list_membership_remove"; readonly repositories:RepositorySelector; readonly lists:readonly ListTarget[] };
export interface PlanRequest { readonly snapshotId:SnapshotId; readonly actions:readonly PlanAction[]; readonly protectedRepositoryIds:readonly RepositoryId[]; readonly protectedListIds:readonly UserListId[]; readonly ttlMinutes?:number; readonly maxOperations?:number; readonly callerNote?:string }
```

All operations share `operationId`, `kind`, `dependsOn`, `preconditions`, `before`, `after`, `inverse`, and `risk`. `star`/`unstar` additionally store `repositoryId`, `repositoryDatabaseId`, and `coordinates`. `list_update`/`list_delete` store `listId`; delete before-state stores full List plus member repository IDs. `list_create` stores `clientRef`. `list_membership_set` stores repository IDs/coordinates, `expectedListIds`, and `targetLists`. This routing data is resolved from the snapshot; identity comparisons still use IDs.

```ts
export interface OperationPrecondition { readonly kind:string; readonly expected:JsonValue }
export interface ResolvedOperationBase { readonly operationId:string; readonly dependsOn:readonly string[]; readonly preconditions:readonly OperationPrecondition[]; readonly before:JsonValue; readonly after:JsonValue; readonly inverse:JsonValue; readonly risk:"normal"|"destructive"|"non_reversible" }
export type ResolvedOperation =
  | Readonly<ResolvedOperationBase & {kind:"star"|"unstar";repositoryId:RepositoryId;repositoryDatabaseId:RepositoryDatabaseId;coordinates:RepositoryCoordinates}>
  | Readonly<ResolvedOperationBase & {kind:"list_create";clientRef:string}>
  | Readonly<ResolvedOperationBase & {kind:"list_update"|"list_delete";listId:UserListId}>
  | Readonly<ResolvedOperationBase & {kind:"list_membership_set";repositoryId:RepositoryId;repositoryDatabaseId:RepositoryDatabaseId;coordinates:RepositoryCoordinates;expectedListIds:readonly UserListId[];targetLists:readonly ListTarget[]}>;
export interface OperationDependency { readonly operationId:string; readonly dependsOnOperationId:string }
export interface PlanExecutableContent { readonly schemaVersion:1; readonly policyVersion:"1"; readonly binding:AccountBinding; readonly snapshotId:SnapshotId; readonly protectedRepositoryIds:readonly RepositoryId[]; readonly protectedListIds:readonly UserListId[]; readonly operations:readonly ResolvedOperation[]; readonly dependencies:readonly OperationDependency[] }
export type PlanState = "ready"|"applying"|"applied"|"partial"|"expired"|"failed"|"superseded";
export interface ChangePlan { readonly id:PlanId; readonly hash:string; readonly state:PlanState; readonly createdAt:string; readonly expiresAt:string; readonly callerNote:string|null; readonly executable:PlanExecutableContent; readonly operations:readonly ResolvedOperation[]; readonly dependencies:readonly OperationDependency[]; readonly warnings:readonly string[] }
export function topologicalOperationIds(operations:readonly ResolvedOperation[], dependencies:readonly OperationDependency[]):readonly string[];
export function reverseDependencyOperationIds(operations:readonly ResolvedOperation[], dependencies:readonly OperationDependency[]):readonly string[];
```

Kahn order uses original operation order as tie-breaker and rejects duplicates, unknown IDs, self-edges, mismatched `dependsOn`, and cycles. Plan transitions: `ready→applying|expired|superseded`, `applying→applied|partial|failed`, `partial→applying`.

```ts
export type FailureMode="stop"|"continue"; export type RunState="pending"|"running"|"completed"|"partial"|"failed";
export type RunOperationStatus="pending"|"running"|"succeeded"|"skipped"|"failed"|"unresolved";
export type ReconciliationStatus="not_required"|"pending"|"confirmed_applied"|"confirmed_not_applied"|"unknown";
export interface ChangeRun { readonly id:RunId; readonly planId:PlanId; readonly binding:AccountBinding; readonly state:RunState; readonly failureMode:FailureMode; readonly warnings:readonly string[]; readonly startedAt:string; readonly finishedAt:string|null }
export interface RunOperation { readonly runId:RunId; readonly operationId:string; readonly sequence:number; readonly status:RunOperationStatus; readonly reconciliation:ReconciliationStatus; readonly attempts:number; readonly before:JsonValue; readonly after:JsonValue; readonly externalRequestId:string|null; readonly error:SerializedDomainError|null; readonly startedAt:string|null; readonly finishedAt:string|null }
```

Run transitions: `pending→running`, `running→completed|partial|failed`, `partial→running`. `canonicalJson`, `sha256Hex`, and `hashPlanExecutable` reject unsupported/non-finite values and hash only `PlanExecutableContent`. The planner derives `binding` from the referenced complete snapshot, uses the fixed `policyVersion: "1"`, and never accepts caller-supplied account identity.

- [ ] **Step 4: Verify hash determinism and transition tables**
Run `npm test -- test/unit/domain/plan-run.test.ts && npm run typecheck && npm run lint`; expect one pass with graph, hash, and state assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/canonical-json.ts src/domain/plan.ts src/domain/run.ts test/unit/domain/plan-run.test.ts
git commit -m "feat: define immutable plans and run lifecycle"
```

### Task 6: Lock the complete synchronous StoragePort

**Files:**
- Create: `src/app/ports/storage-port.ts`
- Create: `test/fixtures/memory-storage.ts`, `test/unit/ports/storage-port.test.ts`

**Interfaces:**
- Consumes: all domain contracts from Tasks 2, 4, 5.
- Produces: exact port for plans 02/03 and `SQLiteStore`.

- [ ] **Step 1: Write the failing fake-port contract test**

```ts
import { expect, test } from "vitest";
import type { StoragePort } from "../../../src/app/ports/storage-port.js";
import { createMemoryStorage } from "../../fixtures/memory-storage.js";
test("StoragePort transactions are synchronous", () => {
  const store: StoragePort = createMemoryStorage();
  expect(store.withTransaction(() => "committed")).toBe("committed");
  expect(store.getSchemaVersion()).toBe(1); store.close();
});
```

- [ ] **Step 2: Prove the port is missing**
Run `npm test -- test/unit/ports/storage-port.test.ts`; expect FAIL resolving `src/app/ports/storage-port.ts`.

- [ ] **Step 3: Define every exact method**

```ts
export interface Lease { readonly name:string; readonly ownerId:string; readonly acquiredAt:string; readonly expiresAt:string }
export interface AcquireLeaseInput { readonly name:string; readonly ownerId:string; readonly now:string; readonly expiresAt:string }
export interface AuditPage { readonly items:readonly RunOperation[]; readonly nextSequence:number|null }
export interface StorageTransaction {
  createSnapshot(draft:SnapshotDraft):Snapshot;
  appendSnapshotBatch(id:SnapshotId,batch:SnapshotBatch):void;
  completeSnapshot(input:{readonly id:SnapshotId;readonly completedAt:string;readonly counts:SnapshotCounts;readonly warningCount:number;readonly sourceRateLimit:JsonValue|null}):Snapshot;
  failSnapshot(input:{readonly id:SnapshotId;readonly failedAt:string;readonly sourceRateLimit:JsonValue|null}):Snapshot;
  getCompleteSnapshot(id:SnapshotId):Snapshot|null;
  getLatestCompleteSnapshot(binding:AccountBinding):Snapshot|null;
  getRepositoryMetadata(id:RepositoryId):ObservedRepositoryMetadata|null;
  getSnapshotRepository(snapshotId:SnapshotId,repositoryId:RepositoryId):RepositoryView|null;
  getSnapshotList(snapshotId:SnapshotId,listId:UserListId):ListView|null;
  queryRepositories(input:RepositoryQuery):RepositoryQueryPage;
  queryLists(input:ListQuery):ListQueryPage;
  hasStar(snapshotId:SnapshotId,repositoryId:RepositoryId):boolean;
  savePlan(plan:ChangePlan):void;
  getPlan(id:PlanId):ChangePlan|null;
  compareAndSetPlanState(input:{readonly planId:PlanId;readonly expected:readonly PlanState[];readonly next:PlanState}):ChangePlan;
  createRun(run:ChangeRun):void;
  getRun(id:RunId):ChangeRun|null;
  getLatestRunForPlan(planId:PlanId):ChangeRun|null;
  compareAndSetRunState(input:{readonly runId:RunId;readonly expected:readonly RunState[];readonly next:RunState;readonly finishedAt:string|null}):ChangeRun;
  createRunOperation(operation:RunOperation):void;
  startRunOperation(input:{readonly runId:RunId;readonly operationId:string;readonly startedAt:string}):RunOperation;
  getRunOperation(input:{readonly runId:RunId;readonly operationId:string}):RunOperation|null;
  retryRunOperation(input:{readonly runId:RunId;readonly operationId:string}):RunOperation;
  listRunOperations(runId:RunId):readonly RunOperation[];
  listRunOperationsPage(input:{readonly runId:RunId;readonly afterSequence:number|null;readonly pageSize:number}):AuditPage;
  finishRunOperation(input:{readonly runId:RunId;readonly operationId:string;readonly status:Exclude<RunOperationStatus,"pending"|"running">;readonly reconciliation:ReconciliationStatus;readonly attempts:number;readonly externalRequestId:string|null;readonly before:JsonValue;readonly after:JsonValue;readonly error:SerializedDomainError|null;readonly finishedAt:string}):RunOperation;
  reconcileRunOperation(input:{readonly runId:RunId;readonly operationId:string;readonly status:"succeeded"|"failed"|"unresolved";readonly reconciliation:"confirmed_applied"|"confirmed_not_applied"|"unknown";readonly externalRequestId:string|null;readonly after:JsonValue;readonly error:SerializedDomainError|null;readonly finishedAt:string}):RunOperation;
  acquireLease(input:AcquireLeaseInput):Lease|null;
  renewLease(input:AcquireLeaseInput):Lease;
  releaseLease(input:{readonly name:string;readonly ownerId:string}):void;
}
export interface StoragePort extends StorageTransaction {
  migrate():void; getSchemaVersion():number;
  withTransaction<T>(fn:(tx:StorageTransaction)=>T):T;
  recoverIncompleteSnapshots(now:string):readonly SnapshotId[];
  recoverInterruptedRuns(now:string):readonly RunId[];
  close():void;
}
```

`memory-storage.ts` implements every method with Maps and structured clones;
transactions snapshot Maps and restore on throw. Its tests prove
`createRunOperation` inserts only `pending` with zero attempts,
`startRunOperation` performs the sole `pending→running` CAS and increments
attempts, and `retryRunOperation` changes only reconciled-unresolved or
retryable-failed rows back to `pending` without changing attempts. Succeeded
rows remain immutable. It exposes no raw SQL, generic query, `execute`, or
async transaction.

- [ ] **Step 4: Verify exact structural compliance**
Run `npm test -- test/unit/ports/storage-port.test.ts && npm run typecheck && npm run lint`; expect one pass and exact fake-port structural compliance.

- [ ] **Step 5: Commit**

```bash
git add src/app/ports/storage-port.ts test/fixtures/memory-storage.ts test/unit/ports/storage-port.test.ts
git commit -m "feat: define synchronous storage port"
```

### Task 7: Add migrations, atomic snapshots, SQL queries, and leases

**Files:**
- Create: `src/storage/migrations/001-initial.ts`, `src/storage/migrations.ts`
- Create: `src/storage/sqlite-database.ts`, `src/storage/snapshot-repository.ts`, `src/storage/lease-repository.ts`
- Create: `src/storage/state-directory.ts`
- Create: `test/integration/storage/snapshot.test.ts`

**Interfaces:**
- Consumes: snapshot/query/lease port contracts and `compileFilter`.
- Produces: configured SQLite connection, atomic publication, stable query pages, owner-checked leases.

- [ ] **Step 1: Write failing publication and lease tests**

```ts
import { expect, test } from "vitest";
import { migrateSqliteDatabase, openSqliteDatabase } from "../../../src/storage/sqlite-database.js";
import { SnapshotRepository } from "../../../src/storage/snapshot-repository.js";
import { LeaseRepository } from "../../../src/storage/lease-repository.js";
import { snapshotBatchFixture, snapshotDraftFixture } from "../../fixtures/domain.js";
test("hides building rows and publishes only after verification", () => {
  const db=openSqliteDatabase(":memory:"); migrateSqliteDatabase(db,"2026-07-16T00:00:00Z");
  const snapshots=new SnapshotRepository(db);
  const building=snapshots.createSnapshot(snapshotDraftFixture);
  snapshots.appendSnapshotBatch(building.id,snapshotBatchFixture);
  expect(snapshots.getCompleteSnapshot(building.id)).toBeNull();
  const saved=snapshots.completeSnapshot({id:building.id,completedAt:"2026-07-16T01:00:00Z",counts:{repositories:1,stars:1,lists:1,memberships:1},warningCount:0,sourceRateLimit:null});
  expect(snapshots.getCompleteSnapshot(saved.id)?.counts.repositories).toBe(1);
  expect(db.pragma("foreign_keys",{simple:true})).toBe(1); db.close();
});
test("lease expires before another owner acquires", () => {
  const db=openSqliteDatabase(":memory:"); migrateSqliteDatabase(db,"2026-07-16T00:00:00Z");
  const leases=new LeaseRepository(db);
  expect(leases.acquireLease({name:"sync",ownerId:"p1",now:"2026-07-16T00:00:00Z",expiresAt:"2026-07-16T00:05:00Z"})?.ownerId).toBe("p1");
  expect(leases.acquireLease({name:"sync",ownerId:"p2",now:"2026-07-16T00:01:00Z",expiresAt:"2026-07-16T00:06:00Z"})).toBeNull();
  db.close();
});
test("later metadata observations cannot change a completed snapshot", () => {
  const db=openSqliteDatabase(":memory:"); migrateSqliteDatabase(db,"2026-07-16T00:00:00Z");
  const snapshots=new SnapshotRepository(db);
  const first=completeSnapshotWith(snapshots,{stars:10,observedAt:"2026-07-16T00:00:00Z"});
  const before=snapshots.getSnapshotRepository(first.id,asRepositoryId("R_1"));
  completeSnapshotWith(snapshots,{stars:20,observedAt:"2026-07-17T00:00:00Z"});
  expect(snapshots.getSnapshotRepository(first.id,asRepositoryId("R_1"))).toEqual(before);
  expect(snapshots.queryRepositories(queryFor(first.id)).items[0]?.stargazerCount).toBe(10);
  db.close();
});
```

- [ ] **Step 2: Prove storage modules are absent**
Run `npm test -- test/integration/storage/snapshot.test.ts`; expect FAIL resolving `src/storage/sqlite-database.ts`.

- [ ] **Step 3: Implement schema and focused repositories**

Migration 001 creates:

```sql
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL);
CREATE TABLE accounts(host TEXT NOT NULL,login TEXT NOT NULL,account_id TEXT NOT NULL,PRIMARY KEY(host,account_id),UNIQUE(host,login));
CREATE TABLE repositories(repository_id TEXT PRIMARY KEY,repository_database_id TEXT NOT NULL UNIQUE,current_version_hash TEXT,observed_at TEXT NOT NULL);
CREATE TABLE repository_versions(repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,version_hash TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,full_name TEXT NOT NULL,description TEXT,url TEXT NOT NULL,stargazer_count INTEGER NOT NULL CHECK(stargazer_count>=0),is_fork INTEGER NOT NULL CHECK(is_fork IN(0,1)),is_archived INTEGER NOT NULL CHECK(is_archived IN(0,1)),is_disabled INTEGER NOT NULL CHECK(is_disabled IN(0,1)),is_private INTEGER NOT NULL CHECK(is_private IN(0,1)),visibility TEXT NOT NULL CHECK(visibility IN('public','private','internal')),primary_language TEXT,topics_json TEXT NOT NULL,license_spdx_id TEXT,pushed_at TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(repository_id,version_hash));
CREATE TABLE snapshots(snapshot_id TEXT PRIMARY KEY,host TEXT NOT NULL,login TEXT NOT NULL,account_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('building','complete','failed')),started_at TEXT NOT NULL,completed_at TEXT,failed_at TEXT,repositories_count INTEGER NOT NULL DEFAULT 0,stars_count INTEGER NOT NULL DEFAULT 0,lists_count INTEGER NOT NULL DEFAULT 0,memberships_count INTEGER NOT NULL DEFAULT 0,warning_count INTEGER NOT NULL DEFAULT 0,source_rate_limit_json TEXT,FOREIGN KEY(host,account_id) REFERENCES accounts(host,account_id));
CREATE TABLE snapshot_stars(snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,repository_id TEXT NOT NULL,version_hash TEXT NOT NULL,observed_at TEXT NOT NULL,starred_at TEXT NOT NULL,PRIMARY KEY(snapshot_id,repository_id),FOREIGN KEY(repository_id,version_hash) REFERENCES repository_versions(repository_id,version_hash));
CREATE TABLE user_lists(snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,list_id TEXT NOT NULL,name TEXT NOT NULL,slug TEXT NOT NULL,description TEXT,is_private INTEGER NOT NULL CHECK(is_private IN(0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_added_at TEXT,PRIMARY KEY(snapshot_id,list_id));
CREATE TABLE list_memberships(snapshot_id TEXT NOT NULL,list_id TEXT NOT NULL,repository_id TEXT NOT NULL,PRIMARY KEY(snapshot_id,list_id,repository_id),FOREIGN KEY(snapshot_id,list_id) REFERENCES user_lists(snapshot_id,list_id) ON DELETE CASCADE,FOREIGN KEY(snapshot_id,repository_id) REFERENCES snapshot_stars(snapshot_id,repository_id) ON DELETE CASCADE);
CREATE TABLE repository_evidence(repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,source_ref TEXT NOT NULL,etag TEXT,content TEXT NOT NULL,truncated INTEGER NOT NULL CHECK(truncated IN(0,1)),fetched_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(repository_id,source_ref));
CREATE TABLE plans(plan_id TEXT PRIMARY KEY,state TEXT NOT NULL,host TEXT NOT NULL,login TEXT NOT NULL,account_id TEXT NOT NULL,snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id),hash TEXT NOT NULL,executable_json TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,caller_note TEXT,warnings_json TEXT NOT NULL,summary_json TEXT NOT NULL);
CREATE TABLE plan_operations(plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,operation_json TEXT NOT NULL,PRIMARY KEY(plan_id,operation_id),UNIQUE(plan_id,sequence));
CREATE TABLE plan_operation_dependencies(plan_id TEXT NOT NULL,operation_id TEXT NOT NULL,depends_on_operation_id TEXT NOT NULL,PRIMARY KEY(plan_id,operation_id,depends_on_operation_id),FOREIGN KEY(plan_id,operation_id) REFERENCES plan_operations(plan_id,operation_id) ON DELETE CASCADE,FOREIGN KEY(plan_id,depends_on_operation_id) REFERENCES plan_operations(plan_id,operation_id) ON DELETE CASCADE);
CREATE TABLE runs(run_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES plans(plan_id),host TEXT NOT NULL,login TEXT NOT NULL,account_id TEXT NOT NULL,state TEXT NOT NULL,failure_mode TEXT NOT NULL,warnings_json TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,totals_json TEXT NOT NULL,reconciliation_json TEXT NOT NULL);
CREATE TABLE run_operations(run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,status TEXT NOT NULL,reconciliation TEXT NOT NULL,attempts INTEGER NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,external_request_id TEXT,error_json TEXT,started_at TEXT,finished_at TEXT,PRIMARY KEY(run_id,operation_id),UNIQUE(run_id,sequence));
CREATE TABLE leases(name TEXT PRIMARY KEY,owner_id TEXT NOT NULL,acquired_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL,expires_at TEXT NOT NULL);
```

Add indexes for complete snapshot binding/time, snapshot repository pagination, and run sequence. `openSqliteDatabase` applies only the pragmas. `migrateSqliteDatabase(db, appliedAt)` applies pending migrations inside `BEGIN IMMEDIATE` and rejects schema newer than the binary.

`createSnapshot` upserts the bound account then inserts `building`.
`appendSnapshotBatch` canonicalizes each remote Repository, hashes only its
query-relevant GitHub metadata, inserts an immutable `repository_versions` row
idempotently, updates the identity row's current version plus local
`observed_at`, and links the building snapshot Star to that exact version and
observation time. It then inserts Lists and memberships only for that building
ID. Every explicit/latest snapshot query joins `snapshot_stars` to
`repository_versions` through both stable ID and version hash; it never joins
the mutable current pointer. Thus a later sync cannot change an older
snapshot's query results or plan hash. `getRepositoryMetadata` alone follows
the current version and returns its local observation time for incremental
reuse.

`completeSnapshot` verifies actual SQL counts match supplied counts and
performs one guarded `building→complete` update. `failSnapshot` and startup
recovery perform `building→failed`; failed/building snapshots never satisfy
query methods. Queries compose only the allowlisted SQL compiler, fetch page
size plus one, and aggregate the complete filtered set.

Lease acquisition uses:

```sql
INSERT INTO leases(name,owner_id,acquired_at,heartbeat_at,expires_at)
VALUES(@name,@ownerId,@now,@now,@expiresAt)
ON CONFLICT(name) DO UPDATE SET
owner_id=@ownerId,acquired_at=@now,heartbeat_at=@now,expires_at=@expiresAt
WHERE leases.expires_at<=@now OR leases.owner_id=@ownerId RETURNING *;
```

Renew and release require the same owner.

`prepareStateDirectory(path, platform)` creates new POSIX directories with
mode `0700` and new database files with `0600`. Before and after opening, it
removes all group/world permission bits from an existing directory, database,
`-wal`, and `-shm` without adding an owner permission that was absent; failure
to establish owner-only permissions is a `STORAGE_ERROR`. On Windows it relies
on the user's inherited ACL, never shells out, and documents that behavior.
Integration tests inspect POSIX modes, prove a second open does not broaden a
pre-existing restrictive mode, and skip only the numeric-mode assertions on
Windows.

- [ ] **Step 4: Verify rollback, foreign keys, queries, and lease ownership**
Run `npm test -- test/integration/storage/snapshot.test.ts test/unit/domain/filter.test.ts && npm run typecheck && npm run lint`; expect all pass, including orphan-FK rejection, mid-save rollback, and duplicate-free cursor pages.

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrations/001-initial.ts src/storage/migrations.ts src/storage/sqlite-database.ts src/storage/snapshot-repository.ts src/storage/lease-repository.ts src/storage/state-directory.ts test/integration/storage/snapshot.test.ts
git commit -m "feat: persist complete snapshots and leases"
```

### Task 8: Persist immutable plans, write-ahead runs, and crash recovery

**Files:**
- Create: `src/storage/plan-run-repository.ts`, `src/storage/sqlite-store.ts`
- Create: `test/integration/storage/plan-run.test.ts`
- Modify: `test/fixtures/domain.ts`

**Interfaces:**
- Consumes: complete `StoragePort`, domain transitions, configured connection and repositories.
- Produces: `SQLiteStore implements StoragePort`, atomic state claims, paged audit, one-time recovery.

- [ ] **Step 1: Write failing immutability and recovery tests**

```ts
import { expect, test } from "vitest";
import { SQLiteStore } from "../../../src/storage/sqlite-store.js";
import { changePlanFixture, changeRunFixture, runningOperationFixture, snapshotBatchFixture, snapshotDraftFixture } from "../../fixtures/domain.js";
const seedSnapshot = (store:SQLiteStore) => {
  const snapshot=store.createSnapshot(snapshotDraftFixture); store.appendSnapshotBatch(snapshot.id,snapshotBatchFixture);
  store.completeSnapshot({id:snapshot.id,completedAt:"2026-07-16T01:00:00Z",counts:{repositories:1,stars:1,lists:1,memberships:1},warningCount:0,sourceRateLimit:null});
};
test("plans are immutable and claims compare-and-set", () => {
  const store=new SQLiteStore(":memory:"); store.migrate();
  seedSnapshot(store); store.savePlan(changePlanFixture);
  expect(()=>store.savePlan({...changePlanFixture,hash:"f".repeat(64)})).toThrow(/immutable/u);
  expect(store.compareAndSetPlanState({planId:changePlanFixture.id,expected:["ready"],next:"applying"}).state).toBe("applying");
  expect(()=>store.compareAndSetPlanState({planId:changePlanFixture.id,expected:["ready"],next:"expired"})).toThrow(/state/u);
  store.close();
});
test("running audit records recover as unresolved", () => {
  const store=new SQLiteStore(":memory:"); store.migrate();
  seedSnapshot(store); store.savePlan(changePlanFixture);
  store.createRun(changeRunFixture);
  store.createRunOperation({...runningOperationFixture,status:"pending",attempts:0,startedAt:null});
  store.startRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,startedAt:"2026-07-16T02:59:00Z"});
  expect(store.recoverInterruptedRuns("2026-07-16T03:00:00Z")).toEqual([changeRunFixture.id]);
  expect(store.getRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId})?.status).toBe("unresolved");
  expect(store.recoverInterruptedRuns("2026-07-16T03:01:00Z")).toEqual([]);
  store.reconcileRunOperation({
    runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,
    status:"failed",reconciliation:"confirmed_not_applied",
    externalRequestId:null,after:null,
    error:{code:"RECONCILIATION_REQUIRED",message:"confirmed not applied",retryable:true,details:{}},
    finishedAt:"2026-07-16T03:01:30Z",
  });
  const queued=store.retryRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId});
  expect([queued.status,queued.attempts]).toEqual(["pending",1]);
  const retried=store.startRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,startedAt:"2026-07-16T03:03:00Z"});
  expect([retried.status,retried.attempts]).toEqual(["running",2]); store.close();
});
```

- [ ] **Step 2: Prove facade and plan repository are absent**
Run `npm test -- test/integration/storage/plan-run.test.ts`; expect FAIL resolving `src/storage/sqlite-store.ts`.

- [ ] **Step 3: Implement immutable persistence and recovery**

`savePlan` writes the plan plus normalized operation/dependency rows in one
transaction and derives `summary_json`; it first requires a complete source
snapshot and exact equality between snapshot binding and executable binding.
`createRun` likewise requires exact run-binding equality with the stored plan.
Repeated identical ID/content is idempotent, while any differing field raises
`STORAGE_ERROR: plan_id is immutable`. Reads validate JSON through domain
schemas and return frozen copies. State claims use:

```sql
UPDATE plans SET state=@next
WHERE plan_id=@planId AND state IN(SELECT value FROM json_each(@expectedJson))
RETURNING *;
```

No row means `NOT_FOUND` for missing ID or `PRECONDITION_FAILED` for stale
state. Runs use the same rule. `createRun` persists its immutable, redacted
warning strings in `runs.warnings_json`; every load and resume returns the same
warnings. `createRunOperation` inserts a `pending`,
attempt-zero write-ahead row before waiting in the mutation pacer and accepts
a duplicate only when every byte matches. `startRunOperation` is the only
`pending→running` CAS; it sets `startedAt` and increments attempts immediately
before transport dispatch. `retryRunOperation` accepts only an `unresolved`
row reconciled as confirmed-not-applied or a `failed` row with
`error.retryable=true`, changes it to `pending`, and clears finish/error fields
without incrementing attempts. Succeeded/skipped rows never change.
`finishRunOperation` accepts only pending/running records, preserves
before-state, and stores only `SerializedDomainError`.
`reconcileRunOperation` is a separate CAS accepting only an `unresolved`
record and writing `succeeded`/`confirmed_applied`,
`failed`/`confirmed_not_applied`, or `unresolved`/`unknown`; it preserves
attempts, original before/start time, and never makes a succeeded row mutable.

Crash recovery is one `BEGIN IMMEDIATE` transaction:

```sql
UPDATE run_operations SET status='failed',reconciliation='confirmed_not_applied',error_json=@retryableRecoveryError,finished_at=@now WHERE status='pending';
UPDATE run_operations SET status='unresolved',reconciliation='unknown',finished_at=@now WHERE status='running';
UPDATE runs SET state='partial',finished_at=@now WHERE state IN('pending','running');
UPDATE plans SET state='partial' WHERE state='applying' AND EXISTS(SELECT 1 FROM runs r WHERE r.plan_id=plans.plan_id AND r.state='partial');
```

The pending recovery error is `INTERNAL_ERROR`, retryable, and states that no
dispatch occurred; running rows remain ambiguous and must reconcile before
retry. Recovery covers an interrupted run even when it has zero operation
rows, transitions its owning applying plan to partial, returns affected branded
run IDs in lexical order, and is idempotent. Tests simulate a crash before
dispatch, during dispatch, and after a successful response but before audit
completion. `recoverIncompleteSnapshots` similarly changes every building
snapshot to failed once. `listRunOperationsPage` validates size 1–100, orders
by sequence, fetches one extra, and emits `nextSequence` only when more rows
exist.

`SQLiteStore` delegates every port method, owns one connection, makes `close` idempotent, and implements `withTransaction` with `db.transaction(fn).immediate()`. If the callback returns a Promise, roll back and throw `STORAGE_ERROR`; no transaction crosses `await`.

- [ ] **Step 4: Run complete foundation and reopen verification**
Run `npm test -- test/unit test/integration/storage && npm run test:coverage && npm run format:check && npm run lint && npm run typecheck && npm run build && git diff --check`; expect full success, coverage gates, and a reopen test proving one-time recovery without hash/before-state changes.

- [ ] **Step 5: Commit**

```bash
git add src/storage/plan-run-repository.ts src/storage/sqlite-store.ts test/integration/storage/plan-run.test.ts test/fixtures/domain.ts
git commit -m "feat: add crash-safe plan and run storage"
```

## Plan 01 Completion Gate

Run on Node 22 and Node 24 from a clean checkout:

```bash
npm ci
npm run verify
node --input-type=module -e "import('./dist/storage/sqlite-store.js').then(({SQLiteStore})=>{const s=new SQLiteStore(':memory:');s.migrate();if(s.getSchemaVersion()!==1)process.exit(1);s.close()})"
npm pack --dry-run
git status --short
```

Expected: shrinkwrap is unchanged; verification passes; schema smoke exits 0; tarball excludes source, tests, databases, tokens, and environment files; working tree is clean. The Plan 04 startup composition must call `migrate()`, `recoverIncompleteSnapshots(now)`, then `recoverInterruptedRuns(now)` before accepting MCP calls. Specification coverage is explicit across Tasks 1–8: toolchain, IDs, records, snapshots, errors, redaction, config, filters, SQL/cursors, canonical hash, plan/run graph and state, `StoragePort`, WAL/foreign keys/migrations, leases, immutable plans, write-ahead audit, and crash recovery.
