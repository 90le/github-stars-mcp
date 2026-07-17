import { setTimeout as waitFor } from "node:timers/promises";
import { types as utilTypes } from "node:util";
import { Octokit, RequestError } from "octokit";
import type { OctokitResponse } from "@octokit/types";
import type { Credential } from "../auth/credential-provider.js";
import { AppError, type AppErrorCode } from "../domain/errors.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.js";
import {
  GRAPHQL_READ_DOCUMENTS,
  REST_READ_OPERATIONS,
  type GitHubTransport,
  type GraphqlReadOperation,
  type GraphqlTransportError,
  type GraphqlTransportResponse,
  type RestReadOperation,
  type RestTransportResponse,
  type TransportHeaders,
} from "./allowed-operations.js";
import { RateGate } from "./rate-gate.js";

export interface OctokitTransportRuntime {
  fetch: typeof globalThis.fetch;
  random(): number;
  wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

const GITHUB_API_ORIGIN = "https://api.github.com" as const;
const API_VERSION = "2026-03-10" as const;
const DEFAULT_ACCEPT = "application/vnd.github+json" as const;
const STAR_ACCEPT = "application/vnd.github.star+json" as const;
const MAX_ATTEMPTS = 3;
const MAX_GRAPHQL_CURSOR_LENGTH = 4_096;
const MAX_GRAPHQL_LIST_ID_LENGTH = 128;
const MAX_GRAPHQL_ERRORS = 100;
const MAX_GRAPHQL_ERROR_MESSAGE_LENGTH = 16_384;
const MAX_GRAPHQL_ERROR_TYPE_LENGTH = 128;
const MAX_GRAPHQL_ERROR_PATH_SEGMENTS = 100;
const MAX_GRAPHQL_ERROR_PATH_STRING_LENGTH = 256;

const DEFAULT_RUNTIME: OctokitTransportRuntime = Object.freeze({
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
  random: () => Math.random(),
  async wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    await waitFor(delayMs, undefined, { signal });
  },
});

const SILENT_LOG = Object.freeze({
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
});

type BoundaryReason =
  | "malformed_envelope"
  | "origin_rejected"
  | "redirect_rejected";

class BoundaryFailure extends Error {
  readonly reason: BoundaryReason;

  constructor(reason: BoundaryReason) {
    super("GitHub request boundary rejected a response");
    this.name = "BoundaryFailure";
    this.reason = reason;
  }
}

type RetryAction =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "backoff" }>
  | Readonly<{
      kind: "primary_limit" | "secondary_limit";
      retryAt: string;
    }>;

interface ClassifiedFailure {
  readonly error: AppError;
  readonly retry: RetryAction;
  readonly rateLimit: Readonly<{
    remaining: number;
    resetAt: string;
  }> | null;
}

type FailureRateObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{
      kind: "valid";
      state: Readonly<{ remaining: number; resetAt: string }>;
    }>;

interface ExpectedRequest {
  readonly kind: "rest" | "graphql";
  readonly operation: RestReadOperation | GraphqlReadOperation;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly queryKeys: ReadonlySet<string>;
}

function safeDetails(
  reason: string,
  operation: string,
  status?: number,
): Readonly<Record<string, string | number>> {
  return status === undefined
    ? { reason, operation }
    : { reason, operation, status };
}

const ERROR_MESSAGES: Readonly<Record<AppErrorCode, string>> = Object.freeze({
  AUTH_REQUIRED: "GitHub authentication is required",
  INSUFFICIENT_PERMISSION: "GitHub permission is insufficient",
  CAPABILITY_UNAVAILABLE: "GitHub capability is unavailable",
  VALIDATION_ERROR: "GitHub rejected the request",
  NOT_FOUND: "GitHub resource was not found",
  RATE_LIMITED: "GitHub primary rate limit was reached",
  SECONDARY_RATE_LIMITED: "GitHub secondary rate limit was reached",
  GITHUB_UNAVAILABLE: "GitHub is unavailable",
  STALE_SNAPSHOT: "GitHub snapshot is stale",
  PLAN_EXPIRED: "GitHub plan expired",
  PLAN_HASH_MISMATCH: "GitHub plan hash does not match",
  PLAN_ACCOUNT_MISMATCH: "GitHub plan account does not match",
  PLAN_TOO_LARGE: "GitHub plan is too large",
  PRECONDITION_FAILED: "GitHub precondition failed",
  PARTIAL_FAILURE: "GitHub operation partially failed",
  RECONCILIATION_REQUIRED: "GitHub reconciliation is required",
  STORAGE_ERROR: "GitHub storage failed",
  INTERNAL_ERROR: "GitHub internal error",
});

function mappedError(
  code: AppErrorCode,
  retryable: boolean,
  reason: string,
  operation: string,
  status?: number,
): AppError {
  return new AppError(code, ERROR_MESSAGES[code], {
    retryable,
    details: safeDetails(reason, operation, status),
  });
}

