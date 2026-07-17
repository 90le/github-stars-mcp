import type { AppConfig } from "../../src/config.js";
import {
  asPlanId,
  asRepositoryDatabaseId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
  type PlanId,
  type RepositoryId,
  type RunId,
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
  GitHubCapabilities,
  GitHubStatusReadPort,
  MutationReceipt,
  RepositoryIdentity,
  UserListMutationResult,
} from "../../src/app/ports/github-port.js";
import type {
  AcquireLeaseInput,
  Lease,
  LeaseGuard,
  StoragePort,
  StorageTransaction,
} from "../../src/app/ports/storage-port.js";
import { MutationExecutor } from "../../src/app/services/mutation-executor.js";
import {
  MutationPacer,
  type MutationPacerRuntime,
} from "../../src/app/services/mutation-pacer.js";
import type { LeaseScheduler } from "../../src/app/services/lease-scope.js";
import {
  ApplyService,
  type ApplyInput,
} from "../../src/app/services/apply-service.js";
import type { FailureMode } from "../../src/domain/run.js";
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
  membershipSelectorMismatch: "repository" | "list" | undefined,
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
      const page = storage.queryListMemberships(input);
      if (
        input.cursor !== null ||
        membershipSelectorMismatch !== input.selector.kind
      ) {
        return page;
      }
      if (
        membershipSelectorMismatch === "repository" &&
        page.selector.kind === "repository" &&
        "listIds" in page
      ) {
        return Object.freeze({
          ...page,
          selector: Object.freeze({
            kind: "repository" as const,
            repositoryId: asRepositoryId("R_wrong_echo"),
          }),
        });
      }
      if (
        membershipSelectorMismatch === "list" &&
        page.selector.kind === "list" &&
        "repositoryIds" in page
      ) {
        return Object.freeze({
          ...page,
          selector: Object.freeze({
            kind: "list" as const,
            listId: asUserListId("UL_wrong_echo"),
          }),
        });
      }
      return page;
    },
    withTransaction<T>(callback: (transaction: StorageTransaction) => T): T {
      tracking.transactionCalls += 1;
      const pending: ChangePlan[] = [];
      const result = storage.withTransaction((transaction) =>
        callback({
          ...transaction,
          savePlan(plan: ChangePlan) {
            transaction.savePlan(plan);
            pending.push(plan);
            if (failSave) {
              throw new AppError("STORAGE_ERROR", "fixture save failure", {
                retryable: false,
              });
            }
          },
        }),
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
    binding?: AccountBinding;
    failSave?: boolean;
    cyclicResolver?: boolean;
    membershipSelectorMismatch?: "repository" | "list";
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
    binding: options.binding ?? plannerBinding,
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
    options.membershipSelectorMismatch,
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
    rawStorage: memoryStorage,
    snapshot,
    repositories: Object.freeze({ keep, remove }),
    lists: Object.freeze({ existing, add }),
    ids,
    validInput,
    tracking,
  });
}

const APPLY_CAPABILITIES: GitHubCapabilities = Object.freeze({
  starRead: "available",
  starWrite: "available",
  listRead: "available",
  listWrite: "available",
});

const APPLY_NOW = "2026-07-16T02:00:00.000Z";
const APPLY_INTERVAL_MS = 1_000;

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

class ApplyRuntime implements Clock, IdGenerator, MutationPacerRuntime {
  #wallMs: number;
  #monotonic = 0;
  #runSequence = 0;
  readonly events: string[] = [];
  waitGate: Promise<void> | null = null;
  onWait: (() => void) | null = null;

  constructor(now: string) {
    this.#wallMs = Date.parse(now);
  }

  now(): string {
    const value = new Date(this.#wallMs).toISOString();
    this.#wallMs += 1;
    return value;
  }

  setNow(now: string): void {
    this.#wallMs = Date.parse(now);
  }

  monotonicMs(): number {
    return this.#monotonic;
  }

  async wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.events.push(`wait:${String(delayMs)}`);
    this.onWait?.();
    aborted(signal);
    if (this.waitGate !== null) await this.waitGate;
    aborted(signal);
    this.#monotonic += delayMs;
  }

  snapshotId() {
    return asSnapshotId("snap_apply_unused");
  }

  planId() {
    return asPlanId("plan_apply_unused");
  }

  runId(): RunId {
    this.#runSequence += 1;
    return asRunId(`run_apply_${String(this.#runSequence)}`);
  }

  requestId(): string {
    return "request_apply_fixture";
  }

  operationId(): string {
    return "op_apply_unused";
  }
}

class ManualLeaseScheduler implements LeaseScheduler {
  readonly intervals: Array<
    Readonly<{ callback: () => void; intervalMs: number; active: boolean }>
  > = [];

