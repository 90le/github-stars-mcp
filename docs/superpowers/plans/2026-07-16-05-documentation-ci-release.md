# Documentation, CI, and Release Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the tested MCP implementation into a trustworthy open-source project with complete user documentation, governance, reproducible CI, package verification, security automation, visual assets, and a manually gated 1.0.0 release path.

**Architecture:** Documentation is checked against machine-readable tool schemas and CLI output rather than maintained as disconnected prose. CI separates fast deterministic tests from cross-platform package smoke tests, while release workflows consume an already verified commit and never publish without an explicit maintainer-approved environment.

**Tech Stack:** Markdown, Node.js 22/24, npm, Vitest v4, GitHub Actions, CodeQL, Dependabot, CycloneDX/SPDX SBOM tooling, npm provenance.

## Global Constraints

- License the project under Apache-2.0.
- Support Node 22 and 24 on Windows, macOS, and Linux.
- Publish no telemetry and persist no credential.
- Document GitHub.com as the only fully supported Version 1 host.
- Keep mutation execution disabled by default with `GITHUB_STARS_MCP_READ_ONLY=true`.
- Never claim exact restoration of original `starred_at` timestamps or deleted User List IDs.
- Never run live Star/List mutations in pull-request CI.
- Pin every third-party action in every workflow to an immutable 40-character commit SHA.
- Require manual approval for the first npm publication.
- Keep package, plugin, README, and repository version/keywords aligned.

## File Map

- `README.md`: product promise, install, agent workflows, safety boundary, and links.
- `docs/requirements.md`: requirement-family index and acceptance criteria.
- `docs/architecture.md`: module boundaries, data flow, and persistence model.
- `docs/tool-reference.md`: generated-and-reviewed nine-tool reference.
- `docs/security.md`: threat model, credentials, local private data, and reporting.
- `docs/plugin.md`: Codex plugin installation and safe workflow.
- `docs/development.md`: runtime, commands, test layers, and fixtures.
- `docs/troubleshooting.md`: authentication, permissions, native SQLite, rates, and stdio.
- `docs/verification-matrix.md`: requirement-to-test/release-evidence ledger.
- `CONTRIBUTING.md`: contribution workflow and quality gates.
- `SECURITY.md`: supported versions and private reporting channel.
- `CODE_OF_CONDUCT.md`: Contributor Covenant.
- `LICENSE`: Apache License 2.0 text.
- `.github/workflows/ci.yml`: deterministic lint/type/test/build gates.
- `.github/workflows/package-smoke.yml`: cross-platform packed-install matrix.
- `.github/workflows/codeql.yml`: security analysis.
- `.github/workflows/release.yml`: manually approved release/package workflow.
- `.github/dependabot.yml`: npm and Actions updates.
- `.github/ISSUE_TEMPLATE/bug.yml`: actionable bug report form.
- `.github/ISSUE_TEMPLATE/feature.yml`: scoped feature proposal form.
- `.github/pull_request_template.md`: safety and verification checklist.
- `scripts/generate-tool-reference.mjs`: derive reference tables from schemas.
- `scripts/verify-docs.mjs`: reject version, tool, config, and link drift.
- `scripts/verify-package.mjs`: inspect packed contents and executable behavior.
- `scripts/verify-release.mjs`: verify version/tag/plugin/changelog consistency.
- `assets/social-preview.png`: 1280 by 640 repository preview.
- `plugin/assets/icon.png`: compact square plugin mark.
- `plugin/assets/logo.png`: plugin catalog logo.

---

### Task 1: Write the user-facing README and core documentation

