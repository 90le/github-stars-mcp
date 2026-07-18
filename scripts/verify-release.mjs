import { execFile } from "node:child_process";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { writeChecksums } from "./checksums.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "github-stars-mcp";
const EXPECTED_NPM_MAINTAINER = "90le";
const NPM_REGISTRY = "https://registry.npmjs.org";
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "ComSpec",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

function fail(message) {
  throw new Error(message);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value;
}

async function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} must be readable JSON`, { cause: error });
  }
  return record(parsed, label);
}

function inside(root, path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function repositoryPath(root, path) {
  const resolved = resolve(root, path);
  if (!inside(root, resolved)) fail("release path escapes the repository");
  return resolved;
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((candidate, index) => candidate === expected[index])
  );
}

export function releaseChildEnvironment(source = process.env) {
  const environment = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === "string") environment[key] = value;
  }
  environment.npm_config_registry = `${NPM_REGISTRY}/`;
  const isolatedConfigRoot =
    process.platform === "win32" ? source.TEMP || "C:\\Windows\\Temp" : "/tmp";
  environment.npm_config_userconfig = `${isolatedConfigRoot}/github-stars-mcp-release-user-${process.pid}.npmrc`;
  environment.npm_config_globalconfig = `${isolatedConfigRoot}/github-stars-mcp-release-global-${process.pid}.npmrc`;
  environment.npm_config_ignore_scripts = "true";
  environment.npm_config_audit = "false";
  environment.npm_config_fund = "false";
  return environment;
}

async function run(command, arguments_, options = {}) {
  try {
    return await execFileAsync(command, arguments_, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env ?? releaseChildEnvironment(),
      maxBuffer: options.maxBuffer ?? MAX_OUTPUT_BYTES,
      timeout: options.timeout ?? 120_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(options.label ?? "release command failed", {
      cause: error,
    });
  }
}

function npmCommand() {
  return process.execPath;
}

function npmArguments(arguments_) {
  const cli = resolve(
    dirname(process.execPath),
    "node_modules/npm/bin/npm-cli.js",
  );
  return [cli, ...arguments_];
}

function sourceRepositoryIsExact(repository) {
  const value =
    typeof repository === "string"
      ? repository
      : record(repository, "package repository").url;
  return (
    value === "https://github.com/90le/github-stars-mcp.git" ||
    value === "git+https://github.com/90le/github-stars-mcp.git"
  );
}

export function validatePackageMetadata(packageMetadata) {
  if (
    packageMetadata.name !== PACKAGE_NAME ||
    typeof packageMetadata.version !== "string" ||
    !SEMVER.test(packageMetadata.version) ||
    packageMetadata.private !== false ||
    packageMetadata.license !== "Apache-2.0" ||
    packageMetadata.packageManager !== "npm@11.12.1"
  ) {
    fail("package release identity is invalid");
  }
  if (!sourceRepositoryIsExact(packageMetadata.repository)) {
    fail("package repository does not match the GitHub source repository");
  }
  if (
    packageMetadata.homepage !==
      "https://github.com/90le/github-stars-mcp#readme" ||
    record(packageMetadata.bugs, "package bugs").url !==
      "https://github.com/90le/github-stars-mcp/issues"
  ) {
    fail("package project URLs are invalid");
  }
  const scripts = record(packageMetadata.scripts, "package scripts");
  if (scripts.build !== "tsc -p tsconfig.build.json") {
    fail("package build command is not the audited TypeScript command");
  }
  if (
    !Array.isArray(packageMetadata.keywords) ||
    packageMetadata.keywords.some(
      (keyword) => typeof keyword !== "string" || keyword.length === 0,
    )
  ) {
    fail("package search keywords are invalid");
  }
  const keywords = new Set(packageMetadata.keywords);
  for (const keyword of [
    "mcp",
    "model-context-protocol",
    "github",
    "github-stars",
    "github-api",
    "ai-agent",
    "github-lists",
  ]) {
    if (!keywords.has(keyword)) fail("package search keywords are incomplete");
  }
  const publishConfig = record(
    packageMetadata.publishConfig,
    "package publishConfig",
  );
  if (
    !exactStringArray(Object.keys(publishConfig).sort(), [
      "access",
      "registry",
    ]) ||
    publishConfig.access !== "public" ||
    publishConfig.registry !== `${NPM_REGISTRY}/`
  ) {
    fail("package publication must use the official public npm registry");
  }
}

export async function verifyReleaseMetadata(options = {}) {
  const root = await realpath(resolve(options.root ?? "."));
  const packageMetadata = await readJson(
    repositoryPath(root, "package.json"),
    "package.json",
  );
  validatePackageMetadata(packageMetadata);
  const version = packageMetadata.version;
  const npmSpecifier = `${PACKAGE_NAME}@${version}`;

  const shrinkwrap = await readJson(
    repositoryPath(root, "npm-shrinkwrap.json"),
    "npm-shrinkwrap.json",
  );
  const rootPackage = record(
    record(shrinkwrap.packages, "shrinkwrap packages")[""],
    "shrinkwrap root package",
  );
  if (
    shrinkwrap.name !== PACKAGE_NAME ||
    shrinkwrap.version !== version ||
    rootPackage.name !== PACKAGE_NAME ||
    rootPackage.version !== version
  ) {
    fail("npm shrinkwrap version does not match package.json");
  }

  const plugin = await readJson(
    repositoryPath(root, "plugins/github-stars-mcp/.codex-plugin/plugin.json"),
    "plugin manifest",
  );
  if (plugin.name !== PACKAGE_NAME || plugin.version !== version) {
    fail("plugin version does not match package.json");
  }

  const mcp = await readJson(
    repositoryPath(root, "plugins/github-stars-mcp/.mcp.json"),
    "plugin MCP configuration",
  );
  const servers = record(mcp.mcpServers, "plugin MCP servers");
  const server = record(servers[PACKAGE_NAME], "plugin MCP server");
  if (
    Object.keys(servers).length !== 1 ||
    server.command !== "npx" ||
    !exactStringArray(server.args, ["-y", npmSpecifier, "--stdio"]) ||
    server.startup_timeout_sec !== 120 ||
    server.tool_timeout_sec !== 900
  ) {
    fail("plugin launcher does not match the release");
  }

  const changelog = await readFile(
    repositoryPath(root, "CHANGELOG.md"),
    "utf8",
  );
  const escapedVersion = version.replaceAll(".", "\\.");
  if (
    !new RegExp(
      `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`,
      "mu",
    ).test(changelog)
  ) {
    fail("changelog does not contain the release version");
  }
  const exactSpecifier = `${PACKAGE_NAME}@${version}`;
  const [toolReference, readme, pluginGuide, troubleshooting] =
    await Promise.all([
      readFile(repositoryPath(root, "docs/tool-reference.md"), "utf8"),
      readFile(repositoryPath(root, "README.md"), "utf8"),
      readFile(repositoryPath(root, "docs/plugin.md"), "utf8"),
      readFile(repositoryPath(root, "docs/troubleshooting.md"), "utf8"),
    ]);
  if (
    !toolReference.includes(
      `Generated from the built \`${PACKAGE_NAME}\` ${version} server.`,
    ) ||
    !readme.includes(exactSpecifier) ||
    !pluginGuide.includes(exactSpecifier) ||
    !troubleshooting.includes(exactSpecifier)
  ) {
    fail("release documentation does not match the package version");
  }

  let runtimeVersion = options.runtimeVersion;
  if (runtimeVersion === undefined) {
    const result = await run(
      process.execPath,
      [repositoryPath(root, "dist/cli.js"), "--version"],
      { cwd: root, label: "built CLI version check failed", timeout: 10_000 },
    );
    if (result.stderr !== "" || result.stdout !== `${version}\n`) {
      fail("built CLI version does not match package.json");
    }
    runtimeVersion = result.stdout.trim();
  }
  if (runtimeVersion !== version) {
    fail("runtime version does not match package.json");
  }

  return Object.freeze({ name: PACKAGE_NAME, version, npmSpecifier });
}

