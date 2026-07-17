import { types as utilTypes } from "node:util";
import type { StoragePort } from "../ports/storage-port.js";
import {
  canonicalJson,
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
  parseRunOperationAttempt,
  parseRunOperationReconciliation,
  type ChangeRun,
  type RunOperation,
  type RunOperationAttempt,
  type RunOperationReconciliation,
} from "../../domain/run.js";

export type PlanInspectInput = Readonly<{
  kind: "plan";
  id: string;
  limit?: number;
  cursor?: string | null;
}>;

export type RunInspectInput = Readonly<{
  kind: "run";
  id: string;
  limit?: number;
  cursor?: string | null;
}>;

export type AttemptsInspectInput = Readonly<{
  kind: "attempts";
  id: RunId;
  operationId: string;
  limit?: number;
  cursor?: string | null;
}>;

export type ReconciliationsInspectInput = Readonly<{
  kind: "reconciliations";
  id: RunId;
  operationId: string;
  limit?: number;
  cursor?: string | null;
}>;

export type InspectInput =
  | PlanInspectInput
  | RunInspectInput
  | AttemptsInspectInput
  | ReconciliationsInspectInput;

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

export type AttemptsInspectResult = Readonly<{
  kind: "attempts";
  run: ChangeRun;
  operationId: string;
  attempts: readonly RunOperationAttempt[];
  total: number;
  nextCursor: string | null;
}>;

export type ReconciliationsInspectResult = Readonly<{
  kind: "reconciliations";
  run: ChangeRun;
  operationId: string;
  reconciliations: readonly RunOperationReconciliation[];
  total: number;
  nextCursor: string | null;
}>;

export type InspectResult =
  | PlanInspectResult
  | RunInspectResult
  | AttemptsInspectResult
  | ReconciliationsInspectResult;

export type InspectStoragePort = Pick<
  StoragePort,
  | "getPlan"
  | "getRun"
  | "listRunOperationsPage"
  | "listRunOperationAttemptsPage"
  | "listRunOperationReconciliationsPage"
>;

type InspectKind = InspectInput["kind"];

type SequenceCursor = Readonly<{
  version: 1;
  kind: "plan" | "run";
  targetId: string;
  afterSequence: number;
}>;

type AttemptCursor = Readonly<{
  version: 1;
  kind: "attempts";
  runId: string;
  operationId: string;
  afterAttempt: number;
}>;

type ReconciliationCursor = Readonly<{
  version: 1;
  kind: "reconciliations";
  runId: string;
  operationId: string;
  afterEventSequence: number;
}>;

type CursorPayload = SequenceCursor | AttemptCursor | ReconciliationCursor;

type ParsedPlanRunInput = Readonly<{
  kind: "plan" | "run";
  id: string;
  targetId: PlanId | RunId;
  limit: number;
  cursor: SequenceCursor | null;
}>;

type ParsedHistoryInput = Readonly<{
  kind: "attempts" | "reconciliations";
  id: string;
  targetId: RunId;
  operationId: string;
  limit: number;
  cursor: AttemptCursor | ReconciliationCursor | null;
}>;

type ParsedInput = ParsedPlanRunInput | ParsedHistoryInput;

type JsonObject = Readonly<Record<string, JsonValue>>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 128;
const MAX_CURSOR_LENGTH = 4_096;
const PLAN_RUN_INPUT_KEYS = new Set(["kind", "id", "limit", "cursor"]);
const HISTORY_INPUT_KEYS = new Set([
  "kind",
  "id",
  "operationId",
  "limit",
  "cursor",
]);
const SEQUENCE_CURSOR_KEYS = new Set([
  "version",
  "kind",
  "targetId",
  "afterSequence",
]);
const ATTEMPT_CURSOR_KEYS = new Set([
  "version",
  "kind",
  "runId",
  "operationId",
  "afterAttempt",
]);
const RECONCILIATION_CURSOR_KEYS = new Set([
  "version",
  "kind",
  "runId",
  "operationId",
  "afterEventSequence",
]);
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const OBJECT_PROTOTYPE = Object.prototype;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const HAS_OWN = Object.hasOwn;
const REFLECT_GET_PROTOTYPE_OF = Reflect.getPrototypeOf;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const IS_PROXY = utilTypes.isProxy;

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

