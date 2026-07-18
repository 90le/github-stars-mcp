import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { OperationCoordinator } from "../app/services/operation-coordinator.js";
import { AppError } from "../domain/errors.js";
import { newRequestId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import { canonicalJsonClone } from "../domain/canonical-json.js";
import type { ToolServiceOutput } from "./output-mappers.js";
import { toolFailure, toolSuccess } from "./result.js";
import type { ToolName } from "./schemas/common.js";
import {
  ToolFailureStructuredContentSchema,
  type ToolOutputSchemas,
} from "./schemas/output.js";

const MAX_TOOL_TEXT_LENGTH = 180;
const FORBIDDEN_INPUT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INVALID_TOOL_ARGUMENTS = Object.freeze({
  __invalid_mcp_arguments__: true,
});

type Registration<
  Name extends ToolName,
  InputSchema extends z.ZodType,
  ServiceResult,
> = Readonly<{
  name: Name;
  title: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema: (typeof ToolOutputSchemas)[Name];
  annotations: Required<
    Pick<
      ToolAnnotations,
      "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint"
    >
  >;
  execute: (
    input: z.output<InputSchema>,
    signal: AbortSignal,
  ) => ServiceResult | Promise<ServiceResult>;
  mapOutput: (result: ServiceResult) => ToolServiceOutput;
  summary: string;
}>;

type RuntimeTool = Readonly<{
  advertised: Tool;
  outputSchema: z.ZodType;
  invoke: (input: unknown, signal: AbortSignal) => Promise<ToolServiceOutput>;
  summary: string;
}>;

type ToolState = Readonly<{
  tools: Map<ToolName, RuntimeTool>;
}>;

const toolStates = new WeakMap<McpServer, ToolState>();

function schemaRecord(
  schema: z.ZodType,
  io: "input" | "output",
): Record<string, unknown> {
  const generated = {
    ...z.toJSONSchema(schema, { target: "draft-7", io }),
  };
  if (generated.type !== "object") {
    throw new Error("MCP tool schemas must have an object root");
  }
  return generated;
}

function advertisedOutputSchema(successSchema: z.ZodType) {
  const generated = z.toJSONSchema(
    z.union([successSchema, ToolFailureStructuredContentSchema]),
    { target: "draft-7", io: "output" },
  );
  return {
    ...generated,
    type: "object" as const,
  };
}

function advertiseTool<
  Name extends ToolName,
  InputSchema extends z.ZodType,
  ServiceResult,
>(registration: Registration<Name, InputSchema, ServiceResult>): Tool {
  return ToolSchema.parse({
    name: registration.name,
    title: registration.title,
    description: registration.description,
    inputSchema: schemaRecord(registration.inputSchema, "input"),
    outputSchema: advertisedOutputSchema(registration.outputSchema),
    annotations: registration.annotations,
    execution: { taskSupport: "forbidden" },
  });
}

function hasForbiddenInputKey(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenInputKey);
  return Object.entries(value).some(
    ([key, child]) =>
      FORBIDDEN_INPUT_KEYS.has(key.toLowerCase()) ||
      hasForbiddenInputKey(child),
  );
}

