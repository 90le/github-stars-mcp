import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  Hash,
  Hmac,
  timingSafeEqual,
} from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalJson } from "./canonical-json.js";
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
  readonly v: 1;
  readonly kind: "lists";
  readonly snapshotId: SnapshotId | string;
}

export interface ListCursorPositionInput {
  readonly values: readonly CursorValue[];
  readonly listId: UserListId | string;
}

export type ListMembershipCursorContext =
  | Readonly<{
      v: 1;
      kind: "list_memberships";
      snapshotId: SnapshotId | string;
      selector: { readonly kind: "list"; readonly listId: UserListId | string };
    }>
  | Readonly<{
      v: 1;
      kind: "list_memberships";
      snapshotId: SnapshotId | string;
      selector: {
        readonly kind: "repository";
        readonly repositoryId: RepositoryId | string;
      };
    }>;

export type ListMembershipCursorPosition =
  | Readonly<{
      selector: { readonly kind: "list"; readonly listId: UserListId | string };
      boundaryRepositoryId: RepositoryId | string;
    }>
  | Readonly<{
      selector: {
        readonly kind: "repository";
        readonly repositoryId: RepositoryId | string;
      };
      boundaryListId: UserListId | string;
    }>;

declare const validatedListMembershipCursorBrand: unique symbol;

export type ValidatedListMembershipCursorPayload =
  | Readonly<{
      v: 1;
      kind: "list_memberships";
      snapshotId: SnapshotId;
      selectionHash: string;
      selector: { readonly kind: "list"; readonly listId: UserListId };
      boundaryRepositoryId: RepositoryId;
      readonly [validatedListMembershipCursorBrand]: true;
    }>
  | Readonly<{
      v: 1;
      kind: "list_memberships";
      snapshotId: SnapshotId;
      selectionHash: string;
      selector: {
        readonly kind: "repository";
        readonly repositoryId: RepositoryId;
      };
      boundaryListId: UserListId;
      readonly [validatedListMembershipCursorBrand]: true;
    }>;

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
  encodeListMembership(
    context: ListMembershipCursorContext,
    position: ListMembershipCursorPosition,
  ): string;
  decodeListMembership(
    cursor: string,
    context: ListMembershipCursorContext,
  ): ValidatedListMembershipCursorPayload;
}

interface NormalizedRepositoryContext {
  readonly snapshotId: SnapshotId;
  readonly filterHash: string;
  readonly sortHash: string;
  readonly sort: readonly NormalizedRepositorySort[];
}

interface NormalizedListContext {
  readonly v: 1;
  readonly snapshotId: SnapshotId;
  readonly selectionHash: string;
}

type NormalizedListMembershipContext =
  | Readonly<{
      v: 1;
      snapshotId: SnapshotId;
      selectionHash: string;
      selector: { readonly kind: "list"; readonly listId: UserListId };
    }>
  | Readonly<{
      v: 1;
      snapshotId: SnapshotId;
      selectionHash: string;
      selector: {
        readonly kind: "repository";
        readonly repositoryId: RepositoryId;
      };
    }>;

