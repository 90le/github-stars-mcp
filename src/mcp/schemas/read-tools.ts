import { z } from "zod";
import {
  CursorSchema,
  FilterExpressionSchema,
  PageSizeSchema,
  RepositoryIdSchema,
  SnapshotIdSchema,
  UserListIdSchema,
} from "./common.js";

function requireUnique(
  values: readonly string[],
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: "array members must be unique",
    });
  }
}

function requireEvidenceLimit(
  value: Readonly<{ evidence: string; evidence_limit: number }>,
  context: z.RefinementCtx,
): void {
  if (value.evidence === "none" && value.evidence_limit !== 0) {
    context.addIssue({
      code: "custom",
      path: ["evidence_limit"],
      message: "evidence_limit must be zero when evidence is none",
    });
  }
}

export const StatusInputSchema = z
  .object({
    refresh_capabilities: z.boolean().default(false),
  })
  .strict();

export const SyncInputSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).default("incremental"),
    include_lists: z.boolean().default(true),
    metadata_max_age_hours: z.number().int().min(0).max(8_760).default(24),
  })
  .strict();

export const StarsQueryFieldSchema = z.enum([
  "repository_id",
  "repository_database_id",
  "owner",
  "name",
  "name_with_owner",
  "description",
  "url",
  "stargazers_count",
  "fork",
  "archived",
  "disabled",
  "is_private",
  "visibility",
  "language",
  "topics",
  "license",
  "pushed_at",
  "updated_at",
  "starred_at",
]);

export const StarsSortFieldSchema = z.enum([
  "stargazers_count",
  "pushed_at",
  "updated_at",
  "starred_at",
  "name_with_owner",
]);

const StarsSortSchema = z
  .array(
    z
      .object({
        field: StarsSortFieldSchema,
        direction: z.enum(["asc", "desc"]),
      })
      .strict(),
  )
  .min(1)
  .max(4)
  .superRefine((values, context) => {
    requireUnique(
      values.map((value) => value.field),
      context,
    );
  })
  .default([{ field: "starred_at", direction: "desc" }]);

const StarsFieldsSchema = z
  .array(StarsQueryFieldSchema)
  .max(19)
  .superRefine(requireUnique);

export const StarsQueryInputSchema = z
  .object({
    snapshot_id: SnapshotIdSchema.optional(),
    where: FilterExpressionSchema.optional(),
    sort: StarsSortSchema,
    limit: PageSizeSchema,
    cursor: CursorSchema.optional(),
    fields: StarsFieldsSchema.optional(),
    evidence: z.enum(["none", "summary", "readme"]).default("none"),
    evidence_limit: z.number().int().min(0).max(20).default(0),
  })
  .strict()
  .superRefine(requireEvidenceLimit);

export const ListsQueryInputSchema = z
  .object({
    mode: z.enum(["lists", "memberships"]),
    snapshot_id: SnapshotIdSchema.optional(),
    list_id: UserListIdSchema.optional(),
    repository_id: RepositoryIdSchema.optional(),
    limit: PageSizeSchema,
    cursor: CursorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const selectorCount =
      Number(value.list_id !== undefined) +
      Number(value.repository_id !== undefined);
    if (
      (value.mode === "lists" && selectorCount !== 0) ||
      (value.mode === "memberships" && selectorCount !== 1)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "lists mode accepts no selector; memberships requires exactly one selector",
      });
    }
  });

const TopicSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/u);
const LoginSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u);
const TrimEqualTextSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), {
      message: "text must be trim-equal",
    });
const SearchQuerySchema = z.string().trim().min(1).max(256);

const DiscoveryQualifiersSchema = z
  .object({
    language: TrimEqualTextSchema(100).optional(),
    topic: z.array(TopicSchema).max(20).superRefine(requireUnique).optional(),
    user: LoginSchema.optional(),
    org: LoginSchema.optional(),
    stars: TrimEqualTextSchema(64).optional(),
    pushed: TrimEqualTextSchema(64).optional(),
    archived: z.boolean().optional(),
    fork: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.user !== undefined && value.org !== undefined) {
      context.addIssue({
        code: "custom",
        message: "user and org qualifiers cannot be combined",
      });
    }
  })
  .default({});

const DiscoveryCursorSchema = CursorSchema.refine(
  (value) => /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)),
  { message: "discovery cursor must be a canonical positive page" },
);

export const DiscoverInputSchema = z
  .object({
    query: SearchQuerySchema,
    qualifiers: DiscoveryQualifiersSchema,
    sort: z
      .enum(["best-match", "stars", "forks", "help-wanted-issues", "updated"])
      .default("best-match"),
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(100).default(30),
    cursor: DiscoveryCursorSchema.optional(),
    evidence: z.enum(["none", "summary", "readme"]).default("none"),
    evidence_limit: z.number().int().min(0).max(20).default(0),
  })
  .strict()
  .superRefine((value, context) => {
    requireEvidenceLimit(value, context);
    const page = value.cursor === undefined ? 1 : Number(value.cursor);
    if (page - 1 > Math.floor(999 / value.limit)) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "discovery offset exceeds GitHub's 1,000-result cap",
      });
    }
  });

export const CandidatesQueryInputSchema = z
  .object({
    state: z
      .enum(["discovered", "selected", "dismissed", "starred"])
      .optional(),
    query: SearchQuerySchema.optional(),
    limit: PageSizeSchema,
    cursor: CursorSchema.optional(),
  })
  .strict();

export type StatusInput = z.infer<typeof StatusInputSchema>;
export type SyncInput = z.infer<typeof SyncInputSchema>;
export type StarsQueryInput = z.infer<typeof StarsQueryInputSchema>;
export type ListsQueryInput = z.infer<typeof ListsQueryInputSchema>;
export type DiscoverInput = z.infer<typeof DiscoverInputSchema>;
export type CandidatesQueryInput = z.infer<typeof CandidatesQueryInputSchema>;
