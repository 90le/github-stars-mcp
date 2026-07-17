import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  GitHubPort,
  GitHubSearchInput,
} from "../../../src/app/ports/github-port.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import type {
  GitHubTransport,
  GraphqlTransportResponse,
  RestReadOperation,
  RestTransportResponse,
} from "../../../src/github/allowed-operations.js";
import { OctokitGitHubAdapter } from "../../../src/github/octokit-github-adapter.js";
import { rawRestRepository } from "../../support/read-service-fixtures.js";
import { createScriptedGitHubAdapter } from "../../support/scripted-github-adapter.js";

const baseInput = Object.freeze({
  query: "mcp language:TypeScript",
  sort: "stars",
  order: "desc",
  page: 1,
  perPage: 50,
}) satisfies GitHubSearchInput;

function searchStep(
  data: unknown,
  headers: Readonly<Record<string, string | undefined>> = {},
) {
  return {
    kind: "rest" as const,
    operation: "searchRepositories" as const,
    method: "GET" as const,
    path: "/search/repositories" as const,
    status: 200,
    data,
    headers,
  };
}

function secondRepository() {
  return rawRestRepository({
    id: 43,
    node_id: "R_43",
    owner: { login: "acme" },
    name: "agent",
    full_name: "acme/agent",
    html_url: "https://github.com/acme/agent",
  });
}

function transport(
  implementation: GitHubTransport["rest"] = <T>() =>
    Promise.resolve({
      data: {
        total_count: 0,
        incomplete_results: false,
        items: [],
      } as T,
      status: 200,
      headers: {},
    }),
) {
  const rest = vi.fn(
    (
      operation: RestReadOperation,
      parameters: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ) => implementation<unknown>(operation, parameters, signal),
  );
  const port: GitHubTransport = {
    rest<T>(
      operation: RestReadOperation,
      parameters: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<RestTransportResponse<T>> {
      return rest(operation, parameters, signal) as Promise<
        RestTransportResponse<T>
      >;
    },
    graphql<T>(): Promise<GraphqlTransportResponse<T>> {
      return Promise.reject(new Error("unexpected GraphQL request"));
    },
    restMutation(): Promise<never> {
      return Promise.reject(new Error("unexpected REST mutation"));
    },
    graphqlMutation(): Promise<never> {
      return Promise.reject(new Error("unexpected GraphQL mutation"));
    },
  };
  return { port, rest };
}

async function expectCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await action().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AppError);
  expect(serializeError(error).code).toBe(code);
}