function cancelled(operation: string): AppError {
  return new AppError("GITHUB_UNAVAILABLE", "GitHub request was cancelled", {
    retryable: false,
    details: safeDetails("cancelled", operation),
  });
}

function invalidInput(
  reason: "invalid_parameters" | "invalid_version",
  operation = "transport",
): AppError {
  return mappedError("VALIDATION_ERROR", false, reason, operation);
}

function originRejected(operation: string): AppError {
  return mappedError("GITHUB_UNAVAILABLE", false, "origin_rejected", operation);
}

function controlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return false;
  }
  return true;
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

function ownDataValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function dataEntries(
  value: unknown,
): readonly (readonly [string, unknown])[] | null {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    return null;
  }
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      if (descriptor.value !== undefined) entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function containsSecret(
  value: unknown,
  secret: string,
  visited = new Set<unknown>(),
): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    visited.has(value)
  ) {
    return false;
  }
  visited.add(value);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  for (const key of keys) {
    if (typeof key !== "string") return false;
    const nested = ownDataValue(value, key);
    if (containsSecret(nested, secret, visited)) return true;
  }
  return false;
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value)
  );
}

function copyRestParameters(
  operation: RestReadOperation,
  parameters: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const entries = dataEntries(parameters);
  if (entries === null) throw invalidInput("invalid_parameters", operation);
  const values = new Map(entries);
  const forbidden = ["baseUrl", "url", "route", "path", "method", "request"];
  if (forbidden.some((key) => values.has(key))) {
    throw originRejected(operation);
  }

  if (operation === "getViewer") {
    if (entries.length !== 0)
      throw invalidInput("invalid_parameters", operation);
    return Object.freeze({});
  }

  if (operation === "listStars") {
    if (entries.some(([key]) => key !== "page" && key !== "per_page")) {
      throw invalidInput("invalid_parameters", operation);
    }
    const page = values.get("page");
    const perPage = values.get("per_page");
    if (
      (page !== undefined && !positiveInteger(page)) ||
      (perPage !== undefined && !positiveInteger(perPage))
    ) {
      throw invalidInput("invalid_parameters", operation);
    }
    return Object.freeze({
      ...(page === undefined ? {} : { page }),
      ...(perPage === undefined ? {} : { per_page: perPage }),
    });
  }

  if (operation === "getReadme") {
    if (
      entries.length !== 2 ||
      entries.some(([key]) => key !== "owner" && key !== "repo")
    ) {
      throw invalidInput("invalid_parameters", operation);
    }
    const owner = values.get("owner");
    const repo = values.get("repo");
    if (
      typeof owner !== "string" ||
      owner.length === 0 ||
      !controlFree(owner) ||
      !wellFormedUnicode(owner) ||
      typeof repo !== "string" ||
      repo.length === 0 ||
      !controlFree(repo) ||
      !wellFormedUnicode(repo)
    ) {
      throw invalidInput("invalid_parameters", operation);
    }
    return Object.freeze({ owner, repo });
  }

  const allowed = new Set(["q", "sort", "order", "page", "per_page"]);
  if (entries.some(([key]) => !allowed.has(key))) {
    throw invalidInput("invalid_parameters", operation);
  }
  const query = values.get("q");
  const sort = values.get("sort");
  const order = values.get("order");
  const page = values.get("page");
  const perPage = values.get("per_page");
  if (
    typeof query !== "string" ||
    query.length === 0 ||
    !controlFree(query) ||
    (sort !== undefined &&
      sort !== "stars" &&
      sort !== "forks" &&
      sort !== "help-wanted-issues" &&
      sort !== "updated") ||
    (order !== undefined && order !== "asc" && order !== "desc") ||
    (page !== undefined && !positiveInteger(page)) ||
    (perPage !== undefined && !positiveInteger(perPage))
  ) {
    throw invalidInput("invalid_parameters", operation);
  }
  return Object.freeze({
    q: query,
    ...(sort === undefined ? {} : { sort }),
    ...(order === undefined ? {} : { order }),
    ...(page === undefined ? {} : { page }),
    ...(perPage === undefined ? {} : { per_page: perPage }),
  });
}

function copyGraphqlVariables(
  operation: GraphqlReadOperation,
  variables: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const entries = dataEntries(variables);
  if (entries === null) throw invalidInput("invalid_parameters", operation);
  const values = new Map(entries);
  const allowed =
    operation === "listLists"
      ? new Set(["cursor"])
      : new Set(["listId", "cursor"]);
  if (entries.some(([key]) => !allowed.has(key))) {
    throw invalidInput("invalid_parameters", operation);
  }
  const cursor = values.get("cursor");
  if (
    cursor !== undefined &&
    cursor !== null &&
    (typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > MAX_GRAPHQL_CURSOR_LENGTH ||
      !controlFree(cursor))
  ) {
    throw invalidInput("invalid_parameters", operation);
  }
  if (operation === "listLists") {
    return Object.freeze({ cursor: cursor ?? null });
  }
  const listId = values.get("listId");
  if (
    typeof listId !== "string" ||
    listId.length === 0 ||
    listId.length > MAX_GRAPHQL_LIST_ID_LENGTH ||
    !controlFree(listId)
  ) {
    throw invalidInput("invalid_parameters", operation);
  }
  return Object.freeze({ listId, cursor: cursor ?? null });
}

