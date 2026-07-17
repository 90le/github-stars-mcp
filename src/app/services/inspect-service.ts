import type { StoragePort } from "../ports/storage-port.js";
import {
  canonicalJsonClone,
  freezeJsonValue,
} from "../../domain/canonical-json.js";
import { AppError } from "../../domain/errors.js";
import {
  asPlanId,
  asRunId,
  type PlanId,
  type RunId,
} from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import {
  parseChangePlan,
  type ChangePlan,
  type ResolvedOperation,
} from "../../domain/plan.js";
import { redactSecrets } from "../../domain/redaction.js";
import {
  parseChangeRun,
  parseRunOperation,
  type ChangeRun,
  type RunOperation,
} from "../../domain/run.js";

export type InspectInput = Readonly<{
  kind: "plan" | "run";
  id: string;
  limit?: number;
  cursor?: string | null;
}>;

export type PlanInspectionMetadata = Readonly<{
  id: PlanId;
  hash: string;
  state: ChangePlan["state"];
  createdAt: string;
  expiresAt: string;
  callerNote: string | null;
  binding: ChangePlan["executable"]["binding"];
  snapshotId: ChangePlan["executable"]["snapshotId"];
  schemaVersion: 1;
  policyVersion: "1";
  protectedRepositoryIds: ChangePlan["executable"]["protectedRepositoryIds"];
  protectedListIds: ChangePlan["executable"]["protectedListIds"];
  warnings: readonly string[];
  operationCount: number;
  dependencyCount: number;
}>;

export type PlanInspectionOperation = Readonly<{
  sequence: number;
  operation: ResolvedOperation;
}>;

export type PlanInspectResult = Readonly<{
  kind: "plan";
  plan: PlanInspectionMetadata;
  operations: readonly PlanInspectionOperation[];
  total: number;
  nextCursor: string | null;
}>;

export type RunInspectResult = Readonly<{
  kind: "run";
  run: ChangeRun;
  operations: readonly RunOperation[];
  total: number;
  nextCursor: string | null;
}>;

export type InspectResult = PlanInspectResult | RunInspectResult;

export type InspectStoragePort = Pick<
  StoragePort,
  "getPlan" | "getRun" | "listRunOperationsPage"
>;

type InspectKind = InspectInput["kind"];

type ParsedInput = Readonly<{
  kind: InspectKind;
  id: string;
  targetId: PlanId | RunId;
  limit: number;
  cursor: CursorPayload | null;
}>;

type CursorPayload = Readonly<{
  version: 1;
  kind: InspectKind;
  targetId: string;
  afterSequence: number;
}>;

type JsonObject = Readonly<Record<string, JsonValue>>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 128;
const MAX_CURSOR_LENGTH = 4_096;
const INPUT_KEYS = new Set(["kind", "id", "limit", "cursor"]);
const CURSOR_KEYS = new Set(["version", "kind", "targetId", "afterSequence"]);
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function validation(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function notFound(): never {
  throw new AppError(
    "NOT_FOUND",
    "The requested inspection target was not found",
    { retryable: false },
  );
}

function storageFailure(): never {
  throw new AppError(
    "STORAGE_ERROR",
    "Inspection storage returned invalid data",
    {
      retryable: false,
    },
  );
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function boundedId(value: JsonValue, kind: InspectKind): PlanId | RunId {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_ID_LENGTH ||
    value.trim() !== value
  ) {
    return validation("Inspection target ID is invalid");
  }
  return kind === "plan" ? asPlanId(value) : asRunId(value);
}

function boundedLimit(value: JsonValue | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LIMIT
  ) {
    return validation("Inspection limit must be an integer from 1 to 100");
  }
  return value;
}

function decodeCursor(value: string): CursorPayload {
  if (
    value.length < 1 ||
    value.length > MAX_CURSOR_LENGTH ||
    !BASE64URL.test(value)
  ) {
    return validation("Inspection cursor is invalid");
  }

  let decoded: string;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      return validation("Inspection cursor is invalid");
    }
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return validation("Inspection cursor is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return validation("Inspection cursor is invalid");
  }

  const cloned = canonicalJsonClone(parsed);
  if (
    !isJsonObject(cloned) ||
    !exactKeys(cloned, CURSOR_KEYS, [
      "version",
      "kind",
      "targetId",
      "afterSequence",
    ]) ||
    cloned.version !== 1 ||
    (cloned.kind !== "plan" && cloned.kind !== "run") ||
    typeof cloned.targetId !== "string" ||
    cloned.targetId.length < 1 ||
    cloned.targetId.length > MAX_ID_LENGTH ||
    cloned.targetId.trim() !== cloned.targetId ||
    typeof cloned.afterSequence !== "number" ||
    !Number.isSafeInteger(cloned.afterSequence) ||
    cloned.afterSequence < 0
  ) {
    return validation("Inspection cursor is invalid");
  }
  return Object.freeze({
    version: 1,
    kind: cloned.kind,
    targetId: cloned.targetId,
    afterSequence: cloned.afterSequence,
  });
}

