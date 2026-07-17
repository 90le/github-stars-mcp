import type {
  RepositoryDatabaseId,
  RepositoryId,
  UserListId,
} from "../../domain/ids.js";
import type {
  AccountBinding,
  Repository,
  RepositoryCoordinates,
  UserList,
} from "../../domain/repository.js";

export type {
  AccountBinding,
  RepositoryCoordinates,
} from "../../domain/repository.js";

export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
  rateLimit: RateLimitState | null;
  warnings: readonly string[];
}>;

export type RateLimitState = Readonly<{
  remaining: number;
  resetAt: string;
}>;

export type CapabilityState = "available" | "unavailable" | "unknown";

export type GitHubCapabilities = Readonly<{
  starRead: CapabilityState;
  starWrite: CapabilityState;
  listRead: CapabilityState;
  listWrite: CapabilityState;
}>;

export type GitHubRepository = Repository;

export type GitHubStar = Readonly<{
  repository: GitHubRepository;
  starredAt: string;
}>;

export type GitHubUserList = UserList;

export type GitHubListItem =
  | Readonly<{
      kind: "repository";
      repository: GitHubRepository;
    }>
  | Readonly<{
      kind: "unsupported";
      typename: string;
      itemId: string | null;
    }>;

export type GitHubReadme = Readonly<{
  text: string;
  sourceUrl: string;
  sha: string;
  byteLength: number;
}>;

export type GitHubSearchInput = Readonly<{
  query: string;
  sort: "stars" | "forks" | "help-wanted-issues" | "updated" | null;
  order: "asc" | "desc";
  page: number;
  perPage: number;
}>;

export type GitHubSearchPage = Readonly<{
  items: readonly GitHubRepository[];
  totalCount: number;
  incompleteResults: boolean;
  nextPage: number | null;
  rateLimit: RateLimitState | null;
}>;

export type MutationReceipt = Readonly<{
  requestId: string | null;
  clientMutationId: string | null;
}>;

export type RepositoryIdentity = Readonly<{
  repositoryId: RepositoryId;
  repositoryDatabaseId: RepositoryDatabaseId;
  coordinates: RepositoryCoordinates;
}>;

export type CreateUserListInput = Readonly<{
  name: string;
  description: string | null;
  isPrivate: boolean;
}>;

export type UpdateUserListInput = Readonly<{
  name?: string;
  description?: string | null;
  isPrivate?: boolean;
}>;

export type UserListMutationResult = Readonly<{
  list: GitHubUserList;
  receipt: MutationReceipt;
}>;

export interface GitHubStatusReadPort {
  getViewer(signal?: AbortSignal): Promise<AccountBinding>;
  probeCapabilities(signal?: AbortSignal): Promise<GitHubCapabilities>;
}

export interface GitHubStarReadPort extends GitHubStatusReadPort {
  listStarredRepositories(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubStar>>;
}

export interface GitHubListReadPort {
  listUserLists(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubUserList>>;
  listUserListItems(
    listId: UserListId,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubListItem>>;
}

export interface GitHubSyncReadPort
  extends GitHubStarReadPort, GitHubListReadPort {}

export interface GitHubEvidenceReadPort {
  getReadme(
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ): Promise<GitHubReadme | null>;
}

export interface GitHubDiscoveryReadPort {
  searchRepositories(
    input: GitHubSearchInput,
    signal?: AbortSignal,
  ): Promise<GitHubSearchPage>;
}

export interface GitHubLiveReadPort {
  getRepositoryIdentity(
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ): Promise<RepositoryIdentity | null>;
  getUserList(
    listId: UserListId,
    signal?: AbortSignal,
  ): Promise<GitHubUserList | null>;
  checkStar(
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ): Promise<boolean>;
  getRepositoryListIds(
    repositoryId: RepositoryId,
    signal?: AbortSignal,
  ): Promise<readonly UserListId[]>;
}

export interface GitHubMutationPort {
  star(
    repository: RepositoryCoordinates,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt>;
  unstar(
    repository: RepositoryCoordinates,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt>;
  createUserList(
    input: CreateUserListInput,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<UserListMutationResult>;
  updateUserList(
    listId: UserListId,
    input: UpdateUserListInput,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<UserListMutationResult>;
  deleteUserList(
    listId: UserListId,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt>;
  setRepositoryListIds(
    repositoryId: RepositoryId,
    listIds: readonly UserListId[],
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt>;
}

export interface GitHubPort
  extends
    GitHubSyncReadPort,
    GitHubEvidenceReadPort,
    GitHubDiscoveryReadPort,
    GitHubLiveReadPort,
    GitHubMutationPort {}
