import { describe, expect, it } from "vitest";
import { loadLiveContractConfig } from "../fixtures/live-contract.js";

const VALID_ENV = Object.freeze({
  GITHUB_STARS_MCP_LIVE: "1",
  GITHUB_STARS_MCP_LIVE_CONFIRM: "DELETE_TEST_DATA",
  GITHUB_STARS_MCP_LIVE_LOGIN: "fixture-user",
  GITHUB_STARS_MCP_LIVE_REPOSITORY:
    "fixture-user/github-stars-mcp-fixture-contract-1",
});

function capturedError(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw");
}

function expectInvalid(callback: () => unknown): void {
  expect(capturedError(callback)).toMatchObject({
    code: "VALIDATION_ERROR",
    retryable: false,
  });
}

describe("disposable-account live contract guard", () => {
  it.each(Object.keys(VALID_ENV))("rejects a missing %s guard", (guard) => {
    const env = { ...VALID_ENV };
    delete env[guard as keyof typeof env];

    expectInvalid(() => loadLiveContractConfig(env));
  });

  it.each([
    ["GITHUB_STARS_MCP_LIVE", "true"],
    ["GITHUB_STARS_MCP_LIVE_CONFIRM", "delete_test_data"],
    ["GITHUB_STARS_MCP_LIVE_LOGIN", "fixture-user "],
    [
      "GITHUB_STARS_MCP_LIVE_REPOSITORY",
      "fixture-user/github-stars-mcp-fixture-",
    ],
    [
      "GITHUB_STARS_MCP_LIVE_REPOSITORY",
      "other/github-stars-mcp-fixture-contract-1",
    ],
    [
      "GITHUB_STARS_MCP_LIVE_REPOSITORY",
      "fixture-user/not-the-fixture-contract-1",
    ],
  ])("rejects invalid %s", (guard, value) => {
    expectInvalid(() =>
      loadLiveContractConfig({ ...VALID_ENV, [guard]: value }),
    );
  });

  it.each([
    "",
    "-fixture",
    "fixture-",
    "fixture_user",
    "a".repeat(40),
    "Fixture/User",
  ])("rejects invalid login %j", (login) => {
    expectInvalid(() =>
      loadLiveContractConfig({
        ...VALID_ENV,
        GITHUB_STARS_MCP_LIVE_LOGIN: login,
        GITHUB_STARS_MCP_LIVE_REPOSITORY: `${login}/github-stars-mcp-fixture-contract-1`,
      }),
    );
  });

  it("returns one frozen, minimal configuration with a fixed report path", () => {
    const result = loadLiveContractConfig(VALID_ENV);

    expect(result).toEqual({
      login: "fixture-user",
      repository: "fixture-user/github-stars-mcp-fixture-contract-1",
      reportPath: "artifacts/live-contract.json",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/token|authorization/iu);
  });
});
