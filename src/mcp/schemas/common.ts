import { Buffer } from "node:buffer";
import { z } from "zod";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";

export const ToolNames = [
  "github_stars_status",
  "github_stars_sync",
  "github_stars_query",
  "github_lists_query",
  "github_changes_plan",
  "github_changes_inspect",
  "github_changes_apply",
  "github_changes_rollback",
  "github_repositories_discover",
  "github_repositories_candidates",
] as const;

export type ToolName = (typeof ToolNames)[number];

export const CursorSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 4_096, {
    message: "cursor must not exceed 4,096 UTF-8 bytes",
  });

export const StableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim(), {
    message: "stable identifiers must be trim-equal",
  });

export const RepositoryIdSchema = StableIdSchema;
export const UserListIdSchema = StableIdSchema;
export const SnapshotIdSchema = StableIdSchema;
export const PlanIdSchema = StableIdSchema;
export const RunIdSchema = StableIdSchema;
export const OperationIdSchema = StableIdSchema;
export const ClientRefSchema = z.string().regex(/^ref_[A-Za-z0-9_-]{1,64}$/u);

export const PageSizeSchema = z.number().int().min(1).max(100).default(50);

function addDuplicateIssue(
  values: readonly (boolean | number | string)[],
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: "array members must be unique",
    });
  }
}

export function uniqueStringArray(
  item: z.ZodString,
  minimum: number,
  maximum: number,
): z.ZodArray<z.ZodString> {
  return z.array(item).min(minimum).max(maximum).superRefine(addDuplicateIssue);
}

const StringSetSchema = uniqueStringArray(z.string().max(1_024), 1, 5_000);
const CollectionSetSchema = uniqueStringArray(z.string().max(128), 1, 5_000);
const NumberSetSchema = z
  .array(z.number().finite())
  .min(1)
  .max(5_000)
  .superRefine(addDuplicateIssue);

const NonNullableStringFieldSchema = z.enum([
  "repository_id",
  "owner",
  "name",
  "name_with_owner",
  "visibility",
]);
const NullableStringFieldSchema = z.enum([
  "description",
  "language",
  "license",
]);
const StringFieldSchema = z.union([
  NonNullableStringFieldSchema,
  NullableStringFieldSchema,
]);
const BooleanFieldSchema = z.enum([
  "fork",
  "archived",
  "disabled",
  "is_private",
  "is_unclassified",
]);
const NonNullableTemporalFieldSchema = z.enum(["updated_at", "starred_at"]);
const NullableTemporalFieldSchema = z.literal("pushed_at");
const TemporalFieldSchema = z.union([
  NonNullableTemporalFieldSchema,
  NullableTemporalFieldSchema,
]);
const CollectionFieldSchema = z.enum(["topics", "list_ids"]);

const RelativeTimestampSchema = z
  .object({
    ago: z
      .object({
        amount: z.number().int().min(1).max(10_000),
        unit: z.enum(["hours", "days", "weeks", "months", "years"]),
      })
      .strict(),
  })
  .strict();

const AbsoluteUtcTimestampSchema = z.string().superRefine((value, context) => {
  try {
    canonicalUtcTimestamp(value, "filter timestamp");
  } catch {
    context.addIssue({
      code: "custom",
      message:
        "filter timestamp must use valid YYYY-MM-DDTHH:mm:ss[.SSS]Z UTC form",
    });
  }
});

const TimestampInputSchema = z.union([
  AbsoluteUtcTimestampSchema,
  RelativeTimestampSchema,
]);

function publicStringLimit(field: z.infer<typeof StringFieldSchema>): number {
  switch (field) {
    case "repository_id":
    case "license":
      return 128;
    case "owner":
      return 39;
    case "name":
    case "language":
      return 100;
    case "name_with_owner":
      return 256;
    case "visibility":
      return 16;
    case "description":
      return 1_024;
  }
}

function checkPublicString(
  field: z.infer<typeof StringFieldSchema>,
  value: string,
  path: readonly (number | string)[],
  context: z.RefinementCtx,
): void {
  if (
    value.length > publicStringLimit(field) ||
    (field === "repository_id" && value !== value.trim())
  ) {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: `${field} filter value exceeds its public field boundary`,
    });
  }
}

const StringScalarLeafSchema = z
  .object({
    field: StringFieldSchema,
    op: z.enum(["eq", "ne", "contains"]),
    value: z.string().max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    checkPublicString(value.field, value.value, ["value"], context);
  });
const StringSetLeafSchema = z
  .object({
    field: StringFieldSchema,
    op: z.enum(["in", "not_in"]),
    value: StringSetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 0; index < value.value.length; index += 1) {
      const member = value.value[index];
      if (member !== undefined) {
        checkPublicString(value.field, member, ["value", index], context);
      }
    }
  });
const NullableStringLeafSchema = z
  .object({
    field: NullableStringFieldSchema,
    op: z.literal("is_null"),
  })
  .strict();
const NumberScalarLeafSchema = z
  .object({
    field: z.literal("stargazers_count"),
    op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
    value: z.number().finite(),
  })
  .strict();
