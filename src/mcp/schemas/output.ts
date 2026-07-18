import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  canonicalJson,
  canonicalJsonClone,
} from "../../domain/canonical-json.js";
import { APP_ERROR_CODES } from "../../domain/errors.js";
import type { JsonValue } from "../../domain/json.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";
import type { ToolName } from "./common.js";

const SafeIntegerSchema = z.number().int().nonnegative().safe();
const StableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim(), {
    message: "stable IDs must be trim-equal",
  });
const MAX_CURSOR_BYTES = 4_096;
const CursorSchema = z
  .string()
  .min(1)
  .max(MAX_CURSOR_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_CURSOR_BYTES,
    "cursor must not exceed 4096 UTF-8 bytes",
  )
  .describe("Opaque cursor limited to 4096 UTF-8 bytes at runtime");
const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    try {
      return canonicalUtcTimestamp(value) === value;
    } catch {
      return false;
    }
  }, "timestamp must be a canonical valid UTC instant");
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const BoundedTextSchema = z.string().max(2_000);
const NullableTimestampSchema = TimestampSchema.nullable();

const PublicJsonPrecheckSchema = z.unknown().superRefine((value, context) => {
  try {
    canonicalJson(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "value must satisfy the bounded public JSON contract",
    });
  }
});
export const PublicJsonValueSchema: z.ZodType<JsonValue> =
  PublicJsonPrecheckSchema.pipe(z.json());

const FORBIDDEN_OPAQUE_KEYS = new Set([
  "access_token",
  "account_id",
  "accountid",
  "authorization",
  "binding",
  "cookie",
  "host",
  "login",
  "password",
  "token",
]);

function hasForbiddenOpaqueKey(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenOpaqueKey);
  for (const [key, child] of Object.entries(value)) {
    if (
      FORBIDDEN_OPAQUE_KEYS.has(key.toLowerCase()) ||
      hasForbiddenOpaqueKey(child)
    ) {
      return true;
    }
  }
  return false;
}

