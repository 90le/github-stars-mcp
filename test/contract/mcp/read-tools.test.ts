import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResultSchema,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import { registerReadTools } from "../../../src/mcp/register-read-tools.js";
import {
  ToolFailureStructuredContentSchema,
  ToolOutputSchemas,
} from "../../../src/mcp/schemas/output.js";
import {
  fakeServices,
  UNTRUSTED_README_MARKER,
} from "../../fixtures/fake-services.js";

const READ_TOOL_NAMES = [
  "github_stars_status",
  "github_stars_sync",
  "github_stars_query",
  "github_lists_query",
  "github_repositories_discover",
] as const;

async function connectReadServer() {
  const services = fakeServices();
  const server = new McpServer({
    name: "read-contract",
    version: "0.0.0",
  });
  registerReadTools(server, services);
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server, services };
}

async function closeSession(client: Client, server: McpServer): Promise<void> {
  await Promise.allSettled([client.close(), server.close()]);
}

async function callTool(
  client: Client,
  params: CallToolRequest["params"],
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool(params));
}

function expectShortSummary(result: CallToolResult) {
  expect(result.content).toHaveLength(1);
  const content = result.content[0];
  expect(content?.type).toBe("text");
  if (content?.type !== "text") throw new Error("expected text summary");
  expect(content.text.length).toBeLessThanOrEqual(180);
  expect(content.text).not.toContain(UNTRUSTED_README_MARKER);
}