**Files:**
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/requirements.md`
- Create: `docs/security.md`
- Create: `docs/plugin.md`
- Create: `docs/development.md`
- Create: `docs/troubleshooting.md`
- Create: `test/contract/docs/core-docs.test.ts`

**Interfaces:**
- Consumes: approved specification, CLI flags, environment variables, nine tool names, and stable error codes.
- Produces: documentation links and copy used by npm, GitHub, plugin users, and contributors.

- [ ] **Step 1: Write a documentation contract test**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const required = [
  "README.md", "docs/architecture.md", "docs/requirements.md", "docs/security.md",
  "docs/plugin.md", "docs/development.md", "docs/troubleshooting.md",
];

describe("core documentation", () => {
  it("exists and contains no unfinished markers", async () => {
    for (const path of required) {
      const text = await readFile(path, "utf8");
      expect(text.length, path).toBeGreaterThan(500);
      expect(text, path).not.toMatch(/\b(?:TBD|TODO|FIXME|coming soon)\b/i);
    }
  });

  it("states the repository safety and credential prohibitions", async () => {
    const security = await readFile("docs/security.md", "utf8");
    expect(security).toMatch(/cannot delete.*repository/i);
    expect(security).toMatch(/does not store.*token/i);
  });
});
```

- [ ] **Step 2: Run the documentation test and verify missing files**

Run: `npm test -- test/contract/docs/core-docs.test.ts`

Expected: FAIL with missing documentation paths.

- [ ] **Step 3: Write complete, behavior-matched documentation**

The README must contain this opening contract and retain its meaning through copy editing:

```md
# GitHub Stars MCP

Give AI agents a fast, structured, and auditable way to discover, organize, star, and unstar GitHub repositories. GitHub Stars MCP runs locally over stdio, uses official GitHub APIs, and requires an immutable plan before any GitHub write.

> GitHub Stars MCP cannot delete, archive, transfer, rename, change the visibility of, or modify the contents of a code repository. Its GitHub mutation adapter exposes only Star and Star List operations.

## Quick start

```bash
npx -y github-stars-mcp@1.0.0 --doctor
```

The server starts read-only. Set `GITHUB_STARS_MCP_READ_ONLY=false` only when you want an authorized agent to apply a plan you have inspected.
```

The seven documents must cover all headings below:

```text
architecture: boundaries, nine tools, API mapping, SQLite model, sync/apply/rollback flows
requirements: AUTH/SYNC/QUERY/LIST/PLAN/APPLY/UNDO/DISCOVER/OPS/PLUGIN families and acceptance link
security: credential order, allowlist, local private metadata, prompt injection, SSRF, audit, disclosure
plugin: repository install, marketplace install, environment forwarding, status-to-audit workflow
development: Node/npm setup, commands, fixtures, test layers, live-contract isolation, release preparation
troubleshooting: gh auth, fine-grained/classic tokens, List preview, rate limits, better-sqlite3, stdio logs
```

Examples must use fictional IDs and repositories. Every destructive example must show `github_changes_plan`, `github_changes_inspect`, then `github_changes_apply` with the returned hash.

- [ ] **Step 4: Run the focused prose contracts**

Run: `npm test -- test/contract/docs/core-docs.test.ts`

Expected: PASS with no missing headings or unfinished markers. Task 2 creates
the generated-reference and full relative-link drift checker before
`npm run docs:check` is first invoked.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md docs/requirements.md docs/security.md docs/plugin.md docs/development.md docs/troubleshooting.md test/contract/docs/core-docs.test.ts
git commit -m "docs: add complete project guides"
```

### Task 2: Generate and verify the nine-tool reference

**Files:**
- Create: `scripts/generate-tool-reference.mjs`
- Create: `scripts/verify-docs.mjs`
- Create: `docs/tool-reference.md`
- Modify: `package.json`
- Modify: `src/version.ts`
- Create: `test/contract/docs/tool-reference.test.ts`

**Interfaces:**
- Consumes: built server tool list and Zod-derived JSON schemas.
- Produces: deterministic `docs/tool-reference.md`, `npm run docs:generate`, and `npm run docs:check`.

- [ ] **Step 1: Write a drift-detection test**

```ts
it("regenerates the committed tool reference byte-for-byte", async () => {
  const committed = await readFile("docs/tool-reference.md", "utf8");
  const generated = await generateToolReference(createMcpServer(fakeServices()));
  expect(generated).toBe(committed);
  for (const name of ToolNames) expect(committed).toContain(`\`${name}\``);
});
```

- [ ] **Step 2: Run and verify the generator is absent**

Run: `npm test -- test/contract/docs/tool-reference.test.ts`

Expected: FAIL because the generator and reference do not exist.

- [ ] **Step 3: Implement deterministic reference generation**

```js
export function renderTool(tool) {
  const annotations = Object.entries(tool.annotations ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `- \`${key}\`: \`${String(value)}\``)
    .join("\n");
  return [
    `## \`${tool.name}\``, "", tool.description, "", "### Annotations", "", annotations,
    "", "### Input schema", "", "```json", JSON.stringify(tool.inputSchema, null, 2), "```", "",
  ].join("\n");
}

