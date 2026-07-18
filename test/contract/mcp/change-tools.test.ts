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
import { registerChangeTools } from "../../../src/mcp/register-change-tools.js";
import {
  ToolFailureStructuredContentSchema,
  ToolOutputSchemas,
} from "../../../src/mcp/schemas/output.js";
import { fakeServices } from "../../fixtures/fake-services.js";

const CHANGE_TOOL_NAMES = [
  "github_changes_plan",
  "github_changes_inspect",
  "github_changes_apply",
  "github_changes_rollback",
] as const;

const PLAN_INPUT = {
  snapshot_id: "snap_1",
  operations: [
    {
      kind: "list_create",
      client_ref: "ref_ai",
      name: "AI",
    },
  ],
} as const;

async function connectChangeServer() {
  const services = fakeServices();
  const server = new McpServer({
    name: "change-contract",
    version: "0.0.0",
  });
  registerChangeTools(server, services);
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

describe("safe change MCP registration", () => {
  it("advertises and calls four explicit plan/inspect/apply tools", async () => {
    const { client, server, services } = await connectChangeServer();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(CHANGE_TOOL_NAMES);
      for (const tool of listed.tools) {
        expect(tool.description?.length).toBeGreaterThan(20);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
      }
      expect(listed.tools.map((tool) => tool.annotations)).toEqual([
        {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      ]);

      const calls = [
        { name: "github_changes_plan", arguments: PLAN_INPUT },
        {
          name: "github_changes_inspect",
          arguments: { kind: "run", id: "run_1" },
        },
        {
          name: "github_changes_apply",
          arguments: {
            plan_id: "plan_1",
            expected_hash: "a".repeat(64),
            failure_mode: "continue",
          },
        },
        {
          name: "github_changes_rollback",
          arguments: { run_id: "run_1" },
        },
      ] as const;
      for (const call of calls) {
        const result = await callTool(client, call);
        expect(result.isError).not.toBe(true);
        expect(
          ToolOutputSchemas[call.name].safeParse(result.structuredContent)
            .success,
        ).toBe(true);
        expect(result.content).toHaveLength(1);
        const content = result.content[0];
        expect(content?.type).toBe("text");
        if (content?.type !== "text") throw new Error("expected text summary");
        expect(content.text.length).toBeLessThanOrEqual(180);
        expect(content.text).not.toContain("account-secret");
      }

      expect(vi.mocked(services.plan.create).mock.calls[0]?.[0]).toMatchObject({
        snapshotId: "snap_1",
        actions: [{ kind: "list_create", clientRef: "ref_ai", name: "AI" }],
        protectedRepositoryIds: [],
        protectedListIds: [],
      });
      expect(vi.mocked(services.inspect.inspect)).toHaveBeenCalledWith({
        kind: "run",
        id: "run_1",
        limit: 50,
        cursor: null,
      });
      expect(vi.mocked(services.apply.apply)).toHaveBeenCalledWith(
        {
          planId: "plan_1",
          expectedHash: "a".repeat(64),
          failureMode: "continue",
        },
        expect.any(AbortSignal),
      );
      expect(
        vi.mocked(services.rollback.createRollback).mock.calls[0]?.[0],
      ).toEqual({
        runId: "run_1",
        protectedRepositoryIds: [],
        protectedListIds: [],
      });
    } finally {
      await closeSession(client, server);
    }
  });

  it("returns all four closed Inspect result branches", async () => {
    const { client, server } = await connectChangeServer();
    try {
      const calls = [
        { kind: "plan", id: "plan_1" },
        { kind: "run", id: "run_1" },
        { kind: "attempts", id: "run_1", operation_id: "op_1" },
        {
          kind: "reconciliations",
          id: "run_1",
          operation_id: "op_1",
        },
      ];
      const results = [];
      for (const argumentsValue of calls) {
        results.push(
          await callTool(client, {
            name: "github_changes_inspect",
            arguments: argumentsValue,
          }),
        );
      }
      const parsedResults = results.map((result) =>
        ToolOutputSchemas.github_changes_inspect.parse(
          result.structuredContent,
        ),
      );
      expect(parsedResults).toMatchObject([
        { data: { kind: "plan" } },
        { data: { kind: "run" } },
        { data: { kind: "attempts" } },
        { data: { kind: "reconciliations" } },
      ]);
    } finally {
      await closeSession(client, server);
    }
  });

  it("keeps invalid apply, inspect, and plan input away from services", async () => {
    const { client, server, services } = await connectChangeServer();
    try {
      const invalidApply = await callTool(client, {
        name: "github_changes_apply",
        arguments: { plan_id: "plan_1" },
      });
      const missingOperation = await callTool(client, {
        name: "github_changes_inspect",
        arguments: { kind: "attempts", id: "run_1" },
      });
      const extraOperation = await callTool(client, {
        name: "github_changes_inspect",
        arguments: {
          kind: "run",
          id: "run_1",
          operation_id: "op_1",
        },
      });
      const unresolvedClientRef = await callTool(client, {
        name: "github_changes_plan",
        arguments: {
          snapshot_id: "snap_1",
          operations: [
            {
              kind: "list_membership_add",
              repositories: { repository_ids: ["repo_1"] },
              lists: [{ client_ref: "ref_missing" }],
            },
          ],
        },
      });
      const invalidRollback = await callTool(client, {
        name: "github_changes_rollback",
        arguments: { run_id: "" },
      });
      for (const result of [
        invalidApply,
        missingOperation,
        extraOperation,
        unresolvedClientRef,
        invalidRollback,
      ]) {
        expect(result.isError).toBe(true);
      }
      expect(vi.mocked(services.apply.apply)).not.toHaveBeenCalled();
      expect(vi.mocked(services.inspect.inspect)).not.toHaveBeenCalled();
      expect(vi.mocked(services.plan.create)).not.toHaveBeenCalled();
      expect(
        vi.mocked(services.rollback.createRollback),
      ).not.toHaveBeenCalled();
    } finally {
      await closeSession(client, server);
    }
  });

  it("turns every change service or mapper exception into a strict failure", async () => {
    const { client, server, services } = await connectChangeServer();
    try {
      const failure = new AppError(
        "PRECONDITION_FAILED",
        "forced change failure",
        {
          retryable: false,
          details: { reason: "forced_contract_failure" },
        },
      );
      const cases = [
        {
          name: "github_changes_plan",
          arguments: PLAN_INPUT,
          mock: vi.mocked(services.plan.create),
        },
        {
          name: "github_changes_inspect",
          arguments: { kind: "run", id: "run_1" },
          mock: vi.mocked(services.inspect.inspect),
        },
        {
          name: "github_changes_apply",
          arguments: {
            plan_id: "plan_1",
            expected_hash: "a".repeat(64),
          },
          mock: vi.mocked(services.apply.apply),
        },
        {
          name: "github_changes_rollback",
          arguments: { run_id: "run_1" },
          mock: vi.mocked(services.rollback.createRollback),
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

      vi.mocked(services.apply.apply).mockResolvedValueOnce({} as never);
      const mapperFailure = await callTool(client, {
        name: "github_changes_apply",
        arguments: {
          plan_id: "plan_1",
          expected_hash: "a".repeat(64),
        },
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
