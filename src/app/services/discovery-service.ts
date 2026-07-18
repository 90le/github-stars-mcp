import type {
  GitHubDiscoveryReadPort,
  GitHubSearchPage,
  RateLimitState,
} from "../ports/github-port.js";
import type {
  DiscoveryCandidateStorage,
  StoragePort,
} from "../ports/storage-port.js";
import { canonicalJsonClone } from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import type { JsonValue } from "../../domain/json.js";
import {
  repositorySchema,
  type AccountBinding,
  type Repository,
} from "../../domain/repository.js";
import { parseSnapshot, type Snapshot } from "../../domain/snapshot.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";
import type { EvidenceRecord } from "./evidence-service.js";
import { copyQueryBinding, type EvidenceReader } from "./query-service.js";

export type DiscoveryStoragePort = Pick<
  StoragePort,
  "getLatestCompleteSnapshot" | "hasStar"
> &
  Pick<DiscoveryCandidateStorage, "saveDiscoveredCandidate">;

export type DiscoveryQualifiers = Readonly<{
  language?: string;
  topic?: readonly string[];
  user?: string;
  org?: string;
  stars?: string;
  pushed?: string;
  archived?: boolean;
  fork?: boolean;
}>;

export type DiscoveryInput = Readonly<{
  query: string;
  qualifiers: DiscoveryQualifiers;
  sort: "stars" | "forks" | "help-wanted-issues" | "updated" | null;
  order: "asc" | "desc";
  limit: number;
  cursor: string | null;
  evidence: "none" | "summary" | "readme";
  evidenceLimit: number;
}>;

export type DiscoveryItem = Readonly<{
  repository: Repository;
  alreadyStarred: boolean;
}>;

export type DiscoveryResult = Readonly<{
  items: readonly DiscoveryItem[];
  evidence: readonly EvidenceRecord[];
  reportedTotal: number;
  cappedTotal: number;
  incompleteResults: boolean;
  nextCursor: string | null;
  rateLimit: RateLimitState | null;
}>;

const INPUT_KEYS = new Set([
  "query",
  "qualifiers",
  "sort",
  "order",
  "limit",
  "cursor",
  "evidence",
  "evidenceLimit",
]);
const QUALIFIER_KEYS = new Set([
  "language",
  "topic",
  "user",
  "org",
  "stars",
  "pushed",
  "archived",
  "fork",
]);
const SEARCH_PAGE_KEYS = new Set([
  "items",
  "totalCount",
  "incompleteResults",
  "nextPage",
  "rateLimit",
]);
const RATE_LIMIT_KEYS = new Set(["remaining", "resetAt"]);
const SORT_VALUES = new Set([
  "stars",
  "forks",
  "help-wanted-issues",
  "updated",
]);
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const TOPIC = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/u;
const PLAIN_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9.+#-]{0,99}$/u;
const QUALIFIER_INJECTION = /(?:^|\s)-?[A-Za-z][A-Za-z0-9-]*:/u;
const EMPTY_EVIDENCE = Object.freeze([]) as readonly EvidenceRecord[];

type JsonObject = Readonly<Record<string, JsonValue>>;

type ParsedDiscoveryInput = Readonly<{
  query: string;
  sort: DiscoveryInput["sort"];
  order: DiscoveryInput["order"];
  limit: number;
  page: number;
  evidence: DiscoveryInput["evidence"];
  evidenceLimit: number;
}>;

function validation(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function malformedRemote(): never {
  throw new AppError(
    "GITHUB_UNAVAILABLE",
    "GitHub returned malformed Search data",
    {
      retryable: false,
      details: {
        operation: "searchRepositories",
        reason: "malformed_remote_data",
      },
    },
  );
}

function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function plainObject(input: unknown, label: string): JsonObject {
  const cloned = canonicalJsonClone(input);
  if (cloned === null || typeof cloned !== "object" || isJsonArray(cloned)) {
    return validation(`${label} must be a plain data object`);
  }
  return cloned;
}

function exactKeys(
  input: JsonObject,
  expected: ReadonlySet<string>,
  label: string,
): void {
  const keys = Object.keys(input);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    validation(`${label} contains unsupported properties`);
  }
}

function subsetKeys(
  input: JsonObject,
  expected: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(input).some((key) => !expected.has(key))) {
    validation(`${label} contains unsupported properties`);
  }
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

function controlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return false;
    }
  }
  return true;
}

