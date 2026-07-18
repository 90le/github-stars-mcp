import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import type {
  CapabilityState,
  CreateUserListInput,
  GitHubCapabilities,
  GitHubListItem,
  GitHubPort,
  GitHubReadme,
  GitHubSearchInput,
  GitHubSearchPage,
  GitHubStar,
  GitHubUserList,
  MutationReceipt,
  Page,
  RateLimitState,
  RepositoryIdentity,
  UpdateUserListInput,
  UserListMutationResult,
} from "../app/ports/github-port.js";
import { AppError, type AppErrorCode } from "../domain/errors.js";
import type {
  RepositoryDatabaseId,
  RepositoryId,
  UserListId,
} from "../domain/ids.js";
import { repositorySchema, userListSchema } from "../domain/repository.js";
import type {
  AccountBinding,
  Repository,
  RepositoryCoordinates,
  UserList,
} from "../domain/repository.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import {
  GRAPHQL_MUTATION_OPERATIONS,
  GRAPHQL_READ_OPERATIONS,
  type GitHubTransport,
  type GraphqlMutationOperation,
  type GraphqlReadOperation,
  type GraphqlTransportError,
} from "./allowed-operations.js";
import { AmbiguousMutationError } from "./errors.js";
import {
  parseGraphqlInputCursor,
  parseGraphqlNextCursor,
  parseRestNextCursor,
  parseRestPageCursor,
} from "./pagination.js";

const MAX_PAGE_ITEMS = 100;
const MAX_GRAPHQL_ERRORS = 100;
const MAX_ERROR_MESSAGE = 16_384;
const MAX_ERROR_TYPE = 128;
const MAX_ERROR_PATH = 100;
const MAX_ERROR_PATH_TEXT = 256;
const MAX_ID = 128;
const MAX_LOGIN = 100;
const MAX_REPOSITORY_NAME = 100;
const MAX_FULL_NAME = 201;
const MAX_DESCRIPTION = 8_192;
const MAX_LANGUAGE = 100;
const MAX_TOPIC = 100;
const MAX_LICENSE = 100;
const MAX_LIST_NAME = 255;
const MAX_LIST_SLUG = 255;
const MAX_LIST_DESCRIPTION = 8_192;
const MAX_README_BYTES = 1_048_576;
const MAX_README_BASE64 = 1_500_000;
const MAX_README_URL = 4_096;
const MAX_MUTATION_INPUT_NAME = 100;
const MAX_MUTATION_INPUT_DESCRIPTION = 1_024;
const MAX_MUTATION_LIST_IDS = 5_000;
const MAX_REQUEST_ID = 256;
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/u;
const README_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const README_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SEARCH_INPUT_KEYS = new Set([
  "query",
  "sort",
  "order",
  "page",
  "perPage",
]);
const SEARCH_SORTS = new Set([
  "stars",
  "forks",
  "help-wanted-issues",
  "updated",
]);

type SafeRecord = ReadonlyMap<string, unknown>;

const SECONDARY_RATE_TYPES = Object.freeze([
  "SECONDARY_RATE_LIMITED",
  "ABUSE_DETECTED",
] as const);
const PRIMARY_RATE_TYPES = Object.freeze(["RATE_LIMITED"] as const);
const TRANSIENT_TYPES = Object.freeze([
  "INTERNAL",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
] as const);
const SCHEMA_UNAVAILABLE_TYPES = Object.freeze([
  "undefinedField",
  "undefinedType",
] as const);

function malformedRemote(operation: string): AppError {
  return new AppError(
    "GITHUB_UNAVAILABLE",
    "GitHub returned malformed remote data",
    {
      retryable: false,
      details: { operation, reason: "malformed_remote_data" },
    },
  );
}

function isMalformedMutationResponse(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== "GITHUB_UNAVAILABLE") {
    return false;
  }
  let details: unknown;
  try {
    details = Object.getOwnPropertyDescriptor(error, "details")?.value;
  } catch {
    return false;
  }
  return (
    details !== null &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    Object.getOwnPropertyDescriptor(details, "reason")?.value ===
      "malformed_remote_data"
  );
}

function parseDispatchedMutationResult<T>(
  operation: "star" | "unstar" | GraphqlMutationOperation,
  operationId: string,
  parse: () => T,
): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AppError && !isMalformedMutationResponse(error)) {
      throw error;
    }
    throw new AmbiguousMutationError(operationId, operation, error);
  }
}

function controlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return false;
    }
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

function safeRecord(value: unknown, operation: string): SafeRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw malformedRemote(operation);
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw malformedRemote(operation);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw malformedRemote(operation);
  }

  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw malformedRemote(operation);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw malformedRemote(operation);
    }
    result.set(key, descriptor.value as unknown);
  }
  return result;
}

function required(record: SafeRecord, key: string, operation: string): unknown {
  if (!record.has(key)) throw malformedRemote(operation);
  return record.get(key);
}

function exactKeys(
  record: SafeRecord,
  keys: readonly string[],
  operation: string,
): void {
  if (record.size !== keys.length || keys.some((key) => !record.has(key))) {
    throw malformedRemote(operation);
  }
}

function denseArray(
  value: unknown,
  maximum: number,
  operation: string,
): readonly unknown[] {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw malformedRemote(operation);
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value as object);
  } catch {
    throw malformedRemote(operation);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw malformedRemote(operation);
  }
  const expectedKeys = value.length + 1;
  if (keys.length !== expectedKeys) throw malformedRemote(operation);

  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw malformedRemote(operation);
    }
    result.push(descriptor.value as unknown);
  }
  return Object.freeze(result);
}

function boundedText(
  value: unknown,
  maximum: number,
  operation: string,
  options: Readonly<{
    trimEqual?: boolean;
    requireControlFree?: boolean;
  }> = {},
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    (options.trimEqual !== false && value !== value.trim()) ||
    !wellFormedUnicode(value) ||
    (options.requireControlFree !== false && !controlFree(value))
  ) {
    throw malformedRemote(operation);
  }
  return value;
}

function nullableText(
  value: unknown,
  maximum: number,
  operation: string,
): string | null {
  return value === null
    ? null
    : boundedText(value, maximum, operation, {
        trimEqual: false,
        requireControlFree: false,
      });
}

function booleanValue(value: unknown, operation: string): boolean {
  if (typeof value !== "boolean") throw malformedRemote(operation);
  return value;
}

function nonnegativeInteger(value: unknown, operation: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedRemote(operation);
  }
  return value;
}

function timestamp(value: unknown, label: string, operation: string): string {
  try {
    return canonicalUtcTimestamp(value, label);
  } catch {
    throw malformedRemote(operation);
  }
}

function nullableTimestamp(
  value: unknown,
  label: string,
  operation: string,
): string | null {
  return value === null ? null : timestamp(value, label, operation);
}

