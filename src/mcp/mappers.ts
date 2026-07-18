import type { ApplyInput as ApplyServiceInput } from "../app/services/apply-service.js";
import type {
  DiscoveryInput as DiscoveryServiceInput,
  DiscoveryQualifiers,
} from "../app/services/discovery-service.js";
import type { InspectInput as InspectServiceInput } from "../app/services/inspect-service.js";
import type { ListsQueryInput as ListsQueryServiceInput } from "../app/services/lists-query-service.js";
import type { CreatePlanInput } from "../app/services/plan-service.js";
import type {
  StarsQueryField,
  StarsQueryInput as StarsQueryServiceInput,
} from "../app/services/query-service.js";
import type { CreateRollbackInput } from "../app/services/rollback-service.js";
import type { StatusInput as StatusServiceInput } from "../app/services/status-service.js";
import type { SyncInput as SyncServiceInput } from "../app/services/sync-service.js";
import type { Clock } from "../app/ports/runtime-port.js";
import {
  parseFilter,
  type FilterExpression,
  type RepositorySort,
} from "../domain/filter.js";
import {
  asPlanId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
} from "../domain/ids.js";
import type {
  PlanAction,
  RepositorySelector,
  RequestedListTarget,
} from "../domain/plan.js";
import type {
  ApplyInput,
  InspectInput,
  PlanInput,
  PlanOperationInput,
  RollbackInput,
} from "./schemas/change-tools.js";
import type {
  FilterExpressionInput,
  FilterLeafInput,
  RepositorySelectorInput,
} from "./schemas/common.js";
import type {
  DiscoverInput,
  CandidatesQueryInput,
  ListsQueryInput,
  StarsQueryInput,
  StatusInput,
  SyncInput,
} from "./schemas/read-tools.js";
import type { CandidateQueryInput } from "../app/services/candidate-query-service.js";

function requestClock(clock: Pick<Clock, "now">): Pick<Clock, "now"> {
  let read = false;
  let timestamp = "";
  return {
    now(): string {
      if (!read) {
        timestamp = clock.now();
        read = true;
      }
      return timestamp;
    },
  };
}

function impossible(value: never): never {
  throw new TypeError(`Unsupported validated MCP input: ${String(value)}`);
}

