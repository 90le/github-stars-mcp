# Changelog

All notable changes are recorded here. This project follows Semantic
Versioning.

## [1.0.0] - 2026-07-17

Initial public release.

### Added

- Nine strict MCP tools for status, synchronization, Star queries, User List
  queries, repository discovery, immutable change planning, audited apply,
  run inspection, and rollback-plan creation.
- Complete local SQLite snapshots with authenticated cursors, leases,
  recovery, bounded evidence, and zero telemetry.
- Official GitHub API adapters for Stars and User Lists, including guarded
  pagination, capability detection, rate pacing, and an explicit six-operation
  mutation allowlist.
- Optional Codex plugin, repository marketplace metadata, generated tool
  reference, cross-platform package verification, and cold-install-safe MCP
  startup timing.

### Safety

- GitHub writes are disabled by default and require an immutable plan ID,
  matching SHA-256 plan hash, authenticated-account binding, capability
  checks, preconditions, and a global account lease.
- Credentials are resolved at runtime, redacted from outputs and logs, and
  never stored in SQLite, plans, run evidence, packages, or plugin files.
- Release artifacts are built once, installed and verified from the exact
  tarball, checksummed, attested, and published only through protected manual
  environments.

### Known rollback limits

- Re-starring a repository creates a new `starred_at` timestamp.
- Recreating a deleted GitHub User List creates a new List ID.
- An unknown remote mutation outcome is reconciled by readback and is never
  retried blindly.

[1.0.0]: https://github.com/90le/github-stars-mcp/releases/tag/v1.0.0