function fixedRepositoryUrl(
  value: unknown,
  owner: string,
  name: string,
  operation: string,
): string {
  const text = boundedText(value, 2_048, operation);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw malformedRemote(operation);
  }
  const expected = `https://github.com/${owner}/${name}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== expected ||
    text !== expected
  ) {
    throw malformedRemote(operation);
  }
  return text;
}

function frozenRepository(
  candidate: Readonly<Record<string, unknown>>,
  operation: string,
): Repository {
  try {
    const parsed = repositorySchema.parse(candidate);
    const topics = Object.freeze([...parsed.topics]);
    return Object.freeze({ ...parsed, topics });
  } catch {
    throw malformedRemote(operation);
  }
}

function restTopics(value: unknown, operation: string): readonly string[] {
  return Object.freeze(
    denseArray(value, MAX_PAGE_ITEMS, operation).map((topic) =>
      boundedText(topic, MAX_TOPIC, operation),
    ),
  );
}

function restLicense(value: unknown, operation: string): string | null {
  if (value === null) return null;
  const license = safeRecord(value, operation);
  const spdxId = required(license, "spdx_id", operation);
  return spdxId === null ? null : boundedText(spdxId, MAX_LICENSE, operation);
}

function normalizeRestRepository(
  value: unknown,
  operation: string,
): Repository {
  const repository = safeRecord(value, operation);
  const ownerRecord = safeRecord(
    required(repository, "owner", operation),
    operation,
  );
  const owner = boundedText(
    required(ownerRecord, "login", operation),
    MAX_LOGIN,
    operation,
  );
  const name = boundedText(
    required(repository, "name", operation),
    MAX_REPOSITORY_NAME,
    operation,
  );
  const fullName = boundedText(
    required(repository, "full_name", operation),
    MAX_FULL_NAME,
    operation,
  );
  if (fullName !== `${owner}/${name}`) throw malformedRemote(operation);

  const visibility = required(repository, "visibility", operation);
  if (
    visibility !== "public" &&
    visibility !== "private" &&
    visibility !== "internal"
  ) {
    throw malformedRemote(operation);
  }
  const language = required(repository, "language", operation);
  const nodeId = boundedText(
    required(repository, "node_id", operation),
    MAX_ID,
    operation,
  );
  const databaseId = nonnegativeInteger(
    required(repository, "id", operation),
    operation,
  );

  return frozenRepository(
    {
      repositoryId: nodeId,
      repositoryDatabaseId: String(databaseId),
      owner,
      name,
      fullName,
      description: nullableText(
        required(repository, "description", operation),
        MAX_DESCRIPTION,
        operation,
      ),
      url: fixedRepositoryUrl(
        required(repository, "html_url", operation),
        owner,
        name,
        operation,
      ),
      stargazerCount: nonnegativeInteger(
        required(repository, "stargazers_count", operation),
        operation,
      ),
      isFork: booleanValue(required(repository, "fork", operation), operation),
      isArchived: booleanValue(
        required(repository, "archived", operation),
        operation,
      ),
      isDisabled: booleanValue(
        required(repository, "disabled", operation),
        operation,
      ),
      isPrivate: booleanValue(
        required(repository, "private", operation),
        operation,
      ),
      visibility,
      primaryLanguage:
        language === null
          ? null
          : boundedText(language, MAX_LANGUAGE, operation),
      topics: restTopics(required(repository, "topics", operation), operation),
      licenseSpdxId: restLicense(
        required(repository, "license", operation),
        operation,
      ),
      pushedAt: nullableTimestamp(
        required(repository, "pushed_at", operation),
        "repository pushedAt",
        operation,
      ),
      updatedAt: timestamp(
        required(repository, "updated_at", operation),
        "repository updatedAt",
        operation,
      ),
    },
    operation,
  );
}

function graphqlTopics(value: unknown, operation: string): readonly string[] {
  const connection = safeRecord(value, operation);
  const nodes = denseArray(
    required(connection, "nodes", operation),
    MAX_PAGE_ITEMS,
    operation,
  );
  return Object.freeze(
    nodes.map((candidate) => {
      const node = safeRecord(candidate, operation);
      const topic = safeRecord(required(node, "topic", operation), operation);
      return boundedText(
        required(topic, "name", operation),
        MAX_TOPIC,
        operation,
      );
    }),
  );
}

function graphqlLanguage(value: unknown, operation: string): string | null {
  if (value === null) return null;
  const language = safeRecord(value, operation);
  return boundedText(
    required(language, "name", operation),
    MAX_LANGUAGE,
    operation,
  );
}

function graphqlLicense(value: unknown, operation: string): string | null {
  if (value === null) return null;
  const license = safeRecord(value, operation);
  const spdxId = required(license, "spdxId", operation);
  return spdxId === null ? null : boundedText(spdxId, MAX_LICENSE, operation);
}

function normalizeGraphqlRepository(
  value: unknown,
  operation: string,
): Repository {
  const repository = safeRecord(value, operation);
  if (required(repository, "__typename", operation) !== "Repository") {
    throw malformedRemote(operation);
  }
  const ownerRecord = safeRecord(
    required(repository, "owner", operation),
    operation,
  );
  const owner = boundedText(
    required(ownerRecord, "login", operation),
    MAX_LOGIN,
    operation,
  );
  const name = boundedText(
    required(repository, "name", operation),
    MAX_REPOSITORY_NAME,
    operation,
  );
  const fullName = boundedText(
    required(repository, "nameWithOwner", operation),
    MAX_FULL_NAME,
    operation,
  );
  if (fullName !== `${owner}/${name}`) throw malformedRemote(operation);

  const remoteVisibility = required(repository, "visibility", operation);
  const visibility =
    remoteVisibility === "PUBLIC"
      ? "public"
      : remoteVisibility === "PRIVATE"
        ? "private"
        : remoteVisibility === "INTERNAL"
          ? "internal"
          : null;
  if (visibility === null) throw malformedRemote(operation);

  return frozenRepository(
    {
      repositoryId: boundedText(
        required(repository, "id", operation),
        MAX_ID,
        operation,
      ),
      repositoryDatabaseId: String(
        nonnegativeInteger(
          required(repository, "databaseId", operation),
          operation,
        ),
      ),
      owner,
      name,
      fullName,
      description: nullableText(
        required(repository, "description", operation),
        MAX_DESCRIPTION,
        operation,
      ),
      url: fixedRepositoryUrl(
        required(repository, "url", operation),
        owner,
        name,
        operation,
      ),
      stargazerCount: nonnegativeInteger(
        required(repository, "stargazerCount", operation),
        operation,
      ),
      isFork: booleanValue(
        required(repository, "isFork", operation),
        operation,
      ),
      isArchived: booleanValue(
        required(repository, "isArchived", operation),
        operation,
      ),
      isDisabled: booleanValue(
        required(repository, "isDisabled", operation),
        operation,
      ),
      isPrivate: booleanValue(
        required(repository, "isPrivate", operation),
        operation,
      ),
      visibility,
      primaryLanguage: graphqlLanguage(
        required(repository, "primaryLanguage", operation),
        operation,
      ),
      topics: graphqlTopics(
        required(repository, "repositoryTopics", operation),
        operation,
      ),
      licenseSpdxId: graphqlLicense(
        required(repository, "licenseInfo", operation),
        operation,
      ),
      pushedAt: nullableTimestamp(
        required(repository, "pushedAt", operation),
        "repository pushedAt",
        operation,
      ),
      updatedAt: timestamp(
        required(repository, "updatedAt", operation),
        "repository updatedAt",
        operation,
      ),
    },
    operation,
  );
}

function normalizeUserList(value: unknown, operation: string): UserList {
  const list = safeRecord(value, operation);
  try {
    return Object.freeze(
      userListSchema.parse({
        listId: boundedText(required(list, "id", operation), MAX_ID, operation),
        name: boundedText(
          required(list, "name", operation),
          MAX_LIST_NAME,
          operation,
        ),
        slug: boundedText(
          required(list, "slug", operation),
          MAX_LIST_SLUG,
          operation,
        ),
        description: nullableText(
          required(list, "description", operation),
          MAX_LIST_DESCRIPTION,
          operation,
        ),
        isPrivate: booleanValue(
          required(list, "isPrivate", operation),
          operation,
        ),
        createdAt: timestamp(
          required(list, "createdAt", operation),
          "List createdAt",
          operation,
        ),
        updatedAt: timestamp(
          required(list, "updatedAt", operation),
          "List updatedAt",
          operation,
        ),
        lastAddedAt: nullableTimestamp(
          required(list, "lastAddedAt", operation),
          "List lastAddedAt",
          operation,
        ),
      }),
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "GITHUB_UNAVAILABLE") {
      throw error;
    }
    throw malformedRemote(operation);
  }
}

function safeHeaders(value: unknown, operation: string): SafeRecord {
  const headers = safeRecord(value, operation);
  const normalized = new Map<string, unknown>();
  for (const [name, headerValue] of headers) {
    if (
      name.length === 0 ||
      !controlFree(name) ||
      !wellFormedUnicode(name) ||
      (headerValue !== undefined && typeof headerValue !== "string")
    ) {
      throw malformedRemote(operation);
    }
    const lowerName = name.toLowerCase();
    if (normalized.has(lowerName)) throw malformedRemote(operation);
    normalized.set(lowerName, headerValue);
  }
  return normalized;
}

function restRateLimit(
  headers: SafeRecord,
  operation: string,
): RateLimitState | null {
  const remainingValue = headers.get("x-ratelimit-remaining");
  const resetValue = headers.get("x-ratelimit-reset");
  if (remainingValue === undefined && resetValue === undefined) return null;
  if (
    typeof remainingValue !== "string" ||
    !/^(0|[1-9]\d*)$/u.test(remainingValue) ||
    typeof resetValue !== "string" ||
    !/^(0|[1-9]\d*)$/u.test(resetValue)
  ) {
    throw malformedRemote(operation);
  }
  const remaining = Number(remainingValue);
  const resetSeconds = Number(resetValue);
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    !Number.isSafeInteger(resetSeconds) ||
    resetSeconds < 0 ||
    resetSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    throw malformedRemote(operation);
  }
  let resetAt: string;
  try {
    resetAt = canonicalUtcTimestamp(
      new Date(resetSeconds * 1_000).toISOString(),
      "REST rate limit reset",
    );
  } catch {
    throw malformedRemote(operation);
  }
  return Object.freeze({ remaining, resetAt });
}

function restEnvelope(
  response: unknown,
  operation: string,
): Readonly<{
  data: unknown;
  headers: SafeRecord;
}> {
  const envelope = safeRecord(response, operation);
  if (required(envelope, "status", operation) !== 200) {
    throw malformedRemote(operation);
  }
  return Object.freeze({
    data: required(envelope, "data", operation),
    headers: safeHeaders(required(envelope, "headers", operation), operation),
  });
}

function invalidRepositoryCoordinates(operation = "getReadme"): AppError {
  return new AppError(
    "VALIDATION_ERROR",
    "Repository coordinates are invalid",
    {
      retryable: false,
      details: {
        operation,
        reason: "invalid_repository_coordinates",
      },
    },
  );
}

function repositoryCoordinates(
  value: RepositoryCoordinates,
  operation = "getReadme",
): RepositoryCoordinates {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw invalidRepositoryCoordinates(operation);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalidRepositoryCoordinates(operation);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 2 ||
    keys.some((key) => key !== "owner" && key !== "name")
  ) {
    throw invalidRepositoryCoordinates(operation);
  }

  const read = (key: "owner" | "name", maximum: number): string => {
    const descriptor = descriptors[key];
    const candidate = descriptor?.value as unknown;
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > maximum ||
      candidate !== candidate.trim() ||
      !wellFormedUnicode(candidate) ||
      !controlFree(candidate) ||
      /[/\\?#]/u.test(candidate)
    ) {
      throw invalidRepositoryCoordinates(operation);
    }
    return candidate;
  };

  return Object.freeze({
    owner: read("owner", MAX_LOGIN),
    name: read("name", MAX_REPOSITORY_NAME),
  });
}

function boundaryInputError(operation: string): AppError {
  return new AppError("VALIDATION_ERROR", "GitHub operation input is invalid", {
    retryable: false,
    details: { operation, reason: "invalid_input" },
  });
}

function inputRecord(
  value: unknown,
  operation: string,
): ReadonlyMap<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw boundaryInputError(operation);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw boundaryInputError(operation);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw boundaryInputError(operation);
  }
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw boundaryInputError(operation);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw boundaryInputError(operation);
    }
    result.set(key, descriptor.value as unknown);
  }
  return result;
}

function inputText(
  value: unknown,
  maximum: number,
  operation: string,
  options: Readonly<{
    allowEmpty?: boolean;
    trimEqual?: boolean;
  }> = {},
): string {
  if (
    typeof value !== "string" ||
    (options.allowEmpty !== true && value.length === 0) ||
    value.length > maximum ||
    (options.trimEqual === true && value !== value.trim()) ||
    !controlFree(value) ||
    !wellFormedUnicode(value)
  ) {
    throw boundaryInputError(operation);
  }
  return value;
}

function stableInputId(value: unknown, operation: string): string {
  return inputText(value, MAX_ID, operation, { trimEqual: true });
}

function validatedOperationId(value: unknown, operation: string): string {
  return stableInputId(value, operation);
}

function inputDescription(value: unknown, operation: string): string | null {
  return value === null
    ? null
    : inputText(value, MAX_MUTATION_INPUT_DESCRIPTION, operation, {
        allowEmpty: true,
      });
}

function validatedCreateUserListInput(
  value: CreateUserListInput,
): CreateUserListInput {
  const operation = "createUserList";
  const input = inputRecord(value, operation);
  const keys = ["name", "description", "isPrivate"] as const;
  if (
    input.size !== keys.length ||
    keys.some((key) => !input.has(key)) ||
    typeof input.get("isPrivate") !== "boolean"
  ) {
    throw boundaryInputError(operation);
  }
  return Object.freeze({
    name: inputText(input.get("name"), MAX_MUTATION_INPUT_NAME, operation),
    description: inputDescription(input.get("description"), operation),
    isPrivate: input.get("isPrivate") as boolean,
  });
}

function validatedUpdateUserListInput(
  value: UpdateUserListInput,
): UpdateUserListInput {
  const operation = "updateUserList";
  const input = inputRecord(value, operation);
  const allowed = new Set(["name", "description", "isPrivate"]);
  if (
    input.size === 0 ||
    input.size > allowed.size ||
    [...input.keys()].some((key) => !allowed.has(key)) ||
    (input.has("isPrivate") && typeof input.get("isPrivate") !== "boolean")
  ) {
    throw boundaryInputError(operation);
  }
  const name = input.has("name")
    ? inputText(input.get("name"), MAX_MUTATION_INPUT_NAME, operation)
    : undefined;
  const description = input.has("description")
    ? inputDescription(input.get("description"), operation)
    : undefined;
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(input.has("isPrivate")
      ? { isPrivate: input.get("isPrivate") as boolean }
      : {}),
  });
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validatedListIds(
  value: readonly UserListId[],
  operation: string,
): readonly UserListId[] {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_MUTATION_LIST_IDS
  ) {
    throw boundaryInputError(operation);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value as object);
  } catch {
    throw boundaryInputError(operation);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== value.length + 1
  ) {
    throw boundaryInputError(operation);
  }
  const ids: UserListId[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw boundaryInputError(operation);
    }
    ids.push(stableInputId(descriptor.value, operation) as UserListId);
  }
  ids.sort(utf8Compare);
  return Object.freeze([...new Set(ids)]);
}

function readmeSourceUrl(
  value: unknown,
  coordinates: RepositoryCoordinates,
  operation: string,
): string {
  const text = boundedText(value, MAX_README_URL, operation);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw malformedRemote(operation);
  }
  const prefix = `/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(
    coordinates.name,
  )}/blob/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== text ||
    !url.pathname.startsWith(prefix) ||
    url.pathname.length <= prefix.length
  ) {
    throw malformedRemote(operation);
  }
  return text;
}