describe("GitHub repository Search adapter", () => {
  it("keeps the adapter on the approved named port", () => {
    expectTypeOf<OctokitGitHubAdapter>().toMatchTypeOf<GitHubPort>();
    expect(
      Object.getOwnPropertyNames(OctokitGitHubAdapter.prototype).sort(),
    ).toEqual(
      [
        "constructor",
        "checkStar",
        "createUserList",
        "deleteUserList",
        "getReadme",
        "getRepositoryIdentity",
        "getRepositoryListIds",
        "getUserList",
        "getViewer",
        "listStarredRepositories",
        "listUserListItems",
        "listUserLists",
        "probeCapabilities",
        "searchRepositories",
        "setRepositoryListIds",
        "star",
        "unstar",
        "updateUserList",
      ].sort(),
    );
  });

  it("uses only the fixed Search operation, normalizes repositories, and exposes cap state", async () => {
    const scripted = createScriptedGitHubAdapter([
      searchStep(
        {
          total_count: 5_432,
          incomplete_results: true,
          items: [rawRestRepository(), secondRepository()],
        },
        {
          "x-ratelimit-remaining": "29",
          "x-ratelimit-reset": "1784336400",
        },
      ),
    ]);
    const signal = new AbortController().signal;

    const result = await scripted.adapter.searchRepositories(baseInput, signal);

    expect(result).toMatchObject({
      totalCount: 5_432,
      incompleteResults: true,
      nextPage: 2,
      rateLimit: {
        remaining: 29,
        resetAt: "2026-07-18T01:00:00.000Z",
      },
    });
    expect(result.items.map((item) => item.repositoryId)).toEqual([
      "R_42",
      "R_43",
    ]);
    expect(scripted.requests).toEqual([
      {
        kind: "rest",
        operation: "searchRepositories",
        method: "GET",
        path: "/search/repositories",
        parameters: {
          q: "mcp language:TypeScript",
          sort: "stars",
          order: "desc",
          page: 1,
          per_page: 50,
        },
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.every(Object.isFrozen)).toBe(true);
    expect(result.items.every((item) => Object.isFrozen(item.topics))).toBe(
      true,
    );
  });

  it.each([
    [19, 50, 5_432, 20],
    [20, 50, 5_432, null],
    [999, 1, 1_000, 1_000],
    [1_000, 1, 5_432, null],
    [1, 50, 100, 2],
  ])(
    "computes next page from the reported total and 1,000 cap: page %s limit %s",
    async (page, perPage, totalCount, nextPage) => {
      const scripted = createScriptedGitHubAdapter([
        searchStep({
          total_count: totalCount,
          incomplete_results: false,
          items: [],
        }),
      ]);

      const result = await scripted.adapter.searchRepositories({
        ...baseInput,
        page,
        perPage,
      });

      expect(result.nextPage).toBe(nextPage);
    },
  );

  it("does not infer pagination from a short or empty item array", async () => {
    const scripted = createScriptedGitHubAdapter([
      searchStep({
        total_count: 100,
        incomplete_results: false,
        items: [],
      }),
    ]);

    await expect(
      scripted.adapter.searchRepositories(baseInput),
    ).resolves.toMatchObject({
      nextPage: 2,
    });
  });

  it.each([
    ["empty query", { query: "" }],
    ["oversized query", { query: "x".repeat(257) }],
    ["control query", { query: "mcp\u0000" }],
    ["bad sort", { sort: "watchers" }],
    ["bad order", { order: "sideways" }],
    ["zero page", { page: 0 }],
    ["fractional page", { page: 1.5 }],
    ["zero limit", { perPage: 0 }],
    ["large limit", { perPage: 101 }],
    ["past cap", { page: 21, perPage: 50 }],
  ])("rejects invalid %s before transport", async (_label, patch) => {
    const remote = transport();
    const adapter = new OctokitGitHubAdapter(remote.port);

    await expectCode(
      () =>
        adapter.searchRepositories({
          ...baseInput,
          ...patch,
        } as GitHubSearchInput),
      "VALIDATION_ERROR",
    );
    expect(remote.rest).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, accessors, and Proxies without invoking caller code", async () => {
    let getterCalls = 0;
    let proxyCalls = 0;
    const unknown = { ...baseInput, headers: { authorization: "never" } };
    const accessor = Object.defineProperty({ ...baseInput }, "query", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "mcp";
      },
    });
    const proxy = new Proxy(
      { ...baseInput },
      {
        ownKeys: () => {
          proxyCalls += 1;
          return [];
        },
      },
    );
    const remote = transport();
    const adapter = new OctokitGitHubAdapter(remote.port);

    for (const input of [unknown, accessor, proxy]) {
      await expectCode(
        () => adapter.searchRepositories(input),
        "VALIDATION_ERROR",
      );
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
    expect(remote.rest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "negative total",
      { total_count: -1, incomplete_results: false, items: [] },
    ],
    [
      "unsafe total",
      {
        total_count: Number.MAX_SAFE_INTEGER + 1,
        incomplete_results: false,
        items: [],
      },
    ],
    [
      "wrong incomplete flag",
      { total_count: 1, incomplete_results: "false", items: [] },
    ],
    [
      "unknown envelope key",
      {
        total_count: 1,
        incomplete_results: false,
        items: [],
        secret: "ghp_remote_secret",
      },
    ],
    [
      "oversized page",
      {
        total_count: 51,
        incomplete_results: false,
        items: Array.from({ length: 51 }, () => rawRestRepository()),
      },
    ],
    [
      "malformed repository",
      {
        total_count: 1,
        incomplete_results: false,
        items: [rawRestRepository({ id: -1 })],
      },
    ],
  ])("fails closed for a malformed %s", async (_label, data) => {
    const scripted = createScriptedGitHubAdapter([searchStep(data)]);

    await expectCode(
      () => scripted.adapter.searchRepositories(baseInput),
      "GITHUB_UNAVAILABLE",
    );
  });

  it("passes the exact AbortSignal to one fixed transport call", async () => {
    const signal = new AbortController().signal;
    let received: AbortSignal | undefined;
    const remote = transport(
      <T>(
        operation: RestReadOperation,
        parameters: Readonly<Record<string, unknown>>,
        actualSignal?: AbortSignal,
      ): Promise<RestTransportResponse<T>> => {
        expect(operation).toBe("searchRepositories");
        expect(parameters).toEqual({
          q: baseInput.query,
          sort: baseInput.sort,
          order: baseInput.order,
          page: baseInput.page,
          per_page: baseInput.perPage,
        });
        received = actualSignal;
        return Promise.resolve({
          data: {
            total_count: 0,
            incomplete_results: false,
            items: [],
          } as T,
          status: 200,
          headers: {},
        });
      },
    );

    await new OctokitGitHubAdapter(remote.port).searchRepositories(
      baseInput,
      signal,
    );
    expect(received).toBe(signal);
    expect(remote.rest).toHaveBeenCalledOnce();
  });
});
