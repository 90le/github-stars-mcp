import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

const REPOSITORY_ROOT = resolve(".");
const PLUGIN_ROOT = resolve("plugins/github-stars-mcp");
const MARKETPLACE_PATH = resolve(".agents/plugins/marketplace.json");
const PACKAGE_PATH = resolve("package.json");
const BASE_CONFIG_PATH = resolve("tsconfig.json");
const BUILD_CONFIG_PATH = resolve("tsconfig.build.json");
const SOURCE_ROOT = resolve("src");
const DIST_ROOT = resolve("dist");
const SKILL_PATH = resolve(PLUGIN_ROOT, "skills/manage-github-stars/SKILL.md");
const EXPECTED_ENV = Object.freeze([
  "GITHUB_STARS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_HOST",
  "GITHUB_STARS_MCP_DATA_DIR",
  "GITHUB_STARS_MCP_READ_ONLY",
  "GITHUB_STARS_MCP_AUTH_MODE",
  "GITHUB_STARS_MCP_LOG_LEVEL",
  "GITHUB_STARS_MCP_MAX_READ_CONCURRENCY",
  "GITHUB_STARS_MCP_WRITE_INTERVAL_MS",
  "GITHUB_STARS_MCP_MAX_PLAN_ACTIONS",
  "GITHUB_STARS_MCP_PLAN_TTL_MINUTES",
]);
const PRESENTATION_EXTENSIONS = new Set([".json", ".md", ".yaml", ".yml"]);
const ASSET_EXTENSIONS = new Set([".png"]);
const ALLOWED_PLUGIN_EXTENSIONS = new Set([
  ...PRESENTATION_EXTENSIONS,
  ...ASSET_EXTENSIONS,
]);
const REQUIRED_PLUGIN_FILES = new Set([
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "skills/manage-github-stars/SKILL.md",
]);
const EXPECTED_PACKAGE_FILES = Object.freeze([
  "dist",
  "plugins/github-stars-mcp",
  "README.md",
  "LICENSE",
]);
const BUILD_CONFIG_KEYS = new Set([
  "compilerOptions",
  "exclude",
  "extends",
  "include",
]);
const BUILD_COMPILER_OPTION_KEYS = new Set([
  "declaration",
  "noEmit",
  "outDir",
  "rootDir",
  "sourceMap",
]);
const MANIFEST_KEYS = new Set([
  "author",
  "description",
  "homepage",
  "interface",
  "keywords",
  "license",
  "mcpServers",
  "name",
  "repository",
  "skills",
  "version",
]);
const INTERFACE_KEYS = new Set([
  "brandColor",
  "capabilities",
  "category",
  "composerIcon",
  "defaultPrompt",
  "developerName",
  "displayName",
  "logo",
  "logoDark",
  "longDescription",
  "privacyPolicyURL",
  "screenshots",
  "shortDescription",
  "termsOfServiceURL",
  "websiteURL",
]);
const STATIC_ONLY_ARGUMENT = "--static-only";
let canonicalRepositoryRoot;
let canonicalPluginRoot;

class ValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ValidationError(code);
}

function assert(condition, code) {
  if (!condition) fail(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, code) {
  assert(isPlainObject(value), code);
  return value;
}

function assertExactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    actual.length === expected.length &&
      actual.every((entry, index) => entry === expected[index]),
    code,
  );
}

function assertAllowedKeys(value, keys, code) {
  assert(
    Object.keys(value).every((key) => keys.has(key)),
    code,
  );
}

function assertExactArray(value, expected, code) {
  assert(
    Array.isArray(value) &&
      value.length === expected.length &&
      value.every((entry, index) => entry === expected[index]),
    code,
  );
}

async function readJson(path, code) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    fail(`${code}_MISSING`);
  }
  try {
    return assertPlainObject(JSON.parse(source), `${code}_ROOT`);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(`${code}_JSON`);
  }
}

function isInside(root, path, allowRoot = false) {
  const pathFromRoot = relative(root, path);
  return (
    (allowRoot && pathFromRoot === "") ||
    (pathFromRoot !== "" &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !pathFromRoot.startsWith("../") &&
      !pathFromRoot.startsWith("..\\"))
  );
}

async function fileMetadata(path, code) {
  try {
    return await lstat(path);
  } catch {
    fail(`${code}_MISSING`);
  }
}

async function canonicalPath(path, code) {
  try {
    return await realpath(path);
  } catch {
    fail(`${code}_CANONICAL`);
  }
}

async function assertRepositoryPath(path, code) {
  assert(isInside(REPOSITORY_ROOT, path, true), `${code}_BOUNDARY`);
  const pathFromRoot = relative(REPOSITORY_ROOT, path);
  let current = REPOSITORY_ROOT;
  if (pathFromRoot !== "") {
    for (const segment of pathFromRoot.split(/[\\/]/u)) {
      current = join(current, segment);
      const metadata = await fileMetadata(current, code);
      assert(!metadata.isSymbolicLink(), `${code}_LINK`);
    }
  }
  const canonical = await canonicalPath(path, code);
  assert(
    typeof canonicalRepositoryRoot === "string" &&
      isInside(canonicalRepositoryRoot, canonical, true),
    `${code}_CANONICAL_BOUNDARY`,
  );
  return { canonical, metadata: await fileMetadata(path, code) };
}