export function assertReleaseRevision({ version, headRevision, tagRevision }) {
  if (
    !SEMVER.test(version) ||
    !REVISION.test(headRevision) ||
    !REVISION.test(tagRevision)
  ) {
    fail("release revisions are invalid");
  }
  if (headRevision !== tagRevision) {
    fail(`HEAD does not match refs/tags/v${version}`);
  }
}

async function assertCleanRepository(root) {
  const topLevel = (
    await run("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      label: "repository root check failed",
      timeout: 10_000,
    })
  ).stdout.trim();
  if ((await realpath(topLevel)) !== root) {
    fail("release command is not running at the repository root");
  }
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: root,
      label: "repository cleanliness check failed",
      timeout: 10_000,
    },
  );
  if (status.stdout !== "") fail("release requires a clean Git worktree");
}

async function assertExactTag(root, version) {
  const [head, tag] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], {
      cwd: root,
      label: "HEAD revision check failed",
      timeout: 10_000,
    }),
    run("git", ["rev-parse", `refs/tags/v${version}^{commit}`], {
      cwd: root,
      label: `release tag v${version} is missing`,
      timeout: 10_000,
    }),
  ]);
  assertReleaseRevision({
    version,
    headRevision: head.stdout.trim(),
    tagRevision: tag.stdout.trim(),
  });
}

