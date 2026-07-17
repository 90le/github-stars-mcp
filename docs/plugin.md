# Codex plugin

The optional Codex plugin packages the local GitHub Stars MCP server and
instructions for agent-safe operation. The plugin adds no cloud relay and
contains no credential. Codex starts the same stdio executable described in
the project README.

## Install from the repository

Clone or download the repository, build it with Node.js 22 or 24, then install
the plugin directory exposed by the repository marketplace manifest:

```bash
git clone https://github.com/90le/github-stars-mcp.git
cd github-stars-mcp
npm ci
npm run build
```

Use Codex plugin management to install `plugins/github-stars-mcp` from this
checkout. The plugin manifest points at the packaged server command; it does
not run a browser automation script or read browser cookies.

## Install from a marketplace

Add the repository's `.agents/plugins/marketplace.json` as a marketplace
source, select `github-stars-mcp`, and inspect the requested MCP server command
before installation. Published plugin and npm package versions match. Reject
an installation if the plugin contains a token, database, `.env` file, log,
browser profile, or extra runtime module outside the source-derived manifest.

## Forward environment

Codex must pass configuration into the local server process. Start with:

```text
GITHUB_STARS_MCP_AUTH_MODE=auto
GITHUB_STARS_MCP_READ_ONLY=true
GITHUB_STARS_MCP_LOG_LEVEL=warning
```

Set credentials in the operating system or authenticate `gh` for
`github.com`. Do not paste a token into plugin instructions, `config.toml`,
task text, or a repository file. If the host supports an environment allowlist,
forward only the documented `GITHUB_STARS_MCP_*`, `GITHUB_HOST`, and selected
credential variable.

## Agent workflow

Ask the agent to call `github_stars_status` first. The result identifies the
account, read-only state, List capability, last snapshot, and rate limit
without printing credentials. Sync before planning if the snapshot is absent
or stale.

For any Star removal, List deletion, metadata change, or membership change,
require this sequence:

```text
1. github_changes_plan
   snapshot_id: "snap_demo_plugin"
   requests:
     - kind: "list_delete"
       list_ids: ["L_demo_unused"]

2. github_changes_inspect
   plan_id: "plan_demo_plugin_cleanup"

3. github_changes_apply
   plan_id: "plan_demo_plugin_cleanup"
   expected_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
   failure_mode: "stop"
```

These IDs and the hash are fictional. In a real session, the agent must reuse
the exact returned values. Keep write mode disabled until the inspected plan
matches the requested scope. After apply, call `github_changes_inspect` with
the returned run ID and page through the audit until `next_cursor` is null.

## Rollback workflow

Call `github_changes_rollback` with a completed or partial source run. The
tool creates a compensating plan and makes no GitHub change. Inspect and apply
that new plan through the same three-step workflow. Recreated Lists receive
new IDs, and re-starred repositories receive new Star timestamps.

## Isolation and updates

The package verifier installs the plugin into an isolated Codex home and
checks the manifest, executable, assets, and exact packed runtime tree. Update
the plugin and npm package together. Run plugin validation and `--doctor`
after an update; keep write mode disabled until status and a read-only query
succeed.
