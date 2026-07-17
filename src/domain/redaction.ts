import { types as utilTypes } from "node:util";
import type { JsonValue } from "./json.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[Truncated]";
const CIRCULAR = "[Circular]";
const UNSUPPORTED_ARRAY_ITEM = "[Unsupported array item]";
const MAX_DEPTH = 20;
const MIN_GITHUB_TOKEN_BODY = 8;

const FREEZE = Object.freeze;
/* eslint-disable @typescript-eslint/unbound-method -- Redaction captures mutable realm methods once and invokes them only with explicit receivers. */
const INTRINSICS = FREEZE({
  arrayIsArray: Array.isArray,
  arraySort: Array.prototype.sort,
  numberIsFinite: Number.isFinite,
  numberIsInteger: Number.isInteger,
  numberIsSafeInteger: Number.isSafeInteger,
  objectCreate: Object.create,
  objectFreeze: FREEZE,
  objectHasOwn: Object.hasOwn,
  objectPrototype: Object.prototype,
  reflectApply: Reflect.apply,
  reflectDefineProperty: Reflect.defineProperty,
  reflectGetOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
  reflectGetPrototypeOf: Reflect.getPrototypeOf,
  reflectOwnKeys: Reflect.ownKeys,
  reflectSetPrototypeOf: Reflect.setPrototypeOf,
  stringCharCodeAt: String.prototype.charCodeAt,
  stringFromValue: String,
  stringReplaceAll: String.prototype.replaceAll,
  stringSlice: String.prototype.slice,
  stringToLowerCase: String.prototype.toLowerCase,
  utilIsProxy: utilTypes.isProxy,
  weakSetAdd: WeakSet.prototype.add,
  weakSetConstructor: WeakSet,
  weakSetDelete: WeakSet.prototype.delete,
  weakSetHas: WeakSet.prototype.has,
});
/* eslint-enable @typescript-eslint/unbound-method */

function failInternalRedaction(): never {
  throw new TypeError("Internal redaction operation failed");
}

function createInternalArray<T>(): T[] {
  const array: T[] = [];
  if (!INTRINSICS.reflectSetPrototypeOf(array, null)) {
    failInternalRedaction();
  }
  return array;
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
    failInternalRedaction();
  }
}

function createInternalRecord(): Record<string, JsonValue> {
  return INTRINSICS.objectCreate(null) as Record<string, JsonValue>;
}

const EMPTY_SECRET_REGISTRY = INTRINSICS.objectFreeze(
  createInternalArray<string>(),
);
const INVALID_SECRET_REGISTRY = INTRINSICS.objectFreeze(
  createInternalArray<string>(),
);

function canonicalArrayIndex(key: string, length: number): number | null {
  if (key.length === 0) return null;
  let index = 0;
  for (let offset = 0; offset < key.length; offset += 1) {
    const code = INTRINSICS.reflectApply(INTRINSICS.stringCharCodeAt, key, [
      offset,
    ]);
    if (
      code < 48 ||
      code > 57 ||
      (offset === 0 && code === 48 && key.length > 1)
    ) {
      return null;
    }
    index = index * 10 + code - 48;
    if (!INTRINSICS.numberIsSafeInteger(index) || index >= length) return null;
  }
  return index;
}

function inspectSecretRegistry(
  secrets: readonly string[],
): readonly string[] | undefined {
  if (secrets === INVALID_SECRET_REGISTRY) return undefined;

  try {
    if (INTRINSICS.utilIsProxy(secrets)) return undefined;
    if (!INTRINSICS.arrayIsArray(secrets)) return undefined;
    const lengthDescriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(
      secrets,
      "length",
    );
    if (
      lengthDescriptor === undefined ||
      !INTRINSICS.objectHasOwn(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !INTRINSICS.numberIsInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return undefined;
    }

    const length = lengthDescriptor.value;
    const keys = INTRINSICS.reflectOwnKeys(secrets);
    if (keys.length !== length + 1) return undefined;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        canonicalArrayIndex(key, length) === null
      ) {
        return undefined;
      }
    }

    const snapshot = createInternalArray<string>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(
        secrets,
        INTRINSICS.stringFromValue(index),
      );
      if (
        descriptor === undefined ||
        !INTRINSICS.objectHasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      ) {
        return undefined;
      }
      appendInternalArray(snapshot, descriptor.value);
    }
    return INTRINSICS.objectFreeze(snapshot);
  } catch {
    return undefined;
  }
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

  const unique = createInternalArray<string>();
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
    if (!seen) appendInternalArray(unique, secret);
  }
  INTRINSICS.reflectApply(INTRINSICS.arraySort, unique, [
    (left: string, right: string) => right.length - left.length,
  ]);
  return INTRINSICS.objectFreeze(unique);
}

