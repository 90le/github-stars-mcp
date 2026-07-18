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

Run `npm run release:prepare` from a clean worktree. The equivalent direct
command is `npm run release:verify -- --prepare-only`. It builds the runtime,
checks package ownership and version consistency, produces one npm tarball,
verifies that exact tarball in an isolated installation, and creates
`artifacts/release-bundle/` with exactly:

- `github-stars-mcp-<version>.tgz`
- `github-stars-mcp.cdx.json`
- `requirements.json`
- `release-manifest.json`
- `SHA256SUMS`

The manifest binds the version, tag ref, commit, and filenames. `SHA256SUMS`
covers the tarball and all three JSON files. Preparation does not publish to
npm, create a GitHub Release, or require a release tag.

Before enabling releases, create two protected GitHub environments:

- `release` gates attestation and the GitHub Release.
- `npm-publish` gates the optional npm publication.

Configure required reviewers and allow only tags matching `v*` for both
environments. The `publish_npm` workflow input defaults to `false`; an input
is intent, not approval.

For a release, commit the version, create signed or annotated tag
`v<package-version>` on that exact commit, push the tag, and dispatch the
Release workflow against that tag. The unprivileged `verify-package` job
checks out source, installs fixed tooling, runs all verification, calls
`--bundle-release`, and uploads the five-file bundle. It has read-only
repository permission and no publishing identity.

After environment approval, the privileged `release` job downloads only that
bundle. It does not check out or execute repository code. System tools
recheck every digest and bind `release-manifest.json` to `GITHUB_SHA`,
`GITHUB_REF`, the version tag, and the single tarball before attestation and
an idempotent GitHub Release update. The optional `publish-npm` job downloads
the same bundle, repeats those checks, and publishes that exact tarball. It
never repacks.

### First npm publication

An unclaimed npm package cannot configure a trusted publisher yet. Bootstrap
the first version inside the protected `npm-publish` job:

1. Create a short-lived granular npm access token with only the necessary
   read/write package access and bypass-2FA enabled for this non-interactive
   publication.
2. Store it as the `NPM_TOKEN` secret on the `npm-publish` environment, not as
   a repository secret.
3. Dispatch the exact version tag with `publish_npm=true` and
   `bootstrap_npm=true`. Only the publish step receives the token, and npm
   publishes with provenance from the GitHub-hosted runner.
4. Configure npm trusted publishing for repository
   `90le/github-stars-mcp`, workflow `release.yml`, and environment
   `npm-publish`.
5. Delete the environment secret and revoke the granular token.

For later releases, dispatch with `publish_npm=true` and
`bootstrap_npm=false`. npm 11.12.1 uses GitHub OIDC; no npm token is present.
Never enable `bootstrap_npm` after trusted publishing is configured.

Tag, package, shrinkwrap, plugin, launcher, CLI, changelog, and generated
reference versions must match. Pull-request workflows never receive a live
mutation credential.
