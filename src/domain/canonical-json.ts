import { Buffer } from "node:buffer";
import { createHash, Hash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { AppError } from "./errors.js";
import type { JsonValue } from "./json.js";

const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;
const MAX_STRING_CODE_UNITS = 1_048_576;
const MAX_CANONICAL_BYTES = 64 * 1_024 * 1_024;

const freezeIntrinsicRecord = Object.freeze;
/* eslint-disable @typescript-eslint/unbound-method -- Method intrinsics are deliberately captured and invoked only through captured Reflect.apply. */
const INTRINSICS = freezeIntrinsicRecord({
  arrayIsArray: Array.isArray,
  arrayJoin: Array.prototype.join,
  arrayPrototype: Array.prototype,
  arraySort: Array.prototype.sort,
  bufferByteLength: Buffer.byteLength,
  createHash,
  hashDigest: Hash.prototype.digest,
  hashUpdate: Hash.prototype.update,
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
  numberIsFinite: Number.isFinite,
  numberIsSafeInteger: Number.isSafeInteger,
  objectFreeze: freezeIntrinsicRecord,
  objectHasOwn: Object.hasOwn,
  objectIs: Object.is,
  objectKeys: Object.keys,
  objectPrototype: Object.prototype,
  reflectApply: Reflect.apply,
  reflectDefineProperty: Reflect.defineProperty,
  reflectGetOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
  reflectGetPrototypeOf: Reflect.getPrototypeOf,
  reflectOwnKeys: Reflect.ownKeys,
  reflectSetPrototypeOf: Reflect.setPrototypeOf,
  setAdd: Set.prototype.add,
  setConstructor: Set,
  setDelete: Set.prototype.delete,
  setHas: Set.prototype.has,
  stringFromValue: String,
  utilIsAnyArrayBuffer: utilTypes.isAnyArrayBuffer,
  utilIsArgumentsObject: utilTypes.isArgumentsObject,
  utilIsArrayBufferView: utilTypes.isArrayBufferView,
  utilIsBoxedPrimitive: utilTypes.isBoxedPrimitive,
  utilIsDate: utilTypes.isDate,
  utilIsExternal: utilTypes.isExternal,
  utilIsGeneratorObject: utilTypes.isGeneratorObject,
  utilIsMap: utilTypes.isMap,
  utilIsMapIterator: utilTypes.isMapIterator,
  utilIsModuleNamespaceObject: utilTypes.isModuleNamespaceObject,
  utilIsNativeError: utilTypes.isNativeError,
  utilIsPromise: utilTypes.isPromise,
  utilIsProxy: utilTypes.isProxy,
  utilIsRegExp: utilTypes.isRegExp,
  utilIsSet: utilTypes.isSet,
  utilIsSetIterator: utilTypes.isSetIterator,
  utilIsWeakMap: utilTypes.isWeakMap,
  utilIsWeakSet: utilTypes.isWeakSet,
});
/* eslint-enable @typescript-eslint/unbound-method */

class CanonicalJsonFailure extends Error {}

interface SerializationBudget {
  nodes: number;
  remainingBytes: number;
}

function failCanonicalJson(): never {
  throw new CanonicalJsonFailure();
}

function createInternalArray<T>(): T[] {
  const value: T[] = [];
  if (!INTRINSICS.reflectSetPrototypeOf(value, null)) {
    return failCanonicalJson();
  }
  return value;
}

function appendInternalArray<T>(target: T[], value: T): void {
  if (
    !INTRINSICS.reflectDefineProperty(
      target,
      INTRINSICS.stringFromValue(target.length),
      {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      },
    )
  ) {
    failCanonicalJson();
  }
}

function isRecognizableExotic(value: object): boolean {
  try {
    return (
      INTRINSICS.utilIsProxy(value) ||
      INTRINSICS.utilIsPromise(value) ||
      INTRINSICS.utilIsMap(value) ||
      INTRINSICS.utilIsSet(value) ||
      INTRINSICS.utilIsWeakMap(value) ||
      INTRINSICS.utilIsWeakSet(value) ||
      INTRINSICS.utilIsDate(value) ||
      INTRINSICS.utilIsRegExp(value) ||
      INTRINSICS.utilIsNativeError(value) ||
      INTRINSICS.utilIsAnyArrayBuffer(value) ||
      INTRINSICS.utilIsArrayBufferView(value) ||
      INTRINSICS.utilIsArgumentsObject(value) ||
      INTRINSICS.utilIsBoxedPrimitive(value) ||
      INTRINSICS.utilIsMapIterator(value) ||
      INTRINSICS.utilIsSetIterator(value) ||
      INTRINSICS.utilIsGeneratorObject(value) ||
      INTRINSICS.utilIsModuleNamespaceObject(value) ||
      INTRINSICS.utilIsExternal(value)
    );
  } catch {
    return true;
  }
}

interface InspectedProperty {
  readonly key: string;
  readonly value: unknown;
}

function inspectPlainObject(
  value: object,
  budget: SerializationBudget,
): readonly InspectedProperty[] {
  if (INTRINSICS.utilIsProxy(value) || INTRINSICS.arrayIsArray(value)) {
    return failCanonicalJson();
  }
  const prototype = INTRINSICS.reflectGetPrototypeOf(value);
  if (prototype !== INTRINSICS.objectPrototype && prototype !== null) {
    return failCanonicalJson();
  }

  const keys = INTRINSICS.reflectOwnKeys(value);
  if (
    keys.length > MAX_NODES - budget.nodes ||
    keys.length * 5 > budget.remainingBytes
  ) {
    return failCanonicalJson();
  }
  const result = createInternalArray<InspectedProperty>();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || key.length > MAX_STRING_CODE_UNITS) {
      return failCanonicalJson();
    }
    const descriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !INTRINSICS.objectHasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return failCanonicalJson();
    }
    appendInternalArray(result, {
      key,
      value: descriptor.value as unknown,
    });
  }
  INTRINSICS.reflectApply(INTRINSICS.arraySort, result, [
    (left: InspectedProperty, right: InspectedProperty) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  ]);
  return result;
}