const MAX_CURSOR_BYTES = 4 * 1_024;
const HASH = /^[a-f0-9]{64}$/u;
const MAC = /^[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
/* eslint-disable @typescript-eslint/unbound-method -- Mutable realm and crypto intrinsics are captured once and receiver-sensitive methods are called only through captured Reflect.apply. */
const objectGetPrototypeOfAtLoad = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptorAtLoad = Object.getOwnPropertyDescriptor;
const typedArrayPrototype = objectGetPrototypeOfAtLoad(
  Uint8Array.prototype,
) as object;
const typedArrayByteLength = (
  objectGetOwnPropertyDescriptorAtLoad(typedArrayPrototype, "byteLength") as {
    readonly get: (this: void) => unknown;
  }
).get;
const intrinsicUint8ArraySet = (
  objectGetOwnPropertyDescriptorAtLoad(typedArrayPrototype, "set") as {
    readonly value: (this: void, source: Uint8Array) => void;
  }
).value;
const bufferEqualsAtLoad = (
  objectGetOwnPropertyDescriptorAtLoad(Buffer.prototype, "equals") as {
    readonly value: (this: Buffer, otherBuffer: Uint8Array) => boolean;
  }
).value;
const bufferToStringAtLoad = (
  objectGetOwnPropertyDescriptorAtLoad(Buffer.prototype, "toString") as {
    readonly value: (this: Buffer, encoding?: BufferEncoding) => string;
  }
).value;
const freezeCursorIntrinsics = Object.freeze;
const CURSOR_INTRINSICS = freezeCursorIntrinsics({
  arrayIsArray: Array.isArray,
  arrayPrototype: Array.prototype,
  bufferByteLength: Buffer.byteLength,
  bufferEquals: bufferEqualsAtLoad,
  bufferFrom: Buffer.from,
  bufferToString: bufferToStringAtLoad,
  createHash,
  createHmac,
  hashDigest: Hash.prototype.digest,
  hashUpdate: Hash.prototype.update,
  hmacDigest: Hmac.prototype.digest,
  hmacUpdate: Hmac.prototype.update,
  jsonParse: JSON.parse,
  numberIsFinite: Number.isFinite,
  numberIsSafeInteger: Number.isSafeInteger,
  objectCreate: Object.create,
  objectFreeze: freezeCursorIntrinsics,
  objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  objectHasOwn: Object.hasOwn,
  objectPrototype: Object.prototype,
  reflectApply: Reflect.apply,
  reflectDefineProperty: Reflect.defineProperty,
  reflectGetPrototypeOf: Reflect.getPrototypeOf,
  reflectOwnKeys: Reflect.ownKeys,
  regexpTest: RegExp.prototype.test,
  stringFromValue: String,
  timingSafeEqual,
  typedArrayByteLength,
  uint8ArrayConstructor: Uint8Array,
  uint8ArraySet: intrinsicUint8ArraySet,
  utilIsProxy: utilTypes.isProxy,
  utilIsUint8Array: utilTypes.isUint8Array,
  weakSetAdd: WeakSet.prototype.add,
  weakSetConstructor: WeakSet,
  weakSetHas: WeakSet.prototype.has,
});
/* eslint-enable @typescript-eslint/unbound-method */

const validatedRepositoryPayloads =
  new CURSOR_INTRINSICS.weakSetConstructor<object>();
const validatedListMembershipPayloads =
  new CURSOR_INTRINSICS.weakSetConstructor<object>();

function regexpMatches(pattern: RegExp, value: string): boolean {
  return CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.regexpTest, pattern, [
    value,
  ]);
}

function weakSetAdd<T extends object>(target: WeakSet<T>, value: T): void {
  CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.weakSetAdd, target, [value]);
}

function weakSetHas<T extends object>(target: WeakSet<T>, value: T): boolean {
  return CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.weakSetHas, target, [
    value,
  ]);
}

function createInternalArray<T>(): T[] {
  return [];
}

function appendInternalArray<T>(target: T[], value: T): void {
  if (
    !CURSOR_INTRINSICS.reflectDefineProperty(
      target,
      CURSOR_INTRINSICS.stringFromValue(target.length),
      {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      },
    )
  ) {
    cursorError("cursor internal array append failed");
  }
}

function arrayCopy<T>(input: readonly T[]): T[] {
  const result = createInternalArray<T>();
  for (let index = 0; index < input.length; index += 1) {
    appendInternalArray(result, input[index] as T);
  }
  return result;
}

function frozenArrayCopy<T>(input: readonly T[]): readonly T[] {
  return CURSOR_INTRINSICS.objectFreeze(arrayCopy(input));
}

function arrayFilter<T>(
  input: readonly T[],
  predicate: (value: T, index: number) => boolean,
): T[] {
  const result = createInternalArray<T>();
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] as T;
    if (predicate(value, index)) appendInternalArray(result, value);
  }
  return result;
}

function arraySome<T>(
  input: readonly T[],
  predicate: (value: T, index: number) => boolean,
): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (predicate(input[index] as T, index)) return true;
  }
  return false;
}