export function renderReference(tools) {
  const ordered = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return `# MCP Tool Reference\n\nGenerated from the built server. Do not edit by hand.\n\n${ordered.map(renderTool).join("\n")}`;
}
```

`verify-docs.mjs` must regenerate to memory, compare bytes, ensure README package/plugin versions match `package.json`, validate every relative Markdown link, and reject `@latest`, `TODO`, `TBD`, or undocumented environment variables.

- [ ] **Step 4: Generate, verify, and test**

Run: `npm run build && npm run docs:generate && npm run docs:check && npm test -- test/contract/docs/tool-reference.test.ts`

Expected: PASS and a clean `git diff` immediately after a second `npm run docs:generate`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-tool-reference.mjs scripts/verify-docs.mjs docs/tool-reference.md package.json test/contract/docs/tool-reference.test.ts
git commit -m "docs: generate MCP tool reference"
```

### Task 3: Add open-source governance and contribution safety gates

**Files:**
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/pull_request_template.md`
- Create: `scripts/verify-yaml.mjs`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`
- Create: `test/contract/docs/governance.test.ts`

**Interfaces:**
- Consumes: project test commands and security reporting repository URL.
- Produces: contributor contract, disclosure channel, issue forms, and PR verification checklist.

- [ ] **Step 1: Write governance-file tests**

```ts
it("ships Apache-2.0 and actionable security guidance", async () => {
  expect(await readFile("LICENSE", "utf8")).toContain("Apache License");
  expect(await readFile("LICENSE", "utf8")).toContain("Version 2.0, January 2004");
  const security = await readFile("SECURITY.md", "utf8");
  expect(security).toContain("Private vulnerability reporting");
  expect(security).not.toContain("open a public issue for a vulnerability");
});

it("requires safety and test evidence in pull requests", async () => {
  const template = await readFile(".github/pull_request_template.md", "utf8");
  expect(template).toContain("GitHub mutation allowlist");
  expect(template).toContain("npm run verify");
});
```

- [ ] **Step 2: Run and verify missing governance files**

Run: `npm test -- test/contract/docs/governance.test.ts`

Expected: FAIL with missing `LICENSE` first.

- [ ] **Step 3: Add exact governance content**

Use the unmodified Apache License 2.0 text in `LICENSE` and Contributor Covenant 2.1 text in `CODE_OF_CONDUCT.md`. `CONTRIBUTING.md` must require:

```md
1. Create a focused branch from `main`.
2. Add a failing test before production behavior.
3. Run `npm run verify` and the package smoke test relevant to your platform.
4. State whether the GitHub mutation allowlist changed. Any expansion requires a security review.
5. Never place real tokens, private repository metadata, or live-account mutation fixtures in commits.
```

`SECURITY.md` must list 1.x as supported, direct reporters to GitHub private vulnerability reporting, ask for version/reproduction/impact without live credentials, and promise no fixed response time that maintainers cannot guarantee.

Pin `yaml@2.8.1` as a development dependency and create
`scripts/verify-yaml.mjs` plus `"yaml:check": "node scripts/verify-yaml.mjs"`.
The script parses every committed `.yml`/`.yaml` file, rejects duplicate keys,
and reports the path and parser location without printing environment values.