function readmeFromResponse(
  response: unknown,
  coordinates: RepositoryCoordinates,
): GitHubReadme {
  const operation = "getReadme";
  const envelope = restEnvelope(response, operation);
  const data = safeRecord(envelope.data, operation);
  exactKeys(
    data,
    ["encoding", "content", "html_url", "sha", "size"],
    operation,
  );
  if (required(data, "encoding", operation) !== "base64") {
    throw malformedRemote(operation);
  }
  const rawContent = required(data, "content", operation);
  if (
    typeof rawContent !== "string" ||
    rawContent.length > MAX_README_BASE64 ||
    !wellFormedUnicode(rawContent)
  ) {
    throw malformedRemote(operation);
  }
  const content = rawContent.replace(/[\r\n]/gu, "");
  if (!README_BASE64.test(content) || content.length % 4 !== 0) {
    throw malformedRemote(operation);
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(content, "base64");
  } catch {
    throw malformedRemote(operation);
  }
  if (decoded.toString("base64") !== content) {
    throw malformedRemote(operation);
  }

  const size = required(data, "size", operation);
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_README_BYTES ||
    decoded.byteLength !== size
  ) {
    throw malformedRemote(operation);
  }
  const sha = required(data, "sha", operation);
  if (typeof sha !== "string" || !README_SHA.test(sha)) {
    throw malformedRemote(operation);
  }
  return Object.freeze({
    text: decoded.toString("utf8"),
    sourceUrl: readmeSourceUrl(
      required(data, "html_url", operation),
      coordinates,
      operation,
    ),
    sha,
    byteLength: size,
  });
}