const NumberSetLeafSchema = z
  .object({
    field: z.literal("stargazers_count"),
    op: z.enum(["in", "not_in"]),
    value: NumberSetSchema,
  })
  .strict();
const BooleanLeafSchema = z
  .object({
    field: BooleanFieldSchema,
    op: z.enum(["eq", "ne"]),
    value: z.boolean(),
  })
  .strict();
const TemporalLeafSchema = z
  .object({
    field: TemporalFieldSchema,
    op: z.enum(["before", "after"]),
    value: TimestampInputSchema,
  })
  .strict();
const TemporalEqualityLeafSchema = z
  .object({
    field: TemporalFieldSchema,
    op: z.literal("eq"),
    value: AbsoluteUtcTimestampSchema,
  })
  .strict();
const NullableTemporalLeafSchema = z
  .object({
    field: NullableTemporalFieldSchema,
    op: z.literal("is_null"),
  })
  .strict();
const CollectionScalarLeafSchema = z
  .object({
    field: CollectionFieldSchema,
    op: z.enum(["contains", "not_contains"]),
    value: z.string().max(128),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.field === "topics" && value.value.length > 50) ||
      (value.field === "list_ids" && value.value !== value.value.trim())
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `${value.field} filter value exceeds its public field boundary`,
      });
    }
  });
const CollectionSetLeafSchema = z
  .object({
    field: CollectionFieldSchema,
    op: z.enum(["in", "not_in"]),
    value: CollectionSetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 0; index < value.value.length; index += 1) {
      const member = value.value[index];
      if (
        member !== undefined &&
        ((value.field === "topics" && member.length > 50) ||
          (value.field === "list_ids" && member !== member.trim()))
      ) {
        context.addIssue({
          code: "custom",
          path: ["value", index],
          message: `${value.field} filter value exceeds its public field boundary`,
        });
      }
    }
  });
const CollectionNullLeafSchema = z
  .object({
    field: CollectionFieldSchema,
    op: z.literal("is_null"),
  })
  .strict();

export const FilterLeafSchema = z
  .union([
    StringScalarLeafSchema,
    StringSetLeafSchema,
    NullableStringLeafSchema,
    NumberScalarLeafSchema,
    NumberSetLeafSchema,
    BooleanLeafSchema,
    TemporalLeafSchema,
    TemporalEqualityLeafSchema,
    NullableTemporalLeafSchema,
    CollectionScalarLeafSchema,
    CollectionSetLeafSchema,
    CollectionNullLeafSchema,
  ])
  .meta({ id: "GithubStarsMcpFilterLeaf" });

export type FilterLeafInput = z.infer<typeof FilterLeafSchema>;
export type FilterExpressionInput =
  | FilterLeafInput
  | { all: FilterExpressionInput[] }
  | { any: FilterExpressionInput[] }
  | { not: FilterExpressionInput };

let filterAtDepth: z.ZodType<FilterExpressionInput> = FilterLeafSchema;
for (let depth = 11; depth >= 1; depth -= 1) {
  const child = filterAtDepth;
  const next = z.union([
    FilterLeafSchema,
    z.object({ all: z.array(child).min(1).max(100) }).strict(),
    z.object({ any: z.array(child).min(1).max(100) }).strict(),
    z.object({ not: child }).strict(),
  ]);
  filterAtDepth =
    depth === 1
      ? next
      : next.meta({ id: `GithubStarsMcpFilterDepth${String(depth)}` });
}

function filterTotals(
  root: FilterExpressionInput,
): Readonly<{ leaves: number; setMembers: number }> {
  let leaves = 0;
  let setMembers = 0;
  const pending: FilterExpressionInput[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if ("all" in node) {
      pending.push(...node.all);
      continue;
    }
    if ("any" in node) {
      pending.push(...node.any);
      continue;
    }
    if ("not" in node) {
      pending.push(node.not);
      continue;
    }
    leaves += 1;
    if ("value" in node && Array.isArray(node.value)) {
      setMembers += node.value.length;
    }
  }
  return { leaves, setMembers };
}

export const FilterExpressionSchema = filterAtDepth
  .superRefine((value, context) => {
    const totals = filterTotals(value);
    if (totals.leaves > 100) {
      context.addIssue({
        code: "custom",
        message: "filter must not contain more than 100 leaves",
      });
    }
    if (totals.setMembers > 10_000) {
      context.addIssue({
        code: "custom",
        message: "filter sets must not contain more than 10,000 total members",
      });
    }
  })
  .meta({ id: "GithubStarsMcpFilterExpression" });

const RepositoryIdsSelectorSchema = z
  .object({
    repository_ids: uniqueStringArray(RepositoryIdSchema, 1, 5_000),
  })
  .strict();
const RepositoryFilterSelectorSchema = z
  .object({ where: FilterExpressionSchema })
  .strict();

export const RepositorySelectorSchema = z.union([
  RepositoryIdsSelectorSchema,
  RepositoryFilterSelectorSchema,
]);

export type RepositorySelectorInput = z.infer<typeof RepositorySelectorSchema>;
