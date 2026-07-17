import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { types as utilTypes } from "node:util";
import type { RateLimitState } from "../app/ports/github-port.js";
import { canonicalJsonClone } from "../domain/canonical-json.js";
import {
  AppError,
  serializeError,
  type AppErrorCode,
} from "../domain/errors.js";
import type { JsonValue } from "../domain/json.js";
import { redactSecrets } from "../domain/redaction.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";

type JsonObject = { readonly [key: string]: JsonValue };

export type ResultOptions = Readonly<{
  requestId: string;
  summary: string;
  warnings?: readonly string[];
  rateLimit?: RateLimitState | null;
  nextCursor?: string | null;
}>;

const INVALID_REQUEST_ID = "req_invalid";
const REDACTED_REQUEST_ID = "req_redacted";
const REDACTED = "[REDACTED]";
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 1_024;
const MAX_SUMMARY_LINES = 4;
const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 512;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_FAILURE_MESSAGE_LENGTH = 2_048;
const MAX_FAILURE_TEXT_LENGTH = 2_128;
const MAX_REGISTERED_SECRETS = 100;

const SUCCESS_OPTION_KEYS = new Set([
  "requestId",
  "summary",
  "warnings",
  "rateLimit",
  "nextCursor",
]);
const RATE_LIMIT_KEYS = new Set(["remaining", "resetAt"]);
const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "password",
  "cookie",
]);
const FAILURE_OMITTED_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "password",
  "cookie",
  "cause",
  "stack",
  "name",
  "secrets",
  "command",
  "headers",
  "stdout",
  "stderr",
  "raw",
  "rawerror",
  "raw_error",
]);
const TOKEN_PATTERN = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{4,}\b/gu;
const TOKEN_PATTERN_TEST = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{4,}\b/u;
const BEARER_PATTERN = /^Bearer[ \t]+(.+)$/iu;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u;
const freezeIntrinsic = Object.freeze;
/* eslint-disable @typescript-eslint/unbound-method -- Method intrinsics are deliberately captured and invoked only through captured Reflect.apply. */
const INTRINSICS = freezeIntrinsic({
  appErrorPrototype: AppError.prototype,
  arrayIsArray: Array.isArray,
  arrayPrototype: Array.prototype,
  numberFromValue: Number,
  numberIsInteger: Number.isInteger,
  numberIsSafeInteger: Number.isSafeInteger,
  objectCreate: Object.create,
  objectDefineProperty: Object.defineProperty,
  objectFreeze: freezeIntrinsic,
  objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  objectHasOwn: Object.hasOwn,
  objectKeys: Object.keys,
  reflectApply: Reflect.apply,
  reflectGetPrototypeOf: Reflect.getPrototypeOf,
  reflectOwnKeys: Reflect.ownKeys,
  regExpExec: RegExp.prototype.exec,
  setAdd: Set.prototype.add,
  setConstructor: Set,
  setHas: Set.prototype.has,
  stringFromValue: String,
  stringCharCodeAt: String.prototype.charCodeAt,
  stringIncludes: String.prototype.includes,
  stringSlice: String.prototype.slice,
  stringToLowerCase: String.prototype.toLowerCase,
  stringTrim: String.prototype.trim,
  utilIsProxy: utilTypes.isProxy,
});
/* eslint-enable @typescript-eslint/unbound-method */

function pushValue<T>(target: T[], value: T): void {
  INTRINSICS.objectDefineProperty(
    target,
    INTRINSICS.stringFromValue(target.length),
    {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    },
  );
}

function hasSetValue<T>(target: ReadonlySet<T>, value: T): boolean {
  return INTRINSICS.reflectApply(INTRINSICS.setHas, target, [value]);
}

function addSetValue<T>(target: Set<T>, value: T): void {
  INTRINSICS.reflectApply(INTRINSICS.setAdd, target, [value]);
}

