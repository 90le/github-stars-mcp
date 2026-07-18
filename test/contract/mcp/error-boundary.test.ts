import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResultSchema,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import { registerChangeTools } from "../../../src/mcp/register-change-tools.js";
import { registerReadTools } from "../../../src/mcp/register-read-tools.js";
import { ToolNames, type ToolName } from "../../../src/mcp/schemas/common.js";
import { ToolFailureStructuredContentSchema } from "../../../src/mcp/schemas/output.js";
import {
  fakeServices,
  type FakeServices,
} from "../../fixtures/fake-services.js";

const SECRET = "github_pat_boundary_secret_123456789";
const TOOL_TITLES = {
  github_stars_status: "GitHub Stars Status",
  github_stars_sync: "Sync GitHub Stars",
  github_stars_query: "Query GitHub Stars",
  github_lists_query: "Query GitHub Lists",
  github_changes_plan: "Plan GitHub Changes",
  github_changes_inspect: "Inspect GitHub Changes",
  github_changes_apply: "Apply GitHub Changes",
  github_changes_rollback: "Create GitHub Rollback Plan",
  github_repositories_discover: "Discover GitHub Repositories",
} as const satisfies Record<ToolName, string>;

const VALID_CALLS = [
  { name: "github_stars_status", arguments: {} },
  { name: "github_stars_sync", arguments: {} },
  { name: "github_stars_query", arguments: {} },
  { name: "github_lists_query", arguments: { mode: "lists" } },
  {
    name: "github_changes_plan",
    arguments: {
      snapshot_id: "snap_1",
      operations: [{ kind: "list_create", client_ref: "ref_ai", name: "AI" }],
    },
  },
  {
    name: "github_changes_inspect",
    arguments: { kind: "run", id: "run_1" },
  },
  {
    name: "github_changes_apply",
    arguments: { plan_id: "plan_1", expected_hash: "a".repeat(64) },
  },
  { name: "github_changes_rollback", arguments: { run_id: "run_1" } },
  {
    name: "github_repositories_discover",
    arguments: { query: "model context protocol" },
  },
] as const satisfies readonly CallToolRequest["params"][];

type ConnectedServer = Readonly<{
  client: Client;
  server: McpServer;
  services: FakeServices;
}>;

const sessions: ConnectedServer[] = [];

async function connectServer(): Promise<ConnectedServer> {
  const services = fakeServices();
  const server = new McpServer({
    name: "error-boundary-contract",
    version: "0.0.0",
  });
  registerReadTools(server, services);
  registerChangeTools(server, services);
  const client = new Client({
    name: "error-boundary-client",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const connected = { client, server, services };
  sessions.push(connected);
  return connected;
}

afterEach(async () => {
  const closing = sessions
    .splice(0)
    .flatMap(({ client, server }) => [client.close(), server.close()]);
  await Promise.allSettled(closing);
});

function rejectNext(
  services: FakeServices,
  name: ToolName,
  error: unknown,
): void {
  switch (name) {
    case "github_stars_status":
      vi.mocked(services.status.status).mockRejectedValueOnce(error);
      return;
    case "github_stars_sync":
      vi.mocked(services.sync.sync).mockRejectedValueOnce(error);
      return;
    case "github_stars_query":
      vi.mocked(services.query.query).mockRejectedValueOnce(error);
      return;
    case "github_lists_query":
      vi.mocked(services.listsQuery.query).mockRejectedValueOnce(error);
      return;
    case "github_changes_plan":
      vi.mocked(services.plan.create).mockRejectedValueOnce(error);
      return;
    case "github_changes_inspect":
      vi.mocked(services.inspect.inspect).mockRejectedValueOnce(error);
      return;
    case "github_changes_apply":
      vi.mocked(services.apply.apply).mockRejectedValueOnce(error);
      return;
    case "github_changes_rollback":
      vi.mocked(services.rollback.createRollback).mockRejectedValueOnce(error);
      return;
    case "github_repositories_discover":
      vi.mocked(services.discover.discover).mockRejectedValueOnce(error);
      return;
  }
}

async function call(
  client: Client,
  params: CallToolRequest["params"],
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool(params));
}

function expectSafeFailure(result: CallToolResult, forbiddenText = SECRET) {
  expect(result.isError).toBe(true);
  const failure = ToolFailureStructuredContentSchema.parse(
    result.structuredContent,
  );
  expect(failure.request_id).toMatch(/^req_[0-9a-f-]+$/u);
  expect(result.content).toHaveLength(1);
  const content = result.content[0];
  expect(content?.type).toBe("text");
  if (content?.type !== "text") throw new Error("expected text failure");
  expect(content.text.length).toBeLessThanOrEqual(180);
  expect(JSON.stringify(result)).not.toContain(forbiddenText);
  return failure;
}

function jsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return objectRecord(parsed);
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value as Record<string, unknown>;
}