- [ ] **Step 4: Validate Markdown and YAML**

Run: `npm test -- test/contract/docs/governance.test.ts && npm run docs:check && npm run yaml:check`

Expected: PASS; GitHub issue forms parse and all relative links resolve.

- [ ] **Step 5: Commit**

```bash
git add LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md .github/ISSUE_TEMPLATE .github/pull_request_template.md scripts/verify-yaml.mjs package.json npm-shrinkwrap.json test/contract/docs/governance.test.ts
git commit -m "docs: add open source governance"
```

### Task 4: Build reproducible CI and dependency automation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/package-smoke.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/verify-workflows.mjs`
- Modify: `package.json`
- Create: `test/contract/ci/workflows.test.ts`

**Interfaces:**
- Consumes: `npm ci`, `npm run verify`, `npm pack`, and plugin validation commands.
- Produces: PR CI, cross-platform package matrix, CodeQL, and weekly dependency updates.

- [ ] **Step 1: Write workflow policy tests**

```ts
it("tests Node 22 and 24 without live mutation credentials", async () => {
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  expect(ci).toMatch(/node-version:\s*\[22, 24\]/);
  expect(ci).toContain("GITHUB_STARS_MCP_READ_ONLY: true");
  expect(ci).not.toMatch(/GITHUB_STARS_TOKEN|GH_TOKEN:/);
});

it("runs package smoke on all three operating systems", async () => {
  const smoke = await readFile(".github/workflows/package-smoke.yml", "utf8");
  expect(smoke).toContain("ubuntu-latest");
  expect(smoke).toContain("macos-latest");
  expect(smoke).toContain("windows-latest");
});

it("pins actions and runs dependency review for pull requests", async () => {
  const workflows = await readAllWorkflowText();
  expect(workflows).not.toMatch(/uses:\s*[^@\s]+@(?![a-f0-9]{40}\b)/);
  expect(workflows).toContain("actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294");
});
```

- [ ] **Step 2: Run and verify workflow files are missing**

Run: `npm test -- test/contract/ci/workflows.test.ts`

Expected: FAIL because CI workflows do not exist.

- [ ] **Step 3: Create least-privilege workflows**

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22, 24]
    env:
      GITHUB_STARS_MCP_READ_ONLY: true
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run verify
  dependency-review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
      - uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294
```

`package-smoke.yml` must matrix `ubuntu-latest`, `macos-latest`, and
`windows-latest` with Node 22 and 24, use the pinned checkout/setup-node SHAs,
run `npm ci`, build, pack, install the tarball into a clean temporary project,
and run `--help`, `--version`, and a fixture-backed `--doctor`. `codeql.yml`
must grant only `security-events: write` plus `contents: read` and pin every
`github/codeql-action` use to
`ddf5ce7296213f5548c91e2dd19df2d77d2b2d66`. Dependabot must update npm and
GitHub Actions weekly with a limit of 10 open PRs per ecosystem.

- [ ] **Step 4: Validate and locally reproduce CI commands**

Run: `npm run workflows:check && npm test -- test/contract/ci/workflows.test.ts && npm ci && npm run verify`

Expected: PASS; workflow parser reports no broad write permission and no mutation token in PR CI.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/package-smoke.yml .github/workflows/codeql.yml .github/dependabot.yml scripts/verify-workflows.mjs package.json test/contract/ci/workflows.test.ts
git commit -m "ci: add verification and package matrices"
```

### Task 5: Verify package contents and clean installation

**Files:**
- Create: `scripts/verify-package.mjs`
- Create: `test/contract/package/package.test.ts`
- Modify: `package.json`
- Create: `.npmignore`

**Interfaces:**
- Consumes: `npm pack --json`, an optional exact `--tarball <path>`, and the built CLI.
- Produces: `npm run package:verify` and a strict package-file allowlist.

