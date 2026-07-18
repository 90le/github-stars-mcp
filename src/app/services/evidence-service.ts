import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import type {
  GitHubEvidenceReadPort,
  GitHubReadme,
} from "../ports/github-port.js";
import { canonicalJsonClone } from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import type { RepositoryId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import {
  repositorySchema,
  repositoryViewSchema,
  type Repository,
} from "../../domain/repository.js";

export type EvidenceRecord = Readonly<{
  repositoryId: RepositoryId;
  kind: "untrusted_external_text";
  text: string;
  sourceUrl: string;
  sha: string | null;
  byteLength: number;
  truncated: boolean;
  missing: boolean;
}>;

const MAX_EVIDENCE_RECORDS = 20;
const MAX_CONCURRENCY = 8;
const MAX_CHARS = 65_536;
const README_KEYS = new Set(["text", "sourceUrl", "sha", "byteLength"]);

type JsonObject = Readonly<Record<string, JsonValue>>;

function validation(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function cancelled(): never {
  throw new AppError(
    "GITHUB_UNAVAILABLE",
    "Evidence collection was cancelled",
    {
      retryable: false,
      details: { operation: "evidence", reason: "cancelled" },
    },
  );
}

function internalFailure(): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    "Evidence collection failed unexpectedly",
    { retryable: false },
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

function frozenRepository(input: unknown): Repository {
  try {
    const view = repositoryViewSchema.safeParse(input);
    let parsed: Repository;
    if (view.success) {
      const { starredAt, ...repository } = view.data;
      void starredAt;
      parsed = repository;
    } else {
      parsed = repositorySchema.parse(input);
    }
    return Object.freeze({
      ...parsed,
      topics: Object.freeze([...parsed.topics]),
    });
  } catch {
    return validation("Evidence repository is invalid");
  }
}

function repositories(input: unknown): readonly Repository[] {
  const cloned = canonicalJsonClone(input);
  if (!isJsonArray(cloned) || cloned.length > MAX_EVIDENCE_RECORDS) {
    return validation(
      "Evidence repositories must be a dense array of at most 20 items",
    );
  }
  const result = cloned.map(frozenRepository);
  const seen = new Set<string>();
  for (const repository of result) {
    if (seen.has(repository.repositoryId)) {
      return validation("Evidence repository IDs must be unique");
    }
    seen.add(repository.repositoryId);
  }
  return Object.freeze(result);
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (utilTypes.isProxy(signal)) return true;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return validation(`${label} is outside its supported bounds`);
  }
  return value;
}

function truncatedText(
  text: string,
  maximum: number,
): Readonly<{ text: string; truncated: boolean }> {
  if (text.length <= maximum) {
    return Object.freeze({ text, truncated: false });
  }
  let end = maximum;
  const finalCodeUnit = text.charCodeAt(end - 1);
  const followingCodeUnit = text.charCodeAt(end);
  if (
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    followingCodeUnit >= 0xdc00 &&
    followingCodeUnit <= 0xdfff
  ) {
    end -= 1;
  }
  return Object.freeze({ text: text.slice(0, end), truncated: true });
}

function evidenceRecord(
  repository: Repository,
  value: Readonly<{
    text: string;
    sourceUrl: string;
    sha: string | null;
    byteLength: number;
    missing: boolean;
  }>,
  maximum: number,
): EvidenceRecord {
  const bounded = truncatedText(value.text, maximum);
  return Object.freeze({
    repositoryId: repository.repositoryId,
    kind: "untrusted_external_text",
    text: bounded.text,
    sourceUrl: value.sourceUrl,
    sha: value.sha,
    byteLength: value.byteLength,
    truncated: bounded.truncated,
    missing: value.missing,
  });
}

function summaryEvidence(
  repository: Repository,
  maximum: number,
): EvidenceRecord {
  const text = repository.description ?? "";
  return evidenceRecord(
    repository,
    {
      text,
      sourceUrl: repository.url,
      sha: null,
      byteLength: Buffer.byteLength(text, "utf8"),
      missing: repository.description === null,
    },
    maximum,
  );
}

function safeReadme(input: GitHubReadme): GitHubReadme {
  const root = plainObject(input, "README result");
  exactKeys(root, README_KEYS, "README result");
  if (
    typeof root.text !== "string" ||
    typeof root.sourceUrl !== "string" ||
    typeof root.sha !== "string" ||
    typeof root.byteLength !== "number" ||
    !Number.isSafeInteger(root.byteLength) ||
    root.byteLength < 0
  ) {
    return validation("README result is invalid");
  }
  return Object.freeze({
    text: root.text,
    sourceUrl: root.sourceUrl,
    sha: root.sha,
    byteLength: root.byteLength,
  });
}

function readmeEvidence(
  repository: Repository,
  input: GitHubReadme | null,
  maximum: number,
): EvidenceRecord {
  if (input === null) {
    return evidenceRecord(
      repository,
      {
        text: "",
        sourceUrl: repository.url,
        sha: null,
        byteLength: 0,
        missing: true,
      },
      maximum,
    );
  }
  const value = safeReadme(input);
  return evidenceRecord(
    repository,
    {
      text: value.text,
      sourceUrl: value.sourceUrl,
      sha: value.sha,
      byteLength: value.byteLength,
      missing: false,
    },
    maximum,
  );
}

function safePrimaryError(error: unknown): AppError {
  if (utilTypes.isProxy(error)) return internalFailure();
  try {
    return error instanceof AppError ? error : internalFailure();
  } catch {
    return internalFailure();
  }
}

export class EvidenceService {
  readonly #github: GitHubEvidenceReadPort;
  readonly #concurrency: number;
  readonly #maxChars: number;

  constructor(
    github: GitHubEvidenceReadPort,
    concurrency: number,
    maxChars = MAX_CHARS,
  ) {
    this.#github = github;
    this.#concurrency = boundedInteger(
      concurrency,
      1,
      MAX_CONCURRENCY,
      "Evidence concurrency",
    );
    this.#maxChars = boundedInteger(
      maxChars,
      1,
      MAX_CHARS,
      "Evidence character limit",
    );
  }

  async fetch(
    input: readonly Repository[],
    mode: "summary" | "readme",
    signal?: AbortSignal,
  ): Promise<readonly EvidenceRecord[]> {
    const selected = repositories(input);
    if (mode !== "summary" && mode !== "readme") {
      return validation("Evidence mode is invalid");
    }
    if (signalIsAborted(signal)) return cancelled();
    if (mode === "summary") {
      return Object.freeze(
        selected.map((repository) =>
          summaryEvidence(repository, this.#maxChars),
        ),
      );
    }
    if (selected.length === 0) return Object.freeze([]);

    const output: (EvidenceRecord | undefined)[] = Array.from(
      { length: selected.length },
      (): EvidenceRecord | undefined => undefined,
    );
    let nextIndex = 0;
    let stopped = false;
    const failure: { value: AppError | null } = { value: null };

    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = nextIndex;
        if (index >= selected.length) return;
        nextIndex += 1;
        const repository = selected[index]!;
        try {
          const value = await this.#github.getReadme(
            Object.freeze({
              owner: repository.owner,
              name: repository.name,
            }),
            signal,
          );
          output[index] = readmeEvidence(repository, value, this.#maxChars);
        } catch (error) {
          if (!stopped) {
            stopped = true;
            failure.value = safePrimaryError(error);
          }
          return;
        }
      }
    };

    const workerCount = Math.min(this.#concurrency, selected.length);
    await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    );
    if (failure.value !== null) throw failure.value;
    const completed = output.map((record) => {
      if (record === undefined) throw internalFailure();
      return record;
    });
    return Object.freeze(completed);
  }
}
