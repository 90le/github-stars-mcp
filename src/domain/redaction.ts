import { types as utilTypes } from "node:util";
import type { JsonValue } from "./json.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[Truncated]";
const CIRCULAR = "[Circular]";
const UNSUPPORTED_ARRAY_ITEM = "[Unsupported array item]";
const MAX_DEPTH = 20;
const GITHUB_TOKEN =
  /\b(?:github_pat_[A-Za-z0-9_]{8,255}|gh[pousr]_[A-Za-z0-9_]{8,255})\b/gu;
const BEARER_CREDENTIAL = /\bBearer[ \t]+[A-Za-z0-9._~+/\-=]{1,4096}/giu;

const FREEZE = Object.freeze;
/* eslint-disable @typescript-eslint/unbound-method -- Redaction captures mutable realm methods once and invokes them only with explicit receivers. */
const INTRINSICS = FREEZE({
  arrayIsArray: Array.isArray,
  arraySort: Array.prototype.sort,
  getOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  objectDefineProperty: Object.defineProperty,
  objectFreeze: FREEZE,
  objectPrototype: Object.prototype,
  reflectApply: Reflect.apply,
  reflectGetPrototypeOf: Reflect.getPrototypeOf,
  reflectOwnKeys: Reflect.ownKeys,
  regexpReplace: RegExp.prototype[Symbol.replace],
  stringFromValue: String,
  stringReplaceAll: String.prototype.replaceAll,
  stringToLowerCase: String.prototype.toLowerCase,
  utilIsProxy: utilTypes.isProxy,
  weakSetAdd: WeakSet.prototype.add,
  weakSetConstructor: WeakSet,
  weakSetDelete: WeakSet.prototype.delete,
  weakSetHas: WeakSet.prototype.has,
});
/* eslint-enable @typescript-eslint/unbound-method */

const INVALID_SECRET_REGISTRY: readonly string[] = (() => {
  const sentinel: string[] = [];
  sentinel.length = 1;
  return Object.freeze(sentinel);
})();

function inspectSecretRegistry(
  secrets: readonly string[],
): readonly string[] | undefined {
  if (secrets === INVALID_SECRET_REGISTRY) return undefined;

  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (!INTRINSICS.arrayIsArray(secrets)) return undefined;
    descriptors = INTRINSICS.getOwnPropertyDescriptors(secrets);
  } catch {
    return undefined;
  }

  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return undefined;
  }

  const length = lengthDescriptor.value;
  const keys = INTRINSICS.reflectOwnKeys(descriptors);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (typeof key !== "string") return undefined;
    if (key === "length") continue;
    if (!/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length) return undefined;
  }

  const snapshot: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
    ) {
      snapshot.push(descriptor.value);
      continue;
    }
    return undefined;
  }
  return INTRINSICS.objectFreeze(snapshot);
}

export function snapshotSecretRegistry(
  secrets: readonly string[],
): readonly string[] {
  return inspectSecretRegistry(secrets) ?? INVALID_SECRET_REGISTRY;
}

function registeredSecrets(
  secrets: readonly string[],
): readonly string[] | undefined {
  const snapshot = snapshotSecretRegistry(secrets);
  if (snapshot === INVALID_SECRET_REGISTRY) return undefined;

  const unique: string[] = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    const secret = snapshot[index];
    if (secret === undefined || secret.length === 0) continue;
    let seen = false;
    for (
      let existingIndex = 0;
      existingIndex < unique.length;
      existingIndex += 1
    ) {
      if (unique[existingIndex] === secret) {
        seen = true;
        break;
      }
    }
    if (!seen) unique.push(secret);
  }
  INTRINSICS.reflectApply(INTRINSICS.arraySort, unique, [
    (left: string, right: string) => right.length - left.length,
  ]);
  return INTRINSICS.objectFreeze(unique);
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (let index = 0; index < secrets.length; index += 1) {
    const secret = secrets[index];
    if (secret !== undefined) {
      redacted = INTRINSICS.reflectApply(
        INTRINSICS.stringReplaceAll,
        redacted,
        [secret, REDACTED],
      ) as string;
    }
  }
  redacted = INTRINSICS.reflectApply(INTRINSICS.regexpReplace, GITHUB_TOKEN, [
    redacted,
    REDACTED,
  ]) as string;
  return INTRINSICS.reflectApply(INTRINSICS.regexpReplace, BEARER_CREDENTIAL, [
    redacted,
    REDACTED,
  ]) as string;
}

