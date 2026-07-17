import { expect, test } from "vitest";
import {
  asPlanId,
  asRepositoryDatabaseId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
  newOperationId,
  newPlanId,
  newRequestId,
  newRunId,
  newSnapshotId,
} from "../../../src/domain/ids.js";
import { SystemRuntime } from "../../../src/app/ports/runtime-port.js";
import type { JsonValue } from "../../../src/domain/json.js";
import {
  observedRepositoryMetadataSchema,
  repositorySchema,
  repositoryViewSchema,
  starRecordSchema,
  userListSchema,
  type AccountBinding,
  type ListMembership,
  type ObservedRepositoryMetadata,
  type Repository,
  type RepositoryView,
  type StarRecord,
  type UserList,
} from "../../../src/domain/repository.js";
import type {
  Snapshot,
  SnapshotBatch,
  SnapshotCounts,
  SnapshotDraft,
} from "../../../src/domain/snapshot.js";
import { repositoryInputFixture } from "../../fixtures/domain.js";

function assertParsedRepositoryReadonly(): void {
  const repository = repositorySchema.parse(repositoryInputFixture);

  // @ts-expect-error Parsed repository fields must remain readonly.
  repository.owner = "Other";
  /* eslint-disable @typescript-eslint/no-unsafe-call */
  // @ts-expect-error Parsed repository topics must remain readonly.
  repository.topics.push("mutation");
  /* eslint-enable @typescript-eslint/no-unsafe-call */
}

void assertParsedRepositoryReadonly;

