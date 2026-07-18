import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  createPackedInstallation,
  EXPECTED_TOOL_NAMES,
  parseJsonDocument,
  removePackedInstallation,
  run,
} from "./smoke-common.mjs";

function assertExactTools(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(value.tools)
  ) {
    throw new Error("MCP Inspector response has no tools array");
  }
  const names = value.tools.map((tool) =>
    tool !== null && typeof tool === "object" && typeof tool.name === "string"
      ? tool.name
      : null,
  );
  if (names.some((name) => name === null)) {
    throw new Error("MCP Inspector returned a tool without a valid name");
  }
  const actual = [...names].sort();
  const expected = [...EXPECTED_TOOL_NAMES].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error("MCP Inspector returned a non-exact tool set");
  }
}

export async function runMcpInspectorSmoke() {
  const installation = await createPackedInstallation({
    installInspector: true,
  });
  try {
    const inspectorCli = join(
      installation.installRoot,
      "node_modules/@modelcontextprotocol/inspector/cli/build/cli.js",
    );
    const environment = {
      ...process.env,
      GITHUB_STARS_MCP_DATA_DIR: installation.stateRoot,
      GITHUB_STARS_MCP_LOG_LEVEL: "error",
      GITHUB_STARS_MCP_READ_ONLY: "true",
    };
    const result = await run(
      process.execPath,
      [
        inspectorCli,
        "--cli",
        process.execPath,
        installation.cliPath,
        "--stdio",
        "--method",
        "tools/list",
      ],
      {
        cwd: installation.installRoot,
        env: environment,
        label: "MCP Inspector tools/list",
      },
    );
    assertExactTools(
      parseJsonDocument(result.stdout, "MCP Inspector tools/list"),
    );
    return Object.freeze({
      status: "passed",
      inspectorVersion: "0.22.0",
      toolCount: EXPECTED_TOOL_NAMES.length,
    });
  } finally {
    await removePackedInstallation(installation);
  }
}

async function main() {
  const report = await runMcpInspectorSmoke();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `MCP Inspector smoke failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }\n`,
    );
    process.exitCode = 1;
  }
}
