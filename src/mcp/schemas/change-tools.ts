import { z } from "zod";
import {
  ClientRefSchema,
  CursorSchema,
  OperationIdSchema,
  PageSizeSchema,
  PlanIdSchema,
  RepositoryIdSchema,
  RepositorySelectorSchema,
  RunIdSchema,
  SnapshotIdSchema,
  UserListIdSchema,
  uniqueStringArray,
} from "./common.js";

const RepositoryIdsSchema = uniqueStringArray(RepositoryIdSchema, 0, 5_000);
const ListIdsSchema = uniqueStringArray(UserListIdSchema, 0, 5_000);
const NonEmptyListIdsSchema = uniqueStringArray(UserListIdSchema, 1, 5_000);

const ListNameSchema = z.string().trim().min(1).max(100);
const ListDescriptionSchema = z.string().max(1_024).nullable();

const ExistingListTargetSchema = z
  .object({ list_id: UserListIdSchema })
  .strict();
const CreatedListTargetSchema = z
  .object({ client_ref: ClientRefSchema })
  .strict();
const RequestedListTargetSchema = z.union([
  ExistingListTargetSchema,
  CreatedListTargetSchema,
]);

function targetKey(
  value:
    | z.infer<typeof ExistingListTargetSchema>
    | z.infer<typeof CreatedListTargetSchema>,
): string {
  return "list_id" in value
    ? `existing:${value.list_id}`
    : `created:${value.client_ref}`;
}

function uniqueTargets(
  value: readonly (
    | z.infer<typeof ExistingListTargetSchema>
    | z.infer<typeof CreatedListTargetSchema>
  )[],
  context: z.RefinementCtx,
): void {
  const keys = value.map(targetKey);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      message: "List targets must be unique",
    });
  }
}

const StarOperationSchema = z
  .object({
    kind: z.literal("star"),
    repositories: RepositorySelectorSchema,
  })
  .strict();
const UnstarOperationSchema = z
  .object({
    kind: z.literal("unstar"),
    repositories: RepositorySelectorSchema,
  })
  .strict();
const ListCreateOperationSchema = z
  .object({
    kind: z.literal("list_create"),
    client_ref: ClientRefSchema,
    name: ListNameSchema,
    description: ListDescriptionSchema.default(null),
    is_private: z.boolean().default(false),
  })
  .strict();
const ListUpdateOperationSchema = z
  .object({
    kind: z.literal("list_update"),
    list_ids: NonEmptyListIdsSchema,
    name: ListNameSchema.optional(),
    description: ListDescriptionSchema.optional(),
    is_private: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.name === undefined &&
      value.description === undefined &&
      value.is_private === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "List update requires at least one metadata field",
      });
    }
  });
const ListDeleteOperationSchema = z
  .object({
    kind: z.literal("list_delete"),
    list_ids: NonEmptyListIdsSchema,
  })
  .strict();
const MembershipSetOperationSchema = z
  .object({
    kind: z.literal("list_membership_set"),
    repositories: RepositorySelectorSchema,
    lists: z
      .array(RequestedListTargetSchema)
      .max(5_000)
      .superRefine(uniqueTargets),
  })
  .strict();
const MembershipAddOperationSchema = z
  .object({
    kind: z.literal("list_membership_add"),
    repositories: RepositorySelectorSchema,
    lists: z
      .array(RequestedListTargetSchema)
      .min(1)
      .max(5_000)
      .superRefine(uniqueTargets),
  })
  .strict();
const MembershipRemoveOperationSchema = z
  .object({
    kind: z.literal("list_membership_remove"),
    repositories: RepositorySelectorSchema,
    lists: z
      .array(ExistingListTargetSchema)
      .min(1)
      .max(5_000)
      .superRefine(uniqueTargets),
  })
  .strict();

export const PlanOperationSchema = z.union([
  StarOperationSchema,
  UnstarOperationSchema,
  ListCreateOperationSchema,
  ListUpdateOperationSchema,
  ListDeleteOperationSchema,
  MembershipSetOperationSchema,
  MembershipAddOperationSchema,
  MembershipRemoveOperationSchema,
]);

export const PlanInputSchema = z
  .object({
    snapshot_id: SnapshotIdSchema,
    operations: z.array(PlanOperationSchema).min(1).max(5_000),
    protected_repository_ids: RepositoryIdsSchema.default([]),
    protected_list_ids: ListIdsSchema.default([]),
    expires_in_minutes: z.number().int().min(1).max(10_080).optional(),
    caller_note: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const createRefs = value.operations
      .filter(
        (operation): operation is z.infer<typeof ListCreateOperationSchema> =>
          operation.kind === "list_create",
      )
      .map((operation) => operation.client_ref);
    if (new Set(createRefs).size !== createRefs.length) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "List create client references must be unique",
      });
    }
    const knownRefs = new Set(createRefs);
    for (let index = 0; index < value.operations.length; index += 1) {
      const operation = value.operations[index];
      if (
        operation?.kind !== "list_membership_set" &&
        operation?.kind !== "list_membership_add"
      ) {
        continue;
      }
      for (const target of operation.lists) {
        if ("client_ref" in target && !knownRefs.has(target.client_ref)) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "lists"],
            message: "created List target does not resolve to a List create",
          });
        }
      }
    }
  });

export const InspectInputSchema = z
  .object({
    kind: z.enum(["plan", "run", "attempts", "reconciliations"]),
    id: z.union([PlanIdSchema, RunIdSchema]),
    operation_id: OperationIdSchema.optional(),
    limit: PageSizeSchema,
    cursor: CursorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsOperation =
      value.kind === "attempts" || value.kind === "reconciliations";
    if (needsOperation !== (value.operation_id !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["operation_id"],
        message:
          "operation_id is required only for attempts and reconciliations",
      });
    }
  });

export const ApplyInputSchema = z
  .object({
    plan_id: PlanIdSchema,
    expected_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    failure_mode: z.enum(["stop", "continue"]).default("stop"),
  })
  .strict();

export const RollbackInputSchema = z
  .object({
    run_id: RunIdSchema,
    protected_repository_ids: RepositoryIdsSchema.default([]),
    protected_list_ids: ListIdsSchema.default([]),
    expires_in_minutes: z.number().int().min(1).max(10_080).optional(),
    caller_note: z.string().max(2_000).optional(),
  })
  .strict();

export type PlanOperationInput = z.infer<typeof PlanOperationSchema>;
export type PlanInput = z.infer<typeof PlanInputSchema>;
export type InspectInput = z.infer<typeof InspectInputSchema>;
export type ApplyInput = z.infer<typeof ApplyInputSchema>;
export type RollbackInput = z.infer<typeof RollbackInputSchema>;
