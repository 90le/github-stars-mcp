import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { types as utilTypes } from "node:util";
import type { RateLimitState } from "../app/ports/github-port.js";
import {
  canonicalJsonClone,
  freezeJsonValue,
} from "../domain/canonical-json.js";
import {
  APP_ERROR_CODES,
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
const APP_ERROR_CODE_SET = new Set<string>(APP_ERROR_CODES);
const INTRINSICS = Object.freeze({
  appErrorPrototype: AppError.prototype,
  arrayIsArray: Array.isArray,
  arrayPrototype: Array.prototype,
  objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  objectHasOwn: Object.hasOwn,
  reflectApply: Reflect.apply,
  reflectGetPrototypeOf: Reflect.getPrototypeOf,
  reflectOwnKeys: Reflect.ownKeys,
  // The intrinsic is invoked only through the captured Reflect.apply.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  setHas: Set.prototype.has,
  utilIsProxy: utilTypes.isProxy,
});

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
  return Array.isArray(value);
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
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.has(key)) return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return false;
  }
  return true;
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function toWellFormedText(value: string): string {
  const fragments: string[] = [];
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }
    fragments.push(value.slice(segmentStart, index), "\ufffd");
    segmentStart = index + 1;
  }
  if (segmentStart === 0) return value;
  fragments.push(value.slice(segmentStart));
  return fragments.join("");
}

function hasControlCharacter(value: string, allowLineFeed: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
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
    value.trim() === value &&
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
    if (value.charCodeAt(index) === 0x0a) lines += 1;
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
    warnings.push(warning);
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
    !Number.isSafeInteger(remaining) ||
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

function addSecret(secrets: Set<string>, value: string): void {
  if (value.length === 0 || secrets.has(value)) return;
  if (secrets.size >= MAX_REGISTERED_SECRETS) return invalidInput();
  secrets.add(value);

  const bearer = /^Bearer[ \t]+(.+)$/iu.exec(value);
  const credential = bearer?.[1];
  if (
    credential !== undefined &&
    credential.length > 0 &&
    !secrets.has(credential)
  ) {
    if (secrets.size >= MAX_REGISTERED_SECRETS) return invalidInput();
    secrets.add(credential);
  }
}

function collectStrings(value: JsonValue, secrets: Set<string>): void {
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
  for (const key of Object.keys(value)) {
    collectStrings(value[key] as JsonValue, secrets);
  }
}

function visitRegisteredSecrets(value: JsonValue, secrets: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (isJsonArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      visitRegisteredSecrets(value[index] as JsonValue, secrets);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    const child = value[key] as JsonValue;
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      collectStrings(child, secrets);
    } else {
      visitRegisteredSecrets(child, secrets);
    }
  }
}

function collectRegisteredSecrets(value: JsonValue): readonly string[] {
  const secrets = new Set<string>();
  visitRegisteredSecrets(value, secrets);
  return [...secrets];
}