const IdentityFreeJsonPrecheckSchema = z
  .unknown()
  .superRefine((value, context) => {
    try {
      const cloned = canonicalJsonClone(value);
      if (hasForbiddenOpaqueKey(cloned)) {
        context.addIssue({
          code: "custom",
          message:
            "value must satisfy the bounded identity-free public JSON contract",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "value must satisfy the bounded identity-free public JSON contract",
      });
    }
  });
const IdentityFreeJsonValueSchema: z.ZodType<JsonValue> =
  IdentityFreeJsonPrecheckSchema.pipe(z.json());

const RateLimitOutputSchema = z
  .object({
    remaining: SafeIntegerSchema,
    reset_at: TimestampSchema,
  })
  .strict();

const ToolSuccessBase = z
  .object({
    schema_version: z.literal("1"),
    ok: z.literal(true),
    request_id: z.string().min(1).max(128),
    warnings: z.array(z.string().max(512)).max(20),
    rate_limit: RateLimitOutputSchema.nullable(),
    next_cursor: CursorSchema.nullable(),
  })
  .strict();

function serializedErrorOutputSchema(details: z.ZodType<JsonValue>) {
  return z
    .object({
      code: z.enum(APP_ERROR_CODES),
      message: z.string().max(2_048),
      retryable: z.boolean(),
      details,
    })
    .strict();
}

const SerializedErrorOutputSchema = serializedErrorOutputSchema(
  PublicJsonValueSchema,
);
const IdentityFreeSerializedErrorOutputSchema = serializedErrorOutputSchema(
  IdentityFreeJsonValueSchema,
);

export const ToolFailureStructuredContentSchema = z
  .object({
    schema_version: z.literal("1"),
    ok: z.literal(false),
    request_id: z.string().min(1).max(128),
    error: SerializedErrorOutputSchema,
  })
  .strict();

function successOutput<T extends z.ZodType>(
  data: T,
): z.ZodObject<
  z.ZodRawShape & {
    data: T;
  }
> {
  return ToolSuccessBase.extend({ data }).strict();
}

const SnapshotCountsOutputSchema = z
  .object({
    repositories: SafeIntegerSchema,
    stars: SafeIntegerSchema,
    lists: SafeIntegerSchema,
    memberships: SafeIntegerSchema,
  })
  .strict();

const RunCountsOutputSchema = z
  .object({
    pending: SafeIntegerSchema,
    running: SafeIntegerSchema,
    succeeded: SafeIntegerSchema,
    skipped: SafeIntegerSchema,
    failed: SafeIntegerSchema,
    unresolved: SafeIntegerSchema,
  })
  .strict();

const SnapshotStatusOutputSchema = z
  .object({
    snapshot_id: StableIdSchema,
    mode: z.enum(["full", "incremental"]),
    list_coverage: z.enum(["complete", "unavailable", "omitted"]),
    status: z.literal("complete"),
    started_at: TimestampSchema,
    completed_at: TimestampSchema,
    failed_at: z.null(),
    counts: SnapshotCountsOutputSchema,
    warning_count: SafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.completed_at >= value.started_at, {
    message: "snapshot completion cannot precede its start",
  });

const IncompleteRunOutputSchema = z
  .object({
    run_id: StableIdSchema,
    plan_id: StableIdSchema,
    state: z.enum(["pending", "running", "partial"]),
    started_at: TimestampSchema,
    finished_at: NullableTimestampSchema,
    counts: RunCountsOutputSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const unfinished = value.state === "pending" || value.state === "running";
    if (
      (unfinished && value.finished_at !== null) ||
      (!unfinished && value.finished_at === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "incomplete run timestamps do not match its lifecycle state",
      });
    }
    if (value.finished_at !== null && value.finished_at < value.started_at) {
      context.addIssue({
        code: "custom",
        message: "incomplete run finish cannot precede its start",
      });
    }
  });

export const StatusOutputDataSchema = z
  .object({
    server_version: z.string().min(1).max(128),
    host: z.literal("github.com"),
    login: z.string().min(1).max(100),
    credential_source: z.enum([
      "GITHUB_STARS_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "gh",
    ]),
    capabilities: z
      .object({
        star_read: z.enum(["available", "unavailable", "unknown"]),
        star_write: z.enum(["available", "unavailable", "unknown"]),
        list_read: z.enum(["available", "unavailable", "unknown"]),
        list_write: z.enum(["available", "unavailable", "unknown"]),
      })
      .strict(),
    database_schema_version: SafeIntegerSchema,
    latest_complete_snapshot: SnapshotStatusOutputSchema.nullable(),
    incomplete_runs: z
      .object({
        items: z.array(IncompleteRunOutputSchema).max(20),
        total: SafeIntegerSchema,
        truncated: z.boolean(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.total < value.items.length ||
          value.truncated !== value.total > value.items.length
        ) {
          context.addIssue({
            code: "custom",
            message: "incomplete run totals are inconsistent",
          });
        }
      }),
  })
  .strict();

export const SyncOutputDataSchema = z
  .object({
    snapshot_id: StableIdSchema,
    counts: SnapshotCountsOutputSchema.extend({
      refreshed_repositories: SafeIntegerSchema,
      reused_metadata: SafeIntegerSchema,
      warnings: SafeIntegerSchema,
    }).strict(),
    duration_ms: SafeIntegerSchema,
  })
  .strict();

const LanguageAggregateOutputSchema = z
  .object({
    language: z.string().max(100).nullable(),
    count: SafeIntegerSchema,
  })
  .strict();

function sqliteBinaryOrderedLanguages(
  items: readonly { readonly language: string | null }[],
): boolean {
  let sawNull = false;
  let previous: string | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const language = items[index]?.language;
    if (language === null) {
      if (index !== 0 || sawNull) return false;
      sawNull = true;
      continue;
    }
    if (
      language === undefined ||
      (previous !== undefined &&
        Buffer.compare(
          Buffer.from(previous, "utf8"),
          Buffer.from(language, "utf8"),
        ) >= 0)
    ) {
      return false;
    }
    previous = language;
  }
  return true;
}

const ProjectionOutputSchema = z
  .object({
    repository_id: StableIdSchema.optional(),
    repository_database_id: z
      .string()
      .regex(/^(?:0|[1-9]\d*)$/u)
      .optional(),
    owner: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(100).optional(),
    name_with_owner: z.string().min(1).max(201).optional(),
    description: z.string().max(8_192).nullable().optional(),
    url: z.string().url().max(2_048).optional(),
    stargazers_count: SafeIntegerSchema.optional(),
    fork: z.boolean().optional(),
    archived: z.boolean().optional(),
    disabled: z.boolean().optional(),
    is_private: z.boolean().optional(),
    visibility: z.enum(["public", "private", "internal"]).optional(),
    language: z.string().max(100).nullable().optional(),
    topics: z.array(z.string().max(100)).max(100).optional(),
    license: z.string().max(100).nullable().optional(),
    pushed_at: NullableTimestampSchema.optional(),
    updated_at: TimestampSchema.optional(),
    starred_at: TimestampSchema.optional(),
  })
  .strict();

