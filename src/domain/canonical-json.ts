import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { AppError } from "./errors.js";
import type { JsonValue } from "./json.js";

const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;
const MAX_STRING_CODE_UNITS = 1_048_576;
const MAX_CANONICAL_BYTES = 64 * 1_024 * 1_024;

class CanonicalJsonFailure extends Error {}

interface SerializationBudget {
  nodes: number;
}

function failCanonicalJson(): never {
  throw new CanonicalJsonFailure();
}

function inspectPlainObject(value: object): Readonly<Record<string, unknown>> {
  if (utilTypes.isProxy(value) || Array.isArray(value)) {
    return failCanonicalJson();
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return failCanonicalJson();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const keys = Reflect.ownKeys(descriptors);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || key.length > MAX_STRING_CODE_UNITS) {
      return failCanonicalJson();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return failCanonicalJson();
    }
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function inspectDenseArray(value: object): readonly unknown[] {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  ) {
    return failCanonicalJson();
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
    return failCanonicalJson();
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== length + 1 ||
    keys.some((key) => typeof key !== "string")
  ) {
    return failCanonicalJson();
  }

  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return failCanonicalJson();
    }
    result.push(descriptor.value);
  }
  return result;
}

function serialize(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  budget: SerializationBudget,
): string {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    return failCanonicalJson();
  }

  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CODE_UNITS) return failCanonicalJson();
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return failCanonicalJson();
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") return failCanonicalJson();
  if (ancestors.has(value)) return failCanonicalJson();

  ancestors.add(value);
  try {
    if (utilTypes.isProxy(value)) return failCanonicalJson();
    if (Array.isArray(value)) {
      const array = inspectDenseArray(value);
      const serialized: string[] = [];
      for (let index = 0; index < array.length; index += 1) {
        serialized.push(serialize(array[index], ancestors, depth + 1, budget));
      }
      return `[${serialized.join(",")}]`;
    }

    const record = inspectPlainObject(value);
    const keys = Object.keys(record).sort();
    const serialized: string[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) return failCanonicalJson();
      serialized.push(
        `${JSON.stringify(key)}:${serialize(
          record[key],
          ancestors,
          depth + 1,
          budget,
        )}`,
      );
    }
    return `{${serialized.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces deterministic JSON without consulting user-defined getters,
 * iterators, prototypes, or toJSON hooks.
 */
export function canonicalJson(value: unknown): string {
  try {
    const result = serialize(value, new Set<object>(), 0, { nodes: 0 });
    if (Buffer.byteLength(result, "utf8") > MAX_CANONICAL_BYTES) {
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
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Creates an accessor-free JSON clone. Domain parsers call this before
 * inspecting any caller-supplied field.
 */
export function canonicalJsonClone(value: unknown): JsonValue {
  const text = canonicalJson(value);
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "Value must be bounded canonical JSON data",
    );
  }
}

export function freezeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const entries = value as readonly JsonValue[];
    for (let index = 0; index < entries.length; index += 1) {
      freezeJsonValue(entries[index] as JsonValue);
    }
    return Object.freeze(entries);
  }
  const object = value as { readonly [key: string]: JsonValue };
  for (const key of Object.keys(object)) {
    freezeJsonValue(object[key] as JsonValue);
  }
  return Object.freeze(object);
}
