import { describe, expect, it, vi } from "vitest";
import type {
  GitHubDiscoveryReadPort,
  GitHubSearchInput,
  GitHubSearchPage,
} from "../../../src/app/ports/github-port.js";
import type { EvidenceReader } from "../../../src/app/services/query-service.js";
import {
  DiscoveryService,
  buildSearchQuery,
  parseDiscoveryCursor,
  validateDiscoveryBounds,
  type DiscoveryInput,
  type DiscoveryStoragePort,
} from "../../../src/app/services/discovery-service.js";
import type { EvidenceRecord } from "../../../src/app/services/evidence-service.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import {
  asRepositoryDatabaseId,
  asRepositoryId,
  asSnapshotId,
  type RepositoryId,
  type SnapshotId,
} from "../../../src/domain/ids.js";
import {
  repositorySchema,
  type AccountBinding,
  type Repository,
} from "../../../src/domain/repository.js";
import { parseSnapshot, type Snapshot } from "../../../src/domain/snapshot.js";

const binding = Object.freeze({
  host: "github.com",
  login: "octocat",
  accountId: "U_account",
}) satisfies AccountBinding;

function repository(suffix: string): Repository {
  return repositorySchema.parse({
    repositoryId: asRepositoryId(`R_${suffix}`),
    repositoryDatabaseId: asRepositoryDatabaseId(
      String(1_000 + Number(suffix)),
    ),
    owner: "acme",
    name: `tool-${suffix}`,
    fullName: `acme/tool-${suffix}`,
    description: `description ${suffix}`,
    url: `https://github.com/acme/tool-${suffix}`,
    stargazerCount: 100 + Number(suffix),
    isFork: false,
    isArchived: false,
    isDisabled: false,
    isPrivate: false,
    visibility: "public",
    primaryLanguage: "TypeScript",
    topics: ["mcp"],
    licenseSpdxId: "MIT",
    pushedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return parseSnapshot({
    id: overrides.id ?? asSnapshotId("snap_1"),
    binding: overrides.binding ?? binding,
    mode: overrides.mode ?? "full",
    listCoverage: overrides.listCoverage ?? "complete",
    startedAt: overrides.startedAt ?? "2026-07-17T00:00:00.000Z",
    status: overrides.status ?? "complete",
    completedAt:
      overrides.completedAt === undefined
        ? "2026-07-17T00:01:00.000Z"
        : overrides.completedAt,
    failedAt: overrides.failedAt ?? null,
    counts: overrides.counts ?? {
      repositories: 2,
      stars: 2,
      lists: 0,
      memberships: 0,
    },
    warningCount: overrides.warningCount ?? 0,
    sourceRateLimit: overrides.sourceRateLimit ?? null,
  });
}

function baseInput(overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    query: "mcp",
    qualifiers: {},
    sort: "stars",
    order: "desc",
    limit: 50,
    cursor: null,
    evidence: "none",
    evidenceLimit: 0,
    ...overrides,
  };
}

function github(page: Partial<GitHubSearchPage> = {}) {
  const searchRepositories = vi.fn(
    (
      input: GitHubSearchInput,
      signal?: AbortSignal,
    ): Promise<GitHubSearchPage> => {
      void input;
      void signal;
      return Promise.resolve(
        Object.freeze({
          items:
            page.items ?? Object.freeze([repository("1"), repository("2")]),
          totalCount: page.totalCount ?? 5_432,
          incompleteResults: page.incompleteResults ?? true,
          nextPage: page.nextPage === undefined ? 2 : page.nextPage,
          rateLimit: page.rateLimit ?? null,
        }),
      );
    },
  );
  return {
    port: { searchRepositories } satisfies GitHubDiscoveryReadPort,
    searchRepositories,
  };
}

function storage(
  options: { latest?: unknown; starred?: readonly string[] } = {},
) {
  const getLatestCompleteSnapshot = vi.fn(() =>
    options.latest === undefined ? snapshot() : options.latest,
  );
  const hasStar = vi.fn((_snapshotId: SnapshotId, repositoryId: RepositoryId) =>
    (options.starred ?? []).includes(repositoryId),
  );
  const saveDiscoveredCandidate = vi.fn();
  return {
    port: {
      getLatestCompleteSnapshot,
      hasStar,
      saveDiscoveredCandidate,
    } as DiscoveryStoragePort,
    getLatestCompleteSnapshot,
    hasStar,
    saveDiscoveredCandidate,
  };
}

function evidence(records: readonly EvidenceRecord[] = []) {
  const fetch = vi.fn(
    (
      repositories: readonly Repository[],
      mode: "summary" | "readme",
      signal?: AbortSignal,
    ): Promise<readonly EvidenceRecord[]> => {
      void repositories;
      void mode;
      void signal;
      return Promise.resolve(records);
    },
  );
  return {
    port: { fetch } satisfies EvidenceReader,
    fetch,
  };
}

async function expectCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await action().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AppError);
  expect(serializeError(error).code).toBe(code);
}