async function assertPluginPath(path, code) {
  assert(isInside(PLUGIN_ROOT, path), `${code}_BOUNDARY`);
  const result = await assertRepositoryPath(path, code);
  assert(
    typeof canonicalPluginRoot === "string" &&
      isInside(canonicalPluginRoot, result.canonical),
    `${code}_CANONICAL_BOUNDARY`,
  );
  return result.metadata;
}

async function assertPluginReference(reference, expectedKind, code) {
  assert(
    typeof reference === "string" &&
      reference.startsWith("./") &&
      !reference.includes("\\") &&
      !reference.includes("\0"),
    `${code}_FORMAT`,
  );
  const target = resolve(PLUGIN_ROOT, reference);
  const metadata = await assertPluginPath(target, code);
  assert(
    expectedKind === "directory" ? metadata.isDirectory() : metadata.isFile(),
    `${code}_KIND`,
  );
}

async function assertManifestAssetReference(reference, code) {
  assert(
    typeof reference === "string" &&
      reference.startsWith("./assets/") &&
      reference.toLowerCase().endsWith(".png"),
    `${code}_FORMAT`,
  );
  const target = resolve(PLUGIN_ROOT, reference);
  const relativePath = relative(PLUGIN_ROOT, target).replaceAll("\\", "/");
  assert(reference === `./${relativePath}`, `${code}_FORMAT`);
  await assertPluginReference(reference, "file", code);
  return relativePath;
}

async function assertPluginFile(path, code) {
  const metadata = await assertPluginPath(path, code);
  assert(metadata.isFile(), `${code}_KIND`);
  assert(metadata.size <= 1_048_576, `${code}_SIZE`);
}

async function collectPluginTree(directory = PLUGIN_ROOT) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("PLUGIN_TREE_MISSING");
  }
  const files = [];
  const directories = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    const path = resolve(directory, entry.name);
    const metadata = await assertPluginPath(path, "PLUGIN_TREE");
    if (metadata.isDirectory()) {
      directories.push(path);
      const nested = await collectPluginTree(path);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else {
      assert(metadata.isFile(), "PLUGIN_TREE_ENTRY_KIND");
      assert(metadata.size <= 1_048_576, "PLUGIN_FILE_TOO_LARGE");
      files.push(path);
    }
  }
  return { directories, files };
}

function parseSkillFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert(match !== null, "SKILL_FRONTMATTER");
  const result = Object.create(null);
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    assert(separator > 0, "SKILL_FRONTMATTER_LINE");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    assert(key.length > 0 && value.length > 0, "SKILL_FRONTMATTER_VALUE");
    assert(result[key] === undefined, "SKILL_FRONTMATTER_DUPLICATE");
    result[key] = value;
  }
  return result;
}

async function validateManifest() {
  const manifestPath = resolve(PLUGIN_ROOT, ".codex-plugin/plugin.json");
  await assertPluginFile(manifestPath, "MANIFEST_PATH");
  const manifest = await readJson(manifestPath, "MANIFEST");
  assert(manifest.apps === undefined, "MANIFEST_APPS");
  assertAllowedKeys(manifest, MANIFEST_KEYS, "MANIFEST_KEYS");
  assert(manifest.name === "github-stars-mcp", "MANIFEST_NAME");
  assert(manifest.version === "1.0.0", "MANIFEST_VERSION");
  assert(manifest.license === "Apache-2.0", "MANIFEST_LICENSE");
  assert(
    manifest.repository === "https://github.com/90le/github-stars-mcp",
    "MANIFEST_REPOSITORY",
  );
  assert(
    typeof manifest.description === "string" &&
      manifest.description.includes("GitHub Stars") &&
      manifest.description.includes("User Lists"),
    "MANIFEST_DESCRIPTION",
  );
  const author = assertPlainObject(manifest.author, "MANIFEST_AUTHOR");
  assertAllowedKeys(
    author,
    new Set(["email", "name", "url"]),
    "MANIFEST_AUTHOR_KEYS",
  );
  assert(author.name === "90le", "MANIFEST_AUTHOR_NAME");
  assert(author.url === "https://github.com/90le", "MANIFEST_AUTHOR_URL");
  await assertPluginReference(manifest.skills, "directory", "MANIFEST_SKILLS");
  await assertPluginReference(manifest.mcpServers, "file", "MANIFEST_MCP");

  const interfaceMetadata = assertPlainObject(
    manifest.interface,
    "MANIFEST_INTERFACE",
  );
  assertAllowedKeys(
    interfaceMetadata,
    INTERFACE_KEYS,
    "MANIFEST_INTERFACE_KEYS",
  );
  const assets = new Set();
  for (const key of ["composerIcon", "logo", "logoDark"]) {
    if (interfaceMetadata[key] !== undefined) {
      assets.add(
        await assertManifestAssetReference(
          interfaceMetadata[key],
          `MANIFEST_ASSET_${key.toUpperCase()}`,
        ),
      );
    }
  }
  if (interfaceMetadata.screenshots !== undefined) {
    assert(
      Array.isArray(interfaceMetadata.screenshots) &&
        interfaceMetadata.screenshots.length <= 20,
      "MANIFEST_ASSET_SCREENSHOTS",
    );
    for (const screenshot of interfaceMetadata.screenshots) {
      assets.add(
        await assertManifestAssetReference(
          screenshot,
          "MANIFEST_ASSET_SCREENSHOT",
        ),
      );
    }
  }
  return assets;
}