- [ ] **Step 1: Write package-boundary tests**

```ts
it("packs runtime, plugin, license, and user docs but no tests or local state", async () => {
  const files = await packedFiles();
  expect(files).toContain("package/dist/cli.js");
  expect(files).toContain("package/plugin/.codex-plugin/plugin.json");
  expect(files).toContain("package/LICENSE");
  expect(files.some((path) => path.includes("/test/"))).toBe(false);
  expect(files.some((path) => /\.sqlite(?:3)?$/.test(path))).toBe(false);
  expect(files.some((path) => /\.env$/.test(path))).toBe(false);
});

it("verifies a caller-supplied tarball without repacking it", async () => {
  const tarball = await packFixture();
  const before = await sha256(tarball);
  const result = await runPackageVerifier(["--tarball", tarball]);
  expect(result.exitCode).toBe(0);
  expect(result.packInvocations).toBe(0);
  expect(await sha256(tarball)).toBe(before);
});
```

- [ ] **Step 2: Run and verify package verifier is missing**

Run: `npm test -- test/contract/package/package.test.ts`

Expected: FAIL because `packedFiles` is not implemented.

- [ ] **Step 3: Implement package inspection and smoke install**

```js
const allowedPrefixes = [
  "package/dist/", "package/plugin/", "package/README.md", "package/LICENSE",
  "package/SECURITY.md", "package/package.json", "package/npm-shrinkwrap.json",
];

for (const file of files) {
  if (!allowedPrefixes.some((prefix) => file.path.startsWith(prefix))) {
    throw new Error(`Unexpected packed file: ${file.path}`);
  }
}
```

With no argument, the script must pack to an OS temporary directory and use
the single filename returned by `npm pack --json`. With
`--tarball <path>`, it must reject every other argument, resolve and verify
that exact pre-existing `.tgz`, and must not run `npm pack`. In both modes it
must install the exact selected tarball with
`npm install --ignore-scripts=false`, enumerate the installed package tree
against the strict allowlist (so the externally supplied archive itself is
checked), invoke the installed binary for `--help` and `--version`, run
fixture-backed `--doctor`, assert zero token-like output, and remove the
temporary installation in `finally`. Tests cover both modes, a missing or
second tarball argument, and prove the supplied tarball's SHA-256 is unchanged.

- [ ] **Step 4: Run package verification twice**

Run: `npm run build && npm run package:verify && npm run package:verify`

Expected: PASS twice with no repository working-tree changes.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-package.mjs test/contract/package/package.test.ts package.json .npmignore
git commit -m "test: verify distributable package"
```

### Task 6: Create and verify project visual assets

**Files:**
- Create: `assets/social-preview.png`
- Create: `plugin/assets/icon.png`
- Create: `plugin/assets/logo.png`
- Create: `scripts/verify-assets.mjs`
- Create: `test/contract/assets/assets.test.ts`
- Modify: `plugin/.codex-plugin/plugin.json`

**Interfaces:**
- Consumes: product name and brand colors `#0D1117`, `#F5B301`, and `#FFFFFF`.
- Produces: 1280x640 social preview, 256x256 icon, and 512x512 logo.

- [ ] **Step 1: Write PNG dimension and contrast tests**

```ts
it.each([
  ["assets/social-preview.png", 1280, 640],
  ["plugin/assets/icon.png", 256, 256],
  ["plugin/assets/logo.png", 512, 512],
])("validates %s", async (path, width, height) => {
  const image = await readPngMetadata(path);
  expect(image).toMatchObject({ width, height, hasAlpha: true });
  expect(image.uniqueColors).toBeGreaterThan(8);
});
```

- [ ] **Step 2: Run and verify assets are missing**

Run: `npm test -- test/contract/assets/assets.test.ts`

Expected: FAIL with missing social preview.

- [ ] **Step 3: Generate the three approved assets**

Use the image-generation workflow with this exact art direction:

