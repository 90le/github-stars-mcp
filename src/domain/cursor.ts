import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";
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
  type NormalizedRepositorySort,
  type RepositorySort,
} from "./filter.js";
import { canonicalUtcTimestamp } from "./timestamp.js";

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

declare const validatedRepositoryCursorBrand: unique symbol;

export interface ValidatedRepositoryCursorPayload extends RepositoryCursorPayload {
  readonly [validatedRepositoryCursorBrand]: true;
}

export interface RepositoryCursorContext {
  readonly kind: "repositories";
  readonly snapshotId: SnapshotId | string;
  readonly filterHash: string;
  readonly sort: readonly RepositorySort[];
}

export interface RepositoryCursorPositionInput {
  readonly values: readonly CursorValue[];
  readonly nulls: readonly boolean[];
  readonly repositoryId: RepositoryId | string;
}

export interface ListCursorPayload {
  readonly v: 1;
  readonly kind: "lists";
  readonly snapshotId: SnapshotId;
  readonly selectionHash: string;
  readonly values: readonly CursorValue[];
  readonly listId: UserListId;
}

export interface ListCursorContext {
  readonly kind: "lists";
  readonly snapshotId: SnapshotId | string;
  readonly selectionHash: string;
}

export interface ListCursorPositionInput {
  readonly values: readonly CursorValue[];
  readonly listId: UserListId | string;
}

export interface CursorCodec {
  encodeRepository(
    context: RepositoryCursorContext,
    position: RepositoryCursorPositionInput,
  ): string;
  decodeRepository(
    cursor: string,
    context: RepositoryCursorContext,
  ): ValidatedRepositoryCursorPayload;
  encodeList(
    context: ListCursorContext,
    position: ListCursorPositionInput,
  ): string;
  decodeList(cursor: string, context: ListCursorContext): ListCursorPayload;
}

interface NormalizedRepositoryContext {
  readonly snapshotId: SnapshotId;
  readonly filterHash: string;
  readonly sortHash: string;
  readonly sort: readonly NormalizedRepositorySort[];
}

interface NormalizedListContext {
  readonly snapshotId: SnapshotId;
  readonly selectionHash: string;
}

const MAX_CURSOR_BYTES = 4 * 1_024;
const HASH = /^[a-f0-9]{64}$/u;
const MAC = /^[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const validatedRepositoryPayloads = new WeakSet<object>();
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const typedArrayByteLength = (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength") as {
    readonly get: (this: void) => unknown;
  }
).get;
const intrinsicUint8ArraySet = (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "set") as {
    readonly value: (this: void, source: Uint8Array) => void;
  }
).value;

function cursorError(message: string): never {
  throw new AppError("VALIDATION_ERROR", message);
}

function snapshotPlainObject(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      utilTypes.isProxy(value) ||
      Array.isArray(value)
    ) {
      return cursorError(`${label} must be a plain data object`);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return cursorError(`${label} must be a plain data object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        return cursorError(`${label} cannot contain symbol properties`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return cursorError(`${label} properties must be plain data values`);
      }
      result[key] = descriptor.value as unknown;
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return cursorError(`${label} could not be inspected`);
  }
}

function snapshotDenseArray(value: unknown, label: string): readonly unknown[] {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      utilTypes.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return cursorError(`${label} must be a dense plain array`);
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
      return cursorError(`${label} must be a dense plain array`);
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length !== length + 1
    ) {
      return cursorError(`${label} must be a dense plain array`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return cursorError(`${label} must be a dense plain array`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return cursorError(`${label} could not be inspected`);
  }
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    cursorError(`${label} has invalid properties`);
  }
}

function canonicalJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): string {
  if (depth > 64) {
    return cursorError("canonical JSON nesting must not exceed 64 levels");
  }
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
  if (typeof value !== "object" || value === undefined) {
    return cursorError("value is not canonical JSON");
  }
  if (ancestors.has(value)) {
    return cursorError("canonical JSON cannot contain cycles");
  }

  ancestors.add(value);
  try {
    let isArray: boolean;
    try {
      isArray = Array.isArray(value);
    } catch {
      return cursorError("canonical JSON value could not be inspected");
    }
    if (isArray) {
      const entries = snapshotDenseArray(value, "canonical JSON array").map(
        (entry) => canonicalJson(entry, ancestors, depth + 1),
      );
      return `[${entries.join(",")}]`;
    }
    const record = snapshotPlainObject(value, "canonical JSON object");
    const keys = Object.keys(record).sort();
    const entries = keys.map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          record[key],
          ancestors,
          depth + 1,
        )}`,
    );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
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

function validHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    return cursorError(`${label} must be a lowercase 64-hex hash`);
  }
  return value;
}

