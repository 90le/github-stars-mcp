# GitHub Stars MCP

GitHub Stars MCP gives an AI agent a local, structured interface for finding,
auditing, classifying, starring, and unstarring GitHub repositories. It also
manages GitHub User Lists. The server uses official GitHub APIs, communicates
with an MCP host over stdio, and stores snapshots and audit records in local
SQLite.

This package is an MCP server for AI hosts such as Codex, Claude, and Cursor.
It is not an interactive Stars CLI for a person to drive command by command.
Its nine tools expose no generic REST, GraphQL, browser, or shell access.

> GitHub Stars MCP cannot delete, archive, transfer, rename, change the
> visibility of, or modify the contents of a code repository. Unstarring a
> repository only removes it from the authenticated user's Stars.

## Install and connect

GitHub Stars MCP supports Node.js 22 and 24 on Windows, macOS, and Linux.
Version 1 supports GitHub.com.

Authenticate with the GitHub CLI if you do not supply a token:

```bash
gh auth login --hostname github.com
gh auth status --hostname github.com
```

Check the local runtime, configuration, authentication, and GitHub
capabilities:

```bash
npx -y github-stars-mcp@1.0.0 --doctor
```

Add the server to an MCP host. Host configuration formats differ, but a
standard JSON configuration looks like this:

```json
{
  "mcpServers": {
    "github-stars-mcp": {
      "command": "npx",
      "args": ["-y", "github-stars-mcp@1.0.0", "--stdio"],
      "env": {
        "GITHUB_STARS_MCP_AUTH_MODE": "auto",
        "GITHUB_STARS_MCP_READ_ONLY": "true",
        "GITHUB_STARS_MCP_LOG_LEVEL": "warning"
      }
    }
  }
}
```

Keep `GITHUB_STARS_MCP_READ_ONLY=true` while an agent syncs, queries, plans,
or inspects. To execute an authorized plan, set it to `false` in the MCP
server process and restart that process. The switch enables the apply code
path; it does not replace authorization for a specific inspected plan.

The server reserves stdout for MCP JSON-RPC. It sends logs and diagnostics to
stderr. A wrapper that prints a banner to stdout will break the stdio
connection.

## Authentication and permissions

The default `auto` mode checks credentials in this order:

1. `GITHUB_STARS_TOKEN`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `gh auth token --hostname github.com`

Set `GITHUB_STARS_MCP_AUTH_MODE=env` to disable the GitHub CLI fallback. Set
it to `gh` to use only the authenticated GitHub CLI.

Use a dedicated credential with only the account permissions required to
read or change Stars and User Lists. The server needs no repository
administration, contents-write, workflow-write, organization-administration,
or repository-deletion permission. Optional README evidence reads content
already visible to the credential; use `evidence: "none"` if that read is
outside the intended scope. GitHub's public-preview User List behavior does
not have a complete fine-grained token permission map, so
`github_stars_status` reports Star read, Star write, List read, and List write
capabilities separately as `available`, `unavailable`, or `unknown`.

Status also returns the authenticated login, credential source name, latest
complete snapshot, incomplete runs, database schema version, and rate-limit
state. It does not return the token. It also does not return the process
`GITHUB_STARS_MCP_READ_ONLY` setting; verify that value in the MCP host
configuration.

The process keeps the selected credential in memory, redacts it from errors,
and never writes it to SQLite or logs.

## The nine tools

| Tool                           | Purpose                                                      | Changes GitHub |
| ------------------------------ | ------------------------------------------------------------ | -------------- |
| `github_stars_status`          | Read identity, capabilities, local state, and rate limits    | No             |
| `github_stars_sync`            | Publish a complete logical snapshot                          | No             |
| `github_stars_query`           | Filter, sort, aggregate, and page through snapshot Stars     | No             |
| `github_lists_query`           | Read List metadata or membership pages                       | No             |
| `github_changes_plan`          | Resolve requested operations into an immutable plan          | No             |
| `github_changes_inspect`       | Inspect a plan, run, attempt history, or reconciliation      | No             |
| `github_changes_apply`         | Apply one authorized immutable plan                          | Yes            |
| `github_changes_rollback`      | Create a compensating plan from a completed or partial run   | No             |
| `github_repositories_discover` | Search GitHub for bounded repository candidates and evidence | No             |

`github_changes_apply` is the only tool that can call a GitHub mutation
endpoint. Planning, rollback creation, synchronization, queries, and
inspection can write local state but cannot change GitHub.

## Sync, query, Lists, and discovery

Run `github_stars_sync` before a collection-wide decision if no current
snapshot exists. A full sync refreshes repository metadata. An incremental
sync can reuse metadata that remains within `metadata_max_age_hours`, but it
still publishes a complete logical Star snapshot. `include_lists` defaults to
`true`. If the account cannot read Lists or the caller omits them, the
snapshot records `unavailable` or `omitted` List coverage instead of claiming
an empty complete List collection.

Star queries use a local immutable snapshot. They return at most 100 items per
page and at most 20 evidence records. Follow `next_cursor` until it is null.
The public repository fields use snake case. Important aliases include
`name_with_owner`, `stargazers_count`, `language`, `license`, `archived`,
`disabled`, and `fork`.

For example, this query finds low-popularity repositories with no recent
push, then asks for a bounded projection:

```text
github_stars_query
  where:
    all:
      - field: "stargazers_count"
        op: "lt"
        value: 10000
      - field: "pushed_at"
        op: "before"
        value:
          ago:
            amount: 3
            unit: "years"
  sort:
    - field: "stargazers_count"
      direction: "desc"
  limit: 50
  fields:
    - "repository_id"
    - "name_with_owner"
    - "stargazers_count"
    - "language"
    - "license"
    - "archived"
    - "disabled"
    - "fork"
    - "pushed_at"
  evidence: "none"
  evidence_limit: 0
```

