import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import {
  asRepositoryId,
  asSnapshotId,
  asUserListId,
  type RepositoryId,
  type SnapshotId,
  type UserListId,
} from "./ids.js";
import type { JsonValue } from "./json.js";
import {
  normalizeSort,
  parseFilter,
  type FilterExpression,
  type RepositorySort,
} from "./filter.js";

export type CursorValue = string | number | null;

export interface RepositoryCursorPayload {
  readonly v: 1;
  readonly kind: "repositories";
  readonly snapshotId: SnapshotId;
  readonly filterHash: string;
  readonly sortHash: string;
  readonly values: readonly CursorValue[];
  readonly nulls: readonly boolean[];
  readonly repositoryId: RepositoryId;
}

export interface RepositoryCursorInput {
  readonly v?: 1;
  readonly kind: "repositories";
  readonly snapshotId: SnapshotId | string;
  readonly filterHash: string;
  readonly sortHash: string;
  readonly values: readonly CursorValue[];
  readonly nulls: readonly boolean[];
  readonly repositoryId: RepositoryId | string;
}

export interface ExpectedRepositoryCursor {
  readonly kind: "repositories";
  readonly snapshotId: SnapshotId | string;
  readonly filterHash: string;
  readonly sortHash: string;
}

export interface ListCursorPayload {
  readonly v: 1;
  readonly kind: "lists";
  readonly snapshotId: SnapshotId;
  readonly selectionHash: string;
  readonly values: readonly CursorValue[];
  readonly listId: UserListId;
}

export interface ListCursorInput {
  readonly v?: 1;
  readonly kind: "lists";
  readonly snapshotId: SnapshotId | string;
  readonly selectionHash: string;
  readonly values: readonly CursorValue[];
  readonly listId: UserListId | string;
}

export interface ExpectedListCursor {
  readonly kind: "lists";
  readonly snapshotId: SnapshotId | string;
  readonly selectionHash: string;
}

const MAX_CURSOR_BYTES = 4 * 1_024;
const HASH_LENGTH = 64;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function cursorError(message: string, cause?: unknown): never {
  throw new AppError("VALIDATION_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return cursorError("canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return cursorError("canonical JSON arrays must be dense");
      }
      entries.push(canonicalJson(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    return cursorError("value is not canonical JSON");
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    return cursorError("canonical JSON value could not be inspected", error);
  }
  if (keys.some((key) => typeof key !== "string")) {
    return cursorError("canonical JSON objects cannot contain symbol keys");
  }
  const stringKeys = [...(keys as readonly string[])].sort();
  const entries = stringKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.value === undefined
    ) {
      return cursorError("canonical JSON properties must be data values");
    }
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
  });
  return `{${entries.join(",")}}`;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashFilter(filter: FilterExpression | null): string {
  return hashCanonical(filter === null ? null : parseFilter(filter));
}

export function hashRepositorySort(sort: readonly RepositorySort[]): string {
  return hashCanonical(normalizeSort(sort));
}

export function hashListSelection(selection: JsonValue): string {
  return hashCanonical(selection);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    return cursorError(`${label} could not be inspected`, error);
  }
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    cursorError(`${label} has invalid properties`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return cursorError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validHash(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length !== HASH_LENGTH) {
    return cursorError(`${label} must be a 64-character hash`);
  }
  return value;
}

function cursorValues(value: unknown, label: string): readonly CursorValue[] {
  if (!Array.isArray(value)) {
    return cursorError(`${label} must be an array`);
  }
  const result: CursorValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return cursorError(`${label} must be dense`);
    }
    const entry: unknown = value[index];
    if (
      entry !== null &&
      typeof entry !== "string" &&
      (typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      return cursorError(`${label} contains an invalid value`);
    }
    result.push(entry);
  }
  return result;
}

function booleanMarkers(value: unknown): readonly boolean[] {
  if (!Array.isArray(value)) {
    return cursorError("repository cursor null markers must be an array");
  }
  const result: boolean[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "boolean") {
      return cursorError(
        "repository cursor null markers must be a dense Boolean array",
      );
    }
    result.push(value[index] as boolean);
  }
  return result;
}