function isRestReadOperation(value: unknown): value is RestReadOperation {
  return (
    typeof value === "string" && Object.hasOwn(REST_READ_OPERATIONS, value)
  );
}

function isGraphqlReadOperation(value: unknown): value is GraphqlReadOperation {
  return (
    typeof value === "string" && Object.hasOwn(GRAPHQL_READ_DOCUMENTS, value)
  );
}

function expectedRestRequest(
  operation: RestReadOperation,
  parameters: Readonly<Record<string, unknown>>,
): ExpectedRequest {
  if (operation === "getViewer") {
    return {
      kind: "rest",
      operation,
      method: "GET",
      path: "/user",
      queryKeys: new Set(),
    };
  }
  if (operation === "listStars") {
    return {
      kind: "rest",
      operation,
      method: "GET",
      path: "/user/starred",
      queryKeys: new Set(["page", "per_page"]),
    };
  }
  if (operation === "getReadme") {
    return {
      kind: "rest",
      operation,
      method: "GET",
      path: `/repos/${encodeURIComponent(
        String(parameters.owner),
      )}/${encodeURIComponent(String(parameters.repo))}/readme`,
      queryKeys: new Set(),
    };
  }
  return {
    kind: "rest",
    operation,
    method: "GET",
    path: "/search/repositories",
    queryKeys: new Set(["q", "sort", "order", "page", "per_page"]),
  };
}

function inputUrl(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
  } catch {
    throw new BoundaryFailure("origin_rejected");
  }
}

function validateUrl(url: URL, expected: ExpectedRequest): void {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== GITHUB_API_ORIGIN ||
    url.pathname !== expected.path ||
    url.hash !== ""
  ) {
    throw new BoundaryFailure("origin_rejected");
  }
  for (const key of url.searchParams.keys()) {
    if (!expected.queryKeys.has(key)) {
      throw new BoundaryFailure("origin_rejected");
    }
  }
}

function guardedFetch(
  fetch: typeof globalThis.fetch,
  expected: ExpectedRequest,
): typeof globalThis.fetch {
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(inputUrl(input));
      validateUrl(url, expected);
    } catch (error) {
      if (error instanceof BoundaryFailure) throw error;
      throw new BoundaryFailure("origin_rejected");
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== expected.method) {
      throw new BoundaryFailure("origin_rejected");
    }

    const headers = new Headers(init?.headers);
    headers.set("user-agent", `${PACKAGE_NAME}/${PACKAGE_VERSION}`);
    headers.set("x-github-api-version", API_VERSION);
    headers.set(
      "accept",
      expected.operation === "listStars" ? STAR_ACCEPT : DEFAULT_ACCEPT,
    );
    const authorization = headers.get("authorization");
    if (
      authorization === null ||
      (!authorization.startsWith("token ") &&
        !authorization.startsWith("bearer "))
    ) {
      throw new BoundaryFailure("malformed_envelope");
    }

    const response = await fetch(url.href, {
      ...init,
      method: expected.method,
      headers,
      redirect: "error",
    });
    if (utilTypes.isProxy(response)) {
      throw new BoundaryFailure("malformed_envelope");
    }

    let status: number;
    let responseUrl: string;
    let redirected: boolean;
    try {
      status = response.status;
      responseUrl = response.url;
      redirected = response.redirected;
    } catch {
      throw new BoundaryFailure("malformed_envelope");
    }
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new BoundaryFailure("malformed_envelope");
    }
    if (status >= 300 && status <= 399) {
      throw new BoundaryFailure("redirect_rejected");
    }
    if (responseUrl !== "") {
      let finalUrl: URL;
      try {
        finalUrl = new URL(responseUrl);
      } catch {
        throw new BoundaryFailure("origin_rejected");
      }
      validateUrl(finalUrl, expected);
      if (finalUrl.href !== url.href || redirected) {
        throw new BoundaryFailure("redirect_rejected");
      }
    } else if (redirected) {
      throw new BoundaryFailure("redirect_rejected");
    }
    return response;
  };
}

function safeRuntimeFetch(
  runtime: OctokitTransportRuntime,
  operation: string,
): typeof globalThis.fetch {
  let fetch: unknown;
  try {
    fetch = runtime.fetch;
  } catch {
    throw mappedError("GITHUB_UNAVAILABLE", false, "invalid_fetch", operation);
  }
  if (typeof fetch !== "function") {
    throw mappedError("GITHUB_UNAVAILABLE", false, "invalid_fetch", operation);
  }
  return fetch as typeof globalThis.fetch;
}

const SENSITIVE_RESPONSE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

