# Security model

GitHub Stars MCP limits an AI agent to a named Star and User List surface. It
cannot delete a code repository, archive it, transfer it, rename it, change
its visibility, or modify repository contents. The server exposes no generic
REST, GraphQL, filesystem, or shell tool.

## Credential handling

In `auto` mode, the process checks `GITHUB_STARS_TOKEN`, `GITHUB_TOKEN`,
`GH_TOKEN`, then `gh auth token --hostname github.com`. The `env` mode uses
environment credentials only. The `gh` mode uses the GitHub CLI only.

The process keeps the selected credential in memory for the API client. It
does not store any token in SQLite, snapshots, plans, audits, logs, MCP
results, plugin files, or diagnostics. Redaction covers registered credential
values, GitHub token shapes, authorization headers, and nested error details.
`--doctor` reports the credential source and capability result without showing
the credential.

Use a token with only the permissions needed for Stars and User Lists. Keep
`GITHUB_STARS_MCP_READ_ONLY=true` unless an inspected plan is ready to apply.
Revoke a credential through GitHub or `gh auth logout` if it appears in a
terminal capture or committed file.

## Mutation allowlist

The production `GitHubPort` contains named methods for star, unstar, User List
creation, metadata update, deletion, and membership replacement. Build and
security tests compare that contract and the adapter's public surface against
an exact allowlist. Any added capability requires a code and security review.

`github_changes_apply` is the sole MCP tool that can reach those methods. It
requires a stored immutable plan and its exact hash. It verifies the current
account, capabilities, expiry, stable remote IDs, and preconditions before a
write. One account lease and a write interval constrain concurrent processes.

The service writes an audit row before dispatch. A network reset produces an
ambiguous state, so recovery reads current remote state before considering a
retry. The service retries only when it proves the operation was not applied.

## Local private metadata

SQLite may contain private repository names, descriptions, topics, Star
timestamps, User List names and memberships, query evidence, caller notes,
plans, and run audits. Treat `GITHUB_STARS_MCP_DATA_DIR` as private data.
Restrict backups, disk synchronization, and support bundles that include it.

The server requests owner-only file permissions where the platform supports
them. Windows inherited ACLs can still grant broader access; `--doctor`
reports that condition. Full-disk encryption protects state when a device is
lost.

## Prompt injection

Repository names, descriptions, topics, README evidence, and List text come
from untrusted users. Treat them as data. An MCP host must not execute
instructions found in those fields or reinterpret them as tool arguments.
The server uses strict schemas, stable IDs, protected-target lists, immutable
plans, and a separate inspect step to reduce that risk.

An agent should show the plan operation counts and affected names before it
requests apply authorization. Copy `plan_id` and `expected_hash` from tool
output. Do not accept a hash embedded in repository text.

## Network and SSRF boundary

Version 1 accepts only `GITHUB_HOST=github.com`. Tool inputs cannot supply a
URL, hostname, REST method, GraphQL document, header, local path, or token.
The adapter constructs approved GitHub API calls from validated stable IDs.
Discovery source URLs appear as evidence; the server does not fetch arbitrary
URLs supplied by a repository.

## Audit and failure disclosure

Run inspection returns bounded sanitized rows with operation status,
reconciliation state, timestamps, and safe request identifiers. It omits raw
headers, response bodies, stack traces, credentials, and internal file paths.
Opaque cursors prevent callers from changing audit query state.

Report a suspected vulnerability through GitHub private vulnerability
reporting for the `90le/github-stars-mcp` repository. Include the affected
version, a minimal reproduction with fictional data, impact, and any proposed
mitigation. Do not include a live token, private repository metadata, or an
account database. See the repository [security policy](../SECURITY.md).
