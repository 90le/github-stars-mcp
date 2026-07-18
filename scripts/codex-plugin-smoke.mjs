import { cp, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  createPackedInstallation,
  findCodexCommand,
  isolatedCodexEnvironment,
  parseJsonDocument,
  readJson,
  removePackedInstallation,
  REPOSITORY_ROOT,
  run,
} from "./smoke-common.mjs";

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function inside(root, path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith("../") &&
    !fromRoot.startsWith("..\\")
  );
}

async function requireInstalledCli(installedPackageRoot) {
  const canonicalRoot = await realpath(installedPackageRoot);
  const cliPath = resolve(canonicalRoot, "dist/cli.js");
  if (!inside(canonicalRoot, cliPath) || !(await stat(cliPath)).isFile()) {
    throw new Error("installed packed CLI is invalid");
  }
  return cliPath;
}

export async function createLocalPluginFixture({
  installedPackageRoot,
  marketplaceRoot,
  repositoryRoot = REPOSITORY_ROOT,
}) {
  const cliPath = await requireInstalledCli(installedPackageRoot);
  const pluginRoot = join(marketplaceRoot, "plugins/github-stars-mcp");
  await mkdir(join(marketplaceRoot, ".agents/plugins"), { recursive: true });
  await mkdir(join(marketplaceRoot, "plugins"), { recursive: true });
  await cp(
    join(repositoryRoot, ".agents/plugins/marketplace.json"),
    join(marketplaceRoot, ".agents/plugins/marketplace.json"),
  );
  await cp(join(repositoryRoot, "plugins/github-stars-mcp"), pluginRoot, {
    recursive: true,
  });

  const marketplace = record(
    await readJson(
      join(marketplaceRoot, ".agents/plugins/marketplace.json"),
      "copied marketplace",
    ),
    "copied marketplace",
  );
  if (
    typeof marketplace.name !== "string" ||
    marketplace.name.length === 0 ||
    !Array.isArray(marketplace.plugins) ||
    marketplace.plugins.length !== 1
  ) {
    throw new Error("copied marketplace has an invalid identity");
  }
  const marketplacePlugin = record(
    marketplace.plugins[0],
    "copied marketplace plugin",
  );
  if (marketplacePlugin.name !== "github-stars-mcp") {
    throw new Error("copied marketplace has an unexpected plugin");
  }

  const configPath = join(pluginRoot, ".mcp.json");
  const config = record(
    await readJson(configPath, "copied MCP configuration"),
    "copied MCP configuration",
  );
  const servers = record(config.mcpServers, "copied MCP servers");
  if (
    Object.keys(servers).length !== 1 ||
    servers["github-stars-mcp"] === undefined
  ) {
    throw new Error("copied MCP configuration has a non-exact server set");
  }
  const server = record(
    servers["github-stars-mcp"],
    "copied github-stars-mcp server",
  );
  server.command = process.execPath;
  server.args = [cliPath, "--stdio"];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return Object.freeze({
    marketplaceRoot,
    marketplaceName: marketplace.name,
    pluginRoot,
    pluginSelector: `github-stars-mcp@${marketplace.name}`,
    cliPath,
  });
}

async function runCodex(command, arguments_, fixture, home) {
  const result = await run(
    command.command,
    [...command.prefix, ...arguments_],
    {
      cwd: fixture.marketplaceRoot,
      env: isolatedCodexEnvironment(home),
      label: `codex ${arguments_.slice(0, 2).join(" ")}`,
    },
  );
  return parseJsonDocument(
    result.stdout,
    `codex ${arguments_.slice(0, 2).join(" ")}`,
  );
}

async function assertPluginInstalled(value, fixture) {
  const result = record(value, "Codex plugin list");
  if (!Array.isArray(result.installed)) {
    throw new Error("Codex plugin list has no installed array");
  }
  const matches = result.installed.filter((candidate) => {
    if (candidate === null || typeof candidate !== "object") return false;
    return (
      candidate.name === "github-stars-mcp" &&
      candidate.marketplaceName === fixture.marketplaceName &&
      candidate.installed === true &&
      candidate.enabled === true
    );
  });
  if (matches.length !== 1) {
    throw new Error("Codex did not report the expected installed plugin");
  }
  const source = record(matches[0].source, "installed plugin source");
  if (source.source !== "local" || typeof source.path !== "string") {
    throw new Error("Codex installed the plugin from an unexpected source");
  }
  if ((await realpath(source.path)) !== (await realpath(fixture.pluginRoot))) {
    throw new Error("Codex plugin source does not match the smoke fixture");
  }
}

function assertMcpServer(value, fixture) {
  if (!Array.isArray(value)) {
    throw new Error("Codex MCP list must be a JSON array");
  }
  const matches = value.filter(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      candidate.name === "github-stars-mcp",
  );
  if (matches.length !== 1) {
    throw new Error("Codex did not report exactly one github-stars-mcp server");
  }
  const server = record(matches[0], "Codex MCP server");
  const transport = record(server.transport, "Codex MCP transport");
  if (
    server.enabled !== true ||
    transport.type !== "stdio" ||
    transport.command !== process.execPath ||
    !Array.isArray(transport.args) ||
    transport.args.length !== 2 ||
    transport.args[0] !== fixture.cliPath ||
    transport.args[1] !== "--stdio" ||
    server.startup_timeout_sec !== 120 ||
    server.tool_timeout_sec !== 900
  ) {
    throw new Error("Codex MCP server does not use the installed packed CLI");
  }
}

export async function runCodexPluginSmoke() {
  const command = await findCodexCommand();
  if (command === null) {
    return Object.freeze({ status: "skipped", reason: "codex-not-installed" });
  }

  const installation = await createPackedInstallation();
  const marketplaceRoot = join(installation.root, "marketplace");
  const home = join(installation.root, "codex-home");
  try {
    await mkdir(home, { recursive: true });
    const fixture = await createLocalPluginFixture({
      installedPackageRoot: installation.installedPackageRoot,
      marketplaceRoot,
    });
    await runCodex(
      command,
      ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
      fixture,
      home,
    );
    await runCodex(
      command,
      ["plugin", "add", fixture.pluginSelector, "--json"],
      fixture,
      home,
    );
    const plugins = await runCodex(
      command,
      ["plugin", "list", "--json"],
      fixture,
      home,
    );
    await assertPluginInstalled(plugins, fixture);
    const servers = await runCodex(
      command,
      ["mcp", "list", "--json"],
      fixture,
      home,
    );
    assertMcpServer(servers, fixture);
    return Object.freeze({
      status: "passed",
      plugin: fixture.pluginSelector,
      server: "github-stars-mcp",
    });
  } finally {
    await removePackedInstallation(installation);
  }
}

async function main() {
  const report = await runCodexPluginSmoke();
  if (report.status === "skipped") {
    process.stderr.write(
      "Codex plugin smoke skipped: Codex is not installed\n",
    );
    process.exitCode = 77;
    return;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Codex plugin smoke failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }\n`,
    );
    process.exitCode = 1;
  }
}
