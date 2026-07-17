import { describe, expect, it, vi } from "vitest";
import { GRAPHQL_READ_DOCUMENTS } from "../../../src/github/allowed-operations.js";
import {
  createScriptedGitHubTransport,
  type ScriptedGitHubStep,
} from "../../support/scripted-github-transport.js";

describe("scripted GitHub transport", () => {
  it("copies and freezes its transcript, responses, and recorded REST requests", async () => {
    const data = { viewer: { login: "octo" } };
    const headers: Record<string, string | undefined> = {
      "X-GitHub-Request-Id": "request-1",
      "X-Optional": undefined,
    };
    const transcript: ScriptedGitHubStep[] = [
      {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        status: 200,
        data,
        headers,
      },
    ];
    const scripted = createScriptedGitHubTransport(transcript);

    data.viewer.login = "mutated-after-construction";
    headers["X-GitHub-Request-Id"] = "mutated-after-construction";
    transcript.length = 0;

    const parameters = { page: 1, nested: { value: "original" } };
    const response = await scripted.transport.rest<{
      readonly viewer: { readonly login: string };
    }>("getViewer", parameters);
    parameters.page = 99;
    parameters.nested.value = "mutated-after-request";

    expect(response).toEqual({
      data: { viewer: { login: "octo" } },
      status: 200,
      headers: {
        "x-github-request-id": "request-1",
        "x-optional": undefined,
      },
    });
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.data)).toBe(true);
    expect(Object.isFrozen(response.data.viewer)).toBe(true);
    expect(Object.isFrozen(response.headers)).toBe(true);
    expect(scripted.requests).toEqual([
      {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        parameters: { page: 1, nested: { value: "original" } },
      },
    ]);
    expect(Object.isFrozen(scripted.requests)).toBe(true);
    expect(Object.isFrozen(scripted.requests[0])).toBe(true);
    const firstRequest = scripted.requests[0];
    if (firstRequest?.kind !== "rest") {
      throw new Error("Expected a recorded REST request");
    }
    expect(Object.isFrozen(firstRequest.parameters)).toBe(true);
    expect(() =>
      (
        scripted.requests as unknown as {
          push(value: unknown): void;
        }
      ).push({}),
    ).toThrow(TypeError);
    scripted.assertExhausted();
  });

  it("copies arrays and null-prototype objects but rejects cyclic fixture data", async () => {
    const dictionary: Record<string, unknown> = { key: "value" };
    Object.setPrototypeOf(dictionary, null);
    const fixture: {
      list: { value: string }[];
      dictionary: Record<string, unknown>;
    } = {
      list: [{ value: "original" }],
      dictionary,
    };
    const scripted = createScriptedGitHubTransport([
      {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        status: 200,
        data: fixture,
      },
    ]);

    fixture.list[0]!.value = "mutated";
    fixture.dictionary.key = "mutated";
    const response = await scripted.transport.rest<typeof fixture>(
      "getViewer",
      {},
    );

    expect(response.data).not.toBe(fixture);
    expect(response.data.list).toEqual([{ value: "original" }]);
    expect(response.data.dictionary).toEqual({ key: "value" });
    expect(Object.getPrototypeOf(response.data.dictionary)).toBe(null);
    expect(Object.isFrozen(response.data)).toBe(true);
    expect(Object.isFrozen(response.data.list)).toBe(true);
    expect(Object.isFrozen(response.data.list[0])).toBe(true);
    expect(Object.isFrozen(response.data.dictionary)).toBe(true);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      createScriptedGitHubTransport([
        {
          kind: "rest",
          operation: "getViewer",
          method: "GET",
          path: "/user",
          status: 200,
          data: cyclic,
        },
      ]),
    ).toThrow(
      "Scripted GitHub transport accepts data properties on plain fixture values only",
    );
  });

  it("rejects accessors, functions, custom prototypes, symbols, and extra step fields without evaluating or leaking them", () => {
    const getter = vi.fn(() => "raw-accessor-secret");
    const toJSON = vi.fn(() => ({ leaked: "raw-to-json-secret" }));
    const accessorData: Record<string, unknown> = {};
    Object.defineProperty(accessorData, "value", {
      enumerable: true,
      get: getter,
    });
    const symbolData = { safe: true };
    Object.defineProperty(symbolData, Symbol("raw-symbol-secret"), {
      enumerable: true,
      value: "raw-symbol-value-secret",
    });
    class CustomFixture {
      value = "raw-custom-secret";
    }

    const hostileValues: readonly unknown[] = [
      accessorData,
      { toJSON },
      new CustomFixture(),
      symbolData,
    ];
    for (const data of hostileValues) {
      let error: unknown;
      try {
        createScriptedGitHubTransport([
          {
            kind: "rest",
            operation: "getViewer",
            method: "GET",
            path: "/user",
            status: 200,
            data,
          },
        ]);
      } catch (reason) {
        error = reason;
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe(
        "Error: Scripted GitHub transport accepts data properties on plain fixture values only",
      );
      expect(String(error)).not.toMatch(
        /raw-(?:accessor|to-json|custom|symbol)/u,
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();

    const extraField = {
      kind: "rest",
      operation: "getViewer",
      method: "GET",
      path: "/user",
      status: 200,
      credential: "raw-extra-secret",
    } as unknown as ScriptedGitHubStep;
    expect(() => createScriptedGitHubTransport([extraField])).toThrow(
      "Scripted GitHub transcript rest:getViewer has unrecognized fields",
    );
    try {
      createScriptedGitHubTransport([extraField]);
    } catch (error) {
      expect(String(error)).not.toContain("raw-extra-secret");
    }
  });

  it("rejects Proxy fixture graphs without executing their traps", () => {
    const traps = {
      get: vi.fn(),
      getOwnPropertyDescriptor: vi.fn(),
      getPrototypeOf: vi.fn(),
      ownKeys: vi.fn(),
    };
    const proxiedData = new Proxy(
      { value: "raw-proxy-secret" },
      {
        get() {
          traps.get();
          throw new Error("raw-get-trap-secret");
        },
        getOwnPropertyDescriptor() {
          traps.getOwnPropertyDescriptor();
          throw new Error("raw-descriptor-trap-secret");
        },
        getPrototypeOf() {
          traps.getPrototypeOf();
          throw new Error("raw-prototype-trap-secret");
        },
        ownKeys() {
          traps.ownKeys();
          throw new Error("raw-own-keys-trap-secret");
        },
      },
    );

    let error: unknown;
    try {
      createScriptedGitHubTransport([
        {
          kind: "rest",
          operation: "getViewer",
          method: "GET",
          path: "/user",
          status: 200,
          data: proxiedData,
        },
      ]);
    } catch (reason) {
      error = reason;
    }

    expect(String(error)).toBe(
      "Error: Scripted GitHub transport accepts data properties on plain fixture values only",
    );
    expect(String(error)).not.toContain("raw-");
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.getOwnPropertyDescriptor).not.toHaveBeenCalled();
    expect(traps.getPrototypeOf).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
  });

  it("rejects sparse transcripts instead of treating a hole as exhaustion", () => {
    const sparse = new Array<ScriptedGitHubStep>(2);
    sparse[1] = {
      kind: "rest",
      operation: "getViewer",
      method: "GET",
      path: "/user",
      status: 200,
      data: {},
    };

    expect(() => createScriptedGitHubTransport(sparse)).toThrow(
      "Scripted GitHub transcript must be a dense array",
    );
  });

  it("preserves the complete GraphQL envelope and records fixed documents and occurrences", async () => {
    const firstVariables = { cursor: null as string | null };
    const scripted = createScriptedGitHubTransport([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: { viewer: { lists: null } },
        errors: [
          {
            message: "preview returned partial data",
            type: null,
            path: ["viewer", "lists", 0],
          },
        ],
        headers: { "X-GitHub-Request-Id": "graphql-1" },
        rateLimit: {
          remaining: 4999,
          resetAt: "2026-07-17T01:00:00.000Z",
        },
      },
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: null,
      },
    ]);

    const first = await scripted.transport.graphql<{
      readonly viewer: { readonly lists: null };
    }>("listLists", firstVariables);
    firstVariables.cursor = "mutated-after-request";
    const second = await scripted.transport.graphql("listLists", {
      cursor: "cursor-2",
    });

    expect(first).toEqual({
      data: { viewer: { lists: null } },
      errors: [
        {
          message: "preview returned partial data",
          type: null,
          path: ["viewer", "lists", 0],
        },
      ],
      status: 200,
      headers: { "x-github-request-id": "graphql-1" },
      rateLimit: {
        remaining: 4999,
        resetAt: "2026-07-17T01:00:00.000Z",
      },
    });
    expect(second).toEqual({
      data: null,
      errors: [],
      status: 200,
      headers: {},
      rateLimit: null,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.errors)).toBe(true);
    expect(Object.isFrozen(first.errors[0]?.path)).toBe(true);
    expect(Object.isFrozen(first.rateLimit)).toBe(true);
    expect(scripted.graphqlVariables("listLists")).toEqual({ cursor: null });
    expect(scripted.graphqlVariables("listLists", 1)).toEqual({
      cursor: "cursor-2",
    });
    expect(Object.isFrozen(scripted.graphqlVariables("listLists"))).toBe(true);
    expect(scripted.graphqlDocuments()).toEqual([
      GRAPHQL_READ_DOCUMENTS.listLists,
      GRAPHQL_READ_DOCUMENTS.listLists,
    ]);
    expect(Object.isFrozen(scripted.graphqlDocuments())).toBe(true);
    expect(scripted.requests[0]).toEqual({
      kind: "graphql",
      operation: "listLists",
      graphqlOperation: "ViewerLists",
      document: GRAPHQL_READ_DOCUMENTS.listLists,
      variables: { cursor: null },
    });
    scripted.assertExhausted();
  });

  it("matches strict FIFO kind and operation without consuming a mismatch", async () => {
    const scripted = createScriptedGitHubTransport([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: null,
      },
    ]);

    await expect(scripted.transport.rest("getViewer", {})).rejects.toThrow(
      "Scripted GitHub transport expected graphql:listLists but received rest:getViewer",
    );
    expect(scripted.requests).toHaveLength(1);
    expect(() => scripted.assertExhausted()).toThrow(
      "Scripted GitHub transport has 1 unused step; next is graphql:listLists",
    );

    await expect(
      scripted.transport.graphql("listItems", {
        listId: "UL_1",
        cursor: null,
      }),
    ).rejects.toThrow(
      "Scripted GitHub transport expected graphql:listLists but received graphql:listItems",
    );
    expect(scripted.requests).toHaveLength(2);

    await expect(
      scripted.transport.graphql("listLists", { cursor: null }),
    ).resolves.toMatchObject({ status: 200 });
    scripted.assertExhausted();

    await expect(
      scripted.transport.graphql("listLists", { cursor: null }),
    ).rejects.toThrow(
      "Scripted GitHub transport is exhausted; received graphql:listLists",
    );
    expect(scripted.requests).toHaveLength(4);
  });

  it("does not record or consume an aborted request", async () => {
    const scripted = createScriptedGitHubTransport([
      {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        status: 200,
        data: {},
      },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      scripted.transport.rest("getViewer", {}, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(scripted.requests).toEqual([]);
    expect(() => scripted.assertExhausted()).toThrow(
      "Scripted GitHub transport has 1 unused step; next is rest:getViewer",
    );

    await expect(
      scripted.transport.rest("getViewer", {}),
    ).resolves.toMatchObject({ status: 200 });
    scripted.assertExhausted();
  });

  it.each(["rest", "graphql"] as const)(
    "replaces a caller-supplied %s abort reason with a fixed zero-secret AbortError",
    async (kind) => {
      const step: ScriptedGitHubStep =
        kind === "rest"
          ? {
              kind: "rest",
              operation: "getViewer",
              method: "GET",
              path: "/user",
              status: 200,
              data: {},
            }
          : {
              kind: "graphql",
              operation: "listLists",
              graphqlOperation: "ViewerLists",
              status: 200,
              data: null,
            };
      const scripted = createScriptedGitHubTransport([step]);
      const controller = new AbortController();
      controller.abort(new Error("raw-secret-token"));

      const result =
        kind === "rest"
          ? scripted.transport.rest("getViewer", {}, controller.signal)
          : scripted.transport.graphql(
              "listLists",
              { cursor: null },
              controller.signal,
            );
      const error = await result.catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(DOMException);
      expect(error).toMatchObject({
        name: "AbortError",
        message: "The operation was aborted",
      });
      expect(String(error)).not.toContain("raw-secret-token");
      expect(JSON.stringify(error)).not.toContain("raw-secret-token");
      expect(scripted.requests).toEqual([]);
      expect(() => scripted.assertExhausted()).toThrow(/1 unused step/u);
    },
  );

  it.each([
    [
      "REST",
      () => {
        const scripted = createScriptedGitHubTransport([
          {
            kind: "rest",
            operation: "getViewer",
            method: "GET",
            path: "/user",
            status: 200,
            data: {},
          },
        ]);
        return {
          scripted,
          result: scripted.transport.rest("getViewer", {
            headers: { Authorization: "raw-secret-token" },
          }),
        };
      },
    ],
    [
      "GraphQL",
      () => {
        const scripted = createScriptedGitHubTransport([
          {
            kind: "graphql",
            operation: "listLists",
            graphqlOperation: "ViewerLists",
            status: 200,
            data: null,
          },
        ]);
        return {
          scripted,
          result: scripted.transport.graphql("listLists", {
            cursor: null,
            token: "raw-secret-token",
          }),
        };
      },
    ],
  ])(
    "rejects credential-bearing %s fields without recording them",
    async (_label, arrange) => {
      const { scripted, result } = arrange();
      const error = await result.catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        "Scripted GitHub transport refused credential-bearing request fields",
      );
      expect(String(error)).not.toContain("raw-secret-token");
      expect(JSON.stringify(error)).not.toContain("raw-secret-token");
      expect(scripted.requests).toEqual([]);
      expect(() => scripted.assertExhausted()).toThrow(/1 unused step/u);
    },
  );

  it("rejects recursive mixed-case credentials before recording or consuming", async () => {
    const scripted = createScriptedGitHubTransport([
      {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        status: 200,
        data: {},
      },
    ]);
    const result = scripted.transport.rest("getViewer", {
      nested: [{ AuThOrIzAtIoN: "raw-deep-secret" }],
    });
    const error = await result.catch((reason: unknown) => reason);

    expect(String(error)).toContain(
      "Scripted GitHub transport refused credential-bearing request fields",
    );
    expect(String(error)).not.toContain("raw-deep-secret");
    expect(scripted.requests).toEqual([]);
    expect(() => scripted.assertExhausted()).toThrow(/1 unused step/u);
  });

  it.each(["Authorization", "access_token", "Cookie", "password"])(
    "rejects sensitive transcript header %s without leaking its value",
    (headerName) => {
      const step = {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        status: 200,
        data: {},
        headers: { [headerName]: "raw-transcript-secret" },
      } as ScriptedGitHubStep;

      let error: unknown;
      try {
        createScriptedGitHubTransport([step]);
      } catch (reason) {
        error = reason;
      }
      expect(String(error)).toContain(
        "Scripted GitHub transcript contains credential-bearing headers",
      );
      expect(String(error)).not.toContain("raw-transcript-secret");
    },
  );

  it("rejects case-colliding response headers deterministically", () => {
    const step = {
      kind: "rest",
      operation: "getViewer",
      method: "GET",
      path: "/user",
      status: 200,
      data: {},
      headers: {
        "X-Request-ID": "raw-first-value",
        "x-request-id": "raw-second-value",
      },
    } as ScriptedGitHubStep;

    let error: unknown;
    try {
      createScriptedGitHubTransport([step]);
    } catch (reason) {
      error = reason;
    }
    expect(String(error)).toBe(
      "Error: Scripted GitHub transcript contains colliding header names",
    );
    expect(String(error)).not.toMatch(/raw-(?:first|second)-value/u);
  });

  it.each([500, 429])(
    "returns the first REST %i response once without retrying or consuming the next step",
    async (status) => {
      const scripted = createScriptedGitHubTransport([
        {
          kind: "rest",
          operation: "getViewer",
          method: "GET",
          path: "/user",
          status,
          data: { attempt: 1 },
        },
        {
          kind: "rest",
          operation: "getViewer",
          method: "GET",
          path: "/user",
          status: 200,
          data: { attempt: 2 },
        },
      ]);

      await expect(
        scripted.transport.rest("getViewer", {}),
      ).resolves.toMatchObject({ status, data: { attempt: 1 } });
      expect(scripted.requests).toHaveLength(1);
      expect(() => scripted.assertExhausted()).toThrow(
        "Scripted GitHub transport has 1 unused step; next is rest:getViewer",
      );
    },
  );

  it("returns one GraphQL error envelope without retrying or consuming the next step", async () => {
    const scripted = createScriptedGitHubTransport([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: null,
        errors: [
          {
            message: "preview unavailable",
            type: null,
            path: null,
          },
        ],
      },
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: { attempt: 2 },
      },
    ]);

    await expect(
      scripted.transport.graphql("listLists", { cursor: null }),
    ).resolves.toMatchObject({
      status: 200,
      data: null,
      errors: [{ message: "preview unavailable" }],
    });
    expect(scripted.requests).toHaveLength(1);
    expect(() => scripted.assertExhausted()).toThrow(
      "Scripted GitHub transport has 1 unused step; next is graphql:listLists",
    );
  });

  it("rejects transcript routes that do not match their named operation", () => {
    const invalidRestStep = {
      kind: "rest",
      operation: "getViewer",
      method: "GET",
      path: "/repos/steal",
      status: 200,
    } as unknown as ScriptedGitHubStep;
    const invalidGraphqlStep = {
      kind: "graphql",
      operation: "listLists",
      graphqlOperation: "InjectedDocument",
      status: 200,
    } as unknown as ScriptedGitHubStep;

    expect(() => createScriptedGitHubTransport([invalidRestStep])).toThrow(
      "Scripted GitHub transcript route does not match rest:getViewer",
    );
    expect(() => createScriptedGitHubTransport([invalidGraphqlStep])).toThrow(
      "Scripted GitHub transcript document does not match graphql:listLists",
    );
  });

  it("rejects invalid occurrence lookups without exposing transcript data", async () => {
    const scripted = createScriptedGitHubTransport([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: null,
      },
    ]);
    await scripted.transport.graphql("listLists", { cursor: "private-value" });

    expect(() => scripted.graphqlVariables("listLists", -1)).toThrow(
      "GraphQL occurrence must be a non-negative integer",
    );
    expect(() => scripted.graphqlVariables("listItems")).toThrow(
      "No recorded GraphQL request for listItems occurrence 0",
    );
    expect(() => scripted.graphqlVariables("listLists", 2)).toThrow(
      "No recorded GraphQL request for listLists occurrence 2",
    );
    expect(JSON.stringify(scripted.requests)).not.toContain("raw-secret-token");
  });
});