function invalidSearchInput(): AppError {
  return new AppError("VALIDATION_ERROR", "GitHub Search input is invalid", {
    retryable: false,
    details: {
      operation: "searchRepositories",
      reason: "invalid_search_input",
    },
  });
}

function searchInput(value: GitHubSearchInput): GitHubSearchInput {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw invalidSearchInput();
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalidSearchInput();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== SEARCH_INPUT_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !SEARCH_INPUT_KEYS.has(key))
  ) {
    throw invalidSearchInput();
  }
  const read = (key: keyof GitHubSearchInput): unknown => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw invalidSearchInput();
    }
    return descriptor.value as unknown;
  };
  const query = read("query");
  const sort = read("sort");
  const order = read("order");
  const page = read("page");
  const perPage = read("perPage");
  if (
    typeof query !== "string" ||
    query.length === 0 ||
    query.length > 256 ||
    query !== query.trim() ||
    !wellFormedUnicode(query) ||
    !controlFree(query) ||
    (sort !== null && (typeof sort !== "string" || !SEARCH_SORTS.has(sort))) ||
    (order !== "asc" && order !== "desc") ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    typeof perPage !== "number" ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100 ||
    page - 1 > Math.floor(999 / perPage)
  ) {
    throw invalidSearchInput();
  }
  return Object.freeze({
    query,
    sort: sort as GitHubSearchInput["sort"],
    order,
    page,
    perPage,
  });
}

function searchPageFromResponse(
  response: unknown,
  input: GitHubSearchInput,
): GitHubSearchPage {
  const operation = "searchRepositories";
  const envelope = restEnvelope(response, operation);
  const data = safeRecord(envelope.data, operation);
  exactKeys(data, ["total_count", "incomplete_results", "items"], operation);
  const totalCount = nonnegativeInteger(
    required(data, "total_count", operation),
    operation,
  );
  const incompleteResults = required(data, "incomplete_results", operation);
  if (typeof incompleteResults !== "boolean") {
    throw malformedRemote(operation);
  }
  const items = Object.freeze(
    denseArray(
      required(data, "items", operation),
      input.perPage,
      operation,
    ).map((item) => normalizeRestRepository(item, operation)),
  );
  if (items.length > totalCount) throw malformedRemote(operation);
  const cappedTotal = Math.min(totalCount, 1_000);
  const nextPage =
    input.page * input.perPage < cappedTotal ? input.page + 1 : null;
  return Object.freeze({
    items,
    totalCount,
    incompleteResults,
    nextPage,
    rateLimit: restRateLimit(envelope.headers, operation),
  });
}

function starPageFromResponse(
  response: unknown,
  operation: string,
): Page<GitHubStar> {
  const envelope = restEnvelope(response, operation);
  const items = starItems(envelope.data, MAX_PAGE_ITEMS, operation);
  return Object.freeze({
    items,
    nextCursor: parseRestNextCursor(envelope.headers.get("link")),
    rateLimit: restRateLimit(envelope.headers, operation),
    warnings: Object.freeze([]),
  });
}