```text
Create a crisp open-source developer-tool identity for “GitHub Stars MCP”. Use a dark #0D1117 field, a warm #F5B301 five-point star built from connected graph nodes, and restrained white typography. The symbol must remain legible at 32 px, contain no GitHub Octocat or third-party trademark, contain no gradients that muddy small sizes, and contain no extra slogans. Produce a square mark and a 1280x640 social preview with the title “GitHub Stars MCP” and subtitle “AI-native, auditable Star management”.
```

Crop/export exactly to the dimensions listed above. `verify-assets.mjs` must read the PNG signature and IHDR directly, reject alternate dimensions, files above 1.5 MB, missing alpha, or transparent empty borders wider than 12 percent.

In the same task, add
`"composerIcon": "./assets/icon.png"` and
`"logo": "./assets/logo.png"` to the plugin `interface`. Run
`npm run plugin:validate` only after all three images exist; tests assert every
manifest asset reference resolves inside `plugin/`.

- [ ] **Step 4: Run visual metadata verification**

Run: `npm test -- test/contract/assets/assets.test.ts && node scripts/verify-assets.mjs && npm run plugin:validate`

Expected: PASS with all three exact dimensions and size limits.

- [ ] **Step 5: Commit**

```bash
git add assets/social-preview.png plugin/assets/icon.png plugin/assets/logo.png plugin/.codex-plugin/plugin.json scripts/verify-assets.mjs test/contract/assets/assets.test.ts
git commit -m "design: add project brand assets"
```

### Task 7: Add SBOM, provenance, and manually gated release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/verify-release.mjs`
- Create: `scripts/checksums.mjs`
- Create: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `plugin/.codex-plugin/plugin.json`
- Modify: `plugin/.mcp.json`
- Create: `test/contract/release/release.test.ts`

**Interfaces:**
- Consumes: verified commit, matching `v1.0.0` tag, npm `production` environment approval, package tarball, assets, and SBOM generator.
- Produces: checksummed tarball, CycloneDX JSON SBOM, GitHub Release, and optional npm provenance publication.

- [ ] **Step 1: Write release-consistency tests**

```ts
it("keeps package, plugin, launcher, and changelog at one version", async () => {
  const pkg = await readJson("package.json");
  const plugin = await readJson("plugin/.codex-plugin/plugin.json");
  const mcp = await readJson("plugin/.mcp.json");
  expect(pkg.version).toBe("1.0.0");
  expect(plugin.version).toBe(pkg.version);
  expect(mcp.mcpServers["github-stars-mcp"].args).toContain(`github-stars-mcp@${pkg.version}`);
  expect(await readFile("CHANGELOG.md", "utf8")).toContain(`## [${pkg.version}]`);
  expect((await runBuiltCli(["--version"])).stdout).toBe(`${pkg.version}\n`);
});

it("installs pinned Codex and verifies the one release tarball before use", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  expect(workflow).toContain("npm install --global @openai/codex@0.144.5");
  expect(workflow.match(/\bnpm pack\b/g)).toHaveLength(1);
  const packed = workflow.indexOf("id: pack");
  const verified = workflow.indexOf(
    'package:verify -- --tarball "${{ steps.pack.outputs.tarball }}"',
  );
  const checksummed = workflow.indexOf("node scripts/checksums.mjs");
  const attested = workflow.indexOf("actions/attest-build-provenance");
  expect(packed).toBeLessThan(verified);
  expect(verified).toBeLessThan(checksummed);
  expect(checksummed).toBeLessThan(attested);
});
```

- [ ] **Step 2: Run and verify release files are incomplete**

Run: `npm test -- test/contract/release/release.test.ts`

Expected: FAIL until versions, changelog, and workflow agree.

- [ ] **Step 3: Implement the release verifier and workflow**

```yaml
name: Release
on:
  workflow_dispatch:
    inputs:
      publish_npm:
        type: boolean
        default: false
permissions:
  contents: write
  id-token: write
  attestations: write
