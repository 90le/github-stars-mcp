import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  GitHubCapabilities,
  GitHubListItem,
  GitHubStar,
  GitHubSyncReadPort,
  GitHubUserList,
  Page,
  RateLimitState,
} from "../../../src/app/ports/github-port.js";
import type {
  Clock,
  IdGenerator,
} from "../../../src/app/ports/runtime-port.js";
import type {
  AcquireLeaseInput,
  CompleteSnapshotInput,
  FailSnapshotInput,
  LeaseGuard,
  StoragePort,
} from "../../../src/app/ports/storage-port.js";
import {
  appendCleanupDiagnostic,
  LeaseScope,
  type LeaseScheduler,
} from "../../../src/app/services/lease-scope.js";
import {
  SyncService,
  type SyncInput,
  type SyncResult,
} from "../../../src/app/services/sync-service.js";
import { sha256Hex } from "../../../src/domain/canonical-json.js";
import { AppError } from "../../../src/domain/errors.js";
import { asSnapshotId, type UserListId } from "../../../src/domain/ids.js";
import type {
  AccountBinding,
  ObservedRepositoryMetadata,
} from "../../../src/domain/repository.js";
import type {
  SnapshotBatch,
  SnapshotVerificationBatch,
} from "../../../src/domain/snapshot.js";
import { createMemoryStorage } from "../../fixtures/memory-storage.js";
import {
  syncPage,
  syncRepository,
  syncRepositoryItem,
  syncStar,
  syncUnsupportedItem,
  syncUserList,
} from "../../support/read-service-fixtures.js";

const START = "2026-07-18T00:00:00.000Z";
const BINDING: AccountBinding = Object.freeze({
  host: "github.com",
  login: "sync-user",
  accountId: "U_sync_account",
});
const CAPABILITIES: GitHubCapabilities = Object.freeze({
  starRead: "available",
  starWrite: "unknown",
  listRead: "available",
  listWrite: "unknown",
});
const INPUT: SyncInput = Object.freeze({
  mode: "full",
  includeLists: false,
  metadataMaxAgeHours: 24,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
  };
}

class ManualRuntime implements Clock, IdGenerator {
  wallMs = Date.parse(START);
  monotonic = 1_000;
  nowCalls = 0;
  monotonicCalls = 0;
  snapshotCalls = 0;
  requestCalls = 0;

  now(): string {
    this.nowCalls += 1;
    return new Date(this.wallMs).toISOString();
  }

  monotonicMs(): number {
    this.monotonicCalls += 1;
    return this.monotonic;
  }

  snapshotId() {
    this.snapshotCalls += 1;
    return asSnapshotId(`snap_sync_${String(this.snapshotCalls)}`);
  }

  planId(): never {
    throw new Error("unexpected planId");
  }

  runId(): never {
    throw new Error("unexpected runId");
  }

  requestId(): string {
    this.requestCalls += 1;
    return `req_sync_${String(this.requestCalls)}`;
  }

  operationId(): never {
    throw new Error("unexpected operationId");
  }

  advance(milliseconds: number): void {
    this.wallMs += milliseconds;
    this.monotonic += milliseconds;
  }
}

class ControllableNowRuntime extends ManualRuntime {
  failNow = false;

  override now(): string {
    if (this.failNow) {
      throw new Error("raw-runtime-clock-secret");
    }
    return super.now();
  }
}

interface ManualInterval {
  readonly callback: () => void;
  active: boolean;
}

class ManualScheduler implements LeaseScheduler {
  readonly intervals: ManualInterval[] = [];
  readonly cleared: unknown[] = [];

  setInterval(callback: () => void, intervalMs: number): unknown {
    expect(intervalMs).toBe(60_000);
    const interval = { callback, active: true };
    this.intervals.push(interval);
    return interval;
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle);
    if (handle !== null && typeof handle === "object" && "active" in handle) {
      (handle as { active: boolean }).active = false;
    }
  }

  tick(): void {
    for (const interval of this.intervals) {
      if (interval.active) interval.callback();
    }
  }

  get activeCount(): number {
    return this.intervals.filter((interval) => interval.active).length;
  }
}

type SyncReadStep =
  | Readonly<{
      kind: "stars";
      cursor: string | null;
      page: Page<GitHubStar> | Promise<Page<GitHubStar>>;
      onRead?: () => void;
      error?: Error;
    }>
  | Readonly<{
      kind: "lists";
      cursor: string | null;
      page: Page<GitHubUserList> | Promise<Page<GitHubUserList>>;
      onRead?: () => void;
      error?: Error;
    }>
  | Readonly<{
      kind: "items";
      listId: UserListId;
      cursor: string | null;
      page: Page<GitHubListItem> | Promise<Page<GitHubListItem>>;
      onRead?: () => void;
      error?: Error;
    }>;

