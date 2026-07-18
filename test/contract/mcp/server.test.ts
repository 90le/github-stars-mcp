import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { OperationCoordinator } from "../../../src/app/services/operation-coordinator.js";
import { createMcpServer } from "../../../src/mcp/create-server.js";
import { ToolNames } from "../../../src/mcp/schemas/common.js";
import { PACKAGE_VERSION } from "../../../src/version.js";
import { fakeServices } from "../../fixtures/fake-services.js";

describe("createMcpServer", () => {
  it("publishes stable identity, safety instructions, and exactly nine tools", async () => {
    const coordinator = new OperationCoordinator();
    const server = createMcpServer(fakeServices(), coordinator);
    const client = new Client({ name: "server-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      expect(client.getServerVersion()).toEqual({
        name: "github-stars-mcp",
        version: PACKAGE_VERSION,
      });
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("Sync before");
      expect(instructions).toContain("explicit authorization");
      expect(instructions).toContain("repository administration");
      expect(instructions).toContain("next_cursor");
      expect(instructions).toContain("starred_at");
      expect(instructions).toContain("pushed_at");
      const listedNames = (await client.listTools()).tools.map(
        (tool) => tool.name,
      );
      expect(listedNames).toHaveLength(ToolNames.length);
      expect([...listedNames].sort()).toEqual([...ToolNames].sort());
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("rejects new tool calls after shutdown admission closes", async () => {
    const coordinator = new OperationCoordinator();
    const server = createMcpServer(fakeServices(), coordinator);
    const client = new Client({ name: "server-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      coordinator.stopAccepting();
      const result = await client.callTool({
        name: "github_stars_status",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          details: { reason: "shutting_down" },
        },
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
