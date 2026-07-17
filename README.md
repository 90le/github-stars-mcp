# GitHub Stars MCP

Give AI agents a fast, structured, and auditable way to discover, organize,
star, and unstar GitHub repositories. GitHub Stars MCP runs locally over
stdio, uses official GitHub APIs, and requires an immutable plan before any
GitHub write.

> GitHub Stars MCP cannot delete, archive, transfer, rename, change the
> visibility of, or modify the contents of a code repository. Its GitHub
> mutation adapter exposes only Star and Star List operations.

## Quick start

```bash
npx -y github-stars-mcp@1.0.0 --doctor
```

The server starts with `GITHUB_STARS_MCP_READ_ONLY=true`. Set
`GITHUB_STARS_MCP_READ_ONLY=false` only when you want an authorized agent to
apply a plan you have inspected.

Run the MCP server over stdio:

```bash
npx -y github-stars-mcp@1.0.0 --stdio
```

GitHub Stars MCP supports Node.js 22 and 24 on Windows, macOS, and Linux.
GitHub.com is the supported host for version 1.

## Why use it

GitHub's web interface works well for individual Stars. An agent needs a
bounded API, stable identifiers, pagination, and a record of each write.
GitHub Stars MCP supplies those controls without exposing a generic REST,
GraphQL, shell, or repository-administration tool.

The server keeps snapshots, plans, and run audits in a local SQLite database.
It does not send telemetry. It does not store GitHub tokens in the database.

## Nine tools

| Tool                           | Purpose                                                          | Changes GitHub |
| ------------------------------ | ---------------------------------------------------------------- | -------------- |
| `github_stars_status`          | Check authentication, capabilities, local state, and rate limits | No             |
| `github_stars_sync`            | Create a complete or incremental local snapshot                  | No             |
| `github_stars_query`           | Filter, sort, and page through snapshot Stars                    | No             |
| `github_lists_query`           | Read List metadata and memberships                               | No             |
| `github_repositories_discover` | Search GitHub repositories with bounded evidence                 | No             |
| `github_changes_plan`          | Resolve requested actions into an immutable plan                 | No             |
| `github_changes_inspect`       | Inspect a plan or apply run with paginated audit rows            | No             |
| `github_changes_apply`         | Apply an inspected plan under a global account lease             | Yes            |
| `github_changes_rollback`      | Create a compensating plan for a completed or partial run        | No             |

Only `github_changes_apply` can call a GitHub mutation endpoint. Planning,
inspection, rollback creation, synchronization, and queries do not mutate
GitHub.

## Authentication

The default `auto` mode checks credentials in this order:

1. `GITHUB_STARS_TOKEN`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `gh auth token --hostname github.com`

Set `GITHUB_STARS_MCP_AUTH_MODE=env` to disable the GitHub CLI fallback or
`GITHUB_STARS_MCP_AUTH_MODE=gh` to use only the authenticated GitHub CLI.
The server passes the credential to the official API client in memory,
redacts it from errors, and does not write it to SQLite or logs.

Run `gh auth status --hostname github.com` if `--doctor` reports no usable
credential. Fine-grained token support for Star Lists depends on GitHub's
preview capability for the authenticated account. `github_stars_status`
reports unavailable or uncertain capabilities without attempting a write.

## Safe write workflow

An agent must create, inspect, and apply the same immutable plan. The apply
call requires the SHA-256 hash returned by the plan call.

```text
1. github_changes_plan
   snapshot_id: "snap_demo_20260717"
   requests:
     - kind: "unstar"
       repository_ids: ["R_demo_obsolete"]

2. github_changes_inspect
   plan_id: "plan_demo_cleanup"

3. github_changes_apply
   plan_id: "plan_demo_cleanup"
   expected_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
   failure_mode: "stop"
```

The IDs and hash above are fictional. A real agent must copy the returned
`plan_id` and `hash`; it must not invent them.

Apply verifies the stored plan content, hash, expiry, authenticated account,
capability set, and repository or List preconditions. It acquires one account
lease, records a durable operation row before dispatch, and paces mutations.
Replaying a completed plan returns its existing run. A process interruption
causes readback reconciliation before any retry.

Use `protected_repository_ids` and `protected_list_ids` in plan or rollback
requests for targets that an agent must preserve. Keep `failure_mode` at
`stop` unless independent operations should continue after one failure.

## Rollback limits

`github_changes_rollback` creates another immutable plan. It does not call
GitHub. Inspect the returned plan, then pass it to `github_changes_apply` with
its returned hash.

A compensating plan can star a repository again, but GitHub assigns a new
`starred_at` value. It can recreate a deleted List, but GitHub assigns a new
List ID. The audit explains these losses. The tool never claims byte-for-byte
restoration of remote history.

## Configuration

| Variable                                | Default            | Meaning                                          |
| --------------------------------------- | ------------------ | ------------------------------------------------ |
| `GITHUB_HOST`                           | `github.com`       | Version 1 accepts only `github.com`              |
| `GITHUB_STARS_MCP_AUTH_MODE`            | `auto`             | `auto`, `env`, or `gh`                           |
| `GITHUB_STARS_MCP_DATA_DIR`             | OS state directory | Absolute path for SQLite and local state         |
| `GITHUB_STARS_MCP_LOG_LEVEL`            | `warning`          | `debug`, `info`, `warning`, or `error` on stderr |
| `GITHUB_STARS_MCP_READ_ONLY`            | `true`             | Blocks `github_changes_apply` when true          |
| `GITHUB_STARS_MCP_MAX_READ_CONCURRENCY` | `4`                | Read concurrency from 1 through 8                |
| `GITHUB_STARS_MCP_WRITE_INTERVAL_MS`    | `1000`             | Minimum interval between mutations               |
| `GITHUB_STARS_MCP_MAX_PLAN_ACTIONS`     | `5000`             | Maximum operations in one plan                   |
| `GITHUB_STARS_MCP_PLAN_TTL_MINUTES`     | `1440`             | Plan lifetime, up to 10080 minutes               |

The server reserves stdout for MCP JSON-RPC. Logs and diagnostics go to
stderr. Do not wrap stdio mode in a command that writes banners to stdout.

## Documentation

- [Architecture](docs/architecture.md)
- [Requirements](docs/requirements.md)
- [Security model](docs/security.md)
- [Codex plugin](docs/plugin.md)
- [Development](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)
- [MCP tool reference](docs/tool-reference.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
