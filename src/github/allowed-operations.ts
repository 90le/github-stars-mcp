import type { RateLimitState } from "../app/ports/github-port.js";

export const REST_READ_OPERATIONS = Object.freeze({
  getViewer: "GET /user",
  listStars: "GET /user/starred",
  getReadme: "GET /repos/{owner}/{repo}/readme",
  searchRepositories: "GET /search/repositories",
} as const);

export const GRAPHQL_READ_OPERATIONS = Object.freeze({
  listLists: "ViewerLists",
  listItems: "UserListItems",
} as const);

export const GRAPHQL_READ_DOCUMENTS = Object.freeze({
  listLists: `
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
  `,
  listItems: `
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
  `,
} as const satisfies Readonly<
  Record<keyof typeof GRAPHQL_READ_OPERATIONS, string>
>);

export type RestReadOperation = keyof typeof REST_READ_OPERATIONS;
export type GraphqlReadOperation = keyof typeof GRAPHQL_READ_OPERATIONS;

export type TransportHeaders = Readonly<Record<string, string | undefined>>;

export type GraphqlTransportError = Readonly<{
  message: string;
  type: string | null;
  path: readonly (string | number)[] | null;
}>;

export type RestTransportResponse<T> = Readonly<{
  data: T;
  status: number;
  headers: TransportHeaders;
}>;

export type GraphqlTransportResponse<T> = Readonly<{
  data: T | null;
  errors: readonly GraphqlTransportError[];
  status: number;
  headers: TransportHeaders;
  rateLimit: RateLimitState | null;
}>;

export interface GitHubTransport {
  rest<T>(
    operation: RestReadOperation,
    parameters: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<RestTransportResponse<T>>;
  graphql<T>(
    operation: GraphqlReadOperation,
    variables: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<GraphqlTransportResponse<T>>;
}
