import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  GitHubListItem,
  GitHubSyncReadPort,
} from "../../../src/app/ports/github-port.js";
import { AppError } from "../../../src/domain/errors.js";
import { asUserListId, type UserListId } from "../../../src/domain/ids.js";
import type {
  GitHubTransport,
  GraphqlReadOperation,
  GraphqlTransportResponse,
  RestTransportResponse,
} from "../../../src/github/allowed-operations.js";
import { OctokitGitHubAdapter } from "../../../src/github/octokit-github-adapter.js";
import {
  rawGraphqlRepository,
  rawUserList,
  userListItemsData,
  viewerListsData,
} from "../../support/read-service-fixtures.js";
import { createScriptedGitHubAdapter } from "../../support/scripted-github-adapter.js";

function graphqlError(type: string | null, message = "raw-remote-secret") {
  return Object.freeze({
    message,
    type,
    path: Object.freeze(["viewer", "raw-path-secret"]),
  });
}

type GraphqlResponseFactory = (
  operation: GraphqlReadOperation,
  signal: AbortSignal | undefined,
) => unknown;

function graphqlOnlyTransport(
  response: Readonly<Record<string, unknown>> | GraphqlResponseFactory,
  dispatch = vi.fn(),
): GitHubTransport {
  return {
    rest<T>(): Promise<RestTransportResponse<T>> {
      return Promise.reject(new Error("unexpected REST request"));
    },
    graphql<T>(
      operation: GraphqlReadOperation,
      _variables: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<GraphqlTransportResponse<T>> {
      dispatch(operation, signal);
      const result =
        typeof response === "function" ? response(operation, signal) : response;
      return Promise.resolve(result as GraphqlTransportResponse<T>);
    },
  };
}

async function rejectedError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("GitHub User List read contracts", () => {
  it("exposes the final read methods without mutation stubs", () => {
    expectTypeOf<OctokitGitHubAdapter>().toMatchTypeOf<GitHubSyncReadPort>();
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

  it("normalizes complete List metadata with an independent opaque cursor and rate state", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData(
          [
            rawUserList(),
            rawUserList({
              id: "UL_2",
              name: "Private",
              slug: "private",
              description: null,
              isPrivate: true,
              lastAddedAt: null,
            }),
          ],
          { hasNextPage: true, endCursor: "opaque-list-cursor==" },
        ),
        rateLimit: {
          remaining: 4_997,
          resetAt: "2026-07-18T01:00:00Z",
        },
      },
    ]);
    const controller = new AbortController();

    const page = await scripted.adapter.listUserLists(null, controller.signal);

    expect(page).toEqual({
      items: [
        {
          listId: "UL_1",
          name: "AI",
          slug: "ai",
          description: "AI repositories",
          isPrivate: false,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
          lastAddedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          listId: "UL_2",
          name: "Private",
          slug: "private",
          description: null,
          isPrivate: true,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
          lastAddedAt: null,
        },
      ],
      nextCursor: "opaque-list-cursor==",
      rateLimit: {
        remaining: 4_997,
        resetAt: "2026-07-18T01:00:00.000Z",
      },
      warnings: [],
    });
    expect(scripted.graphqlVariables("listLists")).toEqual({ cursor: null });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(Object.isFrozen(page.rateLimit)).toBe(true);
    expect(Object.isFrozen(page.warnings)).toBe(true);
  });

  it("normalizes repository union members and safely represents unsupported members", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data: userListItemsData(
          [
            rawGraphqlRepository(),
            {
              __typename: "Issue",
              id: "I_1",
              body: "raw-untrusted-secret",
            },
            { __typename: "PullRequest", id: null },
          ],
          { hasNextPage: true, endCursor: "opaque-item-cursor==" },
        ),
        rateLimit: {
          remaining: 4_996,
          resetAt: "2026-07-18T01:00:00Z",
        },
      },
    ]);

    const page = await scripted.adapter.listUserListItems(
      asUserListId("UL_1"),
      null,
    );

    expect(page).toEqual({
      items: [
        {
          kind: "repository",
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
        { kind: "unsupported", typename: "Issue", itemId: "I_1" },
        { kind: "unsupported", typename: "PullRequest", itemId: null },
      ],
      nextCursor: "opaque-item-cursor==",
      rateLimit: {
        remaining: 4_996,
        resetAt: "2026-07-18T01:00:00.000Z",
      },
      warnings: [
        "UserListItems returned unsupported union member Issue",
        "UserListItems returned unsupported union member PullRequest",
      ],
    });
    expect(scripted.graphqlVariables("listItems")).toEqual({
      listId: "UL_1",
      cursor: null,
    });
    expect(JSON.stringify(page)).not.toContain("raw-untrusted-secret");
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(Object.isFrozen(page.items[1])).toBe(true);
    expect(
      Object.isFrozen(
        (page.items[0] as Extract<GitHubListItem, { kind: "repository" }>)
          .repository.topics,
      ),
    ).toBe(true);
    expect(Object.isFrozen(page.warnings)).toBe(true);
  });

  it("represents unsupported union members without Node IDs as nullable records", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data: userListItemsData([{ __typename: "FutureItem" }]),
      },
    ]);

    const page = await scripted.adapter.listUserListItems(
      asUserListId("UL_1"),
      null,
    );

    expect(page.items).toEqual([
      {
        kind: "unsupported",
        typename: "FutureItem",
        itemId: null,
      },
    ]);
    expect(page.warnings).toEqual([
      "UserListItems returned unsupported union member FutureItem",
    ]);
    expect(Object.isFrozen(page.items[0])).toBe(true);
  });

  it("keeps metadata and membership pagination on independent named operations", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData([], {
          hasNextPage: true,
          endCursor: "list-next",
        }),
      },
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data: userListItemsData([], {
          hasNextPage: true,
          endCursor: "item-next",
        }),
      },
    ]);

    await expect(
      scripted.adapter.listUserLists("list-current"),
    ).resolves.toMatchObject({
      nextCursor: "list-next",
    });
    await expect(
      scripted.adapter.listUserListItems(asUserListId("UL_1"), "item-current"),
    ).resolves.toMatchObject({ nextCursor: "item-next" });
    expect(scripted.requests.map((request) => request.operation)).toEqual([
      "listLists",
      "listItems",
    ]);
    expect(scripted.graphqlVariables("listLists")).toEqual({
      cursor: "list-current",
    });
    expect(scripted.graphqlVariables("listItems")).toEqual({
      listId: "UL_1",
      cursor: "item-current",
    });
  });

  it("returns null when hasNextPage is false even with a valid endCursor", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData([], {
          hasNextPage: false,
          endCursor: "ignored-but-valid",
        }),
      },
    ]);

    await expect(scripted.adapter.listUserLists(null)).resolves.toMatchObject({
      nextCursor: null,
    });
  });

  it("forwards the exact signal object to both List operations", async () => {
    const dispatch = vi.fn();
    const adapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport((operation) => {
        const data =
          operation === "listLists" ? viewerListsData() : userListItemsData();
        return {
          data,
          errors: [],
          status: 200,
          headers: {},
          rateLimit: null,
        };
      }, dispatch),
    );
    const controller = new AbortController();

    await adapter.listUserLists(null, controller.signal);
    await adapter.listUserListItems(
      asUserListId("UL_1"),
      null,
      controller.signal,
    );

    expect(dispatch.mock.calls).toEqual([
      ["listLists", controller.signal],
      ["listItems", controller.signal],
    ]);
  });

  it.each([
    ["", "invalid_cursor"],
    ["a\nb", "invalid_cursor"],
    ["\ud800", "invalid_cursor"],
    ["x".repeat(4_097), "invalid_cursor"],
  ])(
    "rejects invalid metadata cursor input before dispatch",
    async (cursor, reason) => {
      const dispatch = vi.fn();
      const adapter = new OctokitGitHubAdapter(
        graphqlOnlyTransport({}, dispatch),
      );

      await expect(adapter.listUserLists(cursor)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        details: { operation: "listUserLists", reason },
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["", null, "invalid_list_id"],
    ["UL\n1", null, "invalid_list_id"],
    [" UL_1", null, "invalid_list_id"],
    ["UL_1 ", null, "invalid_list_id"],
    ["\ud800", null, "invalid_list_id"],
    ["x".repeat(129), null, "invalid_list_id"],
    ["UL_1", "", "invalid_cursor"],
    ["UL_1", "a\u0000b", "invalid_cursor"],
    ["UL_1", "\ud800", "invalid_cursor"],
    ["UL_1", "x".repeat(4_097), "invalid_cursor"],
  ])(
    "rejects invalid membership input before dispatch",
    async (listId, cursor, reason) => {
      const dispatch = vi.fn();
      const adapter = new OctokitGitHubAdapter(
        graphqlOnlyTransport({}, dispatch),
      );

      await expect(
        adapter.listUserListItems(listId as UserListId, cursor),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        details: { operation: "listUserListItems", reason },
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wrong hasNextPage", { hasNextPage: "yes", endCursor: null }],
    ["missing cursor", { hasNextPage: true, endCursor: null }],
    ["empty cursor", { hasNextPage: true, endCursor: "" }],
    ["control cursor", { hasNextPage: true, endCursor: "a\nb" }],
    ["invalid Unicode cursor", { hasNextPage: true, endCursor: "\ud800" }],
    ["oversized cursor", { hasNextPage: true, endCursor: "x".repeat(4_097) }],
    ["wrong terminal cursor", { hasNextPage: false, endCursor: 1 }],
  ])("rejects malformed pageInfo (%s)", async (_label, pageInfo) => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData([], pageInfo),
      },
    ]);

    await expect(scripted.adapter.listUserLists(null)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: {
        operation: "ViewerLists",
        reason: "malformed_remote_data",
      },
    });
    expect(scripted.requests).toHaveLength(1);
  });

  it.each([
    ["oversized page", Array.from({ length: 101 }, () => rawUserList())],
    ["empty ID", [rawUserList({ id: "" })]],
    ["invalid name", [rawUserList({ name: "\ud800" })]],
    ["invalid timestamp", [rawUserList({ updatedAt: "raw-list-secret" })]],
    ["wrong privacy", [rawUserList({ isPrivate: "false" })]],
  ])(
    "rejects malformed List metadata (%s) without leakage",
    async (_label, nodes) => {
      const scripted = createScriptedGitHubAdapter([
        {
          kind: "graphql",
          operation: "listLists",
          graphqlOperation: "ViewerLists",
          status: 200,
          data: viewerListsData(nodes),
        },
      ]);

      const error = await rejectedError(scripted.adapter.listUserLists(null));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        details: {
          operation: "ViewerLists",
          reason: "malformed_remote_data",
        },
      });
      expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
        "raw-list-secret",
      );
    },
  );

  it.each([
    ["unsafe database ID", rawGraphqlRepository({ databaseId: 2 ** 53 })],
    ["negative database ID", rawGraphqlRepository({ databaseId: -1 })],
    [
      "inconsistent full name",
      rawGraphqlRepository({ nameWithOwner: "other/tool" }),
    ],
    [
      "explicit URL port",
      rawGraphqlRepository({
        url: "https://github.com:443/octocat/tool",
      }),
    ],
    [
      "invalid topic",
      rawGraphqlRepository({
        repositoryTopics: { nodes: [{ topic: { name: "\ud800" } }] },
      }),
    ],
    [
      "invalid repository timestamp",
      rawGraphqlRepository({ updatedAt: "raw-repository-secret" }),
    ],
  ])(
    "rejects malformed GraphQL repository (%s) without leakage",
    async (_label, repository) => {
      const scripted = createScriptedGitHubAdapter([
        {
          kind: "graphql",
          operation: "listItems",
          graphqlOperation: "UserListItems",
          status: 200,
          data: userListItemsData([repository]),
        },
      ]);

      const error = await rejectedError(
        scripted.adapter.listUserListItems(asUserListId("UL_1"), null),
      );

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        details: {
          operation: "UserListItems",
          reason: "malformed_remote_data",
        },
      });
      expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
        "raw-repository-secret",
      );
    },
  );

  it.each([
    [{ __typename: "", id: "I_1" }],
    [{ __typename: "x".repeat(129), id: "I_1" }],
    [{ __typename: "\ud800", id: "I_1" }],
    [{ __typename: "Issue raw-secret", id: "I_1" }],
    [{ __typename: "Issue-Secret", id: "I_1" }],
    [{ __typename: "Issue", id: "x".repeat(129) }],
    [{ __typename: "Issue", id: 1 }],
    [{ id: "I_1" }],
  ])("rejects malformed unsupported union members", async (member) => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data: userListItemsData([member]),
      },
    ]);

    await expect(
      scripted.adapter.listUserListItems(asUserListId("UL_1"), null),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: {
        operation: "UserListItems",
        reason: "malformed_remote_data",
      },
    });
  });

  it.each([
    ["missing node", { ...userListItemsData(), node: null }],
    [
      "non-UserList node",
      { ...userListItemsData(), node: { __typename: "Issue" } },
    ],
  ])("maps %s to sanitized NOT_FOUND", async (_label, data) => {
    const rawListId = "UL_raw-secret";
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data,
      },
    ]);

    const error = await rejectedError(
      scripted.adapter.listUserListItems(asUserListId(rawListId), null),
    );

    expect(error).toMatchObject({
      code: "NOT_FOUND",
      retryable: false,
      details: { operation: "UserListItems", reason: "not_found" },
    });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
      rawListId,
    );
  });

  it.each([
    ["UNAUTHENTICATED", "AUTH_REQUIRED", false],
    ["FORBIDDEN", "INSUFFICIENT_PERMISSION", false],
    ["SECONDARY_RATE_LIMITED", "SECONDARY_RATE_LIMITED", true],
    ["ABUSE_DETECTED", "SECONDARY_RATE_LIMITED", true],
    ["RATE_LIMITED", "RATE_LIMITED", true],
    ["NOT_FOUND", "NOT_FOUND", false],
    ["undefinedField", "CAPABILITY_UNAVAILABLE", false],
    ["undefinedType", "CAPABILITY_UNAVAILABLE", false],
    ["INTERNAL", "GITHUB_UNAVAILABLE", true],
    ["GRAPHQL_VALIDATION_FAILED", "GITHUB_UNAVAILABLE", false],
    ["UNKNOWN_RAW_SECRET", "GITHUB_UNAVAILABLE", false],
  ] as const)(
    "maps GraphQL semantic type %s to %s",
    async (type, code, retryable) => {
      const scripted = createScriptedGitHubAdapter([
        {
          kind: "graphql",
          operation: "listLists",
          graphqlOperation: "ViewerLists",
          status: 200,
          data: viewerListsData([rawUserList({ name: "raw-partial-secret" })]),
          errors: [graphqlError(type)],
        },
      ]);

      const error = await rejectedError(scripted.adapter.listUserLists(null));

      expect(error).toMatchObject({
        code,
        retryable,
        details: {
          operation: "ViewerLists",
          errorCount: 1,
        },
      });
      expect(`${error.message}${JSON.stringify(error.details)}`).not.toMatch(
        /raw-(?:remote|path|partial)-secret|UNKNOWN_RAW_SECRET/u,
      );
    },
  );

  it("applies semantic-error precedence deterministically in either array order", async () => {
    const types = [
      "INTERNAL",
      "undefinedField",
      "NOT_FOUND",
      "RATE_LIMITED",
      "ABUSE_DETECTED",
      "FORBIDDEN",
      "UNAUTHENTICATED",
    ];
    for (const ordered of [types, [...types].reverse()]) {
      const scripted = createScriptedGitHubAdapter([
        {
          kind: "graphql",
          operation: "listLists",
          graphqlOperation: "ViewerLists",
          status: 200,
          data: viewerListsData(),
          errors: ordered.map((type) => graphqlError(type)),
        },
      ]);

      await expect(scripted.adapter.listUserLists(null)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        retryable: false,
        details: {
          operation: "ViewerLists",
          recognizedTypes: [
            "UNAUTHENTICATED",
            "FORBIDDEN",
            "ABUSE_DETECTED",
            "RATE_LIMITED",
            "NOT_FOUND",
            "undefinedField",
            "INTERNAL",
          ],
          errorCount: 7,
        },
      });
    }
  });

  it("discards partial data without traversing it when any GraphQL error exists", async () => {
    let touched = false;
    const partialData = {};
    Object.defineProperty(partialData, "viewer", {
      enumerable: true,
      get() {
        touched = true;
        return { lists: { nodes: [], pageInfo: {} } };
      },
    });
    const adapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: partialData,
        errors: [graphqlError("FORBIDDEN")],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );

    await expect(adapter.listUserLists(null)).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
    });
    expect(touched).toBe(false);
  });

  it("never infers schema unavailability from GraphQL messages or paths", async () => {
    const adapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: viewerListsData(),
        errors: [
          {
            message: "undefinedField raw-message-secret",
            type: "GRAPHQL_VALIDATION_FAILED",
            path: ["undefinedType", "raw-path-secret"],
          },
        ],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );

    const error = await rejectedError(adapter.listUserLists(null));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: {
        operation: "ViewerLists",
        recognizedTypes: [],
        errorCount: 1,
      },
    });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toMatch(
      /undefinedField|undefinedType|raw-(?:message|path)-secret/u,
    );
  });

  it("bounds, detaches, and deeply freezes membership pages independently", async () => {
    const rawRepository = rawGraphqlRepository();
    const nodes = [rawRepository];
    const data = userListItemsData(nodes);
    const adapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data,
        errors: [],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );

    const page = await adapter.listUserListItems(asUserListId("UL_1"), null);
    rawRepository.name = "mutated";
    nodes.push({ __typename: "Issue", id: "I_late" });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: "repository",
      repository: { name: "tool" },
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(Object.isFrozen(page.warnings)).toBe(true);

    const oversizedAdapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: userListItemsData(
          Array.from({ length: 101 }, () => ({
            __typename: "Issue",
            id: null,
          })),
        ),
        errors: [],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );
    await expect(
      oversizedAdapter.listUserListItems(asUserListId("UL_1"), null),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });

    const sparse: unknown[] = [];
    sparse.length = 1;
    const sparseAdapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: userListItemsData(sparse),
        errors: [],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );
    await expect(
      sparseAdapter.listUserListItems(asUserListId("UL_1"), null),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });
  });

  it("rejects sparse, revoked-Proxy, and accessor List envelopes without raw leakage", async () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const sparseAdapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: viewerListsData(sparse),
        errors: [],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );
    await expect(sparseAdapter.listUserLists(null)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });

    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    const proxyAdapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: viewerListsData(revocable.proxy),
        errors: [],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );
    await expect(proxyAdapter.listUserLists(null)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });

    let touched = false;
    const connection = { pageInfo: { hasNextPage: false, endCursor: null } };
    Object.defineProperty(connection, "nodes", {
      enumerable: true,
      get() {
        touched = true;
        return [{ id: "raw-accessor-secret" }];
      },
    });
    const accessorAdapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: { viewer: { lists: connection } },
        errors: [],
        status: 200,
        headers: {},
        rateLimit: null,
      }),
    );
    await expect(accessorAdapter.listUserLists(null)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "malformed_remote_data" },
    });
    expect(touched).toBe(false);
  });

  it.each([
    [{ remaining: -1, resetAt: "2026-07-18T01:00:00Z" }],
    [{ remaining: 1.5, resetAt: "2026-07-18T01:00:00Z" }],
    [{ remaining: 1, resetAt: "raw-rate-secret" }],
  ])("rejects malformed GraphQL rate state", async (rateLimit) => {
    const adapter = new OctokitGitHubAdapter(
      graphqlOnlyTransport({
        data: viewerListsData(),
        errors: [],
        status: 200,
        headers: {},
        rateLimit,
      }),
    );

    const error = await rejectedError(adapter.listUserLists(null));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { operation: "ViewerLists", reason: "malformed_remote_data" },
    });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
      "raw-rate-secret",
    );
  });
});