function starItems(
  data: unknown,
  maximum: number,
  operation: string,
): readonly GitHubStar[] {
  return Object.freeze(
    denseArray(data, maximum, operation).map((value): GitHubStar => {
      const star = safeRecord(value, operation);
      return Object.freeze({
        repository: normalizeRestRepository(
          required(star, "repo", operation),
          operation,
        ),
        starredAt: timestamp(
          required(star, "starred_at", operation),
          "Star starredAt",
          operation,
        ),
      });
    }),
  );
}

function validateStarProbeResponse(response: unknown): void {
  const operation = "listStarredRepositories";
  const envelope = restEnvelope(response, operation);
  starItems(envelope.data, 1, operation);
  restRateLimit(envelope.headers, operation);
}

function validateGraphqlErrorPath(value: unknown, operation: string): void {
  if (value === null) return;
  const path = denseArray(value, MAX_ERROR_PATH, operation);
  for (const part of path) {
    if (typeof part === "number") {
      if (!Number.isSafeInteger(part) || part < 0) {
        throw malformedRemote(operation);
      }
      continue;
    }
    boundedText(part, MAX_ERROR_PATH_TEXT, operation, { trimEqual: false });
  }
}

function validateGraphqlErrors(
  value: unknown,
  operation: string,
): readonly GraphqlTransportError[] {
  const errors = denseArray(value, MAX_GRAPHQL_ERRORS, operation);
  return Object.freeze(
    errors.map((candidate): GraphqlTransportError => {
      const error = safeRecord(candidate, operation);
      const message = required(error, "message", operation);
      if (
        typeof message !== "string" ||
        message.length > MAX_ERROR_MESSAGE ||
        !wellFormedUnicode(message)
      ) {
        throw malformedRemote(operation);
      }
      const typeValue = required(error, "type", operation);
      const type =
        typeValue === null
          ? null
          : boundedText(typeValue, MAX_ERROR_TYPE, operation);
      const path = required(error, "path", operation);
      validateGraphqlErrorPath(path, operation);
      return Object.freeze({
        message: "",
        type,
        path: null,
      });
    }),
  );
}

function recognizedTypes(
  errors: readonly GraphqlTransportError[],
): readonly string[] {
  const present = new Set(
    errors
      .map((error) => error.type)
      .filter((type): type is string => type !== null),
  );
  const ordered = [
    "UNAUTHENTICATED",
    "FORBIDDEN",
    ...SECONDARY_RATE_TYPES,
    ...PRIMARY_RATE_TYPES,
    "NOT_FOUND",
    ...SCHEMA_UNAVAILABLE_TYPES,
    ...TRANSIENT_TYPES,
  ].filter((type) => present.has(type));
  return Object.freeze([...new Set(ordered)]);
}

function mappedGraphqlError(
  operation: GraphqlReadOperation | GraphqlMutationOperation,
  errors: readonly GraphqlTransportError[],
): AppError {
  const types = recognizedTypes(errors);
  const has = (type: string): boolean => types.includes(type);
  let code: AppErrorCode;
  let retryable = false;
  if (has("UNAUTHENTICATED")) {
    code = "AUTH_REQUIRED";
  } else if (has("FORBIDDEN")) {
    code = "INSUFFICIENT_PERMISSION";
  } else if (SECONDARY_RATE_TYPES.some(has)) {
    code = "SECONDARY_RATE_LIMITED";
    retryable = true;
  } else if (PRIMARY_RATE_TYPES.some(has)) {
    code = "RATE_LIMITED";
    retryable = true;
  } else if (has("NOT_FOUND")) {
    code = "NOT_FOUND";
  } else if (SCHEMA_UNAVAILABLE_TYPES.some(has)) {
    code = "CAPABILITY_UNAVAILABLE";
  } else {
    code = "GITHUB_UNAVAILABLE";
    retryable = TRANSIENT_TYPES.some(has);
  }
  const operationName = Object.hasOwn(GRAPHQL_READ_OPERATIONS, operation)
    ? GRAPHQL_READ_OPERATIONS[operation as GraphqlReadOperation]
    : GRAPHQL_MUTATION_OPERATIONS[operation as GraphqlMutationOperation];
  return new AppError(code, "GitHub GraphQL operation failed", {
    retryable,
    details: {
      operation: operationName,
      recognizedTypes: types,
      errorCount: errors.length,
    },
  });
}

function graphqlRateLimit(
  value: unknown,
  operation: string,
): RateLimitState | null {
  if (value === null) return null;
  const rate = safeRecord(value, operation);
  return Object.freeze({
    remaining: nonnegativeInteger(
      required(rate, "remaining", operation),
      operation,
    ),
    resetAt: timestamp(
      required(rate, "resetAt", operation),
      "GraphQL rate limit reset",
      operation,
    ),
  });
}

function graphqlData(
  response: unknown,
  operation: GraphqlReadOperation,
): Readonly<{ data: unknown; rateLimit: RateLimitState | null }> {
  const operationName = GRAPHQL_READ_OPERATIONS[operation];
  const envelope = safeRecord(response, operationName);
  if (required(envelope, "status", operationName) !== 200) {
    throw malformedRemote(operationName);
  }
  safeHeaders(required(envelope, "headers", operationName), operationName);
  const errors = validateGraphqlErrors(
    required(envelope, "errors", operationName),
    operationName,
  );
  if (errors.length > 0) throw mappedGraphqlError(operation, errors);
  return Object.freeze({
    data: required(envelope, "data", operationName),
    rateLimit: graphqlRateLimit(
      required(envelope, "rateLimit", operationName),
      operationName,
    ),
  });
}

function graphqlNextCursor(
  value: unknown,
  operation: "ViewerLists" | "UserListItems",
): string | null {
  const pageInfo = safeRecord(value, operation);
  return parseGraphqlNextCursor(
    required(pageInfo, "hasNextPage", operation),
    required(pageInfo, "endCursor", operation),
    operation,
  );
}

function viewerListsPage(
  data: unknown,
  rateLimit: RateLimitState | null,
): Page<GitHubUserList> {
  const operation = GRAPHQL_READ_OPERATIONS.listLists;
  const root = safeRecord(data, operation);
  const viewer = safeRecord(required(root, "viewer", operation), operation);
  const lists = safeRecord(required(viewer, "lists", operation), operation);
  const items = Object.freeze(
    denseArray(
      required(lists, "nodes", operation),
      MAX_PAGE_ITEMS,
      operation,
    ).map((node) => normalizeUserList(node, operation)),
  );
  return Object.freeze({
    items,
    nextCursor: graphqlNextCursor(
      required(lists, "pageInfo", operation),
      operation,
    ),
    rateLimit,
    warnings: Object.freeze([]),
  });
}

function validateViewerLists(data: unknown): void {
  viewerListsPage(data, null);
}

function invalidListId(): AppError {
  return new AppError("VALIDATION_ERROR", "GitHub User List ID is invalid", {
    retryable: false,
    details: {
      operation: "listUserListItems",
      reason: "invalid_list_id",
    },
  });
}

