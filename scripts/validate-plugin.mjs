import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import process from "node:process";

const REPOSITORY_ROOT = resolve(".");
const PLUGIN_ROOT = resolve("plugins/github-stars-mcp");
const MARKETPLACE_PATH = resolve(".agents/plugins/marketplace.json");
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
const RUNTIME_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const PRESENTATION_EXTENSIONS = new Set([".json", ".md", ".yaml", ".yml"]);

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

function assertInsidePlugin(path, code) {
  const pathFromPlugin = relative(PLUGIN_ROOT, path);
  assert(
    pathFromPlugin !== "" &&
      pathFromPlugin !== ".." &&
      !pathFromPlugin.startsWith(`..\\`) &&
      !pathFromPlugin.startsWith("../") &&
      !resolve(path).startsWith(`${PLUGIN_ROOT}..`),
    code,
  );
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
  assertInsidePlugin(target, `${code}_BOUNDARY`);
  let metadata;
  try {
    metadata = await stat(target);
  } catch {
    fail(`${code}_MISSING`);
  }
  assert(
    expectedKind === "directory" ? metadata.isDirectory() : metadata.isFile(),
    `${code}_KIND`,
  );
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
    assertInsidePlugin(path, "PLUGIN_TREE_BOUNDARY");
    const metadata = await lstat(path);
    assert(!metadata.isSymbolicLink(), "PLUGIN_TREE_SYMLINK");
    if (entry.isDirectory()) {
      files.push(...(await collectPluginFiles(path)));
    } else {
      assert(entry.isFile(), "PLUGIN_TREE_ENTRY_KIND");
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
  const manifest = await readJson(
    resolve(PLUGIN_ROOT, ".codex-plugin/plugin.json"),
    "MANIFEST",
  );
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
  await assertPluginReference(manifest.skills, "directory", "MANIFEST_SKILLS");
  await assertPluginReference(manifest.mcpServers, "file", "MANIFEST_MCP");

  const interfaceMetadata = assertPlainObject(
    manifest.interface,
    "MANIFEST_INTERFACE",
  );
  for (const key of ["logo", "icon"]) {
    if (interfaceMetadata[key] !== undefined) {
      await assertPluginReference(
        interfaceMetadata[key],
        "file",
        `MANIFEST_${key.toUpperCase()}`,
      );
    }
  }
}

async function validateMcpConfiguration() {
  const configuration = await readJson(
    resolve(PLUGIN_ROOT, ".mcp.json"),
    "MCP_CONFIG",
  );
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
  const plugins = marketplace.plugins;
  assert(Array.isArray(plugins) && plugins.length === 1, "MARKETPLACE_PLUGINS");
  const entry = assertPlainObject(plugins[0], "MARKETPLACE_ENTRY");
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

async function validatePluginTree() {
  const files = await collectPluginFiles();
  assert(files.length > 0, "PLUGIN_EMPTY");
  for (const path of files) {
    const extension = extname(path).toLowerCase();
    assert(!RUNTIME_EXTENSIONS.has(extension), "PLUGIN_RUNTIME_SOURCE");
    if (!PRESENTATION_EXTENSIONS.has(extension)) continue;
    const source = await readFile(path, "utf8");
    assert(
      !/github_pat_|gh[pousr]_[A-Za-z0-9_]{4,}|authorization\s*:\s*bearer/iu.test(
        source,
      ),
      "PLUGIN_CREDENTIAL_VALUE",
    );
    assert(!/\b(?:TODO|TBD)\b/u.test(source), "PLUGIN_PLACEHOLDER");
  }
}

async function validateRepositoryBoundary() {
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
}

async function main() {
  await validateRepositoryBoundary();
  await validateManifest();
  await validateMcpConfiguration();
  await validateMarketplace();
  await validateSkill();
  await validatePluginTree();
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