function stableSnapshotId(value: unknown, label: string): SnapshotId {
  if (typeof value !== "string") {
    return cursorError(`${label} must be a stable ID`);
  }
  try {
    return asSnapshotId(value);
  } catch {
    return cursorError(`${label} must be a stable ID`);
  }
}

function stableRepositoryId(value: unknown): RepositoryId {
  if (typeof value !== "string") {
    return cursorError("repository cursor repository ID must be a stable ID");
  }
  try {
    return asRepositoryId(value);
  } catch {
    return cursorError("repository cursor repository ID must be a stable ID");
  }
}

function stableListId(value: unknown): UserListId {
  if (typeof value !== "string") {
    return cursorError("list cursor list ID must be a stable ID");
  }
  try {
    return asUserListId(value);
  } catch {
    return cursorError("list cursor list ID must be a stable ID");
  }
}

function cursorValues(value: unknown, label: string): readonly CursorValue[] {
  const entries = snapshotDenseArray(value, label);
  const result: CursorValue[] = [];
  for (const entry of entries) {
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
  const entries = snapshotDenseArray(value, "repository cursor null markers");
  if (entries.some((entry) => typeof entry !== "boolean")) {
    return cursorError(
      "repository cursor null markers must be a dense Boolean array",
    );
  }
  return entries as readonly boolean[];
}

function normalizeRepositoryContext(
  context: unknown,
): NormalizedRepositoryContext {
  const record = snapshotPlainObject(context, "repository cursor context");
  exactKeys(
    record,
    ["kind", "snapshotId", "filterHash", "sort"],
    "repository cursor context",
  );
  if (record.kind !== "repositories") {
    return cursorError("cursor resource kind does not match repositories");
  }
  const normalizedSort = normalizeSort(
    record.sort as readonly RepositorySort[],
  );
  return {
    snapshotId: stableSnapshotId(
      record.snapshotId,
      "repository cursor snapshot",
    ),
    filterHash: validHash(record.filterHash, "repository cursor filter hash"),
    sortHash: hashCanonical(normalizedSort),
    sort: normalizedSort,
  };
}

function normalizeListContext(context: unknown): NormalizedListContext {
  const record = snapshotPlainObject(context, "list cursor context");
  exactKeys(
    record,
    ["kind", "snapshotId", "selectionHash"],
    "list cursor context",
  );
  if (record.kind !== "lists") {
    return cursorError("cursor resource kind does not match lists");
  }
  return {
    snapshotId: stableSnapshotId(record.snapshotId, "list cursor snapshot"),
    selectionHash: validHash(
      record.selectionHash,
      "list cursor selection hash",
    ),
  };
}

function validateRepositoryValues(
  sort: readonly NormalizedRepositorySort[],
  values: readonly CursorValue[],
  nulls: readonly boolean[],
): void {
  const valueTerms = sort.filter((term) => term.field !== "repository_id");
  if (
    values.length !== valueTerms.length ||
    nulls.length !== valueTerms.length ||
    values.some((entry, index) => (entry === null) !== nulls[index])
  ) {
    return cursorError(
      "repository cursor values do not match normalized sort and null markers",
    );
  }

  valueTerms.forEach((term, index) => {
    const value = values[index]!;
    if (term.field === "stargazer_count") {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        cursorError(
          "repository cursor stargazer value must be a nonnegative safe integer",
        );
      }
      return;
    }
    if (term.field === "pushed_at" && value === null) return;
    if (typeof value !== "string") {
      cursorError(`repository cursor ${term.field} value is invalid`);
    }
    if (
      term.field === "pushed_at" ||
      term.field === "updated_at" ||
      term.field === "starred_at"
    ) {
      let canonical: string;
      try {
        canonical = canonicalUtcTimestamp(
          value,
          `repository cursor ${term.field} timestamp`,
        );
      } catch {
        return cursorError(
          `repository cursor ${term.field} timestamp is invalid`,
        );
      }
      if (canonical !== value) {
        return cursorError(
          `repository cursor ${term.field} timestamp must be canonical`,
        );
      }
    }
  });
}