describe("Search query grammar", () => {
  it("emits closed qualifiers in fixed order with sorted topics and one quoted language", () => {
    expect(
      buildSearchQuery("agent framework", {
        fork: false,
        topic: ["zeta", "alpha"],
        pushed: ">=2025-01-01",
        language: "Vim Script",
        archived: false,
        stars: "100..10000",
        org: "openai",
      }),
    ).toBe(
      'agent framework language:"Vim Script" topic:alpha topic:zeta org:openai stars:100..10000 pushed:>=2025-01-01 archived:false fork:false',
    );
  });

  it.each([
    ["plain integer", "0"],
    ["comparison", ">=10000"],
    ["closed range", "1..9999"],
  ])("accepts stars %s", (_label, stars) => {
    expect(buildSearchQuery("mcp", { stars })).toBe(`mcp stars:${stars}`);
  });

  it.each([
    ["plain date", "2026-07-17"],
    ["comparison", "<2026-07-17"],
    ["closed range", "2025-01-01..2026-07-17"],
  ])("accepts pushed %s", (_label, pushed) => {
    expect(buildSearchQuery("mcp", { pushed })).toBe(`mcp pushed:${pushed}`);
  });

  it.each([
    ["language", "mcp -language:javascript"],
    ["organization", "mcp -org:openai"],
    ["topic at the start", "-topic:agents mcp"],
    ["user", "mcp -user:octocat"],
    ["stars", "mcp -stars:100"],
    ["pushed", "mcp -pushed:>=2026-01-01"],
    ["archived", "mcp -archived:true"],
    ["fork", "mcp -fork:true"],
    ["sort", "mcp -sort:stars"],
  ])("rejects negated %s qualifier injection", (_label, query) => {
    expect(() => buildSearchQuery(query, {})).toThrowError(AppError);
  });

  it.each(["state-of-the-art mcp", "mcp -javascript", "release-2026 -1"])(
    "accepts ordinary hyphenated or minus text: %s",
    (query) => {
      expect(buildSearchQuery(query, {})).toBe(query);
    },
  );

  it.each([
    ["empty query", "", {}],
    ["trimmed query", " mcp", {}],
    ["control query", "mcp\u0000", {}],
    ["malformed Unicode", "mcp\uD800", {}],
    ["raw quote", 'mcp "agent"', {}],
    ["raw slash", "mcp\\agent", {}],
    ["qualifier injection", "mcp sort:stars", {}],
    ["six Boolean operators", "a AND b OR c NOT d AND e OR f NOT g", {}],
    ["unknown qualifier", "mcp", { sort: "stars" }],
    ["conflicting owner scopes", "mcp", { user: "octocat", org: "openai" }],
    ["bad login", "mcp", { user: "-octocat" }],
    ["bad topic case", "mcp", { topic: ["AI"] }],
    ["duplicate topic", "mcp", { topic: ["mcp", "mcp"] }],
    ["sparse topic", "mcp", { topic: Object.assign([], { 1: "mcp" }) }],
    ["bad stars", "mcp", { stars: "1 OR archived:false" }],
    ["descending stars range", "mcp", { stars: "10..1" }],
    ["unsafe stars", "mcp", { stars: "9007199254740992" }],
    ["bad date", "mcp", { pushed: "2026-02-30" }],
    ["descending date range", "mcp", { pushed: "2026-01-02..2026-01-01" }],
    ["quoted language", "mcp", { language: 'Type"Script' }],
    ["slash language", "mcp", { language: "Type\\Script" }],
  ])("rejects %s", (_label, query, qualifiers) => {
    expect(() => buildSearchQuery(query, qualifiers as never)).toThrowError(
      AppError,
    );
  });

  it("enforces the final 256-character bound after qualifiers", () => {
    expect(() =>
      buildSearchQuery("x".repeat(250), { language: "TypeScript" }),
    ).toThrow(/256/u);
  });

  it.each([
    [1, 1_000],
    [50, 20],
    [100, 10],
  ])(
    "accepts only offsets inside the 1,000 cap for limit %s",
    (limit, last) => {
      expect(() =>
        validateDiscoveryBounds({ limit, page: last }),
      ).not.toThrow();
      expect(() =>
        validateDiscoveryBounds({ limit, page: last + 1 }),
      ).toThrowError(AppError);
    },
  );

  it.each([
    [null, 1],
    ["1", 1],
    ["20", 20],
  ])("parses canonical cursor %s", (cursor, expected) => {
    expect(parseDiscoveryCursor(cursor)).toBe(expected);
  });

  it.each(["", "0", "01", "-1", "1.5", "9007199254740992"])(
    "rejects cursor %s",
    (cursor) => {
      expect(() => parseDiscoveryCursor(cursor)).toThrowError(AppError);
    },
  );
});

