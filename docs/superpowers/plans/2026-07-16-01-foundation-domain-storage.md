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
- SQLite requires 3.38+, UTF-8, JSON1, `foreign_keys=ON`,
  `trusted_schema=OFF`, `mmap_size=0`, `busy_timeout=5000`,
  `synchronous=FULL`, WAL for file databases, and checksum-verified numbered
  migrations.
- Sync creates a lease-bound `building` snapshot, appends bounded page
  batches, then atomically verifies its still-active lease, actual counts, and
  List coverage while publishing `complete`; interrupted work remains
  unreadable and startup recovery skips another live process before failing
  abandoned drafts.
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
    licenseSpdxId: "Apache-2.0", pushedAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T01:00:00.000Z"
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
export interface RepositoryView extends Repository { readonly starredAt: string }
export interface RepositoryFilterView extends RepositoryView { readonly listIds: readonly UserListId[] }
export interface ObservedRepositoryMetadata { readonly repository: Repository; readonly observedAt: string }
```

`repositorySchema` has output type `Repository`, so parsed fields and topic
arrays remain readonly at compile time. It trims names, preserves ID case,
lowercases/trims/deduplicates/sorts topics, requires an HTTPS GitHub URL,
nonnegative integer stars, and canonical UTC ISO timestamps ending in `Z`;
numeric-offset timestamps are rejected rather than stored in mixed forms.

```ts
export type ListCoverage = "collecting" | "complete" | "unavailable" | "omitted";
export interface SnapshotDraft { readonly id: SnapshotId; readonly binding: AccountBinding; readonly mode: "full" | "incremental"; readonly listCoverage: Exclude<ListCoverage,"complete">; readonly startedAt: string }
export interface SnapshotCounts { readonly repositories: number; readonly stars: number; readonly lists: number; readonly memberships: number }
export interface Snapshot extends Omit<SnapshotDraft,"listCoverage"> { readonly listCoverage: ListCoverage; readonly status: "building" | "complete" | "failed"; readonly completedAt: string | null; readonly failedAt: string | null; readonly counts: SnapshotCounts; readonly warningCount: number; readonly sourceRateLimit: JsonValue|null }
export interface SnapshotBatch { readonly repositories: readonly ObservedRepositoryMetadata[]; readonly stars: readonly StarRecord[]; readonly lists: readonly UserList[]; readonly memberships: readonly ListMembership[] }
export interface SnapshotVerificationBatch { readonly stars: readonly StarRecord[]; readonly lists: readonly UserList[]; readonly memberships: readonly ListMembership[] }
```

Task 6 deliberately revisits these snapshot contracts after the basic record
slice is complete: it adds strict runtime parsers, deep freezing, coverage
state invariants, detached-clone behavior at the storage boundary, and an
order-independent verification staging type. Verification batches contain
only the remote identity/timestamp/List relationship data needed to prove set
equality; they never duplicate repository metadata.

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
- Create: `src/domain/timestamp.ts`, `src/domain/filter.ts`, `src/domain/cursor.ts`, `src/storage/filter-sql.ts`
- Modify: `src/domain/repository.ts`, `test/unit/domain/records.test.ts`, `test/fixtures/domain.ts`
- Create: `test/unit/domain/filter.test.ts`

**Interfaces:**
- Consumes: internal `RepositoryFilterView`, `SnapshotId`, branded IDs, `AppError`.
- Produces: `FilterExpression`, `RepositorySort`, `RepositoryQuery`, `RepositoryQueryPage`, `ListQuery`, `ListQueryPage`, evaluators and SQL compiler.

- [ ] **Step 1: Write failing equivalence, injection, and cursor tests**

```ts
import { expect, test } from "vitest";
import { createCursorCodec } from "../../../src/domain/cursor.js";
import { matchesFilter, parseFilter } from "../../../src/domain/filter.js";
import { compileFilter } from "../../../src/storage/filter-sql.js";
import { repositoryViewFixture } from "../../fixtures/domain.js";
test("evaluates filters while parameterizing caller text", () => {
  const nested = parseFilter({ all: [
    { field: "stargazer_count", op: "lt", value: 10000 },
    { field: "pushed_at", op: "before", value: "2023-07-16T00:00:00.000Z" }
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
  const cursors = createCursorCodec(new Uint8Array(32).fill(7));
  const context = {
    kind:"repositories",snapshotId:"snap_1",filterHash:"f".repeat(64),
    sort:[{field:"stargazer_count",direction:"desc"},{field:"pushed_at",direction:"asc"}],
  } as const;
  const cursor = cursors.encodeRepository(context, {
    values:[12,null,"openai/sdk"],nulls:[false,true,false],repositoryId:"R_9",
  });
  expect(cursors.decodeRepository(cursor, context)).toMatchObject({
    values:[12,null,"openai/sdk"],nulls:[false,true,false],repositoryId:"R_9",
  });
  expect(() => cursors.decodeRepository(cursor, {
    ...context,
    snapshotId:"snap_2",
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
export interface LanguageAggregate { readonly language:string|null; readonly count:number }
export interface RepositoryQueryPage { readonly items: readonly RepositoryView[]; readonly total: number; readonly aggregates: { readonly languages:readonly LanguageAggregate[]; readonly archived: number; readonly forks: number }; readonly nextCursor: string|null }
export interface ListSummary extends UserList { readonly repositoryCount:number }
export interface ListQuery { readonly snapshotId: SnapshotId; readonly pageSize: number; readonly cursor: string|null }
export interface ListQueryPage { readonly coverage:"complete"; readonly items: readonly ListSummary[]; readonly total: number; readonly nextCursor: string|null }
export type ListMembershipSelector = {readonly kind:"list";readonly listId:UserListId}|{readonly kind:"repository";readonly repositoryId:RepositoryId};
export interface ListMembershipQuery { readonly snapshotId:SnapshotId; readonly selector:ListMembershipSelector; readonly pageSize:number; readonly cursor:string|null }
export type ListMembershipQueryPage =
  | {readonly coverage:"complete";readonly selector:{readonly kind:"list";readonly listId:UserListId};readonly repositoryIds:readonly RepositoryId[];readonly total:number;readonly nextCursor:string|null}
  | {readonly coverage:"complete";readonly selector:{readonly kind:"repository";readonly repositoryId:RepositoryId};readonly listIds:readonly UserListId[];readonly total:number;readonly nextCursor:string|null};
```

`parseFilter(input, { now })` limits depth to 12 and leaves to 100, rejects
empty groups and mismatched field/operators, and validates timestamps. For
temporal comparisons it also accepts
`{ ago: { amount: 1..10000, unit: "hours"|"days"|"weeks"|"months"|"years" } }`
and immediately resolves it, using the injected UTC `now`, to the absolute ISO
timestamp present in the returned `FilterExpression`. Calendar months/years
use UTC calendar arithmetic; all other units use exact duration arithmetic.
The normalized filter, every nested group/leaf, and every set-value array are
returned as detached, recursively frozen canonical data.
Any relative result outside years `0000..9999` is rejected. The shared
`canonicalUtcTimestamp` accepts only a valid `YYYY-MM-DDTHH:mm:ss[.SSS]Z`
value with zero through three fractional digits and returns exactly
millisecond precision (`.SSSZ`); longer fractions, offsets, expanded years,
invalid calendar dates, and non-canonical cursor timestamps are rejected.
`repositorySchema` uses this same utility for `pushedAt` and `updatedAt`, and
`starRecordSchema`, `userListSchema`, `repositoryViewSchema`, and
`observedRepositoryMetadataSchema` normalize every Star/List/view/observation
timestamp through it. Temporal sort extraction also canonicalizes defensively
before in-memory comparison or cursor creation, so even a manually constructed
view cannot disagree with SQLite. Adapters and storage must parse through
these schemas at their boundaries. No unresolved relative value reaches SQL
or an executable plan.
Filter evaluation uses the internal `RepositoryFilterView`;
`is_unclassified` means its `listIds.length === 0`. Public `RepositoryView`
and `RepositoryQueryPage` rows never expose memberships. Null checks are accepted only
for nullable fields/collections and use a Boolean value. `normalizeSort`
descriptor-snapshots plain data-only terms exactly once, rejects accessors,
symbols, sparse arrays, custom prototypes, and hostile proxies, deduplicates,
then appends `full_name ASC` and internal `repository_id ASC`.

```ts
export interface SqlFragment { readonly sql: string; readonly params: readonly (string|number)[] }
export function compileFilter(filter: FilterExpression): SqlFragment;
export function compileOrder(sort: readonly RepositorySort[]): string;
export function compileCursor(sort: readonly RepositorySort[], cursor: ValidatedRepositoryCursorPayload|null): SqlFragment;
```

Map fields only to fixed columns. Topics use `EXISTS (SELECT 1 FROM
json_each(rv.topics_json) WHERE value=?)`; Lists use `EXISTS (SELECT 1 FROM
list_memberships m WHERE m.snapshot_id=ss.snapshot_id AND
m.repository_id=ss.repository_id AND m.list_id=?)`. Every `in`/`not_in` set
contains 1–5,000 values, all sets together contain at most 10,000 values, and
set values are deduplicated then deterministically sorted during parsing.
Compilation binds each set once as canonical JSON and reads it with
`json_each(?)`; it never emits one SQLite variable per member. Unit tests run a
table-driven evaluator/SQL equivalence case for every allowed field/operator
pair, including nulls and `is_unclassified`, plus 5,000-value and aggregate
budget boundaries.

`createCursorCodec(signingKey)` defensively copies a caller-injected key of at
least 32 actual bytes and returns repository/List/List-membership encode and decode methods.
It obtains typed-array length/data through intrinsic operations, so overridden
subclass properties cannot fake the length, copies into a dedicated unpooled
`Uint8Array` backing store, and retains no `Buffer` view of the key. Tests
cover forged `Uint8Array` subclasses, detached/hostile inputs, source mutation,
and absence of key bytes from the shared Buffer slab.
Repository cursors are max-4-KiB base64url canonical JSON envelopes with
`{mac,payload:{v:1,kind:"repositories",snapshotId,filterHash,sortHash,values,nulls,repositoryId}}`;
List cursors use
`{mac,payload:{v:1,kind:"lists",snapshotId,selectionHash,values,listId}}`.
List-membership cursors use
one of
`{mac,payload:{v:1,kind:"list_memberships",snapshotId,selectionHash,selector:{kind:"list",listId},boundaryRepositoryId}}`
or
`{mac,payload:{v:1,kind:"list_memberships",snapshotId,selectionHash,selector:{kind:"repository",repositoryId},boundaryListId}}`.
The selector is the exact normalized direction, and no generic boundary field
or alternate encoding is accepted.

Task 6 adds these exact codec types and methods:

```ts
export type ListMembershipCursorContext =
  | Readonly<{v:1;kind:"list_memberships";snapshotId:SnapshotId;selector:{kind:"list";listId:UserListId}}>
  | Readonly<{v:1;kind:"list_memberships";snapshotId:SnapshotId;selector:{kind:"repository";repositoryId:RepositoryId}}>;
export type ListMembershipCursorPosition =
  | Readonly<{selector:{kind:"list";listId:UserListId};boundaryRepositoryId:RepositoryId}>
  | Readonly<{selector:{kind:"repository";repositoryId:RepositoryId};boundaryListId:UserListId}>;
export type ValidatedListMembershipCursorPayload =
  | Readonly<{v:1;kind:"list_memberships";snapshotId:SnapshotId;selectionHash:string;selector:{kind:"list";listId:UserListId};boundaryRepositoryId:RepositoryId}>
  | Readonly<{v:1;kind:"list_memberships";snapshotId:SnapshotId;selectionHash:string;selector:{kind:"repository";repositoryId:RepositoryId};boundaryListId:UserListId}>;
export function assertValidatedListMembershipCursorPayload(
  value: unknown,
): asserts value is ValidatedListMembershipCursorPayload;
export interface CursorCodec {
  // existing repository/List methods
  encodeListMembership(context:ListMembershipCursorContext,position:ListMembershipCursorPosition):string;
  decodeListMembership(cursor:string,context:ListMembershipCursorContext):ValidatedListMembershipCursorPayload;
}
```

The context and position selectors must match exactly. Decode returns a
runtime-branded frozen discriminated payload and validates the boundary ID
according to direction; no generic `boundaryId` API escapes the codec. The
brand is held in a module-private `WeakSet<object>` and
`assertValidatedListMembershipCursorPayload` rejects frozen lookalikes that
were not returned by this codec.
`mac` is lowercase-hex HMAC-SHA-256 over the canonical payload and is checked
with constant-time comparison. Decode descriptor-snapshots data-only plain
objects and dense arrays, rejects cycles/exotic prototypes/accessors/symbols
and all malformed input as `VALIDATION_ERROR`, authenticates the envelope,
and requires the expected resource kind, snapshot, canonical
filter/selection hash, and normalized sort. It returns a runtime-branded,
frozen `ValidatedRepositoryCursorPayload`; no sort-only/partial decoder is
exported, and `compileCursor` accepts only that fully validated payload.
Canonical re-encoding after changing any boundary, plus reuse across any
context boundary, raises `VALIDATION_ERROR`.
Neither List codec accepts a caller-selected `selectionHash`. The codec
derives it as `sha256Hex(canonicalJson(context))`, where the only List-page
context is `{v:1,kind:"lists",snapshotId}` and the membership context is the
exact `{v:1,kind:"list_memberships",snapshotId,selector}` union above.
Canonical object-key ordering is therefore part of the wire contract. Lock
these vectors in tests:

```text
{"kind":"lists","snapshotId":"snap_1","v":1}
  -> ebacad18c114f59f8b4a83de0dd9a0d62b4b336beccaaa64a36fbe7f5ea17230
{"kind":"list_memberships","selector":{"kind":"list","listId":"L_1"},"snapshotId":"snap_1","v":1}
  -> 0ca224c01b214e4f2b666ebad73a4031237f8623aa9a5da850d9c13394ee76b9
{"kind":"list_memberships","selector":{"kind":"repository","repositoryId":"R_1"},"snapshotId":"snap_1","v":1}
  -> 44f61d13268a2be2b6b420fe28536027f1ce9f6f05c62e9753cd4ad64bf992f9
```

Every nullable sort uses explicit `NULLS LAST` semantics in both directions,
encoded null markers, and a stable ID final key. Tests cover null/non-null
boundaries, duplicate sort values, empty final pages, cursor tampering, and
cross-snapshot/filter/sort/resource reuse. In-memory text comparison uses UTF-8
byte ordering to match SQLite `BINARY`; cursor temporal values use the shared
canonical UTC validator and stargazer values are nonnegative integers.

- [ ] **Step 4: Verify behavior and SQL safety**
Run `npm test -- test/unit/domain/filter.test.ts && npm run typecheck && npm run lint`; expect one pass, hostile text only in parameters, and clean static checks.

- [ ] **Step 5: Commit**

```bash
git add src/domain/timestamp.ts src/domain/filter.ts src/domain/cursor.ts src/domain/repository.ts src/storage/filter-sql.ts test/unit/domain/filter.test.ts test/unit/domain/records.test.ts test/fixtures/domain.ts
git commit -m "feat: add deterministic repository filters"
```

### Task 5: Define canonical plans, dependency order, and run state

**Files:**
- Create: `src/domain/canonical-json.ts`, `src/domain/plan.ts`, `src/domain/run.ts`
- Create: `test/unit/domain/plan-run.test.ts`

**Interfaces:**
- Consumes: IDs, account/coordinates, filters, `JsonValue`, `SerializedDomainError`.
- Produces: exact immutable plan/run interfaces, strict runtime parsers, canonical executable hashing, graph validation, and normal/recovery lifecycle transitions consumed by plans 03/04.

- [ ] **Step 1: Write failing canonical, graph, and transition tests**

```ts
import { expect, test } from "vitest";
import { canonicalJson, sha256Hex } from "../../../src/domain/canonical-json.js";
import { asRepositoryDatabaseId, asRepositoryId, asSnapshotId } from "../../../src/domain/ids.js";
import { hashPlanExecutable, topologicalOperationIds, transitionPlanState, type ResolvedOperation } from "../../../src/domain/plan.js";
import { recoverRunState, transitionRunState } from "../../../src/domain/run.js";
test("canonicalizes, orders dependencies, and guards terminals", () => {
  expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const create:ResolvedOperation = { operationId:"create",kind:"list_create",dependsOn:[],preconditions:[],before:null,after:{clientRef:"x"},inverse:{kind:"list_delete"},risk:"normal",clientRef:"x" };
  const assign:ResolvedOperation = { operationId:"assign",kind:"list_membership_set",dependsOn:["create"],preconditions:[],before:{listIds:[]},after:{targets:[{kind:"created",createOperationId:"create"}]},inverse:{listIds:[]},risk:"normal",repositoryId:asRepositoryId("R_1"),repositoryDatabaseId:asRepositoryDatabaseId("1"),coordinates:{owner:"o",name:"r"},expectedListIds:[],targetLists:[{kind:"created",createOperationId:"create"}] };
  expect(topologicalOperationIds([assign, create], [{ operationId:"assign", dependsOnOperationId:"create" }])).toEqual(["create","assign"]);
  expect(transitionPlanState("ready", "applying")).toBe("applying");
  expect(() => transitionRunState("completed", "running")).toThrow(/transition/u);
  expect(recoverRunState("pending")).toBe("partial");
  expect(hashPlanExecutable({ schemaVersion:1,policyVersion:"1",binding:{host:"github.com",login:"u",accountId:"1"},snapshotId:asSnapshotId("snap_1"),protectedRepositoryIds:[],protectedListIds:[],operations:[],dependencies:[] })).toHaveLength(64);
});
```

- [ ] **Step 2: Prove plan modules are absent**
Run `npm test -- test/unit/domain/plan-run.test.ts`; expect FAIL resolving `src/domain/canonical-json.ts`.

- [ ] **Step 3: Implement exact request, operation, plan, and run types**

```ts
export type RepositorySelector = { readonly kind:"ids"; readonly repositoryIds:readonly RepositoryId[] } | { readonly kind:"filter"; readonly filter:FilterExpression };
export type ExistingListTarget = { readonly kind:"existing"; readonly listId:UserListId };
export type RequestedListTarget = ExistingListTarget | { readonly kind:"created"; readonly clientRef:string };
export type ResolvedListTarget = ExistingListTarget | { readonly kind:"created"; readonly createOperationId:string };
export type PlanAction =
  | { readonly kind:"star"|"unstar"; readonly repositories:RepositorySelector }
  | { readonly kind:"list_create"; readonly clientRef:string; readonly name:string; readonly description:string|null; readonly isPrivate:boolean }
  | { readonly kind:"list_update"; readonly listIds:readonly UserListId[]; readonly name?:string; readonly description?:string|null; readonly isPrivate?:boolean }
  | { readonly kind:"list_delete"; readonly listIds:readonly UserListId[] }
  | { readonly kind:"list_membership_set"|"list_membership_add"; readonly repositories:RepositorySelector; readonly lists:readonly RequestedListTarget[] }
  | { readonly kind:"list_membership_remove"; readonly repositories:RepositorySelector; readonly lists:readonly ExistingListTarget[] };
export interface PlanRequest { readonly snapshotId:SnapshotId; readonly actions:readonly PlanAction[]; readonly protectedRepositoryIds:readonly RepositoryId[]; readonly protectedListIds:readonly UserListId[]; readonly ttlMinutes?:number; readonly maxOperations?:number; readonly callerNote?:string }
```

Request-time created-List references always use `clientRef`; only the resolver
may translate them into `createOperationId`. One `list_update` request may
select multiple IDs and deterministically expands to one resolved operation
per List. Its schema requires at least one metadata field. All IDs and
references are non-empty and bounded. Request arrays may arrive in any order;
the planner normalizes them before resolution, while executable protected,
expected, target, and dependency ID arrays must already be sorted and unique
rather than being silently reordered by executable parsers.

All operations share `operationId`, `kind`, `dependsOn`, `preconditions`, `before`, `after`, `inverse`, and `risk`. `star`/`unstar` additionally store `repositoryId`, `repositoryDatabaseId`, and `coordinates`. `list_update`/`list_delete` store `listId`; delete before-state stores full List plus member repository IDs. `list_create` stores `clientRef`. `list_membership_set` stores repository IDs/coordinates, `expectedListIds`, and `targetLists`. This routing data is resolved from the snapshot; identity comparisons still use IDs.

```ts
export interface OperationPrecondition { readonly kind:string; readonly expected:JsonValue }
export interface ResolvedOperationBase { readonly operationId:string; readonly dependsOn:readonly string[]; readonly preconditions:readonly OperationPrecondition[]; readonly before:JsonValue; readonly after:JsonValue; readonly inverse:JsonValue; readonly risk:"normal"|"destructive"|"non_reversible" }
export type ResolvedOperation =
  | Readonly<ResolvedOperationBase & {kind:"star"|"unstar";repositoryId:RepositoryId;repositoryDatabaseId:RepositoryDatabaseId;coordinates:RepositoryCoordinates}>
  | Readonly<ResolvedOperationBase & {kind:"list_create";clientRef:string}>
  | Readonly<ResolvedOperationBase & {kind:"list_update"|"list_delete";listId:UserListId}>
  | Readonly<ResolvedOperationBase & {kind:"list_membership_set";repositoryId:RepositoryId;repositoryDatabaseId:RepositoryDatabaseId;coordinates:RepositoryCoordinates;expectedListIds:readonly UserListId[];targetLists:readonly ResolvedListTarget[]}>;
export interface OperationDependency { readonly operationId:string; readonly dependsOnOperationId:string }
export interface PlanExecutableContent { readonly schemaVersion:1; readonly policyVersion:"1"; readonly binding:AccountBinding; readonly snapshotId:SnapshotId; readonly protectedRepositoryIds:readonly RepositoryId[]; readonly protectedListIds:readonly UserListId[]; readonly operations:readonly ResolvedOperation[]; readonly dependencies:readonly OperationDependency[] }
export type PlanState = "ready"|"applying"|"applied"|"partial"|"expired"|"failed"|"superseded";
export interface ChangePlan { readonly id:PlanId; readonly hash:string; readonly state:PlanState; readonly createdAt:string; readonly expiresAt:string; readonly callerNote:string|null; readonly executable:PlanExecutableContent; readonly operations:readonly ResolvedOperation[]; readonly dependencies:readonly OperationDependency[]; readonly warnings:readonly string[] }
export function parsePlanRequest(input:unknown):PlanRequest;
export function parsePlanExecutable(input:unknown):PlanExecutableContent;
export function parseChangePlan(input:unknown):ChangePlan;
export function hashPlanExecutable(input:unknown):string;
export function topologicalOperationIds(operations:readonly ResolvedOperation[], dependencies:readonly OperationDependency[]):readonly string[];
export function reverseDependencyOperationIds(operations:readonly ResolvedOperation[], dependencies:readonly OperationDependency[]):readonly string[];
```

Kahn order always chooses the currently available node with the lowest
original operation index (not FIFO insertion order) and rejects duplicate
operation IDs, duplicate dependency edges, duplicate embedded `dependsOn`
IDs, unknown endpoints, self-edges, mismatched dependency sets, and cycles.
It uses `Map`, never property-key lookup, does not mutate inputs, and returns a
frozen array. Reverse order is the exact reverse topological result. Plan
transitions: `ready→applying|expired|superseded`,
`applying→applied|partial|failed`, `partial→applying`; every other pair,
including self/unknown states, raises `PRECONDITION_FAILED`.

```ts
export type FailureMode="stop"|"continue"; export type RunState="pending"|"running"|"completed"|"partial"|"failed";
export type RunOperationStatus="pending"|"running"|"succeeded"|"skipped"|"failed"|"unresolved";
export type ReconciliationStatus="not_required"|"pending"|"confirmed_applied"|"confirmed_not_applied"|"unknown";
export interface ChangeRun { readonly id:RunId; readonly planId:PlanId; readonly binding:AccountBinding; readonly state:RunState; readonly failureMode:FailureMode; readonly warnings:readonly string[]; readonly startedAt:string; readonly finishedAt:string|null }
export interface RunOperation { readonly runId:RunId; readonly operationId:string; readonly sequence:number; readonly status:RunOperationStatus; readonly reconciliation:ReconciliationStatus; readonly attempts:number; readonly before:JsonValue; readonly after:JsonValue; readonly externalRequestId:string|null; readonly error:SerializedDomainError|null; readonly startedAt:string|null; readonly finishedAt:string|null }
export function parseChangeRun(input:unknown):ChangeRun;
export function parseRunOperation(input:unknown):RunOperation;
export function recoverRunState(state:"pending"|"running"): "partial";
```

Normal run transitions are `pending→running`,
`running→completed|partial|failed`, and `partial→running`.
`recoverRunState` is the only domain path for startup recovery to map
`pending|running→partial`; that edge is not accepted by
`transitionRunState`. Pending/running runs have `finishedAt:null`; completed,
partial, and failed runs require a canonical non-null `finishedAt`.

All exported parsers first descriptor-snapshot through `canonicalJson`, then
strictly validate the safe clone, recursively freeze it, and reject unknown
fields. Plan executable parsing enforces exact schema/policy versions, a
closed operation union, valid branded IDs/account binding, canonical UTC
timestamps where present, nonnegative safe sequence/attempt counts, bounded
trim-equal strings, sorted unique protected/expected IDs, valid JSON
precondition/before/after/inverse data, and graph agreement. A parsed
`ChangePlan` requires lowercase-hex SHA-256 equal to its executable hash and
requires top-level `operations`/`dependencies` to equal—and be returned as
the same frozen arrays as—the executable copies.

`canonicalJson` is a hostile-runtime boundary: it snapshots own data
descriptors without invoking getters/iterators; accepts only null, Boolean,
string, finite number, dense plain-object/array JSON; treats `-0` as `0`;
sorts object keys; preserves array order and repeated non-cyclic references;
and rejects accessors, proxies, symbols, functions, BigInt, `undefined`,
non-finite numbers, custom prototypes/`toJSON`, array extra properties,
sparse arrays, cycles, and reflection/recursion failures as generic
`VALIDATION_ERROR`. `sha256Hex` hashes UTF-8 text to 64 lowercase hex.
`hashPlanExecutable` strictly parses/projects only
`PlanExecutableContent`, so extra metadata can neither enter nor be silently
ignored by the hash. The planner derives `binding` from the referenced
complete snapshot, uses fixed `policyVersion:"1"`, and never accepts
caller-supplied account identity.

- [ ] **Step 4: Verify hash determinism, hostile inputs, parsers, and transition tables**
Run `npm test -- test/unit/domain/plan-run.test.ts && npm run typecheck && npm run lint`; expect one pass with reordered-object/hash vectors, metadata exclusion, executable-change sensitivity, frozen safe-clone parsers, graph tie-break/malformed cases, every lifecycle state pair, recovery-only edges, and hostile canonical input assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/canonical-json.ts src/domain/plan.ts src/domain/run.ts test/unit/domain/plan-run.test.ts
git commit -m "feat: define immutable plans and run lifecycle"
```

### Task 6: Lock the complete synchronous StoragePort

**Files:**
- Create: `src/app/ports/storage-port.ts`
- Create: `test/fixtures/memory-storage.ts`, `test/unit/ports/storage-port.test.ts`
- Modify: `src/domain/snapshot.ts`, `src/domain/filter.ts`, `src/domain/cursor.ts`, `src/domain/run.ts`, `test/fixtures/domain.ts`

**Interfaces:**
- Consumes: all domain contracts from Tasks 2, 4, 5.
- Produces: exact port for plans 02/03 and `SQLiteStore`, bounded List
  membership pages, immutable dispatch-attempt history, strict storage
  parsers, and a faithful in-memory contract implementation.

- [ ] **Step 1: Write the failing fake-port contract test**

```ts
import { expect, test } from "vitest";
import type { StoragePort } from "../../../src/app/ports/storage-port.js";
import { createMemoryStorage } from "../../fixtures/memory-storage.js";
test("transactions are synchronous, rollback thenables, and revoke leaked facades", () => {
  const store: StoragePort = createMemoryStorage();
  store.migrate();
  expect(store.withTransaction(() => "committed")).toBe("committed");
  let leaked: unknown;
  expect(() => store.withTransaction((tx) => {
    leaked=tx;
    tx.savePlan(changePlanFixture);
    return Promise.resolve("must roll back");
  })).toThrow(/synchronous|thenable/iu);
  expect(store.getPlan(changePlanFixture.id)).toBeNull();
  expect(() => (leaked as StorageTransaction).getPlan(changePlanFixture.id)).toThrow();
  expect(store.getSchemaVersion()).toBe(1);
  store.close();
});
```

- [ ] **Step 2: Prove the port is missing**
Run `npm test -- test/unit/ports/storage-port.test.ts`; expect FAIL resolving `src/app/ports/storage-port.ts`.

- [ ] **Step 3: Define every exact method**

```ts
export interface Lease { readonly name:string; readonly ownerId:string; readonly acquiredAt:string; readonly heartbeatAt:string; readonly expiresAt:string }
export interface AcquireLeaseInput { readonly name:string; readonly ownerId:string; readonly now:string; readonly expiresAt:string }
export interface LeaseGuard { readonly name:string; readonly ownerId:string; readonly now:string }
export interface CompleteSnapshotInput { readonly id:SnapshotId; readonly completedAt:string; readonly listCoverage:Exclude<ListCoverage,"collecting">; readonly counts:SnapshotCounts; readonly warningCount:number; readonly sourceRateLimit:JsonValue|null; readonly lease:LeaseGuard }
export interface FailSnapshotInput { readonly id:SnapshotId; readonly failedAt:string; readonly sourceRateLimit:JsonValue|null; readonly lease:LeaseGuard }
export interface AuditPage { readonly items:readonly RunOperation[]; readonly total:number; readonly nextSequence:number|null }
export type RunOperationCounts=Readonly<Record<RunOperationStatus,number>>;
export interface IncompleteRunSummary { readonly runId:RunId; readonly planId:PlanId; readonly state:"pending"|"running"|"partial"; readonly startedAt:string; readonly finishedAt:string|null; readonly counts:RunOperationCounts }
export interface IncompleteRunSummaries { readonly items:readonly IncompleteRunSummary[]; readonly total:number; readonly truncated:boolean }
export type RunOperationAttemptStatus="running"|"succeeded"|"failed"|"unresolved";
interface RunOperationAttemptBase { readonly runId:RunId;readonly operationId:string;readonly attempt:number;readonly before:JsonValue;readonly startedAt:string }
export type RunOperationAttempt =
  | Readonly<RunOperationAttemptBase & {status:"running";reconciliation:"pending";after:null;externalRequestId:null;error:null;finishedAt:null}>
  | Readonly<RunOperationAttemptBase & {status:"succeeded";reconciliation:"not_required";after:JsonValue;externalRequestId:string|null;error:null;finishedAt:string}>
  | Readonly<RunOperationAttemptBase & {status:"failed";reconciliation:"confirmed_not_applied";after:JsonValue;externalRequestId:string|null;error:SerializedDomainError;finishedAt:string}>
  | Readonly<RunOperationAttemptBase & {status:"unresolved";reconciliation:"unknown";after:JsonValue;externalRequestId:string|null;error:SerializedDomainError&{readonly retryable:false};finishedAt:string}>;
export interface RunOperationAttemptPage { readonly items:readonly RunOperationAttempt[]; readonly total:number; readonly nextAttempt:number|null }
interface RunOperationReconciliationBase { readonly runId:RunId;readonly operationId:string;readonly attempt:number;readonly eventSequence:number;readonly after:JsonValue;readonly observedAt:string }
export type RunOperationReconciliation =
  | Readonly<RunOperationReconciliationBase & {status:"succeeded";reconciliation:"confirmed_applied";error:null}>
  | Readonly<RunOperationReconciliationBase & {status:"failed";reconciliation:"confirmed_not_applied";error:SerializedDomainError&{readonly retryable:true}}>
  | Readonly<RunOperationReconciliationBase & {status:"unresolved";reconciliation:"unknown";error:SerializedDomainError&{readonly retryable:false}}>;
export interface RunOperationReconciliationPage { readonly items:readonly RunOperationReconciliation[]; readonly total:number; readonly nextEventSequence:number|null }
interface FinishBeforeDispatchBase { readonly phase:"before_dispatch";readonly runId:RunId;readonly operationId:string;readonly finishedAt:string;readonly lease:LeaseGuard }
interface FinishAfterDispatchBase { readonly phase:"after_dispatch";readonly runId:RunId; readonly operationId:string; readonly externalRequestId:string|null; readonly after:JsonValue; readonly finishedAt:string; readonly lease:LeaseGuard }
export type FinishRunOperationInput =
  | Readonly<FinishBeforeDispatchBase & {readonly status:"skipped";readonly reconciliation:"not_required";readonly error:null}>
  | Readonly<FinishBeforeDispatchBase & {readonly status:"failed";readonly reconciliation:"confirmed_not_applied";readonly error:SerializedDomainError}>
  | Readonly<FinishAfterDispatchBase & {readonly status:"succeeded";readonly reconciliation:"not_required";readonly error:null}>
  | Readonly<FinishAfterDispatchBase & {readonly status:"failed";readonly reconciliation:"confirmed_not_applied";readonly error:SerializedDomainError}>
  | Readonly<FinishAfterDispatchBase & {readonly status:"unresolved";readonly reconciliation:"unknown";readonly error:SerializedDomainError&{readonly retryable:false}}>;
interface ReconcileBase { readonly runId:RunId; readonly operationId:string; readonly after:JsonValue; readonly observedAt:string; readonly lease:LeaseGuard }
export type ReconcileRunOperationInput =
  | Readonly<ReconcileBase & {readonly status:"succeeded";readonly reconciliation:"confirmed_applied";readonly error:null}>
  | Readonly<ReconcileBase & {readonly status:"failed";readonly reconciliation:"confirmed_not_applied";readonly error:SerializedDomainError&{readonly retryable:true}}>
  | Readonly<ReconcileBase & {readonly status:"unresolved";readonly reconciliation:"unknown";readonly error:SerializedDomainError&{readonly retryable:false}}>;
export interface StorageTransaction {
  assertLease(guard:LeaseGuard):Lease;
  createSnapshot(input:{readonly draft:SnapshotDraft;readonly lease:LeaseGuard}):Snapshot;
  appendSnapshotBatch(input:{readonly id:SnapshotId;readonly batch:SnapshotBatch;readonly lease:LeaseGuard}):void;
  beginSnapshotVerification(input:{readonly id:SnapshotId;readonly listCoverage:Exclude<ListCoverage,"collecting">;readonly lease:LeaseGuard}):void;
  appendSnapshotVerificationBatch(input:{readonly id:SnapshotId;readonly batch:SnapshotVerificationBatch;readonly lease:LeaseGuard}):void;
  finishSnapshotVerification(input:{readonly id:SnapshotId;readonly lease:LeaseGuard}):void;
  completeSnapshot(input:CompleteSnapshotInput):Snapshot;
  failSnapshot(input:FailSnapshotInput):Snapshot;
  getCompleteSnapshot(id:SnapshotId):Snapshot|null;
  getLatestCompleteSnapshot(binding:AccountBinding):Snapshot|null;
  getRepositoryMetadata(id:RepositoryId):ObservedRepositoryMetadata|null;
  getSnapshotRepository(snapshotId:SnapshotId,repositoryId:RepositoryId):RepositoryView|null;
  getSnapshotListSummary(snapshotId:SnapshotId,listId:UserListId):ListSummary|null;
  queryRepositories(input:RepositoryQuery):RepositoryQueryPage;
  queryLists(input:ListQuery):ListQueryPage;
  queryListMemberships(input:ListMembershipQuery):ListMembershipQueryPage;
  hasStar(snapshotId:SnapshotId,repositoryId:RepositoryId):boolean;
  savePlan(plan:ChangePlan):void;
  getPlan(id:PlanId):ChangePlan|null;
  compareAndSetPlanState(input:{readonly planId:PlanId;readonly expected:readonly PlanState[];readonly next:PlanState}):ChangePlan;
  createRun(input:{readonly run:ChangeRun;readonly lease:LeaseGuard}):void;
  getRun(id:RunId):ChangeRun|null;
  getLatestRunForPlan(planId:PlanId):ChangeRun|null;
  compareAndSetRunState(input:{readonly runId:RunId;readonly expected:readonly RunState[];readonly next:RunState;readonly finishedAt:string|null;readonly lease:LeaseGuard}):ChangeRun;
  createRunOperation(input:{readonly operation:RunOperation;readonly lease:LeaseGuard}):void;
  startRunOperation(input:{readonly runId:RunId;readonly operationId:string;readonly startedAt:string;readonly lease:LeaseGuard}):RunOperation;
  getRunOperation(input:{readonly runId:RunId;readonly operationId:string}):RunOperation|null;
  retryRunOperation(input:{readonly runId:RunId;readonly operationId:string;readonly maxAttempts:number;readonly lease:LeaseGuard}):RunOperation;
  listRunOperations(runId:RunId):readonly RunOperation[];
  listRunOperationsPage(input:{readonly runId:RunId;readonly afterSequence:number|null;readonly pageSize:number}):AuditPage;
  finishRunOperation(input:FinishRunOperationInput):RunOperation;
  reconcileRunOperation(input:ReconcileRunOperationInput):RunOperation;
  getRunOperationAttempt(input:{readonly runId:RunId;readonly operationId:string;readonly attempt:number}):RunOperationAttempt|null;
  listRunOperationAttemptsPage(input:{readonly runId:RunId;readonly operationId:string;readonly afterAttempt:number|null;readonly pageSize:number}):RunOperationAttemptPage;
  listRunOperationReconciliationsPage(input:{readonly runId:RunId;readonly operationId:string;readonly afterEventSequence:number|null;readonly pageSize:number}):RunOperationReconciliationPage;
  acquireLease(input:AcquireLeaseInput):Lease|null;
  renewLease(input:AcquireLeaseInput):Lease;
  releaseLease(input:{readonly name:string;readonly ownerId:string}):void;
}
export interface StoragePort extends StorageTransaction {
  migrate():void; getSchemaVersion():number;
  withTransaction<T>(fn:(tx:StorageTransaction)=>T):T;
  getIncompleteRunSummaries(input:{readonly binding:AccountBinding;readonly limit:number}):IncompleteRunSummaries;
  recoverAbandonedSnapshots(input:{readonly binding:AccountBinding;readonly lease:LeaseGuard}):readonly SnapshotId[];
  recoverAbandonedRuns(input:{readonly binding:AccountBinding;readonly lease:LeaseGuard}):readonly RunId[];
  recoverIncompleteSnapshots(now:string):readonly SnapshotId[];
  recoverInterruptedRuns(now:string):readonly RunId[];
  close():void;
}
```

`Snapshot`, query-page, attempt, reconciliation-event, and storage-input schemas strictly parse a
descriptor-safe clone, reject unknown fields/aliases, and deeply freeze all
returned values. The language aggregate is an ordered array rather than a
property-keyed record, so a GitHub language such as `__proto__` is inert.
`ListSummary` exposes `repositoryCount` and never embeds members.
`RepositoryView` exposes repository metadata plus `starredAt` and never
embeds `listIds`.
`queryListMemberships` is the only membership read and returns a strict
direction-specific ID page (`repositoryIds` for List selection or `listIds`
for repository selection) with a cursor authenticated against the exact
snapshot and selector. Every List query and List-dependent repository filter
rejects a snapshot whose coverage is not `complete`; other repository queries
remain available.

`memory-storage.ts` starts unmigrated, initializes a private random 32-byte
cursor key only in `migrate()`, and rejects all other operations before ready.
A deterministic key may be injected only through the fixture factory input;
it is copied immediately into a dedicated byte buffer, including when the
source view is backed by `SharedArrayBuffer`, and temporary bytes are wiped.
No key/codec getter, own property, transaction snapshot, error, or log is
exposed. Repeated migration and close are idempotent. Writes parse detached
copies; reads return new frozen detached values. Snapshot metadata versions
and current pointers advance by lexical `(observedAt, versionHash)`, and a
completed snapshot remains unchanged after later metadata observations. The
memory oracle keeps every immutable `(repositoryId, versionHash)` payload and
exact-compares historical hash collisions, plus bidirectional first-seen
`repositoryId`/`repositoryDatabaseId` bindings. A failed batch publishes none
of its snapshot rows, versions, identity bindings, or current pointers.

Snapshot coverage transitions are exact: `collecting -> complete`,
`unavailable -> unavailable`, and `omitted -> omitted`. No other publication
pair is legal. A non-empty List/membership batch is accepted only while the
building snapshot is `collecting`; unavailable/omitted snapshots always retain
zero List/membership rows. An unsupported remote union member or interrupted
List traversal fails the snapshot while it is still collecting and can never
be downgraded into a publishable unavailable/omitted snapshot.
After all first-pass batches, `beginSnapshotVerification` creates a private
empty verification set for the requested final coverage.
`appendSnapshotVerificationBatch` accepts at most 100 Stars, Lists, and
memberships per call; a repeated Star/List/membership identity in that
verification traversal is a collection-change error, never an idempotent
upsert. `finishSnapshotVerification` marks the second traversal complete but
does not publish. `completeSnapshot` is legal only after that marker and
compares the staged and verification Stars `(repositoryId,starredAt)`, every
normalized List metadata field, and memberships `(listId,repositoryId)` as
order-independent exact sets. A mismatch rolls back publication. Verification
rows are private implementation state, never queryable through `StoragePort`,
and are cleared only in the same successful completion or failure/recovery
transaction.
The strict Snapshot parser also rejects `building|failed + complete`,
`complete + collecting`, mismatched lifecycle timestamps, final
unavailable/omitted counts above zero, and any nonnegative-count/rate-limit
shape violation.

Every guarded mutation atomically proves the exact lease owner and
`expiresAt > now`. `acquireLease` returns null for every unexpired lease,
including the same owner; it can take over only at `expiresAt <= now`.
Only `renewLease` may extend the exact same owner and it preserves
`acquiredAt`; a wrong-owner renew/release raises `PRECONDITION_FAILED`.
Each service `LeaseScope` uses a fresh unpredictable owner ID, so two
concurrent calls in one process cannot become same-owner entrants.
`createRun` requires
`pending/finishedAt:null`, exact plan binding, and a globally unique
`planId`. `createRunOperation` accepts only a canonical
`pending/not_required/attempts:0` row whose operation ID and zero-based
sequence match that run's immutable plan. It also requires plan `applying`,
run `running`, exact run/plan binding, and canonical equality between the
audit row's `before` and the resolved plan operation's `before`. Duplicate
create/save calls compare only immutable initial content and never reset a
lifecycle that has advanced.

`parseRunOperation`, `parseRunOperationAttempt`, and
`parseRunOperationReconciliation` enforce the complete matrix, not just enum
membership:

- initial/retried projection: `pending/not_required`, null start/finish,
  request/error/after, attempts zero for initial or positive after retry;
- dispatch projection: `running/pending`, attempts at least one, non-null
  start, null finish/error;
- skipped: `skipped/not_required`, no attempt/start/request/error, null after;
- success: `succeeded` with `not_required` direct dispatch or
  `confirmed_applied` reconciliation, no error;
- failure: `failed/confirmed_not_applied` with error; only a retryable error
  can enter retry;
- unresolved: `unresolved/unknown`, attempts at least one, non-null
  start/finish and non-retryable error;
- attempt rows: only running/pending, succeeded/not_required,
  failed/confirmed_not_applied, or unresolved/unknown; no skipped attempt;
- reconciliation events: only succeeded/confirmed_applied with null error,
  failed/confirmed_not_applied with retryable error, or unresolved/unknown
  with non-retryable error.

`startRunOperation` is one lease-guarded CAS that proves run `running`, plan
`applying`, moves `pending -> running`, increments attempts, and appends the
matching immutable attempt intent. Nothing may await between its return and
transport dispatch. Live precondition reads must therefore occur before
`startRunOperation`; an already-desired or rejected precondition uses
`phase:"before_dispatch"` and creates no attempt. The prepared mutation's
`dispatchPrepared` method must synchronously initiate the one transport call
before returning its Promise.

`finishRunOperation` never accepts caller `before` or `attempts`.
Before-dispatch finish accepts no caller request ID/after state and stores
`null` for both; after-dispatch finish finalizes the current attempt and
projection exactly once. `reconcileRunOperation` accepts only an unresolved
projection, preserves the immutable attempt—including its original ambiguous
`finishedAt`—appends a new `RunOperationReconciliation` event, and updates only
the projection. Every subsequent unknown readback appends another event rather
than overwriting history. A reconciliation event classified
`confirmed_not_applied` must be retryable; a definitive before-dispatch or
transport failure with the same reconciliation may be non-retryable. An
`unknown` error must not be retryable.

`retryRunOperation` accepts only
`failed + confirmed_not_applied + error.retryable + attempts < maxAttempts`.
It never accepts unresolved/unknown, never deletes attempt rows, preserves
before/attempts, and clears projection start/finish/error/request/after before
returning to `pending/not_required`. Succeeded and skipped rows are immutable.
Attempt and reconciliation-event history is never deleted. Audit pages validate integer sizes `1..100`, reject negative boundaries or a
boundary beyond the actual maximum, include a total over the whole selection,
and set the next boundary to the last returned
sequence/attempt/event-sequence only when more rows exist. Incomplete-run
summaries are bounded, include all operation-status counts, and report
total/truncation without an unbounded row array.

Every compare-and-set first validates the requested domain transition even
when the expected value matches. The expected array must be non-empty and
unique, and every listed `expected -> next` edge must be legal before storage
is read. Missing IDs raise `NOT_FOUND`; an actual state outside expected or an
illegal/self edge raises `PRECONDITION_FAILED`. Run terminal `finishedAt`
must be fresh and not precede start; `partial -> running` clears it and
atomically rebinds the run's private stored lease name/owner to the new guard.
Startup recovery skips snapshots/runs whose stored exact-owner lease remains
active. Pending rows recover to retryable
`failed/confirmed_not_applied` without an attempt; running attempts and
projections recover to `unresolved/unknown`; the owning run/plan become
partial exactly once.
The two targeted recovery methods first validate the newly acquired
account-scoped sync/apply guard, restrict candidates to its exact binding, and
perform the same atomic transition. A lease takeover can therefore unblock
abandoned work immediately in a long-running process rather than waiting for
another restart.

`withTransaction` rejects nesting and any call through the root store while a
callback is active; only its transaction facade may access state. Calls to
root `migrate`, `close`, or another `withTransaction` are likewise rejected.
It supplies a revocable transaction facade.
The callback may return `undefined`, another non-callable canonical primitive,
or bounded canonical JSON data made only from descriptor-data
plain/null-prototype objects and dense standard arrays. Recognizable runtime
brands such as Map/Set/WeakMap/WeakSet, Promise, Proxy, Date, RegExp, native
Error, ArrayBuffer, SharedArrayBuffer, and buffer views are rejected before
prototype or descriptor reflection. The descriptor-safe canonical validator
also rejects functions, ordinary custom-prototype/class instances, accessors,
symbols, sparse arrays, and cycles without invoking getters, traps, iterators,
or `toJSON`. Accepted objects and arrays are returned only after
canonicalization into a detached, recursively frozen JSON clone; their input
identity, prototype, class identity, and private/internal slots are not
preserved. A prototype-erased object whose hidden brand cannot be recognized
may canonicalize to only its enumerable data (often `{}`), but the original
object never escapes. This does not claim that every disguised class is
detectable. Validation and cloning run before a final poison-state check, so a
caught reentry during validation cannot commit. Any rejection rolls back every
Map/index/lease/attempt mutation. The facade is revoked before commit/rollback
returns, so a captured
`tx` cannot mutate later. It exposes no raw SQL, generic query, `execute`, or
async transaction.

- [ ] **Step 4: Verify exact structural compliance**
Run `npm test -- test/unit/ports/storage-port.test.ts test/unit/domain/filter.test.ts test/unit/domain/plan-run.test.ts && npm run typecheck && npm run lint`; expect all tests pass, including:

- commit/throw rollback; canonical primitives returned by value and
  plain/null-prototype/array results returned as detached deep-frozen clones;
  rejected recognizable prototype-erased exotics and
  Promise/Proxy/function/class/container/accessor/symbol/sparse/cyclic results
  with zero getter/trap calls; safe enumerable-only canonicalization of
  undetectable prototype-erased private-slot instances; nested transaction;
  root-store reentry; and leaked facade calls after commit and rollback;
- detached/deep-frozen reads after caller mutation, hostile
  accessor/proxy/symbol/sparse/custom-prototype input, and inert
  `__proto__` language values;
- all coverage transitions, batch 101 rejection, count rollback, immutable
  metadata pinning, exact staged/verification set equality, reordered
  verification batches accepted, duplicate or added/removed/changed
  Star/List/membership verification rejected, repository/List/two-direction
  membership cursor tamper/cross-context pages, runtime-brand lookalikes and
  locked selection-hash vectors, and aggregates independent of cursor;
- one-plan-one-run, binding/ID/sequence/before validation, idempotency without
  lifecycle reset, full CAS/finished-time/resume-lease matrix;
- every legal and illegal operation/attempt/reconciliation combination,
  pending finish without attempt, multi-attempt preservation, append-only
  reconciliation events, max-attempt boundary, and bounded audit pages;
- active same-owner reacquire rejection, lease renewal/takeover/wrong
  owner/backward time, exact-owner recovery skip, idempotent expired recovery,
  and bounded incomplete-run totals.

- [ ] **Step 5: Commit**

```bash
git add src/app/ports/storage-port.ts src/domain/snapshot.ts src/domain/filter.ts src/domain/cursor.ts src/domain/run.ts test/fixtures/domain.ts test/fixtures/memory-storage.ts test/unit/ports/storage-port.test.ts test/unit/domain/filter.test.ts test/unit/domain/plan-run.test.ts
git commit -m "feat: define synchronous storage port"
```

### Task 7: Add migrations, atomic snapshots, SQL queries, and leases

**Files:**
- Create: `src/storage/migrations/001-initial.ts`, `src/storage/migrations.ts`
- Create: `src/storage/sqlite-database.ts`, `src/storage/snapshot-repository.ts`, `src/storage/lease-repository.ts`
- Create: `src/storage/runtime-secret-repository.ts`
- Create: `src/storage/state-directory.ts`
- Create: `test/integration/storage/snapshot.test.ts`

**Interfaces:**
- Consumes: snapshot/query/lease port contracts, `createCursorCodec`, and `compileFilter`.
- Produces: configured SQLite connection, private persistent cursor key, atomic publication, authenticated stable query pages, owner-checked leases.

- [ ] **Step 1: Write failing publication and lease tests**

```ts
import { expect, test } from "vitest";
import { createCursorCodec } from "../../../src/domain/cursor.js";
import { migrateSqliteDatabase, openSqliteDatabase } from "../../../src/storage/sqlite-database.js";
import { SnapshotRepository } from "../../../src/storage/snapshot-repository.js";
import { LeaseRepository } from "../../../src/storage/lease-repository.js";
import { snapshotBatchFixture, snapshotDraftFixture } from "../../fixtures/domain.js";
test("hides building rows and publishes only after verification", () => {
  const db=openSqliteDatabase(":memory:"); migrateSqliteDatabase(db,"2026-07-16T00:00:00.000Z");
  const leases=new LeaseRepository(db);
  leases.acquireLease({name:"sync:account",ownerId:"p1",now:"2026-07-16T00:00:00.000Z",expiresAt:"2026-07-16T00:05:00.000Z"});
  const guard={name:"sync:account",ownerId:"p1",now:"2026-07-16T00:01:00.000Z"} as const;
  const snapshots=new SnapshotRepository(db,createCursorCodec(new Uint8Array(32).fill(7)));
  const building=snapshots.createSnapshot({draft:snapshotDraftFixture,lease:guard});
  snapshots.appendSnapshotBatch({id:building.id,batch:snapshotBatchFixture,lease:guard});
  expect(snapshots.getCompleteSnapshot(building.id)).toBeNull();
  snapshots.beginSnapshotVerification({id:building.id,listCoverage:"complete",lease:guard});
  snapshots.appendSnapshotVerificationBatch({
    id:building.id,
    batch:{
      stars:snapshotBatchFixture.stars,
      lists:snapshotBatchFixture.lists,
      memberships:snapshotBatchFixture.memberships,
    },
    lease:guard,
  });
  snapshots.finishSnapshotVerification({id:building.id,lease:guard});
  const saved=snapshots.completeSnapshot({id:building.id,completedAt:"2026-07-16T00:02:00.000Z",listCoverage:"complete",counts:{repositories:1,stars:1,lists:1,memberships:1},warningCount:0,sourceRateLimit:null,lease:guard});
  expect(snapshots.getCompleteSnapshot(saved.id)?.counts.repositories).toBe(1);
  expect(db.pragma("foreign_keys",{simple:true})).toBe(1);
  expect(db.pragma("synchronous",{simple:true})).toBe(2); db.close();
});
test("lease expires before another owner acquires", () => {
  const db=openSqliteDatabase(":memory:"); migrateSqliteDatabase(db,"2026-07-16T00:00:00.000Z");
  const leases=new LeaseRepository(db);
  expect(leases.acquireLease({name:"sync",ownerId:"p1",now:"2026-07-16T00:00:00.000Z",expiresAt:"2026-07-16T00:05:00.000Z"})?.ownerId).toBe("p1");
  expect(leases.acquireLease({name:"sync",ownerId:"p1",now:"2026-07-16T00:00:30.000Z",expiresAt:"2026-07-16T00:06:00.000Z"})).toBeNull();
  expect(leases.acquireLease({name:"sync",ownerId:"p2",now:"2026-07-16T00:01:00.000Z",expiresAt:"2026-07-16T00:06:00.000Z"})).toBeNull();
  expect(leases.renewLease({name:"sync",ownerId:"p1",now:"2026-07-16T00:01:30.000Z",expiresAt:"2026-07-16T00:07:00.000Z"})?.acquiredAt).toBe("2026-07-16T00:00:00.000Z");
  db.close();
});
test("later metadata observations cannot change a completed snapshot", () => {
  const db=openSqliteDatabase(":memory:"); migrateSqliteDatabase(db,"2026-07-16T00:00:00.000Z");
  const snapshots=new SnapshotRepository(db,createCursorCodec(new Uint8Array(32).fill(7)));
  const first=completeSnapshotWith(snapshots,{stars:10,observedAt:"2026-07-16T00:00:00.000Z"});
  const before=snapshots.getSnapshotRepository(first.id,asRepositoryId("R_1"));
  completeSnapshotWith(snapshots,{stars:20,observedAt:"2026-07-17T00:00:00.000Z"});
  expect(snapshots.getSnapshotRepository(first.id,asRepositoryId("R_1"))).toEqual(before);
  expect(snapshots.queryRepositories(queryFor(first.id)).items[0]?.stargazerCount).toBe(10);
  db.close();
});
```

- [ ] **Step 2: Prove storage modules are absent**
Run `npm test -- test/integration/storage/snapshot.test.ts`; expect FAIL resolving `src/storage/sqlite-database.ts`.

- [ ] **Step 3: Implement schema and focused repositories**

Migration 001 creates only `STRICT` tables. Every JSON text column has
`CHECK(json_valid(...))` and, for arrays, the corresponding
`json_type(...)=` check. Every Boolean, enum, nonnegative count, lifecycle
timestamp, hash, and relationship is constrained in SQL as well as parsed by
the domain boundary. The schema includes the tables listed below; omitted
Repository/List payload columns are the exact normalized fields from Task 2.

```sql
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY CHECK(version>0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE runtime_secrets(
  name TEXT PRIMARY KEY,
  value BLOB NOT NULL CHECK(typeof(value)='blob' AND length(value)>=32),
  created_at TEXT NOT NULL,
  CHECK(name<>'cursor_hmac_sha256_v1' OR length(value)=32)
) STRICT;
CREATE TABLE leases(
  name TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  CHECK(length(name)>0 AND length(owner_id)>0),
  CHECK(acquired_at<=heartbeat_at AND heartbeat_at<expires_at)
) STRICT;
CREATE TABLE accounts(
  host TEXT NOT NULL, login TEXT NOT NULL, account_id TEXT NOT NULL,
  PRIMARY KEY(host,account_id),
  UNIQUE(host,login),
  UNIQUE(host,login,account_id)
) STRICT;
CREATE TABLE repositories(
  repository_id TEXT PRIMARY KEY, repository_database_id TEXT NOT NULL UNIQUE,
  current_version_hash TEXT NOT NULL, observed_at TEXT NOT NULL,
  FOREIGN KEY(repository_id,current_version_hash)
    REFERENCES repository_versions(repository_id,version_hash)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE repository_versions(
  repository_id TEXT NOT NULL,
  version_hash TEXT NOT NULL CHECK(length(version_hash)=64 AND version_hash NOT GLOB '*[^0-9a-f]*'),
  owner TEXT NOT NULL, name TEXT NOT NULL, full_name TEXT NOT NULL,
  description TEXT, url TEXT NOT NULL,
  stargazer_count INTEGER NOT NULL CHECK(stargazer_count>=0),
  is_fork INTEGER NOT NULL CHECK(is_fork IN(0,1)),
  is_archived INTEGER NOT NULL CHECK(is_archived IN(0,1)),
  is_disabled INTEGER NOT NULL CHECK(is_disabled IN(0,1)),
  is_private INTEGER NOT NULL CHECK(is_private IN(0,1)),
  visibility TEXT NOT NULL CHECK(visibility IN('public','private','internal')),
  primary_language TEXT,
  topics_json TEXT NOT NULL CHECK(json_valid(topics_json) AND json_type(topics_json)='array'),
  license_spdx_id TEXT, pushed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(repository_id,version_hash),
  FOREIGN KEY(repository_id) REFERENCES repositories(repository_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE snapshots(
  snapshot_id TEXT PRIMARY KEY,
  host TEXT NOT NULL, login TEXT NOT NULL, account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN('full','incremental')),
  status TEXT NOT NULL CHECK(status IN('building','complete','failed')),
  list_coverage TEXT NOT NULL CHECK(list_coverage IN('collecting','complete','unavailable','omitted')),
  lease_name TEXT NOT NULL, lease_owner_id TEXT NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT, failed_at TEXT,
  repositories_count INTEGER NOT NULL DEFAULT 0 CHECK(repositories_count>=0),
  stars_count INTEGER NOT NULL DEFAULT 0 CHECK(stars_count>=0),
  lists_count INTEGER NOT NULL DEFAULT 0 CHECK(lists_count>=0),
  memberships_count INTEGER NOT NULL DEFAULT 0 CHECK(memberships_count>=0),
  warning_count INTEGER NOT NULL DEFAULT 0 CHECK(warning_count>=0),
  source_rate_limit_json TEXT CHECK(source_rate_limit_json IS NULL OR json_valid(source_rate_limit_json)),
  UNIQUE(snapshot_id,host,login,account_id),
  FOREIGN KEY(host,login,account_id)
    REFERENCES accounts(host,login,account_id),
  CHECK(
    (status='building' AND completed_at IS NULL AND failed_at IS NULL) OR
    (status='complete' AND completed_at IS NOT NULL AND failed_at IS NULL) OR
    (status='failed' AND completed_at IS NULL AND failed_at IS NOT NULL)
  ),
  CHECK(
    (status IN('building','failed') AND list_coverage<>'complete') OR
    (status='complete' AND list_coverage<>'collecting')
  ),
  CHECK(list_coverage='complete' OR (lists_count=0 AND memberships_count=0))
) STRICT;
```

`snapshot_stars`, `user_lists`, `list_memberships`, and
`repository_evidence` use the prior primary keys plus exact composite foreign
keys; each is `STRICT`. `snapshot_stars` references the exact
`(repository_id,version_hash)` metadata version. A membership references both
the same-snapshot List and Star. The three-column account foreign key prevents
a snapshot from combining one account's stable ID with another account's
login on the same host; the two independent account uniques alone are not
treated as an exact binding.

Second-pass verification is stored separately, so remote page order cannot
change the result and no repository-sized set is retained in process memory:

```sql
CREATE TABLE snapshot_verifications(
  snapshot_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN('collecting','verified')),
  list_coverage TEXT NOT NULL
    CHECK(list_coverage IN('complete','unavailable','omitted')),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE snapshot_verification_stars(
  snapshot_id TEXT NOT NULL, repository_id TEXT NOT NULL, starred_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,repository_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshot_verifications(snapshot_id)
    ON DELETE CASCADE
) STRICT;
CREATE TABLE snapshot_verification_lists(
  snapshot_id TEXT NOT NULL, list_id TEXT NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
  is_private INTEGER NOT NULL CHECK(is_private IN(0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_added_at TEXT,
  PRIMARY KEY(snapshot_id,list_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshot_verifications(snapshot_id)
    ON DELETE CASCADE
) STRICT;
CREATE TABLE snapshot_verification_memberships(
  snapshot_id TEXT NOT NULL, list_id TEXT NOT NULL, repository_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,list_id,repository_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshot_verifications(snapshot_id)
    ON DELETE CASCADE
) STRICT;
```

Each verification insert is a strict insert: a duplicate primary key is
reported as `PRECONDITION_FAILED` with
`details.reason="collection_changed"`, not ignored. Publication checks all
three pairs with bidirectional `EXCEPT` over the complete normalized columns;
there is no hash-only or traversal-order comparison. The verification tables
have no public query path and are deleted atomically after successful
publication or when a draft is failed/recovered.

Plan tables are:

```sql
CREATE TABLE plans(
  plan_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN('ready','applying','applied','partial','expired','failed','superseded')),
  host TEXT NOT NULL, login TEXT NOT NULL, account_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  hash TEXT NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  executable_json TEXT NOT NULL CHECK(json_valid(executable_json)),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  caller_note TEXT,
  warnings_json TEXT NOT NULL CHECK(json_valid(warnings_json) AND json_type(warnings_json)='array'),
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json) AND json_type(summary_json)='object'),
  UNIQUE(plan_id,host,login,account_id),
  FOREIGN KEY(snapshot_id,host,login,account_id)
    REFERENCES snapshots(snapshot_id,host,login,account_id),
  CHECK(created_at<expires_at)
) STRICT;
CREATE TABLE plan_operations(
  plan_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  kind TEXT NOT NULL CHECK(kind IN('star','unstar','list_create','list_update','list_delete','list_membership_set')),
  operation_json TEXT NOT NULL CHECK(json_valid(operation_json)),
  PRIMARY KEY(plan_id,operation_id),
  UNIQUE(plan_id,sequence),
  UNIQUE(plan_id,operation_id,sequence),
  FOREIGN KEY(plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE plan_operation_dependencies(
  plan_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  depends_on_operation_id TEXT NOT NULL,
  PRIMARY KEY(plan_id,operation_id,depends_on_operation_id),
  FOREIGN KEY(plan_id,operation_id)
    REFERENCES plan_operations(plan_id,operation_id) ON DELETE CASCADE,
  FOREIGN KEY(plan_id,depends_on_operation_id)
    REFERENCES plan_operations(plan_id,operation_id) ON DELETE CASCADE,
  CHECK(operation_id<>depends_on_operation_id)
) STRICT;
```

Runs deliberately omit independently mutable `totals_json` and
`reconciliation_json`; all totals derive from operation rows. One immutable
plan has at most one run, and the database proves every run operation belongs
to an operation in that run's plan:

```sql
CREATE TABLE runs(
  run_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL, login TEXT NOT NULL, account_id TEXT NOT NULL,
  lease_name TEXT NOT NULL, lease_owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('pending','running','completed','partial','failed')),
  failure_mode TEXT NOT NULL CHECK(failure_mode IN('stop','continue')),
  warnings_json TEXT NOT NULL CHECK(json_valid(warnings_json) AND json_type(warnings_json)='array'),
  started_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE(run_id,plan_id),
  FOREIGN KEY(plan_id,host,login,account_id)
    REFERENCES plans(plan_id,host,login,account_id),
  CHECK(
    (state IN('pending','running') AND finished_at IS NULL) OR
    (state IN('completed','partial','failed') AND finished_at IS NOT NULL)
  ),
  CHECK(finished_at IS NULL OR finished_at>=started_at)
) STRICT;
CREATE TABLE run_operations(
  run_id TEXT NOT NULL, plan_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  status TEXT NOT NULL CHECK(status IN('pending','running','succeeded','skipped','failed','unresolved')),
  reconciliation TEXT NOT NULL CHECK(reconciliation IN('not_required','pending','confirmed_applied','confirmed_not_applied','unknown')),
  attempts INTEGER NOT NULL CHECK(attempts>=0),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  external_request_id TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  started_at TEXT, finished_at TEXT,
  PRIMARY KEY(run_id,operation_id), UNIQUE(run_id,sequence),
  FOREIGN KEY(run_id,plan_id) REFERENCES runs(run_id,plan_id) ON DELETE CASCADE,
  FOREIGN KEY(plan_id,operation_id,sequence)
    REFERENCES plan_operations(plan_id,operation_id,sequence),
  CHECK(
    (status='pending' AND reconciliation='not_required'
      AND started_at IS NULL AND finished_at IS NULL
      AND external_request_id IS NULL AND error_json IS NULL
      AND json_type(after_json)='null') OR
    (status='running' AND reconciliation='pending' AND attempts>=1
      AND started_at IS NOT NULL AND finished_at IS NULL
      AND external_request_id IS NULL AND error_json IS NULL
      AND json_type(after_json)='null') OR
    (status='skipped' AND reconciliation='not_required'
      AND started_at IS NULL AND finished_at IS NOT NULL
      AND external_request_id IS NULL AND error_json IS NULL
      AND json_type(after_json)='null') OR
    (status='succeeded' AND reconciliation IN('not_required','confirmed_applied')
      AND attempts>=1 AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_json IS NULL) OR
    (status='failed' AND reconciliation='confirmed_not_applied'
      AND finished_at IS NOT NULL AND error_json IS NOT NULL
      AND json_type(error_json,'$.retryable') IN('true','false')
      AND ((started_at IS NULL AND external_request_id IS NULL
            AND json_type(after_json)='null')
           OR (started_at IS NOT NULL AND attempts>=1))) OR
    (status='unresolved' AND reconciliation='unknown' AND attempts>=1
      AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_json IS NOT NULL
      AND json_type(error_json,'$.retryable')='false'
      AND json_extract(error_json,'$.retryable')=0)
  ),
  CHECK(finished_at IS NULL OR started_at IS NULL OR finished_at>=started_at)
) STRICT;
CREATE TABLE run_operation_attempts(
  run_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  status TEXT NOT NULL CHECK(status IN('running','succeeded','failed','unresolved')),
  reconciliation TEXT NOT NULL CHECK(reconciliation IN('not_required','pending','confirmed_applied','confirmed_not_applied','unknown')),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  external_request_id TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  started_at TEXT NOT NULL, finished_at TEXT,
  PRIMARY KEY(run_id,operation_id,attempt),
  FOREIGN KEY(run_id,operation_id)
    REFERENCES run_operations(run_id,operation_id) ON DELETE CASCADE,
  CHECK(
    (status='running' AND reconciliation='pending'
      AND finished_at IS NULL AND external_request_id IS NULL
      AND error_json IS NULL AND json_type(after_json)='null') OR
    (status='succeeded' AND reconciliation='not_required'
      AND finished_at IS NOT NULL AND error_json IS NULL) OR
    (status='failed' AND reconciliation='confirmed_not_applied'
      AND finished_at IS NOT NULL AND error_json IS NOT NULL
      AND json_type(error_json,'$.retryable') IN('true','false')) OR
    (status='unresolved' AND reconciliation='unknown'
      AND finished_at IS NOT NULL AND error_json IS NOT NULL
      AND json_type(error_json,'$.retryable')='false'
      AND json_extract(error_json,'$.retryable')=0)
  ),
  CHECK(finished_at IS NULL OR finished_at>=started_at)
) STRICT;
CREATE TABLE run_operation_reconciliations(
  run_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  event_sequence INTEGER NOT NULL CHECK(event_sequence>=1),
  status TEXT NOT NULL CHECK(status IN('succeeded','failed','unresolved')),
  reconciliation TEXT NOT NULL CHECK(reconciliation IN('confirmed_applied','confirmed_not_applied','unknown')),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(run_id,operation_id,event_sequence),
  FOREIGN KEY(run_id,operation_id,attempt)
    REFERENCES run_operation_attempts(run_id,operation_id,attempt)
    ON DELETE CASCADE,
  CHECK(
    (status='succeeded' AND reconciliation='confirmed_applied'
      AND error_json IS NULL) OR
    (status='failed' AND reconciliation='confirmed_not_applied'
      AND error_json IS NOT NULL
      AND json_type(error_json,'$.retryable')='true'
      AND json_extract(error_json,'$.retryable')=1) OR
    (status='unresolved' AND reconciliation='unknown'
      AND error_json IS NOT NULL
      AND json_type(error_json,'$.retryable')='false'
      AND json_extract(error_json,'$.retryable')=0)
  )
) STRICT;
```

The migration also installs relationship triggers. They preserve the allowed
recovery edge while making reconciliation/projection history inseparable:

```sql
CREATE TRIGGER run_operation_insert_requires_initial_projection
BEFORE INSERT ON run_operations
WHEN NEW.status<>'pending'
  OR NEW.reconciliation<>'not_required'
  OR NEW.attempts<>0
BEGIN
  SELECT RAISE(ABORT,'run operation must be inserted pending');
END;

CREATE TRIGGER reconciliation_requires_current_unresolved_attempt
BEFORE INSERT ON run_operation_reconciliations
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1
    FROM run_operations AS ro
    JOIN run_operation_attempts AS a
      ON a.run_id=ro.run_id
     AND a.operation_id=ro.operation_id
     AND a.attempt=ro.attempts
    WHERE ro.run_id=NEW.run_id
      AND ro.operation_id=NEW.operation_id
      AND ro.status='unresolved'
      AND ro.reconciliation='unknown'
      AND ro.attempts=NEW.attempt
      AND a.status='unresolved'
      AND a.reconciliation='unknown'
      AND a.finished_at IS NOT NULL
      AND NEW.observed_at>=a.finished_at
  ) THEN RAISE(ABORT,'reconciliation requires current unresolved attempt') END;
END;

CREATE TRIGGER reconciled_projection_requires_latest_event
BEFORE UPDATE OF status,reconciliation,after_json,error_json,finished_at
ON run_operations
WHEN OLD.status='unresolved' AND OLD.reconciliation='unknown'
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1
    FROM run_operation_reconciliations AS e
    WHERE e.run_id=NEW.run_id
      AND e.operation_id=NEW.operation_id
      AND e.attempt=NEW.attempts
      AND e.event_sequence=(
        SELECT MAX(e2.event_sequence)
        FROM run_operation_reconciliations AS e2
        WHERE e2.run_id=NEW.run_id AND e2.operation_id=NEW.operation_id
      )
      AND e.status=NEW.status
      AND e.reconciliation=NEW.reconciliation
      AND e.after_json=NEW.after_json
      AND (
        (e.error_json IS NULL AND NEW.error_json IS NULL) OR
        e.error_json=NEW.error_json
      )
  ) THEN RAISE(ABORT,'reconciled projection requires matching latest event') END;
END;

CREATE TRIGGER reconciliation_events_are_append_only_update
BEFORE UPDATE ON run_operation_reconciliations
BEGIN
  SELECT RAISE(ABORT,'reconciliation events are append-only');
END;
CREATE TRIGGER reconciliation_events_are_append_only_delete
BEFORE DELETE ON run_operation_reconciliations
BEGIN
  SELECT RAISE(ABORT,'reconciliation events are append-only');
END;
```

`reconcileRunOperation` inserts the event first and updates its projection
second inside one private repository transaction. Recovery may still change
`running/pending -> unresolved/unknown` without inventing an event because
the second trigger applies only when the old projection was already
unresolved. Direct `running/pending -> failed/confirmed_not_applied` outcomes
also remain legal without a reconciliation event. Raw-SQL negative integration
tests prove that an event for a historical/non-current attempt, an observation
before the ambiguous attempt finished, or an unresolved-projection rewrite
without its matching latest event is rejected and fully rolled back. They also
prove that a non-pending initial projection and any reconciliation-event
update/delete are rejected.

Indexes cover latest complete snapshot binding/time, recovery by stored lease,
snapshot Star pagination, List fixed order
`name COLLATE BINARY,list_id`, membership pagination in both directions, and
run/attempt sequence. Language aggregates return sorted
`{language:null|string,count}` rows, never dynamic object properties.

`openSqliteDatabase` rejects SQLite older than 3.38, non-UTF-8, or missing
JSON1, and applies/verifies `foreign_keys=ON`, `trusted_schema=OFF`,
`mmap_size=0`, `busy_timeout=5000`, `synchronous=FULL`, plus WAL for file
databases. `migrateSqliteDatabase` first enters `BEGIN IMMEDIATE`, then rereads
the ledger and accepts only a contiguous prefix of the binary's
LF-normalized `(version,name,sha256)` list. It rejects gaps, drift, and a
database newer than the binary before applying the next migration. Concurrent
first starts converge without duplicate or partially observed migrations.

`RuntimeSecretRepository.getOrCreateCursorSigningKey(createdAt)` enters its
own `BEGIN IMMEDIATE`, rereads/inserts exactly one 32-byte BLOB with a targeted
conflict clause, validates its type/length, and returns an exclusive defensive
copy. Startup copies it into `createCursorCodec`, wipes all temporary random
and database buffers, then constructs repositories; no port or diagnostic can
observe the key. SQLite methods reject use before the store reaches ready.

`createSnapshot` atomically validates the active lease and persists its
name/owner. `appendSnapshotBatch` accepts at most 100 of each remote collection
per call, validates the same active lease, and writes only a `building`
snapshot. Non-empty List/membership input requires stored coverage
`collecting`; unavailable/omitted snapshots reject it. It canonicalizes each Repository, hashes query-relevant metadata,
uses targeted conflict clauses, and on a hash/ID conflict compares exact
content instead of silently ignoring it. Repository node/database IDs are
immutable. The current metadata pointer advances only when
`(observed_at,version_hash)` is lexically newer; every snapshot query joins its
exact immutable version, never that pointer.

`beginSnapshotVerification` creates exactly one empty private verification
set for a building draft. Verification append methods enforce all per-array
bounds and canonical records with ordinary strict inserts, so a duplicate
remote identity fails instead of disappearing through conflict handling.
`finishSnapshotVerification` changes only `collecting -> verified`.

`completeSnapshot` requires that verified marker; uses bidirectional SQL
`EXCEPT` to prove exact, order-independent equality for Star identity/time,
all normalized List metadata columns, and membership relationships; runs
actual distinct row counts and List-coverage checks; proves the
stored/current exact-owner lease with `expires_at > lease.now`; publishes
`building -> complete`; and deletes the private verification rows inside one
`BEGIN IMMEDIATE`. It permits only stored
`collecting -> complete`, `unavailable -> unavailable`, or
`omitted -> omitted`; the latter two require zero List/membership rows. Any
mismatch rolls back and returns the stable
`PRECONDITION_FAILED/details.reason="collection_changed"` signal.
`failSnapshot` is likewise owner/lease guarded and clears verification rows in
its transaction. Recovery changes only building snapshots for which no
matching unexpired stored lease exists and also clears those rows.
Failed/building snapshots never satisfy queries.

All three query families require `snapshot.status='complete'`, authenticate
the exact cursor context, use only fixed SQL, fetch page size plus one, and
compute totals/aggregates independently of the cursor. Only List-dependent
repository filters, List summaries, and memberships additionally require
`listCoverage='complete'`; non-List repository filters work for final
unavailable/omitted coverage. List summaries never materialize members.
Membership order is the opposite-side stable ID in SQLite `BINARY` order.

Lease acquire uses one targeted
`INSERT ... ON CONFLICT(name) DO UPDATE ... WHERE leases.expires_at<=@now`;
there is deliberately no same-owner exception. Thus every active reacquire,
including the same owner ID, returns null. `renewLease` is a separate targeted
`UPDATE ... WHERE name=@name AND owner_id=@ownerId AND expires_at>@now` and
preserves `acquired_at`. Every input is canonical and requires
`expiresAt>now`. Wrong-owner renew/release raises `PRECONDITION_FAILED`, and
missing lease raises `NOT_FOUND`.

`prepareStateDirectory(path, platform)` requires an absolute local path. It
uses non-following `lstat` checks before and after creation/open, rejects
symlinks, reparse points, non-regular database/WAL/SHM files, Windows UNC
paths, and POSIX state owned by another UID. POSIX directories/files are
hardened to existing owner permissions only with no group/world bits
(`0700`/`0600` for new paths); existing missing owner permissions are not
invented. WAL/SHM are rechecked after SQLite creates them. Windows relies on
the user's inherited ACL and `--doctor` reports that limitation explicitly.

- [ ] **Step 4: Verify rollback, exact set publication, foreign keys, queries, and lease ownership**
Run `npm test -- test/integration/storage/snapshot.test.ts test/unit/domain/filter.test.ts && npm run typecheck && npm run lint`; expect all pass, including migration gaps/drift/newer-schema rejection, concurrent migration/key initialization, SQLite capability/pragma checks, orphan/composite-FK rejection, cross-account login/account-ID splice rejection, metadata collision and monotonic-pointer checks, mid-save rollback, exact reordered verification sets, every added/removed/changed verification element, active/same-owner/expired lease acquisition and takeover, lease-aware recovery, every List coverage state, two-direction membership pagination, duplicate-free cursor pages, authenticated-tamper rejection, WAL readers during one writer, secure-path rejection, and cursor continuity after database reopen.

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrations/001-initial.ts src/storage/migrations.ts src/storage/sqlite-database.ts src/storage/snapshot-repository.ts src/storage/lease-repository.ts src/storage/runtime-secret-repository.ts src/storage/state-directory.ts test/integration/storage/snapshot.test.ts
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
  store.acquireLease({name:"sync:fixture",ownerId:"seed",now:"2026-07-16T00:00:00.000Z",expiresAt:"2026-07-16T00:10:00.000Z"});
  const lease={name:"sync:fixture",ownerId:"seed",now:"2026-07-16T00:01:00.000Z"} as const;
  const snapshot=store.createSnapshot({draft:snapshotDraftFixture,lease});
  store.appendSnapshotBatch({id:snapshot.id,batch:snapshotBatchFixture,lease});
  store.beginSnapshotVerification({id:snapshot.id,listCoverage:"complete",lease});
  store.appendSnapshotVerificationBatch({
    id:snapshot.id,
    batch:{
      stars:snapshotBatchFixture.stars,
      lists:snapshotBatchFixture.lists,
      memberships:snapshotBatchFixture.memberships,
    },
    lease,
  });
  store.finishSnapshotVerification({id:snapshot.id,lease});
  store.completeSnapshot({id:snapshot.id,completedAt:"2026-07-16T00:02:00.000Z",listCoverage:"complete",counts:{repositories:1,stars:1,lists:1,memberships:1},warningCount:0,sourceRateLimit:null,lease});
  store.releaseLease({name:lease.name,ownerId:lease.ownerId});
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
  store.acquireLease({name:"apply:fixture",ownerId:"p1",now:"2026-07-16T02:55:00.000Z",expiresAt:"2026-07-16T03:05:00.000Z"});
  const lease={name:"apply:fixture",ownerId:"p1",now:"2026-07-16T02:59:00.000Z"} as const;
  store.withTransaction((tx)=>{tx.assertLease(lease);tx.compareAndSetPlanState({planId:changePlanFixture.id,expected:["ready"],next:"applying"});});
  store.createRun({run:changeRunFixture,lease});
  store.compareAndSetRunState({runId:changeRunFixture.id,expected:["pending"],next:"running",finishedAt:null,lease});
  store.createRunOperation({operation:{...runningOperationFixture,status:"pending",attempts:0,startedAt:null},lease});
  store.startRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,startedAt:"2026-07-16T02:59:00.000Z",lease});
  expect(store.recoverInterruptedRuns("2026-07-16T03:00:00.000Z")).toEqual([]);
  store.acquireLease({name:"apply:fixture",ownerId:"p2",now:"2026-07-16T03:06:00.000Z",expiresAt:"2026-07-16T03:16:00.000Z"});
  const resumed={name:"apply:fixture",ownerId:"p2",now:"2026-07-16T03:06:30.000Z"} as const;
  expect(store.recoverAbandonedRuns({binding:changeRunFixture.binding,lease:resumed})).toEqual([changeRunFixture.id]);
  expect(store.getRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId})?.status).toBe("unresolved");
  expect(store.listRunOperationAttemptsPage({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,afterAttempt:null,pageSize:10}).items[0]?.status).toBe("unresolved");
  expect(store.recoverInterruptedRuns("2026-07-16T03:07:00.000Z")).toEqual([]);
  store.compareAndSetPlanState({planId:changePlanFixture.id,expected:["partial"],next:"applying"});
  store.compareAndSetRunState({runId:changeRunFixture.id,expected:["partial"],next:"running",finishedAt:null,lease:{...resumed,now:"2026-07-16T03:07:00.000Z"}});
  store.reconcileRunOperation({
    runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,
    status:"failed",reconciliation:"confirmed_not_applied",
    after:null,lease:{...resumed,now:"2026-07-16T03:08:00.000Z"},
    error:{code:"RECONCILIATION_REQUIRED",message:"confirmed not applied",retryable:true,details:{}},
    observedAt:"2026-07-16T03:08:30.000Z",
  });
  expect(store.listRunOperationReconciliationsPage({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,afterEventSequence:null,pageSize:10}).items).toHaveLength(1);
  const queued=store.retryRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,maxAttempts:3,lease:{...resumed,now:"2026-07-16T03:08:45.000Z"}});
  expect([queued.status,queued.attempts]).toEqual(["pending",1]);
  const retried=store.startRunOperation({runId:changeRunFixture.id,operationId:runningOperationFixture.operationId,startedAt:"2026-07-16T03:09:00.000Z",lease:{...resumed,now:"2026-07-16T03:09:00.000Z"}});
  expect([retried.status,retried.attempts]).toEqual(["running",2]); store.close();
});
```

- [ ] **Step 2: Prove facade and plan repository are absent**
Run `npm test -- test/integration/storage/plan-run.test.ts`; expect FAIL resolving `src/storage/sqlite-store.ts`.

- [ ] **Step 3: Implement immutable persistence and recovery**

`savePlan` writes the plan plus normalized operation/dependency rows in one
transaction and derives `summary_json`; it first requires a complete source
snapshot and exact equality between snapshot binding and executable binding.
If any executable operation uses a List precondition/target, the source
snapshot must also have `listCoverage:"complete"`. `createRun` likewise
requires exact run-binding equality with the stored plan, an active exact
account lease, and no existing run for that plan.
Repeated identical ID/content is idempotent, while any differing field raises
`STORAGE_ERROR: plan_id is immutable`. Reads validate JSON through domain
schemas and return frozen copies. State claims use:

```sql
UPDATE plans SET state=@next
WHERE plan_id=@planId AND state IN(SELECT value FROM json_each(@expectedJson))
RETURNING *;
```

Before executing SQL, every claim validates the requested transition through
the domain transition function. No row means `NOT_FOUND` for missing ID or
`PRECONDITION_FAILED` for stale state. Runs use the same rule and enforce
finished-time invariants; partial resume atomically replaces the stored run
lease binding with the newly validated guard. `createRun` persists its immutable, redacted
warning strings in `runs.warnings_json`; every load and resume returns the same
warnings. `createRunOperation` validates the plan operation/sequence and
inserts a `pending`, attempt-zero write-ahead row before waiting in the
mutation pacer; an identical duplicate is idempotent only while its lifecycle
is still initial.

`startRunOperation` is the sole active-lease `pending→running` CAS. In the same
transaction it proves the run/plan are running/applying, increments attempts,
and inserts the corresponding running `run_operation_attempts` row immediately
before transport dispatch. `finishRunOperation` never accepts caller
before/attempts; it applies the discriminated legal outcome and finalizes the
current attempt plus projection atomically. Pending-before-dispatch
skipped/failed rows create no attempt.
`reconcileRunOperation` is a separate CAS accepting only an `unresolved`
record and writing `succeeded`/`confirmed_applied`,
`failed`/`confirmed_not_applied`, or `unresolved`/`unknown`; it preserves
attempts, original before/start/request ID and the unresolved attempt's
original finish time, appends a reconciliation event, updates the projection
atomically, and never makes a succeeded row mutable.
`retryRunOperation` accepts only
`failed/confirmed_not_applied/error.retryable` within `maxAttempts`; it never
accepts unresolved/unknown, never deletes attempts or reconciliation events,
and resets only the projection fields defined by Task 6.

Crash recovery takes `BEGIN IMMEDIATE`, first materializes only pending/running
runs for which no lease row matches the stored name/owner with
`expires_at>@now`, and then updates only that fixed set. Pending operation rows
become retryable failed/confirmed-not-applied without an attempt; running
attempts and projections become unresolved/unknown; affected runs and owning
applying plans become partial. Recovery finalizes a running attempt once at
the recovery time but does not invent a reconciliation event. Another
process's active exact-owner run is left untouched.

`recoverAbandonedRuns({binding,lease})` uses the same transaction after first
asserting the caller's newly acquired active apply lease and restricting the
fixed candidate set to that binding. `recoverAbandonedSnapshots` does the
equivalent under the new sync lease. Global startup methods use no caller lease
but retain the exact-owner-active exclusion.

The pending recovery error is `INTERNAL_ERROR`, retryable, and states that no
dispatch occurred; running rows remain ambiguous and must reconcile before
retry. Recovery covers an interrupted run even when it has zero operation
rows, transitions its owning applying plan to partial, returns affected branded
run IDs in lexical order, and is idempotent. Tests simulate a crash before
dispatch, during dispatch, and after a successful response but before audit
completion. `recoverIncompleteSnapshots` similarly changes each abandoned
building snapshot once while skipping an exact-owner unexpired lease. All
operation/attempt/reconciliation page methods validate size 1–100, order by
their fixed sequence, fetch one extra, and emit a next boundary only when more
rows exist.

`SQLiteStore` owns one connection and is unusable until `migrate()` completes
this exact composition:

```text
secure state path -> open/verify SQLite -> migrate under BEGIN IMMEDIATE
-> get/create cursor key under BEGIN IMMEDIATE -> exclusive key copy
-> createCursorCodec -> wipe temporary buffers -> construct repositories
-> mark ready
```

It delegates every port method, makes `close` idempotent, and implements
`withTransaction` through an immediate transaction plus the same
recognizable-exotic rejection, detached recursively frozen canonical return
channel, final poison check, and revocable-facade semantics as the memory
store. Nested transactions and root-store reentry (including migrate/close)
are rejected while the callback is active. Callback writes roll back before
an async result can escape; no transaction crosses `await`.

- [ ] **Step 4: Run complete foundation and reopen verification**
Run `npm test -- test/unit test/integration/storage && npm run test:coverage && npm run format:check && npm run lint && npm run typecheck && npm run build && git diff --check`; expect full success, coverage gates, and reopen tests proving one-time lease-aware recovery, one run per plan, attempt-history continuity, cursor continuity, transactional thenable rollback, no hash/before-state changes, timestamp-order CHECK rejection, initial-projection INSERT rejection, current-attempt-only reconciliation, matching-event projection updates, and append-only reconciliation events through raw SQL negative cases.

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

Expected: shrinkwrap is unchanged; verification passes; schema smoke exits 0; tarball excludes source, tests, databases, tokens, and environment files; working tree is clean. The Plan 04 startup composition must call `migrate()` (which also initializes the private cursor codec), `recoverIncompleteSnapshots(now)`, then `recoverInterruptedRuns(now)` before accepting MCP calls; both recovery calls skip exact-owner active leases. Specification coverage is explicit across Tasks 1–8: toolchain, IDs, records, List coverage and bounded memberships, errors, redaction, config, filters, authenticated SQL/cursors, canonical hash, plan/run graph and state, synchronous/revocable `StoragePort`, strict/checksummed migrations, secure state files, atomic leases, immutable plans, per-dispatch attempts, and lease-aware crash recovery.
