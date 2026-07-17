import { describe, expect, test } from "vitest";
import { loadConfig } from "../../../src/config.js";
import {
  APP_ERROR_CODES,
  AppError,
  serializeError,
} from "../../../src/domain/errors.js";
import type { JsonValue } from "../../../src/domain/json.js";
import { redactSecrets } from "../../../src/domain/redaction.js";

const EXPECTED_ERROR_CODES = [
  "AUTH_REQUIRED",
  "INSUFFICIENT_PERMISSION",
  "CAPABILITY_UNAVAILABLE",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "RATE_LIMITED",
  "SECONDARY_RATE_LIMITED",
  "GITHUB_UNAVAILABLE",
  "STALE_SNAPSHOT",
  "PLAN_EXPIRED",
  "PLAN_HASH_MISMATCH",
  "PLAN_ACCOUNT_MISMATCH",
  "PLAN_TOO_LARGE",
  "PRECONDITION_FAILED",
  "PARTIAL_FAILURE",
  "RECONCILIATION_REQUIRED",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
] as const;

describe("domain errors and redaction", () => {
  test("exposes the exact stable error-code contract", () => {
    expect(APP_ERROR_CODES).toEqual(EXPECTED_ERROR_CODES);
    expect(APP_ERROR_CODES).toHaveLength(18);
  });

  test("freezes exported codes and rejects caller-injected error codes", () => {
    const unsafeCode = "CALLER_DEFINED_ERROR";
    const mutableCodes = APP_ERROR_CODES as unknown as string[];
    let expanded = false;
    try {
      mutableCodes.push(unsafeCode);
      expanded = true;
    } catch {
      // A frozen public contract rejects the unsafe mutation.
    }

    const error = new AppError("AUTH_REQUIRED", "safe message");
    Object.defineProperty(error, "code", { value: unsafeCode });
    const serialized = serializeError(error);
    if (expanded) mutableCodes.pop();

    expect(Object.isFrozen(APP_ERROR_CODES)).toBe(true);
    expect(serialized.code).toBe("INTERNAL_ERROR");
  });

  test("stores AppError metadata and serializes only its safe public fields", () => {
    const arbitrarySecret = "not-pattern-matched-secret-value";
    const cause = new Error(arbitrarySecret);
    const error = new AppError(
      "AUTH_REQUIRED",
      `credential ${arbitrarySecret} was rejected`,
      {
        retryable: true,
        details: { attempt: 2 },
        secrets: [arbitrarySecret],
        cause,
      },
    );

    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ attempt: 2 });
    expect(error.secrets).toEqual([arbitrarySecret]);
    expect(Object.getOwnPropertyDescriptor(error, "secrets")).toMatchObject({
      configurable: false,
      writable: false,
    });
    expect(error.cause).toBe(cause);

    const serialized = serializeError(error);
    expect(serialized).toEqual({
      code: "AUTH_REQUIRED",
      message: "credential [REDACTED] was rejected",
      retryable: true,
      details: { attempt: 2 },
    });
    expect(serialized).not.toHaveProperty("cause");
    expect(serialized).not.toHaveProperty("stack");
  });

  test("makes direct AppError JSON serialization use the redacted public shape", () => {
    const arbitrarySecret = "direct-json-secret";
    const error = new AppError(
      "AUTH_REQUIRED",
      `bad credential ${arbitrarySecret}`,
      {
        details: {
          authorization: `Bearer ${arbitrarySecret}`,
          subprocess: { stdout: arbitrarySecret },
        },
        secrets: [arbitrarySecret],
        cause: new Error(arbitrarySecret),
      },
    );

    const json = JSON.stringify(error);

    expect(json).not.toContain(arbitrarySecret);
    expect(JSON.parse(json) as unknown).toEqual(serializeError(error));
    expect(Object.getOwnPropertyDescriptor(error, "secrets")).toMatchObject({
      enumerable: false,
    });
  });

  test("recursively redacts registered secrets and secret-bearing fields without invoking getters", () => {
    const arbitrarySecret = "a7$unpatterned/credential?value";
    let getterCalls = 0;
    const nested: Record<string, unknown> = {
      stdout: `command output: ${arbitrarySecret}`,
      safe: "visible",
    };
    Object.defineProperty(nested, "unsafe", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("unsafe getter invoked");
      },
    });
    const details = {
      authorization: `Bearer ${arbitrarySecret}`,
      ToKeN: "token field value",
      ACCESS_TOKEN: "access token field value",
      Password: "password field value",
      COOKIE: "cookie field value",
      nested: [nested, { cause: { message: arbitrarySecret } }],
      [`field-${arbitrarySecret}`]: "key-secret",
    } as unknown as JsonValue;
    const hostileCause = Object.defineProperty({}, "message", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("cause getter invoked");
      },
    });
    const error = new AppError(
      "AUTH_REQUIRED",
      `bad ${arbitrarySecret}/${arbitrarySecret}`,
      {
        details,
        secrets: ["", arbitrarySecret],
        cause: hostileCause,
      },
    );

    const serialized = serializeError(error);
    const json = JSON.stringify(serialized);

    expect(getterCalls).toBe(0);
    expect(json).not.toContain(arbitrarySecret);
    expect(serialized.message).toBe("bad [REDACTED]/[REDACTED]");
    expect(serialized.details).toMatchObject({
      authorization: "[REDACTED]",
      ToKeN: "[REDACTED]",
      ACCESS_TOKEN: "[REDACTED]",
      Password: "[REDACTED]",
      COOKIE: "[REDACTED]",
      nested: [
        {
          stdout: "command output: [REDACTED]",
          safe: "visible",
        },
        { cause: { message: "[REDACTED]" } },
      ],
      "field-[REDACTED]": "key-secret",
    });
    expect(serialized.details).not.toHaveProperty("cause");
  });

  test("bounds recursive traversal, handles cycles, and stringifies unsupported values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deepest: Record<string, unknown> = cyclic;
    for (let depth = 0; depth < 25; depth += 1) {
      const next: Record<string, unknown> = {};
      deepest.next = next;
      deepest = next;
    }
    deepest.value = "deep-secret";

    const result = redactSecrets(
      {
        cyclic,
        bigint: 42n,
        missing: undefined,
        nonFinite: Number.POSITIVE_INFINITY,
      },
      ["deep-secret"],
    );
    const json = JSON.stringify(result);

    expect(json).not.toContain("deep-secret");
    expect(json).toContain("[Circular]");
    expect(json).toContain("[Truncated]");
    expect(result).toMatchObject({
      bigint: "42",
      missing: "undefined",
      nonFinite: "Infinity",
    });
  });

  test("returns dense JSON-safe arrays without invoking sparse or accessor indices", () => {
    const hiddenSecret = "hidden-array-secret";
    let getterCalls = 0;
    const hostileArray: unknown[] = ["visible"];
    Object.defineProperty(hostileArray, "1", {
      configurable: true,
      enumerable: false,
      value: hiddenSecret,
    });
    Object.defineProperty(hostileArray, "2", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return hiddenSecret;
      },
    });
    hostileArray.length = 4;

    const redacted = redactSecrets(hostileArray);

    expect(Array.isArray(redacted)).toBe(true);
    if (!Array.isArray(redacted)) {
      throw new TypeError("redacted array must remain an array");
    }
    expect(redacted).toEqual([
      "visible",
      "[Unsupported array item]",
      "[Unsupported array item]",
      "[Unsupported array item]",
    ]);
    expect(
      Array.from({ length: 4 }, (_, index) => Object.hasOwn(redacted, index)),
    ).toEqual([true, true, true, true]);
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(redacted)).not.toContain(hiddenSecret);
  });

  test("fails closed when a registered-secret list cannot be inspected", () => {
    const arbitrarySecret = "credential-secret";
    const hostileSecrets = new Proxy([arbitrarySecret], {
      ownKeys: () => {
        throw new Error("secret registry inspection failed");
      },
    });

    expect(redactSecrets(`leaked ${arbitrarySecret}`, hostileSecrets)).toBe(
      "[REDACTED]",
    );
  });

  test("reads non-enumerable registered secret indices", () => {
    const arbitrarySecret = "non-enumerable-secret";
    const secrets: string[] = [];
    Object.defineProperty(secrets, "0", {
      configurable: true,
      enumerable: false,
      value: arbitrarySecret,
      writable: true,
    });

    expect(redactSecrets(`leaked ${arbitrarySecret}`, secrets)).toBe(
      "leaked [REDACTED]",
    );
  });

  test("fails closed for malformed registered secret arrays without invoking accessors", () => {
    const arbitrarySecret = "registry-secret";
    let getterCalls = 0;
    const holey = new Array<string>(1);
    const accessor: string[] = [];
    Object.defineProperty(accessor, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return arbitrarySecret;
      },
    });
    const malformedIndex = [arbitrarySecret];
    Object.defineProperty(malformedIndex, "01", {
      configurable: true,
      enumerable: false,
      value: "malformed-index-secret",
    });
    const nonString = [arbitrarySecret, 42] as unknown as string[];
    const descriptorFailure = new Proxy([arbitrarySecret], {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor inspection failed");
      },
    });

    for (const secrets of [
      holey,
      accessor,
      malformedIndex,
      nonString,
      descriptorFailure,
    ]) {
      expect(redactSecrets(`leaked ${arbitrarySecret}`, secrets)).toBe(
        "[REDACTED]",
      );
    }
    expect(getterCalls).toBe(0);
  });

  test("maps unknown hostile errors to a generic internal error without reading them", () => {
    const arbitrarySecret = "unknown-error-secret";
    let getterCalls = 0;
    const hostile = Object.defineProperties(
      {},
      {
        message: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return arbitrarySecret;
          },
        },
        authorization: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return arbitrarySecret;
          },
        },
      },
    );

    const serialized = serializeError(hostile);

    expect(getterCalls).toBe(0);
    expect(serialized.code).toBe("INTERNAL_ERROR");
    expect(serialized.retryable).toBe(false);
    expect(serialized.details).toEqual({});
    expect(JSON.stringify(serialized)).not.toContain(arbitrarySecret);
  });
});