Filters also accept `ne` as the public inequality operator. An `is_null`
leaf has no `value`. Relative time values apply only to `before` and `after`;
an equality comparison needs an absolute UTC timestamp.

`github_lists_query` has two modes. `lists` accepts no List or repository
selector. `memberships` requires exactly one `list_id` or `repository_id`.
List queries require a snapshot with complete List coverage and return no
more than 100 rows per page.

`github_repositories_discover` searches GitHub without starring a result.
Each request returns no more than 100 candidates and 20 evidence records.
GitHub search exposes at most the first 1,000 results, and the tool reports
both the GitHub total and the capped total. A discovered candidate becomes a
Star only after an agent creates, inspects, and applies a plan.

## Safe change workflow

An agent must plan and inspect before it can apply. The following fictional
values show the public input contract:

```text
1. github_changes_plan
   snapshot_id: "snap_demo_20260718"
   operations:
     - kind: "unstar"
       repositories:
         repository_ids: ["R_demo_obsolete"]
   protected_repository_ids: ["R_demo_keep"]
   protected_list_ids: []

2. github_changes_inspect
   kind: "plan"
   id: "plan_demo_cleanup"
   limit: 100

3. github_changes_apply
   plan_id: "plan_demo_cleanup"
   expected_hash: "<plan_hash>"
   failure_mode: "stop"
```

`github_changes_plan` returns `plan_id` and `plan_hash`.
`github_changes_inspect` returns the same fields in its plan metadata. Copy
that exact `plan_hash` into the apply input's `expected_hash`; never invent,
shorten, or reuse a value from another plan.

The planner accepts `star`, `unstar`, `list_create`, `list_update`,
`list_delete`, `list_membership_set`, `list_membership_add`, and
`list_membership_remove` operations. A Star or membership operation selects
repositories through `repositories: { repository_ids: [...] }` or
`repositories: { where: ... }`. The planner resolves filter selectors to
stable IDs, honors `protected_repository_ids` and `protected_list_ids`,
orders dependencies, and stores no more than 5,000 resolved operations.

Apply rechecks the stored hash, expiry, authenticated account, capabilities,
stable remote identities, and operation preconditions. It acquires an
account lease, writes an audit row before each dispatch, and waits at least
one second between GitHub writes. A replay of a completed plan returns its
existing run. An interrupted or ambiguous write triggers a remote readback;
the service never retries while the remote state remains unknown.

Write authorization should name the inspected `plan_id` and `plan_hash`.
Changing `GITHUB_STARS_MCP_READ_ONLY` to `false`, or asking for general
automation, does not authorize an unseen plan.

## Inspect and audit

`github_changes_inspect` uses one strict root object for four branches:

```text
kind: "plan"
id: "plan_demo_cleanup"
limit: 100

kind: "run"
id: "run_demo_cleanup"
limit: 100

kind: "attempts"
id: "run_demo_cleanup"
operation_id: "op_demo_unstar"
limit: 100

kind: "reconciliations"
id: "run_demo_cleanup"
operation_id: "op_demo_unstar"
limit: 100
```

Only `attempts` and `reconciliations` accept `operation_id`. All branches can
accept a matching opaque `cursor`; follow the returned `next_cursor` until it
is null. Run inspection exposes partial failures and unresolved outcomes
without raw headers, response bodies, stack traces, or credentials.

## Rollback limits

`github_changes_rollback` reads the successful rows of a completed or partial
run and creates another immutable plan. It makes no GitHub request. Inspect
that compensating plan, obtain authorization for its exact `plan_id` and
`plan_hash`, then apply it through the same workflow.

Rollback compensates for supported state changes; it cannot reproduce GitHub
history. Re-starring a repository creates a new `starred_at` timestamp.
Recreating a deleted User List creates a new List ID. The resulting audit
records these losses. If a remote outcome remains unknown, create a new plan
only after inspection establishes current state.

## Configuration

| Variable                                | Default            | Meaning                                          |
| --------------------------------------- | ------------------ | ------------------------------------------------ |
| `GITHUB_HOST`                           | `github.com`       | Version 1 accepts only `github.com`              |
| `GITHUB_STARS_MCP_AUTH_MODE`            | `auto`             | `auto`, `env`, or `gh`                           |
| `GITHUB_STARS_MCP_DATA_DIR`             | OS state directory | Absolute path for SQLite and local state         |
| `GITHUB_STARS_MCP_LOG_LEVEL`            | `warning`          | `debug`, `info`, `warning`, or `error` on stderr |
| `GITHUB_STARS_MCP_READ_ONLY`            | `true`             | Blocks `github_changes_apply` when true          |
| `GITHUB_STARS_MCP_MAX_READ_CONCURRENCY` | `4`                | Read concurrency from 1 through 8                |
| `GITHUB_STARS_MCP_WRITE_INTERVAL_MS`    | `1000`             | Minimum interval between GitHub mutations        |
| `GITHUB_STARS_MCP_MAX_PLAN_ACTIONS`     | `5000`             | Maximum resolved operations in one plan          |
| `GITHUB_STARS_MCP_PLAN_TTL_MINUTES`     | `1440`             | Plan lifetime, up to 10080 minutes               |

## Documentation

- [Architecture](docs/architecture.md)
- [MCP tool reference](docs/tool-reference.md)
- [Requirements](docs/requirements.md)
- [Security model](docs/security.md)
- [Codex plugin](docs/plugin.md)
- [Development](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
