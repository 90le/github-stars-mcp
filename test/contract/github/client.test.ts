import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CapabilityState,
  CreateUserListInput,
  GitHubCapabilities,
  GitHubLiveReadPort,
  GitHubListItem,
  GitHubMutationPort,
  GitHubPort,
  GitHubReadme,
  GitHubRepository,
  GitHubSearchInput,
  GitHubSearchPage,
  GitHubStar,
  GitHubUserList,
  MutationReceipt,
  Page,
  RateLimitState,
  RepositoryIdentity,
  UpdateUserListInput,
  UserListMutationResult,
} from "../../../src/app/ports/github-port.js";
import type { RepositoryId, UserListId } from "../../../src/domain/ids.js";
import type {
  AccountBinding,
  Repository,
  RepositoryCoordinates,
  UserList,
} from "../../../src/domain/repository.js";
import {
  GITHUB_MUTATION_METHOD_NAMES,
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
} from "../../../src/github/allowed-operations.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type ExpectedPortMethod =
  | "getViewer"
  | "probeCapabilities"
  | "listStarredRepositories"
  | "listUserLists"
  | "listUserListItems"
  | "getReadme"
  | "searchRepositories"
  | "getRepositoryIdentity"
  | "getUserList"
  | "checkStar"
  | "getRepositoryListIds"
  | "star"
  | "unstar"
  | "createUserList"
  | "updateUserList"
  | "deleteUserList"
  | "setRepositoryListIds";

const normalizeDocument = (document: string): string =>
  document.replace(/\s+/gu, " ").trim();

