# Contributing to GitHub Stars MCP

GitHub Stars MCP gives AI agents a narrow interface for Stars and Star Lists. Contributions must preserve that boundary, the immutable plan and apply workflow, and the default read-only setting.

## Before You Start

Search open issues before filing a report. Use the bug or feature issue form so maintainers receive the runtime and reproduction details they need.

Send security reports through the private channel in [SECURITY.md](SECURITY.md). Do not disclose a suspected vulnerability in an issue, discussion, pull request, or test fixture.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contribution Workflow

1. Create a focused branch from `main`.
2. Add a failing test before production behavior.
3. Run `npm run verify` and the package smoke test relevant to your platform. Use `npm run package:verify` when the package script exists on your branch.
4. State whether the GitHub mutation allowlist changed. Any expansion requires a security review.
5. Never place real tokens, private repository metadata, or live-account mutation fixtures in commits.

Keep each pull request focused on one behavior or policy change. Update tests and user documentation in the same pull request when the public contract changes.

## Development Setup

Use Node.js 22 or 24 and npm. Install the exact dependency graph from `npm-shrinkwrap.json`:

```bash
npm ci
npm run typecheck
npm test
```

Run the full deterministic gate before opening a pull request:

```bash
npm run verify
```

The gate checks formatting, lint rules, TypeScript, test coverage, and the production build. Run the focused test file during development, then run the full gate before review.

## Tests and Fixtures

Write the smallest failing test that describes the contract. Add tests at the boundary where the behavior lives:

- unit tests for domain rules and pure transformations;
- contract tests for GitHub requests, MCP tools, governance, and packages;
- integration tests for SQLite, process startup, and adapter coordination;
- security tests for capability boundaries, redaction, and hostile input.

Use fictional account names, repository IDs, request IDs, and token-shaped strings. Sanitize copied API responses before committing them. Pull-request CI must not receive credentials that can mutate a GitHub account.

The maintainer-only live contract suite uses a disposable account and disposable repositories. Contributors must not run that suite against a personal or work account.

## GitHub Mutation Safety

Production code may mutate Stars and User Lists through named, allowlisted adapter methods. It may not expose generic REST, GraphQL, URL, request-path, shell, or repository-administration operations.

Each GitHub write must start from an immutable plan and require its expected hash at apply time. Repository deletion, archive, transfer, rename, visibility changes, and contents changes remain outside the product.

If your change touches a GitHub write:

1. Name each added or changed operation in the pull request.
2. Show the failing test that established the intended request shape.
3. Show allowlist, redaction, precondition, audit, and retry evidence.
4. Request a security review for any GitHub mutation allowlist expansion.

Do not combine an allowlist change with cleanup or dependency work.

## Dependency Changes

Use npm to update `package.json` and `npm-shrinkwrap.json`. Explain why the project needs the dependency, review its license and maintenance status, and include the shrinkwrap diff. Avoid drive-by upgrades in feature pull requests.

## Pull Request Evidence

Complete the pull request template. Include:

- the problem and the implemented contract;
- focused test commands and `npm run verify` output;
- package smoke evidence when packaging changed;
- the GitHub mutation allowlist declaration;
- documentation and migration notes.

Maintainers may ask you to split unrelated changes or add a regression test before review.

## License

You license submitted contributions under the project's [Apache License 2.0](LICENSE).
