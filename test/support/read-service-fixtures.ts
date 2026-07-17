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