  setInterval(callback: () => void, intervalMs: number): unknown {
    const interval = { callback, intervalMs, active: true };
    this.intervals.push(interval);
    return interval;
  }

  clearInterval(handle: unknown): void {
    (handle as { active: boolean }).active = false;
  }

  tick(): void {
    for (const interval of this.intervals) {
      if (interval.active) interval.callback();
    }
  }
}

type ApplyMutationCall = Readonly<{
  kind:
    | "star"
    | "unstar"
    | "createUserList"
    | "updateUserList"
    | "deleteUserList"
    | "setRepositoryListIds";
  operationId: string;
}>;

type ApplyMutationFailure = {
  readonly kind: ApplyMutationCall["kind"] | null;
  readonly error: Error;
  readonly afterApply: boolean;
};

class ApplyGitHub implements GitHubStatusReadPort {
  binding: AccountBinding;
  capabilities: GitHubCapabilities;
  starred = true;
  mutationGate: Promise<void> | null = null;
  onMutation: ((call: ApplyMutationCall) => void) | null = null;
  readonly statusCalls: string[] = [];
  readonly mutationCalls: ApplyMutationCall[] = [];
  readonly events: string[];
  readonly #repositories = new Map<string, RepositoryView>();
  readonly #stars = new Map<string, boolean>();
  readonly #lists = new Map<UserListId, UserList>();
  readonly #memberships = new Map<RepositoryId, readonly UserListId[]>();
  readonly #failures: ApplyMutationFailure[] = [];
  #createdSequence = 0;