const EvidenceOutputSchema = z
  .object({
    repository_id: StableIdSchema,
    kind: z.literal("untrusted_external_text"),
    text: z.string().max(65_536),
    source_url: z.string().min(1).max(4_096),
    sha: z.string().min(1).max(128).nullable(),
    byte_length: SafeIntegerSchema,
    truncated: z.boolean(),
    missing: z.boolean(),
  })
  .strict();

export const StarsQueryOutputDataSchema = z
  .object({
    snapshot_id: StableIdSchema,
    total: SafeIntegerSchema,
    aggregates: z
      .object({
        languages: z.array(LanguageAggregateOutputSchema).max(100),
        archived: SafeIntegerSchema,
        forks: SafeIntegerSchema,
      })
      .strict(),
    items: z.array(ProjectionOutputSchema).max(100),
    evidence: z.array(EvidenceOutputSchema).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.total < value.items.length) {
      context.addIssue({
        code: "custom",
        message: "query total cannot be smaller than the returned page",
      });
    }
    if (
      value.aggregates.archived > value.total ||
      value.aggregates.forks > value.total
    ) {
      context.addIssue({
        code: "custom",
        message: "boolean aggregate counts cannot exceed query total",
      });
    }
    if (!sqliteBinaryOrderedLanguages(value.aggregates.languages)) {
      context.addIssue({
        code: "custom",
        message:
          "language aggregates must be unique in null-first SQLite BINARY order",
      });
    }
    const languageTotal = value.aggregates.languages.reduce(
      (total, item) => total + item.count,
      0,
    );
    if (languageTotal > value.total) {
      context.addIssue({
        code: "custom",
        message: "visible language aggregate counts cannot exceed query total",
      });
    }
  });

const ListSummaryOutputSchema = z
  .object({
    list_id: StableIdSchema,
    name: z.string().min(1).max(255),
    slug: z.string().min(1).max(255),
    description: z.string().max(8_192).nullable(),
    is_private: z.boolean(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    last_added_at: NullableTimestampSchema,
    repository_count: SafeIntegerSchema,
  })
  .strict();

const ListsPageOutputDataSchema = z
  .object({
    mode: z.literal("lists"),
    snapshot_id: StableIdSchema,
    coverage: z.literal("complete"),
    items: z.array(ListSummaryOutputSchema).max(100),
    total: SafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.total >= value.items.length, {
    message: "List total cannot be smaller than the returned page",
  });

const ListMembersOutputDataSchema = z
  .object({
    mode: z.literal("memberships"),
    snapshot_id: StableIdSchema,
    coverage: z.literal("complete"),
    selector: z
      .object({
        kind: z.literal("list"),
        list_id: StableIdSchema,
      })
      .strict(),
    repository_ids: z.array(StableIdSchema).max(100),
    total: SafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.total >= value.repository_ids.length, {
    message: "membership total cannot be smaller than the returned page",
  });

const RepositoryListsOutputDataSchema = z
  .object({
    mode: z.literal("memberships"),
    snapshot_id: StableIdSchema,
    coverage: z.literal("complete"),
    selector: z
      .object({
        kind: z.literal("repository"),
        repository_id: StableIdSchema,
      })
      .strict(),
    list_ids: z.array(StableIdSchema).max(100),
    total: SafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.total >= value.list_ids.length, {
    message: "membership total cannot be smaller than the returned page",
  });

export const ListsQueryOutputDataSchema = z.union([
  ListsPageOutputDataSchema,
  ListMembersOutputDataSchema,
  RepositoryListsOutputDataSchema,
]);

const OperationCountsOutputSchema = z
  .object({
    star: SafeIntegerSchema,
    unstar: SafeIntegerSchema,
    list_create: SafeIntegerSchema,
    list_update: SafeIntegerSchema,
    list_delete: SafeIntegerSchema,
    list_membership_set: SafeIntegerSchema,
  })
  .strict();

const RiskCountsOutputSchema = z
  .object({
    normal: SafeIntegerSchema,
    destructive: SafeIntegerSchema,
    non_reversible: SafeIntegerSchema,
  })
  .strict();

function sortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] as string) >= (values[index] as string))
      return false;
  }
  return true;
}