function normalizedHeaders(
  value: Readonly<Record<string, string | number | undefined>>,
): TransportHeaders {
  const headers: Record<string, string | undefined> = {};
  let entries: readonly [string, string | number | undefined][];
  try {
    entries = Object.entries(value);
  } catch {
    throw new BoundaryFailure("malformed_envelope");
  }
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (SENSITIVE_RESPONSE_HEADERS.has(name)) continue;
    if (
      rawValue !== undefined &&
      typeof rawValue !== "string" &&
      typeof rawValue !== "number"
    ) {
      throw new BoundaryFailure("malformed_envelope");
    }
    headers[name] = rawValue === undefined ? undefined : String(rawValue);
  }
  return Object.freeze(headers);
}

function parseEpochReset(value: string | undefined): string | null {
  if (value === undefined || !/^(0|[1-9]\d*)$/u.test(value)) return null;
  const seconds = Number(value);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(milliseconds)) {
    return null;
  }
  try {
    return canonicalUtcTimestamp(new Date(milliseconds).toISOString());
  } catch {
    return null;
  }
}

function restRateState(headers: TransportHeaders): {
  readonly remaining: number;
  readonly resetAt: string;
} | null {
  const remainingHeader = headers["x-ratelimit-remaining"];
  const resetHeader = headers["x-ratelimit-reset"];
  if (remainingHeader === undefined && resetHeader === undefined) return null;
  if (
    remainingHeader === undefined ||
    !/^(0|[1-9]\d*)$/u.test(remainingHeader)
  ) {
    throw new BoundaryFailure("malformed_envelope");
  }
  const remaining = Number(remainingHeader);
  const resetAt = parseEpochReset(resetHeader);
  if (!Number.isSafeInteger(remaining) || remaining < 0 || resetAt === null) {
    throw new BoundaryFailure("malformed_envelope");
  }
  return Object.freeze({ remaining, resetAt });
}

function restFailureRateObservation(
  headers: TransportHeaders,
): FailureRateObservation {
  if (
    headers["x-ratelimit-remaining"] === undefined &&
    headers["x-ratelimit-reset"] === undefined
  ) {
    return { kind: "absent" };
  }
  try {
    const state = restRateState(headers);
    return state === null ? { kind: "malformed" } : { kind: "valid", state };
  } catch {
    return { kind: "malformed" };
  }
}

function mergeFailureRateObservations(
  first: FailureRateObservation,
  second: FailureRateObservation,
): FailureRateObservation {
  if (first.kind === "malformed" || second.kind === "malformed") {
    return { kind: "malformed" };
  }
  if (first.kind === "absent") return second;
  if (second.kind === "absent") return first;
  return first.state.remaining === second.state.remaining &&
    first.state.resetAt === second.state.resetAt
    ? first
    : { kind: "malformed" };
}

function parseRetryAt(value: string | undefined): string | null {
  if (value === undefined) return null;
  const candidate = value.trim();
  let milliseconds: number;
  if (/^(0|[1-9]\d*)$/u.test(candidate)) {
    const seconds = Number(candidate);
    if (!Number.isSafeInteger(seconds)) return null;
    milliseconds = Date.now() + seconds * 1_000;
  } else {
    milliseconds = Date.parse(candidate);
  }
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return canonicalUtcTimestamp(new Date(milliseconds).toISOString());
  } catch {
    return null;
  }
}

function responseHasSecondarySignal(
  data: unknown,
  headers: TransportHeaders,
): boolean {
  if (headers["retry-after"] !== undefined) return true;
  const message = ownDataValue(data, "message");
  if (
    typeof message === "string" &&
    /\b(?:secondary rate|abuse)\b/iu.test(message)
  ) {
    return true;
  }
  const errors = ownDataValue(data, "errors");
  if (errors === undefined) return false;
  const values = denseArrayValues(errors, MAX_GRAPHQL_ERRORS);
  if (values === null) return false;
  for (const error of values) {
    const entries = dataEntries(error);
    if (entries === null) return false;
    const type = new Map(entries).get("type");
    if (type === "ABUSE_DETECTED" || type === "SECONDARY_RATE_LIMITED") {
      return true;
    }
  }
  return false;
}

function boundaryFailure(error: unknown): BoundaryFailure | null {
  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof BoundaryFailure) return current;
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      visited.has(current)
    ) {
      return null;
    }
    visited.add(current);
    current = ownDataValue(current, "cause");
  }
  return null;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const REDIRECT_NETWORK_CODES = new Set([
  "ERR_INVALID_REDIRECT",
  "UND_ERR_REDIRECT",
]);

function containsNetworkCode(
  error: unknown,
  codes: ReadonlySet<string>,
): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 5; depth += 1) {
    const code = ownDataValue(current, "code");
    if (typeof code === "string" && codes.has(code)) return true;
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      visited.has(current)
    ) {
      return false;
    }
    visited.add(current);
    current = ownDataValue(current, "cause");
  }
  return false;
}

function containsExactErrorMessage(error: unknown, message: string): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (ownDataValue(current, "message") === message) return true;
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      visited.has(current)
    ) {
      return false;
    }
    visited.add(current);
    current = ownDataValue(current, "cause");
  }
  return false;
}