function expectNoServiceCalls(services: FakeServices): void {
  expect(services.status.status).not.toHaveBeenCalled();
  expect(services.sync.sync).not.toHaveBeenCalled();
  expect(services.query.query).not.toHaveBeenCalled();
  expect(services.listsQuery.query).not.toHaveBeenCalled();
  expect(services.plan.create).not.toHaveBeenCalled();
  expect(services.inspect.inspect).not.toHaveBeenCalled();
  expect(services.apply.apply).not.toHaveBeenCalled();
  expect(services.rollback.createRollback).not.toHaveBeenCalled();
  expect(services.discover.discover).not.toHaveBeenCalled();
}

describe("MCP call error boundary after tool discovery", () => {
  it("refuses to replace an existing public MCP tool handler", () => {
    const server = new McpServer({
      name: "existing-handler-contract",
      version: "0.0.0",
    });
    server.registerTool("existing_tool", {}, () =>
      Promise.resolve({ content: [{ type: "text", text: "existing" }] }),
    );

    expect(() => registerReadTools(server, fakeServices())).toThrow(
      /request handler/iu,
    );
  });

  it("advertises each exact tool output as success or strict failure", async () => {
    const { client } = await connectServer();
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual(
      [...ToolNames].sort(),
    );
    for (const tool of listed.tools) {
      expect(tool.title).toBe(TOOL_TITLES[tool.name as ToolName]);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema?.type).toBe("object");
      const outputSchema = tool.outputSchema as Record<string, unknown>;
      const branches = outputSchema.anyOf;
      expect(Array.isArray(branches)).toBe(true);
      if (!Array.isArray(branches)) throw new Error("expected output anyOf");
      expect(branches).toHaveLength(2);
      const success = objectRecord(branches[0]);
      const failure = objectRecord(branches[1]);
      expect(success.additionalProperties).toBe(false);
      expect(failure.additionalProperties).toBe(false);
      const successProperties = objectRecord(success.properties);
      const failureProperties = objectRecord(failure.properties);
      expect(objectRecord(successProperties.ok).const).toBe(true);
      expect(objectRecord(failureProperties.ok).const).toBe(false);
      expect(success.required).toEqual([
        "schema_version",
        "ok",
        "request_id",
        "warnings",
        "rate_limit",
        "next_cursor",
        "data",
      ]);
      expect(failure.required).toEqual([
        "schema_version",
        "ok",
        "request_id",
        "error",
      ]);
      const failureError = objectRecord(failureProperties.error);
      expect(failureError.additionalProperties).toBe(false);
      expect(failureError.required).toEqual([
        "code",
        "message",
        "retryable",
        "details",
      ]);
    }
  });

  it("returns strict failures for AppError and unknown errors from all tools", async () => {
    const { client, services } = await connectServer();
    await client.listTools();
    for (const params of VALID_CALLS) {
      rejectNext(
        services,
        params.name,
        new AppError(
          "GITHUB_UNAVAILABLE",
          `forced ${SECRET} ${"x".repeat(500)}`,
          {
            retryable: true,
            details: { authorization: `Bearer ${SECRET}` },
            secrets: [SECRET],
          },
        ),
      );
      expectSafeFailure(await call(client, params));

      rejectNext(services, params.name, new Error(`unknown ${SECRET}`));
      expectSafeFailure(await call(client, params));
    }
  });

  it("contains invalid, dangerous, and nested input before any service", async () => {
    const { client, services } = await connectServer();
    await client.listTools();
    const invalidCalls: readonly CallToolRequest["params"][] = [
      {
        name: "github_stars_status",
        arguments: { access_token: SECRET },
      },
      {
        name: "github_stars_sync",
        arguments: { unknown: `normal-${SECRET}` },
      },
      {
        name: "github_stars_query",
        arguments: jsonObject(`{"__proto__":{"secret":"${SECRET}"}}`),
      },
      {
        name: "github_lists_query",
        arguments: jsonObject(
          `{"mode":"lists","constructor":{"secret":"${SECRET}"}}`,
        ),
      },
      {
        name: "github_repositories_discover",
        arguments: jsonObject(
          `{"query":"mcp","prototype":{"secret":"${SECRET}"}}`,
        ),
      },
      {
        name: "github_changes_plan",
        arguments: {
          snapshot_id: "snap_1",
          operations: [
            {
              kind: "list_create",
              client_ref: "ref_ai",
              name: { secret: SECRET },
            },
          ],
        },
      },
      {
        name: "github_changes_inspect",
        arguments: { kind: "attempts", id: "run_1" },
      },
      {
        name: "github_changes_apply",
        arguments: { plan_id: "plan_1" },
      },
      {
        name: "github_changes_rollback",
        arguments: { run_id: "" },
      },
      {
        name: `github_rest_${SECRET}`,
        arguments: {},
      },
    ];
    for (const params of invalidCalls) {
      const failure = expectSafeFailure(await call(client, params));
      expect(failure.error.code).toBe("VALIDATION_ERROR");
    }
    expectNoServiceCalls(services);
    expect(Object.hasOwn(Object.prototype, "secret")).toBe(false);
  });

  it("turns an abort-shaped service exception into a safe failure", async () => {
    const { client, services } = await connectServer();
    await client.listTools();
    rejectNext(
      services,
      "github_stars_status",
      new DOMException(SECRET, "AbortError"),
    );
    expectSafeFailure(
      await call(client, { name: "github_stars_status", arguments: {} }),
    );
  });

  it("never splits a Unicode surrogate pair at the text boundary", async () => {
    const { client, services } = await connectServer();
    await client.listTools();
    rejectNext(
      services,
      "github_stars_status",
      new AppError("GITHUB_UNAVAILABLE", `${"a".repeat(159)}😀TAIL`, {
        retryable: true,
      }),
    );
    const result = await call(client, {
      name: "github_stars_status",
      arguments: {},
    });
    expectSafeFailure(result);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected text failure");
    expect(Buffer.from(content.text, "utf8").toString("utf8")).toBe(
      content.text,
    );
  });

  it("propagates client cancellation and stops pending service work", async () => {
    const { client, services } = await connectServer();
    await client.listTools();
    let serviceSignal: AbortSignal | undefined;
    let remoteWorkContinued = false;
    vi.mocked(services.status.status).mockImplementationOnce(
      async (_input, signal) =>
        await new Promise<never>((_resolve, reject) => {
          serviceSignal = signal;
          const timer = setTimeout(() => {
            remoteWorkContinued = true;
            reject(new Error("remote work continued after cancellation"));
          }, 1_000);
          const stop = () => {
            clearTimeout(timer);
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error("request cancelled"),
            );
          };
          if (signal?.aborted === true) {
            stop();
            return;
          }
          signal?.addEventListener("abort", stop, { once: true });
        }),
    );

    const controller = new AbortController();
    const pending = client.callTool(
      { name: "github_stars_status", arguments: {} },
      CallToolResultSchema,
      { signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(services.status.status).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(serviceSignal?.aborted).toBe(true);
    expect(remoteWorkContinued).toBe(false);
  });
});
