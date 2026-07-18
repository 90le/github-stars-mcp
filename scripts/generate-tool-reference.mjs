import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpServer } from "../dist/mcp/create-server.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../dist/version.js";

const OUTPUT_PATH = resolve("docs/tool-reference.md");

function unavailable() {
  throw new Error("documentation generation must not invoke services");
}

function referenceServices() {
  return {
    clock: { now: () => "2000-01-01T00:00:00.000Z" },
    status: { status: unavailable },
    sync: { sync: unavailable },
    query: { query: unavailable },
    listsQuery: { query: unavailable },
    discover: { discover: unavailable },
    plan: { create: unavailable },
    inspect: { inspect: unavailable },
    apply: { apply: unavailable },
    rollback: { createRollback: unavailable },
  };
}

function orderedJson(value) {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, orderedJson(child)]),
  );
}

function jsonBlock(value) {
  return ["```json", JSON.stringify(orderedJson(value), null, 2), "```"].join(
    "\n",
  );
}

function renderAnnotations(annotations) {
  return Object.entries(annotations ?? {})
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `- \`${key}\`: \`${String(value)}\``)
    .join("\n");
}

export function renderTool(tool) {
  const title =
    typeof tool.title === "string" && tool.title.length > 0
      ? tool.title
      : tool.name;
  const description =
    typeof tool.description === "string" && tool.description.length > 0
      ? tool.description
      : "No description.";
  return [
    `## \`${tool.name}\``,
    "",
    `**${title}**`,
    "",
    description,
    "",
    "### Annotations",
    "",
    renderAnnotations(tool.annotations),
    "",
    "### Execution",
    "",
    jsonBlock(tool.execution ?? {}),
    "",
    "### Input schema",
    "",
    jsonBlock(tool.inputSchema),
    "",
    "### Output schema",
    "",
    jsonBlock(tool.outputSchema ?? {}),
    "",
  ].join("\n");
}

export function renderReference(tools) {
  const ordered = [...tools].sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  return [
    "# MCP Tool Reference",
    "",
    `Generated from the built \`${PACKAGE_NAME}\` ${PACKAGE_VERSION} server. Do not edit by hand.`,
    "",
    "Every tool below is part of the complete public MCP surface. Input and output schemas are strict; fields not present in a schema are rejected.",
    "",
    ...ordered.map(renderTool),
  ].join("\n");
}

export async function generateToolReference() {
  const server = createMcpServer(referenceServices());
  const client = new Client({
    name: "github-stars-mcp-doc-generator",
    version: PACKAGE_VERSION,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.listTools();
    return renderReference(result.tools);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function main() {
  await writeFile(OUTPUT_PATH, await generateToolReference(), "utf8");
  process.stdout.write(`Generated ${OUTPUT_PATH}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Tool reference generation failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }\n`,
    );
    process.exitCode = 1;
  }
}
