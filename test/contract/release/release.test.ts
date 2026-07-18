import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeChecksums } from "../../../scripts/checksums.mjs";
import {
  assertReleaseRevision,
  prepareArtifactDirectory,
  prepareBuildOutput,
  releaseChildEnvironment,
  validatePackageMetadata,
  validateSbom,
  verifyNpmPackageName,
  verifyReleaseMetadata,
} from "../../../scripts/verify-release.mjs";
import { PACKAGE_VERSION } from "../../../src/version.js";

const temporaryRoots: string[] = [];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release preparation", () => {
  it("keeps package, lock, plugin, launcher, changelog, and runtime at 1.0.0", async () => {
    const metadata = await verifyReleaseMetadata({
      runtimeVersion: PACKAGE_VERSION,
    });
    expect(metadata).toEqual({
      name: "github-stars-mcp",
      version: "1.0.0",
      npmSpecifier: "github-stars-mcp@1.0.0",
    });

    const packageMetadata = await readJson("package.json");
    const shrinkwrap = await readJson("npm-shrinkwrap.json");
    const plugin = await readJson(
      "plugins/github-stars-mcp/.codex-plugin/plugin.json",
    );
    const mcp = await readJson("plugins/github-stars-mcp/.mcp.json");
    const server = (mcp.mcpServers as Record<string, Record<string, unknown>>)[
      "github-stars-mcp"
    ];
    expect(PACKAGE_VERSION).toBe("1.0.0");
    expect(packageMetadata.packageManager).toBe("npm@11.12.1");
    expect(shrinkwrap.version).toBe(packageMetadata.version);
    expect(
      (shrinkwrap.packages as Record<string, Record<string, unknown>>)[""]
        ?.version,
    ).toBe(packageMetadata.version);
    expect(plugin.version).toBe(packageMetadata.version);
    expect(server).toMatchObject({
      args: ["-y", "github-stars-mcp@1.0.0", "--stdio"],
      startup_timeout_sec: 120,
      tool_timeout_sec: 900,
    });
    expect(await readFile("CHANGELOG.md", "utf8")).toContain(
      "## [1.0.0] - 2026-07-17",
    );
  });

  it("writes deterministic SHA-256 checksums for exact regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-checksums-"));
    temporaryRoots.push(root);
    const alpha = join(root, "alpha.tgz");
    const beta = join(root, "beta.tgz");
    const manifest = join(root, "release-manifest.json");
    const outputPath = join(root, "SHA256SUMS");
    await writeFile(beta, "beta", "utf8");
    await writeFile(alpha, "alpha", "utf8");
    await writeFile(manifest, "manifest", "utf8");

    const result = await writeChecksums([beta, manifest, alpha], {
      outputPath,
    });
    const digest = (value: string): string =>
      createHash("sha256").update(value).digest("hex");
    expect(result.lines).toEqual([
      `${digest("alpha")}  alpha.tgz`,
      `${digest("beta")}  beta.tgz`,
      `${digest("manifest")}  release-manifest.json`,
    ]);
    expect(await readFile(outputPath, "utf8")).toBe(
      `${result.lines.join("\n")}\n`,
    );
  });

  it("does not follow a checksum-output symlink into the verified tarball", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-checksum-link-"));
    temporaryRoots.push(root);
    const tarball = join(root, "release.tgz");
    const outputPath = join(root, "SHA256SUMS");
    await writeFile(tarball, "verified tarball", "utf8");
    await symlink(tarball, outputPath, "file");

    await expect(writeChecksums([tarball], { outputPath })).rejects.toThrow(
      /already exists/iu,
    );
    expect(await readFile(tarball, "utf8")).toBe("verified tarball");
  });

  it("rejects an ignored artifacts directory redirected outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-artifacts-root-"));
    const outside = await mkdtemp(join(tmpdir(), "release-artifacts-outside-"));
    temporaryRoots.push(root, outside);
    await symlink(
      outside,
      join(root, "artifacts"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(prepareArtifactDirectory(root)).rejects.toThrow(
      /artifacts must be a real directory/iu,
    );
  });

  it("rejects an ignored build directory redirected outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-build-root-"));
    const outside = await mkdtemp(join(tmpdir(), "release-build-outside-"));
    temporaryRoots.push(root, outside);
    await symlink(
      outside,
      join(root, "dist"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(prepareBuildOutput(root)).rejects.toThrow(
      /dist must be a real directory/iu,
    );
  });

  it("rejects a release when HEAD is not the exact version tag revision", () => {
    expect(() =>
      assertReleaseRevision({
        version: "1.0.0",
        headRevision: "a".repeat(40),
        tagRevision: "b".repeat(40),
      }),
    ).toThrow(/HEAD does not match refs\/tags\/v1\.0\.0/u);
    expect(() =>
      assertReleaseRevision({
        version: "1.0.0",
        headRevision: "a".repeat(40),
        tagRevision: "a".repeat(40),
      }),
    ).not.toThrow();
  });

  it("strips credentials and process hooks from every release subprocess", () => {
    const environment = releaseChildEnvironment({
      PATH: "synthetic-path",
      CI: "true",
      NODE_AUTH_TOKEN: "npm-secret",
      NPM_TOKEN: "npm-secret",
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "github-secret",
      NODE_OPTIONS: "--require=hostile.cjs",
      BASH_ENV: "/tmp/hostile",
      ENV: "/tmp/hostile",
      npm_config_script_shell: "/tmp/hostile-shell",
      npm_config_registry: "https://hostile.invalid/",
      npm_config_userconfig: "/tmp/hostile-npmrc",
    });

    expect(environment).toMatchObject({
      PATH: "synthetic-path",
      CI: "true",
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    });
    for (const name of [
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "npm_config_script_shell",
    ]) {
      expect(environment).not.toHaveProperty(name);
    }
    expect(environment.npm_config_userconfig).not.toBe("/tmp/hostile-npmrc");
  });

  it("rejects an npm dist-tag override in otherwise valid package metadata", async () => {
    const packageMetadata = await readJson("package.json");
    expect(() => validatePackageMetadata(packageMetadata)).not.toThrow();
    expect(() =>
      validatePackageMetadata({
        ...packageMetadata,
        publishConfig: {
          ...(packageMetadata.publishConfig as Record<string, unknown>),
          tag: "next",
        },
      }),
    ).toThrow(/official public npm registry/iu);
  });

  it("rejects an SBOM whose format or root package identity changed", () => {
    const valid = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      metadata: {
        component: {
          version: "1.0.0",
          purl: "pkg:npm/github-stars-mcp@1.0.0",
        },
      },
    };
    expect(() =>
      validateSbom(JSON.stringify(valid), {
        name: "github-stars-mcp",
        version: "1.0.0",
      }),
    ).not.toThrow();
    expect(() =>
      validateSbom(
        JSON.stringify({
          ...valid,
          metadata: {
            component: {
              version: "9.9.9",
              purl: "pkg:npm/foreign-package@9.9.9",
            },
          },
        }),
        { name: "github-stars-mcp", version: "1.0.0" },
      ),
    ).toThrow(/identity/iu);
  });

  it("distinguishes an unclaimed npm name from owned, forbidden, and foreign names", async () => {
    const response = (
      status: number,
      body: unknown,
    ): {
      status: number;
      json(): Promise<unknown>;
    } => ({ status, json: () => Promise.resolve(body) });
    await expect(
      verifyNpmPackageName("github-stars-mcp", "1.0.0", () =>
        Promise.resolve(response(404, {})),
      ),
    ).resolves.toEqual({ state: "unclaimed" });
    await expect(
      verifyNpmPackageName("github-stars-mcp", "1.0.0", () =>
        Promise.resolve(
          response(200, { maintainers: [{ name: "90le" }], versions: {} }),
        ),
      ),
    ).resolves.toEqual({ state: "owned" });
    await expect(
      verifyNpmPackageName("github-stars-mcp", "1.0.0", () =>
        Promise.resolve(response(403, {})),
      ),
    ).rejects.toThrow(/HTTP 403/u);
    await expect(
      verifyNpmPackageName("github-stars-mcp", "1.0.0", () =>
        Promise.resolve(
          response(200, {
            maintainers: [{ name: "someone-else" }],
            versions: {},
          }),
        ),
      ),
    ).rejects.toThrow(/unexpected maintainer/u);
    await expect(
      verifyNpmPackageName("github-stars-mcp", "1.0.0", () =>
        Promise.resolve(
          response(200, {
            maintainers: [{ name: "90le" }, { name: "someone-else" }],
            versions: {},
          }),
        ),
      ),
    ).rejects.toThrow(/unexpected maintainer/u);
    await expect(
      verifyNpmPackageName("github-stars-mcp", "1.0.0", () =>
        Promise.resolve(
          response(200, {
            maintainers: [{ name: "90le" }],
            versions: { "1.0.0": {} },
          }),
        ),
      ),
    ).rejects.toThrow(/already exists/iu);
  });

  it("moves one exact five-file bundle across isolated release stages", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const verifyStart = workflow.indexOf("\n  verify-package:");
    const releaseStart = workflow.indexOf("\n  release:");
    const publishStart = workflow.indexOf("\n  publish-npm:");
    const verifyJob = workflow.slice(verifyStart, releaseStart);
    const releaseJob = workflow.slice(releaseStart, publishStart);
    const publishJob = workflow.slice(publishStart);

    expect(verifyStart).toBeGreaterThan(-1);
    expect(verifyStart).toBeLessThan(releaseStart);
    expect(releaseStart).toBeLessThan(publishStart);
    expect(verifyJob).toContain(
      "node scripts/verify-release.mjs --bundle-release",
    );
    expect(verifyJob).toContain("path: artifacts/release-bundle/");
    expect(releaseJob).not.toMatch(
      /\bcheckout\b|\bnpm (?:ci|install|run)\b|scripts\//u,
    );
    expect(releaseJob).toContain("sha256sum --check --strict SHA256SUMS");
    expect(releaseJob).toContain("actions/attest-build-provenance@");
    expect(releaseJob).toContain("gh release delete-asset");
    expect(releaseJob).toContain("--draft=false --prerelease=false");
    expect(releaseJob).toContain("isDraft,isPrerelease");
    expect(releaseJob).toContain("gh release upload");
    expect(releaseJob).toContain("gh release create");
    expect(publishJob).toContain("sha256sum --check --strict SHA256SUMS");
    expect(workflow).toContain('npm publish "$1" --provenance --access public');
    expect(workflow.match(/name: release-bundle/gu)).toHaveLength(3);
    expect(workflow.match(/^\s+path: release-bundle$/gmu)).toHaveLength(2);
  });

  it("documents the two protected release environments and non-publishing preparation", async () => {
    const development = await readFile("docs/development.md", "utf8");
    const verifier = await readFile("scripts/verify-release.mjs", "utf8");
    expect(development).toContain("`release`");
    expect(development).toContain("`npm-publish`");
    expect(development).toContain("npm run release:verify -- --prepare-only");
    expect(development).toMatch(/does not\s+publish/iu);
    expect(verifier).not.toMatch(/\bnpm publish\b|\bgh release create\b/gu);
    expect(verifier).toContain("refs/tags/v${version}^{commit}");
    expect(verifier).toContain("node_modules/typescript/bin/tsc");
    expect(verifier).not.toContain('["run", "build"]');
  });
});
