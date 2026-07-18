# Requirements

This index connects the public product contract to acceptance evidence.
The approved design specification assigns stable identifiers to each
requirement. Tests, package checks, and release evidence use the same family
names.

## AUTH: identity and credentials

AUTH requirements define the `auto`, `env`, and `gh` credential modes,
credential precedence, GitHub.com host restriction, exact viewer binding,
credential redaction, and capability probing. Acceptance requires tests that
prove the process does not persist or print a token and rejects a plan created
for another account.

## SYNC: complete local snapshots

SYNC requirements cover full and incremental synchronization, exhaustive
pagination, stable repository identity, optional User Lists, atomic
publication, cache freshness, cancellation, and rate-limit behavior.
Acceptance requires fixture-backed multi-page runs and rollback after an
invalid page.

## QUERY and LIST: bounded local reads

QUERY requirements define strict filter trees, allowed fields, stable sort
orders, signed opaque cursors, page limits, and optional bounded enrichment.
LIST requirements cover List metadata, membership views, exact IDs, and
snapshot consistency. Acceptance rejects stale or tampered cursors and proves
that page traversal returns each matching record once.

The public repository contract uses `name_with_owner`, `stargazers_count`,
`language`, `license`, `archived`, `disabled`, and `fork`. It does not expose
the corresponding internal domain field names. Page size stays between 1 and
100, and one query returns no more than 20 evidence records.

## DISCOVER: repository search

DISCOVER requirements define bounded GitHub search, allowlisted sort and
qualifier inputs, minimum evidence, source links, private-result handling,
and rate-limit reporting. Discovery never stars a result. An agent must
create a plan to add a Star.

## PLAN: immutable proposed changes

PLAN requirements cover selector resolution, protected targets, exact before
and after state, dependency ordering, deduplication, action ceilings, expiry,
canonical serialization, SHA-256 hashing, account binding, and caller notes.
Acceptance proves that planning performs no GitHub mutation and that a stored
plan cannot change after creation.

The public plan root uses `operations`. Star and membership operations nest
an ID or filter selector under `repositories`. Plan output and plan inspection
return `plan_hash`.

## INSPECT: plans and durable run evidence

INSPECT requirements define four strict branches. `plan` accepts a plan ID;
`run` accepts a run ID; `attempts` and `reconciliations` accept a run ID and
an operation ID. All branches use bounded pages and target-bound cursors.
Acceptance rejects branch-specific fields on the wrong branch.

## APPLY: guarded mutation and audit

APPLY requirements define read-only startup and require `plan_id`,
`expected_hash`, and a `stop` or `continue` failure mode. The caller copies
the plan result's `plan_hash` into `expected_hash`. Apply also checks the
current viewer, capabilities, plan expiry, a global account lease,
preconditions, and stable remote identities. Mutation pacing, write-ahead
rows, one transport dispatch per attempt, idempotent replay, cancellation,
bounded output, and partial-run reconciliation complete the contract.
Acceptance injects process resets and lease loss at each dispatch boundary.
The service must preserve confirmed success and must not retry an unknown
outcome.

The only allowed remote writes are star, unstar, User List creation, User List
metadata update, User List deletion, and complete User List membership
replacement. APPLY cannot delete a code repository or modify its contents.

## UNDO: compensating plans

UNDO requirements define rollback as plan creation from the successful rows
of a completed or partial source run. The rollback service reverses
dependencies, preserves protected targets, records unavoidable information
loss, and makes no network call. A caller applies the returned plan through
`github_changes_apply`.

GitHub assigns a new `starred_at` timestamp when a repository is re-starred.
GitHub assigns a new ID when the tool recreates a deleted User List. Tests and
documentation must state both limits.

## OPS: runtime and operations

OPS requirements cover Node.js 22 and 24, Windows/macOS/Linux, stdio protocol
cleanliness, `--doctor`, `--version`, `--help`, stderr logging, configuration
validation, SQLite migration, owner-only state permissions where the platform
supports them, and zero telemetry. GitHub.com is the supported version 1 host.

## PLUGIN: Codex packaging

PLUGIN requirements define an optional Codex plugin with a valid manifest,
one MCP server declaration, safe workflow instructions, no bundled credential
or local state, and package contents derived from the source manifest.
Acceptance installs the packed plugin into an isolated home and verifies the
listed server command.

## Acceptance links

[The approved design](superpowers/specs/2026-07-16-github-stars-mcp-design.md)
records the product rationale and requirement IDs. The current MCP schemas,
mappers, and contract tests define the executable public contract.
[The program execution index](superpowers/plans/2026-07-16-00-program-execution-index.md)
records the staged implementation plan. Contract, security, package, and
live-read tests use these family names.

No acceptance row may rely on a live mutation in pull-request CI. Live
contracts use read-only credentials unless a maintainer starts a separate,
explicitly authorized mutation run.
