import type { GitHubPort, RateLimitState } from "../app/ports/github-port.js";
import {
  CREATE_USER_LIST,
  DELETE_USER_LIST,
  SET_REPOSITORY_LISTS,
  UPDATE_USER_LIST,
} from "./user-list-mutations.js";

export const REST_READ_OPERATIONS = Object.freeze({
  getViewer: "GET /user",
  listStars: "GET /user/starred",
  getReadme: "GET /repos/{owner}/{repo}/readme",
  searchRepositories: "GET /search/repositories",
  getRepositoryIdentity: "GET /repos/{owner}/{repo}",
  checkStar: "GET /user/starred/{owner}/{repo}",
} as const);

export const GRAPHQL_READ_OPERATIONS = Object.freeze({
  listLists: "ViewerLists",
  listItems: "UserListItems",
  getUserList: "GetUserList",
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
  getUserList: `
    query GetUserList($listId: ID!) {
      node(id: $listId) {
        __typename
        ... on UserList {
          id
          name
          slug
          description
          isPrivate
          createdAt
          updatedAt
          lastAddedAt
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

export const REST_MUTATION_OPERATIONS = Object.freeze({
  star: "PUT /user/starred/{owner}/{repo}",
  unstar: "DELETE /user/starred/{owner}/{repo}",
} as const);

export const GRAPHQL_MUTATION_OPERATIONS = Object.freeze({
  createUserList: "CreateUserList",
  updateUserList: "UpdateUserList",
  deleteUserList: "DeleteUserList",
  setRepositoryListIds: "UpdateUserListsForItem",
} as const);

export const GRAPHQL_MUTATION_DOCUMENTS = Object.freeze({
  createUserList: CREATE_USER_LIST,
  updateUserList: UPDATE_USER_LIST,
  deleteUserList: DELETE_USER_LIST,
  setRepositoryListIds: SET_REPOSITORY_LISTS,
} as const satisfies Readonly<
  Record<keyof typeof GRAPHQL_MUTATION_OPERATIONS, string>
>);

export const GITHUB_MUTATION_METHOD_NAMES = Object.freeze([
  "star",
  "unstar",
  "createUserList",
  "updateUserList",
  "deleteUserList",
  "setRepositoryListIds",
] as const satisfies readonly (keyof GitHubPort)[]);

export type RestReadOperation = keyof typeof REST_READ_OPERATIONS;
export type GraphqlReadOperation = keyof typeof GRAPHQL_READ_OPERATIONS;
export type RestMutationOperation = keyof typeof REST_MUTATION_OPERATIONS;
export type GraphqlMutationOperation = keyof typeof GRAPHQL_MUTATION_OPERATIONS;

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
  restMutation<T>(
    operation: RestMutationOperation,
    parameters: Readonly<Record<string, unknown>>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<RestTransportResponse<T>>;
  graphqlMutation<T>(
    operation: GraphqlMutationOperation,
    variables: Readonly<Record<string, unknown>>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<GraphqlTransportResponse<T>>;
}