class ScriptedSyncGitHub implements GitHubSyncReadPort {
  readonly events: string[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #steps: SyncReadStep[];
  binding: AccountBinding = BINDING;
  capabilities: GitHubCapabilities = CAPABILITIES;

  constructor(steps: readonly SyncReadStep[] = []) {
    this.#steps = [...steps];
  }

  getViewer(signal?: AbortSignal): Promise<AccountBinding> {
    this.events.push("github:getViewer");
    this.signals.push(signal);
    return Promise.resolve(this.binding);
  }

  probeCapabilities(signal?: AbortSignal): Promise<GitHubCapabilities> {
    this.events.push("github:probeCapabilities");
    this.signals.push(signal);
    return Promise.resolve(this.capabilities);
  }

  async listStarredRepositories(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubStar>> {
    const step = this.#take("stars", cursor);
    this.events.push(`github:stars:${cursor ?? "null"}`);
    this.signals.push(signal);
    step.onRead?.();
    if (step.error !== undefined) throw step.error;
    return step.page;
  }

  async listUserLists(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubUserList>> {
    const step = this.#take("lists", cursor);
    this.events.push(`github:lists:${cursor ?? "null"}`);
    this.signals.push(signal);
    step.onRead?.();
    if (step.error !== undefined) throw step.error;
    return step.page;
  }

  async listUserListItems(
    listId: UserListId,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<GitHubListItem>> {
    const step = this.#take("items", cursor);
    if (step.listId !== listId) {
      throw new Error("unexpected List ID");
    }
    this.events.push(`github:items:${String(listId)}:${cursor ?? "null"}`);
    this.signals.push(signal);
    step.onRead?.();
    if (step.error !== undefined) throw step.error;
    return step.page;
  }

  assertExhausted(): void {
    expect(this.#steps).toEqual([]);
  }

  #take(
    kind: "stars",
    cursor: string | null,
  ): Extract<SyncReadStep, { kind: "stars" }>;
  #take(
    kind: "lists",
    cursor: string | null,
  ): Extract<SyncReadStep, { kind: "lists" }>;
  #take(
    kind: "items",
    cursor: string | null,
  ): Extract<SyncReadStep, { kind: "items" }>;
  #take(kind: SyncReadStep["kind"], cursor: string | null): SyncReadStep {
    const step = this.#steps.shift();
    if (step?.kind !== kind || step.cursor !== cursor) {
      throw new Error(`unexpected ${kind} cursor ${cursor ?? "null"}`);
    }
    return step;
  }
}

interface StorageTracking {
  readonly events: string[];
  readonly acquired: AcquireLeaseInput[];
  readonly guards: LeaseGuard[];
  readonly completed: CompleteSnapshotInput[];
  readonly failed: FailSnapshotInput[];
  readonly appended: Readonly<{
    id: string;
    batch: SnapshotBatch;
    lease: LeaseGuard;
  }>[];
  readonly verificationAppended: Readonly<{
    id: string;
    batch: SnapshotVerificationBatch;
    lease: LeaseGuard;
  }>[];
  readonly metadataReads: string[];
  releases: number;
  recoveries: number;
  creates: number;
  begins: number;
  finishes: number;
}

function trackedMemoryStorage(
  events: string[] = [],
  base: StoragePort = createMemoryStorage(),
): Readonly<{ storage: StoragePort; tracking: StorageTracking }> {
  base.migrate();
  const tracking: StorageTracking = {
    events,
    acquired: [],
    guards: [],
    completed: [],
    failed: [],
    appended: [],
    verificationAppended: [],
    metadataReads: [],
    releases: 0,
    recoveries: 0,
    creates: 0,
    begins: 0,
    finishes: 0,
  };
  const storage: StoragePort = {
    ...base,
    acquireLease(input) {
      tracking.events.push("storage:acquireLease");
      tracking.acquired.push(input);
      return base.acquireLease(input);
    },
    assertLease(guard) {
      tracking.events.push("storage:assertLease");
      tracking.guards.push(guard);
      return base.assertLease(guard);
    },
    renewLease(input) {
      tracking.events.push("storage:renewLease");
      return base.renewLease(input);
    },
    releaseLease(input) {
      tracking.events.push("storage:releaseLease");
      tracking.releases += 1;
      return base.releaseLease(input);
    },
    recoverAbandonedSnapshots(input) {
      tracking.events.push("storage:recoverAbandonedSnapshots");
      tracking.recoveries += 1;
      return base.recoverAbandonedSnapshots(input);
    },
    createSnapshot(input) {
      tracking.events.push("storage:createSnapshot");
      tracking.creates += 1;
      return base.createSnapshot(input);
    },
    appendSnapshotBatch(input) {
      tracking.events.push("storage:appendSnapshotBatch");
      tracking.appended.push(input);
      return base.appendSnapshotBatch(input);
    },
    beginSnapshotVerification(input) {
      tracking.events.push("storage:beginSnapshotVerification");
      tracking.begins += 1;
      return base.beginSnapshotVerification(input);
    },
    appendSnapshotVerificationBatch(input) {
      tracking.events.push("storage:appendSnapshotVerificationBatch");
      tracking.verificationAppended.push(input);
      return base.appendSnapshotVerificationBatch(input);
    },
    finishSnapshotVerification(input) {
      tracking.events.push("storage:finishSnapshotVerification");
      tracking.finishes += 1;
      return base.finishSnapshotVerification(input);
    },
    getRepositoryMetadata(id) {
      tracking.events.push("storage:getRepositoryMetadata");
      tracking.metadataReads.push(id);
      return base.getRepositoryMetadata(id);
    },
    completeSnapshot(input) {
      tracking.events.push("storage:completeSnapshot");
      const result = base.completeSnapshot(input);
      tracking.completed.push(input);
      return result;
    },
    failSnapshot(input) {
      tracking.events.push("storage:failSnapshot");
      tracking.failed.push(input);
      return base.failSnapshot(input);
    },
  };
  return Object.freeze({ storage, tracking });
}

function rateState(
  value: RateLimitState | null = null,
): Readonly<{ getState(): RateLimitState | null }> {
  return Object.freeze({
    getState: () => value,
  });
}

function omittedSteps(
  first: Page<GitHubStar> = syncPage([]),
  verification: Page<GitHubStar> = syncPage([]),
): readonly SyncReadStep[] {
  return [
    { kind: "stars", cursor: null, page: first },
    { kind: "stars", cursor: null, page: verification },
  ];
}

function chunks<T>(items: readonly T[], size = 100): readonly (readonly T[])[] {
  if (items.length === 0) return [[]];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function starTraversal(
  pages: readonly (readonly GitHubStar[])[],
  prefix: string,
): readonly SyncReadStep[] {
  return pages.map((items, index) => ({
    kind: "stars",
    cursor: index === 0 ? null : `${prefix}:${String(index)}`,
    page: syncPage(
      items,
      index === pages.length - 1 ? null : `${prefix}:${String(index + 1)}`,
    ),
  }));
}

function listTraversal(
  pages: readonly (readonly GitHubUserList[])[],
  prefix: string,
): readonly SyncReadStep[] {
  return pages.map((items, index) => ({
    kind: "lists",
    cursor: index === 0 ? null : `${prefix}:${String(index)}`,
    page: syncPage(
      items,
      index === pages.length - 1 ? null : `${prefix}:${String(index + 1)}`,
    ),
  }));
}

function itemTraversal(
  listId: UserListId,
  pages: readonly (readonly GitHubListItem[])[],
  prefix: string,
): readonly SyncReadStep[] {
  return pages.map((items, index) => ({
    kind: "items",
    listId,
    cursor: index === 0 ? null : `${prefix}:${String(index)}`,
    page: syncPage(
      items,
      index === pages.length - 1 ? null : `${prefix}:${String(index + 1)}`,
    ),
  }));
}

function seedMetadata(
  storage: StoragePort,
  observations: readonly ObservedRepositoryMetadata[],
): void {
  const lease = {
    name: "sync:metadata-seed",
    ownerId: "metadata-seed-owner",
    now: "2026-07-16T00:01:00.000Z",
  } as const;
  storage.acquireLease({
    name: lease.name,
    ownerId: lease.ownerId,
    now: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-16T00:10:00.000Z",
  });
  const id = asSnapshotId("snap_metadata_seed");
  storage.createSnapshot({
    draft: {
      id,
      binding: BINDING,
      mode: "full",
      listCoverage: "omitted",
      startedAt: "2026-07-16T00:00:00.000Z",
    },
    lease,
  });
  const stars = observations.map(({ repository }) => ({
    repositoryId: repository.repositoryId,
    starredAt: "2026-07-16T00:00:00.000Z",
  }));
  storage.appendSnapshotBatch({
    id,
    batch: {
      repositories: observations,
      stars,
      lists: [],
      memberships: [],
    },
    lease,
  });
  storage.beginSnapshotVerification({
    id,
    listCoverage: "omitted",
    lease,
  });
  storage.appendSnapshotVerificationBatch({
    id,
    batch: { stars, lists: [], memberships: [] },
    lease,
  });
  storage.finishSnapshotVerification({ id, lease });
  storage.completeSnapshot({
    id,
    completedAt: "2026-07-16T00:02:00.000Z",
    listCoverage: "omitted",
    counts: {
      repositories: observations.length,
      stars: observations.length,
      lists: 0,
      memberships: 0,
    },
    warningCount: 0,
    sourceRateLimit: null,
    lease,
  });
  storage.releaseLease({ name: lease.name, ownerId: lease.ownerId });
}

function serviceFixture(
  options: {
    readonly github?: ScriptedSyncGitHub;
    readonly runtime?: ManualRuntime;
    readonly storage?: StoragePort;
    readonly scheduler?: ManualScheduler;
    readonly rateLimit?: RateLimitState | null;
  } = {},
) {
  const runtime = options.runtime ?? new ManualRuntime();
  const tracked = options.storage === undefined ? trackedMemoryStorage() : null;
  const storage = options.storage ?? tracked!.storage;
  const github = options.github ?? new ScriptedSyncGitHub(omittedSteps());
  const scheduler = options.scheduler ?? new ManualScheduler();
  return {
    runtime,
    storage,
    github,
    scheduler,
    tracking: tracked?.tracking ?? null,
    service: new SyncService(
      github,
      storage,
      runtime,
      rateState(options.rateLimit),
      scheduler,
    ),
  };
}

async function rejectedAppError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("SyncService validation and admission", () => {
  it("exposes the exact public contract", () => {
    expectTypeOf<SyncService["sync"]>().toEqualTypeOf<
      (input: SyncInput, signal?: AbortSignal) => Promise<SyncResult>
    >();
    expect(Object.getOwnPropertyNames(SyncService.prototype).sort()).toEqual(
      ["constructor", "sync"].sort(),
    );
  });

  it.each([
    null,
    [],
    {},
    { ...INPUT, extra: true },
    { ...INPUT, mode: "fast" },
    { ...INPUT, includeLists: "false" },
    { ...INPUT, metadataMaxAgeHours: -1 },
    { ...INPUT, metadataMaxAgeHours: 1.5 },
    { ...INPUT, metadataMaxAgeHours: 8_761 },
  ])("rejects a non-exact input before all I/O", async (candidate) => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.sync(candidate as SyncInput),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      retryable: false,
    });
    expect(fixture.github.events).toEqual([]);
    expect(fixture.tracking?.events).toEqual([]);
    expect(fixture.runtime.monotonicCalls).toBe(0);
  });