async function validateMcpConfiguration() {
  const configurationPath = resolve(PLUGIN_ROOT, ".mcp.json");
  await assertPluginFile(configurationPath, "MCP_CONFIG_PATH");
  const configuration = await readJson(configurationPath, "MCP_CONFIG");
  assertExactKeys(configuration, ["mcpServers"], "MCP_CONFIG_KEYS");
  const servers = assertPlainObject(configuration.mcpServers, "MCP_SERVERS");
  assertExactKeys(servers, ["github-stars-mcp"], "MCP_SERVER_NAMES");
  const server = assertPlainObject(servers["github-stars-mcp"], "MCP_SERVER");
  assertExactKeys(
    server,
    ["args", "command", "env_vars", "tool_timeout_sec"],
    "MCP_SERVER_KEYS",
  );
  assert(server.command === "npx", "MCP_COMMAND");
  assertExactArray(
    server.args,
    ["-y", "github-stars-mcp@1.0.0", "--stdio"],
    "MCP_ARGS",
  );
  assertExactArray(server.env_vars, EXPECTED_ENV, "MCP_ENV");
  assert(server.tool_timeout_sec === 900, "MCP_TIMEOUT");
}

async function validateMarketplace() {
  const marketplace = await readJson(MARKETPLACE_PATH, "MARKETPLACE");
  assertExactKeys(
    marketplace,
    ["interface", "name", "plugins"],
    "MARKETPLACE_KEYS",
  );
  assert(marketplace.name === "personal", "MARKETPLACE_CATALOG_NAME");
  const marketplaceInterface = assertPlainObject(
    marketplace.interface,
    "MARKETPLACE_INTERFACE",
  );
  assertExactKeys(
    marketplaceInterface,
    ["displayName"],
    "MARKETPLACE_INTERFACE_KEYS",
  );
  assert(
    marketplaceInterface.displayName === "Personal",
    "MARKETPLACE_DISPLAY_NAME",
  );
  const plugins = marketplace.plugins;
  assert(Array.isArray(plugins) && plugins.length === 1, "MARKETPLACE_PLUGINS");
  const entry = assertPlainObject(plugins[0], "MARKETPLACE_ENTRY");
  assertExactKeys(
    entry,
    ["category", "name", "policy", "source"],
    "MARKETPLACE_ENTRY_KEYS",
  );
  assert(entry.name === "github-stars-mcp", "MARKETPLACE_NAME");
  assert(entry.category === "Developer Tools", "MARKETPLACE_CATEGORY");
  const source = assertPlainObject(entry.source, "MARKETPLACE_SOURCE");
  assertExactKeys(source, ["path", "source"], "MARKETPLACE_SOURCE_KEYS");
  assert(source.source === "local", "MARKETPLACE_SOURCE_KIND");
  assert(
    source.path === "./plugins/github-stars-mcp",
    "MARKETPLACE_SOURCE_PATH",
  );
  const policy = assertPlainObject(entry.policy, "MARKETPLACE_POLICY");
  assertExactKeys(
    policy,
    ["authentication", "installation"],
    "MARKETPLACE_POLICY_KEYS",
  );
  assert(policy.installation === "AVAILABLE", "MARKETPLACE_INSTALLATION");
  assert(policy.authentication === "ON_INSTALL", "MARKETPLACE_AUTHENTICATION");
}

async function validateSkill() {
  await assertPluginFile(SKILL_PATH, "SKILL_PATH");
  let source;
  try {
    source = await readFile(SKILL_PATH, "utf8");
  } catch {
    fail("SKILL_MISSING");
  }
  const frontmatter = parseSkillFrontmatter(source);
  assertExactKeys(frontmatter, ["description", "name"], "SKILL_KEYS");
  assert(frontmatter.name === "manage-github-stars", "SKILL_NAME");
  assert(frontmatter.description.startsWith("Use when "), "SKILL_DESCRIPTION");

  const normalized = source.toLowerCase();
  for (const required of [
    "github_stars_status",
    "github_stars_sync",
    "github_stars_query",
    "github_repositories_discover",
    "github_changes_plan",
    "github_changes_inspect",
    "github_changes_apply",
    "github_changes_rollback",
    "next_cursor",
    "protected",
    "explicit authorization",
    "repository deletion",
    "content changes",
    "audit",
  ]) {
    assert(normalized.includes(required), "SKILL_WORKFLOW");
  }
  assert(
    !/extract.*cookie|broad.*token|classic token/iu.test(source),
    "SKILL_UNSAFE_AUTH",
  );
}

function hasBytes(contents, offset, expected) {
  return expected.every((value, index) => contents[offset + index] === value);
}

