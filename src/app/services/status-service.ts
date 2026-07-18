import type {
  GitHubCapabilities,
  GitHubStatusReadPort,
  RateLimitState,
} from "../ports/github-port.js";
import type { RateStateReader } from "../ports/rate-state-reader.js";
import type {
  IncompleteRunSummaries,
  IncompleteRunSummary,
  RunOperationCounts,
  StoragePort,
} from "../ports/storage-port.js";
import type { CredentialSource } from "../../auth/credential-provider.js";
import { canonicalJsonClone } from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import { asPlanId, asRunId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import type { AccountBinding } from "../../domain/repository.js";
import { parseSnapshot, type Snapshot } from "../../domain/snapshot.js";
import { canonicalUtcTimestamp } from "../../domain/timestamp.js";
import { PACKAGE_VERSION } from "../../version.js";

export type StatusInput = Readonly<{ refreshCapabilities?: boolean }>;

export type StatusResult = Readonly<{
  serverVersion: string;
  host: "github.com";
  login: string;
  credentialSource: CredentialSource;
  capabilities: GitHubCapabilities;
  databaseSchemaVersion: number;
  latestCompleteSnapshot: Snapshot | null;
  incompleteRuns: IncompleteRunSummaries;
  rateLimit: RateLimitState | null;
}>;

const CREDENTIAL_SOURCES = new Set<CredentialSource>([
  "GITHUB_STARS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "gh",
]);
const CAPABILITY_STATES = new Set(["available", "unavailable", "unknown"]);
const RUN_STATES = new Set(["pending", "running", "partial"]);
const COUNT_KEYS = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "unresolved",
] as const);

type JsonRecord = { readonly [key: string]: JsonValue };

function validationError(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function malformedCollaborator(
  code: "GITHUB_UNAVAILABLE" | "STORAGE_ERROR",
  source: "github" | "rate_state" | "storage",
): AppError {
  return new AppError(
    code,
    code === "STORAGE_ERROR"
      ? "Status storage returned invalid data"
      : "GitHub status data is invalid",
    {
      retryable: false,
      details: { reason: "malformed_collaborator_data", source },
    },
  );
}

function cloneJson(
  value: unknown,
  code: "GITHUB_UNAVAILABLE" | "STORAGE_ERROR",
  source: "github" | "rate_state" | "storage",
): JsonValue {
  try {
    return canonicalJsonClone(value);
  } catch {
    throw malformedCollaborator(code, source);
  }
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function record(
  value: JsonValue,
  keys: readonly string[],
  code: "GITHUB_UNAVAILABLE" | "STORAGE_ERROR",
  source: "github" | "rate_state" | "storage",
): JsonRecord {
  if (value === null || typeof value !== "object" || isJsonArray(value)) {
    throw malformedCollaborator(code, source);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw malformedCollaborator(code, source);
  }
  return value;
}

function jsonField(
  value: JsonRecord,
  key: string,
  code: "GITHUB_UNAVAILABLE" | "STORAGE_ERROR",
  source: "github" | "rate_state" | "storage",
): JsonValue {
  const field = value[key];
  if (field === undefined) throw malformedCollaborator(code, source);
  return field;
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

function boundedIdentityText(value: JsonValue, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    !wellFormedUnicode(value)
  ) {
    throw malformedCollaborator("GITHUB_UNAVAILABLE", "github");
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      throw malformedCollaborator("GITHUB_UNAVAILABLE", "github");
    }
  }
  return value;
}

function verifiedBinding(value: unknown): AccountBinding {
  const root = record(
    cloneJson(value, "GITHUB_UNAVAILABLE", "github"),
    ["host", "login", "accountId"],
    "GITHUB_UNAVAILABLE",
    "github",
  );
  const host = jsonField(root, "host", "GITHUB_UNAVAILABLE", "github");
  const login = jsonField(root, "login", "GITHUB_UNAVAILABLE", "github");
  const accountId = jsonField(
    root,
    "accountId",
    "GITHUB_UNAVAILABLE",
    "github",
  );
  if (host !== "github.com") {
    throw malformedCollaborator("GITHUB_UNAVAILABLE", "github");
  }
  return Object.freeze({
    host: "github.com",
    login: boundedIdentityText(login, 100),
    accountId: boundedIdentityText(accountId, 128),
  });
}

function capabilityState(value: JsonValue): GitHubCapabilities["starRead"] {
  if (typeof value !== "string" || !CAPABILITY_STATES.has(value)) {
    throw malformedCollaborator("GITHUB_UNAVAILABLE", "github");
  }
  if (value !== "available" && value !== "unavailable" && value !== "unknown") {
    throw malformedCollaborator("GITHUB_UNAVAILABLE", "github");
  }
  return value;
}

function capabilities(value: unknown): GitHubCapabilities {
  const root = record(
    cloneJson(value, "GITHUB_UNAVAILABLE", "github"),
    ["starRead", "starWrite", "listRead", "listWrite"],
    "GITHUB_UNAVAILABLE",
    "github",
  );
  return Object.freeze({
    starRead: capabilityState(
      jsonField(root, "starRead", "GITHUB_UNAVAILABLE", "github"),
    ),
    starWrite: capabilityState(
      jsonField(root, "starWrite", "GITHUB_UNAVAILABLE", "github"),
    ),
    listRead: capabilityState(
      jsonField(root, "listRead", "GITHUB_UNAVAILABLE", "github"),
    ),
    listWrite: capabilityState(
      jsonField(root, "listWrite", "GITHUB_UNAVAILABLE", "github"),
    ),
  });
}

function nonnegative(
  value: JsonValue,
  code: "GITHUB_UNAVAILABLE" | "STORAGE_ERROR",
  source: "rate_state" | "storage",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedCollaborator(code, source);
  }
  return value;
}

