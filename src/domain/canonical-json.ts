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
  remainingBytes: number;
}

function failCanonicalJson(): never {
  throw new CanonicalJsonFailure();
}

interface InspectedProperty {
  readonly key: string;
  readonly value: unknown;
}

function inspectPlainObject(
  value: object,
  budget: SerializationBudget,
): readonly InspectedProperty[] {
  if (utilTypes.isProxy(value) || Array.isArray(value)) {
    return failCanonicalJson();
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return failCanonicalJson();
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_NODES - budget.nodes ||
    keys.length * 5 > budget.remainingBytes
  ) {
    return failCanonicalJson();
  }
  const result: InspectedProperty[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || key.length > MAX_STRING_CODE_UNITS) {
      return failCanonicalJson();
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return failCanonicalJson();
    }
    result.push({ key, value: descriptor.value as unknown });
  }
  return result.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

function inspectDenseArray(
  value: object,
  budget: SerializationBudget,
): readonly unknown[] {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  ) {
    return failCanonicalJson();
  }

  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
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
  if (length > MAX_NODES - budget.nodes || length * 2 > budget.remainingBytes) {
    return failCanonicalJson();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    keys.some((key) => typeof key !== "string")
  ) {
    return failCanonicalJson();
  }

  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
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

function consumeBytes(budget: SerializationBudget, count: number): void {
  if (
    !Number.isSafeInteger(count) ||
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
  consumeBytes(budget, Buffer.byteLength(text, "utf8"));
  fragments.push(text);
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
    appendText(budget, fragments, JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return failCanonicalJson();
    appendText(
      budget,
      fragments,
      Object.is(value, -0) ? "0" : JSON.stringify(value),
    );
    return;
  }
  if (typeof value !== "object") return failCanonicalJson();
  if (ancestors.has(value)) return failCanonicalJson();

  ancestors.add(value);
  try {
    if (utilTypes.isProxy(value)) return failCanonicalJson();
    if (Array.isArray(value)) {
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
      appendText(budget, fragments, JSON.stringify(property.key));
      appendText(budget, fragments, ":");
      serialize(property.value, ancestors, depth + 1, budget, fragments);
    }
    appendText(budget, fragments, "}");
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
    const budget: SerializationBudget = {
      nodes: 0,
      remainingBytes: MAX_CANONICAL_BYTES,
    };
    const fragments: string[] = [];
    serialize(value, new Set<object>(), 0, budget, fragments);
    const result = fragments.join("");
    if (
      Buffer.byteLength(result, "utf8") !==
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
