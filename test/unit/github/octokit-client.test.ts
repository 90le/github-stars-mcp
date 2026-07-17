import { readFile } from "node:fs/promises";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type { Credential } from "../../../src/auth/credential-provider.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import {
  GRAPHQL_READ_DOCUMENTS,
  type GitHubTransport,
} from "../../../src/github/allowed-operations.js";
import {
  createOctokitTransport,
  type OctokitTransportRuntime,
} from "../../../src/github/octokit-client.js";
import { RateGate } from "../../../src/github/rate-gate.js";
import { PACKAGE_VERSION } from "../../../src/version.js";

const TOKEN = "github_pat_raw-secret-token";
const WALL_NOW = Date.parse("2026-07-18T00:00:00.000Z");

interface RecordedFetch {
  readonly url: string;
  readonly method: string;
  readonly redirect: RequestRedirect | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

type FetchStep =
  | (() => Response | Promise<Response>)
  | ((
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Response | Promise<Response>);

function testCredential(): Credential {
  const value = { source: "GITHUB_STARS_TOKEN" } as {
    token: string;
    source: "GITHUB_STARS_TOKEN";
  };
  Object.defineProperty(value, "token", {
    configurable: false,
    enumerable: false,
    value: TOKEN,
    writable: false,
  });
  return Object.freeze(value);
}

function jsonResponse(
  status: number,
  data: unknown,
  headers: Readonly<Record<string, string>> = {},
  responseUrl = "",
): Response {
  const response = new Response(
    status === 204 || status === 304 ? null : JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
    },
  );
  if (responseUrl !== "") {
    Object.defineProperty(response, "url", {
      configurable: false,
      value: responseUrl,
    });
  }
  return response;
}

function rawBodyResponse(status: number, data: unknown): Response {
  return {
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    body: null,
    headers: new Headers(),
    redirected: false,
    status,
    statusText: "",
    text: () => Promise.resolve(data as string),
    url: "",
  } as unknown as Response;
}

function fetchHarness(steps: readonly FetchStep[], randoms: number[] = [0]) {
  const queue = [...steps];
  const requests: RecordedFetch[] = [];
  const waits: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    expect(authorization).toContain(TOKEN);
    requests.push({
      url,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      headers: Object.freeze({
        accept: headers.get("accept") ?? "",
        authorization: "[REDACTED]",
        "user-agent": headers.get("user-agent") ?? "",
        "x-github-api-version": headers.get("x-github-api-version") ?? "",
      }),
      body: typeof init?.body === "string" ? init.body : null,
    });

    const step = queue.shift();
    if (step === undefined) throw new Error("No scripted fetch response");
    return step(input, init);
  };
  const runtime: OctokitTransportRuntime = {
    fetch,
    random: () => randoms.shift() ?? 0,
    wait: (delayMs, signal) => {
      if (signal?.aborted === true) {
        return Promise.reject(new Error("raw-abort-reason"));
      }
      waits.push(delayMs);
      return Promise.resolve();
    },
  };
  return {
    runtime,
    requests,
    waits,
    remainingSteps: () => queue.length,
  };
}

function gateHarness() {
  let monotonicMs = 1_000;
  let wallOffsetMs = 0;
  const waits: number[] = [];
  const gate = new RateGate({
    wallNowMs: () => Date.now() + wallOffsetMs,
    monotonicNowMs: () => monotonicMs,
    wait: (delayMs) => {
      waits.push(delayMs);
      monotonicMs += delayMs;
      wallOffsetMs += delayMs;
      return Promise.resolve();
    },
  });
  return { gate, waits };
}

function transportHarness(
  steps: readonly FetchStep[],
  randoms: number[] = [0],
): {
  readonly transport: GitHubTransport;
  readonly requests: RecordedFetch[];
  readonly waits: number[];
  readonly gate: RateGate;
  readonly gateWaits: number[];
  readonly remainingSteps: () => number;
} {
  const fetches = fetchHarness(steps, randoms);
  const rate = gateHarness();
  return {
    transport: createOctokitTransport(
      testCredential(),
      PACKAGE_VERSION,
      rate.gate,
      fetches.runtime,
    ),
    requests: fetches.requests,
    waits: fetches.waits,
    gate: rate.gate,
    gateWaits: rate.waits,
    remainingSteps: fetches.remainingSteps,
  };
}

function codedNetworkFailure(code: string): () => never {
  return () => {
    const cause = new Error(`raw-network-cause-${TOKEN}`);
    Object.defineProperty(cause, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: true,
    });
    throw new TypeError(`raw-network-wrapper-${TOKEN}`, { cause });
  };
}

async function caught(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

function accessorObject(
  key: string,
  base: Readonly<Record<string, unknown>> = {},
): object {
  const value = { ...base };
  Object.defineProperty(value, key, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(`raw-accessor-${TOKEN}`);
    },
  });
  return value;
}

function customPrototypeObject(
  values: Readonly<Record<string, unknown>>,
): object {
  return Object.assign(Object.create({ inherited: true }) as object, values);
}

function hostileProxy(): object {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`raw-proxy-${TOKEN}`);
      },
    },
  );
}

function sparseArray(length: number): unknown[] {
  return new Array<unknown>(length);
}

function accessorArray(): unknown[] {
  const value = ["placeholder"];
  Object.defineProperty(value, "0", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(`raw-array-accessor-${TOKEN}`);
    },
  });
  return value;
}

function customPrototypeArray(values: unknown[]): unknown[] {
  Object.setPrototypeOf(values, { hostile: true });
  return values;
}

function revokedArrayProxy(): unknown[] {
  const revocable = Proxy.revocable<unknown[]>([], {});
  revocable.revoke();
  return revocable.proxy;
}