function rateLimit(value: unknown): RateLimitState | null {
  if (value === null) return null;
  const root = record(
    cloneJson(value, "GITHUB_UNAVAILABLE", "rate_state"),
    ["remaining", "resetAt"],
    "GITHUB_UNAVAILABLE",
    "rate_state",
  );
  const remaining = jsonField(
    root,
    "remaining",
    "GITHUB_UNAVAILABLE",
    "rate_state",
  );
  const rawResetAt = jsonField(
    root,
    "resetAt",
    "GITHUB_UNAVAILABLE",
    "rate_state",
  );
  let resetAt: string;
  try {
    resetAt = canonicalUtcTimestamp(rawResetAt, "rate limit resetAt");
  } catch {
    throw malformedCollaborator("GITHUB_UNAVAILABLE", "rate_state");
  }
  return Object.freeze({
    remaining: nonnegative(remaining, "GITHUB_UNAVAILABLE", "rate_state"),
    resetAt,
  });
}

function runCounts(value: JsonValue): RunOperationCounts {
  const root = record(value, COUNT_KEYS, "STORAGE_ERROR", "storage");
  return Object.freeze({
    pending: nonnegative(
      jsonField(root, "pending", "STORAGE_ERROR", "storage"),
      "STORAGE_ERROR",
      "storage",
    ),
    running: nonnegative(
      jsonField(root, "running", "STORAGE_ERROR", "storage"),
      "STORAGE_ERROR",
      "storage",
    ),
    succeeded: nonnegative(
      jsonField(root, "succeeded", "STORAGE_ERROR", "storage"),
      "STORAGE_ERROR",
      "storage",
    ),
    skipped: nonnegative(
      jsonField(root, "skipped", "STORAGE_ERROR", "storage"),
      "STORAGE_ERROR",
      "storage",
    ),
    failed: nonnegative(
      jsonField(root, "failed", "STORAGE_ERROR", "storage"),
      "STORAGE_ERROR",
      "storage",
    ),
    unresolved: nonnegative(
      jsonField(root, "unresolved", "STORAGE_ERROR", "storage"),
      "STORAGE_ERROR",
      "storage",
    ),
  });
}

