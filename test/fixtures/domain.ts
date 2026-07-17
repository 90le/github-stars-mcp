import {
  asPlanId,
  asRepositoryDatabaseId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
} from "../../src/domain/ids.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  type PlanExecutableContent,
} from "../../src/domain/plan.js";
import {
  repositoryViewSchema,
  type RepositoryView,
} from "../../src/domain/repository.js";
import { parseChangeRun, parseRunOperation } from "../../src/domain/run.js";
import {
  parseSnapshotBatch,
  parseSnapshotDraft,
} from "../../src/domain/snapshot.js";

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

export const accountBindingFixture = Object.freeze({
  host: "github.com",
  login: "octocat",
  accountId: "U_1",
});

export const snapshotDraftFixture = parseSnapshotDraft({
  id: asSnapshotId("snap_1"),
  binding: accountBindingFixture,
  mode: "full",
  listCoverage: "collecting",
  startedAt: "2026-07-16T00:00:00.000Z",
});

export const snapshotBatchFixture = parseSnapshotBatch({
  repositories: [
    {
      repository: repositoryInputFixture,
      observedAt: "2026-07-16T00:00:00.000Z",
    },
  ],
  stars: [
    {
      repositoryId: asRepositoryId("R_1"),
      starredAt: "2026-07-15T12:00:00.000Z",
    },
  ],
  lists: [
    {
      listId: asUserListId("UL_1"),
      name: "AI",
      slug: "ai",
      description: null,
      isPrivate: false,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      lastAddedAt: "2026-07-16T00:00:00.000Z",
    },
  ],
  memberships: [
    {
      listId: asUserListId("UL_1"),
      repositoryId: asRepositoryId("R_1"),
    },
  ],
});

const fixtureExecutable: PlanExecutableContent = {
  schemaVersion: 1,
  policyVersion: "1",
  binding: accountBindingFixture,
  snapshotId: asSnapshotId("snap_1"),
  protectedRepositoryIds: [],
  protectedListIds: [],
  operations: [
    {
      operationId: "op_1",
      kind: "unstar",
      repositoryId: asRepositoryId("R_1"),
      repositoryDatabaseId: asRepositoryDatabaseId("42"),
      coordinates: { owner: "OpenAI", name: "SDK" },
      dependsOn: [],
      preconditions: [],
      before: { starred: true },
      after: { starred: false },
      inverse: { kind: "star" },
      risk: "destructive",
    },
  ],
  dependencies: [],
};

export const changePlanFixture = parseChangePlan({
  id: asPlanId("plan_1"),
  hash: hashPlanExecutable(fixtureExecutable),
  state: "ready",
  createdAt: "2026-07-16T01:00:00.000Z",
  expiresAt: "2026-07-17T01:00:00.000Z",
  callerNote: null,
  executable: fixtureExecutable,
  operations: fixtureExecutable.operations,
  dependencies: fixtureExecutable.dependencies,
  warnings: [],
});

export const changeRunFixture = parseChangeRun({
  id: asRunId("run_1"),
  planId: asPlanId("plan_1"),
  binding: accountBindingFixture,
  state: "pending",
  failureMode: "stop",
  warnings: [],
  startedAt: "2026-07-16T02:00:00.000Z",
  finishedAt: null,
});

export const pendingOperationFixture = parseRunOperation({
  runId: asRunId("run_1"),
  operationId: "op_1",
  sequence: 0,
  status: "pending",
  reconciliation: "not_required",
  attempts: 0,
  before: { starred: true },
  after: null,
  externalRequestId: null,
  error: null,
  startedAt: null,
  finishedAt: null,
});