function parseCursorJson(cursor: string): {
  readonly parsed: unknown;
  readonly text: string;
} {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES ||
    !BASE64URL.test(cursor)
  ) {
    return cursorError("cursor must be at most 4 KiB of base64url text");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(cursor, "base64url");
  } catch (error) {
    return cursorError("cursor base64url is invalid", error);
  }
  if (
    bytes.toString("base64url") !== cursor ||
    bytes.length > MAX_CURSOR_BYTES
  ) {
    return cursorError("cursor base64url is not canonical");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return cursorError("cursor is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return cursorError("cursor JSON is invalid", error);
  }
  return { parsed, text };
}

function parseRepositoryPayload(cursor: string): RepositoryCursorPayload {
  const decoded = parseCursorJson(cursor);
  const value = record(decoded.parsed, "repository cursor");
  if (value.kind !== "repositories") {
    return cursorError("cursor resource kind does not match repositories");
  }
  exactKeys(
    value,
    [
      "v",
      "kind",
      "snapshotId",
      "filterHash",
      "sortHash",
      "values",
      "nulls",
      "repositoryId",
    ],
    "repository cursor",
  );
  if (value.v !== 1) {
    return cursorError("repository cursor version is unsupported");
  }
  let snapshotId: SnapshotId;
  let repositoryId: RepositoryId;
  try {
    if (typeof value.snapshotId !== "string") {
      return cursorError("repository cursor snapshot is invalid");
    }
    if (typeof value.repositoryId !== "string") {
      return cursorError("repository cursor repository ID is invalid");
    }
    snapshotId = asSnapshotId(value.snapshotId);
    repositoryId = asRepositoryId(value.repositoryId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    return cursorError(
      "repository cursor contains an invalid stable ID",
      error,
    );
  }
  const filterHash = validHash(
    value.filterHash,
    "repository cursor filter hash",
  );
  const sortHash = validHash(value.sortHash, "repository cursor sort hash");
  const values = cursorValues(value.values, "repository cursor values");
  const nulls = booleanMarkers(value.nulls);
  if (
    values.length !== nulls.length ||
    values.some((entry, index) => (entry === null) !== nulls[index])
  ) {
    return cursorError(
      "repository cursor null markers do not match its values",
    );
  }
  const payload: RepositoryCursorPayload = {
    v: 1,
    kind: "repositories",
    snapshotId,
    filterHash,
    sortHash,
    values,
    nulls,
    repositoryId,
  };
  if (canonicalJson(payload) !== decoded.text) {
    return cursorError("repository cursor JSON is not canonical");
  }
  return payload;
}

function parseListPayload(cursor: string): ListCursorPayload {
  const decoded = parseCursorJson(cursor);
  const value = record(decoded.parsed, "list cursor");
  if (value.kind !== "lists") {
    return cursorError("cursor resource kind does not match lists");
  }
  exactKeys(
    value,
    ["v", "kind", "snapshotId", "selectionHash", "values", "listId"],
    "list cursor",
  );
  if (value.v !== 1) {
    return cursorError("list cursor version is unsupported");
  }
  let snapshotId: SnapshotId;
  let listId: UserListId;
  try {
    if (typeof value.snapshotId !== "string") {
      return cursorError("list cursor snapshot is invalid");
    }
    if (typeof value.listId !== "string") {
      return cursorError("list cursor list ID is invalid");
    }
    snapshotId = asSnapshotId(value.snapshotId);
    listId = asUserListId(value.listId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    return cursorError("list cursor contains an invalid stable ID", error);
  }
  const selectionHash = validHash(
    value.selectionHash,
    "list cursor selection hash",
  );
  const values = cursorValues(value.values, "list cursor values");
  const payload: ListCursorPayload = {
    v: 1,
    kind: "lists",
    snapshotId,
    selectionHash,
    values,
    listId,
  };
  if (canonicalJson(payload) !== decoded.text) {
    return cursorError("list cursor JSON is not canonical");
  }
  return payload;
}

function encodePayload(payload: unknown): string {
  const text = canonicalJson(payload);
  const cursor = Buffer.from(text, "utf8").toString("base64url");
  if (
    Buffer.byteLength(text, "utf8") > MAX_CURSOR_BYTES ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES
  ) {
    return cursorError("cursor must not exceed 4 KiB");
  }
  return cursor;
}

export function encodeRepositoryCursor(input: RepositoryCursorInput): string {
  const inputRecord = record(input, "repository cursor input");
  const inputKeys = [
    "kind",
    "snapshotId",
    "filterHash",
    "sortHash",
    "values",
    "nulls",
    "repositoryId",
    ...(Object.hasOwn(inputRecord, "v") ? ["v"] : []),
  ];
  exactKeys(inputRecord, inputKeys, "repository cursor input");
  if (inputRecord.kind !== "repositories") {
    return cursorError("cursor resource kind does not match repositories");
  }
  if (Object.hasOwn(inputRecord, "v") && inputRecord.v !== 1) {
    return cursorError("repository cursor version is unsupported");
  }
  const values = cursorValues(input.values, "repository cursor values");
  const nulls = booleanMarkers(input.nulls);
  if (
    values.length !== nulls.length ||
    values.some((entry, index) => (entry === null) !== nulls[index])
  ) {
    return cursorError(
      "repository cursor null markers do not match its values",
    );
  }
  let snapshotId: SnapshotId;
  let repositoryId: RepositoryId;
  try {
    snapshotId = asSnapshotId(input.snapshotId);
    repositoryId = asRepositoryId(input.repositoryId);
  } catch (error) {
    return cursorError(
      "repository cursor contains an invalid stable ID",
      error,
    );
  }
  return encodePayload({
    v: 1,
    kind: "repositories",
    snapshotId,
    filterHash: validHash(input.filterHash, "repository cursor filter hash"),
    sortHash: validHash(input.sortHash, "repository cursor sort hash"),
    values,
    nulls,
    repositoryId,
  } satisfies RepositoryCursorPayload);
}

export function decodeRepositoryCursor(
  cursor: string,
  expected: ExpectedRepositoryCursor,
): RepositoryCursorPayload {
  if (expected.kind !== "repositories") {
    return cursorError("cursor resource kind does not match repositories");
  }
  const payload = parseRepositoryPayload(cursor);
  if (payload.snapshotId !== expected.snapshotId) {
    return cursorError("repository cursor snapshot does not match");
  }
  if (payload.filterHash !== expected.filterHash) {
    return cursorError("repository cursor filter does not match");
  }
  if (payload.sortHash !== expected.sortHash) {
    return cursorError("repository cursor sort does not match");
  }
  return payload;
}

export function decodeRepositoryCursorForSort(
  cursor: string,
  expectedSortHash: string,
): RepositoryCursorPayload {
  const payload = parseRepositoryPayload(cursor);
  if (payload.sortHash !== expectedSortHash) {
    return cursorError("repository cursor sort does not match");
  }
  return payload;
}

export function encodeListCursor(input: ListCursorInput): string {
  const inputRecord = record(input, "list cursor input");
  const inputKeys = [
    "kind",
    "snapshotId",
    "selectionHash",
    "values",
    "listId",
    ...(Object.hasOwn(inputRecord, "v") ? ["v"] : []),
  ];
  exactKeys(inputRecord, inputKeys, "list cursor input");
  if (inputRecord.kind !== "lists") {
    return cursorError("cursor resource kind does not match lists");
  }
  if (Object.hasOwn(inputRecord, "v") && inputRecord.v !== 1) {
    return cursorError("list cursor version is unsupported");
  }
  let snapshotId: SnapshotId;
  let listId: UserListId;
  try {
    snapshotId = asSnapshotId(input.snapshotId);
    listId = asUserListId(input.listId);
  } catch (error) {
    return cursorError("list cursor contains an invalid stable ID", error);
  }
  return encodePayload({
    v: 1,
    kind: "lists",
    snapshotId,
    selectionHash: validHash(input.selectionHash, "list cursor selection hash"),
    values: cursorValues(input.values, "list cursor values"),
    listId,
  } satisfies ListCursorPayload);
}

export function decodeListCursor(
  cursor: string,
  expected: ExpectedListCursor,
): ListCursorPayload {
  if (expected.kind !== "lists") {
    return cursorError("cursor resource kind does not match lists");
  }
  const payload = parseListPayload(cursor);
  if (payload.snapshotId !== expected.snapshotId) {
    return cursorError("list cursor snapshot does not match");
  }
  if (payload.selectionHash !== expected.selectionHash) {
    return cursorError("list cursor selection does not match");
  }
  return payload;
}
