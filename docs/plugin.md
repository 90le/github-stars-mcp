# Codex plugin

The optional Codex plugin connects Codex to the local GitHub Stars MCP stdio
server and supplies instructions for agent-safe use. It contains no cloud
relay, credential, browser automation, or business-logic copy. Codex launches
the same npm executable described in the project README.

## Install from the repository

Clone the project and build it with Node.js 22 or 24:

```bash
git clone https://github.com/90le/github-stars-mcp.git
cd github-stars-mcp
npm ci
npm run build
```

Use Codex plugin management to install `plugins/github-stars-mcp` from that
checkout. The repository marketplace manifest points to the same plural
path. The plugin manifest at
`plugins/github-stars-mcp/.codex-plugin/plugin.json` references one MCP
server definition, its skill, and its fixed brand assets.

You can also add `.agents/plugins/marketplace.json` as a marketplace source
and select `github-stars-mcp`. Inspect the requested stdio command before
installation. Reject a package that contains a token, database, `.env` file,
log, browser profile, or runtime file outside the source-derived manifest.

## Authentication and forwarded environment

The plugin's `.mcp.json` launches:

```text
npx -y github-stars-mcp@1.0.0 --stdio
```

Codex must forward the chosen credential source and server configuration.
Start with:

```text
GITHUB_STARS_MCP_AUTH_MODE=auto
GITHUB_STARS_MCP_READ_ONLY=true
GITHUB_STARS_MCP_LOG_LEVEL=warning
```

Authenticate `gh` for `github.com` or set one supported credential variable
in the operating system. Do not paste a token into plugin instructions,
`config.toml`, a task, or a repository file. If Codex uses an environment
allowlist, forward only the documented `GITHUB_STARS_MCP_*`, `GITHUB_HOST`,
and selected credential variable.

Use the smallest GitHub account permission set that supports the requested
Star or User List operation. The plugin needs no repository administration,
contents-write, workflow-write, or organization-administration permission.
Optional README evidence reads content already visible to the credential.
The plugin never reads browser cookies or asks for a browser-session
credential.

## Agent workflow

Call `github_stars_status` first. Status returns the authenticated account,
credential source name, Star and List capabilities, latest complete snapshot,
incomplete runs, and rate-limit state. It does not return the process
`GITHUB_STARS_MCP_READ_ONLY` value, so confirm that switch in the Codex MCP
configuration.

Sync before making a collection-wide decision if no current snapshot exists.
Use `github_stars_query`, `github_lists_query`, and
`github_repositories_discover` for bounded reads. The plugin exposes the same
strict nine-tool surface as the server and provides no generic REST, GraphQL,
browser, shell, filesystem, or repository-administration fallback.

For any Star removal, List deletion, metadata change, or membership change,
use an immutable plan:

```text
1. github_changes_plan
   snapshot_id: "snap_demo_plugin"
   operations:
     - kind: "list_delete"
       list_ids: ["L_demo_unused"]
   protected_repository_ids: []
   protected_list_ids: ["L_demo_keep"]

2. github_changes_inspect
   kind: "plan"
   id: "plan_demo_plugin_cleanup"
   limit: 100

3. github_changes_apply
   plan_id: "plan_demo_plugin_cleanup"
   expected_hash: "<plan_hash>"
   failure_mode: "stop"
```

The values are fictional. Copy the actual `plan_id` and `plan_hash` returned
by plan or plan inspection. Pass that `plan_hash` as `expected_hash`. Enable
write mode only after the inspected operations match the authorized scope;
write mode alone does not authorize a plan.

After apply, inspect the run with `kind: "run"` and its returned `run_id`.
Inspect an operation's durable attempts with `kind: "attempts"`, the run ID,
and `operation_id`. Use `kind: "reconciliations"` with the same identifiers
for readback history. Follow every `next_cursor` to null and report partial
failures or unknown outcomes.

## Rollback

Call `github_changes_rollback` with a completed or partial source `run_id`.
The tool creates a compensating plan and makes no GitHub change. Inspect that
new plan and obtain authorization for its exact `plan_id` and `plan_hash`
before apply.

Rollback cannot restore GitHub history. A recreated List receives a new ID,
and a re-starred repository receives a new `starred_at` timestamp.

## Validation and updates

The package verifier installs the plugin into an isolated Codex home and
checks the manifest, executable, assets, and packed runtime tree. Update the
plugin and npm package together. Run plugin validation and `--doctor` after
an update. Keep write mode disabled until authentication, capability status,
sync, and a bounded query succeed.