function incompleteRun(value: JsonValue): IncompleteRunSummary {
  const root = record(
    value,
    ["runId", "planId", "state", "startedAt", "finishedAt", "counts"],
    "STORAGE_ERROR",
    "storage",
  );
  const rawRunId = jsonField(root, "runId", "STORAGE_ERROR", "storage");
  const rawPlanId = jsonField(root, "planId", "STORAGE_ERROR", "storage");
  const rawState = jsonField(root, "state", "STORAGE_ERROR", "storage");
  const rawStartedAt = jsonField(root, "startedAt", "STORAGE_ERROR", "storage");
  const rawFinishedAt = jsonField(
    root,
    "finishedAt",
    "STORAGE_ERROR",
    "storage",
  );
  if (
    typeof rawRunId !== "string" ||
    typeof rawPlanId !== "string" ||
    typeof rawState !== "string" ||
    !RUN_STATES.has(rawState)
  ) {
    throw malformedCollaborator("STORAGE_ERROR", "storage");
  }
  let runId: ReturnType<typeof asRunId>;
  let planId: ReturnType<typeof asPlanId>;
  let startedAt: string;
  let finishedAt: string | null;
  try {
    runId = asRunId(rawRunId);
    planId = asPlanId(rawPlanId);
    startedAt = canonicalUtcTimestamp(rawStartedAt, "run startedAt");
    finishedAt =
      rawFinishedAt === null
        ? null
        : canonicalUtcTimestamp(rawFinishedAt, "run finishedAt");
  } catch {
    throw malformedCollaborator("STORAGE_ERROR", "storage");
  }
  return Object.freeze({
    runId,
    planId,
    state:
      rawState === "pending"
        ? "pending"
        : rawState === "running"
          ? "running"
          : "partial",
    startedAt,
    finishedAt,
    counts: runCounts(jsonField(root, "counts", "STORAGE_ERROR", "storage")),
  });
}

function incompleteRuns(value: unknown): IncompleteRunSummaries {
  const root = record(
    cloneJson(value, "STORAGE_ERROR", "storage"),
    ["items", "total", "truncated"],
    "STORAGE_ERROR",
    "storage",
  );
  const rawItems = jsonField(root, "items", "STORAGE_ERROR", "storage");
  if (!isJsonArray(rawItems) || rawItems.length > 20) {
    throw malformedCollaborator("STORAGE_ERROR", "storage");
  }
  const items = Object.freeze(rawItems.map(incompleteRun));
  const total = nonnegative(
    jsonField(root, "total", "STORAGE_ERROR", "storage"),
    "STORAGE_ERROR",
    "storage",
  );
  const truncated = jsonField(root, "truncated", "STORAGE_ERROR", "storage");
  if (
    total < items.length ||
    typeof truncated !== "boolean" ||
    truncated !== total > items.length
  ) {
    throw malformedCollaborator("STORAGE_ERROR", "storage");
  }
  return Object.freeze({ items, total, truncated });
}

function latestSnapshot(
  value: Snapshot | null,
  binding: AccountBinding,
): Snapshot | null {
  if (value === null) return null;
  let snapshot: Snapshot;
  try {
    snapshot = parseSnapshot(value);
  } catch {
    throw malformedCollaborator("STORAGE_ERROR", "storage");
  }
  if (
    snapshot.binding.host !== binding.host ||
    snapshot.binding.login !== binding.login ||
    snapshot.binding.accountId !== binding.accountId ||
    snapshot.status !== "complete"
  ) {
    throw malformedCollaborator("STORAGE_ERROR", "storage");
  }
  return snapshot;
}

function statusInput(input: StatusInput | undefined): boolean {
  if (input === undefined) return false;
  let clone: JsonValue;
  try {
    clone = canonicalJsonClone(input);
  } catch {
    throw validationError("Status input is invalid");
  }
  if (clone === null || typeof clone !== "object" || isJsonArray(clone)) {
    throw validationError("Status input is invalid");
  }
  const keys = Object.keys(clone);
  const refreshCapabilities = clone.refreshCapabilities;
  if (
    keys.some((key) => key !== "refreshCapabilities") ||
    keys.length > 1 ||
    (refreshCapabilities !== undefined &&
      typeof refreshCapabilities !== "boolean")
  ) {
    throw validationError("Status input is invalid");
  }
  return refreshCapabilities === true;
}