function unsupportedPrimitive(
  value: bigint | symbol | undefined,
  secrets: readonly string[],
): string {
  return redactString(INTRINSICS.stringFromValue(value), secrets);
}

function dataDescriptors(value: object): PropertyDescriptorMap | undefined {
  try {
    if (INTRINSICS.utilIsProxy(value)) return undefined;
    return INTRINSICS.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
}

function redactArray(
  value: readonly unknown[],
  secrets: readonly string[],
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  const descriptors = dataDescriptors(value);
  if (descriptors === undefined) return [UNSUPPORTED_ARRAY_ITEM];
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return [UNSUPPORTED_ARRAY_ITEM];
  }

  const result: JsonValue[] = [];
  INTRINSICS.reflectApply(INTRINSICS.weakSetAdd, ancestors, [value]);
  try {
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        result.push(UNSUPPORTED_ARRAY_ITEM);
        continue;
      }
      result.push(redactValue(descriptor.value, secrets, depth + 1, ancestors));
    }
  } finally {
    INTRINSICS.reflectApply(INTRINSICS.weakSetDelete, ancestors, [value]);
  }
  return result;
}

function isPlainObject(value: object): boolean {
  try {
    if (INTRINSICS.utilIsProxy(value)) return false;
    const prototype = INTRINSICS.reflectGetPrototypeOf(value);
    return prototype === INTRINSICS.objectPrototype || prototype === null;
  } catch {
    return false;
  }
}

function defineDataProperty(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  INTRINSICS.objectDefineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function redactObject(
  value: object,
  secrets: readonly string[],
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  if (!isPlainObject(value)) return "[Unsupported object]";

  const descriptors = dataDescriptors(value);
  if (descriptors === undefined) return "[Unsupported object]";

  const result: Record<string, JsonValue> = {};
  INTRINSICS.reflectApply(INTRINSICS.weakSetAdd, ancestors, [value]);
  try {
    const keys = INTRINSICS.reflectOwnKeys(descriptors);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") continue;
      const descriptor = descriptors[key];
      if (descriptor === undefined) continue;
      if (descriptor.enumerable !== true || !("value" in descriptor)) {
        continue;
      }

      const outputKey = redactString(key, secrets);
      const lowerKey = INTRINSICS.reflectApply(
        INTRINSICS.stringToLowerCase,
        key,
        [],
      );
      const outputValue =
        lowerKey === "authorization" ||
        lowerKey === "token" ||
        lowerKey === "access_token" ||
        lowerKey === "password" ||
        lowerKey === "cookie"
          ? REDACTED
          : redactValue(descriptor.value, secrets, depth + 1, ancestors);
      defineDataProperty(result, outputKey, outputValue);
    }
  } finally {
    INTRINSICS.reflectApply(INTRINSICS.weakSetDelete, ancestors, [value]);
  }
  return result;
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value, secrets);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : redactString(String(value), secrets);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return unsupportedPrimitive(value, secrets);
  }
  if (typeof value === "function") return "[Function]";
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (
    INTRINSICS.reflectApply(INTRINSICS.weakSetHas, ancestors, [value]) === true
  ) {
    return CIRCULAR;
  }

  let array = false;
  try {
    if (INTRINSICS.utilIsProxy(value)) return "[Unsupported object]";
    array = INTRINSICS.arrayIsArray(value);
  } catch {
    return "[Unsupported object]";
  }
  return array
    ? redactArray(value as readonly unknown[], secrets, depth, ancestors)
    : redactObject(value, secrets, depth, ancestors);
}

export function redactSecrets(
  value: unknown,
  secrets: readonly string[] = [],
): JsonValue {
  const inspectedSecrets = registeredSecrets(secrets);
  return inspectedSecrets === undefined
    ? REDACTED
    : redactValue(
        value,
        inspectedSecrets,
        0,
        new INTRINSICS.weakSetConstructor<object>(),
      );
}