const SortedIdsSchema = z
  .array(StableIdSchema)
  .max(5_000)
  .refine(sortedUnique, "IDs must be sorted and unique");

const SortedClientRefsSchema = z
  .array(z.string().min(1).max(128))
  .max(5_000)
  .refine(sortedUnique, "client references must be sorted and unique");

export const PlanOutputDataSchema = z
  .object({
    plan_id: StableIdSchema,
    plan_hash: HashSchema,
    state: z.enum([
      "ready",
      "applying",
      "applied",
      "partial",
      "expired",
      "failed",
      "superseded",
    ]),
    snapshot_id: StableIdSchema,
    created_at: TimestampSchema,
    expires_at: TimestampSchema,
    operation_count: SafeIntegerSchema.max(5_000),
    dependency_count: SafeIntegerSchema.max(100_000),
    operation_counts: OperationCountsOutputSchema,
    risk_counts: RiskCountsOutputSchema,
    affected_repository_ids: SortedIdsSchema,
    affected_list_ids: SortedIdsSchema,
    created_client_refs: SortedClientRefsSchema,
    protected_repository_ids: SortedIdsSchema,
    protected_list_ids: SortedIdsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const operationTotal = Object.values(value.operation_counts).reduce(
      (total, count) => total + count,
      0,
    );
    const riskTotal = Object.values(value.risk_counts).reduce(
      (total, count) => total + count,
      0,
    );
    if (
      operationTotal !== value.operation_count ||
      riskTotal !== value.operation_count
    ) {
      context.addIssue({
        code: "custom",
        message: "plan operation and risk counts are inconsistent",
      });
    }
    if (value.expires_at <= value.created_at) {
      context.addIssue({
        code: "custom",
        message: "plan expiry must be later than creation",
      });
    }
  });

export const RollbackOutputDataSchema = PlanOutputDataSchema;

const CoordinatesOutputSchema = z
  .object({
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
  })
  .strict();

const PreconditionOutputSchema = z
  .object({
    kind: z.string().min(1).max(128),
    expected: IdentityFreeJsonValueSchema,
  })
  .strict();

const OperationBaseShape = {
  operation_id: z.string().min(1).max(128),
  depends_on: z.array(z.string().min(1).max(128)).max(5_000),
  preconditions: z.array(PreconditionOutputSchema).max(1_000),
  before: IdentityFreeJsonValueSchema,
  after: IdentityFreeJsonValueSchema,
  inverse: IdentityFreeJsonValueSchema,
  risk: z.enum(["normal", "destructive", "non_reversible"]),
} as const;

const ResolvedOperationOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...OperationBaseShape,
      kind: z.literal("star"),
      repository_id: StableIdSchema,
      repository_database_id: z.string().regex(/^(?:0|[1-9]\d*)$/u),
      coordinates: CoordinatesOutputSchema,
    })
    .strict(),
  z
    .object({
      ...OperationBaseShape,
      kind: z.literal("unstar"),
      repository_id: StableIdSchema,
      repository_database_id: z.string().regex(/^(?:0|[1-9]\d*)$/u),
      coordinates: CoordinatesOutputSchema,
    })
    .strict(),
  z
    .object({
      ...OperationBaseShape,
      kind: z.literal("list_create"),
      client_ref: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      ...OperationBaseShape,
      kind: z.literal("list_update"),
      list_id: StableIdSchema,
    })
    .strict(),
  z
    .object({
      ...OperationBaseShape,
      kind: z.literal("list_delete"),
      list_id: StableIdSchema,
    })
    .strict(),
  z
    .object({
      ...OperationBaseShape,
      kind: z.literal("list_membership_set"),
      repository_id: StableIdSchema,
      repository_database_id: z.string().regex(/^(?:0|[1-9]\d*)$/u),
      coordinates: CoordinatesOutputSchema,
      expected_list_ids: z.array(StableIdSchema).max(5_000),
      target_lists: z
        .array(
          z.union([
            z
              .object({
                kind: z.literal("existing"),
                list_id: StableIdSchema,
              })
              .strict(),
            z
              .object({
                kind: z.literal("created"),
                create_operation_id: z.string().min(1).max(128),
              })
              .strict(),
          ]),
        )
        .max(5_000),
    })
    .strict(),
]);

