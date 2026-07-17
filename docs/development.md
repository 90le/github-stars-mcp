# Development

GitHub Stars MCP uses TypeScript, Node.js 22 or 24, npm, Vitest, Octokit, the
Model Context Protocol SDK, Zod, and `better-sqlite3`. Development commands
must run on Windows, macOS, and Linux.

## Setup

```bash
git clone https://github.com/90le/github-stars-mcp.git
cd github-stars-mcp
npm ci
npm run build
```

`npm ci` installs the pinned dependency graph. Do not replace exact versions
with ranges. Native `better-sqlite3` binaries require a supported Node ABI; a
compiler toolchain may be needed when no prebuilt binary matches the platform.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run format:check` | Check Prettier output |
| `npm run lint` | Run ESLint with zero warnings |
| `npm run typecheck` | Check TypeScript without emitting files |
| `npm test` | Run deterministic unit, contract, integration, and security tests |
| `npm run test:coverage` | Run tests with global coverage thresholds |
| `npm run build` | Emit the production ESM package |
| `npm run yaml:check` | Parse YAML and reject duplicate keys |
| `npm run workflows:check` | Enforce workflow permissions and action pins |
| `npm run verify` | Run format, lint, types, coverage, and build |
| `npm run test:live` | Run separately authorized live contracts |

Run a focused test during development, then run `npm run verify` before a
commit. Add a failing test before changing behavior. Keep commits scoped so an
independent reviewer can compare each task with its approved contract.

## Test layers

Unit tests cover domain validation, canonical serialization, cursor signing,
services, mappers, and result envelopes. Contract tests cover the narrow
GitHub adapter, SQLite port, MCP registration, CLI, documentation, package,
plugin, and workflow policy. Integration tests exercise migrations, complete
snapshots, leases, apply recovery, and stdio framing with local fixtures.

Security tests enforce the exact mutation capability surface, reject generic
API access, scan packed outputs for credentials and local state, verify
redaction under hostile values, and confirm that repository-administration
operations remain unreachable.

Fixtures use fictional accounts, repositories, database IDs, Lists, request
IDs, timestamps, and credentials. Never copy a live API response containing
private metadata into the repository. Test tokens must use invalid shapes or
explicit synthetic markers.

## Live-contract isolation

`npm run test:live` skips unless its explicit live-read prerequisites exist.
Run it outside pull-request CI with a test account or a credential whose scope
you understand. The standard live suite verifies viewer identity, pagination,
stable IDs, and declared capabilities without mutating GitHub.

Do not enable live mutation by setting a broad token in CI. A maintainer who
runs a separate mutation contract must choose disposable Star/List targets,
record authorization, enable write mode for that process, and inspect cleanup
results. Standard verification must pass without network access.

## Architecture changes

Application services depend on narrow ports. Add a named `GitHubPort` method
only when the public product contract needs a new supported capability.
Changes to the six-method mutation allowlist require a security review,
contract updates, packed-output inspection, and documentation changes.

Storage methods are synchronous so transaction callbacks cannot cross an
`await`. Keep GitHub calls outside transactions. Persist write-ahead intent
before dispatch and preserve stable run IDs during recovery.

## Release preparation

Run the complete verification suite, generate the tool reference, validate
YAML and workflows, pack the npm tarball, install it into a clean temporary
project, and run `--help`, `--version`, and fixture-backed `--doctor`.
Validate the plugin in an isolated home. Produce the SBOM, checksums, and
provenance from the verified commit.

The release workflow uses a manually approved environment for publication.
Tag, package, plugin, README, changelog, and generated reference versions must
match. Pull-request workflows never receive a mutation credential.