function pngCrc32(contents, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= contents[offset];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(contents) {
  if (
    !hasBytes(contents, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return false;
  }

  let offset = 8;
  let chunkIndex = 0;
  let seenIhdr = false;
  let seenIdat = false;
  let seenIend = false;
  while (offset < contents.length) {
    if (seenIend || contents.length - offset < 12) return false;
    const length = contents.readUInt32BE(offset);
    if (length > contents.length - offset - 12) return false;

    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcStart = dataStart + length;
    const nextOffset = crcStart + 4;
    const type = contents.subarray(typeStart, dataStart).toString("ascii");
    if (
      !/^[A-Za-z]{4}$/u.test(type) ||
      pngCrc32(contents, typeStart, crcStart) !==
        contents.readUInt32BE(crcStart)
    ) {
      return false;
    }

    if (type === "IHDR") {
      if (chunkIndex !== 0 || seenIhdr || length !== 13) return false;
      seenIhdr = true;
    } else if (chunkIndex === 0) {
      return false;
    }

    if (type === "IDAT") seenIdat = true;
    if (type === "IEND") {
      if (seenIend || length !== 0 || nextOffset !== contents.length) {
        return false;
      }
      seenIend = true;
    }

    offset = nextOffset;
    chunkIndex += 1;
  }
  return seenIhdr && seenIdat && seenIend;
}

function validAsset(contents, extension) {
  return extension === ".png" && validPng(contents);
}

function pluginRelativePath(path) {
  return relative(PLUGIN_ROOT, path).replaceAll("\\", "/");
}

function parentDirectories(paths) {
  const directories = new Set();
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      directories.add(current);
    }
  }
  return directories;
}

async function validatePluginTree(assets) {
  const { directories, files } = await collectPluginTree();
  assert(files.length > 0, "PLUGIN_EMPTY");
  for (const path of files) {
    const extension = extname(path).toLowerCase();
    const metadata = await fileMetadata(path, "PLUGIN_FILE");
    const contents = await readFile(path);
    const source = contents.toString("utf8");
    assert(!containsCredentialMaterial(contents), "PLUGIN_CREDENTIAL_VALUE");
    assert(
      ALLOWED_PLUGIN_EXTENSIONS.has(extension) &&
        (metadata.mode & 0o111) === 0 &&
        !(contents[0] === 0x23 && contents[1] === 0x21) &&
        !(contents[0] === 0x4d && contents[1] === 0x5a) &&
        !(
          contents[0] === 0x7f &&
          contents[1] === 0x45 &&
          contents[2] === 0x4c &&
          contents[3] === 0x46
        ) &&
        !(
          contents[0] === 0x00 &&
          contents[1] === 0x61 &&
          contents[2] === 0x73 &&
          contents[3] === 0x6d
        ),
      "PLUGIN_RUNTIME_SOURCE",
    );
    if (ASSET_EXTENSIONS.has(extension)) {
      assert(validAsset(contents, extension), "PLUGIN_ASSET_FORMAT");
    }
    if (PRESENTATION_EXTENSIONS.has(extension)) {
      assert(!/\b(?:TODO|TBD)\b/u.test(source), "PLUGIN_PLACEHOLDER");
    }
  }

  const expectedFiles = new Set([...REQUIRED_PLUGIN_FILES, ...assets]);
  const actualFiles = files.map(pluginRelativePath);
  assert(
    actualFiles.length === expectedFiles.size &&
      actualFiles.every((path) => expectedFiles.has(path)),
    "PLUGIN_TREE_CONTENTS",
  );

  const requiredDirectories = parentDirectories(expectedFiles);
  const allowedDirectories = new Set(requiredDirectories);
  allowedDirectories.add("assets");
  const actualDirectories = directories.map(pluginRelativePath);
  assert(
    actualDirectories.every((path) => allowedDirectories.has(path)) &&
      [...requiredDirectories].every((path) =>
        actualDirectories.includes(path),
      ),
    "PLUGIN_TREE_DIRECTORIES",
  );
}

function validateArguments() {
  const arguments_ = process.argv.slice(2);
  assert(
    arguments_.length === 0 ||
      (arguments_.length === 1 && arguments_[0] === STATIC_ONLY_ARGUMENT),
    "ARGUMENTS",
  );
  return arguments_[0] === STATIC_ONLY_ARGUMENT;
}

async function validateRepositoryBoundary() {
  const rootMetadata = await fileMetadata(REPOSITORY_ROOT, "REPOSITORY_ROOT");
  assert(rootMetadata.isDirectory(), "REPOSITORY_ROOT_KIND");
  assert(!rootMetadata.isSymbolicLink(), "REPOSITORY_ROOT_LINK");
  canonicalRepositoryRoot = await canonicalPath(
    REPOSITORY_ROOT,
    "REPOSITORY_ROOT",
  );

  const pluginFromRepository = relative(REPOSITORY_ROOT, PLUGIN_ROOT);
  const marketplaceFromRepository = relative(REPOSITORY_ROOT, MARKETPLACE_PATH);
  assert(
    pluginFromRepository === "plugins\\github-stars-mcp" ||
      pluginFromRepository === "plugins/github-stars-mcp",
    "PLUGIN_ROOT",
  );
  assert(
    marketplaceFromRepository === ".agents\\plugins\\marketplace.json" ||
      marketplaceFromRepository === ".agents/plugins/marketplace.json",
    "MARKETPLACE_ROOT",
  );

  const plugin = await assertRepositoryPath(PLUGIN_ROOT, "PLUGIN_ROOT");
  assert(plugin.metadata.isDirectory(), "PLUGIN_ROOT_KIND");
  canonicalPluginRoot = plugin.canonical;

  const marketplace = await assertRepositoryPath(
    MARKETPLACE_PATH,
    "MARKETPLACE_PATH",
  );
  assert(marketplace.metadata.isFile(), "MARKETPLACE_PATH_KIND");
  const packageMetadata = await assertRepositoryPath(
    PACKAGE_PATH,
    "PACKAGE_PATH",
  );
  assert(packageMetadata.metadata.isFile(), "PACKAGE_PATH_KIND");
}