function boundedText(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    !wellFormedUnicode(value) ||
    !controlFree(value)
  ) {
    return validation(`${label} is invalid`);
  }
  return value;
}

function safeInteger(text: string, label: string): number {
  if (!DECIMAL.test(text)) return validation(`${label} is invalid`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    return validation(`${label} is outside the safe integer range`);
  }
  return value;
}

function starQualifier(value: JsonValue | undefined): string {
  const text = boundedText(value, "stars qualifier", 64);
  const comparison = /^(?<operator>>=|<=|>|<)(?<value>.+)$/u.exec(text);
  if (comparison?.groups !== undefined) {
    safeInteger(comparison.groups.value!, "stars qualifier");
    return text;
  }
  const range = /^(?<start>[^.]+)\.\.(?<end>[^.]+)$/u.exec(text);
  if (range?.groups !== undefined) {
    const start = safeInteger(range.groups.start!, "stars qualifier");
    const end = safeInteger(range.groups.end!, "stars qualifier");
    if (start > end) return validation("stars range must be ascending");
    return text;
  }
  safeInteger(text, "stars qualifier");
  return text;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isoDate(value: string, label: string): string {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(value);
  if (match?.groups === undefined) return validation(`${label} is invalid`);
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const monthLengths = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) {
    return validation(`${label} is invalid`);
  }
  return value;
}

function pushedQualifier(value: JsonValue | undefined): string {
  const text = boundedText(value, "pushed qualifier", 64);
  const comparison = /^(?<operator>>=|<=|>|<)(?<date>.+)$/u.exec(text);
  if (comparison?.groups !== undefined) {
    isoDate(comparison.groups.date!, "pushed qualifier");
    return text;
  }
  const range =
    /^(?<start>\d{4}-\d{2}-\d{2})\.\.(?<end>\d{4}-\d{2}-\d{2})$/u.exec(text);
  if (range?.groups !== undefined) {
    const start = isoDate(range.groups.start!, "pushed qualifier");
    const end = isoDate(range.groups.end!, "pushed qualifier");
    if (start > end) return validation("pushed range must be ascending");
    return text;
  }
  return isoDate(text, "pushed qualifier");
}

function loginQualifier(
  value: JsonValue | undefined,
  label: "user" | "org",
): string {
  const text = boundedText(value, `${label} qualifier`, 39);
  if (!LOGIN.test(text)) return validation(`${label} qualifier is invalid`);
  return text;
}

