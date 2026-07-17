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

const REPOSITORY_ROOT = resolve(".");
const PLUGIN_ROOT = resolve("plugins/github-stars-mcp");
const MARKETPLACE_PATH = resolve(".agents/plugins/marketplace.json");
const PACKAGE_PATH = resolve("package.json");
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
const ASSET_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const ALLOWED_PLUGIN_EXTENSIONS = new Set([
  ...PRESENTATION_EXTENSIONS,
  ...ASSET_EXTENSIONS,
]);
const MANIFEST_KEYS = new Set([
  "apps",
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

async function assertPluginFile(path, code) {
  const metadata = await assertPluginPath(path, code);
  assert(metadata.isFile(), `${code}_KIND`);
  assert(metadata.size <= 1_048_576, `${code}_SIZE`);
}

async function collectPluginFiles(directory = PLUGIN_ROOT) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("PLUGIN_TREE_MISSING");
  }
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    const path = resolve(directory, entry.name);
    const metadata = await assertPluginPath(path, "PLUGIN_TREE");
    if (metadata.isDirectory()) {
      files.push(...(await collectPluginFiles(path)));
    } else {
      assert(metadata.isFile(), "PLUGIN_TREE_ENTRY_KIND");
      assert(metadata.size <= 1_048_576, "PLUGIN_FILE_TOO_LARGE");
      files.push(path);
    }
  }
  return files;
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
  if (manifest.apps !== undefined) {
    await assertPluginReference(manifest.apps, "file", "MANIFEST_APPS");
  }

  const interfaceMetadata = assertPlainObject(
    manifest.interface,
    "MANIFEST_INTERFACE",
  );
  assertAllowedKeys(
    interfaceMetadata,
    INTERFACE_KEYS,
    "MANIFEST_INTERFACE_KEYS",
  );
  for (const key of ["composerIcon", "logo", "logoDark"]) {
    if (interfaceMetadata[key] !== undefined) {
      await assertPluginReference(
        interfaceMetadata[key],
        "file",
        `MANIFEST_ASSET_${key.toUpperCase()}`,
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
      assert(
        typeof screenshot === "string" &&
          screenshot.startsWith("./assets/") &&
          screenshot.toLowerCase().endsWith(".png"),
        "MANIFEST_ASSET_SCREENSHOTS",
      );
      await assertPluginReference(
        screenshot,
        "file",
        "MANIFEST_ASSET_SCREENSHOT",
      );
    }
  }
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

function validAsset(contents, extension) {
  if (extension === ".png") {
    return hasBytes(
      contents,
      0,
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return hasBytes(contents, 0, [0xff, 0xd8, 0xff]);
  }
  if (extension === ".gif") {
    return (
      contents.subarray(0, 6).toString("ascii") === "GIF87a" ||
      contents.subarray(0, 6).toString("ascii") === "GIF89a"
    );
  }
  if (extension === ".webp") {
    return (
      contents.subarray(0, 4).toString("ascii") === "RIFF" &&
      contents.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

async function validatePluginTree() {
  const files = await collectPluginFiles();
  assert(files.length > 0, "PLUGIN_EMPTY");
  for (const path of files) {
    const extension = extname(path).toLowerCase();
    const metadata = await fileMetadata(path, "PLUGIN_FILE");
    const contents = await readFile(path);
    const source = contents.toString("utf8");
    assert(
      !/github_pat_|gh[pousr]_[A-Za-z0-9_]{4,}|authorization\s*:\s*bearer/iu.test(
        source,
      ),
      "PLUGIN_CREDENTIAL_VALUE",
    );
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
  assert(Array.isArray(packageMetadata.files), "PACKAGE_FILES");
  assert(
    packageMetadata.files.includes("plugins/github-stars-mcp") &&
      !packageMetadata.files.includes("plugins"),
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

async function validatePackageDryRun(staticOnly) {
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
  const environment = { ...process.env, CODEX_HOME: home };
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
    assert(
      JSON.stringify(plugins).includes("github-stars-mcp"),
      "CODEX_PLUGIN_LIST_CONTENTS",
    );
    const server = runCodex(
      command,
      ["mcp", "get", "github-stars-mcp", "--json"],
      marketplaceRoot,
      home,
      "CODEX_MCP_GET",
    );
    const serialized = JSON.stringify(server);
    for (const expected of [
      "github-stars-mcp",
      "npx",
      "github-stars-mcp@1.0.0",
      "--stdio",
      "GITHUB_STARS_TOKEN",
      "GITHUB_STARS_MCP_PLAN_TTL_MINUTES",
    ]) {
      assert(serialized.includes(expected), "CODEX_MCP_CONTENTS");
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function main() {
  const staticOnly = validateArguments();
  await validateRepositoryBoundary();
  await validateManifest();
  await validateMcpConfiguration();
  await validateMarketplace();
  await validatePackageMetadata();
  await validateSkill();
  await validatePluginTree();
  await validatePackageDryRun(staticOnly);
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
