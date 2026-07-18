import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { asPlanId } from "../../src/domain/ids.js";
import { createServices } from "../../src/server.js";
import { createMemoryStorage } from "../fixtures/memory-storage.js";
import { createScriptedGitHubAdapter } from "../support/scripted-github-adapter.js";

const CONFIG: AppConfig = Object.freeze({
  host: "github.com",
  authMode: "env",
  dataDir: "C:\\state",
  logLevel: "warning",
  readOnly: true,
  maxReadConcurrency: 4,
  writeIntervalMs: 1_000,
  maxPlanActions: 5_000,
  planTtlMinutes: 1_440,
});

describe("createServices", () => {
  it("constructs the complete registry from one verified GitHub session", async () => {
    const github = createScriptedGitHubAdapter([]).adapter;
    const sessionFactory = vi.fn(() =>
      Promise.resolve({
        github,
        credentialSource: "GITHUB_STARS_TOKEN" as const,
        binding: Object.freeze({
          host: "github.com" as const,
          login: "octocat",
          accountId: "account_1",
        }),
      }),
    );
    const services = await createServices(CONFIG, createMemoryStorage(), {
      sessionFactory,
      instanceId: "instance_test",
    });

    expect(sessionFactory).toHaveBeenCalledOnce();
    expect(Object.keys(services).sort()).toEqual(
      [
        "apply",
        "clock",
        "discover",
        "inspect",
        "listsQuery",
        "plan",
        "query",
        "rollback",
        "status",
        "sync",
      ].sort(),
    );
    expect(typeof services.status.status).toBe("function");
    expect(typeof services.apply.apply).toBe("function");
  });

  it("preserves the secure read-only default at the production boundary", async () => {
    const github = createScriptedGitHubAdapter([]).adapter;
    const services = await createServices(CONFIG, createMemoryStorage(), {
      sessionFactory: () =>
        Promise.resolve({
          github,
          credentialSource: "gh",
          binding: {
            host: "github.com",
            login: "octocat",
            accountId: "account_1",
          },
        }),
      instanceId: "instance_test",
    });

    await expect(
      services.apply.apply({
        planId: asPlanId("plan_missing"),
        expectedHash: "0".repeat(64),
        failureMode: "stop",
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "read_only" },
    });
  });
});
