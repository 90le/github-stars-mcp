import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import processModule from "node:process";
import { dirname, isAbsolute, join, parse, resolve, win32 } from "node:path";
import { AppError } from "../domain/errors.js";

export const STATE_DATABASE_BASENAME = "github-stars-mcp.sqlite3";

export interface PreparedStateDirectory {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly platformLimitations: readonly string[];
}

function invalidPath(message: string, cause?: unknown): never {
  throw new AppError("STORAGE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function isWindowsUnsafe(path: string): boolean {
  const normalized = path.replace(/\//gu, "\\");
  return (
    normalized.startsWith("\\\\") ||
    normalized.startsWith("\\\\?\\") ||
    normalized.startsWith("\\\\.\\") ||
    /^\\\\[^\\]/u.test(normalized)
  );
}

function assertLocalAbsolute(path: string, platform: NodeJS.Platform): void {
  if (path.length === 0 || path.includes("\0")) {
    invalidPath("state directory must be nonempty local text");
  }
  if (platform === "win32") {
    if (!win32.isAbsolute(path) || isWindowsUnsafe(path)) {
      invalidPath("state directory must be an absolute local Windows path");
    }
  } else if (!isAbsolute(path)) {
    invalidPath("state directory must be absolute");
  }
}

function inspectNode(
  path: string,
  expected: "directory" | "file",
  required: boolean,
): Stats | undefined {
  let stats: Stats | undefined;
  try {
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    invalidPath(`cannot inspect state ${expected}`, error);
  }
  if (stats === undefined && required) {
    invalidPath(`cannot inspect state ${expected}`);
  }
  return stats;
}

function assertNode(
  path: string,
  expected: "directory" | "file",
  platform: NodeJS.Platform,
  harden: boolean,
  required = true,
): boolean {
  const stats = inspectNode(path, expected, required);
  if (stats === undefined) return false;
  if (stats.isSymbolicLink()) {
    invalidPath(`state ${expected} cannot be a symbolic link or junction`);
  }
  if (
    (expected === "directory" && !stats.isDirectory()) ||
    (expected === "file" && !stats.isFile())
  ) {
    invalidPath(`state ${expected} has the wrong filesystem type`);
  }

  if (platform !== "win32" && harden) {
    const uid =
      typeof processModule.getuid === "function"
        ? processModule.getuid()
        : undefined;
    if (uid !== undefined && stats.uid !== uid) {
      invalidPath(`state ${expected} must be owned by the current user`);
    }
    const allowed = expected === "directory" ? 0o700 : 0o600;
    const hardened = stats.mode & allowed;
    if ((stats.mode & 0o777) !== hardened) {
      chmodSync(path, hardened);
    }
  }
  return true;
}

function walkExistingDirectories(
  target: string,
  platform: NodeJS.Platform,
): void {
  const pathApi = platform === "win32" ? win32 : { parse, join };
  const root = pathApi.parse(target).root;
  const relative = target.slice(root.length);
  const segments =
    platform === "win32"
      ? relative.split(/[\\/]/u).filter(Boolean)
      : relative.split("/").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = pathApi.join(current, segment);
    assertNode(current, "directory", platform, false, false);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function ensureRegularDatabase(
  databasePath: string,
  platform: NodeJS.Platform,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      databasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600,
    );
  } catch (error) {
    if (!isAlreadyExists(error)) {
      invalidPath("cannot create state database file", error);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertNode(databasePath, "file", platform, true);
}

function validateDatabaseFamily(
  databasePath: string,
  platform: NodeJS.Platform,
  requireDatabase: boolean,
): void {
  assertNode(databasePath, "file", platform, true, requireDatabase);
  assertNode(`${databasePath}-wal`, "file", platform, true, false);
  assertNode(`${databasePath}-shm`, "file", platform, true, false);
}

export function prepareStateDirectory(
  dataDirInput: string,
  platform: NodeJS.Platform = processModule.platform,
): PreparedStateDirectory {
  assertLocalAbsolute(dataDirInput, platform);
  const dataDir =
    platform === "win32"
      ? win32.normalize(dataDirInput)
      : resolve(dataDirInput);
  walkExistingDirectories(dirname(dataDir), platform);

  if (!existsSync(dataDir)) {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      invalidPath("cannot create state directory", error);
    }
  }
  walkExistingDirectories(dataDir, platform);
  assertNode(dataDir, "directory", platform, true);
  const databasePath =
    platform === "win32"
      ? win32.join(dataDir, STATE_DATABASE_BASENAME)
      : join(dataDir, STATE_DATABASE_BASENAME);
  validateDatabaseFamily(databasePath, platform, false);
  ensureRegularDatabase(databasePath, platform);
  walkExistingDirectories(dataDir, platform);
  assertNode(dataDir, "directory", platform, true);
  validateDatabaseFamily(databasePath, platform, true);

  const platformLimitations = Object.freeze(
    platform === "win32"
      ? [
          "Windows inherited ACLs are relied upon; Node cannot prove all reparse-point types or eliminate the filename-open race.",
        ]
      : [
          "Node pathname checks cannot eliminate all component-replacement races without openat-style APIs.",
        ],
  );
  return Object.freeze({ dataDir, databasePath, platformLimitations });
}

export function validateStateFilesAfterOpen(
  prepared: PreparedStateDirectory,
  platform: NodeJS.Platform = processModule.platform,
): void {
  assertLocalAbsolute(prepared.dataDir, platform);
  const expectedDatabasePath =
    platform === "win32"
      ? win32.join(prepared.dataDir, STATE_DATABASE_BASENAME)
      : join(prepared.dataDir, STATE_DATABASE_BASENAME);
  if (prepared.databasePath !== expectedDatabasePath) {
    invalidPath(
      "prepared database path does not match the fixed state basename",
    );
  }
  walkExistingDirectories(prepared.dataDir, platform);
  assertNode(prepared.dataDir, "directory", platform, true);
  validateDatabaseFamily(prepared.databasePath, platform, true);
  walkExistingDirectories(prepared.dataDir, platform);
  assertNode(prepared.dataDir, "directory", platform, true);
  validateDatabaseFamily(prepared.databasePath, platform, true);
}
