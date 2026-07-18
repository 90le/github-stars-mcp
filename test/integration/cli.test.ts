import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GitHubCapabilities } from "../../src/app/ports/github-port.js";
import { runCli, type CliDependencies, type CliIo } from "../../src/cli.js";
import type { DoctorDependencies } from "../../src/diagnostics/doctor.js";
import type { runServer } from "../../src/server.js";
import { PACKAGE_VERSION } from "../../src/version.js";

const execFileAsync = promisify(execFile);
const AVAILABLE: GitHubCapabilities = Object.freeze({
  starRead: "available",
  starWrite: "unknown",
  listRead: "available",
  listWrite: "unknown",
});

class Capture extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

function io(): CliIo & { stdout: Capture; stderr: Capture } {
  return { stdout: new Capture(), stderr: new Capture() };
}

function doctor(
  overrides: Partial<DoctorDependencies> = {},
): DoctorDependencies {
  return {
    checkRuntime: () => Promise.resolve(),
    checkDatabase: () => Promise.resolve(),
    checkGh: () => Promise.resolve(true),
    checkCredentials: () => Promise.resolve(),
    checkNetwork: () => Promise.resolve(),
    checkCapabilities: () => Promise.resolve(AVAILABLE),
    ...overrides,
  };
}

describe("CLI", () => {
  it("prints help and package-derived version without loading runtime state", async () => {
    const helpIo = io();
    expect(await runCli(["--help"], {}, { io: helpIo })).toBe(0);
    expect(helpIo.stdout.value).toContain("github-stars-mcp");
    expect(helpIo.stdout.value).toContain("--doctor");
    expect(helpIo.stdout.value).toContain("GITHUB_STARS_MCP_READ_ONLY");
    expect(helpIo.stderr.value).toBe("");

    const versionIo = io();
    expect(await runCli(["--version"], {}, { io: versionIo })).toBe(0);
    expect(versionIo.stdout.value).toBe(`${PACKAGE_VERSION}\n`);
    expect(versionIo.stderr.value).toBe("");
  });

  it.each([
    ["healthy", doctor(), 0, "healthy"],
    [
      "degraded",
      doctor({
        checkCapabilities: () =>
          Promise.resolve({
            ...AVAILABLE,
            listRead: "unavailable",
            listWrite: "unavailable",
          }),
      }),
      2,
      "degraded",
    ],
    [
      "unusable",
      doctor({
        checkCredentials: () => Promise.reject(new Error("missing")),
      }),
      1,
      "unusable",
    ],
  ] as const)(
    "returns documented doctor status for %s",
    async (_name, doctorDependencies, exitCode, status) => {
      const output = io();
      const dependencies: CliDependencies = {
        io: output,
        doctorDependenciesFactory: () => doctorDependencies,
      };
      expect(
        await runCli(
          ["--doctor", "--json"],
          {
            GITHUB_STARS_MCP_DATA_DIR: resolve(".doctor-test-state"),
            GITHUB_STARS_MCP_AUTH_MODE: "env",
          },
          dependencies,
        ),
      ).toBe(exitCode);
      const report = JSON.parse(output.stdout.value) as {
        status: string;
        checks: { name: string }[];
      };
      expect(report.status).toBe(status);
      expect(report.checks.map((check) => check.name)).toEqual([
        "runtime",
        "database",
        "gh",
        "credentials",
        "network",
        "capabilities",
      ]);
      expect(output.stderr.value).toBe("");
    },
  );

  it("starts stdio with read-only defaults and writes no protocol text itself", async () => {
    const output = io();
    const serverRunner = vi.fn<typeof runServer>(() => Promise.resolve());
    expect(
      await runCli(
        [],
        {
          GITHUB_STARS_MCP_DATA_DIR: resolve(".server-test-state"),
          GITHUB_STARS_MCP_AUTH_MODE: "env",
        },
        { io: output, serverRunner },
      ),
    ).toBe(0);
    expect(serverRunner).toHaveBeenCalledOnce();
    expect(serverRunner.mock.calls[0]?.[0].config.readOnly).toBe(true);
    expect(serverRunner.mock.calls[0]?.[0].output).toBe(output.stdout);
    expect(output.stdout.value).toBe("");
  });

  it("rejects unknown flags without reflecting their contents", async () => {
    const output = io();
    const token = "ghp_example_secret_that_must_not_escape";
    expect(await runCli([`--unknown=${token}`], {}, { io: output })).toBe(1);
    expect(output.stdout.value).toBe("");
    expect(output.stderr.value).toContain("Invalid command-line arguments");
    expect(output.stderr.value).not.toContain(token);
  });
});

describe("built CLI", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: process.cwd(),
      shell: process.platform === "win32",
      windowsHide: true,
    });
  }, 60_000);

  it("ships one executable with a shebang and matching version", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin: Record<string, string>;
      version: string;
    };
    expect(packageJson.bin).toEqual({ "github-stars-mcp": "dist/cli.js" });
    expect((await readFile("dist/cli.js", "utf8")).split(/\r?\n/u)[0]).toBe(
      "#!/usr/bin/env node",
    );

    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn(process.execPath, ["dist/cli.js", "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result).toEqual({
      code: 0,
      stdout: `${packageJson.version}\n`,
      stderr: "",
    });
  });
});