function freezeOutputGraph<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;

  const descriptors = INTRINSICS.objectGetOwnPropertyDescriptors(value);
  if (!INTRINSICS.objectHasOwn(descriptors, "toJSON")) {
    INTRINSICS.objectDefineProperty(value, "toJSON", {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  }

  const keys = INTRINSICS.objectKeys(descriptors);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) return invalidInput();
    const descriptor = descriptors[key];
    if (
      descriptor !== undefined &&
      INTRINSICS.objectHasOwn(descriptor, "value")
    ) {
      freezeOutputGraph(descriptor.value);
    }
  }
  return INTRINSICS.objectFreeze(value);
}

function charCodeAt(value: string, index: number): number {
  return INTRINSICS.reflectApply(INTRINSICS.stringCharCodeAt, value, [index]);
}

function sliceText(value: string, start: number, end?: number): string {
  return end === undefined
    ? INTRINSICS.reflectApply(INTRINSICS.stringSlice, value, [start])
    : INTRINSICS.reflectApply(INTRINSICS.stringSlice, value, [start, end]);
}

function lowerCase(value: string): string {
  return INTRINSICS.reflectApply(INTRINSICS.stringToLowerCase, value, []);
}

function testPattern(pattern: RegExp, value: string): boolean {
  return execPattern(pattern, value) !== null;
}

function execPattern(pattern: RegExp, value: string): RegExpExecArray | null {
  return INTRINSICS.reflectApply(INTRINSICS.regExpExec, pattern, [value]);
}

function invalidInput(): never {
  throw new AppError(
    "VALIDATION_ERROR",
    "MCP result input does not satisfy the public result contract",
  );
}

function safeJsonClone(value: unknown): JsonValue {
  try {
    return canonicalJsonClone(value);
  } catch {
    return invalidInput();
  }
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return INTRINSICS.arrayIsArray(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !isJsonArray(value);
}

function safeJsonObject(value: unknown): JsonObject {
  const cloned = safeJsonClone(value);
  return isJsonObject(cloned) ? cloned : invalidInput();
}

function hasExactKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  const keys = INTRINSICS.objectKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || !hasSetValue(allowed, key)) return false;
  }
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (key === undefined || !INTRINSICS.objectHasOwn(value, key)) return false;
  }
  return true;
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = charCodeAt(value, index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = charCodeAt(value, index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function toWellFormedText(value: string): string {
  let result = "";
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = charCodeAt(value, index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = charCodeAt(value, index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }
    result += `${sliceText(value, segmentStart, index)}\ufffd`;
    segmentStart = index + 1;
  }
  if (segmentStart === 0) return value;
  return result + sliceText(value, segmentStart);
}

function hasControlCharacter(value: string, allowLineFeed: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = charCodeAt(value, index);
    if (
      (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) &&
      !(allowLineFeed && codeUnit === 0x0a)
    ) {
      return true;
    }
  }
  return false;
}

function isStructurallyValidRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    INTRINSICS.reflectApply(INTRINSICS.stringTrim, value, []) === value &&
    isWellFormedText(value) &&
    !hasControlCharacter(value, false)
  );
}

function validateSummary(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SUMMARY_LENGTH ||
    !isWellFormedText(value) ||
    hasControlCharacter(value, true)
  ) {
    return invalidInput();
  }
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (charCodeAt(value, index) === 0x0a) lines += 1;
  }
  return lines <= MAX_SUMMARY_LINES ? value : invalidInput();
}

function validateWarnings(value: JsonValue | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!isJsonArray(value) || value.length > MAX_WARNINGS) {
    return invalidInput();
  }
  const warnings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const warning = value[index];
    if (
      typeof warning !== "string" ||
      warning.length > MAX_WARNING_LENGTH ||
      !isWellFormedText(warning)
    ) {
      return invalidInput();
    }
    pushValue(warnings, warning);
  }
  return warnings;
}

function validateRateLimit(
  value: JsonValue | undefined,
): RateLimitState | null {
  if (value === undefined || value === null) return null;
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, RATE_LIMIT_KEYS, ["remaining", "resetAt"])
  ) {
    return invalidInput();
  }
  const remaining = value.remaining;
  const resetAt = value.resetAt;
  if (
    typeof remaining !== "number" ||
    !INTRINSICS.numberIsSafeInteger(remaining) ||
    remaining < 0 ||
    typeof resetAt !== "string"
  ) {
    return invalidInput();
  }
  let canonical: string;
  try {
    canonical = canonicalUtcTimestamp(resetAt, "rate limit reset");
  } catch {
    return invalidInput();
  }
  if (canonical !== resetAt) return invalidInput();
  return { remaining, resetAt };
}

