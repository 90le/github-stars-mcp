import type { AppConfig } from "../../src/config.js";
import {
  asPlanId,
  asRepositoryDatabaseId,
  asRepositoryId,
  asSnapshotId,
  asUserListId,
  type PlanId,
  type RepositoryId,
  type UserListId,
} from "../../src/domain/ids.js";
import type { ChangePlan, PlanRequest } from "../../src/domain/plan.js";
import type {
  ListMembershipQuery,
  ListQuery,
  RepositoryQuery,
} from "../../src/domain/filter.js";
import {
  repositoryViewSchema,
  userListSchema,
  type AccountBinding,
  type RepositoryView,
  type UserList,
} from "../../src/domain/repository.js";
import {
  parseSnapshotBatch,
  parseSnapshotDraft,
  type ListCoverage,
  type Snapshot,
} from "../../src/domain/snapshot.js";
import { PlanService } from "../../src/app/services/plan-service.js";
import type { Clock, IdGenerator } from "../../src/app/ports/runtime-port.js";
import { AppError } from "../../src/domain/errors.js";
import type {
  StoragePort,
  StorageTransaction,
} from "../../src/app/ports/storage-port.js";
import { createMemoryStorage } from "../fixtures/memory-storage.js";

const T0 = "2026-07-16T00:00:00.000Z";
const T1 = "2026-07-16T00:01:00.000Z";
const T2 = "2026-07-16T00:02:00.000Z";
const T5 = "2026-07-16T00:05:00.000Z";
const PLAN_NOW = "2026-07-16T01:00:00.000Z";

export const plannerBinding: AccountBinding = Object.freeze({
  host: "github.com",
  login: "planner",
  accountId: "U_planner",
});

export function repositoryFixture(
  overrides: Partial<RepositoryView> = {},
): RepositoryView {
  const repositoryId = overrides.repositoryId ?? asRepositoryId("R_repo");
  const databaseId =
    overrides.repositoryDatabaseId ?? asRepositoryDatabaseId("100");
  const owner = overrides.owner ?? "acme";
  const name = overrides.name ?? String(repositoryId).toLowerCase();
  return repositoryViewSchema.parse({
    repositoryId,
    repositoryDatabaseId: databaseId,
    owner,
    name,
    fullName: overrides.fullName ?? `${owner}/${name}`,
    description: overrides.description ?? null,
    url: overrides.url ?? `https://github.com/${owner}/${name}`,
    stargazerCount: overrides.stargazerCount ?? 10,
    isFork: overrides.isFork ?? false,
    isArchived: overrides.isArchived ?? false,
    isDisabled: overrides.isDisabled ?? false,
    isPrivate: overrides.isPrivate ?? false,
    visibility: overrides.visibility ?? "public",
    primaryLanguage: overrides.primaryLanguage ?? "TypeScript",
    topics: overrides.topics ?? ["mcp"],
    licenseSpdxId: overrides.licenseSpdxId ?? "Apache-2.0",
    pushedAt: overrides.pushedAt ?? T0,
    updatedAt: overrides.updatedAt ?? T1,
    starredAt: overrides.starredAt ?? T0,
  });
}

export function userListFixture(overrides: Partial<UserList> = {}): UserList {
  const listId = overrides.listId ?? asUserListId("UL_list");
  const name = overrides.name ?? String(listId);
  return userListSchema.parse({
    listId,
    name,
    slug: overrides.slug ?? name.toLowerCase().replaceAll("_", "-"),
    description: overrides.description ?? null,
    isPrivate: overrides.isPrivate ?? false,
    createdAt: overrides.createdAt ?? T0,
    updatedAt: overrides.updatedAt ?? T1,
    lastAddedAt: overrides.lastAddedAt ?? null,
  });
}

export interface SeedCompleteSnapshotInput {
  readonly id?: string;
  readonly binding?: AccountBinding;
  readonly listCoverage?: Exclude<ListCoverage, "collecting">;
  readonly snapshotStatus?: Snapshot["status"];
  readonly repositories?: readonly RepositoryView[];
  readonly starredRepositoryIds?: readonly RepositoryId[];
  readonly lists?: readonly UserList[];
  readonly memberships?: readonly Readonly<{
    listId: UserListId;
    repositoryId: RepositoryId;
  }>[];
}