  constructor(input: {
    binding: AccountBinding;
    capabilities: GitHubCapabilities;
    repositories: readonly RepositoryView[];
    lists: readonly UserList[];
    memberships: readonly Readonly<{
      repositoryId: RepositoryId;
      listId: UserListId;
    }>[];
    events: string[];
  }) {
    this.binding = input.binding;
    this.capabilities = input.capabilities;
    this.events = input.events;
    for (const repository of input.repositories) {
      const key = `${repository.owner}/${repository.name}`;
      this.#repositories.set(key, repository);
      this.#stars.set(key, repository.starredAt !== null);
    }
    for (const list of input.lists) this.#lists.set(list.listId, list);
    for (const membership of input.memberships) {
      const current = this.#memberships.get(membership.repositoryId) ?? [];
      this.#memberships.set(
        membership.repositoryId,
        Object.freeze([...current, membership.listId]),
      );
    }
  }

  failNextMutation(
    error: Error,
    options: Readonly<{
      kind?: ApplyMutationCall["kind"];
      afterApply?: boolean;
    }> = {},
  ): void {
    this.#failures.push({
      kind: options.kind ?? null,
      error,
      afterApply: options.afterApply ?? false,
    });
  }

  failEveryMutation(
    error: Error,
    kind: ApplyMutationCall["kind"] | null = null,
  ): void {
    for (let index = 0; index < 5_000; index += 1) {
      this.#failures.push({ kind, error, afterApply: false });
    }
  }

  getViewer(signal?: AbortSignal): Promise<AccountBinding> {
    aborted(signal);
    this.statusCalls.push("getViewer");
    return Promise.resolve(this.binding);
  }

  probeCapabilities(signal?: AbortSignal): Promise<GitHubCapabilities> {
    aborted(signal);
    this.statusCalls.push("probeCapabilities");
    return Promise.resolve(this.capabilities);
  }

  getRepositoryIdentity(
    coordinates: Readonly<{ owner: string; name: string }>,
    signal?: AbortSignal,
  ): Promise<RepositoryIdentity | null> {
    aborted(signal);
    const repository = this.#repositories.get(
      `${coordinates.owner}/${coordinates.name}`,
    );
    if (repository === undefined) return Promise.resolve(null);
    return Promise.resolve(
      Object.freeze({
        repositoryId: repository.repositoryId,
        repositoryDatabaseId: repository.repositoryDatabaseId,
        coordinates: Object.freeze({
          owner: repository.owner,
          name: repository.name,
        }),
      }),
    );
  }

  checkStar(
    coordinates: Readonly<{ owner: string; name: string }>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    aborted(signal);
    return Promise.resolve(
      this.#stars.get(`${coordinates.owner}/${coordinates.name}`) ?? false,
    );
  }

  getUserList(
    listId: UserListId,
    signal?: AbortSignal,
  ): Promise<UserList | null> {
    aborted(signal);
    return Promise.resolve(this.#lists.get(listId) ?? null);
  }

  getRepositoryListIds(
    repositoryId: RepositoryId,
    signal?: AbortSignal,
  ): Promise<readonly UserListId[]> {
    aborted(signal);
    return Promise.resolve(this.#memberships.get(repositoryId) ?? []);
  }

  async #beginMutation(
    kind: ApplyMutationCall["kind"],
    operationId: string,
    signal?: AbortSignal,
  ): Promise<
    Readonly<{
      receipt: MutationReceipt;
      afterApplyError: Error | null;
    }>
  > {
    aborted(signal);
    const call = Object.freeze({ kind, operationId });
    this.mutationCalls.push(call);
    this.events.push(`mutation:${kind}`);
    this.onMutation?.(call);
    if (this.mutationGate !== null) await this.mutationGate;
    aborted(signal);
    const failureIndex = this.#failures.findIndex(
      (failure) => failure.kind === null || failure.kind === kind,
    );
    const failure =
      failureIndex < 0 ? undefined : this.#failures.splice(failureIndex, 1)[0];
    if (failure !== undefined && !failure.afterApply) throw failure.error;
    return Object.freeze({
      receipt: Object.freeze({
        requestId: `REQ-${String(this.mutationCalls.length)}`,
        clientMutationId: operationId,
      }),
      afterApplyError: failure?.error ?? null,
    });
  }

  async star(
    coordinates: Readonly<{ owner: string; name: string }>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const result = await this.#beginMutation("star", operationId, signal);
    this.#stars.set(`${coordinates.owner}/${coordinates.name}`, true);
    this.starred = true;
    if (result.afterApplyError !== null) throw result.afterApplyError;
    return result.receipt;
  }

  async unstar(
    coordinates: Readonly<{ owner: string; name: string }>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const result = await this.#beginMutation("unstar", operationId, signal);
    this.#stars.set(`${coordinates.owner}/${coordinates.name}`, false);
    this.starred = false;
    if (result.afterApplyError !== null) throw result.afterApplyError;
    return result.receipt;
  }

  async createUserList(
    _input: Readonly<{
      name: string;
      description: string | null;
      isPrivate: boolean;
    }>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<UserListMutationResult> {
    const result = await this.#beginMutation(
      "createUserList",
      operationId,
      signal,
    );
    this.#createdSequence += 1;
    const list = userListFixture({
      listId: asUserListId(`UL_created_${String(this.#createdSequence)}`),
      name: _input.name,
      slug: _input.name.toLowerCase().replaceAll(" ", "-"),
      description: _input.description,
      isPrivate: _input.isPrivate,
    });
    this.#lists.set(list.listId, list);
    if (result.afterApplyError !== null) throw result.afterApplyError;
    return Object.freeze({ list, receipt: result.receipt });
  }

  async updateUserList(
    listId: UserListId,
    _input: Readonly<{
      name?: string;
      description?: string | null;
      isPrivate?: boolean;
    }>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<UserListMutationResult> {
    const result = await this.#beginMutation(
      "updateUserList",
      operationId,
      signal,
    );
    const current = this.#lists.get(listId) ?? userListFixture({ listId });
    const list = userListFixture({
      ...current,
      ..._input,
      listId,
      updatedAt: "2026-07-16T00:02:00.000Z",
    });
    this.#lists.set(listId, list);
    if (result.afterApplyError !== null) throw result.afterApplyError;
    return Object.freeze({
      list,
      receipt: result.receipt,
    });
  }

  async deleteUserList(
    listId: UserListId,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const result = await this.#beginMutation(
      "deleteUserList",
      operationId,
      signal,
    );
    this.#lists.delete(listId);
    if (result.afterApplyError !== null) throw result.afterApplyError;
    return result.receipt;
  }

  async setRepositoryListIds(
    repositoryId: RepositoryId,
    listIds: readonly UserListId[],
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const result = await this.#beginMutation(
      "setRepositoryListIds",
      operationId,
      signal,
    );
    this.#memberships.set(repositoryId, Object.freeze([...listIds]));
    if (result.afterApplyError !== null) throw result.afterApplyError;
    return result.receipt;
  }
}

export interface ApplyFixtureOptions {
  readonly readOnly?: boolean;
  readonly now?: string;
  readonly planTtlMinutes?: number;
  readonly planState?: "expired" | "failed" | "superseded";
  readonly binding?: AccountBinding;
  readonly capabilities?: GitHubCapabilities;
  readonly instanceId?: string;
  readonly expectedHash?: string;
  readonly transformLoadedPlan?: (plan: ChangePlan) => ChangePlan;
  readonly planBinding?: AccountBinding;
  readonly leaseScheduler?: LeaseScheduler;
}

interface ApplyTracking {
  readonly events: string[];
  readonly acquireLease: AcquireLeaseInput[];
  readonly renewLease: AcquireLeaseInput[];
  readonly releaseLease: Array<Readonly<{ name: string; ownerId: string }>>;
  readonly recovery: Array<
    Readonly<{ binding: AccountBinding; lease: LeaseGuard }>
  >;
  globalRecoveries: number;
  loseLeaseOnNextRenew: boolean;
  transactions: number;
}