async function validatePackageMetadata() {
  const packageMetadata = await readJson(PACKAGE_PATH, "PACKAGE");
  assert(packageMetadata.name === "github-stars-mcp", "PACKAGE_NAME");
  assertExactArray(
    packageMetadata.files,
    EXPECTED_PACKAGE_FILES,
    "PACKAGE_FILES",
  );
}

function parseExternalJson(source, code) {
  try {
    return JSON.parse(source);
  } catch {
    fail(code);
  }
}

async function validateBuildConfig() {
  for (const [path, code] of [
    [BASE_CONFIG_PATH, "BASE_CONFIG"],
    [BUILD_CONFIG_PATH, "BUILD_CONFIG"],
  ]) {
    const result = await assertRepositoryPath(path, code);
    assert(result.metadata.isFile(), `${code}_KIND`);
  }

  const baseConfig = await readJson(BASE_CONFIG_PATH, "BASE_CONFIG");
  const buildConfig = await readJson(BUILD_CONFIG_PATH, "BUILD_CONFIG");
  assert(baseConfig.extends === undefined, "BUILD_CONFIG");
  assertExactKeys(buildConfig, BUILD_CONFIG_KEYS, "BUILD_CONFIG");
  assert(buildConfig.extends === "./tsconfig.json", "BUILD_CONFIG");
  assertExactArray(buildConfig.include, ["src/**/*.ts"], "BUILD_CONFIG");
  assertExactArray(buildConfig.exclude, ["test/**/*.ts"], "BUILD_CONFIG");

  const compilerOptions = assertPlainObject(
    buildConfig.compilerOptions,
    "BUILD_CONFIG",
  );
  assertExactKeys(compilerOptions, BUILD_COMPILER_OPTION_KEYS, "BUILD_CONFIG");
  assert(
    compilerOptions.noEmit === false &&
      compilerOptions.rootDir === "src" &&
      compilerOptions.outDir === "dist" &&
      compilerOptions.declaration === true &&
      compilerOptions.sourceMap === true,
    "BUILD_CONFIG",
  );

  const baseCompilerOptions = assertPlainObject(
    baseConfig.compilerOptions,
    "BASE_CONFIG",
  );
  assert(
    (baseCompilerOptions.allowJs === undefined ||
      baseCompilerOptions.allowJs === false) &&
      (baseCompilerOptions.declarationMap === undefined ||
        baseCompilerOptions.declarationMap === false) &&
      (baseCompilerOptions.emitDeclarationOnly === undefined ||
        baseCompilerOptions.emitDeclarationOnly === false) &&
      (baseCompilerOptions.inlineSourceMap === undefined ||
        baseCompilerOptions.inlineSourceMap === false) &&
      baseCompilerOptions.declarationDir === undefined &&
      baseCompilerOptions.outFile === undefined,
    "BUILD_CONFIG",
  );
}

function canonicalTreeEntryName(name, code) {
  assert(
    name.length > 0 &&
      name !== "." &&
      name !== ".." &&
      !name.includes("/") &&
      !name.includes("\\") &&
      !name.includes("\0") &&
      name.normalize("NFC") === name,
    `${code}_PATH`,
  );
}

async function collectCanonicalRegularFiles(root, code) {
  const rootResult = await assertRepositoryPath(root, `${code}_ROOT`);
  assert(rootResult.metadata.isDirectory(), `${code}_ROOT_KIND`);
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail(`${code}_READ`);
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    )) {
      canonicalTreeEntryName(entry.name, code);
      const path = resolve(directory, entry.name);
      const result = await assertRepositoryPath(path, code);
      if (result.metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      assert(result.metadata.isFile(), `${code}_ENTRY_KIND`);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      assert(
        relativePath.length > 0 &&
          resolve(root, ...relativePath.split("/")) === path,
        `${code}_PATH`,
      );
      files.push(relativePath);
    }
  }

  await visit(root);
  return files.sort();
}

function exactPathSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((path, index) => path === sortedExpected[index]);
}

async function validateGeneratedOutputManifest() {
  await validateBuildConfig();
  const sources = await collectCanonicalRegularFiles(
    SOURCE_ROOT,
    "SOURCE_TREE",
  );
  const expected = new Set();
  for (const source of sources) {
    assert(
      source.endsWith(".ts") && !source.endsWith(".d.ts"),
      "SOURCE_TREE_EXTENSION",
    );
    const stem = source.slice(0, -3);
    for (const suffix of [".js", ".js.map", ".d.ts"]) {
      const output = `dist/${stem}${suffix}`;
      assert(!expected.has(output), "SOURCE_OUTPUT_COLLISION");
      expected.add(output);
    }
  }
  assert(expected.size === sources.length * 3, "SOURCE_OUTPUT_COLLISION");
  const expectedPaths = [...expected].sort();
  const actualPaths = (
    await collectCanonicalRegularFiles(DIST_ROOT, "DIST_TREE")
  ).map((path) => `dist/${path}`);
  assert(exactPathSet(actualPaths, expectedPaths), "DIST_TREE_CONTENTS");
  return expectedPaths;
}

function bearerWhitespace(character) {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n"
  );
}

