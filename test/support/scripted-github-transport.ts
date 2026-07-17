import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import type { RateLimitState } from "../../src/app/ports/github-port.js";
import { AppError } from "../../src/domain/errors.js";
import {
  GRAPHQL_MUTATION_DOCUMENTS,
  GRAPHQL_MUTATION_OPERATIONS,
  GRAPHQL_READ_DOCUMENTS,
  GRAPHQL_READ_OPERATIONS,
  REST_MUTATION_OPERATIONS,
  REST_READ_OPERATIONS,
  type GitHubTransport,
  type GraphqlMutationOperation,
  type GraphqlReadOperation,
  type GraphqlTransportError,
  type GraphqlTransportResponse,
  type RestMutationOperation,
  type RestReadOperation,
  type RestTransportResponse,
  type TransportHeaders,
} from "../../src/github/allowed-operations.js";
import { AmbiguousMutationError } from "../../src/github/errors.js";

type AnyRestOperation = RestReadOperation | RestMutationOperation;
type AnyGraphqlOperation = GraphqlReadOperation | GraphqlMutationOperation;

type RestRoute<Operation extends AnyRestOperation> =
  Operation extends RestReadOperation
    ? (typeof REST_READ_OPERATIONS)[Operation]
    : Operation extends RestMutationOperation
      ? (typeof REST_MUTATION_OPERATIONS)[Operation]
      : never;

type RestMethod<Operation extends AnyRestOperation> =
  RestRoute<Operation> extends `${infer Method} ${string}` ? Method : never;

type RestPath<Operation extends AnyRestOperation> =
  RestRoute<Operation> extends `${string} ${infer Path}` ? Path : never;

type GraphqlOperationName<Operation extends AnyGraphqlOperation> =
  Operation extends GraphqlReadOperation
    ? (typeof GRAPHQL_READ_OPERATIONS)[Operation]
    : Operation extends GraphqlMutationOperation
      ? (typeof GRAPHQL_MUTATION_OPERATIONS)[Operation]
      : never;

type GraphqlDocument<Operation extends AnyGraphqlOperation> =
  Operation extends GraphqlReadOperation
    ? (typeof GRAPHQL_READ_DOCUMENTS)[Operation]
    : Operation extends GraphqlMutationOperation
      ? (typeof GRAPHQL_MUTATION_DOCUMENTS)[Operation]
      : never;

export type ScriptedRestStep = {
  [Operation in AnyRestOperation]: Readonly<{
    kind: "rest";
    operation: Operation;
    method: RestMethod<Operation>;
    path: RestPath<Operation>;
    status: number;
    data?: unknown;
    headers?: TransportHeaders;
    resetAfterDispatch?: true;
    abortAfterDispatch?: true;
  }>;
}[AnyRestOperation];

export type ScriptedGraphqlStep = {
  [Operation in AnyGraphqlOperation]: Readonly<{
    kind: "graphql";
    operation: Operation;
    graphqlOperation: GraphqlOperationName<Operation>;
    status: number;
    data?: unknown;
    errors?: readonly GraphqlTransportError[];
    headers?: TransportHeaders;
    rateLimit?: RateLimitState | null;
    resetAfterDispatch?: true;
    abortAfterDispatch?: true;
  }>;
}[AnyGraphqlOperation];

export type ScriptedGitHubStep = ScriptedRestStep | ScriptedGraphqlStep;

export type ScriptedRestRequest = {
  [Operation in AnyRestOperation]: Readonly<{
    kind: "rest";
    operation: Operation;
    method: RestMethod<Operation>;
    path: RestPath<Operation>;
    parameters: Readonly<Record<string, unknown>>;
    operationId?: string;
  }>;
}[AnyRestOperation];

export type ScriptedGraphqlRequest = {
  [Operation in AnyGraphqlOperation]: Readonly<{
    kind: "graphql";
    operation: Operation;
    graphqlOperation: GraphqlOperationName<Operation>;
    document: GraphqlDocument<Operation>;
    variables: Readonly<Record<string, unknown>>;
    operationId?: string;
  }>;
}[AnyGraphqlOperation];

export type ScriptedGitHubRequest =
  | ScriptedRestRequest
  | ScriptedGraphqlRequest;