function boundedOperationId(value: JsonValue): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_ID_LENGTH ||
    value.trim() !== value
  ) {
    return validation("Inspection operation ID is invalid");
  }
  return value;
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

function nonnegativeBoundary(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedCursorText(value: JsonValue | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value
  );
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

  let cloned: JsonValue;
  try {
    if (canonicalJson(parsed) !== decoded) {
      return validation("Inspection cursor is invalid");
    }
    cloned = canonicalJsonClone(parsed);
  } catch {
    return validation("Inspection cursor is invalid");
  }
  if (!isJsonObject(cloned) || cloned.version !== 1) {
    return validation("Inspection cursor is invalid");
  }
  if (cloned.kind === "plan" || cloned.kind === "run") {
    if (
      !exactKeys(cloned, SEQUENCE_CURSOR_KEYS, [
        "version",
        "kind",
        "targetId",
        "afterSequence",
      ]) ||
      !boundedCursorText(cloned.targetId) ||
      !nonnegativeBoundary(cloned.afterSequence)
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
  if (cloned.kind === "attempts") {
    if (
      !exactKeys(cloned, ATTEMPT_CURSOR_KEYS, [
        "version",
        "kind",
        "runId",
        "operationId",
        "afterAttempt",
      ]) ||
      !boundedCursorText(cloned.runId) ||
      !boundedCursorText(cloned.operationId) ||
      !nonnegativeBoundary(cloned.afterAttempt)
    ) {
      return validation("Inspection cursor is invalid");
    }
    return Object.freeze({
      version: 1,
      kind: "attempts",
      runId: cloned.runId,
      operationId: cloned.operationId,
      afterAttempt: cloned.afterAttempt,
    });
  }
  if (cloned.kind === "reconciliations") {
    if (
      !exactKeys(cloned, RECONCILIATION_CURSOR_KEYS, [
        "version",
        "kind",
        "runId",
        "operationId",
        "afterEventSequence",
      ]) ||
      !boundedCursorText(cloned.runId) ||
      !boundedCursorText(cloned.operationId) ||
      !nonnegativeBoundary(cloned.afterEventSequence)
    ) {
      return validation("Inspection cursor is invalid");
    }
    return Object.freeze({
      version: 1,
      kind: "reconciliations",
      runId: cloned.runId,
      operationId: cloned.operationId,
      afterEventSequence: cloned.afterEventSequence,
    });
  }
  return validation("Inspection cursor is invalid");
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
    (cloned.kind !== "plan" &&
      cloned.kind !== "run" &&
      cloned.kind !== "attempts" &&
      cloned.kind !== "reconciliations")
  ) {
    return validation("Inspection input is invalid");
  }

  const rawCursor = cloned.cursor;
  if (
    rawCursor !== undefined &&
    rawCursor !== null &&
    typeof rawCursor !== "string"
  ) {
    return validation("Inspection cursor is invalid");
  }
  const cursor = typeof rawCursor === "string" ? decodeCursor(rawCursor) : null;
  if (cloned.kind === "plan" || cloned.kind === "run") {
    if (!exactKeys(cloned, PLAN_RUN_INPUT_KEYS, ["kind", "id"])) {
      return validation("Inspection input is invalid");
    }
    const targetId = boundedId(cloned.id as JsonValue, cloned.kind);
    if (
      cursor !== null &&
      (cursor.kind !== cloned.kind ||
        !("targetId" in cursor) ||
        cursor.targetId !== String(targetId))
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

  if (!exactKeys(cloned, HISTORY_INPUT_KEYS, ["kind", "id", "operationId"])) {
    return validation("Inspection input is invalid");
  }
  const targetId = boundedId(cloned.id as JsonValue, cloned.kind) as RunId;
  const operationId = boundedOperationId(cloned.operationId as JsonValue);
  if (
    cursor !== null &&
    (cursor.kind !== cloned.kind ||
      !("runId" in cursor) ||
      cursor.runId !== String(targetId) ||
      cursor.operationId !== operationId)
  ) {
    return validation("Inspection cursor does not match its target");
  }
  return Object.freeze({
    kind: cloned.kind,
    id: String(targetId),
    targetId,
    operationId,
    limit: boundedLimit(cloned.limit),
    cursor,
  });
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

function sequenceCursor(
  kind: "plan" | "run",
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

function attemptCursor(
  runId: string,
  operationId: string,
  afterAttempt: number | null,
): string | null {
  return afterAttempt === null
    ? null
    : encodeCursor(
        Object.freeze({
          version: 1,
          kind: "attempts",
          runId,
          operationId,
          afterAttempt,
        }),
      );
}

function reconciliationCursor(
  runId: string,
  operationId: string,
  afterEventSequence: number | null,
): string | null {
  return afterEventSequence === null
    ? null
    : encodeCursor(
        Object.freeze({
          version: 1,
          kind: "reconciliations",
          runId,
          operationId,
          afterEventSequence,
        }),
      );
}

function dataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ReadonlyMap<string, unknown> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      IS_PROXY(value) ||
      ARRAY_IS_ARRAY(value)
    ) {
      return null;
    }
    const prototype = REFLECT_GET_PROTOTYPE_OF(value);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return null;
    const descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
    const keys = REFLECT_OWN_KEYS(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return null;
    }
    const values = new Map<string, unknown>();
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !HAS_OWN(descriptor, "value")
      ) {
        return null;
      }
      values.set(key, descriptor.value as unknown);
    }
    return values;
  } catch {
    return null;
  }
}

