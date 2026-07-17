import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  GitHubCapabilities,
  GitHubStatusReadPort,
  RateLimitState,
} from "../../../src/app/ports/github-port.js";
import type { RateStateReader } from "../../../src/app/ports/rate-state-reader.js";
import type {
  IncompleteRunSummaries,
  StoragePort,
} from "../../../src/app/ports/storage-port.js";
import {
  StatusService,
  type StatusInput,
  type StatusResult,
} from "../../../src/app/services/status-service.js";
import type { CredentialSource } from "../../../src/auth/credential-provider.js";
import { AppError } from "../../../src/domain/errors.js";
import { asPlanId, asRunId, asSnapshotId } from "../../../src/domain/ids.js";
import type { AccountBinding } from "../../../src/domain/repository.js";
import { parseSnapshot } from "../../../src/domain/snapshot.js";
import { RateGate } from "../../../src/github/rate-gate.js";
import { PACKAGE_VERSION } from "../../../src/version.js";
import { createMemoryStorage } from "../../fixtures/memory-storage.js";

const BINDING: AccountBinding = {
  host: "github.com",
  login: "octocat",
  accountId: "U_1",
};

const CAPABILITIES: GitHubCapabilities = {
  starRead: "available",
  starWrite: "unknown",
  listRead: "available",
  listWrite: "unknown",
};

function githubFixture(
  input: {
    readonly viewer?: () => AccountBinding | Promise<AccountBinding>;
    readonly probe?: () => GitHubCapabilities | Promise<GitHubCapabilities>;
  } = {},
) {
  const getViewer = vi.fn(
    async (): Promise<AccountBinding> =>
      await (input.viewer?.() ?? Promise.resolve({ ...BINDING })),
  );
  const probeCapabilities = vi.fn(
    async (): Promise<GitHubCapabilities> =>
      await (input.probe?.() ?? Promise.resolve({ ...CAPABILITIES })),
  );
  const github: GitHubStatusReadPort = {
    getViewer,
    probeCapabilities,
  };
  return { github, getViewer, probeCapabilities };
}

function storageFixture(
  input: {
    readonly latest?: ReturnType<typeof parseSnapshot> | null;
    readonly incomplete?: IncompleteRunSummaries;
  } = {},
) {
  const base = createMemoryStorage();
  base.migrate();
  const getLatestCompleteSnapshot = vi.fn(() => input.latest ?? null);
  const getSchemaVersion = vi.fn(() => 1);
  const getIncompleteRunSummaries = vi.fn(
    () =>
      input.incomplete ?? {
        items: [],
        total: 0,
        truncated: false,
      },
  );
  const storage: StoragePort = {
    ...base,
    getLatestCompleteSnapshot,
    getSchemaVersion,
    getIncompleteRunSummaries,
  };
  return {
    storage,
    getLatestCompleteSnapshot,
    getSchemaVersion,
    getIncompleteRunSummaries,
  };
}

function rateFixture(state: RateLimitState | null = null) {
  const getState = vi.fn(() => state);
  const rateStateReader: RateStateReader = { getState };
  return { rateStateReader, getState };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
    reject(reason: unknown): void {
      reject?.(reason);
    },
  };
}