export function seedCompleteSnapshot(
  storage: StoragePort,
  input: SeedCompleteSnapshotInput = {},
): Snapshot {
  const id = asSnapshotId(input.id ?? "snap_planner");
  const listCoverage = input.listCoverage ?? "complete";
  const repositories = input.repositories ?? [];
  const starredRepositoryIds = new Set(
    input.starredRepositoryIds ??
      repositories.map((repository) => repository.repositoryId),
  );
  const lists = listCoverage === "complete" ? (input.lists ?? []) : [];
  const memberships =
    listCoverage === "complete" ? (input.memberships ?? []) : [];
  const lease = {
    name: `sync:${String(id)}`,
    ownerId: "planner-fixture",
    now: T1,
  } as const;

  storage.migrate();
  storage.acquireLease({
    name: lease.name,
    ownerId: lease.ownerId,
    now: T0,
    expiresAt: T5,
  });
  let snapshot = storage.createSnapshot({
    draft: parseSnapshotDraft({
      id,
      binding: input.binding ?? plannerBinding,
      mode: "full",
      listCoverage: listCoverage === "complete" ? "collecting" : listCoverage,
      startedAt: T0,
    }),
    lease,
  });
  const repositoryRows = repositories.map((repository) => ({
    repository: {
      repositoryId: repository.repositoryId,
      repositoryDatabaseId: repository.repositoryDatabaseId,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      description: repository.description,
      url: repository.url,
      stargazerCount: repository.stargazerCount,
      isFork: repository.isFork,
      isArchived: repository.isArchived,
      isDisabled: repository.isDisabled,
      isPrivate: repository.isPrivate,
      visibility: repository.visibility,
      primaryLanguage: repository.primaryLanguage,
      topics: repository.topics,
      licenseSpdxId: repository.licenseSpdxId,
      pushedAt: repository.pushedAt,
      updatedAt: repository.updatedAt,
    },
    observedAt: T1,
  }));
  const starRows = repositories
    .filter((repository) => starredRepositoryIds.has(repository.repositoryId))
    .map((repository) => ({
      repositoryId: repository.repositoryId,
      starredAt: repository.starredAt,
    }));
  for (let index = 0; index < repositories.length; index += 100) {
    storage.appendSnapshotBatch({
      id,
      batch: parseSnapshotBatch({
        repositories: repositoryRows.slice(index, index + 100),
        stars: starRows.slice(index, index + 100),
        lists: [],
        memberships: [],
      }),
      lease,
    });
  }
  for (let index = 0; index < lists.length; index += 100) {
    storage.appendSnapshotBatch({
      id,
      batch: parseSnapshotBatch({
        repositories: [],
        stars: [],
        lists: lists.slice(index, index + 100),
        memberships: [],
      }),
      lease,
    });
  }
  for (let index = 0; index < memberships.length; index += 100) {
    storage.appendSnapshotBatch({
      id,
      batch: parseSnapshotBatch({
        repositories: [],
        stars: [],
        lists: [],
        memberships: memberships.slice(index, index + 100),
      }),
      lease,
    });
  }
  if (input.snapshotStatus === "building") {
    storage.releaseLease({ name: lease.name, ownerId: lease.ownerId });
    return snapshot;
  }
  if (input.snapshotStatus === "failed") {
    snapshot = storage.failSnapshot({
      id,
      failedAt: T2,
      sourceRateLimit: null,
      lease,
    });
    storage.releaseLease({ name: lease.name, ownerId: lease.ownerId });
    return snapshot;
  }

  storage.beginSnapshotVerification({ id, listCoverage, lease });
  for (let index = 0; index < starRows.length; index += 100) {
    storage.appendSnapshotVerificationBatch({
      id,
      batch: {
        stars: starRows.slice(index, index + 100),
        lists: [],
        memberships: [],
      },
      lease,
    });
  }
  for (let index = 0; index < lists.length; index += 100) {
    storage.appendSnapshotVerificationBatch({
      id,
      batch: {
        stars: [],
        lists: lists.slice(index, index + 100),
        memberships: [],
      },
      lease,
    });
  }
  for (let index = 0; index < memberships.length; index += 100) {
    storage.appendSnapshotVerificationBatch({
      id,
      batch: {
        stars: [],
        lists: [],
        memberships: memberships.slice(index, index + 100),
      },
      lease,
    });
  }
  storage.finishSnapshotVerification({ id, lease });
  snapshot = storage.completeSnapshot({
    id,
    completedAt: T2,
    listCoverage,
    counts: {
      repositories: repositories.length,
      stars: starRows.length,
      lists: lists.length,
      memberships: memberships.length,
    },
    warningCount: 0,
    sourceRateLimit: null,
    lease,
  });
  storage.releaseLease({ name: lease.name, ownerId: lease.ownerId });
  return snapshot;
}

