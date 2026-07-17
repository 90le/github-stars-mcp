import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import type {
  GitHubTransport,
  RestReadOperation,
  RestTransportResponse,
} from "../../../src/github/allowed-operations.js";
import { OctokitGitHubAdapter } from "../../../src/github/octokit-github-adapter.js";
import {
  rawRestRepository,
  rawStar,
} from "../../support/read-service-fixtures.js";
import { createScriptedGitHubAdapter } from "../../support/scripted-github-adapter.js";

function restOnlyTransport(
  response: unknown,
  dispatch = vi.fn(),
): GitHubTransport {
  return {
    rest<T>(
      _operation: RestReadOperation,
      _parameters: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<RestTransportResponse<T>> {
      dispatch(signal);
      return Promise.resolve(response as RestTransportResponse<T>);
    },
    graphql(): Promise<never> {
      return Promise.reject(new Error("unexpected GraphQL request"));
    },
  };
}

async function rejectedError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("REST Star read contracts", () => {
  it("normalizes a complete Star page, strict next link, and REST rate state", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        status: 200,
        data: [rawStar()],
        headers: {
          link: '<https://api.github.com/user/starred?page=2&per_page=100>; rel="next", <https://api.github.com/user/starred?page=9&per_page=100>; rel="last"',
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": "1784336400",
        },
      },
    ]);
    const controller = new AbortController();

    const page = await scripted.adapter.listStarredRepositories(
      null,
      controller.signal,
    );

    expect(page).toEqual({
      items: [
        {
          starredAt: "2026-07-18T00:00:00.000Z",
          repository: {
            repositoryId: "R_42",
            repositoryDatabaseId: "42",
            owner: "octocat",
            name: "tool",
            fullName: "octocat/tool",
            description: "A useful tool",
            url: "https://github.com/octocat/tool",
            stargazerCount: 12_345,
            isFork: false,
            isArchived: false,
            isDisabled: false,
            isPrivate: false,
            visibility: "public",
            primaryLanguage: "TypeScript",
            topics: ["ai", "mcp"],
            licenseSpdxId: "Apache-2.0",
            pushedAt: "2026-07-17T01:02:03.000Z",
            updatedAt: "2026-07-17T04:05:06.007Z",
          },
        },
      ],
      nextCursor: "2",
      rateLimit: {
        remaining: 4_999,
        resetAt: "2026-07-18T01:00:00.000Z",
      },
      warnings: [],
    });
    expect(scripted.requests).toEqual([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        parameters: { page: 1, per_page: 100 },
      },
    ]);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(Object.isFrozen(page.items[0]?.repository)).toBe(true);
    expect(Object.isFrozen(page.items[0]?.repository.topics)).toBe(true);
    expect(Object.isFrozen(page.rateLimit)).toBe(true);
    expect(Object.isFrozen(page.warnings)).toBe(true);
  });

  it("uses canonical positive decimal cursor pages and validates before dispatch", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        status: 200,
        data: [],
      },
    ]);

    await scripted.adapter.listStarredRepositories("2");
    expect(scripted.requests[0]).toMatchObject({
      parameters: { page: 2, per_page: 100 },
    });

    for (const cursor of ["", "0", "01", "-1", "1.0", " 2", "2 ", "９"]) {
      const invalid = createScriptedGitHubAdapter([]);
      await expect(
        invalid.adapter.listStarredRepositories(cursor),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
        details: {
          operation: "listStarredRepositories",
          reason: "invalid_cursor",
        },
      });
      expect(invalid.requests).toEqual([]);
    }
  });

  it.each([
    [
      "duplicate next",
      '<https://api.github.com/user/starred?page=2>; rel="next", <https://api.github.com/user/starred?page=3>; rel="next"',
    ],
    ["cross origin", '<https://evil.example/user/starred?page=2>; rel="next"'],
    [
      "userinfo",
      '<https://user@api.github.com/user/starred?page=2>; rel="next"',
    ],
    ["port", '<https://api.github.com:443/user/starred?page=2>; rel="next"'],
    [
      "wrong path",
      '<https://api.github.com/users/x/starred?page=2>; rel="next"',
    ],
    [
      "unrelated query",
      '<https://api.github.com/user/starred?page=2&token=raw-secret>; rel="next"',
    ],
    [
      "duplicate page",
      '<https://api.github.com/user/starred?page=2&page=3>; rel="next"',
    ],
    [
      "noncanonical page",
      '<https://api.github.com/user/starred?page=02>; rel="next"',
    ],
    [
      "encoded page",
      '<https://api.github.com/user/starred?page=%32>; rel="next"',
    ],
    [
      "malformed quote",
      '<https://api.github.com/user/starred?page=2>; rel="next',
    ],
    [
      "unquoted relation",
      "<https://api.github.com/user/starred?page=2>; rel=next",
    ],
    [
      "empty fragment",
      '<https://api.github.com/user/starred?page=2#>; rel="next"',
    ],
    [
      "dot segment",
      '<https://api.github.com/x/../user/starred?page=2>; rel="next"',
    ],
    [
      "unsafe page",
      '<https://api.github.com/user/starred?page=9007199254740992>; rel="next"',
    ],
    [
      "wrong per page",
      '<https://api.github.com/user/starred?page=2&per_page=99>; rel="next"',
    ],
    [
      "duplicate per page",
      '<https://api.github.com/user/starred?page=2&per_page=100&per_page=100>; rel="next"',
    ],
    [
      "duplicate relation token",
      '<https://api.github.com/user/starred?page=2>; rel="next next"',
    ],
    [
      "duplicate relation attribute",
      '<https://api.github.com/user/starred?page=2>; rel="next"; rel="last"',
    ],
  ])("rejects a malformed Link header (%s)", async (_label, link) => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "listStars",
        method: "GET",
        path: "/user/starred",
        status: 200,
        data: [],
        headers: { link },
      },
    ]);

    const error = await rejectedError(
      scripted.adapter.listStarredRepositories(null),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: {
        operation: "listStarredRepositories",
        reason: "malformed_remote_data",
      },
    });
    expect(JSON.stringify(error)).not.toContain("raw-secret");
    expect(scripted.requests).toHaveLength(1);
  });

  it.each([
    ["page primitive", "raw-page-secret"],
    ["oversized page", Array.from({ length: 101 }, () => rawStar())],
    [
      "malformed Star",
      [{ starred_at: "raw-star-secret", repo: rawRestRepository() }],
    ],
    ["missing repository", [{ starred_at: "2026-07-18T00:00:00Z" }]],
    [
      "unsafe database ID",
      [rawStar({ repo: rawRestRepository({ id: 2 ** 53 }) })],
    ],
    [
      "negative database ID",
      [rawStar({ repo: rawRestRepository({ id: -1 }) })],
    ],
    [
      "invalid node ID",
      [rawStar({ repo: rawRestRepository({ node_id: "\ud800" }) })],
    ],
    [
      "cross-origin URL",
      [
        rawStar({
          repo: rawRestRepository({
            html_url: "https://evil.example/raw-secret",
          }),
        }),
      ],
    ],
    [
      "explicit default URL port",
      [
        rawStar({
          repo: rawRestRepository({
            html_url: "https://github.com:443/octocat/tool",
          }),
        }),
      ],
    ],
    [
      "URL dot segment",
      [
        rawStar({
          repo: rawRestRepository({
            html_url: "https://github.com/x/../octocat/tool",
          }),
        }),
      ],
    ],
    [
      "inconsistent full name",
      [rawStar({ repo: rawRestRepository({ full_name: "other/tool" }) })],
    ],
    [
      "invalid repository timestamp",
      [
        rawStar({
          repo: rawRestRepository({ updated_at: "2026-07-18T00:00:00.0001Z" }),
        }),
      ],
    ],
    [
      "invalid topic",
      [rawStar({ repo: rawRestRepository({ topics: ["ok", "\ud800"] }) })],
    ],
  ])(
    "rejects malformed Star data (%s) without raw leakage",
    async (_label, data) => {
      const adapter = new OctokitGitHubAdapter(
        restOnlyTransport({ data, status: 200, headers: {} }),
      );

      const error = await rejectedError(adapter.listStarredRepositories(null));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        details: {
          operation: "listStarredRepositories",
          reason: "malformed_remote_data",
        },
      });
      expect(JSON.stringify(error)).not.toMatch(
        /raw-(?:page|star|secret)|evil\.example/u,
      );
    },
  );

  it("rejects a sparse page before indexing and performs no later dispatch", async () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const dispatch = vi.fn();
    const adapter = new OctokitGitHubAdapter(
      restOnlyTransport({ data: sparse, status: 200, headers: {} }, dispatch),
    );

    await expect(adapter.listStarredRepositories(null)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("maps a revoked Proxy page to a sanitized malformed-remote error", async () => {
    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    const adapter = new OctokitGitHubAdapter(
      restOnlyTransport({
        data: revocable.proxy,
        status: 200,
        headers: {},
      }),
    );

    await expect(adapter.listStarredRepositories(null)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });
  });

  it("forwards the exact signal object to the Star transport call", async () => {
    const dispatch = vi.fn();
    const adapter = new OctokitGitHubAdapter(
      restOnlyTransport({ data: [], status: 200, headers: {} }, dispatch),
    );
    const controller = new AbortController();

    await adapter.listStarredRepositories(null, controller.signal);

    expect(dispatch).toHaveBeenCalledWith(controller.signal);
  });

  it.each([
    [{ "x-ratelimit-remaining": "1" }],
    [{ "x-ratelimit-reset": "1784336400" }],
    [
      {
        "x-ratelimit-remaining": "-1",
        "x-ratelimit-reset": "1784336400",
      },
    ],
    [
      {
        "x-ratelimit-remaining": "1",
        "x-ratelimit-reset": "raw-rate-secret",
      },
    ],
  ])("rejects malformed REST rate headers", async (headers) => {
    const adapter = new OctokitGitHubAdapter(
      restOnlyTransport({ data: [], status: 200, headers }),
    );

    const error = await rejectedError(adapter.listStarredRepositories(null));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: {
        operation: "listStarredRepositories",
        reason: "malformed_remote_data",
      },
    });
    expect(JSON.stringify(error)).not.toContain("raw-rate-secret");
  });
});
