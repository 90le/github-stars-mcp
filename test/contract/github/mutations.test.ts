import { describe, expect, it, vi } from "vitest";
import type { Credential } from "../../../src/auth/credential-provider.js";
import type {
  GitHubLiveReadPort,
  GitHubMutationPort,
} from "../../../src/app/ports/github-port.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import { asRepositoryId, asUserListId } from "../../../src/domain/ids.js";
import {
  GITHUB_MUTATION_METHOD_NAMES,
  GRAPHQL_MUTATION_DOCUMENTS,
  GRAPHQL_MUTATION_OPERATIONS,
  GRAPHQL_READ_OPERATIONS,
  REST_MUTATION_OPERATIONS,
  REST_READ_OPERATIONS,
  type GitHubTransport,
  type RestReadOperation,
} from "../../../src/github/allowed-operations.js";
import { AmbiguousMutationError } from "../../../src/github/errors.js";
import {
  createOctokitTransport,
  type OctokitTransportRuntime,
} from "../../../src/github/octokit-client.js";
import { OctokitGitHubAdapter } from "../../../src/github/octokit-github-adapter.js";
import { RateGate } from "../../../src/github/rate-gate.js";
import {
  CREATE_USER_LIST,
  DELETE_USER_LIST,
  SET_REPOSITORY_LISTS,
  UPDATE_USER_LIST,
} from "../../../src/github/user-list-mutations.js";
import { PACKAGE_VERSION } from "../../../src/version.js";
import {
  rawGraphqlRepository,
  rawUserList,
  userListItemsData,
  viewerListsData,
} from "../../support/read-service-fixtures.js";
import { createScriptedGitHubAdapter } from "../../support/scripted-github-adapter.js";

const repository = Object.freeze({ owner: "octocat", name: "tool" });
const restRepository = Object.freeze({ owner: "octocat", repo: "tool" });

function testCredential(): Credential {
  const credential = { source: "GITHUB_STARS_TOKEN" } as {
    readonly source: "GITHUB_STARS_TOKEN";
    readonly token: string;
  };
  Object.defineProperty(credential, "token", {
    configurable: false,
    enumerable: false,
    value: "github_pat_contract-secret",
    writable: false,
  });
  return Object.freeze(credential);
}

function transportHarness(
  steps: readonly ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>)[],
) {
  const queue = [...steps];
  const requests: Array<{
    readonly method: string;
    readonly body: string | null;
    readonly contentLength: string | null;
  }> = [];
  const waits: number[] = [];
  const runtime: OctokitTransportRuntime = {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
        contentLength: headers.get("content-length"),
      });
      const step = queue.shift();
      if (step === undefined) throw new Error("unexpected mutation replay");
      return step(input, init);
    },
    random: () => 0,
    wait: (delayMs) => {
      waits.push(delayMs);
      return Promise.resolve();
    },
  };
  let monotonicMs = 1_000;
  const gate = new RateGate({
    wallNowMs: () => Date.parse("2026-07-17T18:00:00.000Z"),
    monotonicNowMs: () => monotonicMs,
    wait: (delayMs) => {
      monotonicMs += delayMs;
      return Promise.resolve();
    },
  });
  return {
    transport: createOctokitTransport(
      testCredential(),
      PACKAGE_VERSION,
      gate,
      runtime,
    ),
    requests,
    waits,
    remaining: () => queue.length,
  };
}