function transientNetworkFailure(error: unknown): boolean {
  return containsNetworkCode(error, TRANSIENT_NETWORK_CODES);
}

function none(error: AppError): ClassifiedFailure {
  return { error, retry: { kind: "none" }, rateLimit: null };
}

function classifyHttpFailure(
  status: number,
  headers: TransportHeaders,
  data: unknown,
  operation: string,
): ClassifiedFailure {
  if (status === 400 || status === 422) {
    return none(
      mappedError(
        "VALIDATION_ERROR",
        false,
        "http_validation",
        operation,
        status,
      ),
    );
  }
  if (status === 401) {
    return none(
      mappedError(
        "AUTH_REQUIRED",
        false,
        "authentication_failed",
        operation,
        status,
      ),
    );
  }
  if (status === 403) {
    if (responseHasSecondarySignal(data, headers)) {
      const retryAt = parseRetryAt(headers["retry-after"]);
      return {
        error: mappedError(
          "SECONDARY_RATE_LIMITED",
          true,
          "secondary_rate_limit",
          operation,
          status,
        ),
        retry:
          retryAt === null
            ? { kind: "none" }
            : { kind: "secondary_limit", retryAt },
        rateLimit: null,
      };
    }
    if (headers["x-ratelimit-remaining"] === "0") {
      const retryAt = parseEpochReset(headers["x-ratelimit-reset"]);
      return {
        error: mappedError(
          "RATE_LIMITED",
          true,
          "primary_rate_limit",
          operation,
          status,
        ),
        retry:
          retryAt === null
            ? { kind: "none" }
            : { kind: "primary_limit", retryAt },
        rateLimit: null,
      };
    }
    return none(
      mappedError(
        "INSUFFICIENT_PERMISSION",
        false,
        "permission_denied",
        operation,
        status,
      ),
    );
  }
  if (status === 429) {
    const retryAt = parseRetryAt(headers["retry-after"]);
    if (retryAt !== null) {
      return {
        error: mappedError(
          "SECONDARY_RATE_LIMITED",
          true,
          "secondary_rate_limit",
          operation,
          status,
        ),
        retry: { kind: "secondary_limit", retryAt },
        rateLimit: null,
      };
    }
    if (headers["retry-after"] === undefined) {
      const retryAt =
        headers["x-ratelimit-remaining"] === "0"
          ? parseEpochReset(headers["x-ratelimit-reset"])
          : null;
      if (retryAt !== null) {
        return {
          error: mappedError(
            "RATE_LIMITED",
            true,
            "primary_rate_limit",
            operation,
            status,
          ),
          retry: { kind: "primary_limit", retryAt },
          rateLimit: null,
        };
      }
    }
    return none(
      mappedError(
        "RATE_LIMITED",
        true,
        "primary_rate_limit",
        operation,
        status,
      ),
    );
  }
  if (status === 404) {
    return none(
      mappedError("NOT_FOUND", false, "not_found", operation, status),
    );
  }
  if (status === 408 || (status >= 500 && status <= 599)) {
    return {
      error: mappedError(
        "GITHUB_UNAVAILABLE",
        true,
        "transient_http",
        operation,
        status,
      ),
      retry: { kind: "backoff" },
      rateLimit: null,
    };
  }
  return none(
    mappedError("GITHUB_UNAVAILABLE", false, "http_failure", operation, status),
  );
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  operation: string,
  requestKind: "rest" | "graphql",
): ClassifiedFailure {
  if (signalIsAborted(signal)) return none(cancelled(operation));
  if (error instanceof AppError) return none(error);

  const boundary = boundaryFailure(error);
  if (boundary !== null) {
    return none(
      mappedError("GITHUB_UNAVAILABLE", false, boundary.reason, operation),
    );
  }

  if (
    containsNetworkCode(error, REDIRECT_NETWORK_CODES) ||
    containsExactErrorMessage(error, "unexpected redirect")
  ) {
    return none(
      mappedError("GITHUB_UNAVAILABLE", false, "redirect_rejected", operation),
    );
  }

  if (error instanceof RequestError && error.response !== undefined) {
    let headers: TransportHeaders;
    try {
      headers = normalizedHeaders(error.response.headers);
    } catch {
      return none(
        mappedError(
          "GITHUB_UNAVAILABLE",
          false,
          "malformed_envelope",
          operation,
        ),
      );
    }
    let failure: ClassifiedFailure;
    try {
      failure = classifyHttpFailure(
        error.status,
        headers,
        error.response.data,
        operation,
      );
    } catch {
      return none(
        mappedError(
          "GITHUB_UNAVAILABLE",
          false,
          "malformed_envelope",
          operation,
        ),
      );
    }
    const observation =
      requestKind === "rest"
        ? restFailureRateObservation(headers)
        : mergeFailureRateObservations(
            graphqlFailureRateObservation(error.response.data),
            restFailureRateObservation(headers),
          );
    if (observation.kind === "malformed") {
      return none(
        mappedError(
          "GITHUB_UNAVAILABLE",
          false,
          "malformed_envelope",
          operation,
        ),
      );
    }
    return {
      ...failure,
      rateLimit: observation.kind === "valid" ? observation.state : null,
    };
  }

  if (transientNetworkFailure(error)) {
    return {
      error: mappedError(
        "GITHUB_UNAVAILABLE",
        true,
        "transient_network",
        operation,
      ),
      retry: { kind: "backoff" },
      rateLimit: null,
    };
  }
  return none(
    mappedError("GITHUB_UNAVAILABLE", false, "network_failure", operation),
  );
}

