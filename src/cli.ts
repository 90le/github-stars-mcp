#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import type { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "./config.js";
import { AppError } from "./domain/errors.js";
import {
  createDoctorDependencies,
  doctorExitCode,
  runDoctor,
  type DoctorDependencies,
  type DoctorReport,
} from "./diagnostics/doctor.js";
import { safeErrorMessage } from "./logging/stderr-logger.js";
import { runServer } from "./server.js";
import { PACKAGE_VERSION } from "./version.js";

const HELP_TEXT = `github-stars-mcp

AI-native, auditable GitHub Stars and User Lists management over MCP stdio.

Usage:
  github-stars-mcp
  github-stars-mcp --stdio
  github-stars-mcp --doctor [--json]
  github-stars-mcp --help
  github-stars-mcp --version

Options:
  --stdio          Start the MCP stdio server (also the default).
  -h, --help       Show this help.
  -V, --version    Show the package version.
  --doctor         Check runtime, database, authentication, network, and capabilities.
  --json           Emit the doctor report as JSON.

Environment:
  GITHUB_STARS_TOKEN                  Preferred dedicated GitHub token.
  GITHUB_TOKEN / GH_TOKEN             Supported fallback token sources.
  GITHUB_STARS_MCP_AUTH_MODE          auto (default), env, or gh.
  GITHUB_STARS_MCP_DATA_DIR           Absolute local state directory.
  GITHUB_STARS_MCP_READ_ONLY          true by default; set false to enable apply.
  GITHUB_STARS_MCP_LOG_LEVEL          debug, info, warning, or error.
`;

type CliMode =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "version" }>
  | Readonly<{ kind: "doctor"; json: boolean }>
  | Readonly<{ kind: "server" }>;

export type CliIo = Readonly<{
  stdout: Writable;
  stderr: Writable;
}>;

export type CliDependencies = Readonly<{
  io?: CliIo;
  serverRunner?: typeof runServer;
  doctorDependenciesFactory?: (
    config: AppConfig,
    env: Readonly<NodeJS.ProcessEnv>,
  ) => DoctorDependencies;
}>;

function invalidArguments(): never {
  throw new AppError(
    "VALIDATION_ERROR",
    "Invalid command-line arguments. Run --help for usage.",
    { retryable: false },
  );
}

function parseCli(arguments_: readonly string[]): CliMode {
  if (
    arguments_.length === 0 ||
    (arguments_.length === 1 && arguments_[0] === "--stdio")
  ) {
    return Object.freeze({ kind: "server" });
  }
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--help" || arguments_[0] === "-h")
  ) {
    return Object.freeze({ kind: "help" });
  }
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--version" || arguments_[0] === "-V")
  ) {
    return Object.freeze({ kind: "version" });
  }
  if (arguments_.length === 1 && arguments_[0] === "--doctor") {
    return Object.freeze({ kind: "doctor", json: false });
  }
  if (
    arguments_.length === 2 &&
    arguments_.includes("--doctor") &&
    arguments_.includes("--json")
  ) {
    return Object.freeze({ kind: "doctor", json: true });
  }
  return invalidArguments();
}

function humanDoctorReport(report: DoctorReport): string {
  const lines = [`Status: ${report.status}`];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runCli(
  arguments_: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  try {
    const mode = parseCli(arguments_);
    if (mode.kind === "help") {
      io.stdout.write(HELP_TEXT);
      return 0;
    }
    if (mode.kind === "version") {
      io.stdout.write(`${PACKAGE_VERSION}\n`);
      return 0;
    }

    const config = loadConfig({ ...env });
    if (mode.kind === "doctor") {
      const doctorDependencies = (
        dependencies.doctorDependenciesFactory ?? createDoctorDependencies
      )(config, env);
      const report = await runDoctor(doctorDependencies);
      io.stdout.write(
        mode.json ? `${JSON.stringify(report)}\n` : humanDoctorReport(report),
      );
      return doctorExitCode(report);
    }

    await (dependencies.serverRunner ?? runServer)({
      config,
      env,
      input: process.stdin,
      output: io.stdout,
      loggerSink: io.stderr,
    });
    return 0;
  } catch (error) {
    io.stderr.write(`${safeErrorMessage(error)}\n`);
    return 1;
  }
}

export function main(): Promise<number> {
  return runCli(process.argv.slice(2), process.env);
}

async function isEntryPoint(entryPoint: string | undefined): Promise<boolean> {
  if (entryPoint === undefined) return false;
  try {
    const [modulePath, invokedPath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(entryPoint),
    ]);
    return modulePath === invokedPath;
  } catch {
    return import.meta.url === pathToFileURL(entryPoint).href;
  }
}

if (await isEntryPoint(process.argv[1])) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