function inspectDenseArray(
  value: object,
  budget: SerializationBudget,
): readonly unknown[] {
  if (INTRINSICS.utilIsProxy(value) || !INTRINSICS.arrayIsArray(value)) {
    return failCanonicalJson();
  }
  const prototype = INTRINSICS.reflectGetPrototypeOf(value);
  if (prototype !== INTRINSICS.arrayPrototype && prototype !== null) {
    return failCanonicalJson();
  }

  const lengthDescriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(
    value,
    "length",
  );
  if (
    lengthDescriptor === undefined ||
    !INTRINSICS.objectHasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number" ||
    !INTRINSICS.numberIsSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return failCanonicalJson();
  }
  const length = lengthDescriptor.value;
  if (length > MAX_NODES - budget.nodes || length * 2 > budget.remainingBytes) {
    return failCanonicalJson();
  }
  const keys = INTRINSICS.reflectOwnKeys(value);
  if (keys.length !== length + 1) {
    return failCanonicalJson();
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== "string") return failCanonicalJson();
  }

  const result = createInternalArray<unknown>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(
      value,
      INTRINSICS.stringFromValue(index),
    );
    if (
      descriptor === undefined ||
      !INTRINSICS.objectHasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return failCanonicalJson();
    }
    appendInternalArray(result, descriptor.value);
  }
  return result;
}

function consumeBytes(budget: SerializationBudget, count: number): void {
  if (
    !INTRINSICS.numberIsSafeInteger(count) ||
    count < 0 ||
    count > budget.remainingBytes
  ) {
    failCanonicalJson();
  }
  budget.remainingBytes -= count;
}

function appendText(
  budget: SerializationBudget,
  fragments: string[],
  text: string,
): void {
  consumeBytes(budget, INTRINSICS.bufferByteLength(text, "utf8"));
  appendInternalArray(fragments, text);
}

