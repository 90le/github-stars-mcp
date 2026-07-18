# GitHub Stars MCP

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/90le/github-stars-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/90le/github-stars-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/90le/github-stars-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/90le/github-stars-mcp/actions/workflows/codeql.yml)
[![Node.js 22 and 24](https://img.shields.io/badge/node-22%20%7C%2024-339933)](https://nodejs.org/)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

An AI-native MCP server for discovering, organizing, and safely maintaining GitHub Stars and User Lists through official GitHub APIs.

It gives Codex, Claude, Cursor, and other MCP hosts a bounded tool surface over local SQLite snapshots. It is designed for AI agents, not browser automation or manual command-by-command operation.

## What it does

- Syncs a complete, auditable snapshot of Stars and User Lists.
- Searches and filters repositories by stars, language, license, activity, archive state, fork status, and more.
- Discovers new repositories without starring them automatically.
- Creates, updates, deletes, and populates GitHub User Lists.
- Stars or unstars repositories through an explicit, hash-bound change plan.
- Records runs, attempts, failures, remote readbacks, and compensating rollback plans.

## The nine MCP tools

| Tool                           | Purpose                                                    | GitHub mutation |
| ------------------------------ | ---------------------------------------------------------- | --------------- |
| `github_stars_status`          | Identity, capabilities, local state, and rate limits       | No              |
| `github_stars_sync`            | Publish a complete Stars/Lists snapshot                    | No              |
| `github_stars_query`           | Filter, sort, aggregate, and page Stars                    | No              |
| `github_lists_query`           | Read List metadata and memberships                         | No              |
| `github_repositories_discover` | Find bounded repository candidates and evidence            | No              |
| `github_changes_plan`          | Resolve requested changes into an immutable plan           | No              |
| `github_changes_inspect`       | Inspect plans, runs, attempts, and reconciliation          | No              |
| `github_changes_apply`         | Apply one inspected and authorized plan                    | Yes             |
| `github_changes_rollback`      | Create a compensating plan from a completed or partial run | No              |

## Safe by design

Mutation follows one path:

```text
sync → plan → inspect → authorize → apply → audit
```

The server defaults to read-only mode. Every write plan has a stable ID and SHA-256 hash, protected repository/List IDs, expiry, preconditions, bounded operation count, ordered dependencies, and resumable audit records. Ambiguous writes are read back from GitHub before any retry.

Only `github_changes_apply` can call a GitHub mutation endpoint. Tokens remain in memory, are redacted from errors, and are never stored in SQLite or logs.

## Install

GitHub Stars MCP supports Node.js 22 and 24 on Windows, macOS, and Linux. Version 1 supports GitHub.com.

Authenticate with GitHub CLI:

```bash
gh auth login --hostname github.com
gh auth status --hostname github.com
```

Check the local runtime and capabilities:

```bash
npx -y github-stars-mcp@1.0.0 --doctor
```

Connect it to an MCP host:

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

Keep `GITHUB_STARS_MCP_READ_ONLY=true` while an agent synchronizes, queries, plans, or inspects. Set it to `false` only in the MCP process that is authorized to apply an already inspected plan.

Credentials are selected in this order: `GITHUB_STARS_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token --hostname github.com`. Use a dedicated credential with only the Star and User List permissions required by the account.

`github_stars_status` reports identity, capabilities, snapshots, runs, schema, and rate limits, but does not return the process `GITHUB_STARS_MCP_READ_ONLY` setting. Verify that setting in the MCP host configuration.

Queries expose stable public fields such as `name_with_owner`, `stargazers_count`, `language`, `license`, `archived`, `disabled`, and `fork`.

## Example agent workflow

An agent can safely handle a cleanup request such as “find repositories with fewer than 10,000 stars and no push in three years, protect these repositories, and prepare a reviewable cleanup plan” by:

1. Calling `github_stars_sync`.
2. Calling `github_stars_query` with bounded filters and evidence.
3. Calling `github_changes_plan` with protected IDs.
4. Calling `github_changes_inspect` and presenting the exact plan hash.
5. Calling `github_changes_apply` only after explicit authorization.
6. Calling `github_changes_inspect` again to report results or generate rollback.

Discovery never stars a result by itself. A discovered repository becomes a Star only through the same plan and authorization flow.

The public change contract uses `operations`, stable repository IDs, and an exact plan hash:

```text
github_changes_plan
  snapshot_id: "snap_demo_20260718"
  operations:
    - kind: "unstar"
      repositories:
        repository_ids: ["R_demo_obsolete"]
  protected_repository_ids: ["R_demo_keep"]

github_changes_inspect
  kind: "plan"
  id: "plan_demo_cleanup"

github_changes_apply
  plan_id: "plan_demo_cleanup"
  expected_hash: "<plan_hash>"
```

`github_changes_inspect` supports four branches:

```text
kind: "plan"
kind: "run"
kind: "attempts"
operation_id: "op_demo_unstar"
kind: "reconciliations"
operation_id: "op_demo_unstar"
```

Copy the exact `plan_hash` returned by inspection into `expected_hash`; never invent or shorten it.

Key configuration variables are `GITHUB_STARS_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_HOST`, `GITHUB_STARS_MCP_DATA_DIR`, `GITHUB_STARS_MCP_READ_ONLY`, `GITHUB_STARS_MCP_AUTH_MODE`, `GITHUB_STARS_MCP_LOG_LEVEL`, `GITHUB_STARS_MCP_MAX_READ_CONCURRENCY`, `GITHUB_STARS_MCP_WRITE_INTERVAL_MS`, `GITHUB_STARS_MCP_MAX_PLAN_ACTIONS`, and `GITHUB_STARS_MCP_PLAN_TTL_MINUTES`.

## Boundaries

This project can manage the authenticated user’s Stars and User Lists. It cannot delete, archive, transfer, rename, change visibility of, or modify the contents of a code repository. It provides no generic REST, GraphQL, browser, or shell access, and does not provide repository-administration or organization-management access.

## Documentation

- [Architecture](docs/architecture.md)
- [MCP tool reference](docs/tool-reference.md)
- [Security model](docs/security.md)
- [Codex plugin](docs/plugin.md)
- [Development and release](docs/development.md)
- [Requirements and verification matrix](docs/requirements.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
