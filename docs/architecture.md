# Architecture

GitHub Stars MCP gives an AI host nine named operations over a local stdio
server. The process converts public snake-case inputs into application
requests, applies domain rules, and calls narrow GitHub and storage ports.
No layer receives a generic HTTP request, GraphQL document, shell command, or
repository administration client.

## Boundaries

The MCP layer registers the exact tool allowlist:
`github_stars_status`, `github_stars_sync`, `github_stars_query`,
`github_lists_query`, `github_repositories_discover`,
`github_changes_plan`, `github_changes_inspect`, `github_changes_apply`, and
`github_changes_rollback`.

Strict schemas reject unknown fields and bound strings, page sizes, selector
depth, result fields, and operation counts. Tool handlers map inputs into
application DTOs and return a versioned result envelope. They convert domain
errors into sanitized error codes; raw exceptions stay inside the process.
The public schemas use snake-case GitHub terms such as `name_with_owner`,
`stargazers_count`, `language`, `license`, `archived`, `disabled`, and
`fork`. Mappers translate those aliases into domain names. Domain field names
do not leak into MCP inputs or outputs.

Application services depend on `GitHubPort`, `StoragePort`, a clock, and a
runtime ID source. The production GitHub adapter implements named reads and
six Star or List mutation methods. Compile-time and source-boundary tests
reject added methods, generic request access, admin clients, or unapproved
exports.

## GitHub API mapping

The adapter uses GitHub's official REST API for viewer, Star, repository, and
rate-limit operations. It uses GitHub's supported GraphQL fields for User List
metadata and membership operations where GitHub exposes no stable REST
equivalent. The adapter validates returned repository database IDs and List
IDs before it accepts state as evidence.

Only `github_changes_apply` reaches mutation methods. The mutation allowlist
covers star, unstar, List creation, List metadata update, List deletion, and
complete List membership replacement. There is no endpoint for repository
deletion, content changes, visibility changes, archival, transfer, or rename.

## SQLite model

The server stores local private metadata in SQLite under
`GITHUB_STARS_MCP_DATA_DIR` or the operating system's application-state
directory. Tables cover:

- authenticated account binding and immutable snapshots;
- repositories, Stars, User Lists, and memberships for each snapshot;
- immutable plans and canonical operation content;
- apply runs, per-operation write-ahead rows, reconciliation state, and
  leases;
- bounded metadata cache and internal schema migrations.

The process configures transactional writes and foreign keys. Snapshot
publication occurs after all pages validate, so queries do not see a half
written snapshot. Plans store a canonical content hash. Runs refer to one plan
and retain successful rows across partial failure.

Tokens never enter SQLite. Repository descriptions, private repository names,
List names, caller notes, and audit details can be sensitive; protect the data
directory like a private source checkout.

## Sync and query flow

`github_stars_sync` authenticates the viewer, pages all Stars, optionally
pages User Lists and memberships, validates stable identities, then publishes
one immutable snapshot. An incremental request can reuse fresh repository
metadata, but the published snapshot still represents a complete logical
view.

`github_stars_query` evaluates a bounded filter tree against a named snapshot.
It sorts by stable fields and returns an opaque signed cursor.
`github_lists_query` reads List and membership records from that snapshot.
`github_repositories_discover` performs bounded GitHub search and returns
source evidence without adding a Star. Star and List queries return at most
100 rows per page. Discovery follows GitHub's 1,000-result search cap, and
query or discovery evidence never exceeds 20 records per call.

## Plan and apply flow

`github_changes_plan` resolves selectors against one snapshot, protects
caller-designated targets, computes exact before and after state, orders
dependencies, and stores immutable canonical content. Planning never calls a
GitHub mutation.

`github_changes_inspect` has four branches. `plan` uses a plan ID. `run` uses
a run ID. `attempts` and `reconciliations` use a run ID plus an operation ID.
Each branch accepts a limit and a cursor for the same target.

Planning and plan inspection return `plan_hash`. An agent passes that value
as `expected_hash` to `github_changes_apply`. Apply checks the input shape,
stored and recomputed hash, plan account, current viewer, capabilities,
expiry, and account lease before it claims a run.

Each remote operation follows this order:

1. Re-read stable remote preconditions.
2. Persist a pending audit row.
3. Persist an attempt and mark it as running.
4. Call one named mutation without transport retries.
5. Persist sanitized before, after, request ID, and outcome.

The lease heartbeat and minimum write interval prevent two local processes
from sending overlapping account mutations. A completed plan replay returns
the original bounded run result.

## Recovery and rollback flow

An interrupted or ambiguous operation enters reconciliation. The service uses
operation-specific reads to classify current state as
`confirmed_applied`, `confirmed_not_applied`, or `unknown`. It retries only a
proved-before state and records each retry as another durable attempt. It
never retries an unknown remote state.

`github_changes_rollback` reads successful rows from a completed or partial
run and projects them into a dependency-safe compensating plan. The service
does not need a GitHub client and performs no network call. The caller uses
the same inspect and apply sequence for that new plan. Re-starring creates a
new timestamp, and recreating a List creates a new ID.

## Process and protocol

The CLI supports `--stdio`, `--doctor`, `--version`, and `--help`. Stdio is the
default. The server writes only JSON-RPC to stdout and sends logs to stderr.
`--doctor` checks Node, configuration, data-directory access, authentication,
network reads, and capabilities without changing GitHub. The status tool
returns identity, capabilities, snapshot state, incomplete runs, and rate
limits. It does not echo the process read-only configuration.