function codeUnitAt(value: string, index: number): number {
  return INTRINSICS.reflectApply(INTRINSICS.stringCharCodeAt, value, [index]);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isGitHubTokenCode(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 95;
}

function isBearerCredentialCode(code: number): boolean {
  return (
    isGitHubTokenCode(code) ||
    code === 43 ||
    code === 45 ||
    code === 46 ||
    code === 47 ||
    code === 61 ||
    code === 126
  );
}

function githubTokenPrefixLength(value: string, index: number): number {
  if (codeUnitAt(value, index) !== 103) return 0;
  if (
    codeUnitAt(value, index + 1) === 104 &&
    (codeUnitAt(value, index + 2) === 112 ||
      codeUnitAt(value, index + 2) === 111 ||
      codeUnitAt(value, index + 2) === 117 ||
      codeUnitAt(value, index + 2) === 115 ||
      codeUnitAt(value, index + 2) === 114) &&
    codeUnitAt(value, index + 3) === 95
  ) {
    return 4;
  }
  return codeUnitAt(value, index + 1) === 105 &&
    codeUnitAt(value, index + 2) === 116 &&
    codeUnitAt(value, index + 3) === 104 &&
    codeUnitAt(value, index + 4) === 117 &&
    codeUnitAt(value, index + 5) === 98 &&
    codeUnitAt(value, index + 6) === 95 &&
    codeUnitAt(value, index + 7) === 112 &&
    codeUnitAt(value, index + 8) === 97 &&
    codeUnitAt(value, index + 9) === 116 &&
    codeUnitAt(value, index + 10) === 95
    ? 11
    : 0;
}

function githubTokenEnd(value: string, index: number): number {
  const prefixLength = githubTokenPrefixLength(value, index);
  if (prefixLength === 0) return index;
  let end = index + prefixLength;
  while (end < value.length && isGitHubTokenCode(codeUnitAt(value, end))) {
    end += 1;
  }
  return end - index - prefixLength >= MIN_GITHUB_TOKEN_BODY ? end : index;
}

function asciiLowercase(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function bearerCredentialEnd(value: string, index: number): number {
  if (
    asciiLowercase(codeUnitAt(value, index)) !== 98 ||
    asciiLowercase(codeUnitAt(value, index + 1)) !== 101 ||
    asciiLowercase(codeUnitAt(value, index + 2)) !== 97 ||
    asciiLowercase(codeUnitAt(value, index + 3)) !== 114 ||
    asciiLowercase(codeUnitAt(value, index + 4)) !== 101 ||
    asciiLowercase(codeUnitAt(value, index + 5)) !== 114
  ) {
    return index;
  }

  let end = index + 6;
  const firstWhitespace = codeUnitAt(value, end);
  if (firstWhitespace !== 32 && firstWhitespace !== 9) return index;
  do {
    end += 1;
  } while (
    end < value.length &&
    (codeUnitAt(value, end) === 32 || codeUnitAt(value, end) === 9)
  );
  const credentialStart = end;
  while (end < value.length && isBearerCredentialCode(codeUnitAt(value, end))) {
    end += 1;
  }
  return end > credentialStart ? end : index;
}

function redactCredentials(value: string): string {
  let output = "";
  let copyStart = 0;
  let index = 0;
  while (index < value.length) {
    const bearerEnd = bearerCredentialEnd(value, index);
    const credentialEnd =
      bearerEnd > index ? bearerEnd : githubTokenEnd(value, index);
    if (credentialEnd === index) {
      index += 1;
      continue;
    }
    output += INTRINSICS.reflectApply(INTRINSICS.stringSlice, value, [
      copyStart,
      index,
    ]);
    output += REDACTED;
    index = credentialEnd;
    copyStart = credentialEnd;
  }
  const suffix = INTRINSICS.reflectApply(INTRINSICS.stringSlice, value, [
    copyStart,
  ]);
  return output + suffix;
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
  return redactCredentials(redacted);
}

function unsupportedPrimitive(
  value: bigint | symbol | undefined,
  secrets: readonly string[],
): string {
  return redactString(INTRINSICS.stringFromValue(value), secrets);
}

function redactArray(
  value: readonly unknown[],
  secrets: readonly string[],
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  const lengthDescriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(
    value,
    "length",
  );
  if (
    lengthDescriptor === undefined ||
    !INTRINSICS.objectHasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number" ||
    !INTRINSICS.numberIsInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    const unsupported = createInternalArray<JsonValue>();
    appendInternalArray(unsupported, UNSUPPORTED_ARRAY_ITEM);
    return unsupported;
  }

  const result = createInternalArray<JsonValue>();
  INTRINSICS.reflectApply(INTRINSICS.weakSetAdd, ancestors, [value]);
  try {
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(
        value,
        INTRINSICS.stringFromValue(index),
      );
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !INTRINSICS.objectHasOwn(descriptor, "value")
      ) {
        appendInternalArray(result, UNSUPPORTED_ARRAY_ITEM);
        continue;
      }
      appendInternalArray(
        result,
        redactValue(descriptor.value, secrets, depth + 1, ancestors),
      );
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
  if (
    !INTRINSICS.reflectDefineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  ) {
    failInternalRedaction();
  }
}

function redactObject(
  value: object,
  secrets: readonly string[],
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  if (!isPlainObject(value)) return "[Unsupported object]";

  const result = createInternalRecord();
  INTRINSICS.reflectApply(INTRINSICS.weakSetAdd, ancestors, [value]);
  try {
    const keys = INTRINSICS.reflectOwnKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") continue;
      const descriptor = INTRINSICS.reflectGetOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (
        descriptor.enumerable !== true ||
        !INTRINSICS.objectHasOwn(descriptor, "value")
      ) {
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
    return INTRINSICS.numberIsFinite(value)
      ? value
      : redactString(INTRINSICS.stringFromValue(value), secrets);
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
  secrets: readonly string[] = EMPTY_SECRET_REGISTRY,
): JsonValue {
  try {
    const inspectedSecrets = registeredSecrets(secrets);
    return inspectedSecrets === undefined
      ? REDACTED
      : redactValue(
          value,
          inspectedSecrets,
          0,
          new INTRINSICS.weakSetConstructor<object>(),
        );
  } catch {
    return REDACTED;
  }
}