  it("rejects accessors and an already-aborted signal before all I/O", async () => {
    let touched = false;
    const hostile: Record<string, unknown> = {
      mode: "full",
      includeLists: false,
    };
    Object.defineProperty(hostile, "metadataMaxAgeHours", {
      enumerable: true,
      get() {
        touched = true;
        return 24;
      },
    });
    const first = serviceFixture();
    await expect(
      first.service.sync(hostile as SyncInput),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(touched).toBe(false);
    expect(first.github.events).toEqual([]);
    expect(first.tracking?.events).toEqual([]);

    const second = serviceFixture();
    const controller = new AbortController();
    controller.abort("raw-abort-secret");
    const error = await second.service
      .sync(INPUT, controller.signal)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(`${String(error)}`).not.toContain("raw-abort-secret");
    expect(second.github.events).toEqual([]);
    expect(second.tracking?.events).toEqual([]);
    expect(second.runtime.monotonicCalls).toBe(0);
  });

  it("stops admission before the next remote call when cancellation arrives after identity", async () => {
    const controller = new AbortController();
    const github = new (class extends ScriptedSyncGitHub {
      override async getViewer(signal?: AbortSignal): Promise<AccountBinding> {
        const viewer = await super.getViewer(signal);
        controller.abort("admission-abort-secret");
        return viewer;
      }
    })();
    const fixture = serviceFixture({ github });

    const error = await fixture.service
      .sync(INPUT, controller.signal)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(String(error)).not.toContain("admission-abort-secret");
    expect(github.events).toEqual(["github:getViewer"]);
    expect(fixture.tracking?.events).toEqual([]);
  });

  it("gives caller cancellation precedence over an adapter cancellation AppError during admission", async () => {
    const controller = new AbortController();
    const github = new (class extends ScriptedSyncGitHub {
      override getViewer(signal?: AbortSignal): Promise<AccountBinding> {
        void super.getViewer(signal);
        controller.abort("in-flight-admission-secret");
        return Promise.reject(
          new AppError("GITHUB_UNAVAILABLE", "adapter cancellation detail", {
            retryable: true,
            details: { reason: "cancelled" },
          }),
        );
      }
    })();
    const fixture = serviceFixture({ github });

    const error = await fixture.service
      .sync(INPUT, controller.signal)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(String(error)).not.toContain("in-flight-admission-secret");
    expect(github.events).toEqual(["github:getViewer"]);
    expect(fixture.tracking?.events).toEqual([]);
  });

  it.each([
    ["unavailable", false],
    ["unknown", true],
  ] as const)(
    "rejects Star read %s before lease acquisition",
    async (starRead, retryable) => {
      const github = new ScriptedSyncGitHub();
      github.capabilities = Object.freeze({
        ...CAPABILITIES,
        starRead,
      });
      const fixture = serviceFixture({ github });

      await expect(fixture.service.sync(INPUT)).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        retryable,
      });
      expect(github.events).toEqual([
        "github:getViewer",
        "github:probeCapabilities",
      ]);
      expect(fixture.tracking?.events).toEqual([]);
    },
  );

  it("rejects unknown requested List capability before a lease but ignores it when Lists are omitted", async () => {
    const rejectedGitHub = new ScriptedSyncGitHub();
    rejectedGitHub.capabilities = Object.freeze({
      ...CAPABILITIES,
      listRead: "unknown",
    });
    const rejected = serviceFixture({ github: rejectedGitHub });

    await expect(
      rejected.service.sync({ ...INPUT, includeLists: true }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
    });
    expect(rejected.tracking?.events).toEqual([]);

    const acceptedGitHub = new ScriptedSyncGitHub(omittedSteps());
    acceptedGitHub.capabilities = rejectedGitHub.capabilities;
    const accepted = serviceFixture({ github: acceptedGitHub });
    await expect(accepted.service.sync(INPUT)).resolves.toMatchObject({
      counts: { lists: 0, memberships: 0, warnings: 0 },
    });
    expect(accepted.tracking?.acquired).toHaveLength(1);
  });

  it("records a deterministic Star-only warning for unavailable requested Lists", async () => {
    const star = syncStar(11);
    const github = new ScriptedSyncGitHub([
      ...starTraversal([[star]], "unavailable-collect-stars"),
      ...starTraversal([[star]], "unavailable-verify-stars"),
    ]);
    github.capabilities = Object.freeze({
      ...CAPABILITIES,
      listRead: "unavailable",
    });
    const fixture = serviceFixture({ github });

    const result = await fixture.service.sync({
      ...INPUT,
      includeLists: true,
    });

    expect(result.warnings).toEqual([
      "GitHub User Lists are unavailable; synchronized Stars only",
    ]);
    expect(result.counts).toMatchObject({
      repositories: 1,
      stars: 1,
      lists: 0,
      memberships: 0,
      warnings: 1,
    });
    expect(fixture.tracking?.completed[0]?.listCoverage).toBe("unavailable");
    expect(
      fixture.tracking?.appended.every(
        ({ batch }) =>
          batch.lists.length === 0 && batch.memberships.length === 0,
      ),
    ).toBe(true);
    expect(
      fixture.tracking?.verificationAppended.every(
        ({ batch }) =>
          batch.lists.length === 0 && batch.memberships.length === 0,
      ),
    ).toBe(true);
  });

  it("derives a redacted account lease, uses a unique owner per call, and recovers before creating", async () => {
    const runtime = new ManualRuntime();
    const github = new ScriptedSyncGitHub([
      ...omittedSteps(),
      ...omittedSteps(),
    ]);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      runtime,
      github,
      storage: tracked.storage,
    });

    await fixture.service.sync(INPUT);
    await fixture.service.sync(INPUT);

    const expectedName = `sync:github.com:${sha256Hex(BINDING.accountId).slice(
      0,
      16,
    )}`;
    expect(tracked.tracking.acquired).toHaveLength(2);
    expect(tracked.tracking.acquired.map(({ name }) => name)).toEqual([
      expectedName,
      expectedName,
    ]);
    expect(tracked.tracking.acquired.map(({ ownerId }) => ownerId)).toEqual([
      "sync:req_sync_1",
      "sync:req_sync_2",
    ]);
    expect(JSON.stringify(tracked.tracking.acquired)).not.toContain(
      BINDING.accountId,
    );
    expect(JSON.stringify(tracked.tracking.acquired)).not.toContain(
      BINDING.login,
    );
    expect(
      tracked.tracking.events.indexOf("storage:recoverAbandonedSnapshots"),
    ).toBeLessThan(tracked.tracking.events.indexOf("storage:createSnapshot"));
    expect(tracked.tracking.releases).toBe(2);
  });

  it("maps an already-held account lease to a safe retryable capability error", async () => {
    const tracked = trackedMemoryStorage();
    const leaseName = `sync:github.com:${sha256Hex(BINDING.accountId).slice(
      0,
      16,
    )}`;
    tracked.storage.acquireLease({
      name: leaseName,
      ownerId: "other-owner",
      now: START,
      expiresAt: "2026-07-18T00:10:00.000Z",
    });
    tracked.tracking.events.length = 0;
    tracked.tracking.acquired.length = 0;
    const fixture = serviceFixture({
      github: new ScriptedSyncGitHub(),
      storage: tracked.storage,
    });

    const error = await rejectedAppError(fixture.service.sync(INPUT));

    expect(error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_held" },
    });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toMatch(
      /sync-user|U_sync_account|other-owner/u,
    );
    expect(tracked.tracking.recoveries).toBe(0);
    expect(tracked.tracking.creates).toBe(0);
  });

  it("excludes a second SyncService instance while the first holds the account lease", async () => {
    const firstPage = deferred<Page<GitHubStar>>();
    const started = deferred<void>();
    const firstGitHub = new ScriptedSyncGitHub([
      {
        kind: "stars",
        cursor: null,
        page: firstPage.promise,
        onRead: () => started.resolve(undefined),
      },
      { kind: "stars", cursor: null, page: syncPage([]) },
    ]);
    const secondGitHub = new ScriptedSyncGitHub();
    const tracked = trackedMemoryStorage();
    const runtime = new ManualRuntime();
    const first = new SyncService(
      firstGitHub,
      tracked.storage,
      runtime,
      rateState(),
      new ManualScheduler(),
    );
    const second = new SyncService(
      secondGitHub,
      tracked.storage,
      runtime,
      rateState(),
      new ManualScheduler(),
    );

    const firstRunning = first.sync(INPUT);
    await started.promise;
    await expect(first.sync(INPUT)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_held" },
    });
    await expect(second.sync(INPUT)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_held" },
    });
    firstPage.resolve(syncPage([]));
    await expect(firstRunning).resolves.toMatchObject({
      snapshotId: asSnapshotId("snap_sync_1"),
    });

    expect(tracked.tracking.creates).toBe(1);
    expect(tracked.tracking.completed).toHaveLength(1);
    expect(tracked.tracking.releases).toBe(1);
    expect(runtime.requestCalls).toBe(3);
  });
});