jobs:
  release:
    environment: release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run verify
      - run: npm run docs:check
      - run: npm run plugin:validate
      - run: npm run release:verify
      - run: npm run smoke:mcp
      - run: npm install --global @openai/codex@0.144.5
      - run: codex --version
      - run: npm run smoke:codex-plugin
      - run: npm run verify:requirements -- --release
      - id: pack
        run: |
          mkdir -p artifacts
          npm sbom --sbom-format cyclonedx > artifacts/github-stars-mcp.cdx.json
          npm pack --json --pack-destination artifacts > artifacts/pack.json
          PACK_TARBALL="artifacts/$(node -p "JSON.parse(require('fs').readFileSync('artifacts/pack.json','utf8'))[0].filename")"
          echo "tarball=${PACK_TARBALL}" >> "$GITHUB_OUTPUT"
      - run: npm run package:verify -- --tarball "${{ steps.pack.outputs.tarball }}"
      - run: node scripts/checksums.mjs artifacts
      - uses: actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661
        with:
          subject-path: ${{ steps.pack.outputs.tarball }}
      - run: |
          VERSION=$(node -p "require('./package.json').version")
          gh release create "v${VERSION}" artifacts/*.tgz artifacts/github-stars-mcp.cdx.json artifacts/requirements.json SHA256SUMS --verify-tag --generate-notes
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        if: ${{ inputs.publish_npm }}
        with:
          name: npm-tarball
          path: ${{ steps.pack.outputs.tarball }}
  publish-npm:
    if: ${{ inputs.publish_npm }}
    needs: release
    environment: npm-publish
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: npm-tarball
          path: artifacts
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm publish "$(find artifacts -maxdepth 1 -name '*.tgz' -print -quit)" --provenance --access public
```

The checkout/setup/upload/download SHAs are the pinned official action refs and
the attestation SHA is the official `v3` ref resolved on 2026-07-16. The
release job installs the official npm-distributed Codex CLI at the exact
`0.144.5` version resolved on 2026-07-17; workflow contract tests reject
`latest`, ranges, missing installation, or a Codex plugin smoke before that
installation.
`verify-workflows.mjs` must reject any non-40-hex `uses:` ref in every workflow.
`verify-release.mjs` must require a clean tree, exact `v1.0.0` tag when running
in release mode, matching package/plugin/config/changelog/runtime versions,
successful package verification, and an unclaimed-or-owned npm package name.
Repository setup documentation must require reviewers on both `release` and
`npm-publish` environments; the publish input alone is never treated as
approval. The pack step is the only release tarball creation step.
`package:verify -- --tarball "${{ steps.pack.outputs.tarball }}"` must pass on
that exact file before checksum, attestation, upload, release, or publication.
The npm job publishes the exact tarball that was checked, checksummed, attested,
and uploaded—never a fresh repack.

```js
// scripts/checksums.mjs
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const inputs = [];
for (const argument of process.argv.slice(2)) {
  const statFiles = argument === "artifacts"
    ? (await readdir(argument)).filter((name) => name.endsWith(".tgz")).map((name) => join(argument, name))
    : [argument];
  inputs.push(...statFiles);
}
const lines = [];
for (const path of [...new Set(inputs)].sort()) {
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  lines.push(`${digest}  ${basename(path)}`);
}
await writeFile("SHA256SUMS", `${lines.join("\n")}\n`, "utf8");
```

- [ ] **Step 4: Run release preparation without publishing**

Run: `npm test -- test/contract/release/release.test.ts && npm run release:verify -- --prepare-only`

Expected: PASS, produce an SBOM and tarball, and make no npm publish or GitHub Release request.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml scripts/verify-release.mjs scripts/checksums.mjs CHANGELOG.md package.json src/version.ts plugin/.codex-plugin/plugin.json plugin/.mcp.json test/contract/release/release.test.ts
git commit -m "release: prepare verified 1.0.0 workflow"
```

### Task 8: Build the requirement evidence matrix and final verification command

**Files:**
- Create: `docs/verification-matrix.md`
- Create: `scripts/verify-requirements.mjs`
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Create: `test/contract/release/requirements.test.ts`

**Interfaces:**
- Consumes: all 80 requirement IDs, test reports, package smoke output, documentation checks, and release artifacts.
- Produces: `npm run verify:requirements` and an auditable completion ledger.

- [ ] **Step 1: Write matrix completeness tests**

```ts
it("maps every approved requirement ID to executable evidence", async () => {
  const spec = await readFile("docs/superpowers/specs/2026-07-16-github-stars-mcp-design.md", "utf8");
  const matrix = await readFile("docs/verification-matrix.md", "utf8");
  const ids = [...spec.matchAll(/\*\*([A-Z]+-\d+):\*\*/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(80);
  for (const id of ids) expect(matrix).toMatch(new RegExp(`\\| ${id} \\| [^|]+ \\| [^|]+ \\|`));
});