function validateCursor(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_CURSOR_LENGTH ||
    !isWellFormedText(value) ||
    hasControlCharacter(value, false)
  ) {
    return invalidInput();
  }
  return value;
}

type SecretCollector = {
  readonly lookup: Set<string>;
  readonly values: string[];
};

function addSecret(secrets: SecretCollector, value: string): void {
  if (value.length === 0 || hasSetValue(secrets.lookup, value)) return;
  if (secrets.values.length >= MAX_REGISTERED_SECRETS) return invalidInput();
  addSetValue(secrets.lookup, value);
  pushValue(secrets.values, value);

  const bearer = execPattern(BEARER_PATTERN, value);
  const credential = bearer?.[1];
  if (
    credential !== undefined &&
    credential.length > 0 &&
    !hasSetValue(secrets.lookup, credential)
  ) {
    if (secrets.values.length >= MAX_REGISTERED_SECRETS) return invalidInput();
    addSetValue(secrets.lookup, credential);
    pushValue(secrets.values, credential);
  }
}

function collectStrings(value: JsonValue, secrets: SecretCollector): void {
  if (typeof value === "string") {
    addSecret(secrets, value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (isJsonArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectStrings(value[index] as JsonValue, secrets);
    }
    return;
  }
  const keys = INTRINSICS.objectKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) return invalidInput();
    collectStrings(value[key] as JsonValue, secrets);
  }
}

function visitRegisteredSecrets(
  value: JsonValue,
  secrets: SecretCollector,
): void {
  if (value === null || typeof value !== "object") return;
  if (isJsonArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      visitRegisteredSecrets(value[index] as JsonValue, secrets);
    }
    return;
  }
  const keys = INTRINSICS.objectKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) return invalidInput();
    const child = value[key] as JsonValue;
    if (hasSetValue(SENSITIVE_KEYS, lowerCase(key))) {
      collectStrings(child, secrets);
    } else {
      visitRegisteredSecrets(child, secrets);
    }
  }
}

function collectRegisteredSecrets(value: JsonValue): readonly string[] {
  const secrets: SecretCollector = {
    lookup: new INTRINSICS.setConstructor<string>(),
    values: [],
  };
  visitRegisteredSecrets(value, secrets);
  return INTRINSICS.objectFreeze(secrets.values);
}

function containsRegisteredSecret(
  value: string,
  secrets: readonly string[],
): boolean {
  for (let index = 0; index < secrets.length; index += 1) {
    const secret = secrets[index];
    if (
      secret !== undefined &&
      secret.length > 0 &&
      INTRINSICS.reflectApply(INTRINSICS.stringIncludes, value, [secret])
    ) {
      return true;
    }
  }
  return false;
}

function isSensitiveRequestId(
  value: string,
  secrets: readonly string[],
): boolean {
  return (
    testPattern(TOKEN_PATTERN_TEST, value) ||
    containsRegisteredSecret(value, secrets)
  );
}

function safeSuccessRequestId(
  value: unknown,
  secrets: readonly string[],
): string {
  if (!isStructurallyValidRequestId(value)) return invalidInput();
  return isSensitiveRequestId(value, secrets) ? REDACTED_REQUEST_ID : value;
}

function redactTokenPatterns(value: string): string {
  INTRINSICS.objectDefineProperty(TOKEN_PATTERN, "lastIndex", { value: 0 });
  let result = "";
  let start = 0;
  let matched = false;
  try {
    while (true) {
      const match = execPattern(TOKEN_PATTERN, value);
      if (match === null) break;
      const token = match[0];
      if (
        token === undefined ||
        token.length === 0 ||
        match.index < start ||
        match.index > value.length - token.length
      ) {
        return invalidInput();
      }
      result += `${sliceText(value, start, match.index)}${REDACTED}`;
      start = match.index + token.length;
      matched = true;
    }
  } finally {
    INTRINSICS.objectDefineProperty(TOKEN_PATTERN, "lastIndex", { value: 0 });
  }
  if (!matched) return value;
  return result + sliceText(value, start);
}