describe("LeaseScope", () => {
  it("uses one canonical time per lease input, renews every minute beyond one TTL, and stops cleanly", async () => {
    const tracked = trackedMemoryStorage();
    const runtime = new ManualRuntime();
    const scheduler = new ManualScheduler();
    const scope = LeaseScope.acquire({
      storage: tracked.storage,
      runtime,
      name: "sync:github.com:lease-test",
      ownerId: "sync:req_lease",
      scheduler,
    });
    const gate = deferred<void>();
    const running = scope.run(async (active) => {
      expect(active).toBe(scope);
      expect(scheduler.activeCount).toBe(1);
      await gate.promise;
      active.assertActive();
      return "done";
    });

    expect(tracked.tracking.acquired[0]).toEqual({
      name: "sync:github.com:lease-test",
      ownerId: "sync:req_lease",
      now: START,
      expiresAt: "2026-07-18T00:10:00.000Z",
    });
    for (let minute = 0; minute < 11; minute += 1) {
      runtime.advance(60_000);
      expect(() => scheduler.tick()).not.toThrow();
    }
    expect(
      tracked.storage.assertLease({
        name: "sync:github.com:lease-test",
        ownerId: "sync:req_lease",
        now: runtime.now(),
      }).expiresAt,
    ).toBe("2026-07-18T00:21:00.000Z");

    gate.resolve();
    await expect(running).resolves.toBe("done");
    expect(scheduler.activeCount).toBe(0);
    expect(tracked.tracking.releases).toBe(1);
    expect(runtime.nowCalls).toBeGreaterThanOrEqual(13);
  });

  it("marks ownership loss, aborts the internal signal, and neither releases nor lets timer exceptions escape", async () => {
    const tracked = trackedMemoryStorage();
    const runtime = new ManualRuntime();
    const scheduler = new ManualScheduler();
    const scope = LeaseScope.acquire({
      storage: tracked.storage,
      runtime,
      name: "sync:github.com:lost-test",
      ownerId: "sync:req_old",
      scheduler,
    });
    const gate = deferred<void>();
    const running = scope.run(async (active) => {
      await gate.promise;
      active.assertActive();
    });

    runtime.advance(10 * 60_000);
    expect(
      tracked.storage.acquireLease({
        name: "sync:github.com:lost-test",
        ownerId: "sync:req_new",
        now: runtime.now(),
        expiresAt: "2026-07-18T00:20:00.000Z",
      })?.ownerId,
    ).toBe("sync:req_new");
    expect(() => scheduler.tick()).not.toThrow();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.tryFreshGuard()).toBeNull();
    gate.resolve();

    await expect(running).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_lost" },
    });
    expect(tracked.tracking.releases).toBe(0);
    expect(
      tracked.storage.assertLease({
        name: "sync:github.com:lost-test",
        ownerId: "sync:req_new",
        now: runtime.now(),
      }).ownerId,
    ).toBe("sync:req_new");
  });

  it("distinguishes acquisition storage failures from runtime clock failures", () => {
    const storageTracked = trackedMemoryStorage();
    const storageFailurePort: StoragePort = {
      ...storageTracked.storage,
      acquireLease() {
        throw new AppError("PRECONDITION_FAILED", "raw acquire precondition");
      },
    };
    let acquisitionError: unknown;
    try {
      LeaseScope.acquire({
        storage: storageFailurePort,
        runtime: new ManualRuntime(),
        name: "sync:github.com:acquire-storage-failure",
        ownerId: "sync:req_storage_failure",
        scheduler: new ManualScheduler(),
      });
    } catch (error) {
      acquisitionError = error;
    }
    expect(acquisitionError).toBeInstanceOf(AppError);
    expect(acquisitionError).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: false,
      details: { reason: "lease_storage_failure" },
    });

    const runtimeTracked = trackedMemoryStorage();
    let acquireCalls = 0;
    const runtimeStorage: StoragePort = {
      ...runtimeTracked.storage,
      acquireLease(input) {
        acquireCalls += 1;
        return runtimeTracked.storage.acquireLease(input);
      },
    };
    const runtime = new ControllableNowRuntime();
    runtime.failNow = true;
    let runtimeError: unknown;
    try {
      LeaseScope.acquire({
        storage: runtimeStorage,
        runtime,
        name: "sync:github.com:acquire-runtime-failure",
        ownerId: "sync:req_runtime_failure",
        scheduler: new ManualScheduler(),
      });
    } catch (error) {
      runtimeError = error;
    }
    expect(runtimeError).toBeInstanceOf(AppError);
    expect(runtimeError).toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false,
      details: { reason: "invalid_runtime_clock" },
    });
    expect(acquireCalls).toBe(0);
  });

  it("contains heartbeat clock failure as INTERNAL_ERROR and releases an owned lease", async () => {
    const tracked = trackedMemoryStorage();
    const runtime = new ControllableNowRuntime();
    const scheduler = new ManualScheduler();
    const scope = LeaseScope.acquire({
      storage: tracked.storage,
      runtime,
      name: "sync:github.com:heartbeat-runtime-failure",
      ownerId: "sync:req_heartbeat_runtime",
      scheduler,
    });
    const gate = deferred<void>();
    const running = scope.run(async (active) => {
      await gate.promise;
      active.assertActive();
    });

    runtime.failNow = true;
    expect(() => scheduler.tick()).not.toThrow();
    expect(scope.signal.aborted).toBe(true);
    runtime.failNow = false;
    gate.resolve(undefined);

    await expect(running).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false,
      details: { reason: "invalid_runtime_clock" },
    });
    expect(tracked.tracking.releases).toBe(1);
  });

  it("blocks new work when known lease expiry passes before a delayed heartbeat", async () => {
    const tracked = trackedMemoryStorage();
    const runtime = new ManualRuntime();
    const scheduler = new ManualScheduler();
    const scope = LeaseScope.acquire({
      storage: tracked.storage,
      runtime,
      name: "sync:github.com:known-expiry",
      ownerId: "sync:req_known_expiry",
      scheduler,
    });
    let remoteStarted = false;

    const error = await scope
      .run((active) => {
        runtime.advance(10 * 60_000);
        active.assertActive();
        remoteStarted = true;
        return Promise.resolve();
      })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_lost" },
    });
    expect(remoteStarted).toBe(false);
    expect(scope.signal.aborted).toBe(true);
    expect(scheduler.activeCount).toBe(0);
    expect(tracked.tracking.releases).toBe(0);
  });

  it("sanitizes scheduler registration failure and releases the acquired lease", async () => {
    const tracked = trackedMemoryStorage();
    let actionStarted = false;
    const scheduler: LeaseScheduler = {
      setInterval() {
        throw new Error("raw-scheduler-secret");
      },
      clearInterval() {
        throw new Error("clear should not be called");
      },
    };
    const scope = LeaseScope.acquire({
      storage: tracked.storage,
      runtime: new ManualRuntime(),
      name: "sync:github.com:scheduler-failure",
      ownerId: "sync:req_scheduler_failure",
      scheduler,
    });

    const error = await rejectedAppError(
      scope.run(() => {
        actionStarted = true;
        return Promise.resolve();
      }),
    );

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false,
      details: { reason: "lease_scheduler_failure" },
    });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
      "raw-scheduler-secret",
    );
    expect(actionStarted).toBe(false);
    expect(tracked.tracking.releases).toBe(1);
  });

  it("preserves a primary error with only sanitized cleanup diagnostics and surfaces cleanup failure by itself", async () => {
    const originalCause = new Error("original primary cause");
    const primary = new AppError(
      "GITHUB_UNAVAILABLE",
      "primary collection failed",
      {
        retryable: true,
        details: { reason: "primary" },
        cause: originalCause,
      },
    );
    const firstTracked = trackedMemoryStorage();
    const firstStorage: StoragePort = {
      ...firstTracked.storage,
      releaseLease() {
        throw new Error("raw-cleanup-secret");
      },
    };
    const firstScope = LeaseScope.acquire({
      storage: firstStorage,
      runtime: new ManualRuntime(),
      name: "sync:github.com:cleanup-primary",
      ownerId: "sync:req_primary",
      scheduler: new ManualScheduler(),
    });

    const received = await firstScope
      .run(() => Promise.reject(primary))
      .catch((error: unknown) => error);

    expect(received).toBe(primary);
    expect((received as Error & { cause?: unknown }).cause).toBe(originalCause);
    expect(
      JSON.stringify(
        (
          received as Error & {
            cleanupDiagnostics?: readonly unknown[];
          }
        ).cleanupDiagnostics,
      ),
    ).not.toContain("raw-cleanup-secret");
    expect(
      (
        received as Error & {
          cleanupDiagnostics?: readonly unknown[];
        }
      ).cleanupDiagnostics,
    ).toMatchObject([
      {
        code: "STORAGE_ERROR",
        retryable: false,
      },
    ]);

    const secondTracked = trackedMemoryStorage();
    const secondStorage: StoragePort = {
      ...secondTracked.storage,
      releaseLease() {
        throw new Error("raw-cleanup-secret");
      },
    };
    const secondScope = LeaseScope.acquire({
      storage: secondStorage,
      runtime: new ManualRuntime(),
      name: "sync:github.com:cleanup-only",
      ownerId: "sync:req_cleanup",
      scheduler: new ManualScheduler(),
    });
    const cleanup = await rejectedAppError(
      secondScope.run(() => Promise.resolve("published")),
    );
    expect(cleanup).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: false,
      details: { reason: "lease_storage_failure" },
    });
    expect(
      `${cleanup.message}${JSON.stringify(cleanup.details)}`,
    ).not.toContain("raw-cleanup-secret");
  });

  it("bounds repeated sanitized cleanup diagnostics without changing the primary cause", () => {
    const cause = new Error("original cause");
    const primary = new AppError("INTERNAL_ERROR", "primary failure", {
      cause,
    });

    for (let index = 0; index < 12; index += 1) {
      appendCleanupDiagnostic(
        primary,
        new Error(`raw-cleanup-credential-${String(index)}`),
      );
    }

    const diagnostics = (
      primary as AppError & {
        cleanupDiagnostics?: readonly unknown[];
      }
    ).cleanupDiagnostics;
    expect(primary.cause).toBe(cause);
    expect(diagnostics).toHaveLength(4);
    expect(JSON.stringify(diagnostics)).not.toContain("credential");
  });
});

