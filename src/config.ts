import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { AppError } from "./domain/errors.js";

export interface AppConfig {
  readonly host: "github.com";
  readonly authMode: "auto" | "env" | "gh";
  readonly dataDir: string;
  readonly logLevel: "debug" | "info" | "warning" | "error";
  readonly readOnly: boolean;
  readonly maxReadConcurrency: number;
  readonly writeIntervalMs: number;
  readonly maxPlanActions: number;
  readonly planTtlMinutes: number;
}

function validationError(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message);
}

function loadHost(value: string | undefined): "github.com" {
  if (value === undefined || value === "github.com") return "github.com";
  throw validationError("GITHUB_HOST must be github.com");
}

function loadAuthMode(value: string | undefined): AppConfig["authMode"] {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "env" || value === "gh") {
    return value;
  }
  throw validationError("GITHUB_STARS_MCP_AUTH_MODE must be auto, env, or gh");
}

function loadLogLevel(value: string | undefined): AppConfig["logLevel"] {
  if (value === undefined) return "warning";
  if (
    value === "debug" ||
    value === "info" ||
    value === "warning" ||
    value === "error"
  ) {
    return value;
  }
  throw validationError(
    "GITHUB_STARS_MCP_LOG_LEVEL must be debug, info, warning, or error",
  );
}

function loadBoolean(
  value: string | undefined,
  defaultValue: boolean,
  variable: string,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw validationError(`${variable} must be true or false`);
}

function loadInteger(
  value: string | undefined,
  defaultValue: number,
  variable: string,
  minimum: number,
  maximum?: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/u.test(value)) {
    throw validationError(`${variable} must be an integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw validationError(`${variable} must be an integer`);
  }
  if (parsed < minimum || (maximum !== undefined && parsed > maximum)) {
    const bounds =
      maximum === undefined
        ? `at least ${minimum}`
        : `between ${minimum} and ${maximum}`;
    throw validationError(`${variable} must be ${bounds}`);
  }
  return parsed;
}

function absolutePath(
  value: string,
  platform: NodeJS.Platform,
  variable: string,
): string {
  const pathImplementation = platform === "win32" ? win32 : posix;
  if (!pathImplementation.isAbsolute(value)) {
    throw validationError(`${variable} must be an absolute path`);
  }
  return value;
}

function resolveDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const explicit = env.GITHUB_STARS_MCP_DATA_DIR;
  if (explicit !== undefined) {
    return absolutePath(explicit, platform, "GITHUB_STARS_MCP_DATA_DIR");
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData !== undefined) {
      absolutePath(localAppData, platform, "LOCALAPPDATA");
      return win32.join(localAppData, "github-stars-mcp");
    }

    const home = env.USERPROFILE ?? env.HOME ?? homedir();
    absolutePath(home, platform, "home directory");
    return win32.join(home, ".local", "state", "github-stars-mcp");
  }

  const xdgStateHome = env.XDG_STATE_HOME;
  if (xdgStateHome !== undefined) {
    absolutePath(xdgStateHome, platform, "XDG_STATE_HOME");
    return posix.join(xdgStateHome, "github-stars-mcp");
  }

  const home = env.HOME ?? homedir();
  absolutePath(home, platform, "home directory");
  return posix.join(home, ".local", "state", "github-stars-mcp");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AppConfig {
  const host = loadHost(env.GITHUB_HOST);
  const authMode = loadAuthMode(env.GITHUB_STARS_MCP_AUTH_MODE);
  const logLevel = loadLogLevel(env.GITHUB_STARS_MCP_LOG_LEVEL);
  const readOnly = loadBoolean(
    env.GITHUB_STARS_MCP_READ_ONLY,
    true,
    "GITHUB_STARS_MCP_READ_ONLY",
  );
  const maxReadConcurrency = loadInteger(
    env.GITHUB_STARS_MCP_MAX_READ_CONCURRENCY,
    4,
    "GITHUB_STARS_MCP_MAX_READ_CONCURRENCY",
    1,
    8,
  );
  const writeIntervalMs = loadInteger(
    env.GITHUB_STARS_MCP_WRITE_INTERVAL_MS,
    1_000,
    "GITHUB_STARS_MCP_WRITE_INTERVAL_MS",
    1_000,
  );
  const maxPlanActions = loadInteger(
    env.GITHUB_STARS_MCP_MAX_PLAN_ACTIONS,
    5_000,
    "GITHUB_STARS_MCP_MAX_PLAN_ACTIONS",
    1,
    5_000,
  );
  const planTtlMinutes = loadInteger(
    env.GITHUB_STARS_MCP_PLAN_TTL_MINUTES,
    1_440,
    "GITHUB_STARS_MCP_PLAN_TTL_MINUTES",
    1,
    10_080,
  );
  const dataDir = resolveDataDir(env, platform);

  return {
    host,
    authMode,
    dataDir,
    logLevel,
    readOnly,
    maxReadConcurrency,
    writeIntervalMs,
    maxPlanActions,
    planTtlMinutes,
  };
}