function isJsonRecord(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeToolInput(value: unknown): JsonValue {
  const cloned = canonicalJsonClone(value);
  if (!isJsonRecord(cloned) || hasForbiddenInputKey(cloned)) {
    throw new AppError("VALIDATION_ERROR", "Invalid MCP tool input", {
      retryable: false,
    });
  }
  return cloned;
}

function boundaryArguments(
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  try {
    const cloned = canonicalJsonClone(value);
    if (!isJsonRecord(cloned) || hasForbiddenInputKey(cloned)) {
      return INVALID_TOOL_ARGUMENTS;
    }
    return cloned;
  } catch {
    return INVALID_TOOL_ARGUMENTS;
  }
}

const BoundaryCallToolRequestSchema = CallToolRequestSchema.extend({
  params: CallToolRequestSchema.shape.params.extend({
    arguments: z
      .unknown()
      .transform((value) => boundaryArguments(value))
      .optional(),
    task: z
      .unknown()
      .transform(() => ({}))
      .optional(),
  }),
});

function conciseText(result: CallToolResult): CallToolResult["content"] {
  const content = result.content[0];
  const text =
    content?.type === "text"
      ? Buffer.from(content.text, "utf8")
          .toString("utf8")
          .slice(0, MAX_TOOL_TEXT_LENGTH)
          .replace(/[\uD800-\uDBFF]$/u, "")
      : "INTERNAL_ERROR: An unexpected internal error occurred";
  return [{ type: "text", text }];
}

function plainStructuredContent(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function successResult(
  tool: RuntimeTool,
  mapped: ToolServiceOutput,
  requestId: string,
): CallToolResult {
  const success = toolSuccess(mapped.data, {
    requestId,
    summary: tool.summary,
    warnings: mapped.warnings,
    rateLimit: mapped.rateLimit,
    nextCursor: mapped.nextCursor,
  });
  const structuredContent = tool.outputSchema.parse(
    plainStructuredContent(success.structuredContent),
  );
  return CallToolResultSchema.parse({
    ...success,
    content: conciseText(success),
    structuredContent,
  });
}

function failureResult(error: unknown, requestId: string): CallToolResult {
  const failure = toolFailure(error, requestId);
  const structuredContent = ToolFailureStructuredContentSchema.parse(
    plainStructuredContent(failure.structuredContent),
  );
  return CallToolResultSchema.parse({
    ...failure,
    content: conciseText(failure),
    structuredContent,
  });
}

function initializeToolBoundary(server: McpServer): ToolState {
  const current = toolStates.get(server);
  if (current !== undefined) return current;

  server.server.assertCanSetRequestHandler(
    ListToolsRequestSchema.shape.method.value,
  );
  server.server.assertCanSetRequestHandler(
    CallToolRequestSchema.shape.method.value,
  );
  const state: ToolState = { tools: new Map() };
  toolStates.set(server, state);
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(
    ListToolsRequestSchema,
    (): ListToolsResult => ({
      tools: [...state.tools.values()].map(({ advertised }) => advertised),
    }),
  );
  server.server.setRequestHandler(
    BoundaryCallToolRequestSchema,
    async (request, context): Promise<CallToolResult> => {
      const requestId = newRequestId();
      try {
        if (request.params.task !== undefined) {
          throw new AppError(
            "VALIDATION_ERROR",
            "Task execution is not supported",
            { retryable: false },
          );
        }
        const tool = state.tools.get(request.params.name as ToolName);
        if (tool === undefined) {
          throw new AppError("VALIDATION_ERROR", "Unknown MCP tool", {
            retryable: false,
          });
        }
        const input = safeToolInput(request.params.arguments ?? {});
        const mapped = await tool.invoke(input, context.signal);
        return successResult(tool, mapped, requestId);
      } catch (error) {
        return failureResult(error, requestId);
      }
    },
  );
  return state;
}

export function registerMappedTool<
  Name extends ToolName,
  InputSchema extends z.ZodType,
  ServiceResult,
>(
  server: McpServer,
  registration: Registration<Name, InputSchema, ServiceResult>,
  coordinator?: OperationCoordinator,
): void {
  const state = initializeToolBoundary(server);
  if (state.tools.has(registration.name)) {
    throw new Error(`MCP tool ${registration.name} is already registered`);
  }
  const advertised = advertiseTool(registration);
  state.tools.set(registration.name, {
    advertised,
    outputSchema: registration.outputSchema,
    summary: registration.summary,
    invoke: async (input, signal) => {
      const invoke = async (
        coordinatedSignal: AbortSignal,
      ): Promise<ToolServiceOutput> => {
        const parsedInput = registration.inputSchema.safeParse(input);
        if (!parsedInput.success) {
          throw new AppError("VALIDATION_ERROR", "Invalid MCP tool input", {
            retryable: false,
          });
        }
        coordinatedSignal.throwIfAborted();
        const serviceResult = await registration.execute(
          parsedInput.data,
          coordinatedSignal,
        );
        return registration.mapOutput(serviceResult);
      };
      return coordinator === undefined
        ? await invoke(signal)
        : await coordinator.run(invoke, signal);
    },
  });
}