const PlanInspectionMetadataOutputSchema = z
  .object({
    plan_id: StableIdSchema,
    plan_hash: HashSchema,
    state: PlanOutputDataSchema.shape.state,
    created_at: TimestampSchema,
    expires_at: TimestampSchema,
    caller_note: BoundedTextSchema.nullable(),
    snapshot_id: StableIdSchema,
    schema_version: z.literal(1),
    policy_version: z.literal("1"),
    protected_repository_ids: SortedIdsSchema,
    protected_list_ids: SortedIdsSchema,
    operation_count: SafeIntegerSchema.max(5_000),
    dependency_count: SafeIntegerSchema.max(100_000),
  })
  .strict()
  .refine((value) => value.expires_at > value.created_at, {
    message: "plan expiry must be later than creation",
  });

const PublicRunOutputSchema = z
  .object({
    run_id: StableIdSchema,
    plan_id: StableIdSchema,
    state: z.enum(["pending", "running", "completed", "partial", "failed"]),
    failure_mode: z.enum(["stop", "continue"]),
    started_at: TimestampSchema,
    finished_at: NullableTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const unfinished = value.state === "pending" || value.state === "running";
    if (
      (unfinished && value.finished_at !== null) ||
      (!unfinished && value.finished_at === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "run timestamps do not match its lifecycle state",
      });
    }
    if (value.finished_at !== null && value.finished_at < value.started_at) {
      context.addIssue({
        code: "custom",
        message: "run finish cannot precede its start",
      });
    }
  });

const RunOperationOutputSchema = z
  .object({
    run_id: StableIdSchema,
    operation_id: z.string().min(1).max(128),
    sequence: SafeIntegerSchema,
    status: z.enum([
      "pending",
      "running",
      "succeeded",
      "skipped",
      "failed",
      "unresolved",
    ]),
    reconciliation: z.enum([
      "not_required",
      "pending",
      "confirmed_applied",
      "confirmed_not_applied",
      "unknown",
    ]),
    attempts: SafeIntegerSchema,
    before: IdentityFreeJsonValueSchema,
    after: IdentityFreeJsonValueSchema,
    external_request_id: z.string().min(1).max(128).nullable(),
    error: IdentityFreeSerializedErrorOutputSchema.nullable(),
    started_at: NullableTimestampSchema,
    finished_at: NullableTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.started_at !== null &&
      value.finished_at !== null &&
      value.finished_at < value.started_at
    ) {
      context.addIssue({
        code: "custom",
        message: "run operation finish cannot precede its start",
      });
    }
    const pending =
      value.status === "pending" &&
      value.reconciliation === "not_required" &&
      value.started_at === null &&
      value.finished_at === null &&
      value.external_request_id === null &&
      value.error === null &&
      value.after === null;
    const running =
      value.status === "running" &&
      value.reconciliation === "pending" &&
      value.attempts >= 1 &&
      value.started_at !== null &&
      value.finished_at === null &&
      value.external_request_id === null &&
      value.error === null &&
      value.after === null;
    const skipped =
      value.status === "skipped" &&
      value.reconciliation === "not_required" &&
      value.started_at === null &&
      value.finished_at !== null &&
      value.external_request_id === null &&
      value.error === null &&
      value.after === null;
    const succeeded =
      value.status === "succeeded" &&
      (value.reconciliation === "not_required" ||
        value.reconciliation === "confirmed_applied") &&
      value.attempts >= 1 &&
      value.started_at !== null &&
      value.finished_at !== null &&
      value.error === null;
    const failedWithoutDispatch =
      value.status === "failed" &&
      value.reconciliation === "confirmed_not_applied" &&
      value.started_at === null &&
      value.finished_at !== null &&
      value.external_request_id === null &&
      value.after === null &&
      value.error !== null;
    const failedAfterDispatch =
      value.status === "failed" &&
      value.reconciliation === "confirmed_not_applied" &&
      value.attempts >= 1 &&
      value.started_at !== null &&
      value.finished_at !== null &&
      value.error !== null;
    const unresolved =
      value.status === "unresolved" &&
      value.reconciliation === "unknown" &&
      value.attempts >= 1 &&
      value.started_at !== null &&
      value.finished_at !== null &&
      value.error?.retryable === false;
    if (
      !pending &&
      !running &&
      !skipped &&
      !succeeded &&
      !failedWithoutDispatch &&
      !failedAfterDispatch &&
      !unresolved
    ) {
      context.addIssue({
        code: "custom",
        message: "run operation fields do not match a legal lifecycle row",
      });
    }
  });

