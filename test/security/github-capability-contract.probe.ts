import type {
  AccountBinding,
  CreateUserListInput,
  GitHubCapabilities,
  GitHubListItem,
  GitHubPort,
  GitHubReadme,
  GitHubSearchInput,
  GitHubSearchPage,
  GitHubStar,
  GitHubUserList,
  MutationReceipt,
  Page,
  RepositoryCoordinates,
  RepositoryIdentity,
  UpdateUserListInput,
  UserListMutationResult,
} from "../../src/app/ports/github-port.js";
import type { RepositoryId, UserListId } from "../../src/domain/ids.js";
import type { OctokitGitHubAdapter } from "../../src/github/octokit-github-adapter.js";

export type ExpectedGitHubPort = Readonly<{
  getViewer: (signal?: AbortSignal) => Promise<AccountBinding>;
  probeCapabilities: (signal?: AbortSignal) => Promise<GitHubCapabilities>;
  listStarredRepositories: (
    cursor: string | null,
    signal?: AbortSignal,
  ) => Promise<Page<GitHubStar>>;
  listUserLists: (
    cursor: string | null,
    signal?: AbortSignal,
  ) => Promise<Page<GitHubUserList>>;
  listUserListItems: (
    listId: UserListId,
    cursor: string | null,
    signal?: AbortSignal,
  ) => Promise<Page<GitHubListItem>>;
  getReadme: (
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ) => Promise<GitHubReadme | null>;
  searchRepositories: (
    input: GitHubSearchInput,
    signal?: AbortSignal,
  ) => Promise<GitHubSearchPage>;
  getRepositoryIdentity: (
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ) => Promise<RepositoryIdentity | null>;
  getUserList: (
    listId: UserListId,
    signal?: AbortSignal,
  ) => Promise<GitHubUserList | null>;
  checkStar: (
    repository: RepositoryCoordinates,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  getRepositoryListIds: (
    repositoryId: RepositoryId,
    signal?: AbortSignal,
  ) => Promise<readonly UserListId[]>;
  star: (
    repository: RepositoryCoordinates,
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<MutationReceipt>;
  unstar: (
    repository: RepositoryCoordinates,
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<MutationReceipt>;
  createUserList: (
    input: CreateUserListInput,
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<UserListMutationResult>;
  updateUserList: (
    listId: UserListId,
    input: UpdateUserListInput,
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<UserListMutationResult>;
  deleteUserList: (
    listId: UserListId,
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<MutationReceipt>;
  setRepositoryListIds: (
    repositoryId: RepositoryId,
    listIds: readonly UserListId[],
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<MutationReceipt>;
}>;

type Assert<Condition extends true> = Condition;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type SameKeys<Left, Right> = [
  Exclude<keyof Left, keyof Right>,
  Exclude<keyof Right, keyof Left>,
] extends [never, never]
  ? true
  : false;
type SignatureMismatch<Actual, Expected> = {
  [Key in keyof Expected]: Key extends keyof Actual
    ? Equal<Actual[Key], Expected[Key]> extends true
      ? never
      : Key
    : Key;
}[keyof Expected];
type NoSignatureMismatch<Actual, Expected> = [
  SignatureMismatch<Actual, Expected>,
] extends [never]
  ? true
  : false;

type AdapterPublicSurface = Pick<
  OctokitGitHubAdapter,
  keyof OctokitGitHubAdapter
>;

export type GitHubPortAssignsToExpected = Assert<
  Assignable<GitHubPort, ExpectedGitHubPort>
>;
export type ExpectedAssignsToGitHubPort = Assert<
  Assignable<ExpectedGitHubPort, GitHubPort>
>;
export type GitHubPortHasExactKeys = Assert<
  SameKeys<GitHubPort, ExpectedGitHubPort>
>;
export type GitHubPortHasExactSignatures = Assert<
  NoSignatureMismatch<GitHubPort, ExpectedGitHubPort>
>;
export type AdapterAssignsToExpected = Assert<
  Assignable<AdapterPublicSurface, ExpectedGitHubPort>
>;
export type ExpectedAssignsToAdapter = Assert<
  Assignable<ExpectedGitHubPort, AdapterPublicSurface>
>;
export type AdapterHasExactKeys = Assert<
  SameKeys<AdapterPublicSurface, ExpectedGitHubPort>
>;
export type AdapterHasExactSignatures = Assert<
  NoSignatureMismatch<AdapterPublicSurface, ExpectedGitHubPort>
>;