function defineJsonProperty(
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

function sanitizeJsonValue(
  value: JsonValue,
  omittedKeys?: ReadonlySet<string>,
): JsonValue {
  if (typeof value === "string") {
    return toWellFormedText(redactTokenPatterns(value));
  }
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) {
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      pushValue(
        result,
        sanitizeJsonValue(value[index] as JsonValue, omittedKeys),
      );
    }
    return result;
  }
  const result: Record<string, JsonValue> = {};
  const keys = INTRINSICS.objectKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) return invalidInput();
    if (omittedKeys !== undefined && hasSetValue(omittedKeys, lowerCase(key))) {
      continue;
    }
    defineJsonProperty(
      result,
      toWellFormedText(redactTokenPatterns(key)),
      sanitizeJsonValue(value[key] as JsonValue, omittedKeys),
    );
  }
  return result;
}

function sanitizeSuccessValue(
  value: JsonValue,
  secrets: readonly string[],
): JsonValue {
  const redacted = redactSecrets(value, secrets);
  const sanitized = sanitizeJsonValue(redacted);
  return safeJsonClone(sanitized);
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let end = maximum;
  const last = charCodeAt(value, end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return sliceText(value, 0, end);
}

function sanitizeSuccessText(
  value: string,
  secrets: readonly string[],
  maximum: number,
): string {
  const redacted = redactSecrets(value, secrets);
  if (typeof redacted !== "string") return invalidInput();
  return boundedText(redactTokenPatterns(redacted), maximum);
}

function createTextContent(text: string) {
  return freezeOutputGraph([{ type: "text" as const, text }]);
}

function frozenJson(value: JsonValue): JsonValue {
  return freezeOutputGraph(value);
}

function sanitizedFailureDetails(value: JsonValue): JsonValue {
  try {
    const cloned = canonicalJsonClone(value);
    const redacted = redactSecrets(cloned);
    const sanitized = sanitizeJsonValue(redacted, FAILURE_OMITTED_KEYS);
    return frozenJson(canonicalJsonClone(sanitized));
  } catch {
    return freezeOutputGraph({});
  }
}

function sanitizedFailureMessage(value: string): string {
  const redacted = redactSecrets(value);
  const text = typeof redacted === "string" ? redacted : REDACTED;
  return toWellFormedText(
    boundedText(redactTokenPatterns(text), MAX_FAILURE_MESSAGE_LENGTH),
  );
}

function snapshotDescriptorStrings(
  value: unknown,
): readonly string[] | undefined {
  if (
    INTRINSICS.utilIsProxy(value) ||
    !INTRINSICS.arrayIsArray(value) ||
    INTRINSICS.reflectGetPrototypeOf(value) !== INTRINSICS.arrayPrototype
  ) {
    return undefined;
  }

  const descriptors: Record<string, PropertyDescriptor> =
    INTRINSICS.objectGetOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !INTRINSICS.objectHasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number" ||
    !INTRINSICS.numberIsInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_REGISTERED_SECRETS
  ) {
    return undefined;
  }

  const length = lengthDescriptor.value;
  const descriptorKeys = INTRINSICS.reflectOwnKeys(descriptors);
  for (let keyIndex = 0; keyIndex < descriptorKeys.length; keyIndex += 1) {
    const key = descriptorKeys[keyIndex];
    if (typeof key !== "string") return undefined;
    if (key === "length") continue;
    if (!testPattern(ARRAY_INDEX_PATTERN, key)) return undefined;
    const index = INTRINSICS.numberFromValue(key);
    if (!INTRINSICS.numberIsSafeInteger(index) || index >= length) {
      return undefined;
    }
  }

  const snapshot: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[INTRINSICS.stringFromValue(index)];
    if (
      descriptor === undefined ||
      !INTRINSICS.objectHasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string"
    ) {
      return undefined;
    }
    pushValue(snapshot, descriptor.value);
  }
  return INTRINSICS.objectFreeze(snapshot);
}

