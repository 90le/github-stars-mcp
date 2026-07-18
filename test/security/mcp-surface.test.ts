import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import { registerChangeTools } from "../../src/mcp/register-change-tools.js";
import { registerReadTools } from "../../src/mcp/register-read-tools.js";
import { ToolNames } from "../../src/mcp/schemas/common.js";
import { fakeServices } from "../fixtures/fake-services.js";

function propertyNames(
  value: unknown,
  output = new Set<string>(),
): Set<string> {
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, output);
    return output;
  }
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    for (const key of Object.keys(properties)) output.add(key);
  }
  for (const child of Object.values(record)) propertyNames(child, output);
  return output;
}

it("exposes exactly ten bounded tools and no generic GitHub capability", async () => {
  const server = new McpServer({
    name: "surface-contract",
    version: "0.0.0",
  });
  const services = fakeServices();
  registerReadTools(server, services);
  registerChangeTools(server, services);
  const client = new Client({ name: "surface-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [...ToolNames].sort(),
    );
    expect(listed.tools).toHaveLength(10);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(Object.keys(tool.annotations ?? {}).sort()).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
      ]);
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint).toBe("boolean");
      expect(tool.name).not.toMatch(
        /graphql|rest|request|shell|repository_(?:delete|archive|transfer|admin)/iu,
      );
      expect(tool.description).not.toMatch(
        /graphql|generic rest|raw url|host override|access token|filesystem path|shell command|repository administration/iu,
      );
      expect([...propertyNames(tool.inputSchema)]).not.toEqual(
        expect.arrayContaining([
          "graphql",
          "rest",
          "url",
          "host",
          "token",
          "access_token",
          "path",
          "shell",
          "command",
          "method",
          "headers",
          "repository_admin",
        ]),
      );
    }

    for (const forbidden of [
      "github_graphql",
      "github_rest_request",
      "github_shell",
      "github_repository_delete",
    ]) {
      const result = await client.callTool({
        name: forbidden,
        arguments: {},
      });
      expect(result.isError).toBe(true);
    }
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});