function jsonResponse(
  status: number,
  data: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function codedReset(): never {
  const cause = new Error("raw-reset-secret");
  Object.defineProperty(cause, "code", {
    configurable: true,
    enumerable: true,
    value: "ECONNRESET",
    writable: true,
  });
  throw new TypeError("raw-reset-wrapper", { cause });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe("closed GitHub live read and mutation boundary", () => {
  it("exports separate exact frozen operation registries and method manifest", () => {
    expect(REST_READ_OPERATIONS).toEqual({
      getViewer: "GET /user",
      listStars: "GET /user/starred",
      getReadme: "GET /repos/{owner}/{repo}/readme",
      searchRepositories: "GET /search/repositories",
      getRepositoryIdentity: "GET /repos/{owner}/{repo}",
      checkStar: "GET /user/starred/{owner}/{repo}",
    });
    expect(GRAPHQL_READ_OPERATIONS).toEqual({
      listLists: "ViewerLists",
      listItems: "UserListItems",
      getUserList: "GetUserList",
    });
    expect(REST_MUTATION_OPERATIONS).toEqual({
      star: "PUT /user/starred/{owner}/{repo}",
      unstar: "DELETE /user/starred/{owner}/{repo}",
    });
    expect(GRAPHQL_MUTATION_OPERATIONS).toEqual({
      createUserList: "CreateUserList",
      updateUserList: "UpdateUserList",
      deleteUserList: "DeleteUserList",
      setRepositoryListIds: "UpdateUserListsForItem",
    });
    expect(GRAPHQL_MUTATION_DOCUMENTS).toEqual({
      createUserList: CREATE_USER_LIST,
      updateUserList: UPDATE_USER_LIST,
      deleteUserList: DELETE_USER_LIST,
      setRepositoryListIds: SET_REPOSITORY_LISTS,
    });
    expect(GITHUB_MUTATION_METHOD_NAMES).toEqual([
      "star",
      "unstar",
      "createUserList",
      "updateUserList",
      "deleteUserList",
      "setRepositoryListIds",
    ]);
    for (const registry of [
      REST_READ_OPERATIONS,
      GRAPHQL_READ_OPERATIONS,
      REST_MUTATION_OPERATIONS,
      GRAPHQL_MUTATION_OPERATIONS,
      GRAPHQL_MUTATION_DOCUMENTS,
      GITHUB_MUTATION_METHOD_NAMES,
    ]) {
      expect(Object.isFrozen(registry)).toBe(true);
    }
  });

  it("implements progressive live-read and mutation ports", () => {
    const adapter = new OctokitGitHubAdapter({} as GitHubTransport);
    const liveRead: GitHubLiveReadPort = adapter;
    const mutation: GitHubMutationPort = adapter;

    expect(liveRead).toBe(adapter);
    expect(mutation).toBe(adapter);
  });

  it("reads stable repository identity and Star state through fixed REST operations", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "getRepositoryIdentity",
        method: "GET",
        path: "/repos/{owner}/{repo}",
        status: 200,
        data: { id: 42, node_id: "R_42" },
      },
      {
        kind: "rest",
        operation: "checkStar",
        method: "GET",
        path: "/user/starred/{owner}/{repo}",
        status: 204,
      },
      {
        kind: "rest",
        operation: "checkStar",
        method: "GET",
        path: "/user/starred/{owner}/{repo}",
        status: 404,
      },
      {
        kind: "rest",
        operation: "getRepositoryIdentity",
        method: "GET",
        path: "/repos/{owner}/{repo}",
        status: 404,
      },
    ]);

    await expect(
      scripted.adapter.getRepositoryIdentity(repository),
    ).resolves.toEqual({
      repositoryId: "R_42",
      repositoryDatabaseId: "42",
      coordinates: repository,
    });
    await expect(scripted.adapter.checkStar(repository)).resolves.toBe(true);
    await expect(scripted.adapter.checkStar(repository)).resolves.toBe(false);
    await expect(
      scripted.adapter.getRepositoryIdentity(repository),
    ).resolves.toBeNull();
    expect(scripted.requests.map(({ operation }) => operation)).toEqual([
      "getRepositoryIdentity",
      "checkStar",
      "checkStar",
      "getRepositoryIdentity",
    ]);
  });

  it("reads one List and exhausts all List and item pages for reverse membership", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "getUserList",
        graphqlOperation: "GetUserList",
        status: 200,
        data: {
          node: { __typename: "UserList", ...rawUserList() },
        },
      },
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData([rawUserList({ id: "UL_B" })], {
          hasNextPage: true,
          endCursor: "lists-2",
        }),
      },
      {
        kind: "graphql",
        operation: "listLists",
        graphqlOperation: "ViewerLists",
        status: 200,
        data: viewerListsData([rawUserList({ id: "UL_A" })]),
      },
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data: userListItemsData([{ __typename: "Issue", id: "I_1" }], {
          hasNextPage: true,
          endCursor: "items-b-2",
        }),
      },
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data: userListItemsData([rawGraphqlRepository()]),
      },
      {
        kind: "graphql",
        operation: "listItems",
        graphqlOperation: "UserListItems",
        status: 200,
        data: userListItemsData([rawGraphqlRepository()]),
      },
    ]);

    await expect(
      scripted.adapter.getUserList(asUserListId("UL_1")),
    ).resolves.toMatchObject({ listId: "UL_1", name: "AI" });
    const listIds = await scripted.adapter.getRepositoryListIds(
      asRepositoryId("R_42"),
    );

    expect(listIds).toEqual(["UL_A", "UL_B"]);
    expect(Object.isFrozen(listIds)).toBe(true);
    expect(scripted.requests.map(({ operation }) => operation)).toEqual([
      "getUserList",
      "listLists",
      "listLists",
      "listItems",
      "listItems",
      "listItems",
    ]);
  });

  it("dispatches REST Star mutations once with no body and returns a sanitized receipt", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "star",
        method: "PUT",
        path: "/user/starred/{owner}/{repo}",
        status: 204,
        headers: { "X-GitHub-Request-Id": "STAR-1" },
      },
      {
        kind: "rest",
        operation: "unstar",
        method: "DELETE",
        path: "/user/starred/{owner}/{repo}",
        status: 204,
      },
    ]);

    await expect(scripted.adapter.star(repository, "op_star")).resolves.toEqual(
      {
        requestId: "STAR-1",
        clientMutationId: null,
      },
    );
    await expect(
      scripted.adapter.unstar(repository, "op_unstar"),
    ).resolves.toEqual({
      requestId: null,
      clientMutationId: null,
    });
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests).toMatchObject([
      { operation: "star", method: "PUT", parameters: restRepository },
      {
        operation: "unstar",
        method: "DELETE",
        parameters: restRepository,
      },
    ]);
  });

  it("dispatches all four fixed GraphQL mutations with stable client IDs", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "createUserList",
        graphqlOperation: "CreateUserList",
        status: 200,
        data: {
          createUserList: {
            list: rawUserList({ id: "UL_NEW" }),
            clientMutationId: "op_create",
          },
        },
        headers: { "x-github-request-id": "LIST-CREATE-1" },
      },
      {
        kind: "graphql",
        operation: "updateUserList",
        graphqlOperation: "UpdateUserList",
        status: 200,
        data: {
          updateUserList: {
            list: rawUserList({ id: "UL_NEW", description: null }),
            clientMutationId: "op_update",
          },
        },
      },
      {
        kind: "graphql",
        operation: "setRepositoryListIds",
        graphqlOperation: "UpdateUserListsForItem",
        status: 200,
        data: {
          updateUserListsForItem: {
            item: { __typename: "Repository", id: "R_42" },
            lists: [{ id: "UL_A" }, { id: "UL_B" }],
            clientMutationId: "op_membership",
          },
        },
      },
      {
        kind: "graphql",
        operation: "deleteUserList",
        graphqlOperation: "DeleteUserList",
        status: 200,
        data: {
          deleteUserList: { clientMutationId: "op_delete" },
        },
      },
    ]);
    const callerIds = [
      asUserListId("UL_B"),
      asUserListId("UL_A"),
      asUserListId("UL_B"),
    ];

    await expect(
      scripted.adapter.createUserList(
        { name: "New", description: "Useful", isPrivate: false },
        "op_create",
      ),
    ).resolves.toMatchObject({
      list: { listId: "UL_NEW" },
      receipt: {
        requestId: "LIST-CREATE-1",
        clientMutationId: "op_create",
      },
    });
    await expect(
      scripted.adapter.updateUserList(
        asUserListId("UL_NEW"),
        { description: null },
        "op_update",
      ),
    ).resolves.toMatchObject({
      list: { listId: "UL_NEW", description: null },
      receipt: { clientMutationId: "op_update" },
    });
    await expect(
      scripted.adapter.setRepositoryListIds(
        asRepositoryId("R_42"),
        callerIds,
        "op_membership",
      ),
    ).resolves.toEqual({
      requestId: null,
      clientMutationId: "op_membership",
    });
    await expect(
      scripted.adapter.deleteUserList(asUserListId("UL_NEW"), "op_delete"),
    ).resolves.toMatchObject({ clientMutationId: "op_delete" });

    expect(scripted.graphqlVariables("UpdateUserListsForItem")).toEqual({
      itemId: "R_42",
      listIds: ["UL_A", "UL_B"],
      clientMutationId: "op_membership",
    });
    expect(callerIds).toEqual(["UL_B", "UL_A", "UL_B"]);
    expect(scripted.requests).toHaveLength(4);
  });

  it("rejects invalid mutation input before recording any request or invoking hooks", async () => {
    const scripted = createScriptedGitHubAdapter([]);
    const getter = vi.fn(() => "raw-accessor-secret");
    const hostile = Object.defineProperty(
      { description: null, isPrivate: false },
      "name",
      { enumerable: true, get: getter },
    );

    for (const promise of [
      scripted.adapter.updateUserList(asUserListId("UL_1"), {}, "op_empty"),
      scripted.adapter.createUserList(
        hostile as {
          readonly name: string;
          readonly description: string | null;
          readonly isPrivate: boolean;
        },
        "op_hostile",
      ),
      scripted.adapter.star(repository, " op_bad"),
      scripted.adapter.setRepositoryListIds(
        asRepositoryId("R_42"),
        new Array(1) as ReturnType<typeof asUserListId>[],
        "op_sparse",
      ),
    ]) {
      await expect(promise).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(scripted.requests).toEqual([]);
  });

  it.each([
    [
      "wrong client mutation ID",
      {
        updateUserList: {
          list: rawUserList({ id: "UL_1" }),
          clientMutationId: "op_wrong",
        },
      },
    ],
    [
      "wrong returned List ID",
      {
        updateUserList: {
          list: rawUserList({ id: "UL_OTHER" }),
          clientMutationId: "op_update",
        },
      },
    ],
  ])("fails closed on %s", async (_label, data) => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "updateUserList",
        graphqlOperation: "UpdateUserList",
        status: 200,
        data,
      },
    ]);

    await expect(
      scripted.adapter.updateUserList(
        asUserListId("UL_1"),
        { name: "Renamed" },
        "op_update",
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(scripted.requests).toHaveLength(1);
  });

  it("rejects partial GraphQL mutation data before traversing it", async () => {
    const getter = vi.fn(() => ({
      list: rawUserList(),
      clientMutationId: "op_create",
    }));
    const partial = Object.defineProperty({}, "createUserList", {
      enumerable: true,
      get: getter,
    });
    const transport: GitHubTransport = {
      rest: () => Promise.reject(new Error("unexpected REST read")),
      graphql: () => Promise.reject(new Error("unexpected GraphQL read")),
      restMutation: () => Promise.reject(new Error("unexpected REST mutation")),
      graphqlMutation: <T>() =>
        Promise.resolve({
          data: partial as T,
          errors: [
            {
              message: "raw-partial-secret",
              type: "FORBIDDEN",
              path: ["raw-path-secret"],
            },
          ],
          status: 200,
          headers: {},
          rateLimit: null,
        }),
    };
    const adapter = new OctokitGitHubAdapter(transport);

    const error = await caught(
      adapter.createUserList(
        { name: "New", description: null, isPrivate: false },
        "op_create",
      ),
    );

    expect(error).toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain("raw-partial-secret");

    const metadataTransport: GitHubTransport = {
      rest: () => Promise.reject(new Error("unexpected REST read")),
      graphql: () => Promise.reject(new Error("unexpected GraphQL read")),
      restMutation: () => Promise.reject(new Error("unexpected REST mutation")),
      graphqlMutation: <T>() =>
        Promise.resolve({
          data: {} as T,
          errors: [
            { message: "raw-null-secret", type: null, path: null },
            { message: "raw-index-secret", type: "UNKNOWN", path: [0] },
          ],
          status: 200,
          headers: {},
          rateLimit: null,
        }),
    };
    const metadataError = await caught(
      new OctokitGitHubAdapter(metadataTransport).deleteUserList(
        asUserListId("UL_1"),
        "op_delete_metadata",
      ),
    );
    expect(metadataError).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { errorCount: 2, recognizedTypes: [] },
    });
    expect(JSON.stringify(metadataError)).not.toContain("raw-null-secret");
    expect(JSON.stringify(metadataError)).not.toContain("raw-index-secret");
  });

  it("maps reset-after-dispatch to AmbiguousMutationError and records exactly once", async () => {
    const scripted = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "star",
        method: "PUT",
        path: "/user/starred/{owner}/{repo}",
        status: 204,
        resetAfterDispatch: true,
      },
    ]);

    const error = await caught(
      scripted.adapter.star(repository, "op_ambiguous"),
    );

    expect(error).toBeInstanceOf(AmbiguousMutationError);
    expect(error).toMatchObject({
      code: "RECONCILIATION_REQUIRED",
      retryable: false,
      operationId: "op_ambiguous",
      mutationName: "star",
      details: { operationId: "op_ambiguous", mutationName: "star" },
    });
    expect(scripted.requests).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain("raw-reset");
  });

  it.each([
    [
      "secondary 429",
      () =>
        jsonResponse(
          429,
          { message: "raw-rate-secret" },
          { "retry-after": "Fri, 17 Jul 2026 19:00:00 GMT" },
        ),
      "SECONDARY_RATE_LIMITED",
      false,
    ],
    [
      "primary 403",
      () =>
        jsonResponse(
          403,
          { message: "raw-primary-secret" },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1784336400",
          },
        ),
      "RATE_LIMITED",
      false,
    ],
    [
      "server 500",
      () => jsonResponse(500, { message: "raw-server-secret" }),
      "RECONCILIATION_REQUIRED",
      true,
    ],
    ["connection reset", () => codedReset(), "RECONCILIATION_REQUIRED", true],
  ] as const)(
    "never retries a dispatched mutation after %s",
    async (_label, step, code, ambiguous) => {
      const harness = transportHarness([step]);

      const error = await caught(
        harness.transport.restMutation("star", restRepository, "op_once"),
      );

      expect(error).toBeInstanceOf(
        ambiguous ? AmbiguousMutationError : AppError,
      );
      expect(error).toMatchObject({ code });
      expect(harness.requests).toHaveLength(1);
      expect(harness.waits).toEqual([]);
      expect(harness.remaining()).toBe(0);
      expect(JSON.stringify(error)).not.toMatch(/raw-(?:rate|primary|server)/u);
    },
  );

  it("distinguishes abort before dispatch from abort after dispatch", async () => {
    const before = transportHarness([
      () => {
        throw new Error("must not dispatch");
      },
    ]);
    const beforeController = new AbortController();
    beforeController.abort("raw-before-reason");

    const beforeError = await caught(
      before.transport.restMutation(
        "star",
        restRepository,
        "op_before",
        beforeController.signal,
      ),
    );
    expect(beforeError).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(beforeError).not.toBeInstanceOf(AmbiguousMutationError);
    expect(before.requests).toEqual([]);

    const afterController = new AbortController();
    const after = transportHarness([
      () => {
        afterController.abort("raw-after-reason");
        throw new DOMException("raw-after-secret", "AbortError");
      },
    ]);
    const afterError = await caught(
      after.transport.restMutation(
        "star",
        restRepository,
        "op_after",
        afterController.signal,
      ),
    );
    expect(afterError).toBeInstanceOf(AmbiguousMutationError);
    expect(after.requests).toHaveLength(1);
    expect(JSON.stringify(afterError)).not.toContain("raw-after");
  });

  it("sends Star mutations with exactly one empty HTTP request", async () => {
    const harness = transportHarness([
      () => jsonResponse(204, null, { "x-github-request-id": "HTTP-STAR-1" }),
    ]);

    await expect(
      harness.transport.restMutation("star", restRepository, "op_http"),
    ).resolves.toMatchObject({ status: 204 });

    expect(harness.requests).toEqual([
      { method: "PUT", body: null, contentLength: "0" },
    ]);
  });

  it.each([
    [401, {}, "AUTH_REQUIRED"],
    [403, {}, "INSUFFICIENT_PERMISSION"],
    [404, {}, "NOT_FOUND"],
    [409, {}, "PRECONDITION_FAILED"],
    [422, {}, "VALIDATION_ERROR"],
    [
      403,
      { message: "You have triggered an abuse detection mechanism." },
      "SECONDARY_RATE_LIMITED",
    ],
  ] as const)(
    "maps known HTTP %s mutation rejection once without ambiguity",
    async (status, data, code) => {
      const harness = transportHarness([() => jsonResponse(status, data)]);

      const error = await caught(
        harness.transport.restMutation("star", restRepository, "op_known"),
      );

      expect(error).toBeInstanceOf(AppError);
      expect(error).not.toBeInstanceOf(AmbiguousMutationError);
      expect(error).toMatchObject({ code });
      expect(harness.requests).toHaveLength(1);
      expect(harness.waits).toEqual([]);
      expect(harness.remaining()).toBe(0);
    },
  );

  it("uses the fixed GraphQL mutation document once and never retries a reset", async () => {
    const success = transportHarness([
      () =>
        jsonResponse(200, {
          data: {
            deleteUserList: { clientMutationId: "op_graphql" },
          },
        }),
    ]);

    await expect(
      success.transport.graphqlMutation(
        "deleteUserList",
        {
          listId: "UL_1",
          clientMutationId: "op_graphql",
        },
        "op_graphql",
      ),
    ).resolves.toMatchObject({
      data: {
        deleteUserList: { clientMutationId: "op_graphql" },
      },
    });
    expect(success.requests).toHaveLength(1);
    expect(success.requests[0]?.method).toBe("POST");
    const body = JSON.parse(success.requests[0]?.body ?? "{}") as {
      readonly query?: string;
      readonly variables?: unknown;
    };
    expect(body.query).toBe(DELETE_USER_LIST);
    expect(body.variables).toEqual({
      listId: "UL_1",
      clientMutationId: "op_graphql",
    });

    const reset = transportHarness([() => codedReset()]);
    const resetError = await caught(
      reset.transport.graphqlMutation(
        "deleteUserList",
        {
          listId: "UL_1",
          clientMutationId: "op_graphql_reset",
        },
        "op_graphql_reset",
      ),
    );
    expect(resetError).toBeInstanceOf(AmbiguousMutationError);
    expect(reset.requests).toHaveLength(1);
    expect(reset.waits).toEqual([]);
  });

  it("returns null only for a null UserList node and fails closed on wrong node types", async () => {
    const missing = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "getUserList",
        graphqlOperation: "GetUserList",
        status: 200,
        data: { node: null },
      },
    ]);
    await expect(
      missing.adapter.getUserList(asUserListId("UL_missing")),
    ).resolves.toBeNull();

    const wrongType = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "getUserList",
        graphqlOperation: "GetUserList",
        status: 200,
        data: {
          node: {
            __typename: "Repository",
            id: "raw-wrong-node-secret",
          },
        },
      },
    ]);
    const error = await caught(
      wrongType.adapter.getUserList(asUserListId("UL_1")),
    );
    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("raw-wrong-node-secret");
  });

  it("stops reverse membership pagination on cancellation between calls", async () => {
    const controller = new AbortController();
    let calls = 0;
    const transport: GitHubTransport = {
      rest: () => Promise.reject(new Error("unexpected REST read")),
      graphql: <T>() => {
        calls += 1;
        controller.abort("raw-cancellation-secret");
        return Promise.resolve({
          data: viewerListsData([], {
            hasNextPage: true,
            endCursor: "next-list-page",
          }) as T,
          errors: [],
          status: 200,
          headers: {},
          rateLimit: null,
        });
      },
      restMutation: () => Promise.reject(new Error("unexpected mutation")),
      graphqlMutation: () => Promise.reject(new Error("unexpected mutation")),
    };

    const error = await caught(
      new OctokitGitHubAdapter(transport).getRepositoryListIds(
        asRepositoryId("R_42"),
        controller.signal,
      ),
    );

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: {
        operation: "getRepositoryListIds",
        reason: "cancelled",
      },
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(error)).not.toContain("raw-cancellation-secret");
  });

  it("rejects hostile and over-budget mutation inputs with zero requests and no hooks", async () => {
    const scripted = createScriptedGitHubAdapter([]);
    const proxyTrap = vi.fn(() => {
      throw new Error("raw-proxy-secret");
    });
    const proxy = new Proxy(
      { name: "Safe", description: null, isPrivate: false },
      { get: proxyTrap },
    );
    const toJSON = vi.fn(() => ({ raw: "raw-json-secret" }));
    const iterator = vi.fn(function* () {
      yield "raw-iterator-secret";
    });
    const symbolInput = {
      name: "Safe",
      description: null,
      isPrivate: false,
      toJSON,
      [Symbol.iterator]: iterator,
    };

    const invalidActions = [
      () => scripted.adapter.createUserList(proxy, "op_proxy"),
      () => scripted.adapter.createUserList(symbolInput, "op_symbol"),
      () =>
        scripted.adapter.createUserList(
          {
            name: "x".repeat(101),
            description: null,
            isPrivate: false,
          },
          "op_name",
        ),
      () =>
        scripted.adapter.createUserList(
          {
            name: "Safe",
            description: "x".repeat(1_025),
            isPrivate: false,
          },
          "op_description",
        ),
      () => scripted.adapter.star(repository, "x".repeat(129)),
      () =>
        scripted.adapter.setRepositoryListIds(
          asRepositoryId("R_42"),
          Array.from({ length: 5_001 }, () => asUserListId("UL_1")),
          "op_many",
        ),
    ];
    for (const action of invalidActions) {
      await expect(action()).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    }
    expect(proxyTrap).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(iterator).not.toHaveBeenCalled();
    expect(scripted.requests).toEqual([]);
  });

  it("rejects hostile mutation transcript graphs without invoking hooks", () => {
    const getter = vi.fn(() => "raw-transcript-getter");
    const toJSON = vi.fn(() => ({ raw: "raw-transcript-json" }));
    const hostileData = { toJSON };
    Object.defineProperty(hostileData, "deleteUserList", {
      enumerable: true,
      get: getter,
    });

    expect(() =>
      createScriptedGitHubAdapter([
        {
          kind: "graphql",
          operation: "deleteUserList",
          graphqlOperation: "DeleteUserList",
          status: 200,
          data: hostileData,
        },
      ]),
    ).toThrow(
      "Scripted GitHub transport accepts data properties on plain fixture values only",
    );
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong repository identity",
      {
        item: { __typename: "Repository", id: "R_other" },
        lists: [{ id: "UL_A" }],
        clientMutationId: "op_membership_identity",
      },
    ],
    [
      "wrong List identity",
      {
        item: { __typename: "Repository", id: "R_42" },
        lists: [{ id: "UL_other" }],
        clientMutationId: "op_membership_identity",
      },
    ],
    [
      "duplicate returned List identity",
      {
        item: { __typename: "Repository", id: "R_42" },
        lists: [{ id: "UL_A" }, { id: "UL_A" }],
        clientMutationId: "op_membership_identity",
      },
    ],
  ])(
    "rejects %s in a membership mutation response",
    async (_label, payload) => {
      const scripted = createScriptedGitHubAdapter([
        {
          kind: "graphql",
          operation: "setRepositoryListIds",
          graphqlOperation: "UpdateUserListsForItem",
          status: 200,
          data: { updateUserListsForItem: payload },
        },
      ]);

      const error = await caught(
        scripted.adapter.setRepositoryListIds(
          asRepositoryId("R_42"),
          [asUserListId("UL_A")],
          "op_membership_identity",
        ),
      );
      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
      });
      expect(scripted.requests).toHaveLength(1);
      expect(JSON.stringify(error)).not.toMatch(/R_other|UL_other/u);
    },
  );

  it("fails closed on malformed or colliding request ID headers", async () => {
    const malformed = createScriptedGitHubAdapter([
      {
        kind: "rest",
        operation: "star",
        method: "PUT",
        path: "/user/starred/{owner}/{repo}",
        status: 204,
        headers: { "x-github-request-id": "raw\nrequest-secret" },
      },
    ]);
    const malformedError = await caught(
      malformed.adapter.star(repository, "op_header"),
    );
    expect(malformedError).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });
    expect(JSON.stringify(malformedError)).not.toContain("raw\nrequest-secret");

    expect(() =>
      createScriptedGitHubAdapter([
        {
          kind: "rest",
          operation: "star",
          method: "PUT",
          path: "/user/starred/{owner}/{repo}",
          status: 204,
          headers: {
            "X-GitHub-Request-Id": "ONE",
            "x-github-request-id": "TWO",
          },
        },
      ]),
    ).toThrow("colliding header names");
  });

  it("serializes ambiguous errors without transport causes or credentials", () => {
    const raw = new Error(
      "github_pat_raw-cause-secret authorization: bearer raw",
    );
    const error = new AmbiguousMutationError("op_safe", "star", raw);

    expect(serializeError(error)).toEqual({
      code: "RECONCILIATION_REQUIRED",
      message: "Mutation star has an unknown outcome.",
      retryable: false,
      details: { operationId: "op_safe", mutationName: "star" },
    });
    expect(JSON.stringify(error)).not.toMatch(
      /raw-cause-secret|authorization|bearer/u,
    );
  });

  it.each(["204", 204.5, 99, 600, 200] as const)(
    "rejects malformed or non-success REST mutation status %s",
    async (status) => {
      const transport: GitHubTransport = {
        rest: () => Promise.reject(new Error("unexpected REST read")),
        graphql: () => Promise.reject(new Error("unexpected GraphQL read")),
        restMutation: <T>() =>
          Promise.resolve({
            data: null as T,
            status: status as number,
            headers: {},
          }),
        graphqlMutation: () =>
          Promise.reject(new Error("unexpected GraphQL mutation")),
      };

      await expect(
        new OctokitGitHubAdapter(transport).star(repository, "op_bad_status"),
      ).rejects.toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: false,
      });
    },
  );

  it("normalizes transport NOT_FOUND for live reads and rejects unexpected live statuses", async () => {
    const notFound = new OctokitGitHubAdapter({
      rest: () =>
        Promise.reject(
          new AppError("NOT_FOUND", "sanitized not found", {
            retryable: false,
          }),
        ),
      graphql: () => Promise.reject(new Error("unexpected GraphQL read")),
      restMutation: () => Promise.reject(new Error("unexpected mutation")),
      graphqlMutation: () => Promise.reject(new Error("unexpected mutation")),
    });
    await expect(
      notFound.getRepositoryIdentity(repository),
    ).resolves.toBeNull();
    await expect(notFound.checkStar(repository)).resolves.toBe(false);

    const unexpected = new OctokitGitHubAdapter({
      rest: <T>(operation: RestReadOperation) =>
        Promise.resolve({
          data: {} as T,
          status: operation === "getRepositoryIdentity" ? 201 : 200,
          headers: {},
        }),
      graphql: () => Promise.reject(new Error("unexpected GraphQL read")),
      restMutation: () => Promise.reject(new Error("unexpected mutation")),
      graphqlMutation: () => Promise.reject(new Error("unexpected mutation")),
    });
    await expect(
      unexpected.getRepositoryIdentity(repository),
    ).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    await expect(unexpected.checkStar(repository)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  it("rejects a non-200 GraphQL mutation envelope and hostile cancellation signal", async () => {
    const nonSuccess = createScriptedGitHubAdapter([
      {
        kind: "graphql",
        operation: "deleteUserList",
        graphqlOperation: "DeleteUserList",
        status: 500,
        data: {
          deleteUserList: { clientMutationId: "op_graphql_status" },
        },
      },
    ]);
    await expect(
      nonSuccess.adapter.deleteUserList(
        asUserListId("UL_1"),
        "op_graphql_status",
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
    });

    const signal = Object.defineProperty({}, "aborted", {
      enumerable: true,
      get() {
        throw new Error("raw-signal-secret");
      },
    }) as AbortSignal;
    const noDispatch = createScriptedGitHubAdapter([]);
    const error = await caught(
      noDispatch.adapter.getRepositoryListIds(asRepositoryId("R_42"), signal),
    );
    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: false,
      details: { reason: "cancelled" },
    });
    expect(noDispatch.requests).toEqual([]);
    expect(JSON.stringify(error)).not.toContain("raw-signal-secret");
  });
});