function serialize(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  budget: SerializationBudget,
  fragments: string[],
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    return failCanonicalJson();
  }

  if (value === null) {
    appendText(budget, fragments, "null");
    return;
  }
  if (typeof value === "boolean") {
    appendText(budget, fragments, value ? "true" : "false");
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CODE_UNITS) return failCanonicalJson();
    appendText(budget, fragments, INTRINSICS.jsonStringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!INTRINSICS.numberIsFinite(value)) return failCanonicalJson();
    appendText(
      budget,
      fragments,
      INTRINSICS.objectIs(value, -0) ? "0" : INTRINSICS.jsonStringify(value),
    );
    return;
  }
  if (typeof value !== "object") return failCanonicalJson();
  if (INTRINSICS.reflectApply(INTRINSICS.setHas, ancestors, [value])) {
    return failCanonicalJson();
  }
  if (isRecognizableExotic(value)) return failCanonicalJson();

  INTRINSICS.reflectApply(INTRINSICS.setAdd, ancestors, [value]);
  try {
    if (INTRINSICS.arrayIsArray(value)) {
      appendText(budget, fragments, "[");
      const array = inspectDenseArray(value, budget);
      for (let index = 0; index < array.length; index += 1) {
        if (index > 0) appendText(budget, fragments, ",");
        serialize(array[index], ancestors, depth + 1, budget, fragments);
      }
      appendText(budget, fragments, "]");
      return;
    }

    appendText(budget, fragments, "{");
    const properties = inspectPlainObject(value, budget);
    for (let index = 0; index < properties.length; index += 1) {
      const property = properties[index];
      if (property === undefined) return failCanonicalJson();
      if (index > 0) appendText(budget, fragments, ",");
      appendText(budget, fragments, INTRINSICS.jsonStringify(property.key));
      appendText(budget, fragments, ":");
      serialize(property.value, ancestors, depth + 1, budget, fragments);
    }
    appendText(budget, fragments, "}");
  } finally {
    INTRINSICS.reflectApply(INTRINSICS.setDelete, ancestors, [value]);
  }
}

/**
 * Produces deterministic JSON without consulting user-defined getters,
 * iterators, prototypes, or toJSON hooks. Every mutable realm operation used
 * by this module is captured before callers can run.
 */
export function canonicalJson(value: unknown): string {
  try {
    const budget: SerializationBudget = {
      nodes: 0,
      remainingBytes: MAX_CANONICAL_BYTES,
    };
    const fragments = createInternalArray<string>();
    serialize(
      value,
      new INTRINSICS.setConstructor<object>(),
      0,
      budget,
      fragments,
    );
    const result = INTRINSICS.reflectApply(INTRINSICS.arrayJoin, fragments, [
      "",
    ]);
    if (
      INTRINSICS.bufferByteLength(result, "utf8") !==
      MAX_CANONICAL_BYTES - budget.remainingBytes
    ) {
      return failCanonicalJson();
    }
    return result;
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Value must be bounded canonical JSON data",
    );
  }
}

export function sha256Hex(text: string): string {
  if (typeof text !== "string") {
    throw new AppError("VALIDATION_ERROR", "SHA-256 input must be text");
  }
  const hash = INTRINSICS.createHash("sha256");
  INTRINSICS.reflectApply(INTRINSICS.hashUpdate, hash, [text, "utf8"]);
  return INTRINSICS.reflectApply(INTRINSICS.hashDigest, hash, ["hex"]);
}

/**
 * Creates an accessor-free JSON clone. Domain parsers call this before
 * inspecting any caller-supplied field.
 */
export function canonicalJsonClone(value: unknown): JsonValue {
  const text = canonicalJson(value);
  try {
    return INTRINSICS.jsonParse(text) as JsonValue;
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Value must be bounded canonical JSON data",
    );
  }
}

export function freezeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (INTRINSICS.arrayIsArray(value)) {
    const entries = value as readonly JsonValue[];
    for (let index = 0; index < entries.length; index += 1) {
      freezeJsonValue(entries[index] as JsonValue);
    }
    return INTRINSICS.objectFreeze(entries);
  }
  const object = value as { readonly [key: string]: JsonValue };
  const keys = INTRINSICS.objectKeys(object);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) return failCanonicalJson();
    freezeJsonValue(object[key] as JsonValue);
  }
  return INTRINSICS.objectFreeze(object);
}