let fixtureSequence = 0;

function fixtureRuntime(): Pick<Clock & IdGenerator, "now" | "planId"> {
  fixtureSequence += 1;
  const prefix = fixtureSequence;
  let planSequence = 0;
  return Object.freeze({
    now: () => PLAN_NOW,
    planId: (): PlanId => {
      planSequence += 1;
      return asPlanId(`plan_fixture_${String(prefix)}_${String(planSequence)}`);
    },
  });
}

interface StorageTracking {
  readonly repositoryQueries: RepositoryQuery[];
  readonly listQueries: ListQuery[];
  readonly membershipQueries: ListMembershipQuery[];
  readonly savedPlans: ChangePlan[];
  transactionCalls: number;
}

function trackedStorage(
  storage: StoragePort,
  tracking: StorageTracking,
  failSave: boolean,
): StoragePort {
  const facade: StoragePort = {
    ...storage,
    queryRepositories(input: RepositoryQuery) {
      tracking.repositoryQueries.push(input);
      return storage.queryRepositories(input);
    },
    queryLists(input: ListQuery) {
      tracking.listQueries.push(input);
      return storage.queryLists(input);
    },
    queryListMemberships(input: ListMembershipQuery) {
      tracking.membershipQueries.push(input);
      return storage.queryListMemberships(input);
    },
    withTransaction<T>(callback: (transaction: StorageTransaction) => T): T {
      tracking.transactionCalls += 1;
      const pending: ChangePlan[] = [];
      const result = storage.withTransaction((transaction) =>
        callback({
          savePlan(plan: ChangePlan) {
            transaction.savePlan(plan);
            pending.push(plan);
            if (failSave) {
              throw new AppError("STORAGE_ERROR", "fixture save failure", {
                retryable: false,
              });
            }
          },
        } as StorageTransaction),
      );
      tracking.savedPlans.push(...pending);
      return result;
    },
  };
  return Object.freeze(facade);
}