function skipBearerWhitespace(source, start, horizontalOnly = false) {
  let index = start;
  while (
    source[index] === " " ||
    source[index] === "\t" ||
    (!horizontalOnly && (source[index] === "\r" || source[index] === "\n"))
  ) {
    index += 1;
  }
  return index;
}

function bearerTokenCharacter(character) {
  if (typeof character !== "string" || character.length !== 1) return false;
  return /[A-Za-z0-9._~+/-]/u.test(character);
}

function decodedHexEscape(source, start, digits) {
  const encoded = source.slice(start, start + digits);
  if (encoded.length !== digits || !/^[0-9A-Fa-f]+$/u.test(encoded)) {
    return null;
  }
  return Number.parseInt(encoded, 16);
}

function decodedStringEscape(source, start) {
  const marker = source[start + 1];
  if (marker === undefined) return { value: "\\", length: 1 };

  if (marker === "u" && source[start + 2] === "{") {
    const close = source.indexOf("}", start + 3);
    if (close !== -1) {
      const digits = close - start - 3;
      const codePoint =
        digits >= 1 && digits <= 6
          ? decodedHexEscape(source, start + 3, digits)
          : null;
      if (codePoint !== null && codePoint <= 0x10ffff) {
        return {
          value: String.fromCodePoint(codePoint),
          length: close - start + 1,
        };
      }
    }
    return { value: "\\u", length: 2 };
  }

  if (marker === "u" || marker === "x") {
    const digits = marker === "u" ? 4 : 2;
    const codePoint = decodedHexEscape(source, start + 2, digits);
    return codePoint === null
      ? { value: `\\${marker}`, length: 2 }
      : { value: String.fromCodePoint(codePoint), length: digits + 2 };
  }

  if (marker === "\r") {
    return {
      value: "",
      length: source[start + 2] === "\n" ? 3 : 2,
    };
  }
  if (marker === "\n") return { value: "", length: 2 };

  const simpleEscapes = {
    0: "\0",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
    "'": "'",
    "`": "`",
    "/": "/",
  };
  return {
    value: Object.hasOwn(simpleEscapes, marker)
      ? simpleEscapes[marker]
      : marker,
    length: 2,
  };
}

function quoteCharacter(character) {
  return character === '"' || character === "'" || character === "`";
}

function readQuotedLiteral(source, start) {
  const quote = source[start];
  if (!quoteCharacter(quote)) return null;
  let value = "";
  for (let index = start + 1; index < source.length; ) {
    if (source[index] === quote) {
      return { value, end: index + 1, terminated: true };
    }
    if (source[index] === "\\") {
      const escape = decodedStringEscape(source, index);
      value += escape.value;
      index += escape.length;
      continue;
    }
    value += source[index];
    index += 1;
  }
  return { value, end: source.length, terminated: false };
}

function bearerCredentialEnd(source, start) {
  let index = skipBearerWhitespace(source, start);
  if (source.slice(index, index + 6).toLowerCase() !== "bearer") return null;
  index += 6;
  if (!bearerWhitespace(source[index])) return null;
  index = skipBearerWhitespace(source, index);

  if (!bearerTokenCharacter(source[index])) return null;
  while (bearerTokenCharacter(source[index])) index += 1;
  while (source[index] === "=") index += 1;
  return index;
}

function completeBearerValue(source, start, allowComment = false) {
  const end = bearerCredentialEnd(source, start);
  if (end === null) return false;
  const tail = skipBearerWhitespace(source, end);
  return tail === source.length || (allowComment && source[tail] === "#");
}

function readConfigKey(source, start) {
  const literal = readQuotedLiteral(source, start);
  if (literal !== null) {
    if (!literal.terminated) return null;
    return { key: literal.value, end: literal.end };
  }
  const match = /^[A-Za-z_][A-Za-z0-9_.-]*/u.exec(source.slice(start));
  return match === null
    ? null
    : { key: match[0], end: start + match[0].length };
}

function bearerConfigKey(key) {
  const normalized = key.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "token" ||
    normalized.endsWith("token")
  );
}

function configValueContainsBearer(source, start) {
  const index = skipBearerWhitespace(source, start, true);
  const literal = readQuotedLiteral(source, index);
  return literal === null
    ? completeBearerValue(source, index, true)
    : completeBearerValue(literal.value, 0);
}

function configEntryContainsBearer(line, start) {
  const index = skipBearerWhitespace(line, start, true);
  const key = readConfigKey(line, index);
  if (key === null || !bearerConfigKey(key.key)) return false;
  const valueSeparator = skipBearerWhitespace(line, key.end, true);
  if (line[valueSeparator] === ":" || line[valueSeparator] === "=") {
    return configValueContainsBearer(line, valueSeparator + 1);
  }
  if (valueSeparator > key.end) {
    return configValueContainsBearer(line, valueSeparator);
  }
  return false;
}

function commentConfigSource(line) {
  const index = skipBearerWhitespace(line, 0, true);
  if (line.slice(index, index + 2) === "//") {
    return line.slice(index + 2);
  }
  if (line.slice(index, index + 2) === "/*") {
    const end = line.indexOf("*/", index + 2);
    return line.slice(index + 2, end === -1 ? line.length : end);
  }
  return line;
}