describe("GitHub read and mutation boundary contracts", () => {
  it("locks the application port to the approved named methods", () => {
    const hasExactMethodSet: Equal<keyof GitHubPort, ExpectedPortMethod> = true;

    expect(hasExactMethodSet).toBe(true);
    expectTypeOf<GitHubPort["getViewer"]>().toEqualTypeOf<
      (signal?: AbortSignal) => Promise<AccountBinding>
    >();
    expectTypeOf<GitHubPort["probeCapabilities"]>().toEqualTypeOf<
      (signal?: AbortSignal) => Promise<GitHubCapabilities>
    >();
    expectTypeOf<GitHubPort["listStarredRepositories"]>().toEqualTypeOf<
      (cursor: string | null, signal?: AbortSignal) => Promise<Page<GitHubStar>>
    >();
    expectTypeOf<GitHubPort["listUserLists"]>().toEqualTypeOf<
      (
        cursor: string | null,
        signal?: AbortSignal,
      ) => Promise<Page<GitHubUserList>>
    >();
    expectTypeOf<GitHubPort["listUserListItems"]>().toEqualTypeOf<
      (
        listId: UserListId,
        cursor: string | null,
        signal?: AbortSignal,
      ) => Promise<Page<GitHubListItem>>
    >();
    expectTypeOf<GitHubPort["getReadme"]>().toEqualTypeOf<
      (
        repository: RepositoryCoordinates,
        signal?: AbortSignal,
      ) => Promise<GitHubReadme | null>
    >();
    expectTypeOf<GitHubPort["searchRepositories"]>().toEqualTypeOf<
      (
        input: GitHubSearchInput,
        signal?: AbortSignal,
      ) => Promise<GitHubSearchPage>
    >();
    expectTypeOf<GitHubPort["getRepositoryIdentity"]>().toEqualTypeOf<
      (
        repository: RepositoryCoordinates,
        signal?: AbortSignal,
      ) => Promise<RepositoryIdentity | null>
    >();
    expectTypeOf<GitHubPort["getUserList"]>().toEqualTypeOf<
      (
        listId: UserListId,
        signal?: AbortSignal,
      ) => Promise<GitHubUserList | null>
    >();
    expectTypeOf<GitHubPort["checkStar"]>().toEqualTypeOf<
      (
        repository: RepositoryCoordinates,
        signal?: AbortSignal,
      ) => Promise<boolean>
    >();
    expectTypeOf<GitHubPort["getRepositoryListIds"]>().toEqualTypeOf<
      (
        repositoryId: RepositoryId,
        signal?: AbortSignal,
      ) => Promise<readonly UserListId[]>
    >();
    expectTypeOf<GitHubPort["star"]>().toEqualTypeOf<
      (
        repository: RepositoryCoordinates,
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<MutationReceipt>
    >();
    expectTypeOf<GitHubPort["unstar"]>().toEqualTypeOf<GitHubPort["star"]>();
    expectTypeOf<GitHubPort["createUserList"]>().toEqualTypeOf<
      (
        input: CreateUserListInput,
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<UserListMutationResult>
    >();
    expectTypeOf<GitHubPort["updateUserList"]>().toEqualTypeOf<
      (
        listId: UserListId,
        input: UpdateUserListInput,
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<UserListMutationResult>
    >();
    expectTypeOf<GitHubPort["deleteUserList"]>().toEqualTypeOf<
      (
        listId: UserListId,
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<MutationReceipt>
    >();
    expectTypeOf<GitHubPort["setRepositoryListIds"]>().toEqualTypeOf<
      (
        repositoryId: RepositoryId,
        listIds: readonly UserListId[],
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<MutationReceipt>
    >();
    expectTypeOf<GitHubPort>().toMatchTypeOf<
      GitHubLiveReadPort & GitHubMutationPort
    >();
  });

  it("keeps the approved port value types aligned with domain identities", () => {
    expectTypeOf<GitHubRepository>().toEqualTypeOf<Repository>();
    expectTypeOf<GitHubUserList>().toEqualTypeOf<UserList>();
    expectTypeOf<CapabilityState>().toEqualTypeOf<
      "available" | "unavailable" | "unknown"
    >();
    expectTypeOf<RateLimitState>().toEqualTypeOf<
      Readonly<{ remaining: number; resetAt: string }>
    >();
    expectTypeOf<GitHubStar>().toEqualTypeOf<
      Readonly<{ repository: Repository; starredAt: string }>
    >();
    expectTypeOf<GitHubListItem>().toEqualTypeOf<
      | Readonly<{ kind: "repository"; repository: Repository }>
      | Readonly<{
          kind: "unsupported";
          typename: string;
          itemId: string | null;
        }>
    >();
  });

  it("contains only the fixed approved REST and GraphQL operation keys", () => {
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
    expect(Object.keys(GRAPHQL_READ_DOCUMENTS).sort()).toEqual([
      "getUserList",
      "listItems",
      "listLists",
    ]);
    expect(Object.isFrozen(REST_READ_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(GRAPHQL_READ_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(GRAPHQL_READ_DOCUMENTS)).toBe(true);
    expectTypeOf<RestReadOperation>().toEqualTypeOf<
      | "getViewer"
      | "listStars"
      | "getReadme"
      | "searchRepositories"
      | "getRepositoryIdentity"
      | "checkStar"
    >();
    expectTypeOf<GraphqlReadOperation>().toEqualTypeOf<
      "listLists" | "listItems" | "getUserList"
    >();
  });

  it("keeps mutation registries separate, exact, and frozen", () => {
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
    expect(Object.keys(GRAPHQL_MUTATION_DOCUMENTS).sort()).toEqual([
      "createUserList",
      "deleteUserList",
      "setRepositoryListIds",
      "updateUserList",
    ]);
    expect(GITHUB_MUTATION_METHOD_NAMES).toEqual([
      "star",
      "unstar",
      "createUserList",
      "updateUserList",
      "deleteUserList",
      "setRepositoryListIds",
    ]);
    expect(Object.isFrozen(REST_MUTATION_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(GRAPHQL_MUTATION_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(GRAPHQL_MUTATION_DOCUMENTS)).toBe(true);
    expect(Object.isFrozen(GITHUB_MUTATION_METHOD_NAMES)).toBe(true);
    expectTypeOf<RestMutationOperation>().toEqualTypeOf<"star" | "unstar">();
    expectTypeOf<GraphqlMutationOperation>().toEqualTypeOf<
      | "createUserList"
      | "updateUserList"
      | "deleteUserList"
      | "setRepositoryListIds"
    >();
  });

  it("pins the ViewerLists document and its complete pagination fields", () => {
    expect(normalizeDocument(GRAPHQL_READ_DOCUMENTS.listLists)).toBe(
      normalizeDocument(`
        query ViewerLists($cursor: String) {
          viewer {
            lists(first: 100, after: $cursor) {
              nodes {
                id
                name
                slug
                description
                isPrivate
                createdAt
                updatedAt
                lastAddedAt
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          rateLimit {
            remaining
            resetAt
          }
        }
      `),
    );
  });

  it("pins UserListItems to typename, nullable node identity, and all repository fields", () => {
    expect(normalizeDocument(GRAPHQL_READ_DOCUMENTS.listItems)).toBe(
      normalizeDocument(`
        query UserListItems($listId: ID!, $cursor: String) {
          node(id: $listId) {
            ... on UserList {
              items(first: 100, after: $cursor) {
                nodes {
                  __typename
                  ... on Node {
                    id
                  }
                  ... on Repository {
                    id
                    databaseId
                    owner {
                      login
                    }
                    name
                    nameWithOwner
                    description
                    url
                    stargazerCount
                    isFork
                    isArchived
                    isDisabled
                    isPrivate
                    visibility
                    primaryLanguage {
                      name
                    }
                    repositoryTopics(first: 100) {
                      nodes {
                        topic {
                          name
                        }
                      }
                    }
                    licenseInfo {
                      spdxId
                    }
                    pushedAt
                    updatedAt
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          rateLimit {
            remaining
            resetAt
          }
        }
      `),
    );
  });

  it("keeps the transport generic only behind fixed operation discriminants", () => {
    expectTypeOf<TransportHeaders>().toEqualTypeOf<
      Readonly<Record<string, string | undefined>>
    >();
    expectTypeOf<GraphqlTransportError>().toEqualTypeOf<
      Readonly<{
        message: string;
        type: string | null;
        path: readonly (string | number)[] | null;
      }>
    >();
    expectTypeOf<RestTransportResponse<{ readonly ok: true }>>().toEqualTypeOf<
      Readonly<{
        data: { readonly ok: true };
        status: number;
        headers: TransportHeaders;
      }>
    >();
    expectTypeOf<
      GraphqlTransportResponse<{ readonly viewer: unknown }>
    >().toEqualTypeOf<
      Readonly<{
        data: { readonly viewer: unknown } | null;
        errors: readonly GraphqlTransportError[];
        status: number;
        headers: TransportHeaders;
        rateLimit: RateLimitState | null;
      }>
    >();
    expectTypeOf<GitHubTransport["rest"]>().toEqualTypeOf<
      <Response>(
        operation: RestReadOperation,
        parameters: Readonly<Record<string, unknown>>,
        signal?: AbortSignal,
      ) => Promise<RestTransportResponse<Response>>
    >();
    expectTypeOf<GitHubTransport["graphql"]>().toEqualTypeOf<
      <Response>(
        operation: GraphqlReadOperation,
        variables: Readonly<Record<string, unknown>>,
        signal?: AbortSignal,
      ) => Promise<GraphqlTransportResponse<Response>>
    >();
    expectTypeOf<GitHubTransport["restMutation"]>().toEqualTypeOf<
      <Response>(
        operation: RestMutationOperation,
        parameters: Readonly<Record<string, unknown>>,
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<RestTransportResponse<Response>>
    >();
    expectTypeOf<GitHubTransport["graphqlMutation"]>().toEqualTypeOf<
      <Response>(
        operation: GraphqlMutationOperation,
        variables: Readonly<Record<string, unknown>>,
        operationId: string,
        signal?: AbortSignal,
      ) => Promise<GraphqlTransportResponse<Response>>
    >();
  });
});