function arrayIncludes<T>(input: readonly T[], expected: T): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === expected) return true;
  }
  return false;
}

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
      CURSOR_INTRINSICS.utilIsProxy(value) ||
      CURSOR_INTRINSICS.arrayIsArray(value)
    ) {
      return cursorError(`${label} must be a plain data object`);
    }
    const prototype = CURSOR_INTRINSICS.reflectGetPrototypeOf(value);
    if (prototype !== CURSOR_INTRINSICS.objectPrototype && prototype !== null) {
      return cursorError(`${label} must be a plain data object`);
    }
    const descriptors =
      CURSOR_INTRINSICS.objectGetOwnPropertyDescriptors(value);
    const result = CURSOR_INTRINSICS.objectCreate(null) as Record<
      string,
      unknown
    >;
    const keys = CURSOR_INTRINSICS.reflectOwnKeys(descriptors);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as PropertyKey;
      if (typeof key !== "string") {
        return cursorError(`${label} cannot contain symbol properties`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !CURSOR_INTRINSICS.objectHasOwn(descriptor, "value") ||
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
      CURSOR_INTRINSICS.utilIsProxy(value) ||
      !CURSOR_INTRINSICS.arrayIsArray(value) ||
      CURSOR_INTRINSICS.reflectGetPrototypeOf(value) !==
        CURSOR_INTRINSICS.arrayPrototype
    ) {
      return cursorError(`${label} must be a dense plain array`);
    }
    const descriptors = CURSOR_INTRINSICS.objectGetOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !CURSOR_INTRINSICS.objectHasOwn(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !CURSOR_INTRINSICS.numberIsSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return cursorError(`${label} must be a dense plain array`);
    }
    const length = lengthDescriptor.value;
    const keys = CURSOR_INTRINSICS.reflectOwnKeys(descriptors);
    if (
      arraySome(keys, (key) => typeof key !== "string") ||
      keys.length !== length + 1
    ) {
      return cursorError(`${label} must be a dense plain array`);
    }
    const result = createInternalArray<unknown>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[CURSOR_INTRINSICS.stringFromValue(index)];
      if (
        descriptor === undefined ||
        !CURSOR_INTRINSICS.objectHasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return cursorError(`${label} must be a dense plain array`);
      }
      appendInternalArray(result, descriptor.value);
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
  const keys = CURSOR_INTRINSICS.reflectOwnKeys(value);
  if (keys.length !== expected.length) {
    cursorError(`${label} has invalid properties`);
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || !arrayIncludes(expected, key)) {
      cursorError(`${label} has invalid properties`);
    }
  }
}

function hashCanonical(value: unknown): string {
  const hash = CURSOR_INTRINSICS.createHash("sha256");
  CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.hashUpdate, hash, [
    canonicalJson(value),
  ]);
  return CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.hashDigest, hash, [
    "hex",
  ]);
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
  if (typeof value !== "string" || !regexpMatches(HASH, value)) {
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
  const result = createInternalArray<CursorValue>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      entry !== null &&
      typeof entry !== "string" &&
      (typeof entry !== "number" || !CURSOR_INTRINSICS.numberIsFinite(entry))
    ) {
      return cursorError(`${label} contains an invalid value`);
    }
    appendInternalArray(result, entry);
  }
  return result;
}