function configContentStart(line) {
  const index = skipBearerWhitespace(line, 0, true);
  if (
    line.slice(index, index + 6) === "export" &&
    (line[index + 6] === " " || line[index + 6] === "\t")
  ) {
    return skipBearerWhitespace(line, index + 6, true);
  }
  return index;
}

function configLineContainsBearer(line) {
  const source = commentConfigSource(line);
  const index = configContentStart(source);
  if (
    source[index] === "-" &&
    (source[index + 1] === " " || source[index + 1] === "\t")
  ) {
    const valueStart = index + 1;
    return (
      configValueContainsBearer(source, valueStart) ||
      configEntryContainsBearer(source, valueStart)
    );
  }
  return (
    configEntryContainsBearer(source, index) ||
    completeBearerValue(source, index, true)
  );
}

function quotedContentContainsBearer(source, depth) {
  for (let index = 0; index < source.length; index++) {
    const literal = readQuotedLiteral(source, index);
    if (literal === null) continue;
    if (completeBearerValue(literal.value, 0)) return true;
    if (depth < 4 && literalBearerValue(literal.value, depth + 1)) return true;
  }
  return false;
}

function literalBearerValue(source, depth = 0) {
  for (const rawLine of source.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (configLineContainsBearer(line)) return true;
  }
  return quotedContentContainsBearer(source, depth);
}

function containsCredentialMaterial(contents) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    return false;
  }
  if (source.includes("\0")) return false;
  return (
    /github_pat_[A-Za-z0-9_]{4,}/u.test(source) ||
    /gh[pousr]_[A-Za-z0-9_]{4,}/u.test(source) ||
    literalBearerValue(source) ||
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(source)
  );
}

async function readPackedFileIfPresent(path) {
  const target = resolve(REPOSITORY_ROOT, ...path.split("/"));
  try {
    await lstat(target);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    fail("PACKAGE_DRY_RUN_FILE_READ");
  }
  const result = await assertRepositoryPath(target, "PACKAGE_DRY_RUN_FILE");
  assert(result.metadata.isFile(), "PACKAGE_DRY_RUN_FILE_KIND");
  try {
    return await readFile(target);
  } catch {
    fail("PACKAGE_DRY_RUN_FILE_READ");
  }
}

function runExternal(command, arguments_, options, code) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  assert(
    result.error === undefined &&
      result.signal === null &&
      result.status === 0 &&
      typeof result.stdout === "string",
    code,
  );
  return result.stdout;
}

async function validatePackageDryRun(staticOnly, expectedDistPaths) {
  if (staticOnly) return;
  const npmEntry = process.env.npm_execpath;
  if (typeof npmEntry !== "string" || npmEntry.length === 0) return;
  const source = runExternal(
    process.execPath,
    [npmEntry, "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: REPOSITORY_ROOT, env: process.env },
    "PACKAGE_DRY_RUN",
  );
  const result = parseExternalJson(source, "PACKAGE_DRY_RUN_JSON");
  assert(Array.isArray(result) && result.length === 1, "PACKAGE_DRY_RUN_SHAPE");
  const entry = assertPlainObject(result[0], "PACKAGE_DRY_RUN_ENTRY");
  assert(Array.isArray(entry.files), "PACKAGE_DRY_RUN_FILES");
  const paths = entry.files.map((file) => {
    const record = assertPlainObject(file, "PACKAGE_DRY_RUN_FILE");
    assert(typeof record.path === "string", "PACKAGE_DRY_RUN_FILE_PATH");
    return record.path;
  });
  assert(
    new Set(paths).size === paths.length &&
      paths.every((path) => {
        const segments = path.split("/");
        if (
          path.includes("\\") ||
          path.includes("\0") ||
          segments.some(
            (segment) =>
              segment.length === 0 || segment === "." || segment === "..",
          )
        ) {
          return false;
        }
        return (
          path === "package.json" ||
          path === "README.md" ||
          path === "LICENSE" ||
          path.startsWith("dist/") ||
          path.startsWith("plugins/github-stars-mcp/")
        );
      }),
    "PACKAGE_DRY_RUN_CONTENTS",
  );
  assert(
    exactPathSet(
      paths.filter((path) => path.startsWith("dist/")),
      expectedDistPaths,
    ),
    "PACKAGE_DRY_RUN_DIST_CONTENTS",
  );
  for (const path of paths) {
    const contents = await readPackedFileIfPresent(path);
    if (contents !== null) {
      assert(
        !containsCredentialMaterial(contents),
        "PACKAGE_DRY_RUN_SENSITIVE_CONTENT",
      );
    }
  }
  for (const expected of [
    "plugins/github-stars-mcp/.codex-plugin/plugin.json",
    "plugins/github-stars-mcp/.mcp.json",
    "plugins/github-stars-mcp/skills/manage-github-stars/SKILL.md",
  ]) {
    assert(paths.includes(expected), "PACKAGE_DRY_RUN_CONTENTS");
  }
}

async function regularFile(path) {
  try {
    const metadata = await stat(path);
    return metadata.isFile();
  } catch {
    return false;
  }
}

async function findCodexCommand() {
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0);
  for (const directory of pathEntries) {
    if (process.platform === "win32") {
      const executable = join(directory, "codex.exe");
      if (await regularFile(executable)) {
        return Object.freeze({ command: executable, prefix: [] });
      }
      const npmEntry = join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (await regularFile(npmEntry)) {
        return Object.freeze({
          command: process.execPath,
          prefix: [npmEntry],
        });
      }
      continue;
    }

    const executable = join(directory, "codex");
    if (await regularFile(executable)) {
      return Object.freeze({ command: executable, prefix: [] });
    }
  }
  return null;
}