describe("StatusService", () => {
  it("locks the public status and rate-reader contracts", () => {
    expectTypeOf<StatusInput>().toEqualTypeOf<
      Readonly<{ refreshCapabilities?: boolean }>
    >();
    expectTypeOf<StatusResult>().toEqualTypeOf<
      Readonly<{
        serverVersion: string;
        host: "github.com";
        login: string;
        credentialSource: CredentialSource;
        capabilities: GitHubCapabilities;
        databaseSchemaVersion: number;
        latestCompleteSnapshot: ReturnType<typeof parseSnapshot> | null;
        incompleteRuns: IncompleteRunSummaries;
        rateLimit: RateLimitState | null;
      }>
    >();
    expectTypeOf<RateGate>().toMatchTypeOf<RateStateReader>();
  });

  it("verifies identity and returns bounded detached frozen local status", async () => {
    const latest = parseSnapshot({
      id: asSnapshotId("snap_status"),
      binding: BINDING,
      mode: "full",
      listCoverage: "complete",
      startedAt: "2026-07-18T00:00:00Z",
      status: "complete",
      completedAt: "2026-07-18T00:01:00Z",
      failedAt: null,
      counts: { repositories: 1, stars: 1, lists: 1, memberships: 1 },
      warningCount: 0,
      sourceRateLimit: null,
    });
    const incomplete: IncompleteRunSummaries = {
      items: [
        {
          runId: asRunId("run_status"),
          planId: asPlanId("plan_status"),
          state: "partial",
          startedAt: "2026-07-18T00:02:00.000Z",
          finishedAt: null,
          counts: {
            pending: 0,
            running: 0,
            succeeded: 1,
            skipped: 0,
            failed: 1,
            unresolved: 0,
          },
        },
      ],
      total: 25,
      truncated: true,
    };
    const github = githubFixture();
    const storage = storageFixture({ latest, incomplete });
    const rate = rateFixture({
      remaining: 4_999,
      resetAt: "2026-07-18T01:00:00Z",
    });
    const service = new StatusService(
      github.github,
      storage.storage,
      "gh",
      rate.rateStateReader,
    );

    const result = await service.status();

    expect(result).toMatchObject({
      serverVersion: PACKAGE_VERSION,
      host: "github.com",
      login: "octocat",
      credentialSource: "gh",
      capabilities: CAPABILITIES,
      databaseSchemaVersion: 1,
      latestCompleteSnapshot: latest,
      incompleteRuns: incomplete,
      rateLimit: {
        remaining: 4_999,
        resetAt: "2026-07-18T01:00:00.000Z",
      },
    });
    expect(Object.hasOwn(result, "accountId")).toBe(false);
    expect(storage.getLatestCompleteSnapshot).toHaveBeenCalledWith(BINDING);
    expect(storage.getIncompleteRunSummaries).toHaveBeenCalledWith({
      binding: BINDING,
      limit: 20,
    });
    expect(storage.getSchemaVersion).toHaveBeenCalledTimes(1);
    expect(rate.getState).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(Object.isFrozen(result.latestCompleteSnapshot)).toBe(true);
    expect(Object.isFrozen(result.incompleteRuns)).toBe(true);
    expect(Object.isFrozen(result.incompleteRuns.items)).toBe(true);
    expect(Object.isFrozen(result.incompleteRuns.items[0]?.counts)).toBe(true);
    expect(Object.isFrozen(result.rateLimit)).toBe(true);
    expect(result.capabilities).not.toBe(CAPABILITIES);
    expect(result.latestCompleteSnapshot).not.toBe(latest);
    expect(result.incompleteRuns).not.toBe(incomplete);
  });

  it("forwards the exact signal to the verified identity and actual probe", async () => {
    const signals: AbortSignal[] = [];
    const github: GitHubStatusReadPort = {
      getViewer(signal) {
        if (signal !== undefined) signals.push(signal);
        return Promise.resolve(BINDING);
      },
      probeCapabilities(signal) {
        if (signal !== undefined) signals.push(signal);
        return Promise.resolve(CAPABILITIES);
      },
    };
    const service = new StatusService(
      github,
      storageFixture().storage,
      "gh",
      rateFixture().rateStateReader,
    );
    const controller = new AbortController();

    await service.status(undefined, controller.signal);

    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("verifies identity on every call while caching successful capabilities by binding", async () => {
    const github = githubFixture();
    const storage = storageFixture();
    const service = new StatusService(
      github.github,
      storage.storage,
      "GITHUB_TOKEN",
      rateFixture().rateStateReader,
    );

    await service.status();
    await service.status();
    await service.status({ refreshCapabilities: true });
    await service.status();

    expect(github.getViewer).toHaveBeenCalledTimes(4);
    expect(github.probeCapabilities).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe for concurrent misses of the same verified binding", async () => {
    const probe = deferred<GitHubCapabilities>();
    const github = githubFixture({ probe: () => probe.promise });
    const service = new StatusService(
      github.github,
      storageFixture().storage,
      "GH_TOKEN",
      rateFixture().rateStateReader,
    );

    const first = service.status();
    const second = service.status();
    await vi.waitFor(() => {
      expect(github.getViewer).toHaveBeenCalledTimes(2);
      expect(github.probeCapabilities).toHaveBeenCalledTimes(1);
    });
    probe.resolve({ ...CAPABILITIES });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(github.probeCapabilities).toHaveBeenCalledTimes(1);
  });

  it("isolates capability caches by host and account ID, not login", async () => {
    const viewers = [
      { ...BINDING, login: "same", accountId: "U_1" },
      { ...BINDING, login: "same", accountId: "U_2" },
      { ...BINDING, login: "renamed", accountId: "U_1" },
    ];
    const github = githubFixture({
      viewer: () => Promise.resolve(viewers.shift() ?? BINDING),
    });
    const service = new StatusService(
      github.github,
      storageFixture().storage,
      "GITHUB_STARS_TOKEN",
      rateFixture().rateStateReader,
    );

    await service.status();
    await service.status();
    await service.status();

    expect(github.probeCapabilities).toHaveBeenCalledTimes(2);
  });

  it("evicts rejected probes so a later call can retry", async () => {
    const probe = vi
      .fn<() => Promise<GitHubCapabilities>>()
      .mockRejectedValueOnce(
        new AppError("GITHUB_UNAVAILABLE", "bounded failure", {
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({ ...CAPABILITIES });
    const github = githubFixture({ probe });
    const service = new StatusService(
      github.github,
      storageFixture().storage,
      "gh",
      rateFixture().rateStateReader,
    );

    await expect(service.status()).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
    await expect(service.status()).resolves.toMatchObject({
      capabilities: CAPABILITIES,
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not let an in-flight probe for one account satisfy another account", async () => {
    const firstProbe = deferred<GitHubCapabilities>();
    const secondProbe = deferred<GitHubCapabilities>();
    const viewers = [
      { ...BINDING, accountId: "U_1" },
      { ...BINDING, accountId: "U_2" },
    ];
    const probe = vi
      .fn<() => Promise<GitHubCapabilities>>()
      .mockReturnValueOnce(firstProbe.promise)
      .mockReturnValueOnce(secondProbe.promise);
    const github = githubFixture({
      viewer: () => Promise.resolve(viewers.shift() ?? BINDING),
      probe,
    });
    const service = new StatusService(
      github.github,
      storageFixture().storage,
      "gh",
      rateFixture().rateStateReader,
    );

    const first = service.status();
    const second = service.status();
    await vi.waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(2);
    });
    firstProbe.resolve({
      ...CAPABILITIES,
      listRead: "unavailable",
      listWrite: "unavailable",
    });
    secondProbe.resolve(CAPABILITIES);

    await expect(first).resolves.toMatchObject({
      capabilities: { listRead: "unavailable" },
    });
    await expect(second).resolves.toMatchObject({
      capabilities: { listRead: "available" },
    });
  });

  it.each([
    [null],
    [{ refreshCapabilities: "yes" }],
    [{ refreshCapabilities: false, raw: "secret" }],
  ])(
    "rejects malformed status input before identity or storage access",
    async (input) => {
      const github = githubFixture();
      const storage = storageFixture();
      const service = new StatusService(
        github.github,
        storage.storage,
        "gh",
        rateFixture().rateStateReader,
      );

      await expect(
        service.status(input as unknown as StatusInput),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
      expect(github.getViewer).not.toHaveBeenCalled();
      expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
    },
  );

  it("rejects accessor status input without invoking it or calling collaborators", async () => {
    let touched = false;
    const input = {};
    Object.defineProperty(input, "refreshCapabilities", {
      enumerable: true,
      get() {
        touched = true;
        return true;
      },
    });
    const github = githubFixture();
    const storage = storageFixture();
    const service = new StatusService(
      github.github,
      storage.storage,
      "gh",
      rateFixture().rateStateReader,
    );

    await expect(service.status(input as StatusInput)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(touched).toBe(false);
    expect(github.getViewer).not.toHaveBeenCalled();
    expect(storage.getLatestCompleteSnapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed rate state and oversized incomplete summaries without leaking values", async () => {
    const malformedRate = new StatusService(
      githubFixture().github,
      storageFixture().storage,
      "gh",
      rateFixture({
        remaining: -1,
        resetAt: "raw-rate-secret",
      }).rateStateReader,
    );
    await expect(malformedRate.status()).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { source: "rate_state" },
    });

    const oversized = {
      items: Array.from({ length: 21 }, (_, index) => ({
        runId: asRunId(`run_${index}`),
        planId: asPlanId(`plan_${index}`),
        state: "partial" as const,
        startedAt: "2026-07-18T00:00:00.000Z",
        finishedAt: null,
        counts: {
          pending: 0,
          running: 0,
          succeeded: 0,
          skipped: 0,
          failed: 0,
          unresolved: 1,
        },
      })),
      total: 21,
      truncated: false,
    };
    const malformedRuns = new StatusService(
      githubFixture().github,
      storageFixture({ incomplete: oversized }).storage,
      "gh",
      rateFixture().rateStateReader,
    );
    await expect(malformedRuns.status()).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      details: { source: "storage" },
    });
  });
});