function booleanMarkers(value: unknown): readonly boolean[] {
  const entries = snapshotDenseArray(value, "repository cursor null markers");
  if (arraySome(entries, (entry) => typeof entry !== "boolean")) {
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
  exactKeys(record, ["v", "kind", "snapshotId"], "list cursor context");
  if (record.v !== 1 || record.kind !== "lists") {
    return cursorError("cursor resource kind does not match lists");
  }
  const snapshotId = stableSnapshotId(
    record.snapshotId,
    "list cursor snapshot",
  );
  const publicContext = { v: 1, kind: "lists", snapshotId } as const;
  return {
    v: 1,
    snapshotId,
    selectionHash: hashCanonical(publicContext),
  };
}

function normalizeMembershipSelector(
  input: unknown,
  label: string,
):
  | { readonly kind: "list"; readonly listId: UserListId }
  | {
      readonly kind: "repository";
      readonly repositoryId: RepositoryId;
    } {
  const record = snapshotPlainObject(input, label);
  if (record.kind === "list") {
    exactKeys(record, ["kind", "listId"], label);
    return CURSOR_INTRINSICS.objectFreeze({
      kind: "list",
      listId: stableListId(record.listId),
    });
  }
  if (record.kind === "repository") {
    exactKeys(record, ["kind", "repositoryId"], label);
    return CURSOR_INTRINSICS.objectFreeze({
      kind: "repository",
      repositoryId: stableRepositoryId(record.repositoryId),
    });
  }
  return cursorError(`${label} kind is invalid`);
}

function normalizeListMembershipContext(
  context: unknown,
): NormalizedListMembershipContext {
  const record = snapshotPlainObject(context, "List membership cursor context");
  exactKeys(
    record,
    ["v", "kind", "snapshotId", "selector"],
    "List membership cursor context",
  );
  if (record.v !== 1 || record.kind !== "list_memberships") {
    return cursorError("cursor resource kind does not match List memberships");
  }
  const snapshotId = stableSnapshotId(
    record.snapshotId,
    "List membership cursor snapshot",
  );
  const selector = normalizeMembershipSelector(
    record.selector,
    "List membership cursor selector",
  );
  const publicContext = {
    v: 1,
    kind: "list_memberships",
    snapshotId,
    selector,
  } as const;
  return CURSOR_INTRINSICS.objectFreeze({
    v: 1,
    snapshotId,
    selector,
    selectionHash: hashCanonical(publicContext),
  }) as NormalizedListMembershipContext;
}

function validateRepositoryValues(
  sort: readonly NormalizedRepositorySort[],
  values: readonly CursorValue[],
  nulls: readonly boolean[],
): void {
  const valueTerms = arrayFilter(
    sort,
    (term) => term.field !== "repository_id",
  );
  if (
    values.length !== valueTerms.length ||
    nulls.length !== valueTerms.length ||
    arraySome(values, (entry, index) => (entry === null) !== nulls[index])
  ) {
    return cursorError(
      "repository cursor values do not match normalized sort and null markers",
    );
  }

  for (let index = 0; index < valueTerms.length; index += 1) {
    const term = valueTerms[index] as NormalizedRepositorySort;
    const value = values[index] as CursorValue;
    if (term.field === "stargazer_count") {
      if (
        typeof value !== "number" ||
        !CURSOR_INTRINSICS.numberIsSafeInteger(value) ||
        value < 0
      ) {
        cursorError(
          "repository cursor stargazer value must be a nonnegative safe integer",
        );
      }
      continue;
    }
    if (term.field === "pushed_at" && value === null) continue;
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
  }
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
    values: frozenArrayCopy(values),
    nulls: frozenArrayCopy(nulls),
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
    values: frozenArrayCopy(cursorValues(record.values, "list cursor values")),
    listId: stableListId(record.listId),
  };
}

function sameMembershipSelector(
  left: NormalizedListMembershipContext["selector"],
  right:
    | { readonly kind: "list"; readonly listId: UserListId }
    | {
        readonly kind: "repository";
        readonly repositoryId: RepositoryId;
      },
): boolean {
  return left.kind === "list" && right.kind === "list"
    ? left.listId === right.listId
    : left.kind === "repository" && right.kind === "repository"
      ? left.repositoryId === right.repositoryId
      : false;
}

function listMembershipPosition(
  input: unknown,
  context: NormalizedListMembershipContext,
):
  | {
      readonly selector: { readonly kind: "list"; readonly listId: UserListId };
      readonly boundaryRepositoryId: RepositoryId;
    }
  | {
      readonly selector: {
        readonly kind: "repository";
        readonly repositoryId: RepositoryId;
      };
      readonly boundaryListId: UserListId;
    } {
  const record = snapshotPlainObject(input, "List membership cursor position");
  const selector = normalizeMembershipSelector(
    record.selector,
    "List membership cursor position selector",
  );
  if (!sameMembershipSelector(context.selector, selector)) {
    return cursorError("List membership cursor selectors do not match");
  }
  if (selector.kind === "list") {
    exactKeys(
      record,
      ["selector", "boundaryRepositoryId"],
      "List membership cursor position",
    );
    return CURSOR_INTRINSICS.objectFreeze({
      selector,
      boundaryRepositoryId: stableRepositoryId(record.boundaryRepositoryId),
    });
  }
  exactKeys(
    record,
    ["selector", "boundaryListId"],
    "List membership cursor position",
  );
  return CURSOR_INTRINSICS.objectFreeze({
    selector,
    boundaryListId: stableListId(record.boundaryListId),
  });
}

function intrinsicByteLength(value: Uint8Array): number {
  return CURSOR_INTRINSICS.reflectApply(
    CURSOR_INTRINSICS.typedArrayByteLength,
    value,
    [],
  ) as number;
}