const RunAttemptOutputSchema = z
  .object({
    run_id: StableIdSchema,
    operation_id: z.string().min(1).max(128),
    attempt: SafeIntegerSchema.min(1),
    status: z.enum(["running", "succeeded", "failed", "unresolved"]),
    reconciliation: z.enum([
      "pending",
      "not_required",
      "confirmed_not_applied",
      "unknown",
    ]),
    before: IdentityFreeJsonValueSchema,
    after: IdentityFreeJsonValueSchema,
    external_request_id: z.string().min(1).max(128).nullable(),
    error: IdentityFreeSerializedErrorOutputSchema.nullable(),
    started_at: TimestampSchema,
    finished_at: NullableTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.finished_at !== null && value.finished_at < value.started_at) {
      context.addIssue({
        code: "custom",
        message: "attempt finish cannot precede its start",
      });
    }
    const valid =
      (value.status === "running" &&
        value.reconciliation === "pending" &&
        value.after === null &&
        value.external_request_id === null &&
        value.error === null &&
        value.finished_at === null) ||
      (value.status === "succeeded" &&
        value.reconciliation === "not_required" &&
        value.error === null &&
        value.finished_at !== null) ||
      (value.status === "failed" &&
        value.reconciliation === "confirmed_not_applied" &&
        value.error !== null &&
        value.finished_at !== null) ||
      (value.status === "unresolved" &&
        value.reconciliation === "unknown" &&
        value.error?.retryable === false &&
        value.finished_at !== null);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "attempt fields do not match a legal lifecycle row",
      });
    }
  });

const ReconciliationOutputSchema = z
  .object({
    run_id: StableIdSchema,
    operation_id: z.string().min(1).max(128),
    attempt: SafeIntegerSchema.min(1),
    event_sequence: SafeIntegerSchema.min(1),
    status: z.enum(["succeeded", "failed", "unresolved"]),
    reconciliation: z.enum([
      "confirmed_applied",
      "confirmed_not_applied",
      "unknown",
    ]),
    after: IdentityFreeJsonValueSchema,
    error: IdentityFreeSerializedErrorOutputSchema.nullable(),
    observed_at: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.status === "succeeded" &&
        value.reconciliation === "confirmed_applied" &&
        value.error === null) ||
      (value.status === "failed" &&
        value.reconciliation === "confirmed_not_applied" &&
        value.error?.retryable === true) ||
      (value.status === "unresolved" &&
        value.reconciliation === "unknown" &&
        value.error?.retryable === false);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "reconciliation fields do not match a legal lifecycle row",
      });
    }
  });