export async function verifyNpmPackageName(
  name,
  versionOrFetch,
  maybeFetchImplementation = globalThis.fetch,
) {
  const version =
    typeof versionOrFetch === "function" ? undefined : versionOrFetch;
  const fetchImplementation =
    typeof versionOrFetch === "function"
      ? versionOrFetch
      : maybeFetchImplementation;
  if (
    version !== undefined &&
    (!SEMVER.test(version) || name !== PACKAGE_NAME)
  ) {
    fail("npm package version preflight identity is invalid");
  }
  let response;
  try {
    response = await fetchImplementation(
      `${NPM_REGISTRY}/${encodeURIComponent(name)}`,
      {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    throw new Error("npm registry ownership check failed", { cause: error });
  }
  if (response.status === 404) {
    return Object.freeze({ state: "unclaimed" });
  }
  if (response.status !== 200) {
    fail(`npm registry ownership check returned HTTP ${response.status}`);
  }
  let document;
  try {
    document = record(await response.json(), "npm package metadata");
  } catch (error) {
    throw new Error("npm registry returned invalid package metadata", {
      cause: error,
    });
  }
  const maintainers = Array.isArray(document.maintainers)
    ? document.maintainers
    : [];
  if (version !== undefined) {
    const versions = document.versions;
    if (
      versions !== undefined &&
      (versions === null ||
        typeof versions !== "object" ||
        Array.isArray(versions))
    ) {
      fail("npm package versions metadata is invalid");
    }
    if (
      versions !== undefined &&
      Object.prototype.hasOwnProperty.call(versions, version)
    ) {
      fail(`npm package version ${version} already exists`);
    }
  }
  if (
    maintainers.length !== 1 ||
    maintainers[0] === null ||
    typeof maintainers[0] !== "object" ||
    typeof maintainers[0].name !== "string" ||
    maintainers[0].name.toLowerCase() !== EXPECTED_NPM_MAINTAINER
  ) {
    fail("npm package name is registered to an unexpected maintainer");
  }
  return Object.freeze({ state: "owned" });
}

function parseArguments(arguments_) {
  if (arguments_.length === 0) return "check";
  if (arguments_.length !== 1) {
    fail(
      "usage: verify-release.mjs [--check-only|--prepare-only|--release|--bundle-release|--artifacts-preflight]",
    );
  }
  const modes = new Map([
    ["--artifacts-preflight", "artifacts-preflight"],
    ["--bundle-release", "bundle-release"],
    ["--check-only", "check"],
    ["--prepare-only", "prepare"],
    ["--release", "release"],
  ]);
  const mode = modes.get(arguments_[0]);
  if (mode === undefined) {
    fail(
      "usage: verify-release.mjs [--check-only|--prepare-only|--release|--bundle-release|--artifacts-preflight]",
    );
  }
  return mode;
}

async function removeOwnedDirectory(root, relativePath) {
  const path = repositoryPath(root, relativePath);
  const metadata = await optionalLstat(path);
  if (metadata === undefined) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${relativePath} must be a real directory`);
  }
  const canonical = await realpath(path);
  if (!inside(root, canonical) || !samePath(canonical, path)) {
    fail(`${relativePath} must not traverse a symbolic link`);
  }
  await rm(canonical, { recursive: true });
}

export async function prepareBuildOutput(root) {
  await removeOwnedDirectory(root, "dist");
}

async function build(root) {
  await prepareBuildOutput(root);
  const compiler = repositoryPath(root, "node_modules/typescript/bin/tsc");
  const compilerMetadata = await lstat(compiler);
  const canonicalCompiler = await realpath(compiler);
  if (
    compilerMetadata.isSymbolicLink() ||
    !compilerMetadata.isFile() ||
    !inside(root, canonicalCompiler) ||
    !samePath(canonicalCompiler, compiler)
  ) {
    fail("the pinned TypeScript compiler is unavailable");
  }
  await run(
    process.execPath,
    [compiler, "-p", repositoryPath(root, "tsconfig.build.json")],
    {
      cwd: root,
      label: "release build failed",
    },
  );
  const dist = repositoryPath(root, "dist");
  const distMetadata = await lstat(dist);
  const canonicalDist = await realpath(dist);
  if (
    distMetadata.isSymbolicLink() ||
    !distMetadata.isDirectory() ||
    !inside(root, canonicalDist) ||
    !samePath(canonicalDist, dist)
  ) {
    fail("release build output must be a real repository directory");
  }
}

async function removeChecksumOutput(root) {
  const checksum = repositoryPath(root, "SHA256SUMS");
  const metadata = await optionalLstat(checksum);
  if (metadata === undefined) return;
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    fail("SHA256SUMS must not be a directory or special file");
  }
  await rm(checksum);
}

export async function prepareArtifactDirectory(root) {
  await removeOwnedDirectory(root, "artifacts");
  const artifacts = repositoryPath(root, "artifacts");
  await mkdir(artifacts, { mode: 0o700 });
  const metadata = await lstat(artifacts);
  const canonical = await realpath(artifacts);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !inside(root, canonical) ||
    !samePath(canonical, artifacts)
  ) {
    fail("artifacts must be a real directory");
  }
  await removeChecksumOutput(root);
  return canonical;
}

async function gitRevision(root) {
  return (
    await run("git", ["rev-parse", "HEAD"], {
      cwd: root,
      label: "release revision check failed",
      timeout: 10_000,
    })
  ).stdout.trim();
}

export function validateSbom(source, metadata) {
  let parsed;
  try {
    parsed = record(JSON.parse(source), "CycloneDX SBOM");
  } catch (error) {
    throw new Error("release SBOM is invalid JSON", { cause: error });
  }
  const component = record(
    record(parsed.metadata, "SBOM metadata").component,
    "SBOM root component",
  );
  if (
    parsed.bomFormat !== "CycloneDX" ||
    typeof parsed.specVersion !== "string" ||
    component.version !== metadata.version ||
    component.purl !== `pkg:npm/${metadata.name}@${metadata.version}`
  ) {
    fail("release SBOM identity does not match the package");
  }
}

function validateRequirementsArtifact(artifact) {
  if (
    artifact.schema_version !== "1" ||
    artifact.total !== 80 ||
    artifact.verified !== 80 ||
    artifact.release_mode !== true ||
    !Array.isArray(artifact.requirements) ||
    artifact.requirements.length !== 80
  ) {
    fail("release requirement evidence is incomplete");
  }
}

function validateReleaseManifest(value, expected) {
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    !exactStringArray(keys, expectedKeys) ||
    expectedKeys.some((key) => value[key] !== expected[key])
  ) {
    fail("release manifest does not match the verified release");
  }
}

async function writeFreshJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function assertRegularExactPath(path, label) {
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !samePath(canonical, path)
  ) {
    fail(`${label} must be a regular file at its exact path`);
  }
}

async function prepareArtifacts(root, metadata) {
  const artifacts = await prepareArtifactDirectory(root);
  const bundle = repositoryPath(root, "artifacts/release-bundle");
  await mkdir(bundle, { mode: 0o700 });
  const canonicalBundle = await realpath(bundle);
  if (
    !inside(artifacts, canonicalBundle) ||
    !samePath(bundle, canonicalBundle)
  ) {
    fail("release bundle must be a real artifacts subdirectory");
  }

  const tarballName = `${metadata.name}-${metadata.version}.tgz`;
  const tarball = repositoryPath(
    root,
    `artifacts/release-bundle/${tarballName}`,
  );
  const sbomPath = repositoryPath(
    root,
    "artifacts/release-bundle/github-stars-mcp.cdx.json",
  );
  const requirementsPath = repositoryPath(
    root,
    "artifacts/release-bundle/requirements.json",
  );
  const manifestPath = repositoryPath(
    root,
    "artifacts/release-bundle/release-manifest.json",
  );
  const checksumsPath = repositoryPath(
    root,
    "artifacts/release-bundle/SHA256SUMS",
  );

  await run(
    process.execPath,
    [repositoryPath(root, "scripts/verify-requirements.mjs"), "--release"],
    { cwd: root, label: "release requirement verification failed" },
  );
  const requirementsSource = repositoryPath(
    root,
    "artifacts/requirements.json",
  );
  await assertRegularExactPath(
    requirementsSource,
    "release requirement evidence",
  );
  const requirements = await readJson(
    requirementsSource,
    "release requirement evidence",
  );
  validateRequirementsArtifact(requirements);
  await rename(requirementsSource, requirementsPath);

  const sbom = await run(
    npmCommand(),
    npmArguments(["sbom", "--sbom-format", "cyclonedx", "--omit=dev"]),
    {
      cwd: root,
      label: "release SBOM generation failed",
    },
  );
  validateSbom(sbom.stdout, metadata);
  await writeFile(sbomPath, sbom.stdout, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  const packed = await run(
    npmCommand(),
    npmArguments([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      canonicalBundle,
    ]),
    { cwd: root, label: "release package creation failed" },
  );
  let packReport;
  try {
    packReport = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error("npm pack returned invalid JSON", { cause: error });
  }
  if (
    !Array.isArray(packReport) ||
    packReport.length !== 1 ||
    record(packReport[0], "npm pack report").filename !== tarballName
  ) {
    fail("npm pack did not report the exact release tarball");
  }
  const tarballs = (await readdir(bundle))
    .filter((name) => name.endsWith(".tgz"))
    .sort();
  if (!exactStringArray(tarballs, [tarballName])) {
    fail("release preparation must produce exactly one tarball");
  }
  await assertRegularExactPath(tarball, "release tarball");
  const verificationChecksumPath = repositoryPath(
    root,
    "artifacts/release-bundle/.verified-tarball.sha256",
  );
  const verificationChecksum = await writeChecksums([tarball], {
    outputPath: verificationChecksumPath,
  });
  await run(
    process.execPath,
    [repositoryPath(root, "scripts/verify-package.mjs"), "--tarball", tarball],
    { cwd: root, label: "exact release tarball verification failed" },
  );
  await rm(verificationChecksumPath);

  const commitSha = await gitRevision(root);
  if (!REVISION.test(commitSha)) fail("release commit is invalid");
  const manifest = Object.freeze({
    schemaVersion: 1,
    name: metadata.name,
    version: metadata.version,
    commitSha,
    gitRef: `refs/tags/v${metadata.version}`,
    tarball: tarballName,
    sbom: "github-stars-mcp.cdx.json",
    requirements: "requirements.json",
  });
  await writeFreshJson(manifestPath, manifest);

  const checksums = await writeChecksums(
    [tarball, sbomPath, requirementsPath, manifestPath],
    {
      outputPath: checksumsPath,
    },
  );
  const tarballChecksum = checksums.lines.find((line) =>
    line.endsWith(`  ${tarballName}`),
  );
  if (tarballChecksum !== verificationChecksum.lines[0]) {
    fail("release tarball changed after isolated verification");
  }
  validateSbom(await readFile(sbomPath, "utf8"), metadata);
  validateRequirementsArtifact(
    await readJson(requirementsPath, "release requirement evidence"),
  );
  validateReleaseManifest(
    await readJson(manifestPath, "release manifest"),
    manifest,
  );
  const expectedFiles = [
    "SHA256SUMS",
    "github-stars-mcp.cdx.json",
    "release-manifest.json",
    "requirements.json",
    tarballName,
  ].sort();
  const actualFiles = (await readdir(bundle)).sort();
  if (!exactStringArray(actualFiles, expectedFiles)) {
    fail("release bundle must contain exactly five approved artifacts");
  }
  return Object.freeze({
    bundle: relative(root, bundle).replaceAll("\\", "/"),
    tarball: relative(root, tarball).replaceAll("\\", "/"),
    sbom: relative(root, sbomPath).replaceAll("\\", "/"),
    requirements: relative(root, requirementsPath).replaceAll("\\", "/"),
    manifest: relative(root, manifestPath).replaceAll("\\", "/"),
    checksums: relative(root, checksums.outputPath).replaceAll("\\", "/"),
  });
}

async function main() {
  const mode = parseArguments(process.argv.slice(2));
  const root = await realpath(resolve("."));
  await assertCleanRepository(root);
  if (mode === "artifacts-preflight") {
    const artifacts = await prepareArtifactDirectory(root);
    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        mode,
        artifacts: relative(root, artifacts).replaceAll("\\", "/"),
        published: false,
      })}\n`,
    );
    return;
  }
  await build(root);
  const metadata = await verifyReleaseMetadata({ root });
  const registry = await verifyNpmPackageName(metadata.name, metadata.version);
  if (mode === "release" || mode === "bundle-release") {
    await assertExactTag(root, metadata.version);
  }
  const artifacts =
    mode === "prepare" || mode === "bundle-release"
      ? await prepareArtifacts(root, metadata)
      : undefined;
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      mode,
      version: metadata.version,
      npm_name: registry.state,
      ...(artifacts === undefined ? {} : { artifacts }),
      published: false,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Release verification failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }\n`,
    );
    process.exitCode = 1;
  }
}
