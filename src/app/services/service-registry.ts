import type { Clock } from "../ports/runtime-port.js";
import type { ApplyService } from "./apply-service.js";
import type { CandidateQueryService } from "./candidate-query-service.js";
import type { DiscoveryService } from "./discovery-service.js";
import type { InspectService } from "./inspect-service.js";
import type { ListsQueryService } from "./lists-query-service.js";
import type { PlanService } from "./plan-service.js";
import type { QueryService } from "./query-service.js";
import type { RollbackService } from "./rollback-service.js";
import type { StatusService } from "./status-service.js";
import type { SyncService } from "./sync-service.js";

export type ServiceRegistry = Readonly<{
  clock: Pick<Clock, "now">;
  status: Pick<StatusService, "status">;
  sync: Pick<SyncService, "sync">;
  query: Pick<QueryService, "query">;
  listsQuery: Pick<ListsQueryService, "query">;
  discover: Pick<DiscoveryService, "discover">;
  candidates: Pick<CandidateQueryService, "query">;
  plan: Pick<PlanService, "create">;
  inspect: Pick<InspectService, "inspect">;
  apply: Pick<ApplyService, "apply">;
  rollback: Pick<RollbackService, "createRollback">;
}>;