export interface ScriptedGitHubTransportHarness {
  readonly transport: GitHubTransport;
  readonly requests: readonly ScriptedGitHubRequest[];
  graphqlVariables(
    operation: string,
    occurrence?: number,
  ): Readonly<Record<string, unknown>>;
  graphqlDocuments(): readonly string[];
  assertExhausted(): void;
}

const FIXTURE_VALUE_ERROR =
  "Scripted GitHub transport accepts data properties on plain fixture values only";

class InvalidFixtureValue extends Error {}

function cloneFixtureValue(
  value: unknown,
  copies: WeakMap<object, unknown>,
  active: WeakSet<object>,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value !== "object") throw new InvalidFixtureValue();
  if (utilTypes.isProxy(value)) throw new InvalidFixtureValue();
  if (active.has(value)) throw new InvalidFixtureValue();

  const priorCopy = copies.get(value);
  if (priorCopy !== undefined) return priorCopy;
  active.add(value);

  if (Array.isArray(value)) {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) {
      throw new InvalidFixtureValue();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length !== value.length + 1
    ) {
      throw new InvalidFixtureValue();
    }
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        throw new InvalidFixtureValue();
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: cloneFixtureValue(descriptor.value, copies, active),
        writable: true,
      });
    }
    copy.length = value.length;
    active.delete(value);
    return Object.freeze(copy);
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidFixtureValue();
  }

  const copy =
    prototype === null
      ? (Object.create(null) as Record<PropertyKey, unknown>)
      : ({} as Record<PropertyKey, unknown>);
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new InvalidFixtureValue();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw new InvalidFixtureValue();
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: cloneFixtureValue(descriptor.value, copies, active),
      writable: true,
    });
  }
  active.delete(value);
  return Object.freeze(copy);
}

function copyAndFreeze<T>(value: T): T {
  try {
    return cloneFixtureValue(value, new WeakMap(), new WeakSet()) as T;
  } catch {
    throw new Error(FIXTURE_VALUE_ERROR);
  }
}

const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "token",
  "accesstoken",
  "githubtoken",
  "ghtoken",
  "cookie",
  "setcookie",
  "password",
  "secret",
]);

function normalizedSensitiveName(name: string): string {
  return name.toLowerCase().replaceAll("-", "").replaceAll("_", "");
}

function containsSensitiveField(
  value: unknown,
  visited = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value !== "object") return false;
  if (visited.has(value)) return false;
  visited.add(value);

  for (const key of Object.getOwnPropertyNames(value)) {
    if (SENSITIVE_FIELD_NAMES.has(normalizedSensitiveName(key))) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      containsSensitiveField(descriptor.value, visited)
    ) {
      return true;
    }
  }
  return false;
}

function copyRequestFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const copy = copyAndFreeze(fields);
  if (containsSensitiveField(copy)) {
    throw new Error(
      "Scripted GitHub transport refused credential-bearing request fields",
    );
  }
  return copy;
}

function fixedAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  let aborted: boolean;
  try {
    aborted = signal.aborted;
  } catch {
    throw fixedAbortError();
  }
  if (aborted) throw fixedAbortError();
}

function scriptedMutationValidation(operation: string): AppError {
  return new AppError(
    "VALIDATION_ERROR",
    "Scripted GitHub mutation input is invalid",
    {
      retryable: false,
      details: { operation, reason: "invalid_input" },
    },
  );
}

function scriptedMutationCancelled(operation: string): AppError {
  return new AppError("GITHUB_UNAVAILABLE", "GitHub request was cancelled", {
    retryable: false,
    details: { operation, reason: "cancelled" },
  });
}

function assertMutationNotAborted(
  signal: AbortSignal | undefined,
  operation: string,
): void {
  if (signal === undefined) return;
  try {
    if (!signal.aborted) return;
  } catch {
    throw scriptedMutationCancelled(operation);
  }
  throw scriptedMutationCancelled(operation);
}

function scriptedStableText(
  value: unknown,
  maximum = 128,
  trimEqual = true,
): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    (trimEqual && value !== value.trim())
  ) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return null;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    }
  }
  return value;
}