function createAppErrorSnapshot(
  code: string,
  message: string,
  retryable: boolean,
  details: JsonValue,
  secrets: readonly string[],
): AppError {
  const snapshot = INTRINSICS.objectCreate(
    INTRINSICS.appErrorPrototype,
  ) as AppError;
  INTRINSICS.objectDefineProperty(snapshot, "code", {
    configurable: true,
    enumerable: true,
    value: code,
    writable: true,
  });
  INTRINSICS.objectDefineProperty(snapshot, "message", {
    configurable: true,
    enumerable: false,
    value: message,
    writable: true,
  });
  INTRINSICS.objectDefineProperty(snapshot, "retryable", {
    configurable: true,
    enumerable: true,
    value: retryable,
    writable: true,
  });
  INTRINSICS.objectDefineProperty(snapshot, "details", {
    configurable: true,
    enumerable: true,
    value: details,
    writable: true,
  });
  INTRINSICS.objectDefineProperty(snapshot, "secrets", {
    configurable: false,
    enumerable: false,
    value: secrets,
    writable: false,
  });
  return snapshot;
}

type InspectedAppError = Readonly<{
  error: AppError | undefined;
  secrets: readonly string[] | undefined;
}>;

const SAFE_NON_APP_ERROR = INTRINSICS.objectFreeze<InspectedAppError>({
  error: undefined,
  secrets: INTRINSICS.objectFreeze([]),
});
const UNSAFE_ERROR = INTRINSICS.objectFreeze<InspectedAppError>({
  error: undefined,
  secrets: undefined,
});

type PrototypeInspection = "app-error" | "not-app-error" | "unsafe";

function inspectAppErrorPrototype(value: object): PrototypeInspection {
  let current: object | null = value;
  while (current !== null) {
    if (INTRINSICS.utilIsProxy(current)) return "unsafe";
    const prototype = INTRINSICS.reflectGetPrototypeOf(current);
    if (prototype === INTRINSICS.appErrorPrototype) return "app-error";
    current = prototype;
  }
  return "not-app-error";
}

function inspectAppError(error: unknown): InspectedAppError {
  try {
    if (
      (typeof error !== "object" || error === null) &&
      typeof error !== "function"
    ) {
      return SAFE_NON_APP_ERROR;
    }

    const prototype = inspectAppErrorPrototype(error);
    if (prototype === "not-app-error") return SAFE_NON_APP_ERROR;
    if (prototype === "unsafe") return UNSAFE_ERROR;

    const descriptors = INTRINSICS.objectGetOwnPropertyDescriptors(
      error,
    ) as Record<string, PropertyDescriptor>;
    const codeDescriptor = descriptors.code;
    const detailsDescriptor = descriptors.details;
    const messageDescriptor = descriptors.message;
    const retryableDescriptor = descriptors.retryable;
    const secretsDescriptor = descriptors.secrets;
    if (
      codeDescriptor === undefined ||
      detailsDescriptor === undefined ||
      messageDescriptor === undefined ||
      retryableDescriptor === undefined ||
      secretsDescriptor === undefined ||
      !INTRINSICS.objectHasOwn(codeDescriptor, "value") ||
      !INTRINSICS.objectHasOwn(messageDescriptor, "value") ||
      !INTRINSICS.objectHasOwn(retryableDescriptor, "value") ||
      !INTRINSICS.objectHasOwn(secretsDescriptor, "value") ||
      typeof codeDescriptor.value !== "string" ||
      typeof messageDescriptor.value !== "string" ||
      typeof retryableDescriptor.value !== "boolean"
    ) {
      return UNSAFE_ERROR;
    }

    const secrets = snapshotDescriptorStrings(secretsDescriptor.value);
    if (secrets === undefined) return UNSAFE_ERROR;

    let details: JsonValue = INTRINSICS.objectFreeze({});
    if (INTRINSICS.objectHasOwn(detailsDescriptor, "value")) {
      try {
        details = canonicalJsonClone(detailsDescriptor.value);
      } catch {
        details = INTRINSICS.objectFreeze({});
      }
    }

    return INTRINSICS.objectFreeze({
      error: createAppErrorSnapshot(
        codeDescriptor.value,
        messageDescriptor.value,
        retryableDescriptor.value,
        details,
        secrets,
      ),
      secrets,
    });
  } catch {
    return UNSAFE_ERROR;
  }
}