function languageQualifier(value: JsonValue | undefined): string {
  const text = boundedText(value, "language qualifier", 100);
  if (/["\\]/u.test(text)) {
    return validation("language qualifier contains unsafe punctuation");
  }
  return PLAIN_LANGUAGE.test(text) ? text : `"${text}"`;
}

function topicQualifiers(value: JsonValue | undefined): readonly string[] {
  if (!isJsonArray(value) || value.length > 20) {
    return validation("topic qualifier must be a dense array of at most 20");
  }
  const topics = value.map((candidate) => {
    if (typeof candidate !== "string" || !TOPIC.test(candidate)) {
      return validation("topic qualifier is invalid");
    }
    return candidate;
  });
  const unique = new Set(topics);
  if (unique.size !== topics.length) {
    return validation("topic qualifiers must be unique");
  }
  return Object.freeze([...topics].sort());
}

function booleanQualifier(
  value: JsonValue | undefined,
  label: "archived" | "fork",
): boolean {
  if (typeof value !== "boolean") {
    return validation(`${label} qualifier must be Boolean`);
  }
  return value;
}

function freeQuery(value: unknown): string {
  if (typeof value !== "string") return validation("Search query is invalid");
  const query = boundedText(value, "Search query", 256);
  if (/["\\]/u.test(query)) {
    return validation("Search query contains unsafe punctuation");
  }
  if (QUALIFIER_INJECTION.test(query)) {
    return validation("Search query contains a qualifier injection");
  }
  const booleanCount = query
    .split(/\s+/u)
    .filter(
      (token) => token === "AND" || token === "OR" || token === "NOT",
    ).length;
  if (booleanCount > 5) {
    return validation("Search query contains more than five Boolean operators");
  }
  return query;
}

export function buildSearchQuery(
  input: string,
  qualifiersInput: DiscoveryQualifiers,
): string {
  const query = freeQuery(input);
  const qualifiers = plainObject(qualifiersInput, "Search qualifiers");
  subsetKeys(qualifiers, QUALIFIER_KEYS, "Search qualifiers");
  if (qualifiers.user !== undefined && qualifiers.org !== undefined) {
    return validation("user and org qualifiers cannot be combined");
  }

  const parts = [query];
  if (qualifiers.language !== undefined) {
    parts.push(`language:${languageQualifier(qualifiers.language)}`);
  }
  if (qualifiers.topic !== undefined) {
    parts.push(
      ...topicQualifiers(qualifiers.topic).map((topic) => `topic:${topic}`),
    );
  }
  if (qualifiers.user !== undefined) {
    parts.push(`user:${loginQualifier(qualifiers.user, "user")}`);
  }
  if (qualifiers.org !== undefined) {
    parts.push(`org:${loginQualifier(qualifiers.org, "org")}`);
  }
  if (qualifiers.stars !== undefined) {
    parts.push(`stars:${starQualifier(qualifiers.stars)}`);
  }
  if (qualifiers.pushed !== undefined) {
    parts.push(`pushed:${pushedQualifier(qualifiers.pushed)}`);
  }
  if (qualifiers.archived !== undefined) {
    parts.push(
      `archived:${String(booleanQualifier(qualifiers.archived, "archived"))}`,
    );
  }
  if (qualifiers.fork !== undefined) {
    parts.push(`fork:${String(booleanQualifier(qualifiers.fork, "fork"))}`);
  }

  const result = parts.join(" ");
  if (result.length > 256) {
    return validation("Final Search query exceeds 256 characters");
  }
  return result;
}

export function parseDiscoveryCursor(cursor: string | null): number {
  if (cursor === null) return 1;
  if (typeof cursor !== "string" || !/^[1-9]\d*$/u.test(cursor)) {
    return validation("Discovery cursor must be a canonical positive page");
  }
  const page = Number(cursor);
  if (!Number.isSafeInteger(page)) {
    return validation("Discovery cursor is outside the safe integer range");
  }
  return page;
}

export function validateDiscoveryBounds(input: {
  readonly limit: number;
  readonly page: number;
}): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    validation("Discovery limit must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(input.page) || input.page < 1) {
    validation("Discovery page must be a positive safe integer");
  }
  if (input.page - 1 > Math.floor(999 / input.limit)) {
    validation("Discovery offset exceeds GitHub's 1,000-result cap");
  }
}

function parseInput(input: DiscoveryInput): ParsedDiscoveryInput {
  const root = plainObject(input, "Discovery input");
  exactKeys(root, INPUT_KEYS, "Discovery input");
  const query = buildSearchQuery(
    root.query as string,
    root.qualifiers as DiscoveryQualifiers,
  );
  const page = parseDiscoveryCursor(root.cursor as string | null);
  if (
    typeof root.limit !== "number" ||
    typeof root.evidenceLimit !== "number"
  ) {
    return validation("Discovery numeric bounds are invalid");
  }
  validateDiscoveryBounds({ limit: root.limit, page });
  if (
    root.sort !== null &&
    (typeof root.sort !== "string" || !SORT_VALUES.has(root.sort))
  ) {
    return validation("Discovery sort is invalid");
  }
  if (root.order !== "asc" && root.order !== "desc") {
    return validation("Discovery order is invalid");
  }
  if (
    root.evidence !== "none" &&
    root.evidence !== "summary" &&
    root.evidence !== "readme"
  ) {
    return validation("Discovery evidence mode is invalid");
  }
  if (
    !Number.isSafeInteger(root.evidenceLimit) ||
    root.evidenceLimit < 0 ||
    root.evidenceLimit > 20
  ) {
    return validation("Discovery evidence limit must be from 0 to 20");
  }
  if (root.evidence === "none" && root.evidenceLimit !== 0) {
    return validation("Discovery evidence limit must be zero for none");
  }
  return Object.freeze({
    query,
    sort: root.sort as DiscoveryInput["sort"],
    order: root.order,
    limit: root.limit,
    page,
    evidence: root.evidence,
    evidenceLimit: root.evidenceLimit,
  });
}

function sameBinding(left: AccountBinding, right: AccountBinding): boolean {
  return (
    left.host === right.host &&
    left.login === right.login &&
    left.accountId === right.accountId
  );
}

function usableSnapshot(
  candidate: unknown,
  binding: AccountBinding,
): Snapshot | null {
  if (candidate === null) return null;
  try {
    const snapshot = parseSnapshot(canonicalJsonClone(candidate));
    return snapshot.status === "complete" &&
      sameBinding(snapshot.binding, binding)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

function copiedRateLimit(value: JsonValue): RateLimitState | null {
  if (value === null) return null;
  if (typeof value !== "object" || isJsonArray(value)) return malformedRemote();
  exactKeys(value, RATE_LIMIT_KEYS, "Search rate state");
  if (
    typeof value.remaining !== "number" ||
    !Number.isSafeInteger(value.remaining) ||
    value.remaining < 0 ||
    typeof value.resetAt !== "string"
  ) {
    return malformedRemote();
  }
  let resetAt: string;
  try {
    resetAt = canonicalUtcTimestamp(value.resetAt, "Search rate reset");
  } catch {
    return malformedRemote();
  }
  return Object.freeze({ remaining: value.remaining, resetAt });
}

function copiedRepository(value: JsonValue): Repository {
  try {
    const parsed = repositorySchema.parse(value);
    return Object.freeze({
      ...parsed,
      topics: Object.freeze([...parsed.topics]),
    });
  } catch {
    return malformedRemote();
  }
}

function copiedSearchPage(
  input: GitHubSearchPage,
  parsed: ParsedDiscoveryInput,
): GitHubSearchPage {
  const root = plainObject(input, "Search result");
  exactKeys(root, SEARCH_PAGE_KEYS, "Search result");
  if (
    !isJsonArray(root.items) ||
    root.items.length > parsed.limit ||
    typeof root.totalCount !== "number" ||
    !Number.isSafeInteger(root.totalCount) ||
    root.totalCount < root.items.length ||
    typeof root.incompleteResults !== "boolean"
  ) {
    return malformedRemote();
  }
  const items = Object.freeze(root.items.map(copiedRepository));
  const cappedTotal = Math.min(root.totalCount, 1_000);
  const expectedNext =
    parsed.page * parsed.limit < cappedTotal ? parsed.page + 1 : null;
  if (root.nextPage !== expectedNext) return malformedRemote();
  if (root.rateLimit === undefined) return malformedRemote();
  return Object.freeze({
    items,
    totalCount: root.totalCount,
    incompleteResults: root.incompleteResults,
    nextPage: expectedNext,
    rateLimit: copiedRateLimit(root.rateLimit),
  });
}

export class DiscoveryService {
  readonly #github: GitHubDiscoveryReadPort;
  readonly #storage: DiscoveryStoragePort;
  readonly #binding: AccountBinding;
  readonly #evidence: EvidenceReader;

  constructor(
    github: GitHubDiscoveryReadPort,
    storage: DiscoveryStoragePort,
    binding: AccountBinding,
    evidence: EvidenceReader,
  ) {
    this.#github = github;
    this.#storage = storage;
    this.#binding = copyQueryBinding(binding);
    this.#evidence = evidence;
  }

  async discover(
    input: DiscoveryInput,
    signal?: AbortSignal,
  ): Promise<DiscoveryResult> {
    const parsed = parseInput(input);
    const remote = copiedSearchPage(
      await this.#github.searchRepositories(
        Object.freeze({
          query: parsed.query,
          sort: parsed.sort,
          order: parsed.order,
          page: parsed.page,
          perPage: parsed.limit,
        }),
        signal,
      ),
      parsed,
    );

    const latest = usableSnapshot(
      this.#storage.getLatestCompleteSnapshot(this.#binding),
      this.#binding,
    );
    const items = Object.freeze(
      remote.items.map((repository) =>
        Object.freeze({
          repository,
          alreadyStarred:
            latest === null
              ? false
              : this.#storage.hasStar(latest.id, repository.repositoryId),
        }),
      ),
    );
    for (const repository of remote.items) {
      this.#storage.saveDiscoveredCandidate({
        binding: this.#binding,
        repository,
        query: parsed.query,
        discoveredAt: new Date().toISOString(),
      });
    }
    const evidence =
      parsed.evidence === "none"
        ? EMPTY_EVIDENCE
        : await this.#evidence.fetch(
            remote.items.slice(0, parsed.evidenceLimit),
            parsed.evidence,
            signal,
          );
    return Object.freeze({
      items,
      evidence,
      reportedTotal: remote.totalCount,
      cappedTotal: Math.min(remote.totalCount, 1_000),
      incompleteResults: remote.incompleteResults,
      nextCursor: remote.nextPage === null ? null : String(remote.nextPage),
      rateLimit: remote.rateLimit,
    });
  }
}
