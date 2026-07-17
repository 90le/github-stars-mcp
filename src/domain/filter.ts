import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import type { Clock } from "../app/ports/runtime-port.js";
import { AppError } from "./errors.js";
import type { RepositoryId, SnapshotId } from "./ids.js";
import type { RepositoryView, UserList } from "./repository.js";
import { canonicalUtcTimestamp } from "./timestamp.js";

type StringFilterField =
  | "repository_id"
  | "owner"
  | "name"
  | "full_name"
  | "description"
  | "primary_language"
  | "license_spdx_id"
  | "visibility";

type BooleanFilterField =
  | "is_fork"
  | "is_archived"
  | "is_disabled"
  | "is_private";

type TemporalFilterField = "pushed_at" | "updated_at" | "starred_at";
type CollectionFilterField = "topics" | "list_ids";

export type FilterExpression =
  | { readonly all: readonly FilterExpression[] }
  | { readonly any: readonly FilterExpression[] }
  | { readonly not: FilterExpression }
  | {
      readonly field: StringFilterField;
      readonly op: "eq" | "neq" | "contains" | "in" | "not_in" | "is_null";
      readonly value: string | readonly string[] | boolean;
    }
  | {
      readonly field: "stargazer_count";
      readonly op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in" | "not_in";
      readonly value: number | readonly number[];
    }
  | {
      readonly field: BooleanFilterField;
      readonly op: "eq" | "neq";
      readonly value: boolean;
    }
  | {
      readonly field: TemporalFilterField;
      readonly op: "before" | "after" | "eq" | "is_null";
      readonly value: string | boolean;
    }
  | {
      readonly field: CollectionFilterField;
      readonly op: "contains" | "not_contains" | "in" | "not_in" | "is_null";
      readonly value: string | readonly string[] | boolean;
    }
  | {
      readonly field: "is_unclassified";
      readonly op: "eq" | "neq";
      readonly value: boolean;
    };

export interface RepositorySort {
  readonly field:
    | "stargazer_count"
    | "pushed_at"
    | "updated_at"
    | "starred_at"
    | "full_name";
  readonly direction: "asc" | "desc";
}

export interface NormalizedRepositorySort {
  readonly field: RepositorySort["field"] | "repository_id";
  readonly direction: "asc" | "desc";
}

export interface RepositoryQuery {
  readonly snapshotId: SnapshotId;
  readonly filter: FilterExpression | null;
  readonly sort: readonly RepositorySort[];
  readonly pageSize: number;
  readonly cursor: string | null;
}

export interface RepositoryQueryPage {
  readonly items: readonly RepositoryView[];
  readonly total: number;
  readonly aggregates: {
    readonly byLanguage: Readonly<Record<string, number>>;
    readonly archived: number;
    readonly forks: number;
  };
  readonly nextCursor: string | null;
}

export interface ListView extends UserList {
  readonly repositoryIds: readonly RepositoryId[];
}

export interface ListQuery {
  readonly snapshotId: SnapshotId;
  readonly pageSize: number;
  readonly cursor: string | null;
}

