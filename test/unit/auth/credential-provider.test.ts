import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import {
  CredentialProvider,
  type ExecFileRunner,
} from "../../../src/auth/credential-provider.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

const EXECUTABLE = "gh" as const;
const ARGUMENTS = [
  "auth",
  "token",
  "--hostname",
  "github.com",
] as const;

function config(authMode: "auto" | "env" | "gh" = "auto") {
  return { host: "github.com" as const, authMode };
}

function runner(
  implementation: ExecFileRunner = vi
    .fn<ExecFileRunner>()
    .mockResolvedValue({ stdout: "gh-token\n" }),
): ExecFileRunner {
  return implementation;
}

async function caught(operation: Promise<unknown>): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected operation to fail");
}

afterEach(() => {
  vi.restoreAllMocks();
  execFileMock.mockReset();
});

describe("CredentialProvider", () => {
  test("resolves auto mode in exact environment precedence without invoking gh", async () => {
    const run = vi.fn<ExecFileRunner>();
    const provider = new CredentialProvider(
      config(),
      run,
      Object.freeze({
        GITHUB_STARS_TOKEN: "  stars-token  ",
        GITHUB_TOKEN: "github-token",
        GH_TOKEN: "gh-token",
      }),
    );

    const credential = await provider.resolve();

    expect(credential.source).toBe("GITHUB_STARS_TOKEN");
    expect(credential.token).toBe("stars-token");
    expect(run).not.toHaveBeenCalled();
  });

  test("skips blank environment candidates in the same precedence", async () => {
    const run = vi.fn<ExecFileRunner>();

    await expect(
      new CredentialProvider(config(), run, {
        GITHUB_STARS_TOKEN: "   ",
        GITHUB_TOKEN: " selected-github ",
        GH_TOKEN: "lower-priority-gh",
      }).resolve(),
    ).resolves.toMatchObject({
      source: "GITHUB_TOKEN",
      token: "selected-github",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("env mode resolves an available token without invoking gh", async () => {
    const run = vi.fn<ExecFileRunner>();

    await expect(
      new CredentialProvider(config("env"), run, {
        GITHUB_STARS_TOKEN: " ",
        GITHUB_TOKEN: "\t",
        GH_TOKEN: " env-token ",
      }).resolve(),
    ).resolves.toMatchObject({ source: "GH_TOKEN", token: "env-token" });
    expect(run).not.toHaveBeenCalled();
  });

  test("env mode never invokes gh and returns generic AUTH_REQUIRED", async () => {
    const run = vi.fn<ExecFileRunner>();
    const error = await caught(
      new CredentialProvider(config("env"), run, {}).resolve(),
    );

    expect(run).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      code: "AUTH_REQUIRED",
      retryable: false,
    });
    expect(error.message).not.toMatch(/token|stdout|stderr/iu);
  });

  test("gh mode ignores environment credentials and invokes the exact tuple once", async () => {
    const run = vi
      .fn<ExecFileRunner>()
      .mockResolvedValue({ stdout: "  cli-token\r\n" });
    const provider = new CredentialProvider(config("gh"), run, {
      GITHUB_STARS_TOKEN: "ignored-stars",
      GITHUB_TOKEN: "ignored-github",
      GH_TOKEN: "ignored-gh",
    });

    const credential = await provider.resolve();

    expect(credential.source).toBe("gh");
    expect(credential.token).toBe("cli-token");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(EXECUTABLE, ARGUMENTS);
  });

  test("auto mode falls back to gh only after all environment candidates", async () => {
    const run = vi
      .fn<ExecFileRunner>()
      .mockResolvedValue({ stdout: "fallback-token\n" });

    await expect(
      new CredentialProvider(config(), run, {}).resolve(),
    ).resolves.toMatchObject({ source: "gh" });
    expect(run).toHaveBeenCalledOnce();
  });

  test.each([
    ["environment", "prefix\nembedded-secret", "auto" as const],
    ["environment", "prefix\rembedded-secret", "auto" as const],
    ["environment", "prefix\u0000embedded-secret", "auto" as const],
    ["environment", "prefix\u001fembedded-secret", "auto" as const],
    ["environment", "prefix\u007fembedded-secret", "auto" as const],
    ["GitHub CLI", "prefix\nembedded-secret", "gh" as const],
  ])(
    "rejects control characters from %s without exposing the value",
    async (source, secret, authMode) => {
      const run = vi
        .fn<ExecFileRunner>()
        .mockResolvedValue({ stdout: secret });
      const env =
        source === "environment"
          ? { GITHUB_STARS_TOKEN: secret }
          : {};
      const error = await caught(
        new CredentialProvider(config(authMode), run, env).resolve(),
      );

      expect(error.code).toBe("AUTH_REQUIRED");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(serializeError(error))).not.toContain(secret);
      expect(error.secrets).not.toContain(secret);
      expect(
        JSON.stringify(Object.getOwnPropertyDescriptors(error)),
      ).not.toContain(secret);
    },
  );

  test("discards blank stdout and hostile child-process failures without logging or leaking", async () => {
    const token = "ghp_child_process_secret";
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const failures: ExecFileRunner[] = [
      runner(vi.fn<ExecFileRunner>().mockResolvedValue({ stdout: " \r\n " })),
      runner(
        vi.fn<ExecFileRunner>().mockRejectedValue(
          Object.assign(new Error(`failed ${token}`), {
            stdout: token,
            stderr: `stderr ${token}`,
            cause: { authorization: `Bearer ${token}` },
          }),
        ),
      ),
    ];

    for (const run of failures) {
      const error = await caught(
        new CredentialProvider(config("gh"), run, {}).resolve(),
      );
      const serialized = JSON.stringify({
        string: String(error),
        json: error,
        serialized: serializeError(error),
      });
      expect(error).toMatchObject({
        code: "AUTH_REQUIRED",
        retryable: false,
      });
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("stderr");
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  test("replaces a runner-supplied AppError and retains none of its fields", async () => {
    const token = "ghp_injected_app_error_secret";
    const injected = new AppError(
      "GITHUB_UNAVAILABLE",
      `runner failed ${token}`,
      {
        retryable: true,
        details: { stderr: token },
        secrets: [token],
        cause: { stdout: token },
      },
    );
    const run = vi.fn<ExecFileRunner>().mockRejectedValue(injected);

    const error = await caught(
      new CredentialProvider(config("gh"), run, {}).resolve(),
    );

    expect(error).not.toBe(injected);
    expect(error).toMatchObject({
      code: "AUTH_REQUIRED",
      retryable: false,
      details: {},
      secrets: [],
    });
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(
      JSON.stringify(Object.getOwnPropertyDescriptors(error)),
    ).not.toContain(token);
  });

  test("returns a frozen credential with a non-enumerable token data property", async () => {
    const credential = await new CredentialProvider(
      config(),
      runner(),
      { GITHUB_TOKEN: "secret-token" },
    ).resolve();

    expect(Object.isFrozen(credential)).toBe(true);
    expect(Object.keys(credential)).toEqual(["source"]);
    expect(Object.getOwnPropertyDescriptor(credential, "token")).toEqual({
      configurable: false,
      enumerable: false,
      value: "secret-token",
      writable: false,
    });
    expect(JSON.stringify(credential)).toBe(
      JSON.stringify({ source: "GITHUB_TOKEN" }),
    );
  });

  test("native execution uses execFile with fixed no-shell options", async () => {
    execFileMock.mockImplementation(
      (
        file: string,
        args: readonly string[],
        options: Record<string, unknown>,
        callback: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        expect(file).toBe(EXECUTABLE);
        expect(args).toEqual(ARGUMENTS);
        expect(options).toEqual({
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 64 * 1024,
        });
        callback(null, "native-token\n", "ignored stderr");
        return {};
      },
    );

    const credential = await new CredentialProvider(
      config("gh"),
      undefined,
      {},
    ).resolve();

    expect(credential.token).toBe("native-token");
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  test("rejects runtime host and auth-mode escape attempts before credential access", () => {
    const run = vi.fn<ExecFileRunner>();
    const invalidHost = {
      host: "evil.example",
      authMode: "auto",
    } as unknown as ConstructorParameters<typeof CredentialProvider>[0];
    const invalidMode = {
      host: "github.com",
      authMode: "other",
    } as unknown as ConstructorParameters<typeof CredentialProvider>[0];

    expect(() => new CredentialProvider(invalidHost, run, {})).toThrow(
      /github\.com/iu,
    );
    expect(() => new CredentialProvider(invalidMode, run, {})).toThrow(
      /auth mode/iu,
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("loadConfig ignores all credential variables", () => {
    const loaded = loadConfig(
      {
        HOME: "/tmp/home",
        GITHUB_STARS_TOKEN: "dedicated-secret",
        GITHUB_TOKEN: "conventional-secret",
        GH_TOKEN: "cli-secret",
      },
      "linux",
    );

    for (const key of [
      "GITHUB_STARS_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "token",
    ]) {
      expect(Object.keys(loaded)).not.toContain(key);
    }
    expect(JSON.stringify(loaded)).not.toMatch(/secret/iu);
  });
});