function validatedListId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID ||
    value !== value.trim() ||
    !controlFree(value) ||
    !wellFormedUnicode(value)
  ) {
    throw invalidListId();
  }
  return value;
}

function listNotFound(): AppError {
  return new AppError("NOT_FOUND", "GitHub User List was not found", {
    retryable: false,
    details: {
      operation: GRAPHQL_READ_OPERATIONS.listItems,
      reason: "not_found",
    },
  });
}

function normalizeGraphqlListItem(
  value: unknown,
  operation: "UserListItems",
): Readonly<{ item: GitHubListItem; warning: string | null }> {
  const member = safeRecord(value, operation);
  const typename = boundedText(
    required(member, "__typename", operation),
    MAX_ERROR_TYPE,
    operation,
  );
  if (!GRAPHQL_NAME.test(typename)) throw malformedRemote(operation);

  if (typename === "Repository") {
    return Object.freeze({
      item: Object.freeze({
        kind: "repository",
        repository: normalizeGraphqlRepository(value, operation),
      }),
      warning: null,
    });
  }

  const rawId = member.has("id") ? member.get("id") : null;
  const itemId = rawId === null ? null : boundedText(rawId, MAX_ID, operation);
  return Object.freeze({
    item: Object.freeze({
      kind: "unsupported",
      typename,
      itemId,
    }),
    warning: `UserListItems returned unsupported union member ${typename}`,
  });
}

function userListItemsPage(
  data: unknown,
  rateLimit: RateLimitState | null,
): Page<GitHubListItem> {
  const operation = GRAPHQL_READ_OPERATIONS.listItems;
  const root = safeRecord(data, operation);
  const rawNode = required(root, "node", operation);
  if (rawNode === null) throw listNotFound();
  const node = safeRecord(rawNode, operation);
  if (
    !node.has("items") ||
    (node.has("__typename") && node.get("__typename") !== "UserList")
  ) {
    throw listNotFound();
  }
  const connection = safeRecord(required(node, "items", operation), operation);
  const members = denseArray(
    required(connection, "nodes", operation),
    MAX_PAGE_ITEMS,
    operation,
  ).map((candidate) => normalizeGraphqlListItem(candidate, operation));
  const items = Object.freeze(members.map(({ item }) => item));
  const warnings = Object.freeze(
    members.flatMap(({ warning }) => (warning === null ? [] : [warning])),
  );
  return Object.freeze({
    items,
    nextCursor: graphqlNextCursor(
      required(connection, "pageInfo", operation),
      operation,
    ),
    rateLimit,
    warnings,
  });
}

function responseEnvelope(
  response: unknown,
  operation: string,
): Readonly<{
  data: unknown;
  status: number;
  headers: SafeRecord;
}> {
  const envelope = safeRecord(response, operation);
  const status = required(envelope, "status", operation);
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    throw malformedRemote(operation);
  }
  return Object.freeze({
    data: required(envelope, "data", operation),
    status,
    headers: safeHeaders(required(envelope, "headers", operation), operation),
  });
}

function requestIdFromHeaders(
  headers: SafeRecord,
  operation: string,
): string | null {
  const value = headers.get("x-github-request-id");
  if (value === undefined) return null;
  if (typeof value !== "string" || value.includes(",")) {
    throw malformedRemote(operation);
  }
  return boundedText(value, MAX_REQUEST_ID, operation, {
    trimEqual: false,
  });
}

function restMutationReceipt(
  response: unknown,
  operation: "star" | "unstar",
): MutationReceipt {
  const envelope = responseEnvelope(response, operation);
  if (envelope.status !== 204) throw malformedRemote(operation);
  return Object.freeze({
    requestId: requestIdFromHeaders(envelope.headers, operation),
    clientMutationId: null,
  });
}

function graphqlMutationData(
  response: unknown,
  operation: GraphqlMutationOperation,
): Readonly<{ data: unknown; headers: SafeRecord }> {
  const operationName = GRAPHQL_MUTATION_OPERATIONS[operation];
  const envelope = safeRecord(response, operationName);
  if (required(envelope, "status", operationName) !== 200) {
    throw malformedRemote(operationName);
  }
  const headers = safeHeaders(
    required(envelope, "headers", operationName),
    operationName,
  );
  const errors = validateGraphqlErrors(
    required(envelope, "errors", operationName),
    operationName,
  );
  if (errors.length > 0) throw mappedGraphqlError(operation, errors);
  graphqlRateLimit(
    required(envelope, "rateLimit", operationName),
    operationName,
  );
  return Object.freeze({
    data: required(envelope, "data", operationName),
    headers,
  });
}

function mutationReceipt(
  headers: SafeRecord,
  operation: GraphqlMutationOperation,
  operationId: string,
): MutationReceipt {
  return Object.freeze({
    requestId: requestIdFromHeaders(
      headers,
      GRAPHQL_MUTATION_OPERATIONS[operation],
    ),
    clientMutationId: operationId,
  });
}

function validateEchoedClientMutationId(
  payload: SafeRecord,
  operation: GraphqlMutationOperation,
  operationId: string,
): void {
  const operationName = GRAPHQL_MUTATION_OPERATIONS[operation];
  const echoed = boundedText(
    required(payload, "clientMutationId", operationName),
    MAX_ID,
    operationName,
  );
  if (echoed !== operationId) throw malformedRemote(operationName);
}

function userListMutationResult(
  response: unknown,
  operation: "createUserList" | "updateUserList",
  operationId: string,
  expectedListId: UserListId | null,
): UserListMutationResult {
  const operationName = GRAPHQL_MUTATION_OPERATIONS[operation];
  const envelope = graphqlMutationData(response, operation);
  const root = safeRecord(envelope.data, operationName);
  const payload = safeRecord(
    required(root, operation, operationName),
    operationName,
  );
  exactKeys(payload, ["list", "clientMutationId"], operationName);
  validateEchoedClientMutationId(payload, operation, operationId);
  const list = normalizeUserList(
    required(payload, "list", operationName),
    operationName,
  );
  if (expectedListId !== null && list.listId !== expectedListId) {
    throw malformedRemote(operationName);
  }
  return Object.freeze({
    list,
    receipt: mutationReceipt(envelope.headers, operation, operationId),
  });
}

