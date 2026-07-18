import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { generateToolReference } from "./generate-tool-reference.mjs";

const REPOSITORY_ROOT = resolve(".");
const GENERATED_REFERENCE = "docs/tool-reference.md";
const CORE_DOCUMENTS = Object.freeze([
  "README.md",
  "docs/architecture.md",
  "docs/development.md",
  "docs/plugin.md",
  "docs/requirements.md",
  "docs/security.md",
  "docs/troubleshooting.md",
  GENERATED_REFERENCE,
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
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} is unreadable`, { cause: error });
  }
  try {
    return record(JSON.parse(source), label);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("JSON object")) {
      throw error;
    }
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
}

function isInsideRepository(path) {
  const fromRoot = relative(REPOSITORY_ROOT, path);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function linkTarget(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    return closing > 0 ? trimmed.slice(1, closing) : trimmed;
  }
  return trimmed.split(/\s+["']/u, 1)[0];
}

async function verifyLinks(path, source) {
  const prose = source
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/~~~[\s\S]*?~~~/gu, "")
    .replace(/`[^`\r\n]*`/gu, "");
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)\r\n]+)\)/gu)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const target = linkTarget(raw);
    if (
      target.length === 0 ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(target)
    ) {
      continue;
    }
    const filePart = target.split("#", 1)[0];
    if (filePart === undefined || filePart.length === 0) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(filePart);
    } catch {
      fail(`${path} contains an invalid encoded link: ${target}`);
    }
    const resolved = resolve(dirname(path), decoded);
    if (!isInsideRepository(resolved)) {
      fail(`${path} contains a link outside the repository: ${target}`);
    }
    try {
      if (!(await stat(resolved)).isFile()) {
        fail(`${path} links to a non-file path: ${target}`);
      }
    } catch {
      fail(`${path} contains a broken relative link: ${target}`);
    }
  }
}

function exactServer(configuration) {
  const servers = record(configuration.mcpServers, "plugin MCP servers");
  if (
    Object.keys(servers).length !== 1 ||
    servers["github-stars-mcp"] === undefined
  ) {
    fail("plugin MCP configuration must contain exactly github-stars-mcp");
  }
  return record(servers["github-stars-mcp"], "plugin MCP server");
}

function verifyVersions(packageMetadata, manifest, server, documents) {
  const version = packageMetadata.version;
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)
  ) {
    fail("package version is not an exact semantic version");
  }
  if (manifest.version !== version) {
    fail("plugin manifest version does not match package.json");
  }
  const expectedPackage = `github-stars-mcp@${version}`;
  if (
    !Array.isArray(server.args) ||
    server.args.length !== 3 ||
    server.args[0] !== "-y" ||
    server.args[1] !== expectedPackage ||
    server.args[2] !== "--stdio"
  ) {
    fail("plugin MCP package version does not match package.json");
  }
  for (const path of ["README.md", "docs/plugin.md"]) {
    const source = documents.get(path);
    if (source === undefined || !source.includes(expectedPackage)) {
      fail(`${path} does not document ${expectedPackage}`);
    }
    const references = [
      ...source.matchAll(/github-stars-mcp@(\d+\.\d+\.\d+)/gu),
    ].map((match) => match[1]);
    if (references.some((candidate) => candidate !== version)) {
      fail(`${path} documents a package version other than ${version}`);
    }
  }
}

function verifyEnvironment(server, documents) {
  if (
    !Array.isArray(server.env_vars) ||
    server.env_vars.length === 0 ||
    server.env_vars.some(
      (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]+$/u.test(name),
    )
  ) {
    fail("plugin MCP environment allowlist is invalid");
  }
  const names = server.env_vars;
  if (new Set(names).size !== names.length) {
    fail("plugin MCP environment allowlist contains duplicates");
  }
  const userDocumentation = [...documents.values()].join("\n");
  for (const name of names) {
    if (!userDocumentation.includes(`\`${name}\``)) {
      fail(`environment variable ${name} is undocumented`);
    }
  }
}

async function directDocumentationPaths() {
  const entries = await readdir("docs", { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `docs/${entry.name}`)
    .sort();
}

export async function verifyDocumentation() {
  const directPaths = await directDocumentationPaths();
  const paths = [...new Set([...CORE_DOCUMENTS, ...directPaths])].sort();
  const documents = new Map();
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    if (/\b(?:TODO|TBD)\b/iu.test(source) || /@latest\b/iu.test(source)) {
      fail(`${path} contains unfinished or unpinned documentation`);
    }
    await verifyLinks(path, source);
    documents.set(path, source);
  }

  const committed = documents.get(GENERATED_REFERENCE);
  const generated = await generateToolReference();
  if (committed !== generated) {
    fail(`${GENERATED_REFERENCE} is stale; run npm run docs:generate`);
  }

  const packageMetadata = await readJson("package.json", "package.json");
  const manifest = await readJson(
    "plugins/github-stars-mcp/.codex-plugin/plugin.json",
    "plugin manifest",
  );
  const configuration = await readJson(
    "plugins/github-stars-mcp/.mcp.json",
    "plugin MCP configuration",
  );
  const server = exactServer(configuration);
  verifyVersions(packageMetadata, manifest, server, documents);
  verifyEnvironment(server, documents);
  return Object.freeze({
    documents: documents.size,
    environmentVariables: server.env_vars.length,
    version: packageMetadata.version,
  });
}

try {
  const result = await verifyDocumentation();
  process.stdout.write(`${JSON.stringify({ status: "passed", ...result })}\n`);
} catch (error) {
  process.stderr.write(
    `Documentation verification failed: ${
      error instanceof Error ? error.message : "unknown failure"
    }\n`,
  );
  process.exitCode = 1;
}
