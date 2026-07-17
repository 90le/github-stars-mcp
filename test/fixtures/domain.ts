import { asUserListId } from "../../src/domain/ids.js";
import {
  repositoryViewSchema,
  type RepositoryView,
} from "../../src/domain/repository.js";

export const repositoryInputFixture = {
  repositoryId: "R_1",
  repositoryDatabaseId: "42",
  owner: "OpenAI",
  name: "SDK",
  fullName: "OpenAI/SDK",
  description: null,
  url: "https://github.com/OpenAI/SDK",
  stargazerCount: 10,
  isFork: false,
  isArchived: false,
  isDisabled: false,
  isPrivate: false,
  visibility: "public",
  primaryLanguage: "TypeScript",
  topics: ["MCP", "mcp", " Agent "],
  licenseSpdxId: "Apache-2.0",
  pushedAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T01:00:00.000Z",
} as const;

export const repositoryViewFixture: RepositoryView = repositoryViewSchema.parse(
  {
    ...repositoryInputFixture,
    starredAt: "2026-07-15T12:00:00.000Z",
    listIds: [asUserListId("UL_1")],
  },
);