describe("SyncService bounded collection and immutable publication", () => {
  it("streams more than 100 Stars and memberships in bounded batches and accepts reordered verification", async () => {
    const runtime = new ManualRuntime();
    const repositories = Array.from({ length: 205 }, (_, index) =>
      syncRepository(index + 1),
    );
    const stars = repositories.map((repository, index) =>
      syncStar(index + 1, {
        repository,
        starredAt: new Date(
          Date.parse("2026-07-01T00:00:00.000Z") + index * 1_000,
        ).toISOString(),
      }),
    );
    const lists = [syncUserList(1), syncUserList(2)];
    const memberships = repositories.map(syncRepositoryItem);
    const finalRate = Object.freeze({
      remaining: 4_321,
      resetAt: "2026-07-18T01:00:00.000Z",
    });
    const steps: readonly SyncReadStep[] = [
      ...starTraversal(chunks(stars), "collect-stars"),
      ...listTraversal([[lists[0]!], [lists[1]!]], "collect-lists"),
      ...itemTraversal(
        lists[0]!.listId,
        chunks(memberships),
        "collect-items-1",
      ),
      ...itemTraversal(lists[1]!.listId, [[]], "collect-items-2"),
      ...listTraversal([[lists[1]!], [lists[0]!]], "verify-lists"),
      ...itemTraversal(lists[1]!.listId, [[]], "verify-items-2"),
      ...itemTraversal(
        lists[0]!.listId,
        chunks([...memberships].reverse()),
        "verify-items-1",
      ),
      ...starTraversal(chunks([...stars].reverse()), "verify-stars").map(
        (step, index, all) =>
          index === all.length - 1 && step.kind === "stars"
            ? {
                ...step,
                page: syncPage(
                  [...stars].reverse().slice(index * 100, index * 100 + 100),
                  null,
                  { rateLimit: finalRate },
                ),
                onRead: () => runtime.advance(1_234),
              }
            : step,
      ),
    ];
    const github = new ScriptedSyncGitHub(steps);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      runtime,
      github,
      storage: tracked.storage,
      rateLimit: finalRate,
    });

    const result = await fixture.service.sync({
      mode: "full",
      includeLists: true,
      metadataMaxAgeHours: 24,
    });

    expect(result).toEqual({
      snapshotId: asSnapshotId("snap_sync_1"),
      counts: {
        repositories: 205,
        stars: 205,
        lists: 2,
        memberships: 205,
        refreshedRepositories: 205,
        reusedMetadata: 0,
        warnings: 0,
      },
      warnings: [],
      rateLimit: finalRate,
      durationMs: 1_234,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.rateLimit)).toBe(true);
    expect(result.rateLimit).not.toBe(finalRate);
    expect(tracked.tracking.metadataReads).toEqual([]);
    expect(tracked.tracking.completed).toHaveLength(1);
    expect(tracked.tracking.completed[0]?.sourceRateLimit).toEqual(finalRate);
    expect(tracked.tracking.failed).toEqual([]);
    expect(tracked.tracking.begins).toBe(1);
    expect(tracked.tracking.finishes).toBe(1);
    for (const { batch } of tracked.tracking.appended) {
      expect(batch.repositories.length).toBeLessThanOrEqual(100);
      expect(batch.stars.length).toBeLessThanOrEqual(100);
      expect(batch.lists.length).toBeLessThanOrEqual(100);
      expect(batch.memberships.length).toBeLessThanOrEqual(100);
      expect(
        batch.repositories.length +
          batch.stars.length +
          batch.lists.length +
          batch.memberships.length,
      ).toBeGreaterThan(0);
    }
    for (const { batch } of tracked.tracking.verificationAppended) {
      expect(batch.stars.length).toBeLessThanOrEqual(100);
      expect(batch.lists.length).toBeLessThanOrEqual(100);
      expect(batch.memberships.length).toBeLessThanOrEqual(100);
      expect(
        batch.stars.length + batch.lists.length + batch.memberships.length,
      ).toBeGreaterThan(0);
    }
    const verificationEvents = tracked.tracking.events.filter((event) =>
      event.startsWith("storage:appendSnapshotVerificationBatch"),
    );
    expect(verificationEvents).toHaveLength(8);
    expect(github.events.at(-1)).toMatch(/^github:stars:/u);
    const postLeaseSignals = github.signals.slice(2);
    expect(postLeaseSignals.length).toBeGreaterThan(0);
    expect(
      postLeaseSignals.every((signal) => signal === postLeaseSignals[0]),
    ).toBe(true);
    expect(postLeaseSignals[0]).toBeInstanceOf(AbortSignal);
    github.assertExhausted();
  });

  it("reuses complete local observations only inside the incremental age boundary", async () => {
    const exactRemote = syncRepository(1, { description: "remote exact" });
    const boundaryRemote = syncRepository(2, {
      description: "remote boundary",
    });
    const staleRemote = syncRepository(3, { description: "remote stale" });
    const futureRemote = syncRepository(4, { description: "remote future" });
    const missingRemote = syncRepository(5, { description: "remote missing" });
    const mismatchRemote = syncRepository(6, {
      description: "remote mismatch",
    });
    const exactStored = syncRepository(1, { description: "stored exact" });
    const boundaryStored = syncRepository(2, {
      description: "stored boundary",
    });
    const staleStored = syncRepository(3, { description: "stored stale" });
    const futureStored = syncRepository(4, { description: "stored future" });
    const mismatchStored = syncRepository(6, {
      description: "stored but invalid",
    });
    const base = createMemoryStorage();
    base.migrate();
    seedMetadata(base, [
      { repository: exactStored, observedAt: START },
      {
        repository: boundaryStored,
        observedAt: "2026-07-17T00:00:00.000Z",
      },
      {
        repository: staleStored,
        observedAt: "2026-07-16T23:59:59.999Z",
      },
      {
        repository: futureStored,
        observedAt: "2026-07-18T00:00:00.001Z",
      },
      { repository: mismatchStored, observedAt: START },
    ]);
    const tracked = trackedMemoryStorage([], base);
    const mismatchedObservation: ObservedRepositoryMetadata = Object.freeze({
      repository: syncRepository(999),
      observedAt: START,
    });
    const storage: StoragePort = {
      ...tracked.storage,
      getRepositoryMetadata(repositoryId) {
        if (repositoryId === mismatchRemote.repositoryId) {
          tracked.storage.getRepositoryMetadata(repositoryId);
          return mismatchedObservation;
        }
        return tracked.storage.getRepositoryMetadata(repositoryId);
      },
    };
    const stars = [
      exactRemote,
      boundaryRemote,
      staleRemote,
      futureRemote,
      missingRemote,
      mismatchRemote,
    ].map((repository, index) => syncStar(index + 1, { repository }));
    const github = new ScriptedSyncGitHub([
      ...starTraversal([stars], "incremental-collect"),
      ...starTraversal([[...stars].reverse()], "incremental-verify"),
    ]);
    const fixture = serviceFixture({ github, storage });

    const result = await fixture.service.sync({
      mode: "incremental",
      includeLists: false,
      metadataMaxAgeHours: 24,
    });

    expect(result.counts).toMatchObject({
      repositories: 6,
      stars: 6,
      refreshedRepositories: 4,
      reusedMetadata: 2,
    });
    expect(tracked.tracking.metadataReads).toEqual(
      stars.map(({ repository }) => repository.repositoryId),
    );
    const observations = tracked.tracking.appended.flatMap(
      ({ batch }) => batch.repositories,
    );
    expect(observations).toHaveLength(6);
    expect(observations[0]).toEqual({
      repository: exactStored,
      observedAt: START,
    });
    expect(observations[1]).toEqual({
      repository: boundaryStored,
      observedAt: "2026-07-17T00:00:00.000Z",
    });
    expect(observations.slice(2).map(({ repository }) => repository)).toEqual([
      staleRemote,
      futureRemote,
      missingRemote,
      mismatchRemote,
    ]);
    expect(observations.slice(2).map(({ observedAt }) => observedAt)).toEqual(
      Array.from({ length: 4 }, () => START),
    );
    github.assertExhausted();
  });

  it("treats metadataMaxAgeHours zero as exact draft time only", async () => {
    const exact = syncRepository(21, { description: "stored exact zero" });
    const old = syncRepository(22, { description: "stored old zero" });
    const base = createMemoryStorage();
    base.migrate();
    seedMetadata(base, [
      { repository: exact, observedAt: START },
      { repository: old, observedAt: "2026-07-17T23:59:59.999Z" },
    ]);
    const tracked = trackedMemoryStorage([], base);
    const remoteExact = syncRepository(21, {
      description: "remote exact zero",
    });
    const remoteOld = syncRepository(22, { description: "remote old zero" });
    const stars = [
      syncStar(21, { repository: remoteExact }),
      syncStar(22, { repository: remoteOld }),
    ];
    const github = new ScriptedSyncGitHub([
      ...starTraversal([stars], "zero-collect"),
      ...starTraversal([stars], "zero-verify"),
    ]);
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
    });

    const result = await fixture.service.sync({
      mode: "incremental",
      includeLists: false,
      metadataMaxAgeHours: 0,
    });

    expect(result.counts).toMatchObject({
      refreshedRepositories: 1,
      reusedMetadata: 1,
    });
    const observations = tracked.tracking.appended.flatMap(
      ({ batch }) => batch.repositories,
    );
    expect(observations[0]?.repository.description).toBe("stored exact zero");
    expect(observations[1]).toEqual({
      repository: remoteOld,
      observedAt: START,
    });
  });
});

