import { z } from "zod";
import type { RepositoryDatabaseId, RepositoryId, UserListId } from "./ids.js";

export interface AccountBinding {
  readonly host: string;
  readonly login: string;
  readonly accountId: string;
}

export interface RepositoryCoordinates {
  readonly owner: string;
  readonly name: string;
}

export interface Repository extends RepositoryCoordinates {
  readonly repositoryId: RepositoryId;
  readonly repositoryDatabaseId: RepositoryDatabaseId;
  readonly fullName: string;
  readonly description: string | null;
  readonly url: string;
  readonly stargazerCount: number;
  readonly isFork: boolean;
  readonly isArchived: boolean;
  readonly isDisabled: boolean;
  readonly isPrivate: boolean;
  readonly visibility: "public" | "private" | "internal";
  readonly primaryLanguage: string | null;
  readonly topics: readonly string[];
  readonly licenseSpdxId: string | null;
  readonly pushedAt: string | null;
  readonly updatedAt: string;
}

export interface StarRecord {
  readonly repositoryId: RepositoryId;
  readonly starredAt: string;
}

export interface UserList {
  readonly listId: UserListId;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly isPrivate: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAddedAt: string | null;
}

export interface ListMembership {
  readonly listId: UserListId;
  readonly repositoryId: RepositoryId;
}

export interface RepositoryView extends Repository {
  readonly starredAt: string;
  readonly listIds: readonly UserListId[];
}

export interface ObservedRepositoryMetadata {
  readonly repository: Repository;
  readonly observedAt: string;
}

const repositoryIdSchema = z
  .string()
  .min(1, "repository_id must not be empty")
  .refine((value) => value === value.trim(), {
    message: "repository_id must be trim-equal",
  })
  .transform((value) => value as RepositoryId);

const repositoryDatabaseIdSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)$/u,
    "repository_database_id must be a non-negative decimal integer",
  )
  .transform((value) => value as RepositoryDatabaseId);

const trimmedNameSchema = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: false });

const httpsGitHubUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      if (!URL.canParse(value)) {
        return false;
      }

      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "github.com";
    },
    { message: "url must be an HTTPS GitHub URL" },
  );

const topicsSchema = z
  .array(z.string())
  .transform((topics) =>
    [
      ...new Set(
        topics
          .map((topic) => topic.trim().toLowerCase())
          .filter((topic) => topic.length > 0),
      ),
    ].sort(),
  );

export const repositorySchema = z
  .object({
    repositoryId: repositoryIdSchema,
    repositoryDatabaseId: repositoryDatabaseIdSchema,
    owner: trimmedNameSchema,
    name: trimmedNameSchema,
    fullName: trimmedNameSchema,
    description: z.string().nullable(),
    url: httpsGitHubUrlSchema,
    stargazerCount: z.number().int().nonnegative(),
    isFork: z.boolean(),
    isArchived: z.boolean(),
    isDisabled: z.boolean(),
    isPrivate: z.boolean(),
    visibility: z.enum(["public", "private", "internal"]),
    primaryLanguage: trimmedNameSchema.nullable(),
    topics: topicsSchema,
    licenseSpdxId: z.string().nullable(),
    pushedAt: isoTimestampSchema.nullable(),
    updatedAt: isoTimestampSchema,
  })
  .transform((repository): Repository => repository);
