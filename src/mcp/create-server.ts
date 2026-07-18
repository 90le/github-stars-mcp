import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationCoordinator } from "../app/services/operation-coordinator.js";
import type { ServiceRegistry } from "../app/services/service-registry.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.js";
import { registerChangeTools } from "./register-change-tools.js";
import { registerReadTools } from "./register-read-tools.js";

const SERVER_INSTRUCTIONS =
  "Sync before querying or planning. Protect explicit repository IDs for subjective exceptions. " +
  "Inspect the immutable plan and plan_hash before apply, and apply only with explicit authorization " +
  "for that exact plan. This server manages GitHub Stars and User Lists only; repository administration, " +
  "repository deletion, and repository contents are unavailable. Paginate until next_cursor is null. " +
  "Rollback creates another reviewed plan and cannot restore original starred_at timestamps or deleted " +
  "User List IDs. Respect rate-limit reset metadata. Code inactivity uses pushed_at; updated_at also " +
  "changes for metadata.";

export function createMcpServer(
  services: ServiceRegistry,
  coordinator?: OperationCoordinator,
): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerReadTools(server, services, coordinator);
  registerChangeTools(server, services, coordinator);
  return server;
}
