# Troubleshooting

Run `npx -y github-stars-mcp@1.0.0 --doctor` first. Doctor checks the runtime,
configuration, data directory, GitHub CLI, credential source, GitHub network
reads, rate limit, and Star List capability without changing GitHub. It
redacts credentials and writes diagnostics outside the MCP stdout stream.

## Authentication fails

Check the GitHub CLI account:

```bash
gh auth status --hostname github.com
gh auth login --hostname github.com
```

The default `auto` mode tries `GITHUB_STARS_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`,
then `gh auth token --hostname github.com`. An invalid earlier environment
credential can hide a valid CLI login. Remove it or select
`GITHUB_STARS_MCP_AUTH_MODE=gh`. Use `env` when the process must not invoke
`gh`.

Version 1 accepts only `GITHUB_HOST=github.com`. GitHub Enterprise Server URLs
fail configuration validation.

## Token permissions and Lists

A classic or fine-grained token can authenticate successfully while User List
capability remains unavailable. GitHub's List API support and permission
model can differ from Star access. Call `github_stars_status` and read the
capability result. The server blocks List planning or apply when it cannot
prove the required capability.

Do not broaden a token to repository administration permissions. GitHub Stars
MCP does not use them. Create a new least-privilege token when an existing
credential's history or scope is uncertain.

## Read-only apply error

The server defaults to `GITHUB_STARS_MCP_READ_ONLY=true`. Keep this value for
sync, query, discovery, planning, inspection, and rollback creation. Set it to
`false` in the MCP server process only after you inspect the plan. Restart the
server so it loads the new configuration.

`github_stars_status` does not echo the read-only switch. Check the MCP host's
server environment when apply returns `CAPABILITY_UNAVAILABLE` with
`reason: "read_only"`.

Apply still requires the exact `expected_hash`, current account binding,
capability, unexpired plan, remote preconditions, and account lease. Copy the
plan or plan-inspection output's `plan_hash` into `expected_hash`. Enabling
write mode bypasses none of those checks.

## Rate limits

`RATE_LIMITED` includes the known reset time. Wait until that time before
starting another large sync or discovery request. `SECONDARY_RATE_LIMITED`
signals GitHub abuse protection; reduce activity and respect the retry
information. Increasing
`GITHUB_STARS_MCP_MAX_READ_CONCURRENCY` above the default can trigger limits
sooner and cannot exceed 8.

Writes use at least `GITHUB_STARS_MCP_WRITE_INTERVAL_MS=1000`. The server
does not perform hidden transport retries for mutations. It records an
ambiguous response and reconciles with a read before a visible new attempt.

## `better-sqlite3` installation fails

Use Node.js 22 or 24 with the package's supported architecture. Delete no
project state while diagnosing an install. Run `npm ci` in a clean checkout.
If npm cannot download a prebuilt binary, install the compiler and Python
requirements documented by `node-gyp` for your platform, then retry.

The runtime database belongs under `GITHUB_STARS_MCP_DATA_DIR`; it does not
belong in `node_modules`. Set that variable to an absolute writable path. A
relative path fails configuration validation.

## Database or lease errors

Stop duplicate server processes that use the same account and data directory.
The global account lease prevents overlapping mutation sessions. A crashed
process leaves durable audit state. After the lease expires, a later process
reconciles uncertain rows before it resumes the same run.

Do not edit SQLite rows to clear a lease or mark an operation successful.
Keep a copy of the database and inspect the run through
`github_changes_inspect` with `kind: "run"` and the run ID in `id`. Inspect
one operation with `kind: "attempts"` or `kind: "reconciliations"`, the same
run ID in `id`, and its `operation_id`. A `RECONCILIATION_REQUIRED` outcome
means the server could not prove remote state. Resolve it through supported
inspection and a fresh plan.

## Stdio protocol errors

The MCP server reserves stdout for JSON-RPC. Configure wrappers, package
managers, debuggers, and shell profiles so they print no banner to stdout.
Logs use stderr. Set `GITHUB_STARS_MCP_LOG_LEVEL=debug` for a local
reproduction, then return it to `warning` because logs can reveal repository
metadata even though token values are redacted.

Confirm the host command uses `--stdio` or no CLI mode flag. Run `--help` and
`--version` in a terminal as separate processes; those modes are not MCP
sessions.

## Stale plan or snapshot

`STALE_SNAPSHOT` asks for a new `github_stars_sync` before planning.
`PLAN_EXPIRED` requires a new plan. `PLAN_HASH_MISMATCH` means the supplied
`expected_hash` does not match stored canonical content. Inspect the plan and
copy its returned `plan_hash` into `expected_hash`; do not reuse a hash from
another task or account.

`PLAN_ACCOUNT_MISMATCH` means the current GitHub viewer differs from the
account that owns the snapshot and plan. Switch back to the correct account
or sync and create a new plan for the current viewer.