function repositoryPosition(
  input: unknown,
  sort: readonly NormalizedRepositorySort[],
): {
  readonly values: readonly CursorValue[];
  readonly nulls: readonly boolean[];
  readonly repositoryId: RepositoryId;
} {
  const record = snapshotPlainObject(input, "repository cursor position");
  exactKeys(
    record,
    ["values", "nulls", "repositoryId"],
    "repository cursor position",
  );
  const values = cursorValues(record.values, "repository cursor values");
  const nulls = booleanMarkers(record.nulls);
  validateRepositoryValues(sort, values, nulls);
  return {
    values: Object.freeze([...values]),
    nulls: Object.freeze([...nulls]),
    repositoryId: stableRepositoryId(record.repositoryId),
  };
}

function listPosition(input: unknown): {
  readonly values: readonly CursorValue[];
  readonly listId: UserListId;
} {
  const record = snapshotPlainObject(input, "list cursor position");
  exactKeys(record, ["values", "listId"], "list cursor position");
  return {
    values: Object.freeze([
      ...cursorValues(record.values, "list cursor values"),
    ]),
    listId: stableListId(record.listId),
  };
}

function intrinsicByteLength(value: Uint8Array): number {
  return Reflect.apply(typedArrayByteLength, value, []) as number;
}

function signingKeyCopy(signingKey: Uint8Array): Uint8Array {
  try {
    if (
      typeof signingKey !== "object" ||
      signingKey === null ||
      utilTypes.isProxy(signingKey) ||
      !utilTypes.isUint8Array(signingKey)
    ) {
      return cursorError(
        "cursor signing key must be a Uint8Array of at least 32 bytes",
      );
    }
    const actualLength = intrinsicByteLength(signingKey);
    if (!Number.isSafeInteger(actualLength) || actualLength < 32) {
      return cursorError(
        "cursor signing key must be a Uint8Array of at least 32 bytes",
      );
    }
    const copy = new Uint8Array(actualLength);
    Reflect.apply(intrinsicUint8ArraySet, copy, [signingKey]);
    if (intrinsicByteLength(copy) !== actualLength || actualLength < 32) {
      return cursorError(
        "cursor signing key must be a Uint8Array of at least 32 bytes",
      );
    }
    return copy;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return cursorError(
      "cursor signing key must be a Uint8Array of at least 32 bytes",
    );
  }
}

function authenticate(payloadText: string, mac: string, key: Uint8Array): void {
  if (!MAC.test(mac)) {
    return cursorError("cursor authentication code is invalid");
  }
  let expected: Buffer;
  try {
    expected = createHmac("sha256", key).update(payloadText).digest();
  } catch {
    return cursorError("cursor authentication failed");
  }
  const supplied = Buffer.from(mac, "hex");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return cursorError("cursor authentication failed");
  }
}

function encodedEnvelope(payload: unknown, key: Uint8Array): string {
  const payloadText = canonicalJson(payload);
  let mac: string;
  try {
    mac = createHmac("sha256", key).update(payloadText).digest("hex");
  } catch {
    return cursorError("cursor authentication failed");
  }
  const text = canonicalJson({ mac, payload });
  const cursor = Buffer.from(text, "utf8").toString("base64url");
  if (
    Buffer.byteLength(text, "utf8") > MAX_CURSOR_BYTES ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES
  ) {
    return cursorError("cursor must not exceed 4 KiB");
  }
  return cursor;
}

function decodedEnvelope(
  cursor: string,
  key: Uint8Array,
): Readonly<Record<string, unknown>> {
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
  } catch {
    return cursorError("cursor base64url is invalid");
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
  } catch {
    return cursorError("cursor JSON is invalid");
  }
  if (canonicalJson(parsed) !== text) {
    return cursorError("cursor JSON is not canonical");
  }
  const envelope = snapshotPlainObject(parsed, "cursor envelope");
  exactKeys(envelope, ["mac", "payload"], "cursor envelope");
  if (typeof envelope.mac !== "string") {
    return cursorError("cursor authentication code is invalid");
  }
  authenticate(canonicalJson(envelope.payload), envelope.mac, key);
  return snapshotPlainObject(envelope.payload, "cursor payload");
}