describe("configuration", () => {
  test("uses safe defaults and never exposes or reads credential variables", () => {
    const credentialVariables = new Set([
      "GITHUB_STARS_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ]);
    const reads: PropertyKey[] = [];
    const env = new Proxy<NodeJS.ProcessEnv>(
      {
        GITHUB_STARS_MCP_DATA_DIR: "C:\\state",
        GITHUB_STARS_TOKEN: "product-secret",
        GITHUB_TOKEN: "github-secret",
        GH_TOKEN: "cli-secret",
      },
      {
        get(target, property, receiver) {
          reads.push(property);
          if (
            typeof property === "string" &&
            credentialVariables.has(property)
          ) {
            throw new Error(`credential variable ${property} was read`);
          }
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );

    const config = loadConfig(env, "win32");

    expect(config).toEqual({
      host: "github.com",
      authMode: "auto",
      dataDir: "C:\\state",
      logLevel: "warning",
      readOnly: true,
      maxReadConcurrency: 4,
      writeIntervalMs: 1_000,
      maxPlanActions: 5_000,
      planTtlMinutes: 1_440,
    });
    expect(Object.keys(config)).toEqual([
      "host",
      "authMode",
      "dataDir",
      "logLevel",
      "readOnly",
      "maxReadConcurrency",
      "writeIntervalMs",
      "maxPlanActions",
      "planTtlMinutes",
    ]);
    expect(reads).not.toEqual(
      expect.arrayContaining([...credentialVariables.values()]),
    );
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  test("accepts every supported override and inclusive numeric bound", () => {
    expect(
      loadConfig(
        {
          GITHUB_HOST: "github.com",
          GITHUB_STARS_MCP_AUTH_MODE: "gh",
          GITHUB_STARS_MCP_DATA_DIR: "/srv/github-stars",
          GITHUB_STARS_MCP_LOG_LEVEL: "debug",
          GITHUB_STARS_MCP_READ_ONLY: "false",
          GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "1",
          GITHUB_STARS_MCP_WRITE_INTERVAL_MS: "1000",
          GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "1",
          GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "1",
        },
        "linux",
      ),
    ).toEqual({
      host: "github.com",
      authMode: "gh",
      dataDir: "/srv/github-stars",
      logLevel: "debug",
      readOnly: false,
      maxReadConcurrency: 1,
      writeIntervalMs: 1_000,
      maxPlanActions: 1,
      planTtlMinutes: 1,
    });

    const upperBounds = loadConfig(
      {
        GITHUB_STARS_MCP_AUTH_MODE: "env",
        GITHUB_STARS_MCP_DATA_DIR: "/srv/github-stars",
        GITHUB_STARS_MCP_LOG_LEVEL: "error",
        GITHUB_STARS_MCP_READ_ONLY: "true",
        GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "8",
        GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "5000",
        GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "10080",
      },
      "linux",
    );
    expect(upperBounds.maxReadConcurrency).toBe(8);
    expect(upperBounds.maxPlanActions).toBe(5_000);
    expect(upperBounds.planTtlMinutes).toBe(10_080);
  });

  test("resolves platform state directories with explicit overrides taking precedence", () => {
    expect(
      loadConfig(
        {
          GITHUB_STARS_MCP_DATA_DIR: "D:\\explicit-state",
          LOCALAPPDATA: "C:\\Users\\octocat\\AppData\\Local",
        },
        "win32",
      ).dataDir,
    ).toBe("D:\\explicit-state");
    expect(
      loadConfig(
        { LOCALAPPDATA: "C:\\Users\\octocat\\AppData\\Local" },
        "win32",
      ).dataDir,
    ).toBe("C:\\Users\\octocat\\AppData\\Local\\github-stars-mcp");
    expect(
      loadConfig(
        {
          XDG_STATE_HOME: "/var/lib/octocat",
          HOME: "/home/octocat",
        },
        "linux",
      ).dataDir,
    ).toBe("/var/lib/octocat/github-stars-mcp");
    expect(loadConfig({ HOME: "/home/octocat" }, "darwin").dataDir).toBe(
      "/home/octocat/.local/state/github-stars-mcp",
    );
  });

  test.each([
    [{ GITHUB_HOST: "enterprise.example" }, /github\.com/u],
    [{ GITHUB_STARS_MCP_AUTH_MODE: "token" }, /AUTH_MODE/u],
    [{ GITHUB_STARS_MCP_LOG_LEVEL: "warn" }, /LOG_LEVEL/u],
    [{ GITHUB_STARS_MCP_READ_ONLY: "1" }, /READ_ONLY/u],
    [{ GITHUB_STARS_MCP_READ_ONLY: "TRUE" }, /READ_ONLY/u],
    [{ GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "0" }, /1.*8/u],
    [{ GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "9" }, /1.*8/u],
    [{ GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "1.5" }, /integer/u],
    [{ GITHUB_STARS_MCP_WRITE_INTERVAL_MS: "999" }, /1000/u],
    [{ GITHUB_STARS_MCP_WRITE_INTERVAL_MS: "1e3" }, /integer/u],
    [{ GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "0" }, /1.*5000/u],
    [{ GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "5001" }, /1.*5000/u],
    [{ GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "0" }, /1.*10080/u],
    [{ GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "10081" }, /1.*10080/u],
  ] satisfies readonly [NodeJS.ProcessEnv, RegExp][])(
    "rejects invalid setting %#",
    (invalidSetting, expectedMessage) => {
      expect(() =>
        loadConfig(
          {
            GITHUB_STARS_MCP_DATA_DIR: "/tmp/github-stars",
            ...invalidSetting,
          },
          "linux",
        ),
      ).toThrow(expectedMessage);
    },
  );

  test.each([
    [{ GITHUB_STARS_MCP_DATA_DIR: "relative/state" }, "linux"],
    [{ LOCALAPPDATA: "relative\\state" }, "win32"],
    [{ XDG_STATE_HOME: "relative/state" }, "linux"],
    [{ HOME: "relative/home" }, "darwin"],
  ] satisfies readonly [NodeJS.ProcessEnv, NodeJS.Platform][])(
    "rejects relative state path %#",
    (env, platform) => {
      expect(() => loadConfig(env, platform)).toThrow(/absolute/u);
    },
  );
});
