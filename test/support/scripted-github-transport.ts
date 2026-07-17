import { types as utilTypes } from "node:util";
import type { RateLimitState } from "../../src/app/ports/github-port.js";
import {
  GRAPHQL_READ_DOCUMENTS,
  GRAPHQL_READ_OPERATIONS,
  REST_READ_OPERATIONS,
  type GitHubTransport,
  type GraphqlReadOperation,
  type GraphqlTransportError,
  type GraphqlTransportResponse,
  type RestReadOperation,
  type RestTransportResponse,
  type TransportHeaders,
} from "../../src/github/allowed-operations.js";

type RestPath<Operation extends RestReadOperation> =
  (typeof REST_READ_OPERATIONS)[Operation] extends `GET ${infer Path}`
    ? Path
    : never;

export type ScriptedRestStep = {
  [Operation in RestReadOperation]: Readonly<{
    kind: "rest";
    operation: Operation;
    method: "GET";
    path: RestPath<Operation>;
    status: number;
    data?: unknown;
    headers?: TransportHeaders;
  }>;
}[RestReadOperation];

export type ScriptedGraphqlStep = {
  [Operation in GraphqlReadOperation]: Readonly<{
    kind: "graphql";
    operation: Operation;
    graphqlOperation: (typeof GRAPHQL_READ_OPERATIONS)[Operation];
    status: number;
    data?: unknown;
    errors?: readonly GraphqlTransportError[];
    headers?: TransportHeaders;
    rateLimit?: RateLimitState | null;
  }>;
}[GraphqlReadOperation];

export type ScriptedGitHubStep = ScriptedRestStep | ScriptedGraphqlStep;

export type ScriptedRestRequest = {
  [Operation in RestReadOperation]: Readonly<{
    kind: "rest";
    operation: Operation;
    method: "GET";
    path: RestPath<Operation>;
    parameters: Readonly<Record<string, unknown>>;
  }>;
}[RestReadOperation];

export type ScriptedGraphqlRequest = {
  [Operation in GraphqlReadOperation]: Readonly<{
    kind: "graphql";
    operation: Operation;
    graphqlOperation: (typeof GRAPHQL_READ_OPERATIONS)[Operation];
    document: (typeof GRAPHQL_READ_DOCUMENTS)[Operation];
    variables: Readonly<Record<string, unknown>>;
  }>;
}[GraphqlReadOperation];

export type ScriptedGitHubRequest =
  | ScriptedRestRequest
  | ScriptedGraphqlRequest;

export interface ScriptedGitHubTransportHarness {
  readonly transport: GitHubTransport;
  readonly requests: readonly ScriptedGitHubRequest[];
  graphqlVariables(
    operation: GraphqlReadOperation,
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

  const priorCopy = copies.get(value);
  if (priorCopy !== undefined) return priorCopy;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9]\d*)$/u.test(key) ||
        Number(key) >= value.length
      ) {
        throw new InvalidFixtureValue();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new InvalidFixtureValue();
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        value: cloneFixtureValue(descriptor.value, copies),
        writable: true,
      });
    }
    copy.length = value.length;
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
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new InvalidFixtureValue();
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      value: cloneFixtureValue(descriptor.value, copies),
      writable: true,
    });
  }
  return Object.freeze(copy);
}

function copyAndFreeze<T>(value: T): T {
  try {
    return cloneFixtureValue(value, new WeakMap()) as T;
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

function isRestOperation(value: unknown): value is RestReadOperation {
  return (
    typeof value === "string" && Object.hasOwn(REST_READ_OPERATIONS, value)
  );
}

function isGraphqlOperation(value: unknown): value is GraphqlReadOperation {
  return (
    typeof value === "string" && Object.hasOwn(GRAPHQL_READ_OPERATIONS, value)
  );
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
    const route = REST_READ_OPERATIONS[step.operation];
    if (step.method !== "GET" || step.path !== route.slice(4)) {
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
    if (step.graphqlOperation !== GRAPHQL_READ_OPERATIONS[step.operation]) {
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
    return;
  }

  throw new Error(`Scripted GitHub transcript step ${index} is invalid`);
}

function requestLabel(
  kind: ScriptedGitHubRequest["kind"],
  operation: RestReadOperation | GraphqlReadOperation,
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
    operation: RestReadOperation | GraphqlReadOperation,
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
  };

  return {
    transport,
    get requests(): readonly ScriptedGitHubRequest[] {
      return copyAndFreeze(recordedRequests);
    },
    graphqlVariables(
      operation: GraphqlReadOperation,
      occurrence = 0,
    ): Readonly<Record<string, unknown>> {
      if (!Number.isInteger(occurrence) || occurrence < 0) {
        throw new Error("GraphQL occurrence must be a non-negative integer");
      }
      const request = recordedRequests
        .filter(
          (candidate): candidate is ScriptedGraphqlRequest =>
            candidate.kind === "graphql" && candidate.operation === operation,
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
