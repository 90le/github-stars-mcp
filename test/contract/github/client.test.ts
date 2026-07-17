import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CapabilityState,
  GitHubCapabilities,
  GitHubListItem,
  GitHubPort,
  GitHubReadme,
  GitHubRepository,
  GitHubSearchInput,
  GitHubSearchPage,
  GitHubStar,
  GitHubUserList,
  Page,
  RateLimitState,
} from "../../../src/app/ports/github-port.js";
import type { UserListId } from "../../../src/domain/ids.js";
import type {
  AccountBinding,
  Repository,
  RepositoryCoordinates,
  UserList,
} from "../../../src/domain/repository.js";
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
  | "searchRepositories";

const normalizeDocument = (document: string): string =>
  document.replace(/\s+/gu, " ").trim();

describe("GitHub read boundary contracts", () => {
  it("locks the application port to the seven approved named methods", () => {
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
    });
    expect(GRAPHQL_READ_OPERATIONS).toEqual({
      listLists: "ViewerLists",
      listItems: "UserListItems",
    });
    expect(Object.keys(GRAPHQL_READ_DOCUMENTS).sort()).toEqual([
      "listItems",
      "listLists",
    ]);
    expect(Object.isFrozen(REST_READ_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(GRAPHQL_READ_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(GRAPHQL_READ_DOCUMENTS)).toBe(true);
    expectTypeOf<RestReadOperation>().toEqualTypeOf<
      "getViewer" | "listStars" | "getReadme" | "searchRepositories"
    >();
    expectTypeOf<GraphqlReadOperation>().toEqualTypeOf<
      "listLists" | "listItems"
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
  });
});