test("validates stable identities and normalizes topics", () => {
  expect(() => asRepositoryId(" ")).toThrow(/repository_id/u);
  expect(() => asRepositoryId(" R_1")).toThrow(/repository_id/u);
  expect(() => asRepositoryDatabaseId("1.5")).toThrow(/decimal/u);
  expect(asRepositoryDatabaseId("9007199254740993")).toBe("9007199254740993");
  expect(asRepositoryId("R_MixedCase")).toBe("R_MixedCase");
  expect(asUserListId("UL_1")).toBe("UL_1");
  expect(asSnapshotId("snap_external")).toBe("snap_external");
  expect(asPlanId("plan_external")).toBe("plan_external");
  expect(asRunId("run_external")).toBe("run_external");

  expect(newSnapshotId()).toMatch(/^snap_[0-9a-f-]{36}$/u);
  expect(newPlanId()).toMatch(/^plan_[0-9a-f-]{36}$/u);
  expect(newRunId()).toMatch(/^run_[0-9a-f-]{36}$/u);
  expect(newRequestId()).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(newOperationId()).toMatch(/^op_[0-9a-f-]{36}$/u);

  const runtime = new SystemRuntime();
  expect(runtime.now()).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/u);
  expect(runtime.monotonicMs()).toBeGreaterThanOrEqual(0);
  expect(runtime.snapshotId()).toMatch(/^snap_[0-9a-f-]{36}$/u);
  expect(runtime.planId()).toMatch(/^plan_[0-9a-f-]{36}$/u);
  expect(runtime.runId()).toMatch(/^run_[0-9a-f-]{36}$/u);
  expect(runtime.requestId()).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(runtime.operationId()).toMatch(/^op_[0-9a-f-]{36}$/u);

  const repository = repositorySchema.parse(repositoryInputFixture);
  const readonlyRepository: Repository = repository;
  expect(repository.repositoryId).toBe("R_1");
  expect(repository.topics).toEqual(["agent", "mcp"]);
  expect(readonlyRepository).toBe(repository);

  const trimmedRepository = repositorySchema.parse({
    ...repositoryInputFixture,
    owner: " OpenAI ",
    name: " SDK ",
    fullName: " OpenAI/SDK ",
  });
  expect(trimmedRepository.owner).toBe("OpenAI");
  expect(trimmedRepository.name).toBe("SDK");
  expect(trimmedRepository.fullName).toBe("OpenAI/SDK");
  const normalizedTimestamps = repositorySchema.parse({
    ...repositoryInputFixture,
    pushedAt: "2026-07-16T00:00:00.1Z",
    updatedAt: "2026-07-16T01:00:00Z",
  });
  expect(normalizedTimestamps.pushedAt).toBe("2026-07-16T00:00:00.100Z");
  expect(normalizedTimestamps.updatedAt).toBe("2026-07-16T01:00:00.000Z");

  expect(() =>
    repositorySchema.parse({
      ...repositoryInputFixture,
      url: "http://github.com/OpenAI/SDK",
    }),
  ).toThrow(/HTTPS GitHub URL/u);
  expect(
    repositorySchema.safeParse({
      ...repositoryInputFixture,
      url: "not a URL",
    }).success,
  ).toBe(false);

  const parsedStar = starRecordSchema.parse({
    repositoryId: "R_1",
    starredAt: "2026-07-16T00:00:00Z",
  });
  expect(parsedStar.starredAt).toBe("2026-07-16T00:00:00.000Z");

  const parsedList = userListSchema.parse({
    listId: "UL_1",
    name: "Agents",
    slug: "agents",
    description: null,
    isPrivate: false,
    createdAt: "2026-07-16T00:00:00.1Z",
    updatedAt: "2026-07-16T01:00:00Z",
    lastAddedAt: "2026-07-16T01:30:00.12Z",
  });
  expect(parsedList).toMatchObject({
    createdAt: "2026-07-16T00:00:00.100Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
    lastAddedAt: "2026-07-16T01:30:00.120Z",
  });

  const parsedView = repositoryViewSchema.parse({
    ...repositoryInputFixture,
    pushedAt: "2026-07-16T00:00:00Z",
    starredAt: "2026-07-15T12:00:00Z",
    listIds: ["UL_1"],
  });
  expect(parsedView.pushedAt).toBe("2026-07-16T00:00:00.000Z");
  expect(parsedView.starredAt).toBe("2026-07-15T12:00:00.000Z");

  const parsedObservation = observedRepositoryMetadataSchema.parse({
    repository: {
      ...repositoryInputFixture,
      updatedAt: "2026-07-16T01:00:00Z",
    },
    observedAt: "2026-07-16T02:00:00Z",
  });
  expect(parsedObservation.repository.updatedAt).toBe(
    "2026-07-16T01:00:00.000Z",
  );
  expect(parsedObservation.observedAt).toBe("2026-07-16T02:00:00.000Z");

  for (const invalid of [
    {
      schema: starRecordSchema,
      value: {
        repositoryId: " R_1",
        starredAt: "2026-07-16T00:00:00Z",
      },
    },
    {
      schema: userListSchema,
      value: {
        ...parsedList,
        updatedAt: "2026-07-16T01:00:00.1234Z",
      },
    },
    {
      schema: repositoryViewSchema,
      value: { ...parsedView, starredAt: "yesterday" },
    },
    {
      schema: observedRepositoryMetadataSchema,
      value: {
        repository: { ...repositoryInputFixture, updatedAt: "later" },
        observedAt: "2026-07-16T02:00:00Z",
      },
    },
  ]) {
    expect(invalid.schema.safeParse(invalid.value).success).toBe(false);
  }

  expect(
    starRecordSchema.safeParse({ ...parsedStar, unexpected: true }).success,
  ).toBe(false);
  expect(
    userListSchema.safeParse({ ...parsedList, unexpected: true }).success,
  ).toBe(false);
  expect(
    repositoryViewSchema.safeParse({ ...parsedView, unexpected: true }).success,
  ).toBe(false);
  expect(
    observedRepositoryMetadataSchema.safeParse({
      ...parsedObservation,
      unexpected: true,
    }).success,
  ).toBe(false);
  expect(() =>
    repositorySchema.parse({
      ...repositoryInputFixture,
      stargazerCount: -1,
    }),
  ).toThrow();
  expect(() =>
    repositorySchema.parse({
      ...repositoryInputFixture,
      updatedAt: "yesterday",
    }),
  ).toThrow();
  expect(
    repositorySchema.safeParse({
      ...repositoryInputFixture,
      pushedAt: "2026-07-16T08:00:00+08:00",
    }).success,
  ).toBe(false);
  expect(
    repositorySchema.safeParse({
      ...repositoryInputFixture,
      updatedAt: "2026-07-16T09:00:00+08:00",
    }).success,
  ).toBe(false);
  expect(
    repositorySchema.safeParse({
      ...repositoryInputFixture,
      updatedAt: "2026-07-16T01:00:00.1234Z",
    }).success,
  ).toBe(false);

  const binding: AccountBinding = {
    host: "github.com",
    login: "octocat",
    accountId: "U_1",
  };
  const star: StarRecord = {
    repositoryId: repository.repositoryId,
    starredAt: "2026-07-16T00:00:00.000Z",
  };
  const list: UserList = {
    listId: asUserListId("UL_1"),
    name: "Agents",
    slug: "agents",
    description: null,
    isPrivate: false,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
    lastAddedAt: null,
  };
  const membership: ListMembership = {
    listId: list.listId,
    repositoryId: repository.repositoryId,
  };
  const view: RepositoryView = {
    ...repository,
    starredAt: star.starredAt,
    listIds: [list.listId],
  };
  const observed: ObservedRepositoryMetadata = {
    repository,
    observedAt: "2026-07-16T02:00:00.000Z",
  };
  const draft: SnapshotDraft = {
    id: asSnapshotId("snap_external"),
    binding,
    mode: "full",
    startedAt: "2026-07-16T00:00:00.000Z",
  };
  const counts: SnapshotCounts = {
    repositories: 1,
    stars: 1,
    lists: 1,
    memberships: 1,
  };
  const sourceRateLimit: JsonValue = { remaining: 4_999 };
  const snapshot: Snapshot = {
    ...draft,
    status: "complete",
    completedAt: "2026-07-16T02:00:00.000Z",
    failedAt: null,
    counts,
    warningCount: 0,
    sourceRateLimit,
  };
  const batch: SnapshotBatch = {
    repositories: [observed],
    stars: [star],
    lists: [list],
    memberships: [membership],
  };

  expect(view.isDisabled).toBe(false);
  expect(view.isPrivate).toBe(false);
  expect(list.lastAddedAt).toBeNull();
  expect(snapshot.sourceRateLimit).toEqual({ remaining: 4_999 });
  expect(batch.memberships).toEqual([membership]);
});