describe("DiscoveryService", () => {
  it("persists every discovered repository for later planning", async () => {
    const remote = github();
    const local = storage();
    const service = new DiscoveryService(
      remote.port,
      local.port,
      binding,
      evidence().port,
    );

    await service.discover(baseInput());

    expect(local.saveDiscoveredCandidate).toHaveBeenCalledTimes(2);
    expect(local.saveDiscoveredCandidate.mock.calls[0]?.[0]).toMatchObject({
      binding,
      repository: repository("1"),
      query: "mcp",
    });
  });

  it("searches once, marks current Stars, preserves cap flags, and freezes output", async () => {
    const remote = github();
    const local = storage({ starred: ["R_2"] });
    const enrichment = evidence();
    const signal = new AbortController().signal;
    const service = new DiscoveryService(
      remote.port,
      local.port,
      binding,
      enrichment.port,
    );

    const result = await service.discover(
      baseInput({
        qualifiers: {
          language: "TypeScript",
          topic: ["ai-agent"],
        },
      }),
      signal,
    );

    expect(remote.searchRepositories).toHaveBeenCalledWith(
      {
        query: "mcp language:TypeScript topic:ai-agent",
        sort: "stars",
        order: "desc",
        page: 1,
        perPage: 50,
      },
      signal,
    );
    expect(local.getLatestCompleteSnapshot).toHaveBeenCalledWith(binding);
    expect(local.hasStar.mock.calls).toEqual([
      ["snap_1", "R_1"],
      ["snap_1", "R_2"],
    ]);
    expect(result).toMatchObject({
      reportedTotal: 5_432,
      cappedTotal: 1_000,
      incompleteResults: true,
      nextCursor: "2",
      evidence: [],
    });
    expect(result.items.map((item) => item.alreadyStarred)).toEqual([
      false,
      true,
    ]);
    expect(enrichment.fetch).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.every(Object.isFrozen)).toBe(true);
  });

  it.each(["summary", "readme"] as const)(
    "enriches only the requested prefix in %s mode and passes the exact signal",
    async (mode) => {
      const repositories = [repository("1"), repository("2"), repository("3")];
      const remote = github({ items: repositories });
      const local = storage();
      const records = Object.freeze([
        Object.freeze({
          repositoryId: asRepositoryId("R_1"),
          kind: "untrusted_external_text" as const,
          text: "evidence",
          sourceUrl: repositories[0]!.url,
          sha: null,
          byteLength: 8,
          truncated: false,
          missing: false,
        }),
      ]);
      const enrichment = evidence(records);
      const signal = new AbortController().signal;

      const result = await new DiscoveryService(
        remote.port,
        local.port,
        binding,
        enrichment.port,
      ).discover(baseInput({ evidence: mode, evidenceLimit: 1 }), signal);

      expect(enrichment.fetch).toHaveBeenCalledWith(
        repositories.slice(0, 1),
        mode,
        signal,
      );
      expect(result.evidence).toEqual(records);
    },
  );

  it.each([
    ["missing", null],
    [
      "cross binding",
      snapshot({ binding: { ...binding, accountId: "U_other" } }),
    ],
    [
      "non-complete",
      snapshot({
        status: "building",
        completedAt: null,
        listCoverage: "collecting",
      }),
    ],
    ["malformed", { status: "complete" }],
  ])(
    "ignores a %s latest snapshot instead of marking Stars",
    async (_label, latest) => {
      const remote = github();
      const local = storage({ latest });
      const result = await new DiscoveryService(
        remote.port,
        local.port,
        binding,
        evidence().port,
      ).discover(baseInput());

      expect(result.items.every((item) => !item.alreadyStarred)).toBe(true);
      expect(local.hasStar).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unknown field", { authorization: "never" }],
    ["limit zero", { limit: 0 }],
    ["limit too large", { limit: 101 }],
    ["invalid cursor", { cursor: "01" }],
    ["past cap", { cursor: "21", limit: 50 }],
    ["invalid evidence", { evidence: "html" }],
    ["negative evidence limit", { evidenceLimit: -1 }],
    ["large evidence limit", { evidenceLimit: 21 }],
    ["none with evidence", { evidenceLimit: 1 }],
  ])("rejects %s before any I/O", async (_label, patch) => {
    const remote = github();
    const local = storage();
    const enrichment = evidence();
    const service = new DiscoveryService(
      remote.port,
      local.port,
      binding,
      enrichment.port,
    );

    await expectCode(
      () =>
        service.discover({
          ...baseInput(),
          ...patch,
        } as DiscoveryInput),
      "VALIDATION_ERROR",
    );
    expect(remote.searchRepositories).not.toHaveBeenCalled();
    expect(local.getLatestCompleteSnapshot).not.toHaveBeenCalled();
    expect(enrichment.fetch).not.toHaveBeenCalled();
  });

  it("has no mutation dependency and never calls mutation-shaped injected properties", async () => {
    const star = vi.fn(() => Promise.reject(new Error("must not run")));
    const remote = {
      ...github().port,
      star,
      unstar: star,
      mutate: star,
    };
    const local = storage();

    await new DiscoveryService(
      remote,
      local.port,
      binding,
      evidence().port,
    ).discover(baseInput());

    expect(star).not.toHaveBeenCalled();
  });
});
