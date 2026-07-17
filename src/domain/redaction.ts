import type { JsonValue } from "./json.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[Truncated]";
const CIRCULAR = "[Circular]";
const UNSUPPORTED_ARRAY_ITEM = "[Unsupported array item]";
const MAX_DEPTH = 20;
const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "password",
  "cookie",
]);

function registeredSecrets(
  secrets: readonly string[],
): readonly string[] | undefined {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (!Array.isArray(secrets)) return undefined;
    descriptors = Object.getOwnPropertyDescriptors(secrets);
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
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    if (key === "length") continue;
    if (!/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length) return undefined;
  }

  const unique = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
    ) {
      if (descriptor.value.length > 0) unique.add(descriptor.value);
      continue;
    }
    return undefined;
  }
  return [...unique].sort((left, right) => right.length - left.length);
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted;
}

function unsupportedPrimitive(
  value: bigint | symbol | undefined,
  secrets: readonly string[],
): string {
  return redactString(String(value), secrets);
}

function dataDescriptors(value: object): PropertyDescriptorMap | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value);
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
  ancestors.add(value);
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
    ancestors.delete(value);
  }
  return result;
}

function isPlainObject(value: object): boolean {
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function defineDataProperty(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
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
  ancestors.add(value);
  try {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.enumerable !== true || !("value" in descriptor)) {
        continue;
      }

      const outputKey = redactString(key, secrets);
      const outputValue = SENSITIVE_KEYS.has(key.toLowerCase())
        ? REDACTED
        : redactValue(descriptor.value, secrets, depth + 1, ancestors);
      defineDataProperty(result, outputKey, outputValue);
    }
  } finally {
    ancestors.delete(value);
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
  if (ancestors.has(value)) return CIRCULAR;

  let array = false;
  try {
    array = Array.isArray(value);
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
    : redactValue(value, inspectedSecrets, 0, new WeakSet());
}