function decodeRepositoryPayload(
  cursor: string,
  context: NormalizedRepositoryContext,
  key: Uint8Array,
): ValidatedRepositoryCursorPayload {
  const payload = decodedEnvelope(cursor, key);
  exactKeys(
    payload,
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
    "repository cursor payload",
  );
  if (payload.v !== 1) {
    return cursorError("repository cursor version is unsupported");
  }
  if (payload.kind !== "repositories") {
    return cursorError("cursor resource kind does not match repositories");
  }
  const snapshotId = stableSnapshotId(
    payload.snapshotId,
    "repository cursor snapshot",
  );
  const filterHash = validHash(
    payload.filterHash,
    "repository cursor filter hash",
  );
  const sortHash = validHash(payload.sortHash, "repository cursor sort hash");
  const values = cursorValues(payload.values, "repository cursor values");
  const nulls = booleanMarkers(payload.nulls);
  const repositoryId = stableRepositoryId(payload.repositoryId);

  if (snapshotId !== context.snapshotId) {
    return cursorError("repository cursor snapshot does not match");
  }
  if (filterHash !== context.filterHash) {
    return cursorError("repository cursor filter does not match");
  }
  if (sortHash !== context.sortHash) {
    return cursorError("repository cursor sort does not match");
  }
  validateRepositoryValues(context.sort, values, nulls);

  const result = Object.freeze({
    v: 1,
    kind: "repositories",
    snapshotId,
    filterHash,
    sortHash,
    values: Object.freeze([...values]),
    nulls: Object.freeze([...nulls]),
    repositoryId,
  }) as ValidatedRepositoryCursorPayload;
  validatedRepositoryPayloads.add(result);
  return result;
}

function decodeListPayload(
  cursor: string,
  context: NormalizedListContext,
  key: Uint8Array,
): ListCursorPayload {
  const payload = decodedEnvelope(cursor, key);
  exactKeys(
    payload,
    ["v", "kind", "snapshotId", "selectionHash", "values", "listId"],
    "list cursor payload",
  );
  if (payload.v !== 1) {
    return cursorError("list cursor version is unsupported");
  }
  if (payload.kind !== "lists") {
    return cursorError("cursor resource kind does not match lists");
  }
  const snapshotId = stableSnapshotId(
    payload.snapshotId,
    "list cursor snapshot",
  );
  const selectionHash = validHash(
    payload.selectionHash,
    "list cursor selection hash",
  );
  const values = cursorValues(payload.values, "list cursor values");
  const listId = stableListId(payload.listId);
  if (snapshotId !== context.snapshotId) {
    return cursorError("list cursor snapshot does not match");
  }
  if (selectionHash !== context.selectionHash) {
    return cursorError("list cursor selection does not match");
  }
  return Object.freeze({
    v: 1,
    kind: "lists",
    snapshotId,
    selectionHash,
    values: Object.freeze([...values]),
    listId,
  });
}

export function assertValidatedRepositoryCursorPayload(
  value: unknown,
): asserts value is ValidatedRepositoryCursorPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !validatedRepositoryPayloads.has(value)
  ) {
    cursorError(
      "repository cursor payload must come from complete authenticated decoding",
    );
  }
}

export function createCursorCodec(signingKey: Uint8Array): CursorCodec {
  const key = signingKeyCopy(signingKey);
  return Object.freeze({
    encodeRepository(
      contextInput: RepositoryCursorContext,
      positionInput: RepositoryCursorPositionInput,
    ): string {
      const context = normalizeRepositoryContext(contextInput);
      const position = repositoryPosition(positionInput, context.sort);
      return encodedEnvelope(
        {
          v: 1,
          kind: "repositories",
          snapshotId: context.snapshotId,
          filterHash: context.filterHash,
          sortHash: context.sortHash,
          values: position.values,
          nulls: position.nulls,
          repositoryId: position.repositoryId,
        } satisfies RepositoryCursorPayload,
        key,
      );
    },
    decodeRepository(
      cursor: string,
      contextInput: RepositoryCursorContext,
    ): ValidatedRepositoryCursorPayload {
      return decodeRepositoryPayload(
        cursor,
        normalizeRepositoryContext(contextInput),
        key,
      );
    },
    encodeList(
      contextInput: ListCursorContext,
      positionInput: ListCursorPositionInput,
    ): string {
      const context = normalizeListContext(contextInput);
      const position = listPosition(positionInput);
      return encodedEnvelope(
        {
          v: 1,
          kind: "lists",
          snapshotId: context.snapshotId,
          selectionHash: context.selectionHash,
          values: position.values,
          listId: position.listId,
        } satisfies ListCursorPayload,
        key,
      );
    },
    decodeList(
      cursor: string,
      contextInput: ListCursorContext,
    ): ListCursorPayload {
      return decodeListPayload(cursor, normalizeListContext(contextInput), key);
    },
  });
}