function scriptedDescription(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 1_024) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return undefined;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
  }
  return value;
}

function exactRequestKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.size &&
    ownKeys.every((key) => typeof key === "string" && keys.has(key))
  );
}

function copyScriptedRestMutationParameters(
  operation: RestMutationOperation,
  parameters: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let copied: Readonly<Record<string, unknown>>;
  try {
    copied = copyRequestFields(parameters);
  } catch {
    throw scriptedMutationValidation(operation);
  }
  const owner = scriptedStableText(copied.owner);
  const repo = scriptedStableText(copied.repo);
  if (
    !exactRequestKeys(copied, new Set(["owner", "repo"])) ||
    owner === null ||
    repo === null ||
    /[/\\?#]/u.test(owner) ||
    /[/\\?#]/u.test(repo)
  ) {
    throw scriptedMutationValidation(operation);
  }
  return copyAndFreeze({ owner, repo });
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function scriptedMembershipIds(
  value: unknown,
  operation: GraphqlMutationOperation,
): readonly string[] {
  if (!Array.isArray(value) || value.length > 5_000) {
    throw scriptedMutationValidation(operation);
  }
  const ids = value.map((candidate) => {
    const id = scriptedStableText(candidate);
    if (id === null) throw scriptedMutationValidation(operation);
    return id;
  });
  ids.sort(utf8Compare);
  return Object.freeze([...new Set(ids)]);
}

function copyScriptedGraphqlMutationVariables(
  operation: GraphqlMutationOperation,
  variables: Readonly<Record<string, unknown>>,
  operationId: string,
): Readonly<Record<string, unknown>> {
  let copied: Readonly<Record<string, unknown>>;
  try {
    copied = copyRequestFields(variables);
  } catch {
    throw scriptedMutationValidation(operation);
  }
  if (copied.clientMutationId !== operationId) {
    throw scriptedMutationValidation(operation);
  }
  if (operation === "createUserList") {
    const name = scriptedStableText(copied.name, 100, false);
    const description = scriptedDescription(copied.description);
    if (
      !exactRequestKeys(
        copied,
        new Set(["name", "description", "isPrivate", "clientMutationId"]),
      ) ||
      name === null ||
      description === undefined ||
      typeof copied.isPrivate !== "boolean"
    ) {
      throw scriptedMutationValidation(operation);
    }
    return copyAndFreeze({
      name,
      description,
      isPrivate: copied.isPrivate,
      clientMutationId: operationId,
    });
  }
  if (operation === "updateUserList") {
    const keys = Reflect.ownKeys(copied);
    const allowed = new Set([
      "listId",
      "name",
      "description",
      "isPrivate",
      "clientMutationId",
    ]);
    const listId = scriptedStableText(copied.listId);
    if (
      keys.length < 3 ||
      keys.length > 5 ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      listId === null ||
      (!Object.hasOwn(copied, "name") &&
        !Object.hasOwn(copied, "description") &&
        !Object.hasOwn(copied, "isPrivate"))
    ) {
      throw scriptedMutationValidation(operation);
    }
    const name = Object.hasOwn(copied, "name")
      ? scriptedStableText(copied.name, 100, false)
      : undefined;
    const description = Object.hasOwn(copied, "description")
      ? scriptedDescription(copied.description)
      : undefined;
    if (
      (Object.hasOwn(copied, "name") && name === null) ||
      (Object.hasOwn(copied, "description") && description === undefined) ||
      (Object.hasOwn(copied, "isPrivate") &&
        typeof copied.isPrivate !== "boolean")
    ) {
      throw scriptedMutationValidation(operation);
    }
    return copyAndFreeze({
      listId,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(Object.hasOwn(copied, "isPrivate")
        ? { isPrivate: copied.isPrivate }
        : {}),
      clientMutationId: operationId,
    });
  }
  if (operation === "deleteUserList") {
    const listId = scriptedStableText(copied.listId);
    if (
      !exactRequestKeys(copied, new Set(["listId", "clientMutationId"])) ||
      listId === null
    ) {
      throw scriptedMutationValidation(operation);
    }
    return copyAndFreeze({ listId, clientMutationId: operationId });
  }
  const itemId = scriptedStableText(copied.itemId);
  if (
    !exactRequestKeys(
      copied,
      new Set(["itemId", "listIds", "clientMutationId"]),
    ) ||
    itemId === null
  ) {
    throw scriptedMutationValidation(operation);
  }
  return copyAndFreeze({
    itemId,
    listIds: scriptedMembershipIds(copied.listIds, operation),
    clientMutationId: operationId,
  });
}

function resetAfterDispatchCause(): Error {
  const cause = new Error("scripted mutation outcome is unknown");
  Object.defineProperty(cause, "code", {
    configurable: false,
    enumerable: false,
    value: "ECONNRESET",
    writable: false,
  });
  return cause;
}

function throwScriptedDispatchFailure(
  step: ScriptedGitHubStep,
  operation: RestMutationOperation | GraphqlMutationOperation,
  operationId: string,
): void {
  if (step.resetAfterDispatch === true) {
    throw new AmbiguousMutationError(
      operationId,
      operation,
      resetAfterDispatchCause(),
    );
  }
  if (step.abortAfterDispatch === true) {
    throw new AmbiguousMutationError(operationId, operation, fixedAbortError());
  }
}

function headersRecord(value: unknown): value is TransportHeaders {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (headerValue) =>
      typeof headerValue === "string" || headerValue === undefined,
  );
}

function normalizeHeaders(value: unknown): TransportHeaders {
  if (value === undefined) return Object.freeze({});
  if (!headersRecord(value)) {
    throw new Error("Scripted GitHub transcript contains invalid headers");
  }

  const normalized: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  for (const [name, headerValue] of Object.entries(value)) {
    if (SENSITIVE_FIELD_NAMES.has(normalizedSensitiveName(name))) {
      throw new Error(
        "Scripted GitHub transcript contains credential-bearing headers",
      );
    }
    const lowerName = name.toLowerCase();
    if (seen.has(lowerName)) {
      throw new Error(
        "Scripted GitHub transcript contains colliding header names",
      );
    }
    seen.add(lowerName);
    Object.defineProperty(normalized, lowerName, {
      configurable: true,
      enumerable: true,
      value: headerValue,
      writable: true,
    });
  }
  return copyAndFreeze(normalized);
}

function isRestReadOperation(value: unknown): value is RestReadOperation {
  return (
    typeof value === "string" && Object.hasOwn(REST_READ_OPERATIONS, value)
  );
}

function isRestMutationOperation(
  value: unknown,
): value is RestMutationOperation {
  return (
    typeof value === "string" && Object.hasOwn(REST_MUTATION_OPERATIONS, value)
  );
}

function isRestOperation(value: unknown): value is AnyRestOperation {
  return isRestReadOperation(value) || isRestMutationOperation(value);
}

function isGraphqlReadOperation(value: unknown): value is GraphqlReadOperation {
  return (
    typeof value === "string" && Object.hasOwn(GRAPHQL_READ_OPERATIONS, value)
  );
}

function isGraphqlMutationOperation(
  value: unknown,
): value is GraphqlMutationOperation {
  return (
    typeof value === "string" &&
    Object.hasOwn(GRAPHQL_MUTATION_OPERATIONS, value)
  );
}

function isGraphqlOperation(value: unknown): value is AnyGraphqlOperation {
  return isGraphqlReadOperation(value) || isGraphqlMutationOperation(value);
}

function restRoute(operation: AnyRestOperation): string {
  return isRestReadOperation(operation)
    ? REST_READ_OPERATIONS[operation]
    : REST_MUTATION_OPERATIONS[operation];
}

function graphqlOperationName(operation: AnyGraphqlOperation): string {
  return isGraphqlReadOperation(operation)
    ? GRAPHQL_READ_OPERATIONS[operation]
    : GRAPHQL_MUTATION_OPERATIONS[operation];
}

function isValidStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function hasExactFields(
  value: object,
  allowedFields: ReadonlySet<string>,
): boolean {
  return Object.getOwnPropertyNames(value).every((key) =>
    allowedFields.has(key),
  );
}

const REST_STEP_FIELDS = new Set([
  "kind",
  "operation",
  "method",
  "path",
  "status",
  "data",
  "headers",
  "resetAfterDispatch",
  "abortAfterDispatch",
]);
const GRAPHQL_STEP_FIELDS = new Set([
  "kind",
  "operation",
  "graphqlOperation",
  "status",
  "data",
  "errors",
  "headers",
  "rateLimit",
  "resetAfterDispatch",
  "abortAfterDispatch",
]);

function validGraphqlErrors(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return (value as readonly unknown[]).every((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !hasExactFields(candidate, new Set(["message", "type", "path"]))
    ) {
      return false;
    }
    const error = candidate as Partial<GraphqlTransportError>;
    return (
      typeof error.message === "string" &&
      (error.type === null || typeof error.type === "string") &&
      (error.path === null ||
        (Array.isArray(error.path) &&
          error.path.every(
            (part) => typeof part === "string" || typeof part === "number",
          )))
    );
  });
}

function validRateLimit(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (
    typeof value !== "object" ||
    !hasExactFields(value, new Set(["remaining", "resetAt"]))
  ) {
    return false;
  }
  const state = value as Partial<RateLimitState>;
  return (
    typeof state.remaining === "number" &&
    Number.isInteger(state.remaining) &&
    state.remaining >= 0 &&
    typeof state.resetAt === "string"
  );
}

function validDispatchFailureFlags(
  step: ScriptedGitHubStep,
  mutation: boolean,
): boolean {
  const reset = step.resetAfterDispatch;
  const abort = step.abortAfterDispatch;
  return (
    (reset === undefined || reset === true) &&
    (abort === undefined || abort === true) &&
    !(reset === true && abort === true) &&
    (mutation || (reset === undefined && abort === undefined))
  );
}

function validateTranscriptStep(step: ScriptedGitHubStep, index: number): void {
  if (step === null || typeof step !== "object") {
    throw new Error(`Scripted GitHub transcript step ${index} is invalid`);
  }

  if (step.kind === "rest") {
    if (!isRestOperation(step.operation)) {
      throw new Error(
        `Scripted GitHub transcript step ${index} has an invalid REST operation`,
      );
    }
    if (!hasExactFields(step, REST_STEP_FIELDS)) {
      throw new Error(
        `Scripted GitHub transcript rest:${step.operation} has unrecognized fields`,
      );
    }
    const route = restRoute(step.operation);
    const separator = route.indexOf(" ");
    if (
      separator < 1 ||
      step.method !== route.slice(0, separator) ||
      step.path !== route.slice(separator + 1)
    ) {
      throw new Error(
        `Scripted GitHub transcript route does not match rest:${step.operation}`,
      );
    }
    if (!isValidStatus(step.status)) {
      throw new Error(
        `Scripted GitHub transcript rest:${step.operation} has an invalid status`,
      );
    }
    normalizeHeaders(step.headers);
    if (
      !validDispatchFailureFlags(step, isRestMutationOperation(step.operation))
    ) {
      throw new Error(
        `Scripted GitHub transcript rest:${step.operation} has an invalid dispatch failure`,
      );
    }
    return;
  }

  if (step.kind === "graphql") {
    if (!isGraphqlOperation(step.operation)) {
      throw new Error(
        `Scripted GitHub transcript step ${index} has an invalid GraphQL operation`,
      );
    }
    if (!hasExactFields(step, GRAPHQL_STEP_FIELDS)) {
      throw new Error(
        `Scripted GitHub transcript graphql:${step.operation} has unrecognized fields`,
      );
    }
    if (step.graphqlOperation !== graphqlOperationName(step.operation)) {
      throw new Error(
        `Scripted GitHub transcript document does not match graphql:${step.operation}`,
      );
    }
    if (!isValidStatus(step.status)) {
      throw new Error(
        `Scripted GitHub transcript graphql:${step.operation} has an invalid status`,
      );
    }
    normalizeHeaders(step.headers);
    if (!validGraphqlErrors(step.errors) || !validRateLimit(step.rateLimit)) {
      throw new Error(
        `Scripted GitHub transcript graphql:${step.operation} has an invalid envelope`,
      );
    }
    if (
      !validDispatchFailureFlags(
        step,
        isGraphqlMutationOperation(step.operation),
      )
    ) {
      throw new Error(
        `Scripted GitHub transcript graphql:${step.operation} has an invalid dispatch failure`,
      );
    }
    return;
  }

  throw new Error(`Scripted GitHub transcript step ${index} is invalid`);
}

function requestLabel(
  kind: ScriptedGitHubRequest["kind"],
  operation: AnyRestOperation | AnyGraphqlOperation,
): string {
  return `${kind}:${operation}`;
}

export function createScriptedGitHubTransport(
  transcript: readonly ScriptedGitHubStep[],
): ScriptedGitHubTransportHarness {
  if (utilTypes.isProxy(transcript)) {
    throw new Error(FIXTURE_VALUE_ERROR);
  }
  for (let index = 0; index < transcript.length; index += 1) {
    if (!Object.hasOwn(transcript, index)) {
      throw new Error("Scripted GitHub transcript must be a dense array");
    }
  }
  const copiedTranscript = copyAndFreeze(transcript);
  for (let index = 0; index < copiedTranscript.length; index += 1) {
    validateTranscriptStep(copiedTranscript[index]!, index);
  }
  const queue = [...copiedTranscript];
  const recordedRequests: ScriptedGitHubRequest[] = [];

  function consumeStep(
    kind: ScriptedGitHubRequest["kind"],
    operation: AnyRestOperation | AnyGraphqlOperation,
  ): ScriptedGitHubStep {
    const received = requestLabel(kind, operation);
    if (queue.length === 0) {
      throw new Error(
        `Scripted GitHub transport is exhausted; received ${received}`,
      );
    }
    const step = queue[0]!;
    const expected = requestLabel(step.kind, step.operation);
    if (step.kind !== kind || step.operation !== operation) {
      throw new Error(
        `Scripted GitHub transport expected ${expected} but received ${received}`,
      );
    }
    queue.shift();
    return step;
  }

  const transport: GitHubTransport = {
    rest<T>(
      operation: RestReadOperation,
      parameters: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<RestTransportResponse<T>> {
      return Promise.resolve().then(() => {
        assertNotAborted(signal);
        const copiedParameters = copyRequestFields(parameters);
        const route = REST_READ_OPERATIONS[operation];
        const request = copyAndFreeze({
          kind: "rest",
          operation,
          method: "GET",
          path: route.slice(4),
          parameters: copiedParameters,
        }) as ScriptedRestRequest;
        recordedRequests.push(request);

        const step = consumeStep("rest", operation);
        if (step.kind !== "rest") {
          throw new Error("Scripted GitHub transport internal kind mismatch");
        }
        return copyAndFreeze({
          data: step.data as T,
          status: step.status,
          headers: normalizeHeaders(step.headers),
        });
      });
    },

    graphql<T>(
      operation: GraphqlReadOperation,
      variables: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<GraphqlTransportResponse<T>> {
      return Promise.resolve().then(() => {
        assertNotAborted(signal);
        const copiedVariables = copyRequestFields(variables);
        const request = copyAndFreeze({
          kind: "graphql",
          operation,
          graphqlOperation: GRAPHQL_READ_OPERATIONS[operation],
          document: GRAPHQL_READ_DOCUMENTS[operation],
          variables: copiedVariables,
        }) as ScriptedGraphqlRequest;
        recordedRequests.push(request);

        const step = consumeStep("graphql", operation);
        if (step.kind !== "graphql") {
          throw new Error("Scripted GitHub transport internal kind mismatch");
        }
        return copyAndFreeze({
          data: (step.data ?? null) as T | null,
          errors: step.errors ?? [],
          status: step.status,
          headers: normalizeHeaders(step.headers),
          rateLimit: step.rateLimit ?? null,
        });
      });
    },

    restMutation<T>(
      operation: RestMutationOperation,
      parameters: Readonly<Record<string, unknown>>,
      operationId: string,
      signal?: AbortSignal,
    ): Promise<RestTransportResponse<T>> {
      return Promise.resolve().then(() => {
        if (!isRestMutationOperation(operation)) {
          throw scriptedMutationValidation("transport");
        }
        assertMutationNotAborted(signal, operation);
        const copiedOperationId = scriptedStableText(operationId);
        if (copiedOperationId === null) {
          throw scriptedMutationValidation(operation);
        }
        const copiedParameters = copyScriptedRestMutationParameters(
          operation,
          parameters,
        );
        const route = REST_MUTATION_OPERATIONS[operation];
        const separator = route.indexOf(" ");
        const request = copyAndFreeze({
          kind: "rest",
          operation,
          method: route.slice(0, separator),
          path: route.slice(separator + 1),
          parameters: copiedParameters,
          operationId: copiedOperationId,
        }) as ScriptedRestRequest;
        recordedRequests.push(request);

        const step = consumeStep("rest", operation);
        if (step.kind !== "rest" || !isRestMutationOperation(step.operation)) {
          throw new Error("Scripted GitHub transport internal kind mismatch");
        }
        throwScriptedDispatchFailure(step, operation, copiedOperationId);
        return copyAndFreeze({
          data: step.data as T,
          status: step.status,
          headers: normalizeHeaders(step.headers),
        });
      });
    },

    graphqlMutation<T>(
      operation: GraphqlMutationOperation,
      variables: Readonly<Record<string, unknown>>,
      operationId: string,
      signal?: AbortSignal,
    ): Promise<GraphqlTransportResponse<T>> {
      return Promise.resolve().then(() => {
        if (!isGraphqlMutationOperation(operation)) {
          throw scriptedMutationValidation("transport");
        }
        assertMutationNotAborted(signal, operation);
        const copiedOperationId = scriptedStableText(operationId);
        if (copiedOperationId === null) {
          throw scriptedMutationValidation(operation);
        }
        const copiedVariables = copyScriptedGraphqlMutationVariables(
          operation,
          variables,
          copiedOperationId,
        );
        const request = copyAndFreeze({
          kind: "graphql",
          operation,
          graphqlOperation: GRAPHQL_MUTATION_OPERATIONS[operation],
          document: GRAPHQL_MUTATION_DOCUMENTS[operation],
          variables: copiedVariables,
          operationId: copiedOperationId,
        }) as ScriptedGraphqlRequest;
        recordedRequests.push(request);

        const step = consumeStep("graphql", operation);
        if (
          step.kind !== "graphql" ||
          !isGraphqlMutationOperation(step.operation)
        ) {
          throw new Error("Scripted GitHub transport internal kind mismatch");
        }
        throwScriptedDispatchFailure(step, operation, copiedOperationId);
        return copyAndFreeze({
          data: (step.data ?? null) as T | null,
          errors: step.errors ?? [],
          status: step.status,
          headers: normalizeHeaders(step.headers),
          rateLimit: step.rateLimit ?? null,
        });
      });
    },
  };

  return {
    transport,
    get requests(): readonly ScriptedGitHubRequest[] {
      return copyAndFreeze(recordedRequests);
    },
    graphqlVariables(
      operation: string,
      occurrence = 0,
    ): Readonly<Record<string, unknown>> {
      if (!Number.isInteger(occurrence) || occurrence < 0) {
        throw new Error("GraphQL occurrence must be a non-negative integer");
      }
      const request = recordedRequests
        .filter(
          (candidate): candidate is ScriptedGraphqlRequest =>
            candidate.kind === "graphql" &&
            (candidate.operation === operation ||
              candidate.graphqlOperation === operation),
        )
        .at(occurrence);
      if (request === undefined) {
        throw new Error(
          `No recorded GraphQL request for ${operation} occurrence ${occurrence}`,
        );
      }
      return copyAndFreeze(request.variables);
    },
    graphqlDocuments(): readonly string[] {
      return copyAndFreeze(
        recordedRequests
          .filter(
            (request): request is ScriptedGraphqlRequest =>
              request.kind === "graphql",
          )
          .map((request) => request.document),
      );
    },
    assertExhausted(): void {
      if (queue.length === 0) return;
      const step = queue[0]!;
      const count = queue.length;
      throw new Error(
        `Scripted GitHub transport has ${count} unused ${
          count === 1 ? "step" : "steps"
        }; next is ${requestLabel(step.kind, step.operation)}`,
      );
    },
  };
}