function denseArrayValues(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  const values: unknown[] = [];
  try {
    if (
      utilTypes.isProxy(value) ||
      !Array.isArray(value) ||
      Reflect.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximumLength
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key)) {
          return true;
        }
        const index = Number(key);
        return (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        );
      })
    ) {
      return null;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return null;
      values.push(descriptor.value);
    }
  } catch {
    return null;
  }
  return values;
}

function boundedGraphqlErrorPath(
  value: unknown,
): readonly (string | number)[] | null {
  if (value === undefined || value === null) return null;
  const values = denseArrayValues(value, MAX_GRAPHQL_ERROR_PATH_SEGMENTS);
  if (values === null) throw new BoundaryFailure("malformed_envelope");
  const path: (string | number)[] = [];
  for (const part of values) {
    if (typeof part === "string") {
      if (
        part.length > MAX_GRAPHQL_ERROR_PATH_STRING_LENGTH ||
        !controlFree(part)
      ) {
        throw new BoundaryFailure("malformed_envelope");
      }
      path.push(part);
      continue;
    }
    if (typeof part !== "number" || !Number.isSafeInteger(part) || part < 0) {
      throw new BoundaryFailure("malformed_envelope");
    }
    path.push(part);
  }
  return Object.freeze(path);
}

function parseGraphqlErrors(value: unknown): readonly GraphqlTransportError[] {
  if (value === undefined) return Object.freeze([]);
  const values = denseArrayValues(value, MAX_GRAPHQL_ERRORS);
  if (values === null) {
    throw new BoundaryFailure("malformed_envelope");
  }
  return Object.freeze(
    values.map((candidate) => {
      const candidateEntries = dataEntries(candidate);
      if (candidateEntries === null) {
        throw new BoundaryFailure("malformed_envelope");
      }
      const candidateValues = new Map(candidateEntries);
      const message = candidateValues.get("message");
      const directType = candidateValues.get("type");
      const extensions = candidateValues.get("extensions");
      let extensionType: unknown;
      if (extensions !== undefined && extensions !== null) {
        const extensionEntries = dataEntries(extensions);
        if (extensionEntries === null) {
          throw new BoundaryFailure("malformed_envelope");
        }
        extensionType = new Map(extensionEntries).get("code");
      }
      const rawType = directType === undefined ? extensionType : directType;
      const type = rawType === undefined ? null : rawType;
      if (
        typeof message !== "string" ||
        message.length > MAX_GRAPHQL_ERROR_MESSAGE_LENGTH ||
        (type !== null &&
          (typeof type !== "string" ||
            type.length === 0 ||
            type.length > MAX_GRAPHQL_ERROR_TYPE_LENGTH ||
            !controlFree(type)))
      ) {
        throw new BoundaryFailure("malformed_envelope");
      }
      const path = boundedGraphqlErrorPath(candidateValues.get("path"));
      return Object.freeze({
        message,
        type,
        path,
      });
    }),
  );
}

function graphqlRateState(data: unknown): {
  readonly remaining: number;
  readonly resetAt: string;
} | null {
  if (data === null) return null;
  const entries = dataEntries(data);
  if (entries === null) {
    throw new BoundaryFailure("malformed_envelope");
  }
  const value = new Map(entries).get("rateLimit");
  if (value === undefined) return null;
  if (value === null) {
    throw new BoundaryFailure("malformed_envelope");
  }
  const rateEntries = dataEntries(value);
  if (rateEntries === null) {
    throw new BoundaryFailure("malformed_envelope");
  }
  const rateValues = new Map(rateEntries);
  const remaining = rateValues.get("remaining");
  const resetAt = rateValues.get("resetAt");
  if (
    typeof remaining !== "number" ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    typeof resetAt !== "string"
  ) {
    throw new BoundaryFailure("malformed_envelope");
  }
  let canonical: string;
  try {
    canonical = canonicalUtcTimestamp(resetAt, "GraphQL rate limit reset");
  } catch {
    throw new BoundaryFailure("malformed_envelope");
  }
  return Object.freeze({ remaining, resetAt: canonical });
}