export function plannerFixture(
  options: Readonly<{
    listCoverage?: Exclude<ListCoverage, "collecting">;
    maxPlanActions?: number;
    planTtlMinutes?: number;
    repositories?: readonly RepositoryView[];
    lists?: readonly UserList[];
    memberships?: readonly Readonly<{
      listId: UserListId;
      repositoryId: RepositoryId;
    }>[];
    snapshotStatus?: Snapshot["status"];
    starredRepositoryIds?: readonly RepositoryId[];
    failSave?: boolean;
    cyclicResolver?: boolean;
  }> = {},
) {
  const ids = Object.freeze({
    keepRepository: asRepositoryId("R_keep"),
    removeRepository: asRepositoryId("R_remove"),
    existingList: asUserListId("UL_existing"),
    addList: asUserListId("UL_add"),
  });
  const keep = repositoryFixture({
    repositoryId: ids.keepRepository,
    repositoryDatabaseId: asRepositoryDatabaseId("101"),
    name: "keep",
    fullName: "acme/keep",
    url: "https://github.com/acme/keep",
    stargazerCount: 20,
    isPrivate: true,
  });
  const remove = repositoryFixture({
    repositoryId: ids.removeRepository,
    repositoryDatabaseId: asRepositoryDatabaseId("102"),
    name: "remove",
    fullName: "acme/remove",
    url: "https://github.com/acme/remove",
    stargazerCount: 10,
  });
  const existing = userListFixture({
    listId: ids.existingList,
    name: "Existing",
    slug: "existing",
  });
  const add = userListFixture({
    listId: ids.addList,
    name: "Add",
    slug: "add",
  });
  const memoryStorage = createMemoryStorage();
  const snapshot = seedCompleteSnapshot(memoryStorage, {
    listCoverage: options.listCoverage ?? "complete",
    repositories: options.repositories ?? [keep, remove],
    lists: options.lists ?? [existing, add],
    memberships: options.memberships ?? [
      { listId: ids.existingList, repositoryId: ids.removeRepository },
    ],
    ...(options.snapshotStatus === undefined
      ? {}
      : { snapshotStatus: options.snapshotStatus }),
    ...(options.starredRepositoryIds === undefined
      ? {}
      : { starredRepositoryIds: options.starredRepositoryIds }),
  });
  const tracking: StorageTracking = {
    repositoryQueries: [],
    listQueries: [],
    membershipQueries: [],
    savedPlans: [],
    transactionCalls: 0,
  };
  const storage = trackedStorage(
    memoryStorage,
    tracking,
    options.failSave ?? false,
  );
  const runtime = fixtureRuntime();
  const config = Object.freeze({
    maxPlanActions: options.maxPlanActions ?? 5_000,
    planTtlMinutes: options.planTtlMinutes ?? 1_440,
  }) satisfies Pick<AppConfig, "maxPlanActions" | "planTtlMinutes">;
  const cyclicResolver = () => {
    const operations = Object.freeze([
      Object.freeze({
        operationId: "op_000001",
        kind: "list_create" as const,
        clientRef: "cycle-a",
        dependsOn: Object.freeze(["op_000002"]),
        preconditions: Object.freeze([]),
        before: Object.freeze({ listIds: Object.freeze([]) }),
        after: Object.freeze({
          name: "A",
          description: null,
          isPrivate: false,
        }),
        inverse: Object.freeze({ kind: "list_delete" }),
        risk: "normal" as const,
      }),
      Object.freeze({
        operationId: "op_000002",
        kind: "list_create" as const,
        clientRef: "cycle-b",
        dependsOn: Object.freeze(["op_000001"]),
        preconditions: Object.freeze([]),
        before: Object.freeze({ listIds: Object.freeze([]) }),
        after: Object.freeze({
          name: "B",
          description: null,
          isPrivate: false,
        }),
        inverse: Object.freeze({ kind: "list_delete" }),
        risk: "normal" as const,
      }),
    ]);
    return Object.freeze({
      operations,
      dependencies: Object.freeze([
        Object.freeze({
          operationId: "op_000001",
          dependsOnOperationId: "op_000002",
        }),
        Object.freeze({
          operationId: "op_000002",
          dependsOnOperationId: "op_000001",
        }),
      ]),
      warnings: Object.freeze([]),
    });
  };
  const service = new PlanService(
    storage,
    runtime,
    config,
    options.cyclicResolver ? cyclicResolver : undefined,
  );
  const validInput: PlanRequest = Object.freeze({
    snapshotId: snapshot.id,
    actions: Object.freeze([
      Object.freeze({
        kind: "unstar",
        repositories: Object.freeze({
          kind: "ids",
          repositoryIds: Object.freeze([ids.removeRepository]),
        }),
      }),
    ]),
    protectedRepositoryIds: Object.freeze([]),
    protectedListIds: Object.freeze([]),
    callerNote: "fixture",
  });

  return Object.freeze({
    service,
    storage,
    snapshot,
    repositories: Object.freeze({ keep, remove }),
    lists: Object.freeze({ existing, add }),
    ids,
    validInput,
    tracking,
  });
}

export const applyFixture = plannerFixture;
export const rollbackFixture = plannerFixture;
export const inspectFixture = plannerFixture;

export function fakeGitHub<T extends object>(overrides: T): Readonly<T> {
  return Object.freeze({ ...overrides });
}

export function fakeMonotonicTime(start = 0) {
  let current = start;
  return Object.freeze({
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
      return current;
    },
  });
}
