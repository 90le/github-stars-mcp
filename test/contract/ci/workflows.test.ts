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