describe("read-side MCP registration", () => {
  it("advertises and calls exactly five typed read/local-write tools", async () => {
    const { client, server, services } = await connectReadServer();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);
      for (const tool of listed.tools) {
        expect(tool.description?.length).toBeGreaterThan(20);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
      }
      expect(listed.tools.map((tool) => tool.annotations)).toEqual([
        {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      ]);

      const calls = [
        { name: "github_stars_status", arguments: {} },
        { name: "github_stars_sync", arguments: {} },
        {
          name: "github_stars_query",
          arguments: { evidence: "readme", evidence_limit: 1 },
        },
        { name: "github_lists_query", arguments: { mode: "lists" } },
        {
          name: "github_repositories_discover",
          arguments: {
            query: "model context protocol",
            evidence: "readme",
            evidence_limit: 1,
          },
        },
      ] as const;
      for (const call of calls) {
        const result = await callTool(client, call);
        expect(result.isError).not.toBe(true);
        expect(
          ToolOutputSchemas[call.name].safeParse(result.structuredContent)
            .success,
        ).toBe(true);
        expectShortSummary(result);
      }

      expect(vi.mocked(services.status.status)).toHaveBeenCalledWith(
        { refreshCapabilities: false },
        expect.any(AbortSignal),
      );
      expect(vi.mocked(services.sync.sync)).toHaveBeenCalledWith(
        {
          mode: "incremental",
          includeLists: true,
          metadataMaxAgeHours: 24,
        },
        expect.any(AbortSignal),
      );
      expect(vi.mocked(services.query.query).mock.calls[0]?.[0]).toMatchObject({
        snapshotId: null,
        evidence: "readme",
        evidenceLimit: 1,
        limit: 50,
      });
      expect(vi.mocked(services.query.query).mock.calls[0]?.[1]).toEqual(
        expect.any(AbortSignal),
      );
      expect(vi.mocked(services.listsQuery.query)).toHaveBeenCalledWith({
        mode: "lists",
        snapshotId: null,
        limit: 50,
        cursor: null,
      });
      expect(vi.mocked(services.discover.discover).mock.calls[0]?.[0]).toEqual({
        query: "model context protocol",
        qualifiers: {},
        sort: null,
        order: "desc",
        limit: 30,
        cursor: null,
        evidence: "readme",
        evidenceLimit: 1,
      });
      expect(vi.mocked(services.discover.discover).mock.calls[0]?.[1]).toEqual(
        expect.any(AbortSignal),
      );
    } finally {
      await closeSession(client, server);
    }
  });

  it("returns all three closed Lists output branches", async () => {
    const { client, server } = await connectReadServer();
    try {
      const calls = [
        { mode: "lists" },
        { mode: "memberships", list_id: "list_1" },
        { mode: "memberships", repository_id: "repo_1" },
      ];
      const results = [];
      for (const argumentsValue of calls) {
        results.push(
          await callTool(client, {
            name: "github_lists_query",
            arguments: argumentsValue,
          }),
        );
      }
      const parsedResults = results.map((result) =>
        ToolOutputSchemas.github_lists_query.parse(result.structuredContent),
      );
      expect(parsedResults[0]?.data).toMatchObject({
        mode: "lists",
      });
      expect(parsedResults[1]?.data).toMatchObject({
        mode: "memberships",
        selector: { kind: "list", list_id: "list_1" },
        repository_ids: ["repo_1"],
      });
      expect(parsedResults[2]?.data).toMatchObject({
        mode: "memberships",
        selector: { kind: "repository", repository_id: "repo_1" },
        list_ids: ["list_1"],
      });
    } finally {
      await closeSession(client, server);
    }
  });

  it("rejects strict and super-refined input before calling a service", async () => {
    const { client, server, services } = await connectReadServer();
    try {
      const status = vi.mocked(services.status.status);
      const sync = vi.mocked(services.sync.sync);
      const query = vi.mocked(services.query.query);
      const lists = vi.mocked(services.listsQuery.query);
      const discover = vi.mocked(services.discover.discover);
      const invalidStatus = await callTool(client, {
        name: "github_stars_status",
        arguments: { unexpected: true },
      });
      const invalidSync = await callTool(client, {
        name: "github_stars_sync",
        arguments: { unexpected: true },
      });
      const invalidEvidence = await callTool(client, {
        name: "github_stars_query",
        arguments: { evidence: "none", evidence_limit: 1 },
      });
      const invalidLists = await callTool(client, {
        name: "github_lists_query",
        arguments: { mode: "lists", list_id: "list_1" },
      });
      const invalidDiscovery = await callTool(client, {
        name: "github_repositories_discover",
        arguments: { query: "" },
      });
      expect(invalidStatus.isError).toBe(true);
      expect(invalidSync.isError).toBe(true);
      expect(invalidEvidence.isError).toBe(true);
      expect(invalidLists.isError).toBe(true);
      expect(invalidDiscovery.isError).toBe(true);
      expect(status).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(lists).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
    } finally {
      await closeSession(client, server);
    }
  });

  it("turns every read service or mapper exception into a strict failure", async () => {
    const { client, server, services } = await connectReadServer();
    try {
      const failure = new AppError(
        "GITHUB_UNAVAILABLE",
        "forced read failure",
        {
          retryable: true,
          details: { reason: "forced_contract_failure" },
        },
      );
      const cases = [
        {
          name: "github_stars_status",
          arguments: {},
          mock: vi.mocked(services.status.status),
        },
        {
          name: "github_stars_sync",
          arguments: {},
          mock: vi.mocked(services.sync.sync),
        },
        {
          name: "github_stars_query",
          arguments: {},
          mock: vi.mocked(services.query.query),
        },
        {
          name: "github_lists_query",
          arguments: { mode: "lists" },
          mock: vi.mocked(services.listsQuery.query),
        },
        {
          name: "github_repositories_discover",
          arguments: { query: "mcp" },
          mock: vi.mocked(services.discover.discover),
        },
      ] as const;
      for (const testCase of cases) {
        testCase.mock.mockRejectedValueOnce(failure);
        const result = await callTool(client, {
          name: testCase.name,
          arguments: testCase.arguments,
        });
        expect(result.isError).toBe(true);
        expect(
          ToolFailureStructuredContentSchema.safeParse(result.structuredContent)
            .success,
        ).toBe(true);
      }

      vi.mocked(services.query.query).mockResolvedValueOnce({} as never);
      const mapperFailure = await callTool(client, {
        name: "github_stars_query",
        arguments: {},
      });
      expect(mapperFailure.isError).toBe(true);
      expect(
        ToolFailureStructuredContentSchema.safeParse(
          mapperFailure.structuredContent,
        ).success,
      ).toBe(true);
    } finally {
      await closeSession(client, server);
    }
  });
});