function signingKeyCopy(signingKey: Uint8Array): Uint8Array {
  try {
    if (
      typeof signingKey !== "object" ||
      signingKey === null ||
      CURSOR_INTRINSICS.utilIsProxy(signingKey) ||
      !CURSOR_INTRINSICS.utilIsUint8Array(signingKey)
    ) {
      return cursorError(
        "cursor signing key must be a Uint8Array of at least 32 bytes",
      );
    }
    const actualLength = intrinsicByteLength(signingKey);
    if (
      !CURSOR_INTRINSICS.numberIsSafeInteger(actualLength) ||
      actualLength < 32
    ) {
      return cursorError(
        "cursor signing key must be a Uint8Array of at least 32 bytes",
      );
    }
    const copy = new CURSOR_INTRINSICS.uint8ArrayConstructor(actualLength);
    CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.uint8ArraySet, copy, [
      signingKey,
    ]);
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
  if (!regexpMatches(MAC, mac)) {
    return cursorError("cursor authentication code is invalid");
  }
  let expected: Buffer;
  try {
    const hmac = CURSOR_INTRINSICS.createHmac("sha256", key);
    CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.hmacUpdate, hmac, [
      payloadText,
    ]);
    expected = CURSOR_INTRINSICS.reflectApply(
      CURSOR_INTRINSICS.hmacDigest,
      hmac,
      [],
    ) as Buffer;
  } catch {
    return cursorError("cursor authentication failed");
  }
  const supplied = CURSOR_INTRINSICS.bufferFrom(mac, "hex");
  if (
    intrinsicByteLength(supplied) !== intrinsicByteLength(expected) ||
    !CURSOR_INTRINSICS.timingSafeEqual(supplied, expected)
  ) {
    return cursorError("cursor authentication failed");
  }
}

function encodedEnvelope(payload: unknown, key: Uint8Array): string {
  const payloadText = canonicalJson(payload);
  let mac: string;
  try {
    const hmac = CURSOR_INTRINSICS.createHmac("sha256", key);
    CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.hmacUpdate, hmac, [
      payloadText,
    ]);
    mac = CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.hmacDigest, hmac, [
      "hex",
    ]);
  } catch {
    return cursorError("cursor authentication failed");
  }
  const text = canonicalJson({ mac, payload });
  const cursorBytes = CURSOR_INTRINSICS.bufferFrom(text, "utf8");
  const cursor = CURSOR_INTRINSICS.reflectApply(
    CURSOR_INTRINSICS.bufferToString,
    cursorBytes,
    ["base64url"],
  );
  if (
    CURSOR_INTRINSICS.bufferByteLength(text, "utf8") > MAX_CURSOR_BYTES ||
    CURSOR_INTRINSICS.bufferByteLength(cursor, "utf8") > MAX_CURSOR_BYTES
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
    CURSOR_INTRINSICS.bufferByteLength(cursor, "utf8") > MAX_CURSOR_BYTES ||
    !regexpMatches(BASE64URL, cursor)
  ) {
    return cursorError("cursor must be at most 4 KiB of base64url text");
  }

  let bytes: Buffer;
  try {
    bytes = CURSOR_INTRINSICS.bufferFrom(cursor, "base64url");
  } catch {
    return cursorError("cursor base64url is invalid");
  }
  if (
    CURSOR_INTRINSICS.reflectApply(CURSOR_INTRINSICS.bufferToString, bytes, [
      "base64url",
    ]) !== cursor ||
    intrinsicByteLength(bytes) > MAX_CURSOR_BYTES
  ) {
    return cursorError("cursor base64url is not canonical");
  }
  const text = CURSOR_INTRINSICS.reflectApply(
    CURSOR_INTRINSICS.bufferToString,
    bytes,
    ["utf8"],
  );
  const canonicalBytes = CURSOR_INTRINSICS.bufferFrom(text, "utf8");
  if (
    !CURSOR_INTRINSICS.reflectApply(
      CURSOR_INTRINSICS.bufferEquals,
      canonicalBytes,
      [bytes],
    )
  ) {
    return cursorError("cursor is not valid UTF-8");
  }

  let parsed: unknown;
  try {
    parsed = CURSOR_INTRINSICS.jsonParse(text) as unknown;
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

  const result = CURSOR_INTRINSICS.objectFreeze({
    v: 1,
    kind: "repositories",
    snapshotId,
    filterHash,
    sortHash,
    values: frozenArrayCopy(values),
    nulls: frozenArrayCopy(nulls),
    repositoryId,
  }) as ValidatedRepositoryCursorPayload;
  weakSetAdd(validatedRepositoryPayloads, result);
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
  return CURSOR_INTRINSICS.objectFreeze({
    v: 1,
    kind: "lists",
    snapshotId,
    selectionHash,
    values: frozenArrayCopy(values),
    listId,
  });
}