function graphqlFailureRateObservation(data: unknown): FailureRateObservation {
  if (data === null || typeof data !== "object" || utilTypes.isProxy(data)) {
    return { kind: "absent" };
  }
  let dataDescriptor: PropertyDescriptor | undefined;
  let prototype: object | null;
  try {
    dataDescriptor = Object.getOwnPropertyDescriptor(data, "data");
    prototype = Reflect.getPrototypeOf(data);
  } catch {
    return { kind: "absent" };
  }
  if (dataDescriptor === undefined) return { kind: "absent" };
  if (prototype !== Object.prototype && prototype !== null) {
    return { kind: "malformed" };
  }
  if (!("value" in dataDescriptor) || dataEntries(data) === null) {
    return { kind: "malformed" };
  }
  const bodyData = ownDataValue(data, "data");
  if (bodyData === null) return { kind: "absent" };
  const bodyEntries = dataEntries(bodyData);
  if (bodyEntries === null) return { kind: "malformed" };
  let rateDescriptor: PropertyDescriptor | undefined;
  try {
    rateDescriptor = Object.getOwnPropertyDescriptor(bodyData, "rateLimit");
  } catch {
    return { kind: "malformed" };
  }
  if (rateDescriptor === undefined) {
    return { kind: "absent" };
  }
  if (!("value" in rateDescriptor)) return { kind: "malformed" };
  try {
    const state = graphqlRateState(bodyData);
    return state === null ? { kind: "malformed" } : { kind: "valid", state };
  } catch {
    return { kind: "malformed" };
  }
}

function normalizedRestResponse<T>(
  response: OctokitResponse<unknown>,
  rateGate: RateGate,
): RestTransportResponse<T> {
  const headers = normalizedHeaders(response.headers);
  const rateLimit = restRateState(headers);
  rateGate.observe(rateLimit);
  return Object.freeze({
    data: response.data as T,
    status: response.status,
    headers,
  });
}

function normalizedGraphqlResponse<T>(
  response: OctokitResponse<unknown>,
  rateGate: RateGate,
): GraphqlTransportResponse<T> {
  if (response.status !== 200) {
    throw new BoundaryFailure("malformed_envelope");
  }
  const body = response.data;
  const bodyEntries = dataEntries(body);
  if (bodyEntries === null) {
    throw new BoundaryFailure("malformed_envelope");
  }
  const bodyValues = new Map(bodyEntries);
  const errors = parseGraphqlErrors(bodyValues.get("errors"));
  const hasData = Object.hasOwn(body as object, "data");
  const data = hasData ? ownDataValue(body, "data") : null;
  if (
    (!hasData && errors.length === 0) ||
    (hasData && data !== null && dataEntries(data) === null)
  ) {
    throw new BoundaryFailure("malformed_envelope");
  }
  const headers = normalizedHeaders(response.headers);
  const observation = mergeFailureRateObservations(
    graphqlFailureRateObservation(body),
    restFailureRateObservation(headers),
  );
  if (observation.kind === "malformed") {
    throw new BoundaryFailure("malformed_envelope");
  }
  const rateLimit = observation.kind === "valid" ? observation.state : null;
  rateGate.observe(rateLimit);
  return Object.freeze({
    data: data as T | null,
    errors,
    status: response.status,
    headers,
    rateLimit,
  });
}

function randomValue(
  runtime: OctokitTransportRuntime,
  operation: string,
): number {
  let value: number;
  try {
    value = runtime.random();
  } catch {
    throw mappedError("GITHUB_UNAVAILABLE", false, "invalid_random", operation);
  }
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw mappedError("GITHUB_UNAVAILABLE", false, "invalid_random", operation);
  }
  return value;
}

async function ordinaryBackoff(
  runtime: OctokitTransportRuntime,
  retryIndex: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<void> {
  const random = randomValue(runtime, operation);
  const delayMs =
    Math.min(250 * 2 ** retryIndex, 4_000) + Math.floor(random * 250);
  try {
    await runtime.wait(delayMs, signal);
  } catch {
    if (signalIsAborted(signal)) throw cancelled(operation);
    throw mappedError("GITHUB_UNAVAILABLE", false, "wait_failed", operation);
  }
  if (signalIsAborted(signal)) throw cancelled(operation);
}

async function executeWithRetries<T>(
  operation: string,
  requestKind: "rest" | "graphql",
  signal: AbortSignal | undefined,
  rateGate: RateGate,
  runtime: OctokitTransportRuntime,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
    await rateGate.beforeRequest(signal);
    try {
      return await attempt();
    } catch (error) {
      const failure = classifyFailure(error, signal, operation, requestKind);
      if (failure.rateLimit !== null) {
        rateGate.observe(failure.rateLimit);
      }
      if (failure.retry.kind === "primary_limit") {
        rateGate.observePrimaryLimit(failure.retry.retryAt);
      } else if (failure.retry.kind === "secondary_limit") {
        rateGate.observeSecondaryLimit(failure.retry.retryAt);
      }
      if (failure.retry.kind === "none" || attemptIndex === MAX_ATTEMPTS - 1) {
        throw failure.error;
      }
      if (failure.retry.kind === "backoff") {
        await ordinaryBackoff(runtime, attemptIndex, signal, operation);
      }
    }
  }
  throw mappedError(
    "INTERNAL_ERROR",
    false,
    "attempt_loop_exhausted",
    operation,
  );
}

