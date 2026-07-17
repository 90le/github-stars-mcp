import { randomUUID } from "node:crypto";
import { z } from "zod";

type Brand<T, B extends string> = T & { readonly __brand: B };

export type RepositoryId = Brand<string, "RepositoryId">;
export type RepositoryDatabaseId = Brand<string, "RepositoryDatabaseId">;
export type UserListId = Brand<string, "UserListId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type PlanId = Brand<string, "PlanId">;
export type RunId = Brand<string, "RunId">;

function parseStableId<T extends string>(value: string, fieldName: string): T {
  const parsed = z
    .string()
    .min(1, `${fieldName} must not be empty`)
    .refine((candidate) => candidate === candidate.trim(), {
      message: `${fieldName} must be trim-equal`,
    })
    .parse(value);

  return parsed as T;
}

export function asRepositoryId(value: string): RepositoryId {
  return parseStableId<RepositoryId>(value, "repository_id");
}

export function asRepositoryDatabaseId(value: string): RepositoryDatabaseId {
  const parsed = z
    .string()
    .regex(
      /^(0|[1-9]\d*)$/u,
      "repository_database_id must be a non-negative decimal integer",
    )
    .parse(value);

  return parsed as RepositoryDatabaseId;
}

export function asUserListId(value: string): UserListId {
  return parseStableId<UserListId>(value, "user_list_id");
}

export function asSnapshotId(value: string): SnapshotId {
  return parseStableId<SnapshotId>(value, "snapshot_id");
}

export function asPlanId(value: string): PlanId {
  return parseStableId<PlanId>(value, "plan_id");
}

export function asRunId(value: string): RunId {
  return parseStableId<RunId>(value, "run_id");
}

export function newSnapshotId(): SnapshotId {
  return asSnapshotId(`snap_${randomUUID()}`);
}

export function newPlanId(): PlanId {
  return asPlanId(`plan_${randomUUID()}`);
}

export function newRunId(): RunId {
  return asRunId(`run_${randomUUID()}`);
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function newOperationId(): string {
  return `op_${randomUUID()}`;
}
