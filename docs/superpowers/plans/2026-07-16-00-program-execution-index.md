# GitHub Stars MCP Program Execution Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate the five implementation plans that deliver the approved GitHub Stars MCP Version 1 specification as one verified open-source release candidate.

**Architecture:** Work proceeds from pure domain contracts to adapters and services, then MCP/CLI/plugin packaging, and finally release evidence. Each subsystem plan produces testable commits; no plan may bypass the shared ports, official API allowlist, immutable plan/apply workflow, or default read-only gate.

**Tech Stack:** TypeScript 7.0.2, Node.js 22/24, ESM, MCP SDK 1.29.0, Zod v4, Octokit 5.0.5, `better-sqlite3`, Vitest v4, npm, GitHub Actions.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-07-16-github-stars-mcp-design.md`.
- Product: generic local stdio MCP server; the Codex plugin is optional distribution metadata.
- Public surface: exactly nine MCP tools.
- GitHub writes: Star and User List operations only, always through immutable plan plus expected hash.
- Forbidden capabilities: repository deletion, archive, transfer, rename, visibility changes, or contents changes.
- Credentials: environment or `gh auth token`; never returned, logged, or persisted.
- Storage: local SQLite through `SQLiteStore`, WAL, foreign keys, migrations, leases.
- Mutation pacing: serial, at least 1,000 ms between GitHub writes.
- Runtime: Node 22 and 24 on Windows, macOS, and Linux.
- Release: Apache-2.0, verified tarball, plugin, SBOM, checksums, provenance-ready manual publication.

## Plan Set and Dependency Order

| Order | Plan | Independently testable result | Depends on |
|---:|---|---|---|
| 1 | `2026-07-16-01-foundation-domain-storage.md` | Compiling domain, filters, plan/run model, and crash-safe SQLite store | Approved spec |
| 2 | `2026-07-16-02-github-read-sync-query.md` | Authenticated official-API reads, complete snapshots, queries, evidence, and discovery | Plan 01 ports/types |
| 3 | `2026-07-16-03-change-plan-apply-rollback.md` | Immutable plans, safe Star/List apply, audit, resume, reconciliation, and rollback plans | Plans 01 and 02 |
| 4 | `2026-07-16-04-mcp-cli-codex-plugin.md` | Nine MCP tools, stdio CLI, doctor, Inspector gate, and Codex plugin | Plans 01 through 03 |
| 5 | `2026-07-16-05-documentation-ci-release.md` | Complete docs, CI, package matrices, assets, SBOM, and release evidence | Plans 01 through 04 |

Plans 01 and 02 may begin in parallel after the foundation package task fixes compiler and test commands. Plan 03 may implement pure planner tests while Plan 02 completes, but its GitHub mutation adapter work waits for the final `GitHubPort`. Plan 04 may build envelope/schema tests against fake services while application services finish. Plan 05 documentation and governance can run early; package, generated reference, asset, and release gates run after Plan 04.

## Locked Cross-Plan Interfaces

| Path | Required exports |
|---|---|
| `src/domain/ids.ts` | `RepositoryId`, `RepositoryDatabaseId`, `UserListId`, `SnapshotId`, `PlanId`, `RunId`, validated constructors, request-ID generator |
| `src/domain/repository.ts` | normalized `Repository`, `StarRecord`, `UserList`, `ListMembership` |
| `src/domain/filter.ts` | recursive `FilterExpression`, validation, evaluation, SQL compilation, stable sort/cursor contract |
| `src/domain/plan.ts` | `PlanRequest`, `ResolvedOperation`, `ChangePlan`, dependency graph, canonical executable payload |
| `src/domain/run.ts` | `ChangeRun`, `RunOperation`, lifecycle transitions, reconciliation status |
| `src/app/ports/github-port.ts` | `Page<T>` and named allowlisted reads/Star/List mutations; no generic request method |
| `src/app/ports/storage-port.ts` | migration, snapshot, query, plan, run, lease, transaction, and close operations |
| `src/storage/sqlite-store.ts` | `SQLiteStore implements StoragePort` |
| `src/app/services/service-registry.ts` | status, sync, query, Lists query, discovery, plan, inspect, apply, rollback services |
| `src/app/services/plan-service.ts` | `PlanService.create` |
| `src/app/services/inspect-service.ts` | `InspectService.inspect` |
| `src/app/services/apply-service.ts` | `ApplyService.apply` |
| `src/app/services/rollback-service.ts` | `RollbackService.createRollback` |

`repository_id` always means the GraphQL node ID. `repository_database_id` always means the REST numeric ID encoded as decimal text. `list_id` always means a GraphQL User List node ID. Mutation identity never uses names or slugs.

## Requirement Coverage Routing

| Requirement family or specification section | Primary plan/tasks | Secondary verification |
|---|---|---|
| AUTH-01 through AUTH-08 | Plan 02 credential/capability tasks | Plans 04 doctor and 05 security docs |
| SYNC-01 through SYNC-09 | Plan 02 Star/List sync tasks | Plan 01 snapshot store |
| QUERY-01 through QUERY-09 | Plan 01 filter/cursor task; Plan 02 query/evidence tasks | Plan 04 MCP schemas |
| LIST-01 through LIST-08 | Plan 02 List reads; Plan 03 List plan/apply/rollback tasks | Plan 05 live-contract evidence |
| PLAN-01 through PLAN-11 | Plan 01 canonical model; Plan 03 planner tasks | Plan 04 plan tool contract |
| APPLY-01 through APPLY-11 | Plan 03 apply/reconcile/resume tasks | Plan 04 apply schema; Plan 05 requirement ledger |
| UNDO-01 through UNDO-07 | Plan 03 rollback tasks | Plan 05 rollback documentation |
| DISCOVER-01 through DISCOVER-06 | Plan 02 discovery task | Plan 04 discovery tool contract |
| OPS-01 through OPS-06 | Plan 04 CLI/doctor/stdio tasks | Plan 05 package smoke matrix |
| PLUGIN-01 through PLUGIN-05 | Plan 04 plugin tasks | Plan 05 assets and release consistency |
| Architecture/data/security/error/performance/config | Plans 01 through 04 | Plan 05 docs and evidence matrix |
| Testing/CI/release/docs/SEO | Plan 05 | All subsystem test suites |
| Version 1 acceptance criteria | All plans | `npm run verify` and `npm run verify:requirements` |

## Execution and Review Strategy

The user explicitly prioritized speed and authorized autonomous execution. Use option 1 unless the user overrides it:

1. **Subagent-Driven (selected):** use `superpowers:subagent-driven-development`; assign a fresh implementation agent per task, then run specification review and code-quality review before accepting the task.
2. **Inline Execution:** use `superpowers:executing-plans`; execute tasks in ordered batches with review checkpoints.

At most one agent edits a given production file at a time. Parallel agents may work only on disjoint tasks with frozen interfaces. The coordinating agent owns dependency updates, shared port changes, migrations, `package.json`, and final integration.

## Commit and PR Boundaries

- Each numbered task ends with the focused commit named in its plan.
- Never combine a mutation-allowlist change with unrelated refactoring.
- Push checkpoint branches after each subsystem's focused suite passes.
- Open one implementation PR from `agent/implementation` to `main`; keep it draft until full verification.
- Review generated files, lockfile/shrinkwrap changes, workflow permissions, and packed contents explicitly.
- Merge only after local verification and GitHub Actions are green.

## Global Verification Commands

Run focused tests after every task, then these gates at subsystem boundaries:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run docs:check
npm run plugin:validate
npm run package:verify
npm run verify:requirements
```

Release-candidate verification additionally runs:

```bash
npm run smoke:mcp
npm run smoke:codex-plugin
npm run release:verify -- --prepare-only
npm sbom --sbom-format cyclonedx > artifacts/github-stars-mcp.cdx.json
```

The maintainer-only disposable-account live contract is separate from pull-request CI. It must record List-delete/Star and unstar/List-membership behavior, restore its fixtures, and never use the maintainer's normal Star collection.

## Completion Evidence

The project is complete only when all statements are evidenced, not merely intended:

- All five plan documents have every checkbox satisfied or superseded by a documented equivalent.
- All 80 requirement IDs map to existing implementation and executable verification paths.
- The full local gate and Node/OS package matrix pass.
- The MCP Inspector and real Codex plugin smoke tests list exactly nine tools.
- The adapter source and security tests prove the forbidden GitHub capabilities do not exist.
- The package tarball contains only allowlisted runtime, plugin, license, and documentation files.
- The release-preparation run produces checksums, SBOM, requirement JSON, and provenance-ready metadata without publishing by default.
- The implementation PR is reviewed, CI-green, merged to `main`, and the repository working tree is clean.