const PlanInspectOutputDataSchema = z
  .object({
    kind: z.literal("plan"),
    plan: PlanInspectionMetadataOutputSchema,
    operations: z
      .array(
        z
          .object({
            sequence: SafeIntegerSchema,
            operation: ResolvedOperationOutputSchema,
          })
          .strict(),
      )
      .max(100),
    total: SafeIntegerSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.total >= value.operations.length &&
      value.total === value.plan.operation_count,
    { message: "plan inspection totals are inconsistent" },
  );

const RunInspectOutputDataSchema = z
  .object({
    kind: z.literal("run"),
    run: PublicRunOutputSchema,
    operations: z.array(RunOperationOutputSchema).max(100),
    total: SafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.total >= value.operations.length, {
    message: "run inspection total is inconsistent",
  });

const AttemptsInspectOutputDataSchema = z
  .object({
    kind: z.literal("attempts"),
    run: PublicRunOutputSchema,
    operation_id: z.string().min(1).max(128),
    attempts: z.array(RunAttemptOutputSchema).max(100),
    total: SafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.total >= value.attempts.length, {
    message: "attempt inspection total is inconsistent",
  });

const ReconciliationsInspectOutputDataSchema = z
  .object({
    kind: z.literal("reconciliations"),
    run: PublicRunOutputSchema,
    operation_id: z.string().min(1).max(128),
    reconciliations: z.array(ReconciliationOutputSchema).max(100),
    total: SafeIntegerSchema,
  })
  .strict()
  .refine((value) => value.total >= value.reconciliations.length, {
    message: "reconciliation inspection total is inconsistent",
  });

export const InspectOutputDataSchema = z.discriminatedUnion("kind", [
  PlanInspectOutputDataSchema,
  RunInspectOutputDataSchema,
  AttemptsInspectOutputDataSchema,
  ReconciliationsInspectOutputDataSchema,
]);

export const ApplyOutputDataSchema = z
  .object({
    run_id: StableIdSchema,
    plan_id: StableIdSchema,
    state: PublicRunOutputSchema.shape.state,
    failure_mode: PublicRunOutputSchema.shape.failure_mode,
    started_at: TimestampSchema,
    finished_at: NullableTimestampSchema,
    counts: RunCountsOutputSchema,
    errors: z.array(IdentityFreeSerializedErrorOutputSchema).max(20),
    audit_cursor: StableIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const unfinished = value.state === "pending" || value.state === "running";
    if (
      (unfinished && value.finished_at !== null) ||
      (!unfinished && value.finished_at === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "apply run timestamps do not match its lifecycle state",
      });
    }
    if (value.finished_at !== null && value.finished_at < value.started_at) {
      context.addIssue({
        code: "custom",
        message: "apply run finish cannot precede its start",
      });
    }
    const expectedErrors = Math.min(
      20,
      value.counts.failed + value.counts.unresolved,
    );
    if (value.errors.length !== expectedErrors) {
      context.addIssue({
        code: "custom",
        message: "apply error summaries do not match failed operations",
      });
    }
    const operationTotal = Object.values(value.counts).reduce(
      (total, count) => total + count,
      0,
    );
    if (
      (operationTotal === 0 && value.audit_cursor !== null) ||
      (operationTotal > 0 && value.audit_cursor !== value.run_id)
    ) {
      context.addIssue({
        code: "custom",
        message: "apply audit cursor does not match operation count",
      });
    }
  });

const RepositoryOutputSchema = z
  .object({
    repository_id: StableIdSchema,
    repository_database_id: z.string().regex(/^(?:0|[1-9]\d*)$/u),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    name_with_owner: z.string().min(1).max(201),
    description: z.string().max(8_192).nullable(),
    url: z.string().url().max(2_048),
    stargazers_count: SafeIntegerSchema,
    fork: z.boolean(),
    archived: z.boolean(),
    disabled: z.boolean(),
    is_private: z.boolean(),
    visibility: z.enum(["public", "private", "internal"]),
    language: z.string().max(100).nullable(),
    topics: z.array(z.string().max(100)).max(100),
    license: z.string().max(100).nullable(),
    pushed_at: NullableTimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export const DiscoveryOutputDataSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            repository: RepositoryOutputSchema,
            already_starred: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    evidence: z.array(EvidenceOutputSchema).max(20),
    reported_total: SafeIntegerSchema,
    capped_total: SafeIntegerSchema.max(1_000),
    incomplete_results: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.reported_total < value.items.length ||
      value.capped_total !== Math.min(value.reported_total, 1_000)
    ) {
      context.addIssue({
        code: "custom",
        message: "discovery totals are inconsistent",
      });
    }
  });

export const CandidatesOutputDataSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            repository: RepositoryOutputSchema,
            query: z.string(),
            state: z.enum(["discovered", "selected", "dismissed", "starred"]),
            first_discovered_at: z.string(),
            last_discovered_at: z.string(),
          })
          .strict(),
      )
      .max(100),
    total: SafeIntegerSchema,
  })
  .strict();

export const ToolOutputSchemas = {
  github_stars_status: successOutput(StatusOutputDataSchema),
  github_stars_sync: successOutput(SyncOutputDataSchema),
  github_stars_query: successOutput(StarsQueryOutputDataSchema),
  github_lists_query: successOutput(ListsQueryOutputDataSchema),
  github_changes_plan: successOutput(PlanOutputDataSchema),
  github_changes_inspect: successOutput(InspectOutputDataSchema),
  github_changes_apply: successOutput(ApplyOutputDataSchema),
  github_changes_rollback: successOutput(RollbackOutputDataSchema),
  github_repositories_discover: successOutput(DiscoveryOutputDataSchema),
  github_repositories_candidates: successOutput(CandidatesOutputDataSchema),
} as const satisfies Record<ToolName, z.ZodObject<z.ZodRawShape>>;