function safeFailureRequestId(
  value: unknown,
  secrets: readonly string[] | undefined,
): string {
  if (!isStructurallyValidRequestId(value)) return INVALID_REQUEST_ID;
  if (secrets === undefined || isSensitiveRequestId(value, secrets)) {
    return REDACTED_REQUEST_ID;
  }
  return value;
}

function createFailureResult(
  code: AppErrorCode,
  message: string,
  retryable: boolean,
  details: JsonValue,
  requestId: string,
): CallToolResult {
  const error = freezeOutputGraph({
    code,
    message,
    retryable,
    details,
  });
  const structuredContent = freezeOutputGraph({
    schema_version: "1",
    ok: false,
    request_id: requestId,
    error,
  });
  const text = boundedText(`${code}: ${message}`, MAX_FAILURE_TEXT_LENGTH);
  const result: CallToolResult = {
    isError: true,
    content: createTextContent(text),
    structuredContent,
  };
  return freezeOutputGraph(result);
}

const TOTAL_FAILURE_RESULT = createFailureResult(
  "INTERNAL_ERROR",
  "An unexpected internal error occurred",
  false,
  freezeOutputGraph({}),
  INVALID_REQUEST_ID,
);

export function toolSuccess<T extends Readonly<Record<string, unknown>>>(
  data: T,
  options: ResultOptions,
): CallToolResult {
  const clonedData = safeJsonObject(data);
  const clonedOptions = safeJsonObject(options);
  if (
    !hasExactKeys(clonedOptions, SUCCESS_OPTION_KEYS, ["requestId", "summary"])
  ) {
    return invalidInput();
  }

  const summary = validateSummary(clonedOptions.summary);
  const warnings = validateWarnings(clonedOptions.warnings);
  const rateLimit = validateRateLimit(clonedOptions.rateLimit);
  const nextCursor = validateCursor(clonedOptions.nextCursor);
  const registeredSecrets = collectRegisteredSecrets(clonedData);
  const requestId = safeSuccessRequestId(
    clonedOptions.requestId,
    registeredSecrets,
  );

  const sanitizedData = frozenJson(
    sanitizeSuccessValue(clonedData, registeredSecrets),
  );
  if (!isJsonObject(sanitizedData)) return invalidInput();
  const sanitizedWarnings: string[] = [];
  for (let index = 0; index < warnings.length; index += 1) {
    pushValue(
      sanitizedWarnings,
      sanitizeSuccessText(
        warnings[index] as string,
        registeredSecrets,
        MAX_WARNING_LENGTH,
      ),
    );
  }
  freezeOutputGraph(sanitizedWarnings);
  const sanitizedRateLimit =
    rateLimit === null
      ? null
      : freezeOutputGraph({
          remaining: rateLimit.remaining,
          resetAt: rateLimit.resetAt,
        });
  const sanitizedCursor =
    nextCursor === null
      ? null
      : sanitizeSuccessText(nextCursor, registeredSecrets, MAX_CURSOR_LENGTH);
  const sanitizedSummary = sanitizeSuccessText(
    summary,
    registeredSecrets,
    MAX_SUMMARY_LENGTH,
  );

  const structuredContent = freezeOutputGraph({
    schema_version: "1",
    ok: true,
    request_id: requestId,
    data: sanitizedData,
    warnings: sanitizedWarnings,
    rate_limit: sanitizedRateLimit,
    next_cursor: sanitizedCursor,
  });
  const result: CallToolResult = {
    content: createTextContent(sanitizedSummary),
    structuredContent,
  };
  return freezeOutputGraph(result);
}

export function toolFailure(error: unknown, requestId: string): CallToolResult {
  try {
    const inspected = inspectAppError(error);
    const serialized = serializeError(inspected.error);
    return createFailureResult(
      serialized.code,
      sanitizedFailureMessage(serialized.message),
      serialized.retryable,
      sanitizedFailureDetails(serialized.details),
      safeFailureRequestId(requestId, inspected.secrets),
    );
  } catch {
    return TOTAL_FAILURE_RESULT;
  }
}