describe("SyncService consistency, coverage, and cancellation", () => {
  it("detects a Star mutation after List collection, fails that draft, then publishes a stable retry", async () => {
    const stableRepository = syncRepository(30);
    const changedRepository = syncRepository(31);
    const stable = syncStar(30, { repository: stableRepository });
    const before = syncStar(31, {
      repository: changedRepository,
      starredAt: "2026-07-17T00:00:00.000Z",
    });
    const after = syncStar(31, {
      repository: changedRepository,
      starredAt: "2026-07-18T00:00:00.000Z",
    });
    const list = syncUserList(31);
    const steps: readonly SyncReadStep[] = [
      ...starTraversal([[stable], [before]], "attempt-1-collect-stars"),
      ...listTraversal([[list]], "attempt-1-collect-lists"),
      ...itemTraversal(
        list.listId,
        [
          [syncRepositoryItem(stableRepository)],
          [syncRepositoryItem(changedRepository)],
        ],
        "attempt-1-collect-items",
      ),
      ...listTraversal([[list]], "attempt-1-verify-lists"),
      ...itemTraversal(
        list.listId,
        [
          [syncRepositoryItem(stableRepository)],
          [syncRepositoryItem(changedRepository)],
        ],
        "attempt-1-verify-items",
      ),
      ...starTraversal([[stable], [after]], "attempt-1-verify-stars"),
      ...starTraversal([[stable], [after]], "attempt-2-collect-stars"),
      ...listTraversal([[list]], "attempt-2-collect-lists"),
      ...itemTraversal(
        list.listId,
        [
          [syncRepositoryItem(stableRepository)],
          [syncRepositoryItem(changedRepository)],
        ],
        "attempt-2-collect-items",
      ),
      ...listTraversal([[list]], "attempt-2-verify-lists"),
      ...itemTraversal(
        list.listId,
        [
          [syncRepositoryItem(stableRepository)],
          [syncRepositoryItem(changedRepository)],
        ],
        "attempt-2-verify-items",
      ),
      ...starTraversal([[stable], [after]], "attempt-2-verify-stars"),
    ];
    const github = new ScriptedSyncGitHub(steps);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
    });

    const result = await fixture.service.sync({
      mode: "full",
      includeLists: true,
      metadataMaxAgeHours: 24,
    });

    expect(result.snapshotId).toBe(asSnapshotId("snap_sync_2"));
    expect(tracked.tracking.creates).toBe(2);
    expect(tracked.tracking.failed).toHaveLength(1);
    expect(tracked.tracking.completed).toHaveLength(1);
    expect(tracked.tracking.failed[0]?.id).toBe(asSnapshotId("snap_sync_1"));
    github.assertExhausted();
  });

  it.each(["duplicate-id", "cursor-cycle"] as const)(
    "stops after three %s consistency attempts with collection_unstable",
    async (scenario) => {
      const star = syncStar(41);
      const oneAttempt =
        scenario === "duplicate-id"
          ? ([
              {
                kind: "stars",
                cursor: null,
                page: syncPage([star], "deep"),
              },
              {
                kind: "stars",
                cursor: "deep",
                page: syncPage([star]),
              },
            ] satisfies readonly SyncReadStep[])
          : ([
              {
                kind: "stars",
                cursor: null,
                page: syncPage([star], "cycle"),
              },
              {
                kind: "stars",
                cursor: "cycle",
                page: syncPage([], "cycle"),
              },
            ] satisfies readonly SyncReadStep[]);
      const github = new ScriptedSyncGitHub([
        ...oneAttempt,
        ...oneAttempt,
        ...oneAttempt,
      ]);
      const tracked = trackedMemoryStorage();
      const fixture = serviceFixture({
        github,
        storage: tracked.storage,
      });

      const error = await rejectedAppError(fixture.service.sync(INPUT));

      expect(error).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        retryable: true,
        details: { reason: "collection_unstable" },
      });
      expect(tracked.tracking.creates).toBe(3);
      expect(tracked.tracking.failed).toHaveLength(3);
      expect(tracked.tracking.completed).toEqual([]);
      expect(
        github.events.filter((event) => event === "github:stars:null"),
      ).toHaveLength(3);
      github.assertExhausted();
    },
  );

  it.each(["List metadata", "membership"] as const)(
    "retries deep-page %s churn and publishes only the stable second attempt",
    async (scenario) => {
      const firstRepository = syncRepository(61);
      const secondRepository = syncRepository(62);
      const stars = [
        syncStar(61, { repository: firstRepository }),
        syncStar(62, { repository: secondRepository }),
      ];
      const firstList = syncUserList(61);
      const secondList = syncUserList(62);
      const changedSecondList = syncUserList(62, {
        listId: secondList.listId,
        name: "Changed second-page List",
      });
      let steps: readonly SyncReadStep[];
      if (scenario === "List metadata") {
        const firstItems = [[syncRepositoryItem(firstRepository)]];
        const secondItems = [[syncRepositoryItem(secondRepository)]];
        steps = [
          ...starTraversal([stars], "list-churn-1-stars"),
          ...listTraversal([[firstList], [secondList]], "list-churn-1-lists"),
          ...itemTraversal(
            firstList.listId,
            firstItems,
            "list-churn-1-items-a",
          ),
          ...itemTraversal(
            secondList.listId,
            secondItems,
            "list-churn-1-items-b",
          ),
          ...listTraversal(
            [[firstList], [changedSecondList]],
            "list-churn-1-verify-lists",
          ),
          ...itemTraversal(
            firstList.listId,
            firstItems,
            "list-churn-1-verify-items-a",
          ),
          ...itemTraversal(
            secondList.listId,
            secondItems,
            "list-churn-1-verify-items-b",
          ),
          ...starTraversal([stars], "list-churn-1-verify-stars"),
          ...starTraversal([stars], "list-churn-2-stars"),
          ...listTraversal(
            [[firstList], [changedSecondList]],
            "list-churn-2-lists",
          ),
          ...itemTraversal(
            firstList.listId,
            firstItems,
            "list-churn-2-items-a",
          ),
          ...itemTraversal(
            secondList.listId,
            secondItems,
            "list-churn-2-items-b",
          ),
          ...listTraversal(
            [[firstList], [changedSecondList]],
            "list-churn-2-verify-lists",
          ),
          ...itemTraversal(
            firstList.listId,
            firstItems,
            "list-churn-2-verify-items-a",
          ),
          ...itemTraversal(
            secondList.listId,
            secondItems,
            "list-churn-2-verify-items-b",
          ),
          ...starTraversal([stars], "list-churn-2-verify-stars"),
        ];
      } else {
        const bothPages = [
          [syncRepositoryItem(firstRepository)],
          [syncRepositoryItem(secondRepository)],
        ];
        const currentPages = [[syncRepositoryItem(firstRepository)], []];
        steps = [
          ...starTraversal([stars], "membership-churn-1-stars"),
          ...listTraversal([[firstList]], "membership-churn-1-lists"),
          ...itemTraversal(
            firstList.listId,
            bothPages,
            "membership-churn-1-items",
          ),
          ...listTraversal([[firstList]], "membership-churn-1-verify-lists"),
          ...itemTraversal(
            firstList.listId,
            currentPages,
            "membership-churn-1-verify-items",
          ),
          ...starTraversal([stars], "membership-churn-1-verify-stars"),
          ...starTraversal([stars], "membership-churn-2-stars"),
          ...listTraversal([[firstList]], "membership-churn-2-lists"),
          ...itemTraversal(
            firstList.listId,
            currentPages,
            "membership-churn-2-items",
          ),
          ...listTraversal([[firstList]], "membership-churn-2-verify-lists"),
          ...itemTraversal(
            firstList.listId,
            currentPages,
            "membership-churn-2-verify-items",
          ),
          ...starTraversal([stars], "membership-churn-2-verify-stars"),
        ];
      }
      const github = new ScriptedSyncGitHub(steps);
      const tracked = trackedMemoryStorage();
      const fixture = serviceFixture({
        github,
        storage: tracked.storage,
      });

      const result = await fixture.service.sync({
        mode: "full",
        includeLists: true,
        metadataMaxAgeHours: 24,
      });

      expect(result.snapshotId).toBe(asSnapshotId("snap_sync_2"));
      expect(tracked.tracking.creates).toBe(2);
      expect(tracked.tracking.failed).toHaveLength(1);
      expect(tracked.tracking.completed).toHaveLength(1);
      github.assertExhausted();
    },
  );

  it("retries when a List disappears between metadata and item traversal", async () => {
    const repository = syncRepository(66);
    const star = syncStar(66, { repository });
    const list = syncUserList(66);
    const membershipPage = [[syncRepositoryItem(repository)]];
    const github = new ScriptedSyncGitHub([
      ...starTraversal([[star]], "deleted-list-1-stars"),
      ...listTraversal([[list]], "deleted-list-1-lists"),
      {
        kind: "items",
        listId: list.listId,
        cursor: null,
        page: syncPage([]),
        error: new AppError("NOT_FOUND", "List no longer exists", {
          retryable: false,
        }),
      },
      ...starTraversal([[star]], "deleted-list-2-stars"),
      ...listTraversal([[list]], "deleted-list-2-lists"),
      ...itemTraversal(list.listId, membershipPage, "deleted-list-2-items"),
      ...listTraversal([[list]], "deleted-list-2-verify-lists"),
      ...itemTraversal(
        list.listId,
        membershipPage,
        "deleted-list-2-verify-items",
      ),
      ...starTraversal([[star]], "deleted-list-2-verify-stars"),
    ]);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
    });

    const result = await fixture.service.sync({
      mode: "full",
      includeLists: true,
      metadataMaxAgeHours: 24,
    });

    expect(result.snapshotId).toBe(asSnapshotId("snap_sync_2"));
    expect(tracked.tracking.creates).toBe(2);
    expect(tracked.tracking.failed).toHaveLength(1);
    expect(tracked.tracking.completed).toHaveLength(1);
    github.assertExhausted();
  });

  it("rejects an oversized remote page, fails the owned draft, and never publishes", async () => {
    const github = new ScriptedSyncGitHub([
      {
        kind: "stars",
        cursor: null,
        page: syncPage(
          Array.from({ length: 101 }, (_, index) => syncStar(index + 1)),
        ),
      },
    ]);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
    });

    const error = await rejectedAppError(fixture.service.sync(INPUT));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: true,
      details: { reason: "invalid_page" },
    });
    expect(tracked.tracking.failed).toHaveLength(1);
    expect(tracked.tracking.completed).toEqual([]);
  });

  it("classifies every warned List page as a nonretryable capability failure even above the warning result bound", async () => {
    const repository = syncRepository(68);
    const list = syncUserList(68);
    const unsupported = Array.from({ length: 21 }, (_, index) =>
      syncUnsupportedItem("FutureItem", `opaque-${String(index)}`),
    );
    const warnings = Array.from(
      { length: 21 },
      (_, index) => `raw-list-warning-${String(index)}`,
    );
    const github = new ScriptedSyncGitHub([
      ...starTraversal(
        [[syncStar(68, { repository })]],
        "many-list-warnings-stars",
      ),
      ...listTraversal([[list]], "many-list-warnings-lists"),
      {
        kind: "items",
        listId: list.listId,
        cursor: null,
        page: syncPage(unsupported, null, { warnings }),
      },
    ]);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
    });

    const error = await rejectedAppError(
      fixture.service.sync({
        mode: "full",
        includeLists: true,
        metadataMaxAgeHours: 24,
      }),
    );

    expect(error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: false,
      details: { reason: "unexpected_list_warning" },
    });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
      "raw-list-warning",
    );
    expect(tracked.tracking.failed).toHaveLength(1);
    expect(tracked.tracking.completed).toEqual([]);
  });

  it("fails a warned Star page without exposing the remote warning", async () => {
    const github = new ScriptedSyncGitHub([
      {
        kind: "stars",
        cursor: null,
        page: syncPage([], null, {
          warnings: ["raw-star-warning-secret"],
        }),
      },
    ]);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
    });

    const error = await rejectedAppError(fixture.service.sync(INPUT));

    expect(error).toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      retryable: true,
      details: { reason: "unexpected_star_warning" },
    });
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
      "raw-star-warning-secret",
    );
    expect(tracked.tracking.failed).toHaveLength(1);
    expect(tracked.tracking.completed).toEqual([]);
  });

  it.each([
    {
      label: "unsupported union item",
      page: syncPage([syncUnsupportedItem("FutureItem", "opaque-item")]),
    },
    {
      label: "unexpected List warning",
      page: syncPage([], null, { warnings: ["remote-warning-secret"] }),
    },
  ])(
    "fails partial List coverage for $label without publishing",
    async ({ page }) => {
      const repository = syncRepository(51);
      const star = syncStar(51, { repository });
      const list = syncUserList(51);
      const github = new ScriptedSyncGitHub([
        ...starTraversal([[star]], "coverage-stars"),
        ...listTraversal([[list]], "coverage-lists"),
        {
          kind: "items",
          listId: list.listId,
          cursor: null,
          page,
        },
      ]);
      const tracked = trackedMemoryStorage();
      const fixture = serviceFixture({
        github,
        storage: tracked.storage,
      });

      const error = await rejectedAppError(
        fixture.service.sync({
          mode: "full",
          includeLists: true,
          metadataMaxAgeHours: 24,
        }),
      );

      expect(error).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        retryable: false,
      });
      expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
        "remote-warning-secret",
      );
      expect(tracked.tracking.failed).toHaveLength(1);
      expect(tracked.tracking.completed).toEqual([]);
      expect(tracked.tracking.releases).toBe(1);
    },
  );

  it("preserves a primary collection error when failSnapshot cleanup also fails", async () => {
    const repository = syncRepository(71);
    const list = syncUserList(71);
    const github = new ScriptedSyncGitHub([
      ...starTraversal(
        [[syncStar(71, { repository })]],
        "cleanup-primary-stars",
      ),
      ...listTraversal([[list]], "cleanup-primary-lists"),
      {
        kind: "items",
        listId: list.listId,
        cursor: null,
        page: syncPage([syncUnsupportedItem()]),
      },
    ]);
    const tracked = trackedMemoryStorage();
    const storage: StoragePort = {
      ...tracked.storage,
      failSnapshot() {
        throw new Error("raw-fail-cleanup-secret");
      },
    };
    const fixture = serviceFixture({ github, storage });

    const error = await rejectedAppError(
      fixture.service.sync({
        mode: "full",
        includeLists: true,
        metadataMaxAgeHours: 24,
      }),
    );

    expect(error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: false,
      details: { reason: "unsupported_list_item" },
    });
    expect(
      JSON.stringify(
        (
          error as Error & {
            cleanupDiagnostics?: readonly unknown[];
          }
        ).cleanupDiagnostics,
      ),
    ).not.toContain("raw-fail-cleanup-secret");
    expect(
      (
        error as Error & {
          cleanupDiagnostics?: readonly unknown[];
        }
      ).cleanupDiagnostics,
    ).toMatchObject([
      {
        code: "STORAGE_ERROR",
        retryable: false,
      },
    ]);
    expect(tracked.tracking.completed).toEqual([]);
    expect(tracked.tracking.releases).toBe(1);
  });

  it("validates monotonic duration before publication and fails the owned draft", async () => {
    const runtime = new (class extends ManualRuntime {
      override monotonicMs(): number {
        this.monotonicCalls += 1;
        return this.monotonicCalls === 1 ? 1_000 : 999;
      }
    })();
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      runtime,
      storage: tracked.storage,
    });

    const error = await rejectedAppError(fixture.service.sync(INPUT));

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false,
      details: { reason: "invalid_monotonic_clock" },
    });
    expect(tracked.tracking.failed).toHaveLength(1);
    expect(tracked.tracking.completed).toEqual([]);
  });

  it("fails the draft and releases the lease when the caller cancels during collection", async () => {
    let rejectPage: ((reason: unknown) => void) | undefined;
    const started = deferred<void>();
    const pending = new Promise<Page<GitHubStar>>((_, reject) => {
      rejectPage = reject;
    });
    const github = new ScriptedSyncGitHub([
      {
        kind: "stars",
        cursor: null,
        page: pending,
        onRead: () => started.resolve(undefined),
      },
    ]);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
    });
    const controller = new AbortController();

    const running = fixture.service.sync(INPUT, controller.signal);
    await started.promise;
    controller.abort("caller-secret");
    rejectPage?.(new DOMException("request aborted", "AbortError"));
    const error = await running.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(`${String(error)}`).not.toContain("caller-secret");
    expect(tracked.tracking.creates).toBe(1);
    expect(tracked.tracking.failed).toHaveLength(1);
    expect(tracked.tracking.completed).toEqual([]);
    expect(tracked.tracking.releases).toBe(1);
  });

  it("leaves the draft building and does not release after lease loss during collection", async () => {
    const page = deferred<Page<GitHubStar>>();
    const started = deferred<void>();
    const runtime = new ManualRuntime();
    const scheduler = new ManualScheduler();
    const github = new ScriptedSyncGitHub([
      {
        kind: "stars",
        cursor: null,
        page: page.promise,
        onRead: () => started.resolve(undefined),
      },
    ]);
    const tracked = trackedMemoryStorage();
    const fixture = serviceFixture({
      github,
      storage: tracked.storage,
      runtime,
      scheduler,
    });

    const running = fixture.service.sync(INPUT);
    await started.promise;
    const lease = tracked.tracking.acquired[0]!;
    runtime.advance(10 * 60_000);
    tracked.storage.acquireLease({
      name: lease.name,
      ownerId: "sync:replacement-owner",
      now: runtime.now(),
      expiresAt: "2026-07-18T00:20:00.000Z",
    });
    scheduler.tick();
    page.resolve(syncPage([]));

    await expect(running).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      retryable: true,
      details: { reason: "lease_lost" },
    });
    expect(tracked.tracking.creates).toBe(1);
    expect(tracked.tracking.failed).toEqual([]);
    expect(tracked.tracking.completed).toEqual([]);
    expect(tracked.tracking.releases).toBe(0);
  });
});