function parseInput(input: InspectInput): ParsedInput {
  let cloned: JsonValue;
  try {
    cloned = canonicalJsonClone(input);
  } catch {
    return validation("Inspection input must be a plain data object");
  }
  if (
    !isJsonObject(cloned) ||
    !exactKeys(cloned, INPUT_KEYS, ["kind", "id"]) ||
    (cloned.kind !== "plan" && cloned.kind !== "run")
  ) {
    return validation("Inspection input is invalid");
  }

  const targetId = boundedId(cloned.id as JsonValue, cloned.kind);
  const rawCursor = cloned.cursor;
  if (
    rawCursor !== undefined &&
    rawCursor !== null &&
    typeof rawCursor !== "string"
  ) {
    return validation("Inspection cursor is invalid");
  }
  const cursor = typeof rawCursor === "string" ? decodeCursor(rawCursor) : null;
  if (
    cursor !== null &&
    (cursor.kind !== cloned.kind || cursor.targetId !== String(targetId))
  ) {
    return validation("Inspection cursor does not match its target");
  }
  return Object.freeze({
    kind: cloned.kind,
    id: String(targetId),
    targetId,
    limit: boundedLimit(cloned.limit),
    cursor,
  });
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function nextCursor(
  kind: InspectKind,
  targetId: string,
  afterSequence: number | null,
): string | null {
  return afterSequence === null
    ? null
    : encodeCursor(
        Object.freeze({
          version: 1,
          kind,
          targetId,
          afterSequence,
        }),
      );
}

function sanitizedResult<T extends InspectResult>(value: T): T {
  return freezeJsonValue(redactSecrets(value)) as unknown as T;
}

function planMetadata(plan: ChangePlan): PlanInspectionMetadata {
  return Object.freeze({
    id: plan.id,
    hash: plan.hash,
    state: plan.state,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    callerNote: plan.callerNote,
    binding: plan.executable.binding,
    snapshotId: plan.executable.snapshotId,
    schemaVersion: plan.executable.schemaVersion,
    policyVersion: plan.executable.policyVersion,
    protectedRepositoryIds: plan.executable.protectedRepositoryIds,
    protectedListIds: plan.executable.protectedListIds,
    warnings: plan.warnings,
    operationCount: plan.operations.length,
    dependencyCount: plan.dependencies.length,
  });
}

export class InspectService {
  readonly #storage: InspectStoragePort;

  constructor(storage: InspectStoragePort) {
    this.#storage = storage;
  }

  inspect(input: InspectInput): Promise<InspectResult> {
    return Promise.resolve().then(() => {
      const parsed = parseInput(input);
      return parsed.kind === "plan"
        ? this.#inspectPlan(parsed)
        : this.#inspectRun(parsed);
    });
  }

  #inspectPlan(input: ParsedInput): PlanInspectResult {
    let plan: ChangePlan;
    try {
      const stored = this.#storage.getPlan(input.targetId as PlanId);
      if (stored === null) return notFound();
      plan = parseChangePlan(stored);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") throw error;
      return storageFailure();
    }

    const afterSequence = input.cursor?.afterSequence ?? 0;
    if (
      input.cursor !== null &&
      (plan.operations.length === 0 || afterSequence > plan.operations.length)
    ) {
      return validation("Inspection cursor sequence exceeds its target");
    }
    const selected = plan.operations.slice(
      afterSequence,
      afterSequence + input.limit,
    );
    const operations = Object.freeze(
      selected.map((operation, index) =>
        Object.freeze({
          sequence: afterSequence + index + 1,
          operation,
        }),
      ),
    );
    const consumed = afterSequence + operations.length;
    return sanitizedResult(
      Object.freeze({
        kind: "plan",
        plan: planMetadata(plan),
        operations,
        total: plan.operations.length,
        nextCursor: nextCursor(
          "plan",
          input.id,
          consumed < plan.operations.length ? consumed : null,
        ),
      }),
    );
  }

  #inspectRun(input: ParsedInput): RunInspectResult {
    let run: ChangeRun;
    try {
      const stored = this.#storage.getRun(input.targetId as RunId);
      if (stored === null) return notFound();
      run = parseChangeRun(stored);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") throw error;
      return storageFailure();
    }

    let page: ReturnType<InspectStoragePort["listRunOperationsPage"]>;
    try {
      page = this.#storage.listRunOperationsPage({
        runId: run.id,
        afterSequence: input.cursor?.afterSequence ?? null,
        pageSize: input.limit,
      });
    } catch {
      return storageFailure();
    }
    const lastSequence = page.total - 1;
    if (
      input.cursor !== null &&
      (page.total === 0 || input.cursor.afterSequence > lastSequence)
    ) {
      return validation("Inspection cursor sequence exceeds its target");
    }

    let operations: readonly RunOperation[];
    try {
      operations = Object.freeze(page.items.map(parseRunOperation));
    } catch {
      return storageFailure();
    }
    if (
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      (page.nextSequence !== null &&
        (!Number.isSafeInteger(page.nextSequence) ||
          page.nextSequence < 0 ||
          page.nextSequence >= page.total))
    ) {
      return storageFailure();
    }

    return sanitizedResult(
      Object.freeze({
        kind: "run",
        run,
        operations,
        total: page.total,
        nextCursor: nextCursor("run", input.id, page.nextSequence),
      }),
    );
  }
}