export function createOctokitTransport(
  credential: Credential,
  version: string,
  rateGate: RateGate,
  runtime: OctokitTransportRuntime = DEFAULT_RUNTIME,
): GitHubTransport {
  if (
    version !== PACKAGE_VERSION ||
    !controlFree(version) ||
    !controlFree(PACKAGE_VERSION)
  ) {
    throw invalidInput("invalid_version");
  }

  let token: unknown;
  try {
    token = credential.token;
  } catch {
    throw mappedError(
      "AUTH_REQUIRED",
      false,
      "invalid_credential",
      "transport",
    );
  }
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token !== token.trim() ||
    !controlFree(token)
  ) {
    throw mappedError(
      "AUTH_REQUIRED",
      false,
      "invalid_credential",
      "transport",
    );
  }

  let client: Octokit;
  try {
    const failClosedFetch: typeof globalThis.fetch = () =>
      Promise.reject(new BoundaryFailure("origin_rejected"));
    client = new Octokit({
      auth: token,
      baseUrl: GITHUB_API_ORIGIN,
      userAgent: `${PACKAGE_NAME}/${PACKAGE_VERSION}`,
      request: { fetch: failClosedFetch, log: SILENT_LOG },
      retry: { enabled: false },
      throttle: { enabled: false },
      log: SILENT_LOG,
    });
  } catch {
    throw mappedError(
      "GITHUB_UNAVAILABLE",
      false,
      "client_initialization_failed",
      "transport",
    );
  }

  return Object.freeze({
    rest<T>(
      operation: RestReadOperation,
      parameters: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<RestTransportResponse<T>> {
      if (!isRestReadOperation(operation)) {
        return Promise.reject(invalidInput("invalid_parameters"));
      }
      let copiedParameters: Readonly<Record<string, unknown>>;
      try {
        copiedParameters = copyRestParameters(operation, parameters);
      } catch (error) {
        return Promise.reject(
          error instanceof AppError
            ? error
            : invalidInput("invalid_parameters", operation),
        );
      }
      if (containsSecret(copiedParameters, token)) {
        return Promise.reject(invalidInput("invalid_parameters", operation));
      }
      const expected = expectedRestRequest(operation, copiedParameters);
      let fetch: typeof globalThis.fetch;
      try {
        fetch = guardedFetch(safeRuntimeFetch(runtime, operation), expected);
      } catch (error) {
        return Promise.reject(
          error instanceof AppError
            ? error
            : mappedError(
                "GITHUB_UNAVAILABLE",
                false,
                "invalid_fetch",
                operation,
              ),
        );
      }
      return executeWithRetries(
        operation,
        "rest",
        signal,
        rateGate,
        runtime,
        async () => {
          const response = (await client.request(
            REST_READ_OPERATIONS[operation],
            {
              ...copiedParameters,
              request: {
                fetch,
                redirect: "error",
                ...(signal === undefined ? {} : { signal }),
              },
            },
          )) as OctokitResponse<unknown>;
          return normalizedRestResponse<T>(response, rateGate);
        },
      );
    },

    graphql<T>(
      operation: GraphqlReadOperation,
      variables: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<GraphqlTransportResponse<T>> {
      if (!isGraphqlReadOperation(operation)) {
        return Promise.reject(invalidInput("invalid_parameters"));
      }
      let copiedVariables: Readonly<Record<string, unknown>>;
      try {
        copiedVariables = copyGraphqlVariables(operation, variables);
      } catch (error) {
        return Promise.reject(
          error instanceof AppError
            ? error
            : invalidInput("invalid_parameters", operation),
        );
      }
      if (containsSecret(copiedVariables, token)) {
        return Promise.reject(invalidInput("invalid_parameters", operation));
      }
      const expected: ExpectedRequest = {
        kind: "graphql",
        operation,
        method: "POST",
        path: "/graphql",
        queryKeys: new Set(),
      };
      let fetch: typeof globalThis.fetch;
      try {
        fetch = guardedFetch(safeRuntimeFetch(runtime, operation), expected);
      } catch (error) {
        return Promise.reject(
          error instanceof AppError
            ? error
            : mappedError(
                "GITHUB_UNAVAILABLE",
                false,
                "invalid_fetch",
                operation,
              ),
        );
      }
      return executeWithRetries(
        operation,
        "graphql",
        signal,
        rateGate,
        runtime,
        async () => {
          const response = (await client.request("POST /graphql", {
            query: GRAPHQL_READ_DOCUMENTS[operation],
            variables: copiedVariables,
            request: {
              fetch,
              redirect: "error",
              ...(signal === undefined ? {} : { signal }),
            },
          })) as OctokitResponse<unknown>;
          return normalizedGraphqlResponse<T>(response, rateGate);
        },
      );
    },
  });
}