function isolatedEnvironment(home) {
  const environment = {
    ...process.env,
    CODEX_HOME: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_RUNTIME_DIR: join(home, "xdg-runtime"),
    XDG_STATE_HOME: join(home, "xdg-state"),
  };
  for (const key of [
    "GITHUB_STARS_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENAI_API_KEY",
  ]) {
    delete environment[key];
  }
  return environment;
}

function runCodex(command, arguments_, root, home, code) {
  return parseExternalJson(
    runExternal(
      command.command,
      [...command.prefix, ...arguments_],
      {
        cwd: root,
        env: isolatedEnvironment(home),
      },
      code,
    ),
    `${code}_JSON`,
  );
}

async function assertSameCanonicalPath(actual, expected, code) {
  assert(typeof actual === "string" && actual.length > 0, code);
  let actualCanonical;
  let expectedCanonical;
  try {
    [actualCanonical, expectedCanonical] = await Promise.all([
      realpath(actual),
      realpath(expected),
    ]);
  } catch {
    fail(code);
  }
  assert(actualCanonical === expectedCanonical, code);
}

async function validateCodexPluginList(value, expectedSource) {
  const code = "CODEX_PLUGIN_LIST_CONTENTS";
  const result = assertPlainObject(value, code);
  assertExactKeys(result, ["available", "installed"], code);
  assert(
    Array.isArray(result.installed) &&
      result.installed.length === 1 &&
      Array.isArray(result.available) &&
      result.available.length === 0,
    code,
  );
  const plugin = assertPlainObject(result.installed[0], code);
  assert(
    plugin.pluginId === "github-stars-mcp@personal" &&
      plugin.name === "github-stars-mcp" &&
      plugin.marketplaceName === "personal" &&
      plugin.version === "1.0.0" &&
      plugin.installed === true &&
      plugin.enabled === true,
    code,
  );
  const source = assertPlainObject(plugin.source, code);
  assertExactKeys(source, ["path", "source"], code);
  assert(source.source === "local", code);
  await assertSameCanonicalPath(source.path, expectedSource, code);
}

function validateCodexMcp(value) {
  const code = "CODEX_MCP_CONTENTS";
  const server = assertPlainObject(value, code);
  assert(server.name === "github-stars-mcp" && server.enabled === true, code);
  const transport = assertPlainObject(server.transport, code);
  assert(transport.type === "stdio" && transport.command === "npx", code);
  assertExactArray(
    transport.args,
    ["-y", "github-stars-mcp@1.0.0", "--stdio"],
    code,
  );
  assertExactArray(transport.env_vars, EXPECTED_ENV, code);
  assert(server.tool_timeout_sec === 900, code);
}

async function validateWithCodex(staticOnly) {
  if (staticOnly) return;
  const command = await findCodexCommand();
  if (command === null) return;

  const fixture = await mkdtemp(join(tmpdir(), "github-stars-mcp-codex-"));
  const marketplaceRoot = join(fixture, "marketplace");
  const home = join(fixture, "home");
  try {
    await mkdir(join(marketplaceRoot, ".agents/plugins"), {
      recursive: true,
    });
    await mkdir(join(marketplaceRoot, "plugins"), { recursive: true });
    await mkdir(home, { recursive: true });
    await cp(
      MARKETPLACE_PATH,
      join(marketplaceRoot, ".agents/plugins/marketplace.json"),
    );
    await cp(PLUGIN_ROOT, join(marketplaceRoot, "plugins/github-stars-mcp"), {
      recursive: true,
    });

    runCodex(
      command,
      ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
      marketplaceRoot,
      home,
      "CODEX_MARKETPLACE_ADD",
    );
    runCodex(
      command,
      ["plugin", "add", "github-stars-mcp@personal", "--json"],
      marketplaceRoot,
      home,
      "CODEX_PLUGIN_ADD",
    );
    const plugins = runCodex(
      command,
      ["plugin", "list", "--json"],
      marketplaceRoot,
      home,
      "CODEX_PLUGIN_LIST",
    );
    await validateCodexPluginList(
      plugins,
      join(marketplaceRoot, "plugins/github-stars-mcp"),
    );
    const server = runCodex(
      command,
      ["mcp", "get", "github-stars-mcp", "--json"],
      marketplaceRoot,
      home,
      "CODEX_MCP_GET",
    );
    validateCodexMcp(server);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function main() {
  const staticOnly = validateArguments();
  await validateRepositoryBoundary();
  const assets = await validateManifest();
  await validateMcpConfiguration();
  await validateMarketplace();
  await validatePackageMetadata();
  const expectedDistPaths = await validateGeneratedOutputManifest();
  await validateSkill();
  await validatePluginTree(assets);
  await validatePackageDryRun(staticOnly, expectedDistPaths);
  await validateWithCodex(staticOnly);
  process.stdout.write("Validated Codex plugin github-stars-mcp\n");
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof ValidationError ? error.code : "UNEXPECTED_FAILURE";
  process.stderr.write(`Plugin validation failed: ${code}\n`);
  process.exitCode = 1;
}