function invalidValidatedInput(message: string): never {
  throw new TypeError(`Invalid validated MCP input: ${message}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStrings<Value extends string>(
  values: readonly Value[],
): Value[] {
  return values.map((value) => value).sort(compareText);
}

function domainFilterField(field: FilterLeafInput["field"]): string {
  switch (field) {
    case "name_with_owner":
      return "full_name";
    case "stargazers_count":
      return "stargazer_count";
    case "language":
      return "primary_language";
    case "license":
      return "license_spdx_id";
    case "archived":
      return "is_archived";
    case "disabled":
      return "is_disabled";
    case "fork":
      return "is_fork";
    case "repository_id":
    case "owner":
    case "name":
    case "description":
    case "pushed_at":
    case "updated_at":
    case "starred_at":
    case "topics":
    case "list_ids":
    case "is_unclassified":
    case "visibility":
    case "is_private":
      return field;
    default:
      return impossible(field);
  }
}

function copyFilterValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map<unknown>((member: unknown) => member);
  }
  if (typeof value === "object" && value !== null && "ago" in value) {
    const ago = value.ago;
    if (
      typeof ago === "object" &&
      ago !== null &&
      "amount" in ago &&
      "unit" in ago
    ) {
      return { ago: { amount: ago.amount, unit: ago.unit } };
    }
  }
  return value;
}

function domainFilterInput(input: FilterExpressionInput): unknown {
  if ("all" in input) {
    return { all: input.all.map(domainFilterInput) };
  }
  if ("any" in input) {
    return { any: input.any.map(domainFilterInput) };
  }
  if ("not" in input) {
    return { not: domainFilterInput(input.not) };
  }
  const field = domainFilterField(input.field);
  if (!("value" in input)) {
    return { field, op: "is_null", value: true };
  }
  return {
    field,
    op: input.op === "ne" ? "neq" : input.op,
    value: copyFilterValue(input.value),
  };
}

function toFilter(
  input: FilterExpressionInput,
  clock: Pick<Clock, "now">,
): FilterExpression {
  return parseFilter(domainFilterInput(input), clock);
}

function toStarsField(
  field: NonNullable<StarsQueryInput["fields"]>[number],
): StarsQueryField {
  switch (field) {
    case "name_with_owner":
      return "full_name";
    case "stargazers_count":
      return "stargazer_count";
    case "fork":
      return "is_fork";
    case "archived":
      return "is_archived";
    case "disabled":
      return "is_disabled";
    case "language":
      return "primary_language";
    case "license":
      return "license_spdx_id";
    case "repository_id":
    case "repository_database_id":
    case "owner":
    case "name":
    case "description":
    case "url":
    case "is_private":
    case "visibility":
    case "topics":
    case "pushed_at":
    case "updated_at":
    case "starred_at":
      return field;
    default:
      return impossible(field);
  }
}

function toSortField(
  field: StarsQueryInput["sort"][number]["field"],
): RepositorySort["field"] {
  switch (field) {
    case "stargazers_count":
      return "stargazer_count";
    case "name_with_owner":
      return "full_name";
    case "pushed_at":
    case "updated_at":
    case "starred_at":
      return field;
    default:
      return impossible(field);
  }
}

export function toStatusInput(input: StatusInput): StatusServiceInput {
  return { refreshCapabilities: input.refresh_capabilities };
}

export function toSyncInput(input: SyncInput): SyncServiceInput {
  return {
    mode: input.mode,
    includeLists: input.include_lists,
    metadataMaxAgeHours: input.metadata_max_age_hours,
  };
}

export function toStarsQueryInput(
  input: StarsQueryInput,
  clock: Pick<Clock, "now">,
): StarsQueryServiceInput {
  const now = requestClock(clock);
  return {
    snapshotId:
      input.snapshot_id === undefined ? null : asSnapshotId(input.snapshot_id),
    filter: input.where === undefined ? null : toFilter(input.where, now),
    sort: input.sort.map((term) => ({
      field: toSortField(term.field),
      direction: term.direction,
    })),
    limit: input.limit,
    cursor: input.cursor ?? null,
    fields:
      input.fields === undefined
        ? null
        : input.fields.map((field) => toStarsField(field)),
    evidence: input.evidence,
    evidenceLimit: input.evidence_limit,
  };
}

export function toListsQueryInput(
  input: ListsQueryInput,
): ListsQueryServiceInput {
  const snapshotId =
    input.snapshot_id === undefined ? null : asSnapshotId(input.snapshot_id);
  const cursor = input.cursor ?? null;
  if (input.mode === "lists") {
    return {
      mode: "lists",
      snapshotId,
      limit: input.limit,
      cursor,
    };
  }
  if (input.list_id !== undefined) {
    return {
      mode: "memberships",
      snapshotId,
      listId: asUserListId(input.list_id),
      limit: input.limit,
      cursor,
    };
  }
  if (input.repository_id === undefined) {
    return invalidValidatedInput("membership selector is missing");
  }
  return {
    mode: "memberships",
    snapshotId,
    repositoryId: asRepositoryId(input.repository_id),
    limit: input.limit,
    cursor,
  };
}

type MutableDiscoveryQualifiers = {
  -readonly [Key in keyof DiscoveryQualifiers]: DiscoveryQualifiers[Key];
};

export function toDiscoverInput(input: DiscoverInput): DiscoveryServiceInput {
  const qualifiers: MutableDiscoveryQualifiers = {};
  if (input.qualifiers.language !== undefined) {
    qualifiers.language = input.qualifiers.language;
  }
  if (input.qualifiers.topic !== undefined) {
    qualifiers.topic = input.qualifiers.topic.map((topic) => topic);
  }
  if (input.qualifiers.user !== undefined) {
    qualifiers.user = input.qualifiers.user;
  }
  if (input.qualifiers.org !== undefined) {
    qualifiers.org = input.qualifiers.org;
  }
  if (input.qualifiers.stars !== undefined) {
    qualifiers.stars = input.qualifiers.stars;
  }
  if (input.qualifiers.pushed !== undefined) {
    qualifiers.pushed = input.qualifiers.pushed;
  }
  if (input.qualifiers.archived !== undefined) {
    qualifiers.archived = input.qualifiers.archived;
  }
  if (input.qualifiers.fork !== undefined) {
    qualifiers.fork = input.qualifiers.fork;
  }
  return {
    query: input.query,
    qualifiers,
    sort: input.sort === "best-match" ? null : input.sort,
    order: input.order,
    limit: input.limit,
    cursor: input.cursor ?? null,
    evidence: input.evidence,
    evidenceLimit: input.evidence_limit,
  };
}

export function toCandidatesQueryInput(
  input: CandidatesQueryInput,
): CandidateQueryInput {
  return {
    state: input.state ?? null,
    query: input.query ?? null,
    limit: input.limit,
    cursor: input.cursor ?? null,
  };
}

function toRepositorySelector(
  input: RepositorySelectorInput,
  clock: Pick<Clock, "now">,
): RepositorySelector {
  if ("repository_ids" in input) {
    return {
      kind: "ids",
      repositoryIds: sortedStrings(input.repository_ids.map(asRepositoryId)),
    };
  }
  return {
    kind: "filter",
    filter: toFilter(input.where, clock),
  };
}

function toRequestedListTarget(
  input: Extract<
    PlanOperationInput,
    { kind: "list_membership_set" | "list_membership_add" }
  >["lists"][number],
): RequestedListTarget {
  return "list_id" in input
    ? { kind: "existing", listId: asUserListId(input.list_id) }
    : { kind: "created", clientRef: input.client_ref };
}

function compareRequestedTargets(
  left: RequestedListTarget,
  right: RequestedListTarget,
): number {
  if (left.kind !== right.kind) return left.kind === "existing" ? -1 : 1;
  return compareText(
    left.kind === "existing" ? left.listId : left.clientRef,
    right.kind === "existing" ? right.listId : right.clientRef,
  );
}

function toPlanAction(
  input: PlanOperationInput,
  clock: Pick<Clock, "now">,
): PlanAction {
  switch (input.kind) {
    case "star":
    case "unstar":
      return {
        kind: input.kind,
        repositories: toRepositorySelector(input.repositories, clock),
      };
    case "list_create":
      return {
        kind: "list_create",
        clientRef: input.client_ref,
        name: input.name,
        description: input.description,
        isPrivate: input.is_private,
      };
    case "list_update": {
      const result: {
        kind: "list_update";
        listIds: ReturnType<typeof asUserListId>[];
        name?: string;
        description?: string | null;
        isPrivate?: boolean;
      } = {
        kind: "list_update",
        listIds: sortedStrings(input.list_ids.map(asUserListId)),
      };
      if (input.name !== undefined) result.name = input.name;
      if (input.description !== undefined) {
        result.description = input.description;
      }
      if (input.is_private !== undefined) {
        result.isPrivate = input.is_private;
      }
      return result;
    }
    case "list_delete":
      return {
        kind: "list_delete",
        listIds: sortedStrings(input.list_ids.map(asUserListId)),
      };
    case "list_membership_set":
    case "list_membership_add":
      return {
        kind: input.kind,
        repositories: toRepositorySelector(input.repositories, clock),
        lists: input.lists
          .map(toRequestedListTarget)
          .sort(compareRequestedTargets),
      };
    case "list_membership_remove":
      return {
        kind: "list_membership_remove",
        repositories: toRepositorySelector(input.repositories, clock),
        lists: input.lists
          .map((target) => ({
            kind: "existing" as const,
            listId: asUserListId(target.list_id),
          }))
          .sort(compareRequestedTargets),
      };
    default:
      return impossible(input);
  }
}

export function toCreatePlanInput(
  input: PlanInput,
  clock: Pick<Clock, "now">,
): CreatePlanInput {
  const now = requestClock(clock);
  const result: {
    snapshotId: CreatePlanInput["snapshotId"];
    actions: CreatePlanInput["actions"];
    protectedRepositoryIds: CreatePlanInput["protectedRepositoryIds"];
    protectedListIds: CreatePlanInput["protectedListIds"];
    ttlMinutes?: number;
    callerNote?: string;
  } = {
    snapshotId: asSnapshotId(input.snapshot_id),
    actions: input.operations.map((operation) => toPlanAction(operation, now)),
    protectedRepositoryIds: sortedStrings(
      input.protected_repository_ids.map(asRepositoryId),
    ),
    protectedListIds: sortedStrings(input.protected_list_ids.map(asUserListId)),
  };
  if (input.expires_in_minutes !== undefined) {
    result.ttlMinutes = input.expires_in_minutes;
  }
  if (input.caller_note !== undefined) result.callerNote = input.caller_note;
  return result;
}

export function toInspectInput(input: InspectInput): InspectServiceInput {
  const cursor = input.cursor ?? null;
  switch (input.kind) {
    case "plan":
      return {
        kind: "plan",
        id: asPlanId(input.id),
        limit: input.limit,
        cursor,
      };
    case "run":
      return {
        kind: "run",
        id: asRunId(input.id),
        limit: input.limit,
        cursor,
      };
    case "attempts":
    case "reconciliations":
      if (input.operation_id === undefined) {
        return invalidValidatedInput("operation_id is missing");
      }
      return {
        kind: input.kind,
        id: asRunId(input.id),
        operationId: input.operation_id,
        limit: input.limit,
        cursor,
      };
    default:
      return impossible(input.kind);
  }
}

export function toApplyInput(input: ApplyInput): ApplyServiceInput {
  return {
    planId: asPlanId(input.plan_id),
    expectedHash: input.expected_hash,
    failureMode: input.failure_mode,
  };
}

export function toRollbackInput(input: RollbackInput): CreateRollbackInput {
  const result: {
    runId: CreateRollbackInput["runId"];
    protectedRepositoryIds: CreateRollbackInput["protectedRepositoryIds"];
    protectedListIds: CreateRollbackInput["protectedListIds"];
    ttlMinutes?: number;
    callerNote?: string;
  } = {
    runId: asRunId(input.run_id),
    protectedRepositoryIds: sortedStrings(
      input.protected_repository_ids.map(asRepositoryId),
    ),
    protectedListIds: sortedStrings(input.protected_list_ids.map(asUserListId)),
  };
  if (input.expires_in_minutes !== undefined) {
    result.ttlMinutes = input.expires_in_minutes;
  }
  if (input.caller_note !== undefined) result.callerNote = input.caller_note;
  return result;
}
