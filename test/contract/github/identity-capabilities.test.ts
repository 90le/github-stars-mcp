import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  GitHubCapabilities,
  GitHubStarReadPort,
  GitHubStatusReadPort,
} from "../../../src/app/ports/github-port.js";
import { AppError } from "../../../src/domain/errors.js";
import type {
  GitHubTransport,
  GraphqlReadOperation,
  GraphqlTransportResponse,
  RestReadOperation,
  RestTransportResponse,
} from "../../../src/github/allowed-operations.js";
import { OctokitGitHubAdapter } from "../../../src/github/octokit-github-adapter.js";
import { viewerListsData } from "../../support/read-service-fixtures.js";
import { createScriptedGitHubAdapter } from "../../support/scripted-github-adapter.js";

function graphqlError(type: string | null, message = "raw-remote-secret") {
  return Object.freeze({
    message,
    type,
    path: Object.freeze(["viewer", "lists"]),
  });
}

function customTransport(input: {
  readonly rest?: (
    operation: string,
    signal: AbortSignal | undefined,
  ) => unknown;
  readonly graphql?: (
    operation: string,
    signal: AbortSignal | undefined,
  ) => unknown;
}): GitHubTransport {
  return {
    rest<T>(
      operation: RestReadOperation,
      _parameters: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<RestTransportResponse<T>> {
      const response =
        input.rest?.(operation, signal) ??
        ({
          data: [],
          status: 200,
          headers: {},
        } satisfies RestTransportResponse<unknown>);
      return Promise.resolve(response as RestTransportResponse<T>);
    },
    graphql<T>(
      operation: GraphqlReadOperation,
      _variables: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<GraphqlTransportResponse<T>> {
      const response =
        input.graphql?.(operation, signal) ??
        ({
          data: viewerListsData(),
          errors: [],
          status: 200,
          headers: {},
          rateLimit: null,
        } satisfies GraphqlTransportResponse<unknown>);
      return Promise.resolve(response as GraphqlTransportResponse<T>);
    },
  };
}

describe("GitHub identity and capability contracts", () => {
  it("exposes the final read methods without mutation stubs", () => {
    expectTypeOf<GitHubStatusReadPort>().toHaveProperty("getViewer");
    expectTypeOf<GitHubStatusReadPort>().toHaveProperty("probeCapabilities");
    expectTypeOf<GitHubStarReadPort>().toHaveProperty(
      "listStarredRepositories",
    );
    expectTypeOf<OctokitGitHubAdapter>().toMatchTypeOf<GitHubStarReadPort>();

    expect(
      Object.getOwnPropertyNames(OctokitGitHubAdapter.prototype).sort(),
    ).toEqual(
      [
        "constructor",
        "getReadme",
        "getViewer",
        "listStarredRepositories",
        "listUserListItems",
        "listUserLists",
        "probeCapabilities",
        "searchRepositories",
      ].sort(),
    );
  });

  it("returns a detached frozen identity bound to github.com and propagates the signal", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        status: 200,
        data: { node_id: "U_7", login: "octocat" },
      },
    ]);
    const controller = new AbortController();

    const viewer = await scripted.adapter.getViewer(controller.signal);

    expect(viewer).toEqual({
      host: "github.com",
      login: "octocat",
      accountId: "U_7",
    });
    expect(Object.isFrozen(viewer)).toBe(true);
    expect(scripted.requests).toEqual([
      {
        kind: "rest",
        operation: "getViewer",
        method: "GET",
        path: "/user",
        parameters: {},
      },
    ]);
  });

  it("forwards the exact signal object to identity and both capability probes", async () => {
    const seen: AbortSignal[] = [];
    const adapter = new OctokitGitHubAdapter(
      customTransport({
        rest: (operation, signal) => {
          if (signal !== undefined) seen.push(signal);
          return operation === "getViewer"
            ? {
                data: { node_id: "U_1", login: "octocat" },
                status: 200,
                headers: {},
              }
            : { data: [], status: 200, headers: {} };
        },
        graphql: (_operation, signal) => {
          if (signal !== undefined) seen.push(signal);
          return {
            data: viewerListsData(),
            errors: [],
            status: 200,
            headers: {},
            rateLimit: null,
          };
        },
      }),
    );
    const controller = new AbortController();

    await adapter.getViewer(controller.signal);
    await adapter.probeCapabilities(controller.signal);

    expect(seen).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it.each([
    ["null", null],
    ["empty account id", { node_id: "", login: "octocat" }],
    ["trimmed login mismatch", { node_id: "U_1", login: " octocat" }],
    ["control in login", { node_id: "U_1", login: "octo\ncat" }],
    ["invalid Unicode", { node_id: "U_1", login: "\ud800" }],
    ["wrong primitive", { node_id: 1, login: "octocat" }],
  ])(
    "rejects malformed identity data (%s) without leaking it",
    async (_label, data) => {
      const adapter = new OctokitGitHubAdapter(
        customTransport({
          rest: () => ({ data, status: 200, headers: {} }),
        }),
      );

      const error = await adapter
        .getViewer()
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
        details: { operation: "getViewer", reason: "malformed_remote_data" },
      });
      expect(JSON.stringify(error)).not.toMatch(
        /octo\\ncat|raw-remote-secret/u,
      );
    },
  );

  it("rejects an accessor envelope without invoking it", async () => {
    let touched = false;
    const response: Record<string, unknown> = {
      status: 200,
      headers: {},
    };
    Object.defineProperty(response, "data", {
      enumerable: true,
      get() {
        touched = true;
        return { node_id: "U_secret", login: "raw-secret" };
      },
    });
    const adapter = new OctokitGitHubAdapter(
      customTransport({ rest: () => response }),
    );

    await expect(adapter.getViewer()).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { operation: "getViewer", reason: "malformed_remote_data" },
    });
    expect(touched).toBe(false);
  });

  it("probes Stars and Lists independently using only fixed read operations", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        status: 200,
        data: [],
      },
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData(),
      },
    ]);

    await expect(scripted.adapter.probeCapabilities()).resolves.toEqual({
      starRead: "available",
      starWrite: "unknown",
      listRead: "available",
      listWrite: "unknown",
    } satisfies GitHubCapabilities);
    expect(scripted.requests).toEqual([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        parameters: { page: 1, per_page: 1 },
      },
      expect.objectContaining({
        kind: "graphql",
        operation: "listLists",
        variables: { cursor: null },
      }),
    ]);
    expect(JSON.stringify(scripted.requests)).not.toMatch(
      /accept|header|media|https?:|documentOverride/u,
    );
  });

  it("does not apply the formal per-page-100 Link contract to a per-page-1 Star probe", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        status: 200,
        data: [],
        headers: {
          link: '<https://api.github.com/user/starred?page=2&per_page=1>; rel="next"',
        },
      },
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData(),
      },
    ]);

    await expect(scripted.adapter.probeCapabilities()).resolves.toMatchObject({
      starRead: "available",
      listRead: "available",
    });
  });

  it("maps revoked Proxy identity data to a sanitized malformed-remote error", async () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const adapter = new OctokitGitHubAdapter(
      customTransport({
        rest: () => ({
          data: revocable.proxy,
          status: 200,
          headers: {},
        }),
      }),
    );

    await expect(adapter.getViewer()).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });
  });

  it.each([
    ["AUTH_REQUIRED", "unavailable"],
    ["INSUFFICIENT_PERMISSION", "unavailable"],
    ["NOT_FOUND", "unavailable"],
    ["RATE_LIMITED", "unknown"],
    ["SECONDARY_RATE_LIMITED", "unknown"],
    ["GITHUB_UNAVAILABLE", "unknown"],
  ] as const)(
    "maps a %s Star probe failure to %s while still probing Lists",
    async (code, expected) => {
      const graphql = vi.fn(() => ({
        data: viewerListsData(),
        errors: [],
        status: 200,
        headers: {},
        rateLimit: null,
      }));
      const adapter = new OctokitGitHubAdapter(
        customTransport({
          rest: () => {
            throw new AppError(code, "raw-secret", { retryable: true });
          },
          graphql,
        }),
      );

      await expect(adapter.probeCapabilities()).resolves.toMatchObject({
        starRead: expected,
        listRead: "available",
      });
      expect(graphql).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["undefinedField", "unavailable"],
    ["undefinedType", "unavailable"],
    ["UNAUTHENTICATED", "unavailable"],
    ["FORBIDDEN", "unavailable"],
    ["NOT_FOUND", "unavailable"],
    ["RATE_LIMITED", "unknown"],
    ["SECONDARY_RATE_LIMITED", "unknown"],
    ["INTERNAL", "unknown"],
    ["GRAPHQL_VALIDATION_FAILED", "unknown"],
    ["UndefinedField", "unknown"],
    ["UNKNOWN_REMOTE_SECRET", "unknown"],
  ] as const)(
    "maps GraphQL type %s to List capability %s",
    async (type, expected) => {
      const scripted = createScriptedGitHubAdapter([
        {
          kind: "rest",
          operation: "listStars",
          method: "GET",
          path: "/user/starred",
          status: 200,
          data: [],
        },
        {
          kind: "graphql",
          operation: "listLists",
          graphqlOperation: "ViewerLists",
          status: 200,
          data: viewerListsData([{ id: "raw-partial-secret" }]),
          errors: [graphqlError(type)],
        },
      ]);

      await expect(scripted.adapter.probeCapabilities()).resolves.toMatchObject(
        {
          starRead: "available",
          listRead: expected,
          listWrite: expected === "unavailable" ? "unavailable" : "unknown",
        },
      );
    },
  );

  it("uses deterministic GraphQL error precedence rather than array order or messages", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        status: 200,
        data: [],
      },
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData(),
        errors: [
          graphqlError("INTERNAL"),
          graphqlError("undefinedField"),
          graphqlError("FORBIDDEN"),
        ],
      },
    ]);

    await expect(scripted.adapter.probeCapabilities()).resolves.toMatchObject({
      listRead: "unavailable",
      listWrite: "unavailable",
    });
  });

  it("propagates cancellation instead of caching it as an unknown capability", async () => {
    const controller = new AbortController();
    controller.abort(new Error("raw-abort-secret"));
    const scripted = createScriptedGitHubAdapter([]);

    await expect(
      scripted.adapter.probeCapabilities(controller.signal),
    ).rejects.toBeInstanceOf(DOMException);
    expect(scripted.requests).toEqual([]);
  });
});