function trackedApplyStorage(
  raw: StoragePort,
  tracking: ApplyTracking,
  transformLoadedPlan: ((plan: ChangePlan) => ChangePlan) | undefined,
): StoragePort {
  return Object.freeze({
    ...raw,
    getPlan(id: PlanId): ChangePlan | null {
      const plan = raw.getPlan(id);
      return plan === null || transformLoadedPlan === undefined
        ? plan
        : transformLoadedPlan(plan);
    },
    acquireLease(input: AcquireLeaseInput): Lease | null {
      tracking.acquireLease.push(input);
      tracking.events.push("lease:acquire");
      return raw.acquireLease(input);
    },
    renewLease(input: AcquireLeaseInput): Lease {
      tracking.renewLease.push(input);
      tracking.events.push("lease:renew");
      if (tracking.loseLeaseOnNextRenew) {
        tracking.loseLeaseOnNextRenew = false;
        raw.releaseLease({ name: input.name, ownerId: input.ownerId });
        raw.acquireLease({
          name: input.name,
          ownerId: "takeover-process",
          now: input.now,
          expiresAt: new Date(
            Date.parse(input.expiresAt) + 60_000,
          ).toISOString(),
        });
      }
      return raw.renewLease(input);
    },
    releaseLease(input: { readonly name: string; readonly ownerId: string }) {
      tracking.releaseLease.push(input);
      tracking.events.push("lease:release");
      return raw.releaseLease(input);
    },
    recoverAbandonedRuns(input: {
      readonly binding: AccountBinding;
      readonly lease: LeaseGuard;
    }): readonly RunId[] {
      tracking.recovery.push(input);
      tracking.events.push("run:recover");
      return raw.recoverAbandonedRuns(input);
    },
    recoverInterruptedRuns(now: string): readonly RunId[] {
      tracking.globalRecoveries += 1;
      return raw.recoverInterruptedRuns(now);
    },
    withTransaction<T>(callback: (transaction: StorageTransaction) => T): T {
      tracking.transactions += 1;
      return raw.withTransaction(callback);
    },
  });
}

export async function applyFixture(options: ApplyFixtureOptions = {}) {
  const planner = plannerFixture({
    ...(options.planTtlMinutes === undefined
      ? {}
      : { planTtlMinutes: options.planTtlMinutes }),
    ...(options.planBinding === undefined
      ? {}
      : { binding: options.planBinding }),
  });
  const created = await planner.service.create(planner.validInput);
  if (options.planState !== undefined) {
    if (options.planState === "failed") {
      planner.rawStorage.compareAndSetPlanState({
        planId: created.plan.id,
        expected: ["ready"],
        next: "applying",
      });
      planner.rawStorage.compareAndSetPlanState({
        planId: created.plan.id,
        expected: ["applying"],
        next: "failed",
      });
    } else {
      planner.rawStorage.compareAndSetPlanState({
        planId: created.plan.id,
        expected: ["ready"],
        next: options.planState,
      });
    }
  }
  const plan = planner.rawStorage.getPlan(created.plan.id)!;
  const runtime = new ApplyRuntime(options.now ?? APPLY_NOW);
  const scheduler = new ManualLeaseScheduler();
  const tracking: ApplyTracking = {
    events: [],
    acquireLease: [],
    renewLease: [],
    releaseLease: [],
    recovery: [],
    globalRecoveries: 0,
    loseLeaseOnNextRenew: false,
    transactions: 0,
  };
  const storage = trackedApplyStorage(
    planner.rawStorage,
    tracking,
    options.transformLoadedPlan,
  );
  const github = new ApplyGitHub({
    binding: options.binding ?? options.planBinding ?? plannerBinding,
    capabilities: options.capabilities ?? APPLY_CAPABILITIES,
    repositories: [planner.repositories.keep, planner.repositories.remove],
    lists: [planner.lists.existing, planner.lists.add],
    memberships: [
      {
        repositoryId: planner.ids.removeRepository,
        listId: planner.ids.existingList,
      },
    ],
    events: tracking.events,
  });
  const executor = new MutationExecutor(github, github);
  const createService = (
    instanceId = options.instanceId ?? "apply-instance-1",
  ) =>
    new ApplyService({
      github,
      storage,
      runtime,
      executor,
      pacer: new MutationPacer(runtime, APPLY_INTERVAL_MS),
      config: Object.freeze({ readOnly: options.readOnly ?? false }),
      instanceId,
      leaseScheduler: options.leaseScheduler ?? scheduler,
    });
  const input: ApplyInput = Object.freeze({
    planId: plan.id,
    expectedHash: options.expectedHash ?? plan.hash,
    failureMode: "stop" satisfies FailureMode,
  });

  return {
    service: createService(),
    createService,
    storage,
    rawStorage: planner.rawStorage,
    github,
    runtime,
    scheduler,
    tracking,
    plan,
    input,
    planner,
  };
}

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