export interface ListQueryPage {
  readonly items: readonly ListView[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export type FilterParseContext = { readonly now: string } | Pick<Clock, "now">;

type RelativeUnit = "hours" | "days" | "weeks" | "months" | "years";

const STRING_FIELDS = new Set<StringFilterField>([
  "repository_id",
  "owner",
  "name",
  "full_name",
  "description",
  "primary_language",
  "license_spdx_id",
  "visibility",
]);
const NULLABLE_STRING_FIELDS = new Set<StringFilterField>([
  "description",
  "primary_language",
  "license_spdx_id",
]);
const BOOLEAN_FIELDS = new Set<BooleanFilterField>([
  "is_fork",
  "is_archived",
  "is_disabled",
  "is_private",
]);
const TEMPORAL_FIELDS = new Set<TemporalFilterField>([
  "pushed_at",
  "updated_at",
  "starred_at",
]);
const COLLECTION_FIELDS = new Set<CollectionFilterField>([
  "topics",
  "list_ids",
]);
const STRING_OPERATORS = new Set([
  "eq",
  "neq",
  "contains",
  "in",
  "not_in",
  "is_null",
]);
const NUMBER_OPERATORS = new Set([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
]);
const BOOLEAN_OPERATORS = new Set(["eq", "neq"]);
const TEMPORAL_OPERATORS = new Set(["before", "after", "eq", "is_null"]);
const COLLECTION_OPERATORS = new Set([
  "contains",
  "not_contains",
  "in",
  "not_in",
  "is_null",
]);
const RELATIVE_UNITS = new Set<RelativeUnit>([
  "hours",
  "days",
  "weeks",
  "months",
  "years",
]);
const SORT_FIELDS = new Set<RepositorySort["field"]>([
  "stargazer_count",
  "pushed_at",
  "updated_at",
  "starred_at",
  "full_name",
]);
const MAX_SET_ENTRIES = 5_000;
const MAX_TOTAL_SET_MEMBERS = 10_000;

function validationError(message: string): never {
  throw new AppError("VALIDATION_ERROR", message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      utilTypes.isProxy(value) ||
      Array.isArray(value)
    ) {
      return validationError(`${label} must be a plain data object`);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return validationError(`${label} must be a plain data object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        return validationError(`${label} contains unsupported properties`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return validationError(`${label} properties must be plain data`);
      }
      result[key] = descriptor.value as unknown;
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return validationError(`${label} could not be inspected`);
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return validationError(`${label} could not be inspected`);
  }
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    validationError(`${label} contains unsupported properties`);
  }
}

function normalizeTimestamp(value: unknown, label: string): string {
  return canonicalUtcTimestamp(value, label);
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      utilTypes.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return validationError(`${label} must be a dense plain array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return validationError(`${label} must be a dense plain array`);
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length !== length + 1
    ) {
      return validationError(`${label} must be a dense plain array`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return validationError(`${label} must be a dense plain array`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return validationError(`${label} could not be inspected`);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function denseStringSet(
  value: unknown,
  label: string,
  registerMembers: (count: number) => void,
): readonly string[] {
  const entries = denseArray(value, label);
  if (
    entries.length === 0 ||
    entries.length > MAX_SET_ENTRIES ||
    entries.some((entry) => typeof entry !== "string")
  ) {
    return validationError(`${label} must contain 1 to 5,000 string entries`);
  }
  registerMembers(entries.length);
  return [...new Set(entries as readonly string[])].sort(compareUtf8);
}

function denseNumberSet(
  value: unknown,
  label: string,
  registerMembers: (count: number) => void,
): readonly number[] {
  const entries = denseArray(value, label);
  if (
    entries.length === 0 ||
    entries.length > MAX_SET_ENTRIES ||
    entries.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return validationError(
      `${label} must contain 1 to 5,000 finite-number entries`,
    );
  }
  registerMembers(entries.length);
  return [...new Set(entries as readonly number[])].sort(
    (left, right) => left - right,
  );
}

function daysInUtcMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month + 1, 0);
  return date.getUTCDate();
}

function subtractCalendar(
  now: Date,
  amount: number,
  unit: "months" | "years",
): Date {
  const result = new Date(now);
  const originalDay = result.getUTCDate();
  let targetYear = result.getUTCFullYear();
  let targetMonth = result.getUTCMonth();
  if (unit === "years") {
    targetYear -= amount;
  } else {
    const absoluteMonth = targetYear * 12 + targetMonth - amount;
    targetYear = Math.floor(absoluteMonth / 12);
    targetMonth = absoluteMonth - targetYear * 12;
  }
  const targetDay = Math.min(
    originalDay,
    daysInUtcMonth(targetYear, targetMonth),
  );
  result.setUTCDate(1);
  result.setUTCFullYear(targetYear, targetMonth, targetDay);
  return result;
}

function contextNow(context: FilterParseContext | undefined): Date {
  if (context === undefined) {
    return validationError(
      "relative time requires an injected UTC current timestamp",
    );
  }
  let rawNow: unknown;
  try {
    const candidate = context.now;
    rawNow =
      typeof candidate === "function" ? candidate.call(context) : candidate;
  } catch {
    return validationError("injected clock failed");
  }
  return new Date(normalizeTimestamp(rawNow, "injected current time"));
}

function normalizeRelativeTimestamp(
  value: unknown,
  context: FilterParseContext | undefined,
): string {
  if (typeof value === "string") {
    return normalizeTimestamp(value, "filter timestamp");
  }
  const wrapper = asRecord(value, "relative timestamp");
  requireExactKeys(wrapper, ["ago"], "relative timestamp");
  const ago = asRecord(wrapper.ago, "relative timestamp ago");
  requireExactKeys(ago, ["amount", "unit"], "relative timestamp ago");
  if (
    typeof ago.amount !== "number" ||
    !Number.isInteger(ago.amount) ||
    ago.amount < 1 ||
    ago.amount > 10_000
  ) {
    return validationError(
      "relative timestamp amount must be an integer from 1 to 10000",
    );
  }
  if (
    typeof ago.unit !== "string" ||
    !RELATIVE_UNITS.has(ago.unit as RelativeUnit)
  ) {
    return validationError("relative timestamp unit is unsupported");
  }
  const now = contextNow(context);
  const unit = ago.unit as RelativeUnit;
  let result: Date;
  if (unit === "months" || unit === "years") {
    result = subtractCalendar(now, ago.amount, unit);
  } else {
    const unitMilliseconds =
      unit === "hours"
        ? 60 * 60 * 1_000
        : unit === "days"
          ? 24 * 60 * 60 * 1_000
          : 7 * 24 * 60 * 60 * 1_000;
    result = new Date(now.getTime() - ago.amount * unitMilliseconds);
  }
  if (!Number.isFinite(result.getTime())) {
    return validationError("relative timestamp is outside the supported range");
  }
  const resultYear = result.getUTCFullYear();
  if (resultYear < 0 || resultYear > 9_999) {
    return validationError("relative timestamp is outside the supported range");
  }
  return canonicalUtcTimestamp(
    result.toISOString(),
    "resolved relative timestamp",
  );
}

function parseLeaf(
  record: Record<string, unknown>,
  context: FilterParseContext | undefined,
  registerSetMembers: (count: number) => void,
): FilterExpression {
  requireExactKeys(record, ["field", "op", "value"], "filter leaf");
  const { field, op, value } = record;
  if (typeof field !== "string" || typeof op !== "string") {
    return validationError("filter field and operator must be strings");
  }

  if (STRING_FIELDS.has(field as StringFilterField)) {
    const stringField = field as StringFilterField;
    if (!STRING_OPERATORS.has(op)) {
      return validationError(`operator ${op} is not supported for ${field}`);
    }
    if (op === "is_null") {
      if (!NULLABLE_STRING_FIELDS.has(stringField)) {
        return validationError(`${field} is not nullable`);
      }
      if (typeof value !== "boolean") {
        return validationError(`${field} is_null requires a Boolean value`);
      }
      return { field: stringField, op, value };
    }
    if (op === "in" || op === "not_in") {
      return {
        field: stringField,
        op,
        value: denseStringSet(value, `${field} ${op}`, registerSetMembers),
      };
    }
    if (typeof value !== "string") {
      return validationError(`${field} ${op} requires a string value`);
    }
    return {
      field: stringField,
      op: op as "eq" | "neq" | "contains",
      value,
    };
  }

  if (field === "stargazer_count") {
    if (!NUMBER_OPERATORS.has(op)) {
      return validationError(`operator ${op} is not supported for ${field}`);
    }
    if (op === "in" || op === "not_in") {
      return {
        field,
        op,
        value: denseNumberSet(value, `${field} ${op}`, registerSetMembers),
      };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return validationError(`${field} ${op} requires a finite number`);
    }
    return {
      field,
      op: op as "eq" | "neq" | "lt" | "lte" | "gt" | "gte",
      value,
    };
  }

  if (BOOLEAN_FIELDS.has(field as BooleanFilterField)) {
    if (!BOOLEAN_OPERATORS.has(op) || typeof value !== "boolean") {
      return validationError(`${field} requires eq/neq with a Boolean value`);
    }
    return {
      field: field as BooleanFilterField,
      op: op as "eq" | "neq",
      value,
    };
  }

  if (TEMPORAL_FIELDS.has(field as TemporalFilterField)) {
    const temporalField = field as TemporalFilterField;
    if (!TEMPORAL_OPERATORS.has(op)) {
      return validationError(`operator ${op} is not supported for ${field}`);
    }
    if (op === "is_null") {
      if (temporalField !== "pushed_at") {
        return validationError(`${field} is not nullable`);
      }
      if (typeof value !== "boolean") {
        return validationError(`${field} is_null requires a Boolean value`);
      }
      return { field: temporalField, op, value };
    }
    return {
      field: temporalField,
      op: op as "before" | "after" | "eq",
      value: normalizeRelativeTimestamp(value, context),
    };
  }

  if (COLLECTION_FIELDS.has(field as CollectionFilterField)) {
    const collectionField = field as CollectionFilterField;
    if (!COLLECTION_OPERATORS.has(op)) {
      return validationError(`operator ${op} is not supported for ${field}`);
    }
    if (op === "is_null") {
      if (typeof value !== "boolean") {
        return validationError(`${field} is_null requires a Boolean value`);
      }
      return { field: collectionField, op, value };
    }
    if (op === "in" || op === "not_in") {
      return {
        field: collectionField,
        op,
        value: denseStringSet(value, `${field} ${op}`, registerSetMembers),
      };
    }
    if (typeof value !== "string") {
      return validationError(`${field} ${op} requires a string value`);
    }
    return {
      field: collectionField,
      op: op as "contains" | "not_contains",
      value,
    };
  }

  if (field === "is_unclassified") {
    if (!BOOLEAN_OPERATORS.has(op) || typeof value !== "boolean") {
      return validationError(
        "is_unclassified requires eq/neq with a Boolean value",
      );
    }
    return { field, op: op as "eq" | "neq", value };
  }

  return validationError(`unsupported filter field ${field}`);
}

export function parseFilter(
  input: unknown,
  context?: FilterParseContext,
): FilterExpression {
  let leaves = 0;
  let setMembers = 0;

  function registerSetMembers(count: number): void {
    setMembers += count;
    if (setMembers > MAX_TOTAL_SET_MEMBERS) {
      validationError(
        "filter sets must not contain more than 10,000 total members",
      );
    }
  }

  function parseNode(value: unknown, depth: number): FilterExpression {
    if (depth > 12) {
      return validationError("filter depth must not exceed 12");
    }
    const record = asRecord(value, "filter expression");
    if (Object.hasOwn(record, "all")) {
      requireExactKeys(record, ["all"], "all filter");
      const childValues = denseArray(record.all, "all filter children");
      if (childValues.length === 0) {
        return validationError("all filter must contain at least one child");
      }
      const children: FilterExpression[] = [];
      for (const child of childValues) {
        children.push(parseNode(child, depth + 1));
      }
      return { all: children };
    }
    if (Object.hasOwn(record, "any")) {
      requireExactKeys(record, ["any"], "any filter");
      const childValues = denseArray(record.any, "any filter children");
      if (childValues.length === 0) {
        return validationError("any filter must contain at least one child");
      }
      const children: FilterExpression[] = [];
      for (const child of childValues) {
        children.push(parseNode(child, depth + 1));
      }
      return { any: children };
    }
    if (Object.hasOwn(record, "not")) {
      requireExactKeys(record, ["not"], "not filter");
      return { not: parseNode(record.not, depth + 1) };
    }
    leaves += 1;
    if (leaves > 100) {
      return validationError("filter must not contain more than 100 leaves");
    }
    return parseLeaf(record, context, registerSetMembers);
  }

  try {
    return parseNode(input, 1);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION_ERROR", "filter could not be parsed", {
      cause: error,
    });
  }
}

function stringValue(
  view: RepositoryView,
  field: StringFilterField,
): string | null {
  switch (field) {
    case "repository_id":
      return view.repositoryId;
    case "owner":
      return view.owner;
    case "name":
      return view.name;
    case "full_name":
      return view.fullName;
    case "description":
      return view.description;
    case "primary_language":
      return view.primaryLanguage;
    case "license_spdx_id":
      return view.licenseSpdxId;
    case "visibility":
      return view.visibility;
  }
}

function booleanValue(
  view: RepositoryView,
  field: BooleanFilterField,
): boolean {
  switch (field) {
    case "is_fork":
      return view.isFork;
    case "is_archived":
      return view.isArchived;
    case "is_disabled":
      return view.isDisabled;
    case "is_private":
      return view.isPrivate;
  }
}

function temporalValue(
  view: RepositoryView,
  field: TemporalFilterField,
): string | null {
  switch (field) {
    case "pushed_at":
      return view.pushedAt;
    case "updated_at":
      return view.updatedAt;
    case "starred_at":
      return view.starredAt;
  }
}

function collectionValue(
  view: RepositoryView,
  field: CollectionFilterField,
): readonly string[] {
  return field === "topics" ? view.topics : view.listIds;
}

export function matchesFilter(
  view: RepositoryView,
  filter: FilterExpression,
): boolean {
  if ("all" in filter) {
    return filter.all.every((child) => matchesFilter(view, child));
  }
  if ("any" in filter) {
    return filter.any.some((child) => matchesFilter(view, child));
  }
  if ("not" in filter) {
    return !matchesFilter(view, filter.not);
  }

  if (STRING_FIELDS.has(filter.field as StringFilterField)) {
    const stringFilter = filter as Extract<
      FilterExpression,
      { readonly field: StringFilterField }
    >;
    const candidate = stringValue(view, filter.field as StringFilterField);
    if (stringFilter.op === "is_null") {
      return (candidate === null) === stringFilter.value;
    }
    if (candidate === null) return false;
    if (stringFilter.op === "eq") return candidate === stringFilter.value;
    if (stringFilter.op === "neq") return candidate !== stringFilter.value;
    if (stringFilter.op === "contains") {
      return candidate.includes(stringFilter.value as string);
    }
    if (stringFilter.op === "in") {
      return (stringFilter.value as readonly string[]).includes(candidate);
    }
    return !(stringFilter.value as readonly string[]).includes(candidate);
  }

  if (filter.field === "stargazer_count") {
    const candidate = view.stargazerCount;
    if (filter.op === "eq") return candidate === filter.value;
    if (filter.op === "neq") return candidate !== filter.value;
    if (filter.op === "lt") return candidate < (filter.value as number);
    if (filter.op === "lte") return candidate <= (filter.value as number);
    if (filter.op === "gt") return candidate > (filter.value as number);
    if (filter.op === "gte") return candidate >= (filter.value as number);
    if (filter.op === "in") {
      return (filter.value as readonly number[]).includes(candidate);
    }
    return !(filter.value as readonly number[]).includes(candidate);
  }

  if (BOOLEAN_FIELDS.has(filter.field as BooleanFilterField)) {
    const candidate = booleanValue(view, filter.field as BooleanFilterField);
    return filter.op === "eq"
      ? candidate === filter.value
      : candidate !== filter.value;
  }

  if (TEMPORAL_FIELDS.has(filter.field as TemporalFilterField)) {
    const temporalFilter = filter as Extract<
      FilterExpression,
      { readonly field: TemporalFilterField }
    >;
    const candidate = temporalValue(view, filter.field as TemporalFilterField);
    if (temporalFilter.op === "is_null") {
      return (candidate === null) === temporalFilter.value;
    }
    if (candidate === null) return false;
    const candidateTime = canonicalUtcTimestamp(
      candidate,
      `repository ${filter.field} timestamp`,
    );
    const filterTime = canonicalUtcTimestamp(
      temporalFilter.value,
      `filter ${filter.field} timestamp`,
    );
    if (temporalFilter.op === "before") return candidateTime < filterTime;
    if (temporalFilter.op === "after") return candidateTime > filterTime;
    return candidateTime === filterTime;
  }

  if (COLLECTION_FIELDS.has(filter.field as CollectionFilterField)) {
    const collectionFilter = filter as Extract<
      FilterExpression,
      { readonly field: CollectionFilterField }
    >;
    const candidate = collectionValue(
      view,
      filter.field as CollectionFilterField,
    );
    if (collectionFilter.op === "is_null") {
      return (candidate.length === 0) === collectionFilter.value;
    }
    if (collectionFilter.op === "contains") {
      return candidate.includes(collectionFilter.value as string);
    }
    if (collectionFilter.op === "not_contains") {
      return !candidate.includes(collectionFilter.value as string);
    }
    const overlaps = (collectionFilter.value as readonly string[]).some(
      (value) => candidate.includes(value),
    );
    return collectionFilter.op === "in" ? overlaps : !overlaps;
  }

  const unclassified = view.listIds.length === 0;
  return filter.op === "eq"
    ? unclassified === filter.value
    : unclassified !== filter.value;
}

export function normalizeSort(
  sort: readonly RepositorySort[],
): readonly NormalizedRepositorySort[] {
  const terms = denseArray(sort, "repository sort");
  const normalized: NormalizedRepositorySort[] = [];
  const seen = new Set<RepositorySort["field"]>();
  for (const term of terms) {
    const record = asRecord(term, "repository sort term");
    requireExactKeys(record, ["field", "direction"], "repository sort term");
    const fieldValue = record.field;
    const directionValue = record.direction;
    if (
      typeof fieldValue !== "string" ||
      !SORT_FIELDS.has(fieldValue as RepositorySort["field"]) ||
      (directionValue !== "asc" && directionValue !== "desc")
    ) {
      return validationError("repository sort field or direction is invalid");
    }
    const field = fieldValue as RepositorySort["field"];
    if (!seen.has(field)) {
      normalized.push({ field, direction: directionValue });
      seen.add(field);
    }
  }
  if (!seen.has("full_name")) {
    normalized.push({ field: "full_name", direction: "asc" });
  }
  normalized.push({ field: "repository_id", direction: "asc" });
  return normalized;
}

type SortValue = string | number | null;

function repositorySortValue(
  view: RepositoryView,
  field: NormalizedRepositorySort["field"],
): SortValue {
  switch (field) {
    case "stargazer_count":
      return view.stargazerCount;
    case "pushed_at":
      return view.pushedAt === null
        ? null
        : canonicalUtcTimestamp(
            view.pushedAt,
            "repository pushed_at sort timestamp",
          );
    case "updated_at":
      return canonicalUtcTimestamp(
        view.updatedAt,
        "repository updated_at sort timestamp",
      );
    case "starred_at":
      return canonicalUtcTimestamp(
        view.starredAt,
        "repository starred_at sort timestamp",
      );
    case "full_name":
      return view.fullName;
    case "repository_id":
      return view.repositoryId;
  }
}

function compareNonNull(left: string | number, right: string | number): number {
  if (typeof left === "string" && typeof right === "string") {
    return compareUtf8(left, right);
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareRepositories(
  left: RepositoryView,
  right: RepositoryView,
  sort: readonly RepositorySort[],
): number {
  for (const term of normalizeSort(sort)) {
    const leftValue = repositorySortValue(left, term.field);
    const rightValue = repositorySortValue(right, term.field);
    if (leftValue === null && rightValue === null) continue;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const comparison = compareNonNull(leftValue, rightValue);
    if (comparison !== 0) {
      return term.direction === "asc" ? comparison : -comparison;
    }
  }
  return 0;
}

export interface RepositoryCursorPosition {
  readonly values: readonly SortValue[];
  readonly nulls: readonly boolean[];
  readonly repositoryId: RepositoryId;
}

export function repositoryCursorPosition(
  view: RepositoryView,
  sort: readonly RepositorySort[],
): RepositoryCursorPosition {
  const values = normalizeSort(sort)
    .filter((term) => term.field !== "repository_id")
    .map((term) => repositorySortValue(view, term.field));
  return {
    values,
    nulls: values.map((value) => value === null),
    repositoryId: view.repositoryId,
  };
}