describe("Octokit GitHub transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pins every named route, fixed document, origin, redirect mode, and headers", async () => {
    const harness = transportHarness([
      () => jsonResponse(200, { login: "octo" }),
      () => jsonResponse(200, []),
      () => jsonResponse(200, { content: "" }),
      () =>
        jsonResponse(200, {
          items: [],
          total_count: 0,
          incomplete_results: false,
        }),
      () => jsonResponse(200, { data: { viewer: { lists: null } } }),
      () => jsonResponse(200, { data: { node: null } }),
    ]);

    await harness.transport.rest("getViewer", {});
    await harness.transport.rest("listStars", { page: 2, per_page: 100 });
    await harness.transport.rest("getReadme", {
      owner: "space owner",
      repo: "tool",
    });
    await harness.transport.rest("searchRepositories", {
      q: "language:typescript",
      sort: "stars",
      order: "desc",
      page: 1,
      per_page: 10,
    });
    await harness.transport.graphql("listLists", { cursor: null });
    await harness.transport.graphql("listItems", {
      listId: "UL_1",
      cursor: "cursor-1",
    });

    expect(
      harness.requests.map(({ url, method, redirect }) => ({
        url,
        method,
        redirect,
      })),
    ).toEqual([
      {
        url: "https://api.github.com/user",
        method: "GET",
        redirect: "error",
      },
      {
        url: "https://api.github.com/user/starred?page=2&per_page=100",
        method: "GET",
        redirect: "error",
      },
      {
        url: "https://api.github.com/repos/space%20owner/tool/readme",
        method: "GET",
        redirect: "error",
      },
      {
        url: "https://api.github.com/search/repositories?q=language%3Atypescript&sort=stars&order=desc&page=1&per_page=10",
        method: "GET",
        redirect: "error",
      },
      {
        url: "https://api.github.com/graphql",
        method: "POST",
        redirect: "error",
      },
      {
        url: "https://api.github.com/graphql",
        method: "POST",
        redirect: "error",
      },
    ]);
    for (const [index, request] of harness.requests.entries()) {
      expect(request.headers).toMatchObject({
        authorization: "[REDACTED]",
        "user-agent": `github-stars-mcp/${PACKAGE_VERSION}`,
        "x-github-api-version": "2026-03-10",
      });
      expect(request.headers.accept).toBe(
        index === 1
          ? "application/vnd.github.star+json"
          : "application/vnd.github+json",
      );
      expect(JSON.stringify(request)).not.toContain(TOKEN);
    }
    const graphqlBodies = harness.requests
      .filter((request) => request.url.endsWith("/graphql"))
      .map(
        (request) =>
          JSON.parse(request.body ?? "{}") as {
            query?: string;
          },
      );
    expect(graphqlBodies.map((body) => body.query)).toEqual([
      GRAPHQL_READ_DOCUMENTS.listLists,
      GRAPHQL_READ_DOCUMENTS.listItems,
    ]);
  });

  it.each(["0.1.1", "0.1.0\r\nX-Evil: yes"])(
    "rejects invalid package version %s before construction can dispatch",
    (version) => {
      const fetches = fetchHarness([() => jsonResponse(200, {})]);
      const rate = gateHarness();

      expect(() =>
        createOctokitTransport(
          testCredential(),
          version,
          rate.gate,
          fetches.runtime,
        ),
      ).toThrow(AppError);
      expect(fetches.requests).toEqual([]);
    },
  );

  it("rejects a caller origin/path override before physical dispatch", async () => {
    const harness = transportHarness([() => jsonResponse(200, {})]);

    const error = await caught(
      harness.transport.rest("getViewer", {
        baseUrl: "https://evil.example",
        url: "/steal",
      }),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(error.details).toMatchObject({ reason: "origin_rejected" });
    expect(harness.requests).toEqual([]);
  });

  it.each([
    ["unknown", "unknownOperation"],
    ["prototype", "__proto__"],
    ["constructor", "constructor"],
    ["method", "toString"],
    ["credential-like", TOKEN],
    ["number", 1],
    ["symbol", Symbol("operation")],
    ["object", Object.freeze({ operation: "getViewer" })],
    [
      "hostile proxy",
      new Proxy(
        {},
        {
          get() {
            throw new Error(`raw-operation-${TOKEN}`);
          },
        },
      ),
    ],
  ] as const)(
    "rejects non-allowlisted REST operation %s before physical dispatch",
    async (_label, operation) => {
      const harness = transportHarness([() => jsonResponse(200, {})]);

      const error = await caught(
        harness.transport.rest(operation as never, {
          q: `must-not-leak-${TOKEN}`,
        }),
      );

      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
        details: {
          operation: "transport",
          reason: "invalid_parameters",
        },
      });
      expect(harness.requests).toEqual([]);
      expect(harness.remainingSteps()).toBe(1);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it.each([
    ["primitive data", () => ({ data: "invalid", message: "server failure" })],
    [
      "custom data prototype",
      () => ({
        data: customPrototypeObject({ rateLimit: null }),
        message: "server failure",
      }),
    ],
    ["proxy data", () => ({ data: hostileProxy(), message: "server failure" })],
    [
      "data accessor",
      () => accessorObject("data", { message: "server failure" }),
    ],
    [
      "rate-limit accessor",
      () => ({
        data: accessorObject("rateLimit"),
        message: "server failure",
      }),
    ],
    [
      "custom rate-limit prototype",
      () => ({
        data: {
          rateLimit: customPrototypeObject({
            remaining: 1,
            resetAt: new Date(WALL_NOW + 60_000).toISOString(),
          }),
        },
        message: "server failure",
      }),
    ],
    [
      "proxy rate-limit",
      () => ({
        data: { rateLimit: hostileProxy() },
        message: "server failure",
      }),
    ],
  ] as const)(
    "rejects present malformed GraphQL HTTP failure %s without retry",
    async (_label, createBody) => {
      const harness = transportHarness([
        () => rawBodyResponse(500, createBody()),
        () => jsonResponse(200, { data: {} }),
      ]);

      const error = await caught(
        harness.transport.graphql("listLists", { cursor: null }),
      );

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: {
          operation: "listLists",
          reason: "malformed_envelope",
        },
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.remainingSteps()).toBe(1);
      expect(harness.waits).toEqual([]);
    },
  );

  it("rejects present malformed REST failure rate metadata without retry", async () => {
    const harness = transportHarness([
      () =>
        jsonResponse(
          500,
          { message: "server failure" },
          {
            "x-ratelimit-remaining": "invalid",
            "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
          },
        ),
      () => jsonResponse(200, {}),
    ]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: {
        operation: "getViewer",
        reason: "malformed_envelope",
      },
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.remainingSteps()).toBe(1);
    expect(harness.waits).toEqual([]);
  });

  it.each([
    ["unknown", "unknownOperation"],
    ["prototype", "__proto__"],
    ["constructor", "constructor"],
    ["method", "toString"],
    ["credential-like", TOKEN],
    ["number", 1],
    ["symbol", Symbol("operation")],
    ["object", Object.freeze({ operation: "listLists" })],
    [
      "hostile proxy",
      new Proxy(
        {},
        {
          get() {
            throw new Error(`raw-operation-${TOKEN}`);
          },
        },
      ),
    ],
  ] as const)(
    "rejects non-allowlisted GraphQL operation %s before physical dispatch",
    async (_label, operation) => {
      const harness = transportHarness([() => jsonResponse(200, {})]);

      const error = await caught(
        harness.transport.graphql(operation as never, {
          cursor: `must-not-leak-${TOKEN}`,
        }),
      );

      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
        details: {
          operation: "transport",
          reason: "invalid_parameters",
        },
      });
      expect(harness.requests).toEqual([]);
      expect(harness.remainingSteps()).toBe(1);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it.each(["\ud800", "\udfff", `owner\ud800suffix`])(
    "rejects malformed UTF-16 repository coordinates without a synchronous raw throw",
    async (owner) => {
      const harness = transportHarness([() => jsonResponse(200, {})]);
      let result: Promise<unknown> | undefined;

      expect(() => {
        result = harness.transport.rest("getReadme", {
          owner,
          repo: "tool",
        });
      }).not.toThrow();
      const error = await caught(result!);

      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
        details: {
          operation: "getReadme",
          reason: "invalid_parameters",
        },
      });
      expect(harness.requests).toEqual([]);
      expect(harness.remainingSteps()).toBe(1);
    },
  );

  it.each(["rest", "graphql"] as const)(
    "sanitizes a hostile runtime fetch getter for %s without a synchronous throw",
    async (kind) => {
      const rate = gateHarness();
      const runtime: OctokitTransportRuntime = {
        fetch: globalThis.fetch,
        random: () => 0,
        wait: () => Promise.resolve(),
      };
      Object.defineProperty(runtime, "fetch", {
        configurable: false,
        enumerable: true,
        get() {
          throw new Error(`raw-fetch-${TOKEN}`);
        },
      });
      const transport = createOctokitTransport(
        testCredential(),
        PACKAGE_VERSION,
        rate.gate,
        runtime,
      );
      let result: Promise<unknown> | undefined;

      expect(() => {
        result =
          kind === "rest"
            ? transport.rest("getViewer", {})
            : transport.graphql("listLists", { cursor: null });
      }).not.toThrow();
      const error = await caught(result!);

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: {
          operation: kind === "rest" ? "getViewer" : "listLists",
          reason: "invalid_fetch",
        },
      });
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it.each([300, 301, 302, 303, 304, 305, 307, 308])(
    "rejects HTTP %i redirect after one physical request",
    async (status) => {
      const harness = transportHarness([
        () =>
          jsonResponse(
            status,
            {},
            {
              location: "https://evil.example/steal",
            },
          ),
      ]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
      });
      expect(error.details).toMatchObject({ reason: "redirect_rejected" });
      expect(harness.requests).toHaveLength(1);
    },
  );

  it("rejects a fetch implementation that returns a cross-origin final URL", async () => {
    const harness = transportHarness([
      () => jsonResponse(200, {}, {}, "https://evil.example/token-capture"),
    ]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error.details).toEqual(
      expect.objectContaining({ reason: "origin_rejected" }),
    );
    expect(harness.requests).toHaveLength(1);
  });

  it.each([
    [400, "VALIDATION_ERROR", false],
    [422, "VALIDATION_ERROR", false],
    [401, "AUTH_REQUIRED", false],
    [403, "INSUFFICIENT_PERMISSION", false],
    [404, "NOT_FOUND", false],
    [418, "GITHUB_UNAVAILABLE", false],
    [429, "RATE_LIMITED", true],
  ] as const)(
    "maps HTTP %i to %s with retryable=%s",
    async (status, code, retryable) => {
      const harness = transportHarness([
        () => jsonResponse(status, { message: `raw-${status}-${TOKEN}` }),
      ]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({ code, retryable });
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
      expect(Object.hasOwn(error, "cause")).toBe(false);
      expect(harness.requests).toHaveLength(1);
    },
  );

  it("gives secondary rate limiting precedence over a primary signal", async () => {
    const step = () =>
      jsonResponse(
        403,
        { message: `secondary rate limit ${TOKEN}` },
        {
          "retry-after": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
        },
      );
    const harness = transportHarness([step, step, step]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "SECONDARY_RATE_LIMITED",
      retryable: true,
    });
    expect(harness.requests).toHaveLength(3);
    expect(harness.waits).toEqual([]);
    expect(harness.gateWaits).toEqual([60_000]);
    expect(harness.gate.getState()).toEqual({
      remaining: 0,
      resetAt: new Date(WALL_NOW + 60_000).toISOString(),
    });
  });

  it("observes primary REST state independently from a secondary retry action", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const limited = () =>
      jsonResponse(
        429,
        { message: `secondary-${TOKEN}` },
        {
          "retry-after": "1",
          "x-ratelimit-remaining": "40",
          "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
        },
      );
    const harness = transportHarness([limited, limited, limited]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "SECONDARY_RATE_LIMITED",
      retryable: true,
    });
    expect(harness.gateWaits).toEqual([1_000]);
    expect(harness.gate.getState()).toEqual({
      remaining: 40,
      resetAt,
    });
    expect(harness.requests).toHaveLength(3);
  });

  it("observes GraphQL body rate state independently from a secondary retry action", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const limited = () =>
      jsonResponse(
        429,
        {
          data: { rateLimit: { remaining: 39, resetAt } },
          errors: [{ message: `secondary-${TOKEN}` }],
        },
        { "retry-after": "1" },
      );
    const harness = transportHarness([limited, limited, limited]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error).toMatchObject({
      code: "SECONDARY_RATE_LIMITED",
      retryable: true,
    });
    expect(harness.gateWaits).toEqual([1_000]);
    expect(harness.gate.getState()).toEqual({
      remaining: 39,
      resetAt,
    });
    expect(harness.requests).toHaveLength(3);
  });

  it("observes a valid primary reset before retrying through the shared gate", async () => {
    const step = () =>
      jsonResponse(
        403,
        { message: "rate limited" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(WALL_NOW / 1_000 + 1),
        },
      );
    const harness = transportHarness([step, step, step]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(harness.requests).toHaveLength(3);
    expect(harness.gateWaits).toEqual([1_000]);
    expect(harness.waits).toEqual([]);
  });

  it("owns the only retry loop with exact backoff and a three-attempt cap", async () => {
    const step = () => jsonResponse(500, { message: `raw-server-${TOKEN}` });
    const harness = transportHarness([step, step, step], [0, 0.5]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: true,
    });
    expect(harness.requests).toHaveLength(3);
    expect(harness.waits).toEqual([250, 625]);
    expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
  });

  it.each([-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid random value %s before a retry dispatch",
    async (random) => {
      const step = () => jsonResponse(500, { message: "retry" });
      const harness = transportHarness([step, step], [random]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
      });
      expect(error.details).toEqual({
        operation: "getViewer",
        reason: "invalid_random",
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.waits).toEqual([]);
    },
  );

  it("maps a caller abort during fetch without exposing its custom reason", async () => {
    const controller = new AbortController();
    const harness = transportHarness([
      () => {
        controller.abort(new Error(`raw-abort-${TOKEN}`));
        throw controller.signal.reason;
      },
    ]);

    const error = await caught(
      harness.transport.rest("getViewer", {}, controller.signal),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(error.details).toMatchObject({ reason: "cancelled" });
    expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(harness.requests).toHaveLength(1);
  });

  it("observes successful REST and GraphQL rate state while preserving HTTP-200 GraphQL errors", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const harness = transportHarness([
      () =>
        jsonResponse(
          200,
          { login: "octo" },
          {
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
          },
        ),
      () =>
        jsonResponse(200, {
          data: {
            viewer: null,
            rateLimit: { remaining: 41, resetAt },
          },
          errors: [
            {
              message: `raw-graphql-${TOKEN}`,
              type: "INTERNAL",
              path: ["viewer", 0],
            },
          ],
        }),
    ]);

    await harness.transport.rest("getViewer", {});
    expect(harness.gate.getState()).toEqual({
      remaining: 42,
      resetAt,
    });
    const graphql = await harness.transport.graphql<{
      readonly viewer: null;
      readonly rateLimit: {
        readonly remaining: number;
        readonly resetAt: string;
      };
    }>("listLists", { cursor: null });

    expect(graphql).toMatchObject({
      status: 200,
      data: { viewer: null },
      errors: [
        {
          message: `raw-graphql-${TOKEN}`,
          type: "INTERNAL",
          path: ["viewer", 0],
        },
      ],
      rateLimit: { remaining: 41, resetAt },
    });
    expect(harness.requests).toHaveLength(2);
    expect(harness.waits).toEqual([]);
    expect(harness.gate.getState()).toEqual({
      remaining: 41,
      resetAt,
    });
  });

  it.each([408, 500, 599])(
    "retries HTTP %i exactly twice before returning its mapped class",
    async (status) => {
      const step = () => jsonResponse(status, { message: `raw-http-${TOKEN}` });
      const harness = transportHarness([step, step, step], [0, 0]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: true,
      });
      expect(harness.requests).toHaveLength(3);
      expect(harness.waits).toEqual([250, 500]);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it.each([
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
  ])(
    "retries allowlisted network code %s with the same physical cap",
    async (code) => {
      const step = codedNetworkFailure(code);
      const harness = transportHarness([step, step, step], [0, 0]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: true,
      });
      expect(harness.requests).toHaveLength(3);
      expect(harness.waits).toEqual([250, 500]);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it("does not retry an unclassified network failure", async () => {
    const harness = transportHarness([
      codedNetworkFailure("RAW_UNKNOWN_CODE"),
      () => jsonResponse(200, {}),
    ]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(error.details).toMatchObject({ reason: "network_failure" });
    expect(harness.requests).toHaveLength(1);
    expect(harness.remainingSteps()).toBe(1);
    expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
  });

  it("maps a valid 429 Retry-After to secondary limiting and retries without ordinary backoff", async () => {
    const step = () =>
      jsonResponse(
        429,
        { message: `raw-429-${TOKEN}` },
        { "retry-after": "0" },
      );
    const harness = transportHarness([step, step, step]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "SECONDARY_RATE_LIMITED",
      retryable: true,
    });
    expect(harness.requests).toHaveLength(3);
    expect(harness.waits).toEqual([]);
  });

  it("maps HTTP 429 with a primary reset and no Retry-After to the primary gate", async () => {
    const reset = String(WALL_NOW / 1_000 + 1);
    const limited = () =>
      jsonResponse(
        429,
        { message: `raw-429-${TOKEN}` },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": reset,
        },
      );
    const harness = transportHarness([
      limited,
      () => jsonResponse(200, { login: "octo" }),
    ]);

    await harness.transport.rest("getViewer", {});

    expect(harness.gateWaits).toEqual([1_000]);
    expect(harness.requests).toHaveLength(2);
    expect(harness.waits).toEqual([]);
  });

  it.each([
    { message: "abuse detected" },
    { errors: [{ type: "SECONDARY_RATE_LIMITED" }] },
  ] as const)(
    "recognizes a 403 secondary signal %s without inventing a retry time",
    async (body) => {
      const harness = transportHarness([
        () =>
          jsonResponse(403, {
            ...body,
            raw: TOKEN,
          }),
        () => jsonResponse(200, {}),
      ]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code: "SECONDARY_RATE_LIMITED",
        retryable: true,
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.remainingSteps()).toBe(1);
    },
  );

  it.each([
    [
      403,
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "not-an-epoch",
      },
      "GITHUB_UNAVAILABLE",
      false,
      "malformed_envelope",
    ],
    [
      429,
      { "retry-after": "not-a-delay" },
      "RATE_LIMITED",
      true,
      "primary_rate_limit",
    ],
  ] as const)(
    "does not retry malformed limit timing for HTTP %i",
    async (status, headers, code, retryable, reason) => {
      const harness = transportHarness([
        () => jsonResponse(status, { message: TOKEN }, headers),
        () => jsonResponse(200, {}),
      ]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code,
        retryable,
        details: { reason },
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.remainingSteps()).toBe(1);
    },
  );

  it("does not dispatch when the caller is already aborted", async () => {
    const harness = transportHarness([() => jsonResponse(200, {})]);
    const controller = new AbortController();
    controller.abort(new Error(`raw-before-${TOKEN}`));

    const error = await caught(
      harness.transport.rest("getViewer", {}, controller.signal),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(error.details).toMatchObject({ reason: "cancelled" });
    expect(harness.requests).toEqual([]);
    expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
  });

  it("maps abort during ordinary backoff and never dispatches the retry", async () => {
    const fetches = fetchHarness([
      () => jsonResponse(500, { message: "retry" }),
      () => jsonResponse(200, {}),
    ]);
    const rate = gateHarness();
    const controller = new AbortController();
    fetches.runtime.wait = () => {
      controller.abort(new Error(`raw-backoff-${TOKEN}`));
      return Promise.reject(new Error(`raw-wait-${TOKEN}`));
    };
    const transport = createOctokitTransport(
      testCredential(),
      PACKAGE_VERSION,
      rate.gate,
      fetches.runtime,
    );

    const error = await caught(
      transport.rest("getViewer", {}, controller.signal),
    );

    expect(error.details).toMatchObject({ reason: "cancelled" });
    expect(fetches.requests).toHaveLength(1);
    expect(fetches.remainingSteps()).toBe(1);
    expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
  });

  it.each(["random", "wait"] as const)(
    "sanitizes a runtime %s exception without a second dispatch",
    async (phase) => {
      const fetches = fetchHarness([
        () => jsonResponse(500, { message: "retry" }),
        () => jsonResponse(200, {}),
      ]);
      const rate = gateHarness();
      if (phase === "random") {
        fetches.runtime.random = () => {
          throw new Error(`raw-random-${TOKEN}`);
        };
      } else {
        fetches.runtime.wait = () =>
          Promise.reject(new Error(`raw-wait-${TOKEN}`));
      }
      const transport = createOctokitTransport(
        testCredential(),
        PACKAGE_VERSION,
        rate.gate,
        fetches.runtime,
      );

      const error = await caught(transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
      });
      expect(error.details).toMatchObject({
        reason: phase === "random" ? "invalid_random" : "wait_failed",
      });
      expect(fetches.requests).toHaveLength(1);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it.each([
    { "x-ratelimit-remaining": "1" },
    { "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60) },
    {
      "x-ratelimit-remaining": "NaN",
      "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
    },
  ])(
    "rejects malformed successful REST rate headers without retry",
    async (headers) => {
      const harness = transportHarness([
        () => jsonResponse(200, { login: "octo" }, headers),
        () => jsonResponse(200, {}),
      ]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
      });
      expect(error.details).toMatchObject({ reason: "malformed_envelope" });
      expect(harness.requests).toHaveLength(1);
      expect(harness.remainingSteps()).toBe(1);
    },
  );

  it.each([
    ["empty cursor", "listLists", { cursor: "" }],
    ["oversized cursor", "listLists", { cursor: "c".repeat(4_097) }],
    ["control cursor", "listLists", { cursor: "cursor\nvalue" }],
    ["empty list ID", "listItems", { listId: "", cursor: null }],
    [
      "oversized list ID",
      "listItems",
      { listId: "L".repeat(129), cursor: null },
    ],
    ["control list ID", "listItems", { listId: "list\u0000id", cursor: null }],
  ] as const)(
    "rejects %s before GraphQL physical dispatch",
    async (_label, operation, variables) => {
      const harness = transportHarness([() => jsonResponse(200, { data: {} })]);

      const error = await caught(
        harness.transport.graphql(operation, variables),
      );

      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
        details: {
          operation,
          reason: "invalid_parameters",
        },
      });
      expect(harness.requests).toEqual([]);
      expect(harness.remainingSteps()).toBe(1);
    },
  );

  it("accepts exact GraphQL variable bounds", async () => {
    const harness = transportHarness([
      () => jsonResponse(200, { data: {} }),
      () => jsonResponse(200, { data: {} }),
    ]);
    const cursor = "c".repeat(4_096);
    const listId = "L".repeat(128);

    await harness.transport.graphql("listLists", { cursor });
    await harness.transport.graphql("listItems", { listId, cursor });

    expect(JSON.parse(harness.requests[0]?.body ?? "{}")).toMatchObject({
      variables: { cursor },
    });
    expect(JSON.parse(harness.requests[1]?.body ?? "{}")).toMatchObject({
      variables: { cursor, listId },
    });
  });

  it.each([
    "not-an-object",
    { errors: "not-an-array" },
    { errors: [{ type: "INTERNAL" }] },
    {
      data: {
        rateLimit: {
          remaining: -1,
          resetAt: "raw-invalid-reset",
        },
      },
    },
  ])("rejects malformed GraphQL envelope %# without retry", async (body) => {
    const harness = transportHarness([
      () => jsonResponse(200, body),
      () => jsonResponse(200, { data: {} }),
    ]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(error.details).toMatchObject({ reason: "malformed_envelope" });
    expect(harness.requests).toHaveLength(1);
    expect(harness.remainingSteps()).toBe(1);
    expect(JSON.stringify(serializeError(error))).not.toContain(
      "raw-invalid-reset",
    );
  });

  it.each([
    ["missing data", () => ({})],
    ["empty errors only", () => ({ errors: [] })],
    ["array envelope", () => []],
    ["date envelope", () => new Date(0)],
    ["custom envelope prototype", () => customPrototypeObject({ data: {} })],
    ["proxy envelope", () => hostileProxy()],
    ["envelope accessor", () => accessorObject("data")],
    ["primitive data", () => ({ data: "invalid" })],
    ["array data", () => ({ data: [] })],
    [
      "custom data prototype",
      () => ({ data: customPrototypeObject({ viewer: null }) }),
    ],
    ["proxy data", () => ({ data: hostileProxy() })],
    ["data accessor", () => ({ data: accessorObject("viewer") })],
    ["sparse errors", () => ({ data: {}, errors: sparseArray(1) })],
    [
      "custom errors array prototype",
      () => ({
        data: {},
        errors: customPrototypeArray([{ message: "error" }]),
      }),
    ],
    ["revoked errors proxy", () => ({ data: {}, errors: revokedArrayProxy() })],
    [
      "too many errors",
      () => ({
        data: {},
        errors: Array.from({ length: 101 }, () => ({ message: "error" })),
      }),
    ],
    [
      "custom error prototype",
      () => ({
        data: {},
        errors: [customPrototypeObject({ message: "error" })],
      }),
    ],
    ["proxy error", () => ({ data: {}, errors: [hostileProxy()] })],
    [
      "error accessor",
      () => ({
        data: {},
        errors: [accessorObject("message")],
      }),
    ],
    [
      "oversized message",
      () => ({
        data: {},
        errors: [{ message: "m".repeat(16_385) }],
      }),
    ],
    [
      "empty type",
      () => ({ data: {}, errors: [{ message: "error", type: "" }] }),
    ],
    [
      "oversized type",
      () => ({
        data: {},
        errors: [{ message: "error", type: "T".repeat(129) }],
      }),
    ],
    [
      "control type",
      () => ({
        data: {},
        errors: [{ message: "error", type: "BAD\nTYPE" }],
      }),
    ],
    [
      "custom extensions prototype",
      () => ({
        data: {},
        errors: [
          {
            extensions: customPrototypeObject({ code: "INTERNAL" }),
            message: "error",
          },
        ],
      }),
    ],
    [
      "proxy extensions",
      () => ({
        data: {},
        errors: [{ extensions: hostileProxy(), message: "error" }],
      }),
    ],
    [
      "extensions accessor",
      () => ({
        data: {},
        errors: [{ extensions: accessorObject("code"), message: "error" }],
      }),
    ],
    [
      "sparse path",
      () => ({
        data: {},
        errors: [{ message: "error", path: sparseArray(1) }],
      }),
    ],
    [
      "proxy path",
      () => ({
        data: {},
        errors: [{ message: "error", path: new Proxy(["viewer"], {}) }],
      }),
    ],
    [
      "custom path array prototype",
      () => ({
        data: {},
        errors: [
          {
            message: "error",
            path: customPrototypeArray(["viewer"]),
          },
        ],
      }),
    ],
    [
      "revoked path proxy",
      () => ({
        data: {},
        errors: [{ message: "error", path: revokedArrayProxy() }],
      }),
    ],
    [
      "path accessor",
      () => ({
        data: {},
        errors: [{ message: "error", path: accessorArray() }],
      }),
    ],
    [
      "too many path segments",
      () => ({
        data: {},
        errors: [
          {
            message: "error",
            path: Array.from({ length: 101 }, () => "segment"),
          },
        ],
      }),
    ],
    [
      "oversized path string",
      () => ({
        data: {},
        errors: [{ message: "error", path: ["p".repeat(257)] }],
      }),
    ],
    [
      "control path string",
      () => ({
        data: {},
        errors: [{ message: "error", path: ["bad\u0000path"] }],
      }),
    ],
    [
      "negative path number",
      () => ({
        data: {},
        errors: [{ message: "error", path: [-1] }],
      }),
    ],
    [
      "fractional path number",
      () => ({
        data: {},
        errors: [{ message: "error", path: [1.5] }],
      }),
    ],
    [
      "unsafe path number",
      () => ({
        data: {},
        errors: [{ message: "error", path: [Number.MAX_SAFE_INTEGER + 1] }],
      }),
    ],
  ] as const)(
    "rejects malformed bounded GraphQL %s without retry",
    async (_label, body) => {
      const harness = transportHarness([
        () => rawBodyResponse(200, body()),
        () => jsonResponse(200, { data: {} }),
      ]);

      const error = await caught(
        harness.transport.graphql("listLists", { cursor: null }),
      );

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: {
          operation: "listLists",
          reason: "malformed_envelope",
        },
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.remainingSteps()).toBe(1);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it("accepts exact GraphQL response bounds and null data", async () => {
    const path = Array.from({ length: 100 }, (_value, index) =>
      index % 2 === 0
        ? "p".repeat(256)
        : index === 99
          ? Number.MAX_SAFE_INTEGER
          : index,
    );
    const errors = Array.from({ length: 100 }, (_value, index) =>
      index === 0
        ? {
            message: "m".repeat(16_384),
            path,
            type: "T".repeat(128),
          }
        : { message: `error-${index}` },
    );
    const harness = transportHarness([
      () =>
        rawBodyResponse(200, {
          data: {},
          errors,
        }),
      () => rawBodyResponse(200, { data: null }),
    ]);

    const bounded = await harness.transport.graphql("listLists", {
      cursor: null,
    });
    const nullData = await harness.transport.graphql("listLists", {
      cursor: null,
    });

    expect(bounded.errors[0]).toEqual({
      message: "m".repeat(16_384),
      path,
      type: "T".repeat(128),
    });
    expect(bounded.errors).toHaveLength(100);
    expect(bounded.errors[1]).toEqual({
      message: "error-1",
      path: null,
      type: null,
    });
    expect(nullData).toMatchObject({ data: null, errors: [] });
  });

  it("preserves a valid non-empty GraphQL errors-only envelope as null data", async () => {
    const harness = transportHarness([
      () =>
        jsonResponse(200, {
          errors: [
            {
              extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
              message: "fixed document is unavailable",
              path: ["viewer"],
            },
          ],
        }),
    ]);

    const response = await harness.transport.graphql("listLists", {
      cursor: null,
    });

    expect(response).toMatchObject({
      data: null,
      errors: [
        {
          message: "fixed document is unavailable",
          path: ["viewer"],
          type: "GRAPHQL_VALIDATION_FAILED",
        },
      ],
      rateLimit: null,
      status: 200,
    });
  });

  it("observes HTTP-200 GraphQL rate headers for an errors-only envelope", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const harness = transportHarness([
      () =>
        jsonResponse(
          200,
          { errors: [{ message: "fixed document unavailable" }] },
          {
            "x-ratelimit-remaining": "35",
            "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
          },
        ),
    ]);

    const response = await harness.transport.graphql("listLists", {
      cursor: null,
    });

    expect(response).toMatchObject({
      data: null,
      rateLimit: { remaining: 35, resetAt },
    });
    expect(harness.gate.getState()).toEqual({
      remaining: 35,
      resetAt,
    });
  });

  it("rejects conflicting HTTP-200 GraphQL body and header rate state", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const harness = transportHarness([
      () =>
        jsonResponse(
          200,
          {
            data: {
              rateLimit: { remaining: 34, resetAt },
            },
          },
          {
            "x-ratelimit-remaining": "33",
            "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
          },
        ),
      () => jsonResponse(200, { data: {} }),
    ]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: {
        operation: "listLists",
        reason: "malformed_envelope",
      },
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.remainingSteps()).toBe(1);
    expect(harness.gate.getState()).toBeNull();
  });

  it("rejects partial HTTP-200 GraphQL rate headers", async () => {
    const harness = transportHarness([
      () => jsonResponse(200, { data: {} }, { "x-ratelimit-remaining": "32" }),
      () => jsonResponse(200, { data: {} }),
    ]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: {
        operation: "listLists",
        reason: "malformed_envelope",
      },
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.remainingSteps()).toBe(1);
  });

  it("retries GraphQL HTTP failures with one shared cap but never retries HTTP-200 semantic errors", async () => {
    const failed = () =>
      jsonResponse(500, { message: `raw-graphql-http-${TOKEN}` });
    const httpHarness = transportHarness([failed, failed, failed], [0, 0]);

    const httpError = await caught(
      httpHarness.transport.graphql("listLists", { cursor: null }),
    );
    expect(httpError).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: true,
    });
    expect(httpHarness.requests).toHaveLength(3);
    expect(httpHarness.waits).toEqual([250, 500]);

    const semanticHarness = transportHarness([
      () =>
        jsonResponse(200, {
          data: { viewer: null },
          errors: [
            {
              message: `raw-semantic-${TOKEN}`,
              type: "INTERNAL",
              path: ["viewer"],
            },
          ],
        }),
      () => jsonResponse(200, { data: { viewer: {} } }),
    ]);
    const semantic = await semanticHarness.transport.graphql("listLists", {
      cursor: "cursor-1",
    });
    expect(semantic.errors).toHaveLength(1);
    expect(semanticHarness.requests).toHaveLength(1);
    expect(semanticHarness.remainingSteps()).toBe(1);
  });

  it.each(["plain text failure", null])(
    "keeps GraphQL HTTP 500 mapping authoritative for body %#",
    async (body) => {
      const failed = () => jsonResponse(500, body);
      const harness = transportHarness([failed, failed, failed], [0, 0]);

      const error = await caught(
        harness.transport.graphql("listLists", { cursor: null }),
      );

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: true,
        details: {
          operation: "listLists",
          reason: "transient_http",
          status: 500,
        },
      });
      expect(harness.requests).toHaveLength(3);
      expect(harness.waits).toEqual([250, 500]);
    },
  );

  it.each([
    {
      remaining: -1,
      resetAt: new Date(WALL_NOW + 60_000).toISOString(),
    },
    { remaining: 1, resetAt: "invalid-reset" },
    null,
  ])(
    "rejects present malformed GraphQL HTTP failure rate metadata %# without retry",
    async (rateLimit) => {
      const harness = transportHarness([
        () =>
          jsonResponse(500, {
            data: { rateLimit },
            message: "server failure",
          }),
        () => jsonResponse(200, { data: {} }),
      ]);

      const error = await caught(
        harness.transport.graphql("listLists", { cursor: null }),
      );

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: {
          operation: "listLists",
          reason: "malformed_envelope",
        },
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.remainingSteps()).toBe(1);
      expect(harness.waits).toEqual([]);
    },
  );

  it("keeps GraphQL HTTP 401 mapping authoritative for a text body", async () => {
    const harness = transportHarness([
      () => jsonResponse(401, "raw authentication failure"),
    ]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error).toMatchObject({
      code: "AUTH_REQUIRED",
      retryable: false,
      details: {
        operation: "listLists",
        reason: "authentication_failed",
        status: 401,
      },
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.waits).toEqual([]);
  });

  it("observes valid GraphQL HTTP failure rate headers when the body state is absent", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const harness = transportHarness([
      () =>
        jsonResponse(418, "plain failure", {
          "x-ratelimit-remaining": "38",
          "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
        }),
    ]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "http_failure", status: 418 },
    });
    expect(harness.gate.getState()).toEqual({
      remaining: 38,
      resetAt,
    });
  });

  it("rejects conflicting GraphQL HTTP failure body and header rate state", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const harness = transportHarness([
      () =>
        jsonResponse(
          418,
          {
            data: { rateLimit: { remaining: 37, resetAt } },
            message: "plain failure",
          },
          {
            "x-ratelimit-remaining": "38",
            "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
          },
        ),
    ]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: {
        operation: "listLists",
        reason: "malformed_envelope",
      },
    });
    expect(harness.gate.getState()).toBeNull();
  });

  it("accepts identical GraphQL HTTP failure body and header rate state", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const harness = transportHarness([
      () =>
        jsonResponse(
          418,
          {
            data: { rateLimit: { remaining: 36, resetAt } },
            message: "plain failure",
          },
          {
            "x-ratelimit-remaining": "36",
            "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
          },
        ),
    ]);

    const error = await caught(
      harness.transport.graphql("listLists", { cursor: null }),
    );

    expect(error.details).toMatchObject({
      reason: "http_failure",
      status: 418,
    });
    expect(harness.gate.getState()).toEqual({
      remaining: 36,
      resetAt,
    });
  });

  it.each([
    { "x-ratelimit-remaining": "1" },
    { "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60) },
    {
      "x-ratelimit-remaining": "invalid",
      "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
    },
  ])(
    "rejects partial or malformed GraphQL HTTP failure rate headers %#",
    async (headers) => {
      const harness = transportHarness([
        () => jsonResponse(500, "plain failure", headers),
        () => jsonResponse(200, { data: {} }),
      ]);

      const error = await caught(
        harness.transport.graphql("listLists", { cursor: null }),
      );

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: {
          operation: "listLists",
          reason: "malformed_envelope",
        },
      });
      expect(harness.requests).toHaveLength(1);
      expect(harness.remainingSteps()).toBe(1);
    },
  );

  it.each([
    () => accessorArray(),
    () =>
      new Proxy([{ type: "SECONDARY_RATE_LIMITED" }], {
        get() {
          throw new Error(`raw-secondary-${TOKEN}`);
        },
      }),
    () => revokedArrayProxy(),
  ])(
    "sanitizes hostile secondary metadata without exposing raw errors",
    async (createErrors) => {
      const harness = transportHarness([
        () =>
          rawBodyResponse(403, {
            errors: createErrors(),
            message: "permission denied",
          }),
      ]);

      const error = await caught(harness.transport.rest("getViewer", {}));

      expect(error.retryable).toBe(false);
      expect(["GITHUB_UNAVAILABLE", "INSUFFICIENT_PERMISSION"]).toContain(
        error.code,
      );
      expect(harness.requests).toHaveLength(1);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it.each([
    ["REST headers", "getViewer", { headers: { authorization: TOKEN } }],
    ["REST request", "getViewer", { request: { fetch: "evil" } }],
    ["REST method", "getViewer", { method: "DELETE" }],
    ["REST media", "getViewer", { mediaType: { format: "raw" } }],
  ] as const)(
    "rejects %s override fields before dispatch",
    async (_label, operation, parameters) => {
      const harness = transportHarness([() => jsonResponse(200, {})]);

      const error = await caught(harness.transport.rest(operation, parameters));

      expect(error.retryable).toBe(false);
      expect(harness.requests).toEqual([]);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it.each([
    ["query", { cursor: null, query: "query Injected" }],
    ["request", { cursor: null, request: { fetch: "evil" } }],
    ["token", { cursor: null, token: TOKEN }],
  ] as const)(
    "rejects GraphQL %s override before dispatch",
    async (_label, variables) => {
      const harness = transportHarness([() => jsonResponse(200, {})]);

      const error = await caught(
        harness.transport.graphql("listLists", variables),
      );

      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
      expect(harness.requests).toEqual([]);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it("uses exact physical Accept values and exact GraphQL variables", async () => {
    const harness = transportHarness([
      () => jsonResponse(200, []),
      () => jsonResponse(200, { data: { node: null } }),
    ]);

    await harness.transport.rest("listStars", {
      page: 1,
      per_page: 100,
    });
    await harness.transport.graphql("listItems", {
      listId: "UL_1",
      cursor: "cursor-2",
    });

    expect(harness.requests[0]?.headers.accept).toBe(
      "application/vnd.github.star+json",
    );
    const body = JSON.parse(harness.requests[1]?.body ?? "{}") as {
      variables?: unknown;
    };
    expect(body.variables).toEqual({
      listId: "UL_1",
      cursor: "cursor-2",
    });
  });

  it("filters credential-bearing response headers and keeps safe details exact", async () => {
    const harness = transportHarness([
      () =>
        jsonResponse(
          200,
          { login: "octo" },
          {
            "set-cookie": TOKEN,
            "x-github-request-id": "request-1",
          },
        ),
      () => jsonResponse(401, { message: TOKEN }),
    ]);

    const response = await harness.transport.rest("getViewer", {});
    expect(response.headers).toEqual({
      "content-type": "application/json",
      "x-github-request-id": "request-1",
    });
    expect(JSON.stringify(response.headers)).not.toContain(TOKEN);
    const error = await caught(harness.transport.rest("getViewer", {}));
    expect(error.details).toEqual({
      operation: "getViewer",
      reason: "authentication_failed",
      status: 401,
    });
    expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
  });

  it("maps a fetch-level redirect error code after one physical request", async () => {
    const harness = transportHarness([
      codedNetworkFailure("ERR_INVALID_REDIRECT"),
      () => jsonResponse(200, {}),
    ]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error.details).toMatchObject({ reason: "redirect_rejected" });
    expect(harness.requests).toHaveLength(1);
    expect(harness.remainingSteps()).toBe(1);
  });

  it("maps Node native redirect:error rejection after one physical request", async () => {
    const harness = transportHarness([
      () => {
        throw new TypeError("fetch failed", {
          cause: new Error("unexpected redirect"),
        });
      },
      () => jsonResponse(200, {}),
    ]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error.details).toMatchObject({ reason: "redirect_rejected" });
    expect(harness.requests).toHaveLength(1);
    expect(harness.remainingSteps()).toBe(1);
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it.each([
    "https://api.github.com:444/user",
    "https://user@api.github.com/user",
    "https://api.github.com/repos/other/path",
    "http://api.github.com/user",
  ])("rejects hostile final response URL %s", async (responseUrl) => {
    const harness = transportHarness([
      () => jsonResponse(200, {}, {}, responseUrl),
    ]);

    const error = await caught(harness.transport.rest("getViewer", {}));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(error.details).toMatchObject({ reason: "origin_rejected" });
    expect(harness.requests).toHaveLength(1);
  });

  it("prefers a raw GraphQL error type and otherwise preserves extensions.code", async () => {
    const harness = transportHarness([
      () =>
        jsonResponse(200, {
          data: null,
          errors: [
            {
              message: "first",
              type: "FORBIDDEN",
              extensions: { code: "INTERNAL" },
            },
            {
              message: "second",
              extensions: { code: "TIMEOUT" },
            },
          ],
        }),
    ]);

    const response = await harness.transport.graphql("listLists", {
      cursor: null,
    });

    expect(response.errors).toEqual([
      {
        message: "first",
        type: "FORBIDDEN",
        path: null,
      },
      {
        message: "second",
        type: "TIMEOUT",
        path: null,
      },
    ]);
    expect(harness.requests).toHaveLength(1);
  });

  it.each([
    [
      "REST query",
      (transport: GitHubTransport) =>
        transport.rest("searchRepositories", {
          q: `repo:${TOKEN}`,
          page: 1,
          per_page: 10,
        }),
    ],
    [
      "REST path",
      (transport: GitHubTransport) =>
        transport.rest("getReadme", {
          owner: TOKEN,
          repo: "tool",
        }),
    ],
    [
      "GraphQL body",
      (transport: GitHubTransport) =>
        transport.graphql("listItems", {
          listId: TOKEN,
          cursor: null,
        }),
    ],
  ] as const)(
    "rejects resolved credential injection through %s",
    async (_label, dispatch) => {
      const harness = transportHarness([() => jsonResponse(200, {})]);

      const error = await caught(dispatch(harness.transport));

      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
      expect(harness.requests).toEqual([]);
      expect(JSON.stringify(serializeError(error))).not.toContain(TOKEN);
    },
  );

  it("exposes only the transport methods and keeps plugin retries disabled in source", async () => {
    const harness = transportHarness([]);

    expect(Object.keys(harness.transport).sort()).toEqual(["graphql", "rest"]);
    expect(JSON.stringify(harness.transport)).not.toContain(TOKEN);
    expectTypeOf<OctokitTransportRuntime>().toEqualTypeOf<{
      fetch: typeof globalThis.fetch;
      random(): number;
      wait(delayMs: number, signal?: AbortSignal): Promise<void>;
    }>();
    const source = await readFile(
      new URL("../../../src/github/octokit-client.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/retry:\s*\{\s*enabled:\s*false\s*\}/u);
    expect(source).toMatch(/throttle:\s*\{\s*enabled:\s*false\s*\}/u);
    expect(source).not.toMatch(
      /export\s+(?:const|function)\s+\w*(?:Options|Origin|Url|Host)\b/u,
    );
  });

  it("silences Octokit diagnostics and never logs response-controlled values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const harness = transportHarness([
      () =>
        jsonResponse(
          200,
          { login: "octo" },
          {
            deprecation: TOKEN,
            sunset: TOKEN,
            link: `<https://example.test/${TOKEN}>; rel="deprecation"`,
          },
        ),
    ]);

    await harness.transport.rest("getViewer", {});

    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("observes the final limited attempt before exposing failure so the next call is gated", async () => {
    const limited = (offsetSeconds: number) => () =>
      jsonResponse(
        403,
        { message: "rate limited" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(WALL_NOW / 1_000 + offsetSeconds),
        },
      );
    const harness = transportHarness([
      limited(1),
      limited(2),
      limited(3),
      () => jsonResponse(200, { login: "octo" }),
    ]);

    await caught(harness.transport.rest("getViewer", {}));
    expect(harness.gateWaits).toEqual([1_000, 1_000]);
    await harness.transport.rest("getViewer", {});

    expect(harness.gateWaits).toEqual([1_000, 1_000, 1_000]);
    expect(harness.requests).toHaveLength(4);
  });

  it("observes ordinary REST and GraphQL failure-side rate state without retrying semantic errors", async () => {
    const resetAt = new Date(WALL_NOW + 60_000).toISOString();
    const rest = transportHarness([
      () =>
        jsonResponse(
          418,
          { message: "failure" },
          {
            "x-ratelimit-remaining": "40",
            "x-ratelimit-reset": String(WALL_NOW / 1_000 + 60),
          },
        ),
    ]);
    await caught(rest.transport.rest("getViewer", {}));
    expect(rest.gate.getState()).toEqual({
      remaining: 40,
      resetAt,
    });

    const graphql = transportHarness([
      () =>
        jsonResponse(418, {
          data: {
            rateLimit: { remaining: 39, resetAt },
          },
          errors: [{ message: "failure", type: "INTERNAL" }],
        }),
    ]);
    await caught(graphql.transport.graphql("listLists", { cursor: null }));
    expect(graphql.gate.getState()).toEqual({
      remaining: 39,
      resetAt,
    });
  });

  it.each(["application/vnd.github+json", "application/vnd.github.star+json"])(
    "rejects caller Accept override %s instead of weakening operation media types",
    async (accept) => {
      const harness = transportHarness([() => jsonResponse(200, [])]);

      const error = await caught(
        harness.transport.rest("listStars", {
          page: 1,
          per_page: 100,
          headers: { accept },
        }),
      );

      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
      expect(harness.requests).toEqual([]);
    },
  );
});
