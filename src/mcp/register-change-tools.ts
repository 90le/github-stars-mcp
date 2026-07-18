import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationCoordinator } from "../app/services/operation-coordinator.js";
import type { ServiceRegistry } from "../app/services/service-registry.js";
import {
  toApplyInput,
  toCreatePlanInput,
  toInspectInput,
  toRollbackInput,
} from "./mappers.js";
import {
  toApplyOutput,
  toInspectOutput,
  toPlanOutput,
  toRollbackOutput,
} from "./output-mappers.js";
import { registerMappedTool } from "./register-tool.js";
import {
  ApplyInputSchema,
  InspectInputSchema,
  PlanInputSchema,
  RollbackInputSchema,
} from "./schemas/change-tools.js";
import { ToolOutputSchemas } from "./schemas/output.js";

export function registerChangeTools(
  server: McpServer,
  services: ServiceRegistry,
  coordinator?: OperationCoordinator,
): void {
  registerMappedTool(
    server,
    {
      name: "github_changes_plan",
      title: "Plan GitHub Changes",
      description:
        "Resolve and persist a local change plan only. This tool performs no GitHub network write; inspect the immutable plan before applying it.",
      inputSchema: PlanInputSchema,
      outputSchema: ToolOutputSchemas.github_changes_plan,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execute: (input) =>
        services.plan.create(toCreatePlanInput(input, services.clock)),
      mapOutput: toPlanOutput,
      summary: "Change plan created; inspect it before apply.",
    },
    coordinator,
  );

  registerMappedTool(
    server,
    {
      name: "github_changes_inspect",
      title: "Inspect GitHub Changes",
      description:
        "Read a local plan, run, dispatch attempt, or reconciliation history page. This tool performs no network access and writes no state.",
      inputSchema: InspectInputSchema,
      outputSchema: ToolOutputSchemas.github_changes_inspect,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: (input) => services.inspect.inspect(toInspectInput(input)),
      mapOutput: toInspectOutput,
      summary: "Change inspection completed.",
    },
    coordinator,
  );

  registerMappedTool(
    server,
    {
      name: "github_changes_apply",
      title: "Apply GitHub Changes",
      description:
        "Apply an exact hash-bound plan through GitHub network writes. This can unstar repositories or delete Lists and is resumable through its persisted local run.",
      inputSchema: ApplyInputSchema,
      outputSchema: ToolOutputSchemas.github_changes_apply,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      execute: (input, signal) =>
        services.apply.apply(toApplyInput(input), signal),
      mapOutput: toApplyOutput,
      summary: "Change plan apply completed.",
    },
    coordinator,
  );

  registerMappedTool(
    server,
    {
      name: "github_changes_rollback",
      title: "Create GitHub Rollback Plan",
      description:
        "Create and persist a local rollback plan from an audited run. This tool does not write to GitHub; inspect and explicitly apply the returned plan.",
      inputSchema: RollbackInputSchema,
      outputSchema: ToolOutputSchemas.github_changes_rollback,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execute: (input) =>
        services.rollback.createRollback(toRollbackInput(input)),
      mapOutput: toRollbackOutput,
      summary: "Rollback plan created; inspect it before apply.",
    },
    coordinator,
  );
}