function containsRegisteredSecret(
  value: string,
  secrets: readonly string[],
): boolean {
  for (let index = 0; index < secrets.length; index += 1) {
    const secret = secrets[index];
    if (secret !== undefined && secret.length > 0 && value.includes(secret)) {
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
    TOKEN_PATTERN_TEST.test(value) || containsRegisteredSecret(value, secrets)
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
  return value.replace(TOKEN_PATTERN, REDACTED);
}

function defineJsonProperty(
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

function sanitizeJsonValue(
  value: JsonValue,
  omittedKeys?: ReadonlySet<string>,
): JsonValue {
  if (typeof value === "string") {
    return toWellFormedText(redactTokenPatterns(value));
  }
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, omittedKeys));
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    if (omittedKeys?.has(key.toLowerCase()) === true) continue;
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
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
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
  const item = Object.freeze({ type: "text" as const, text });
  const content = [item];
  Object.freeze(content);
  return content;
}

function frozenJson(value: JsonValue): JsonValue {
  return freezeJsonValue(value);
}

function sanitizedFailureDetails(value: JsonValue): JsonValue {
  try {
    const cloned = canonicalJsonClone(value);
    const redacted = redactSecrets(cloned);
    const sanitized = sanitizeJsonValue(redacted, FAILURE_OMITTED_KEYS);
    return frozenJson(canonicalJsonClone(sanitized));
  } catch {
    return Object.freeze({});
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
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_REGISTERED_SECRETS
  ) {
    return undefined;
  }

  const length = lengthDescriptor.value;
  for (const key of INTRINSICS.reflectOwnKeys(descriptors)) {
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
      descriptor === undefined ||
      !INTRINSICS.objectHasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string"
    ) {
      return undefined;
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

type InspectedAppError = Readonly<{
  error: AppError;
  secrets: readonly string[];
}>;

function hasSafeAppErrorPrototype(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    if (INTRINSICS.utilIsProxy(current)) return false;
    const prototype = INTRINSICS.reflectGetPrototypeOf(current);
    if (prototype === INTRINSICS.appErrorPrototype) return true;
    current = prototype;
  }
  return false;
}

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    typeof value === "string" &&
    INTRINSICS.reflectApply(INTRINSICS.setHas, APP_ERROR_CODE_SET, [value])
  );
}

function inspectAppError(error: unknown): InspectedAppError | undefined {
  try {
    if (
      typeof error !== "object" ||
      error === null ||
      !hasSafeAppErrorPrototype(error)
    ) {
      return undefined;
    }

    const descriptors = INTRINSICS.objectGetOwnPropertyDescriptors(error);
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
      !INTRINSICS.objectHasOwn(detailsDescriptor, "value") ||
      !INTRINSICS.objectHasOwn(messageDescriptor, "value") ||
      !INTRINSICS.objectHasOwn(retryableDescriptor, "value") ||
      !INTRINSICS.objectHasOwn(secretsDescriptor, "value") ||
      !isAppErrorCode(codeDescriptor.value) ||
      typeof messageDescriptor.value !== "string" ||
      typeof retryableDescriptor.value !== "boolean"
    ) {
      return undefined;
    }

    const details = canonicalJsonClone(detailsDescriptor.value);
    const secrets = snapshotDescriptorStrings(secretsDescriptor.value);
    if (secrets === undefined) return undefined;

    return Object.freeze({
      error: new AppError(codeDescriptor.value, messageDescriptor.value, {
        details,
        retryable: retryableDescriptor.value,
        secrets,
      }),
      secrets,
    });
  } catch {
    return undefined;
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
  const error = Object.freeze({
    code,
    message,
    retryable,
    details,
  });
  const structuredContent = Object.freeze({
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
  return Object.freeze(result);
}

const TOTAL_FAILURE_RESULT = createFailureResult(
  "INTERNAL_ERROR",
  "An unexpected internal error occurred",
  false,
  Object.freeze({}),
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
  const sanitizedWarnings = warnings.map((warning) =>
    sanitizeSuccessText(warning, registeredSecrets, MAX_WARNING_LENGTH),
  );
  Object.freeze(sanitizedWarnings);
  const sanitizedRateLimit =
    rateLimit === null ? null : Object.freeze({ ...rateLimit });
  const sanitizedCursor =
    nextCursor === null
      ? null
      : sanitizeSuccessText(nextCursor, registeredSecrets, MAX_CURSOR_LENGTH);
  const sanitizedSummary = sanitizeSuccessText(
    summary,
    registeredSecrets,
    MAX_SUMMARY_LENGTH,
  );

  const structuredContent = Object.freeze({
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
  return Object.freeze(result);
}

export function toolFailure(error: unknown, requestId: string): CallToolResult {
  try {
    const inspected = inspectAppError(error);
    const serialized = serializeError(inspected?.error);
    return createFailureResult(
      serialized.code,
      sanitizedFailureMessage(serialized.message),
      serialized.retryable,
      sanitizedFailureDetails(serialized.details),
      safeFailureRequestId(requestId, inspected?.secrets),
    );
  } catch {
    return TOTAL_FAILURE_RESULT;
  }
}
