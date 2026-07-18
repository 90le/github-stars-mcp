import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { newRequestId } from "../domain/ids.js";
import type { ToolName } from "./schemas/common.js";
import type { ToolOutputSchemas } from "./schemas/output.js";
import type { ToolServiceOutput } from "./output-mappers.js";
import { toolFailure, toolSuccess } from "./result.js";
import { ToolFailureStructuredContentSchema } from "./schemas/output.js";

type Registration<
  Name extends ToolName,
  InputSchema extends z.ZodType,
  ServiceResult,
> = Readonly<{
  name: Name;
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

export function registerMappedTool<
  Name extends ToolName,
  InputSchema extends z.ZodType,
  ServiceResult,
>(
  server: McpServer,
  registration: Registration<Name, InputSchema, ServiceResult>,
): void {
  server.registerTool<(typeof ToolOutputSchemas)[Name], z.ZodType>(
    registration.name,
    {
      description: registration.description,
      inputSchema: registration.inputSchema,
      outputSchema: registration.outputSchema,
      annotations: registration.annotations,
    },
    async (input, context): Promise<CallToolResult> => {
      const requestId = newRequestId();
      try {
        const parsed = registration.inputSchema.parse(input);
        const serviceResult = await registration.execute(
          parsed,
          context.signal,
        );
        const mapped = registration.mapOutput(serviceResult);
        const success = toolSuccess(mapped.data, {
          requestId,
          summary: registration.summary,
          warnings: mapped.warnings,
          rateLimit: mapped.rateLimit,
          nextCursor: mapped.nextCursor,
        });
        const plainStructuredContent: unknown = JSON.parse(
          JSON.stringify(success.structuredContent),
        );
        const structuredContent = registration.outputSchema.parse(
          plainStructuredContent,
        );
        return {
          ...success,
          structuredContent,
        };
      } catch (error) {
        const failure = toolFailure(error, requestId);
        const plainStructuredContent: unknown = JSON.parse(
          JSON.stringify(failure.structuredContent),
        );
        return {
          ...failure,
          structuredContent: ToolFailureStructuredContentSchema.parse(
            plainStructuredContent,
          ),
        };
      }
    },
  );
}