function decodeListMembershipPayload(
  cursor: string,
  context: NormalizedListMembershipContext,
  key: Uint8Array,
): ValidatedListMembershipCursorPayload {
  const payload = decodedEnvelope(cursor, key);
  const selector = normalizeMembershipSelector(
    payload.selector,
    "List membership cursor selector",
  );
  const common = ["v", "kind", "snapshotId", "selectionHash", "selector"];
  const expectedKeys = arrayCopy(common);
  appendInternalArray(
    expectedKeys,
    selector.kind === "list" ? "boundaryRepositoryId" : "boundaryListId",
  );
  exactKeys(payload, expectedKeys, "List membership cursor payload");
  if (payload.v !== 1 || payload.kind !== "list_memberships") {
    return cursorError("cursor resource kind does not match List memberships");
  }
  const snapshotId = stableSnapshotId(
    payload.snapshotId,
    "List membership cursor snapshot",
  );
  const selectionHash = validHash(
    payload.selectionHash,
    "List membership cursor selection hash",
  );
  if (snapshotId !== context.snapshotId) {
    return cursorError("List membership cursor snapshot does not match");
  }
  if (
    selectionHash !== context.selectionHash ||
    !sameMembershipSelector(context.selector, selector)
  ) {
    return cursorError("List membership cursor selection does not match");
  }
  const result =
    selector.kind === "list"
      ? CURSOR_INTRINSICS.objectFreeze({
          v: 1,
          kind: "list_memberships",
          snapshotId,
          selectionHash,
          selector,
          boundaryRepositoryId: stableRepositoryId(
            payload.boundaryRepositoryId,
          ),
        })
      : CURSOR_INTRINSICS.objectFreeze({
          v: 1,
          kind: "list_memberships",
          snapshotId,
          selectionHash,
          selector,
          boundaryListId: stableListId(payload.boundaryListId),
        });
  weakSetAdd(validatedListMembershipPayloads, result);
  return result as ValidatedListMembershipCursorPayload;
}

export function assertValidatedRepositoryCursorPayload(
  value: unknown,
): asserts value is ValidatedRepositoryCursorPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !weakSetHas(validatedRepositoryPayloads, value)
  ) {
    cursorError(
      "repository cursor payload must come from complete authenticated decoding",
    );
  }
}

export function assertValidatedListMembershipCursorPayload(
  value: unknown,
): asserts value is ValidatedListMembershipCursorPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !weakSetHas(validatedListMembershipPayloads, value)
  ) {
    cursorError(
      "List membership cursor payload must come from authenticated decoding",
    );
  }
}

export function createCursorCodec(signingKey: Uint8Array): CursorCodec {
  const key = signingKeyCopy(signingKey);
  return CURSOR_INTRINSICS.objectFreeze({
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
    encodeListMembership(
      contextInput: ListMembershipCursorContext,
      positionInput: ListMembershipCursorPosition,
    ): string {
      const context = normalizeListMembershipContext(contextInput);
      const position = listMembershipPosition(positionInput, context);
      return encodedEnvelope(
        "boundaryRepositoryId" in position
          ? {
              v: 1,
              kind: "list_memberships",
              snapshotId: context.snapshotId,
              selectionHash: context.selectionHash,
              selector: position.selector,
              boundaryRepositoryId: position.boundaryRepositoryId,
            }
          : {
              v: 1,
              kind: "list_memberships",
              snapshotId: context.snapshotId,
              selectionHash: context.selectionHash,
              selector: position.selector,
              boundaryListId: position.boundaryListId,
            },
        key,
      );
    },
    decodeListMembership(
      cursor: string,
      contextInput: ListMembershipCursorContext,
    ): ValidatedListMembershipCursorPayload {
      return decodeListMembershipPayload(
        cursor,
        normalizeListMembershipContext(contextInput),
        key,
      );
    },
  });
}