it("enforces final gates in CI and safety-critical branch coverage", async () => {
  expect(await readFile(".github/workflows/ci.yml", "utf8")).toContain("npm run verify:all");
  const config = await readFile("vitest.config.ts", "utf8");
  for (const path of [
    "src/domain/**", "src/app/services/apply-service.ts",
    "src/domain/redaction.ts", "src/github/allowed-operations.ts",
  ]) {
    expect(config).toContain(path);
  }
  expect(config).toMatch(/branches:\s*100/);
});
```

- [ ] **Step 2: Run and verify the matrix is missing**

Run: `npm test -- test/contract/release/requirements.test.ts`

Expected: FAIL because `docs/verification-matrix.md` does not exist.

- [ ] **Step 3: Create the evidence ledger and verifier**

The matrix must use this exact schema and one row per requirement:

```md
| Requirement | Implementation evidence | Verification evidence | Status |
|---|---|---|---|
| AUTH-01 | `src/auth/credential-provider.ts` | `test/unit/auth/credential-provider.test.ts` | Verified |
```

`verify-requirements.mjs` must parse requirement IDs from the approved spec, reject missing/duplicate rows, verify every referenced local path exists, reject any status other than `Verified` in release mode, and emit a JSON summary to `artifacts/requirements.json` for the GitHub Release.

Extend Vitest coverage thresholds with 100-percent branch gates for the domain
safety modules, apply service, credential redaction, and GitHub operation
allowlist while retaining the global 90-percent line/function and 85-percent
branch gates. Add `verify:all` to run `verify`, `docs:check`,
`plugin:validate`, `package:verify`, and `verify:requirements`. Change the
final CI job to run `npm run verify:all`; keep the release workflow's explicit
smoke and release-mode evidence gates so their output remains visible.

- [ ] **Step 4: Run the complete local release gate**

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:coverage && npm run build && npm run docs:check && npm run plugin:validate && npm run package:verify && npm run verify:requirements`

Expected: every command exits 0; coverage meets 90 percent line/function, 85 percent branch, and 100 percent branch for safety-critical modules.

- [ ] **Step 5: Commit**

```bash
git add docs/verification-matrix.md scripts/verify-requirements.mjs package.json vitest.config.ts .github/workflows/ci.yml .github/workflows/release.yml test/contract/release/requirements.test.ts
git commit -m "test: map requirements to release evidence"
```

## Plan Acceptance

- A new user can install, authenticate, diagnose, and understand the safe workflow from the README alone.
- All nine tools and all environment variables are documented and drift-checked.
- Apache-2.0, security reporting, contribution, issue, and PR policies are present.
- PR CI has least privilege and never receives a live mutation token.
- Packed installation passes on Windows, macOS, and Linux with Node 22 and 24.
- Plugin and social-preview assets have exact validated dimensions.
- Release preparation generates a tarball, checksums, SBOM, requirement evidence, and provenance-ready npm command without publishing by default.
- Every approved requirement maps to an existing implementation file and executable verification artifact.