function denseDataArray(
  value: unknown,
  maximum: number,
): readonly unknown[] | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      IS_PROXY(value) ||
      !ARRAY_IS_ARRAY(value) ||
      REFLECT_GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE
    ) {
      return null;
    }
    const lengthDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(value, "length");
    if (
      lengthDescriptor === undefined ||
      !HAS_OWN(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum
    ) {
      return null;
    }
    const length = lengthDescriptor.value;
    const keys = REFLECT_OWN_KEYS(value);
    if (
      keys.length !== length + 1 ||
      keys.some((key) => typeof key !== "string")
    ) {
      return null;
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !HAS_OWN(descriptor, "value")
      ) {
        return null;
      }
      result[index] = descriptor.value as unknown;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function exactAppErrorCode(error: unknown): string | null {
  try {
    if (
      error === null ||
      typeof error !== "object" ||
      IS_PROXY(error) ||
      REFLECT_GET_PROTOTYPE_OF(error) !== AppError.prototype
    ) {
      return null;
    }
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(error, "code");
    return descriptor !== undefined &&
      HAS_OWN(descriptor, "value") &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function invokeStoragePage<T>(action: () => T, cursorProvided: boolean): T {
  try {
    return action();
  } catch (error) {
    if (cursorProvided && exactAppErrorCode(error) === "VALIDATION_ERROR") {
      return validation("Inspection cursor sequence exceeds its target");
    }
    return storageFailure();
  }
}

type ValidatedPage<T> = Readonly<{
  items: readonly T[];
  total: number;
  nextBoundary: number | null;
}>;

function validatedPage<T>(
  rawPage: unknown,
  input: Readonly<{
    nextKey: "nextSequence" | "nextAttempt" | "nextEventSequence";
    limit: number;
    firstBoundary: 0 | 1;
    afterBoundary: number | null;
    cursorProvided: boolean;
    parseItem: (value: unknown) => T;
    itemBoundary: (item: T) => number;
    itemMatchesTarget: (item: T) => boolean;
  }>,
): ValidatedPage<T> {
  const record = dataRecord(rawPage, ["items", "total", input.nextKey]);
  if (record === null) return storageFailure();
  const rawItems = denseDataArray(record.get("items"), input.limit);
  const total = record.get("total");
  const nextBoundary = record.get(input.nextKey);
  if (
    rawItems === null ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    (nextBoundary !== null &&
      (typeof nextBoundary !== "number" ||
        !Number.isSafeInteger(nextBoundary) ||
        nextBoundary < input.firstBoundary))
  ) {
    return storageFailure();
  }

  const consumedBefore =
    input.afterBoundary === null
      ? 0
      : input.afterBoundary - input.firstBoundary + 1;
  if (input.cursorProvided && (total === 0 || consumedBefore > total)) {
    return validation("Inspection cursor sequence exceeds its target");
  }
  if (consumedBefore < 0 || consumedBefore > total) {
    return storageFailure();
  }
  const expectedItemCount = Math.min(input.limit, total - consumedBefore);
  if (rawItems.length !== expectedItemCount) return storageFailure();

  let clonedItems: readonly JsonValue[];
  try {
    const clonedPage = canonicalJsonClone(rawPage);
    if (
      !isJsonObject(clonedPage) ||
      !ARRAY_IS_ARRAY(clonedPage.items) ||
      clonedPage.items.length !== rawItems.length
    ) {
      return storageFailure();
    }
    clonedItems = clonedPage.items;
  } catch {
    return storageFailure();
  }

  const items: T[] = [];
  for (let index = 0; index < clonedItems.length; index += 1) {
    let item: T;
    try {
      item = input.parseItem(clonedItems[index]);
    } catch {
      return storageFailure();
    }
    const expectedBoundary = input.firstBoundary + consumedBefore + index;
    if (
      input.itemBoundary(item) !== expectedBoundary ||
      !input.itemMatchesTarget(item)
    ) {
      return storageFailure();
    }
    items.push(item);
  }

  const consumed = consumedBefore + items.length;
  const hasMore = consumed < total;
  const last = items.at(-1);
  const expectedNext =
    hasMore && last !== undefined ? input.itemBoundary(last) : null;
  if (nextBoundary !== expectedNext) return storageFailure();
  return Object.freeze({
    items: Object.freeze(items),
    total,
    nextBoundary,
  });
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

  inspect(input: PlanInspectInput): Promise<PlanInspectResult>;
  inspect(input: RunInspectInput): Promise<RunInspectResult>;
  inspect(input: AttemptsInspectInput): Promise<AttemptsInspectResult>;
  inspect(
    input: ReconciliationsInspectInput,
  ): Promise<ReconciliationsInspectResult>;
  inspect(input: InspectInput): Promise<InspectResult>;
  inspect(input: InspectInput): Promise<InspectResult> {
    return Promise.resolve().then(() => {
      const parsed = parseInput(input);
      switch (parsed.kind) {
        case "plan":
          return this.#inspectPlan(parsed);
        case "run":
          return this.#inspectRun(parsed);
        case "attempts":
          return this.#inspectAttempts(parsed);
        case "reconciliations":
          return this.#inspectReconciliations(parsed);
      }
    });
  }

  #loadPlan(id: PlanId): ChangePlan {
    let stored: ReturnType<InspectStoragePort["getPlan"]>;
    try {
      stored = this.#storage.getPlan(id);
    } catch {
      return storageFailure();
    }
    if (stored === null) return notFound();
    try {
      const plan = parseChangePlan(stored);
      return plan.id === id ? plan : storageFailure();
    } catch {
      return storageFailure();
    }
  }

  #loadRun(id: RunId): ChangeRun {
    let stored: ReturnType<InspectStoragePort["getRun"]>;
    try {
      stored = this.#storage.getRun(id);
    } catch {
      return storageFailure();
    }
    if (stored === null) return notFound();
    try {
      const run = parseChangeRun(stored);
      return run.id === id ? run : storageFailure();
    } catch {
      return storageFailure();
    }
  }

  #inspectPlan(input: ParsedPlanRunInput): PlanInspectResult {
    const plan = this.#loadPlan(input.targetId as PlanId);

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
        nextCursor: sequenceCursor(
          "plan",
          input.id,
          consumed < plan.operations.length ? consumed : null,
        ),
      }),
    );
  }

  #inspectRun(input: ParsedPlanRunInput): RunInspectResult {
    const run = this.#loadRun(input.targetId as RunId);
    const afterSequence = input.cursor?.afterSequence ?? null;
    const rawPage = invokeStoragePage(
      () =>
        this.#storage.listRunOperationsPage({
          runId: run.id,
          afterSequence,
          pageSize: input.limit,
        }),
      input.cursor !== null,
    );
    const page = validatedPage(rawPage, {
      nextKey: "nextSequence",
      limit: input.limit,
      firstBoundary: 0,
      afterBoundary: afterSequence,
      cursorProvided: input.cursor !== null,
      parseItem: parseRunOperation,
      itemBoundary: (operation) => operation.sequence,
      itemMatchesTarget: (operation) => operation.runId === run.id,
    });

    return sanitizedResult(
      Object.freeze({
        kind: "run",
        run,
        operations: page.items,
        total: page.total,
        nextCursor: sequenceCursor("run", input.id, page.nextBoundary),
      }),
    );
  }

  #inspectAttempts(input: ParsedHistoryInput): AttemptsInspectResult {
    const run = this.#loadRun(input.targetId);
    const cursor = input.cursor?.kind === "attempts" ? input.cursor : null;
    const afterAttempt = cursor?.afterAttempt ?? null;
    const rawPage = invokeStoragePage(
      () =>
        this.#storage.listRunOperationAttemptsPage({
          runId: run.id,
          operationId: input.operationId,
          afterAttempt,
          pageSize: input.limit,
        }),
      cursor !== null,
    );
    const page = validatedPage(rawPage, {
      nextKey: "nextAttempt",
      limit: input.limit,
      firstBoundary: 1,
      afterBoundary: afterAttempt,
      cursorProvided: cursor !== null,
      parseItem: parseRunOperationAttempt,
      itemBoundary: (attempt) => attempt.attempt,
      itemMatchesTarget: (attempt) =>
        attempt.runId === run.id && attempt.operationId === input.operationId,
    });

    return sanitizedResult(
      Object.freeze({
        kind: "attempts",
        run,
        operationId: input.operationId,
        attempts: page.items,
        total: page.total,
        nextCursor: attemptCursor(
          input.id,
          input.operationId,
          page.nextBoundary,
        ),
      }),
    );
  }

  #inspectReconciliations(
    input: ParsedHistoryInput,
  ): ReconciliationsInspectResult {
    const run = this.#loadRun(input.targetId);
    const cursor =
      input.cursor?.kind === "reconciliations" ? input.cursor : null;
    const afterEventSequence = cursor?.afterEventSequence ?? null;
    const rawPage = invokeStoragePage(
      () =>
        this.#storage.listRunOperationReconciliationsPage({
          runId: run.id,
          operationId: input.operationId,
          afterEventSequence,
          pageSize: input.limit,
        }),
      cursor !== null,
    );
    const page = validatedPage(rawPage, {
      nextKey: "nextEventSequence",
      limit: input.limit,
      firstBoundary: 1,
      afterBoundary: afterEventSequence,
      cursorProvided: cursor !== null,
      parseItem: parseRunOperationReconciliation,
      itemBoundary: (event) => event.eventSequence,
      itemMatchesTarget: (event) =>
        event.runId === run.id && event.operationId === input.operationId,
    });

    return sanitizedResult(
      Object.freeze({
        kind: "reconciliations",
        run,
        operationId: input.operationId,
        reconciliations: page.items,
        total: page.total,
        nextCursor: reconciliationCursor(
          input.id,
          input.operationId,
          page.nextBoundary,
        ),
      }),
    );
  }
}