function deleteUserListReceipt(
  response: unknown,
  operationId: string,
): MutationReceipt {
  const operation = "deleteUserList";
  const operationName = GRAPHQL_MUTATION_OPERATIONS[operation];
  const envelope = graphqlMutationData(response, operation);
  const root = safeRecord(envelope.data, operationName);
  const payload = safeRecord(
    required(root, operation, operationName),
    operationName,
  );
  exactKeys(payload, ["clientMutationId"], operationName);
  validateEchoedClientMutationId(payload, operation, operationId);
  return mutationReceipt(envelope.headers, operation, operationId);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function membershipMutationReceipt(
  response: unknown,
  repositoryId: RepositoryId,
  listIds: readonly UserListId[],
  operationId: string,
): MutationReceipt {
  const operation = "setRepositoryListIds";
  const operationName = GRAPHQL_MUTATION_OPERATIONS[operation];
  const envelope = graphqlMutationData(response, operation);
  const root = safeRecord(envelope.data, operationName);
  const payload = safeRecord(
    required(root, "updateUserListsForItem", operationName),
    operationName,
  );
  exactKeys(payload, ["item", "lists", "clientMutationId"], operationName);
  validateEchoedClientMutationId(payload, operation, operationId);
  const item = safeRecord(
    required(payload, "item", operationName),
    operationName,
  );
  exactKeys(item, ["__typename", "id"], operationName);
  if (
    required(item, "__typename", operationName) !== "Repository" ||
    boundedText(required(item, "id", operationName), MAX_ID, operationName) !==
      repositoryId
  ) {
    throw malformedRemote(operationName);
  }
  const returnedIds = denseArray(
    required(payload, "lists", operationName),
    MAX_MUTATION_LIST_IDS,
    operationName,
  ).map((candidate) => {
    const list = safeRecord(candidate, operationName);
    exactKeys(list, ["id"], operationName);
    return boundedText(
      required(list, "id", operationName),
      MAX_ID,
      operationName,
    );
  });
  const sortedUnique = [...new Set(returnedIds)].sort(utf8Compare);
  if (
    sortedUnique.length !== returnedIds.length ||
    !sameIds(sortedUnique, listIds)
  ) {
    throw malformedRemote(operationName);
  }
  return mutationReceipt(envelope.headers, operation, operationId);
}

function liveReadCancelled(operation: string): AppError {
  return new AppError("GITHUB_UNAVAILABLE", "GitHub request was cancelled", {
    retryable: false,
    details: { operation, reason: "cancelled" },
  });
}

function assertLiveReadNotAborted(
  signal: AbortSignal | undefined,
  operation: string,
): void {
  if (signal === undefined) return;
  try {
    if (!signal.aborted) return;
  } catch {
    throw liveReadCancelled(operation);
  }
  throw liveReadCancelled(operation);
}

function isCancellation(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  try {
    if (signal?.aborted === true) return true;
  } catch {
    return true;
  }
  return error instanceof DOMException && error.name === "AbortError";
}

function capabilityFromError(error: unknown): CapabilityState {
  if (!(error instanceof AppError)) return "unknown";
  return error.code === "AUTH_REQUIRED" ||
    error.code === "INSUFFICIENT_PERMISSION" ||
    error.code === "NOT_FOUND" ||
    error.code === "CAPABILITY_UNAVAILABLE"
    ? "unavailable"
    : "unknown";
}

async function probeRead(
  action: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<CapabilityState> {
  try {
    await action();
    return "available";
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    return capabilityFromError(error);
  }
}

export class OctokitGitHubAdapter implements GitHubPort {
  readonly #transport: GitHubTransport;

  constructor(transport: GitHubTransport) {
    this.#transport = transport;
  }

  async getViewer(signal?: AbortSignal): Promise<AccountBinding> {
    const response = await this.#transport.rest(
      "getViewer",
      Object.freeze({}),
      signal,
    );
    const envelope = restEnvelope(response, "getViewer");
    const viewer = safeRecord(envelope.data, "getViewer");
    return Object.freeze({
      host: "github.com",
      login: boundedText(
        required(viewer, "login", "getViewer"),
        MAX_LOGIN,
        "getViewer",
      ),
      accountId: boundedText(
        required(viewer, "node_id", "getViewer"),
        MAX_ID,
        "getViewer",
      ),
    });
  }

  async probeCapabilities(signal?: AbortSignal): Promise<GitHubCapabilities> {
    const starRead = await probeRead(async () => {
      const response = await this.#transport.rest(
        "listStars",
        Object.freeze({ page: 1, per_page: 1 }),
        signal,
      );
      validateStarProbeResponse(response);
    }, signal);
    const listRead = await probeRead(async () => {
      const response = await this.#transport.graphql(
        "listLists",
        Object.freeze({ cursor: null }),
        signal,
      );
      validateViewerLists(graphqlData(response, "listLists").data);
    }, signal);
    return Object.freeze({
      starRead,
      starWrite: "unknown",
      listRead,
      listWrite: listRead === "unavailable" ? "unavailable" : "unknown",
    });
  }

  async listStarredRepositories(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubStar>> {
    const page = parseRestPageCursor(cursor);
    const response = await this.#transport.rest(
      "listStars",
      Object.freeze({ page, per_page: 100 }),
      signal,
    );
    return starPageFromResponse(response, "listStarredRepositories");
  }

  async listUserLists(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubUserList>> {
    const validatedCursor = parseGraphqlInputCursor(cursor, "listUserLists");
    const response = await this.#transport.graphql(
      "listLists",
      Object.freeze({ cursor: validatedCursor }),
      signal,
    );
    const envelope = graphqlData(response, "listLists");
    return viewerListsPage(envelope.data, envelope.rateLimit);
  }

  async listUserListItems(
    listId: UserListId,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubListItem>> {
    const validatedId = validatedListId(listId);
    const validatedCursor = parseGraphqlInputCursor(
      cursor,
      "listUserListItems",
    );
    const response = await this.#transport.graphql(
      "listItems",
      Object.freeze({ listId: validatedId, cursor: validatedCursor }),
      signal,
    );
    const envelope = graphqlData(response, "listItems");
    return userListItemsPage(envelope.data, envelope.rateLimit);
  }

  async getRepositoryIdentity(
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ): Promise<RepositoryIdentity | null> {
    const operation = "getRepositoryIdentity";
    const coordinates = repositoryCoordinates(repository, operation);
    try {
      const response = await this.#transport.rest(
        operation,
        Object.freeze({
          owner: coordinates.owner,
          repo: coordinates.name,
        }),
        signal,
      );
      const envelope = responseEnvelope(response, operation);
      if (envelope.status === 404) return null;
      if (envelope.status !== 200) throw malformedRemote(operation);
      const data = safeRecord(envelope.data, operation);
      return Object.freeze({
        repositoryId: boundedText(
          required(data, "node_id", operation),
          MAX_ID,
          operation,
        ) as RepositoryId,
        repositoryDatabaseId: String(
          nonnegativeInteger(required(data, "id", operation), operation),
        ) as RepositoryDatabaseId,
        coordinates,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  async getUserList(
    listId: UserListId,
    signal?: AbortSignal,
  ): Promise<GitHubUserList | null> {
    const operation = "getUserList";
    const validatedId = stableInputId(listId, operation) as UserListId;
    const response = await this.#transport.graphql(
      operation,
      Object.freeze({ listId: validatedId }),
      signal,
    );
    const envelope = graphqlData(response, operation);
    const operationName = GRAPHQL_READ_OPERATIONS[operation];
    const root = safeRecord(envelope.data, operationName);
    const rawNode = required(root, "node", operationName);
    if (rawNode === null) return null;
    const node = safeRecord(rawNode, operationName);
    if (required(node, "__typename", operationName) !== "UserList") {
      throw malformedRemote(operationName);
    }
    const list = normalizeUserList(rawNode, operationName);
    if (list.listId !== validatedId) throw malformedRemote(operationName);
    return list;
  }

  async checkStar(
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const operation = "checkStar";
    const coordinates = repositoryCoordinates(repository, operation);
    try {
      const response = await this.#transport.rest(
        operation,
        Object.freeze({
          owner: coordinates.owner,
          repo: coordinates.name,
        }),
        signal,
      );
      const envelope = responseEnvelope(response, operation);
      if (envelope.status === 204) return true;
      if (envelope.status === 404) return false;
      throw malformedRemote(operation);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        return false;
      }
      throw error;
    }
  }

  async getRepositoryListIds(
    repositoryId: RepositoryId,
    signal?: AbortSignal,
  ): Promise<readonly UserListId[]> {
    const operation = "getRepositoryListIds";
    const validatedRepositoryId = stableInputId(
      repositoryId,
      operation,
    ) as RepositoryId;
    const lists: UserListId[] = [];
    const seenLists = new Set<UserListId>();
    let listCursor: string | null = null;
    do {
      assertLiveReadNotAborted(signal, operation);
      const page = await this.listUserLists(listCursor, signal);
      for (const list of page.items) {
        if (!seenLists.has(list.listId)) {
          seenLists.add(list.listId);
          lists.push(list.listId);
        }
      }
      listCursor = page.nextCursor;
    } while (listCursor !== null);

    const memberships = new Set<UserListId>();
    for (const listId of lists) {
      let itemCursor: string | null = null;
      do {
        assertLiveReadNotAborted(signal, operation);
        const page = await this.listUserListItems(listId, itemCursor, signal);
        if (
          page.items.some(
            (item) =>
              item.kind === "repository" &&
              item.repository.repositoryId === validatedRepositoryId,
          )
        ) {
          memberships.add(listId);
        }
        itemCursor = page.nextCursor;
      } while (itemCursor !== null);
    }
    return Object.freeze([...memberships].sort(utf8Compare));
  }

  async star(
    repository: RepositoryCoordinates,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const operation = "star";
    const coordinates = repositoryCoordinates(repository, operation);
    const validatedId = validatedOperationId(operationId, operation);
    const response = await this.#transport.restMutation(
      operation,
      Object.freeze({
        owner: coordinates.owner,
        repo: coordinates.name,
      }),
      validatedId,
      signal,
    );
    return parseDispatchedMutationResult(operation, validatedId, () =>
      restMutationReceipt(response, operation),
    );
  }

  async unstar(
    repository: RepositoryCoordinates,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const operation = "unstar";
    const coordinates = repositoryCoordinates(repository, operation);
    const validatedId = validatedOperationId(operationId, operation);
    const response = await this.#transport.restMutation(
      operation,
      Object.freeze({
        owner: coordinates.owner,
        repo: coordinates.name,
      }),
      validatedId,
      signal,
    );
    return parseDispatchedMutationResult(operation, validatedId, () =>
      restMutationReceipt(response, operation),
    );
  }

  async createUserList(
    input: CreateUserListInput,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<UserListMutationResult> {
    const operation = "createUserList";
    const validatedInput = validatedCreateUserListInput(input);
    const validatedId = validatedOperationId(operationId, operation);
    const response = await this.#transport.graphqlMutation(
      operation,
      Object.freeze({
        ...validatedInput,
        clientMutationId: validatedId,
      }),
      validatedId,
      signal,
    );
    return parseDispatchedMutationResult(operation, validatedId, () =>
      userListMutationResult(response, operation, validatedId, null),
    );
  }

  async updateUserList(
    listId: UserListId,
    input: UpdateUserListInput,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<UserListMutationResult> {
    const operation = "updateUserList";
    const validatedListId = stableInputId(listId, operation) as UserListId;
    const validatedInput = validatedUpdateUserListInput(input);
    const validatedId = validatedOperationId(operationId, operation);
    const response = await this.#transport.graphqlMutation(
      operation,
      Object.freeze({
        listId: validatedListId,
        ...validatedInput,
        clientMutationId: validatedId,
      }),
      validatedId,
      signal,
    );
    return parseDispatchedMutationResult(operation, validatedId, () =>
      userListMutationResult(response, operation, validatedId, validatedListId),
    );
  }

  async deleteUserList(
    listId: UserListId,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const operation = "deleteUserList";
    const validatedListId = stableInputId(listId, operation) as UserListId;
    const validatedId = validatedOperationId(operationId, operation);
    const response = await this.#transport.graphqlMutation(
      operation,
      Object.freeze({
        listId: validatedListId,
        clientMutationId: validatedId,
      }),
      validatedId,
      signal,
    );
    return parseDispatchedMutationResult(operation, validatedId, () =>
      deleteUserListReceipt(response, validatedId),
    );
  }

  async setRepositoryListIds(
    repositoryId: RepositoryId,
    listIds: readonly UserListId[],
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const operation = "setRepositoryListIds";
    const validatedRepositoryId = stableInputId(
      repositoryId,
      operation,
    ) as RepositoryId;
    const validatedIds = validatedListIds(listIds, operation);
    const validatedOperation = validatedOperationId(operationId, operation);
    const response = await this.#transport.graphqlMutation(
      operation,
      Object.freeze({
        itemId: validatedRepositoryId,
        listIds: validatedIds,
        clientMutationId: validatedOperation,
      }),
      validatedOperation,
      signal,
    );
    return parseDispatchedMutationResult(operation, validatedOperation, () =>
      membershipMutationReceipt(
        response,
        validatedRepositoryId,
        validatedIds,
        validatedOperation,
      ),
    );
  }

  async getReadme(
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ): Promise<GitHubReadme | null> {
    const coordinates = repositoryCoordinates(repository);
    try {
      const response = await this.#transport.rest(
        "getReadme",
        Object.freeze({
          owner: coordinates.owner,
          repo: coordinates.name,
        }),
        signal,
      );
      return readmeFromResponse(response, coordinates);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  async searchRepositories(
    input: GitHubSearchInput,
    signal?: AbortSignal,
  ): Promise<GitHubSearchPage> {
    const validated = searchInput(input);
    const parameters =
      validated.sort === null
        ? Object.freeze({
            q: validated.query,
            order: validated.order,
            page: validated.page,
            per_page: validated.perPage,
          })
        : Object.freeze({
            q: validated.query,
            sort: validated.sort,
            order: validated.order,
            page: validated.page,
            per_page: validated.perPage,
          });
    const response = await this.#transport.rest(
      "searchRepositories",
      parameters,
      signal,
    );
    return searchPageFromResponse(response, validated);
  }
}
