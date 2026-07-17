import type {
  GitHubListItem,
  GitHubStar,
  Page,
  RateLimitState,
} from "../../src/app/ports/github-port.js";
import {
  asRepositoryDatabaseId,
  asRepositoryId,
  asUserListId,
} from "../../src/domain/ids.js";
import {
  repositorySchema,
  userListSchema,
  type Repository,
  type UserList,
} from "../../src/domain/repository.js";

export function rawRestRepository(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 42,
    node_id: "R_42",
    owner: { login: "octocat" },
    name: "tool",
    full_name: "octocat/tool",
    description: "A useful tool",
    html_url: "https://github.com/octocat/tool",
    stargazers_count: 12_345,
    fork: false,
    archived: false,
    disabled: false,
    private: false,
    visibility: "public",
    language: "TypeScript",
    topics: ["mcp", "AI"],
    license: { spdx_id: "Apache-2.0" },
    pushed_at: "2026-07-17T01:02:03Z",
    updated_at: "2026-07-17T04:05:06.007Z",
    ...overrides,
  };
}

export function rawStar(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    starred_at: "2026-07-18T00:00:00Z",
    repo: rawRestRepository(),
    ...overrides,
  };
}

export function rawGraphqlRepository(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    __typename: "Repository",
    id: "R_42",
    databaseId: 42,
    owner: { login: "octocat" },
    name: "tool",
    nameWithOwner: "octocat/tool",
    description: "A useful tool",
    url: "https://github.com/octocat/tool",
    stargazerCount: 12_345,
    isFork: false,
    isArchived: false,
    isDisabled: false,
    isPrivate: false,
    visibility: "PUBLIC",
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: {
      nodes: [{ topic: { name: "mcp" } }, { topic: { name: "AI" } }],
    },
    licenseInfo: { spdxId: "Apache-2.0" },
    pushedAt: "2026-07-17T01:02:03Z",
    updatedAt: "2026-07-17T04:05:06.007Z",
    ...overrides,
  };
}

export function rawUserList(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "UL_1",
    name: "AI",
    slug: "ai",
    description: "AI repositories",
    isPrivate: false,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-17T00:00:00Z",
    lastAddedAt: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

export function viewerListsData(
  nodes: readonly unknown[] = [],
  pageInfo: Readonly<Record<string, unknown>> = {
    hasNextPage: false,
    endCursor: null,
  },
): Record<string, unknown> {
  return {
    viewer: {
      lists: {
        nodes,
        pageInfo,
      },
    },
    rateLimit: {
      remaining: 4_999,
      resetAt: "2026-07-18T01:00:00Z",
    },
  };
}

export function userListItemsData(
  nodes: readonly unknown[] = [],
  pageInfo: Readonly<Record<string, unknown>> = {
    hasNextPage: false,
    endCursor: null,
  },
): Record<string, unknown> {
  return {
    node: {
      items: {
        nodes,
        pageInfo,
      },
    },
    rateLimit: {
      remaining: 4_998,
      resetAt: "2026-07-18T01:00:00Z",
    },
  };
}

export function syncRepository(
  index: number,
  overrides: Partial<Repository> = {},
): Repository {
  const repositoryId =
    overrides.repositoryId ?? asRepositoryId(`R_sync_${String(index)}`);
  const owner = overrides.owner ?? "sync-owner";
  const name = overrides.name ?? `repo-${String(index)}`;
  return Object.freeze(
    repositorySchema.parse({
      repositoryId,
      repositoryDatabaseId:
        overrides.repositoryDatabaseId ??
        asRepositoryDatabaseId(String(10_000 + index)),
      owner,
      name,
      fullName: overrides.fullName ?? `${owner}/${name}`,
      description: overrides.description ?? `Repository ${String(index)}`,
      url: overrides.url ?? `https://github.com/${owner}/${name}`,
      stargazerCount: overrides.stargazerCount ?? 100 + index,
      isFork: overrides.isFork ?? false,
      isArchived: overrides.isArchived ?? false,
      isDisabled: overrides.isDisabled ?? false,
      isPrivate: overrides.isPrivate ?? false,
      visibility: overrides.visibility ?? "public",
      primaryLanguage: overrides.primaryLanguage ?? "TypeScript",
      topics: overrides.topics ?? ["sync"],
      licenseSpdxId: overrides.licenseSpdxId ?? "Apache-2.0",
      pushedAt: overrides.pushedAt ?? "2026-07-17T00:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-07-18T00:00:00.000Z",
    }),
  );
}

export function syncStar(
  index: number,
  overrides: Partial<GitHubStar> = {},
): GitHubStar {
  return Object.freeze({
    repository: overrides.repository ?? syncRepository(index),
    starredAt: overrides.starredAt ?? "2026-07-18T01:00:00.000Z",
  });
}

export function syncUserList(
  index: number,
  overrides: Partial<UserList> = {},
): UserList {
  const listId = overrides.listId ?? asUserListId(`UL_sync_${String(index)}`);
  return Object.freeze(
    userListSchema.parse({
      listId,
      name: overrides.name ?? `List ${String(index)}`,
      slug: overrides.slug ?? `list-${String(index)}`,
      description: overrides.description ?? null,
      isPrivate: overrides.isPrivate ?? false,
      createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-07-18T00:00:00.000Z",
      lastAddedAt: overrides.lastAddedAt ?? null,
    }),
  );
}

export function syncRepositoryItem(repository: Repository): GitHubListItem {
  return Object.freeze({ kind: "repository", repository });
}

export function syncUnsupportedItem(
  typename = "FutureItem",
  itemId: string | null = null,
): GitHubListItem {
  return Object.freeze({ kind: "unsupported", typename, itemId });
}

export function syncPage<T>(
  items: readonly T[],
  nextCursor: string | null = null,
  options: Readonly<{
    rateLimit?: RateLimitState | null;
    warnings?: readonly string[];
  }> = {},
): Page<T> {
  const rateLimit = options.rateLimit === undefined ? null : options.rateLimit;
  return Object.freeze({
    items: Object.freeze([...items]),
    nextCursor,
    rateLimit:
      rateLimit === null
        ? null
        : Object.freeze({
            remaining: rateLimit.remaining,
            resetAt: rateLimit.resetAt,
          }),
    warnings: Object.freeze([...(options.warnings ?? [])]),
  });
}
