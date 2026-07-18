# Discovery Candidate Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist repositories returned by discovery so they can immediately enter the existing audited Star/List plan flow, and expose bounded candidate status.

**Architecture:** Reuse the existing global `repositories`/`repository_versions` metadata store used by the planner, add an account-scoped `discovery_candidates` table for lifecycle and provenance, and add one read-only MCP candidate query tool. Discovery writes only local state; GitHub mutation remains plan/apply-only.

**Tech Stack:** TypeScript, better-sqlite3 migrations, MCP tool schemas, Vitest contract/unit tests.

## Global Constraints

- Keep completed Star snapshot counts unchanged by discovery.
- Preserve explicit plan hash inspection and read-only apply safeguards.
- Candidate reads are account-bound and paginated.
- Existing tool schemas and plan behavior remain backward compatible.

---

### Task 1: Add candidate persistence schema and storage port

**Files:**
- Modify: `src/storage/migrations/001-initial.ts` or add the next migration under `src/storage/migrations/`
- Modify: `src/app/ports/storage-port.ts`
- Modify: `src/storage/snapshot-repository.ts`
- Test: `test/integration/storage/candidate-repository.test.ts`

- [ ] Write a failing test that saves a discovered repository, reads it through `getRepositoryMetadata`, and verifies the Star snapshot counts remain unchanged.
- [ ] Add the candidate table with account binding, repository ID, query provenance, lifecycle state, first/last discovered timestamps, and uniqueness constraints.
- [ ] Add `saveDiscoveredCandidate` and `queryDiscoveryCandidates` to the storage port and implementation; persist repository/version metadata using the existing immutable hash rules.
- [ ] Run the focused integration test and migration checks.

### Task 2: Persist discovery results

**Files:**
- Modify: `src/app/services/discovery-service.ts`
- Modify: `src/server.ts`
- Test: `test/unit/services/discovery-service.test.ts`

- [ ] Add a failing unit test proving discovery calls candidate persistence for every returned repository and preserves `alreadyStarred`.
- [ ] Extend the discovery storage dependency with the persistence method and call it after validating each remote repository.
- [ ] Keep failures fail-closed: a storage identity/hash conflict must return a storage/precondition error rather than silently dropping a candidate.
- [ ] Run the discovery unit test.

### Task 3: Expose candidate query MCP tool

**Files:**
- Modify: `src/mcp/schemas/read-tools.ts`
- Modify: `src/mcp/schemas/output.ts`
- Modify: `src/mcp/register-read-tools.ts`
- Modify: `src/mcp/mappers.ts`
- Modify: `src/mcp/output-mappers.ts`
- Test: `test/contract/mcp/candidate-tools.test.ts`

- [ ] Write failing contract tests for tool registration, bounded pagination, account binding, and stable candidate fields.
- [ ] Implement `github_repositories_candidates` with optional state/query filters and limit/cursor bounds.
- [ ] Add exact output schemas and mapper coverage; update generated tool reference checks.
- [ ] Run the focused MCP contract tests.

### Task 4: Verify candidate-backed plans

**Files:**
- Modify: `test/contract/mcp/change-tools.test.ts`
- Modify: `test/unit/services/operation-resolver.test.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/tool-reference.md` if generated output requires it

- [ ] Add a failing plan test using a discovered repository ID that is not in the Star snapshot and assert a valid `star` operation is resolved.
- [ ] Add a failing negative test for an unknown candidate ID.
- [ ] Confirm existing snapshot-backed planning tests remain unchanged.
- [ ] Document the workflow: discover → candidates → plan → inspect → apply → sync.
- [ ] Run focused tests, formatting, docs checks, and full `npm run verify:all`.

### Task 5: Commit and local handoff

**Files:**
- Modify: all files above

- [ ] Review `git diff --check` and `git status --short`.
- [ ] Commit with `feat: bridge discovered repositories into plans`.
- [ ] Report commit, tests, and any remaining CI-only verification.