function storageFailure(): AppError {
  return new AppError("STORAGE_ERROR", "Status storage query failed", {
    retryable: false,
    details: { reason: "status_query_failed" },
  });
}

function githubFailure(): AppError {
  return new AppError("GITHUB_UNAVAILABLE", "GitHub capability probe failed", {
    retryable: true,
    details: { reason: "capability_probe_failed" },
  });
}

export class StatusService {
  readonly #github: GitHubStatusReadPort;
  readonly #storage: StoragePort;
  readonly #credentialSource: CredentialSource;
  readonly #rateStateReader: RateStateReader;
  readonly #capabilityCache = new Map<string, GitHubCapabilities>();
  readonly #capabilityInFlight = new Map<string, Promise<GitHubCapabilities>>();

  constructor(
    github: GitHubStatusReadPort,
    storage: StoragePort,
    credentialSource: CredentialSource,
    rateStateReader: RateStateReader,
  ) {
    if (!CREDENTIAL_SOURCES.has(credentialSource)) {
      throw validationError("Credential source is invalid");
    }
    this.#github = github;
    this.#storage = storage;
    this.#credentialSource = credentialSource;
    this.#rateStateReader = rateStateReader;
  }

  async #capabilities(
    binding: AccountBinding,
    refresh: boolean,
    signal: AbortSignal | undefined,
  ): Promise<GitHubCapabilities> {
    const key = `${binding.host}\u0000${binding.accountId}`;
    if (!refresh) {
      const cached = this.#capabilityCache.get(key);
      if (cached !== undefined) return cached;
    }
    const active = this.#capabilityInFlight.get(key);
    if (active !== undefined) return active;

    const pending = Promise.resolve()
      .then(() => this.#github.probeCapabilities(signal))
      .then(capabilities)
      .then((value) => {
        this.#capabilityCache.set(key, value);
        return value;
      })
      .catch((error: unknown) => {
        if (error instanceof AppError || error instanceof DOMException) {
          throw error;
        }
        throw githubFailure();
      })
      .finally(() => {
        if (this.#capabilityInFlight.get(key) === pending) {
          this.#capabilityInFlight.delete(key);
        }
      });
    this.#capabilityInFlight.set(key, pending);
    return pending;
  }

  async status(
    input?: StatusInput,
    signal?: AbortSignal,
  ): Promise<StatusResult> {
    const refresh = statusInput(input);
    let binding: AccountBinding;
    try {
      binding = verifiedBinding(await this.#github.getViewer(signal));
    } catch (error) {
      if (error instanceof AppError || error instanceof DOMException) {
        throw error;
      }
      throw new AppError("GITHUB_UNAVAILABLE", "GitHub identity check failed", {
        retryable: true,
        details: { reason: "identity_check_failed" },
      });
    }
    const capabilityState = await this.#capabilities(binding, refresh, signal);

    let snapshotValue: Snapshot | null;
    let databaseSchemaVersion: number;
    let incompleteValue: IncompleteRunSummaries;
    try {
      snapshotValue = latestSnapshot(
        this.#storage.getLatestCompleteSnapshot(binding),
        binding,
      );
      databaseSchemaVersion = this.#storage.getSchemaVersion();
      if (
        !Number.isSafeInteger(databaseSchemaVersion) ||
        databaseSchemaVersion < 0
      ) {
        throw malformedCollaborator("STORAGE_ERROR", "storage");
      }
      incompleteValue = incompleteRuns(
        this.#storage.getIncompleteRunSummaries({
          binding,
          limit: 20,
        }),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storageFailure();
    }

    let currentRate: RateLimitState | null;
    try {
      currentRate = rateLimit(this.#rateStateReader.getState());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw malformedCollaborator("GITHUB_UNAVAILABLE", "rate_state");
    }

    return Object.freeze({
      serverVersion: PACKAGE_VERSION,
      host: "github.com",
      login: binding.login,
      credentialSource: this.#credentialSource,
      capabilities: capabilityState,
      databaseSchemaVersion,
      latestCompleteSnapshot: snapshotValue,
      incompleteRuns: incompleteValue,
      rateLimit: currentRate,
    });
  }
}
