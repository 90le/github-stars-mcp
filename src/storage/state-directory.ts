import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { getuid } from "node:process";
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

function assertNode(
  path: string,
  expected: "directory" | "file",
  platform: NodeJS.Platform,
  harden: boolean,
): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    invalidPath(`cannot inspect state ${expected}`, error);
  }
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
    const uid = typeof getuid === "function" ? getuid() : undefined;
    if (uid !== undefined && stats.uid !== uid) {
      invalidPath(`state ${expected} must be owned by the current user`);
    }
    const allowed = expected === "directory" ? 0o700 : 0o600;
    const hardened = stats.mode & allowed;
    if ((stats.mode & 0o777) !== hardened) {
      chmodSync(path, hardened);
    }
  }
}

function walkExistingDirectories(
  target: string,
  platform: NodeJS.Platform,
): void {
  const pathApi = platform === "win32" ? win32 : { parse, join };
  const root = pathApi.parse(target).root;
  const relative = target.slice(root.length);
  let current = root;
  for (const segment of relative.split(/[\\/]/u).filter(Boolean)) {
    current = pathApi.join(current, segment);
    if (existsSync(current)) {
      assertNode(current, "directory", platform, false);
    }
  }
}

function ensureRegularDatabase(
  databasePath: string,
  platform: NodeJS.Platform,
): void {
  if (!existsSync(databasePath)) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        databasePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
    } catch (error) {
      invalidPath("cannot create state database file", error);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  assertNode(databasePath, "file", platform, true);
}

export function prepareStateDirectory(
  dataDirInput: string,
  platform: NodeJS.Platform = process.platform,
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
  ensureRegularDatabase(databasePath, platform);
  walkExistingDirectories(dataDir, platform);
  assertNode(dataDir, "directory", platform, true);
  assertNode(databasePath, "file", platform, true);

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
  platform: NodeJS.Platform = process.platform,
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
  for (const path of [
    prepared.databasePath,
    `${prepared.databasePath}-wal`,
    `${prepared.databasePath}-shm`,
  ]) {
    if (existsSync(path)) {
      assertNode(path, "file", platform, true);
    }
  }
  walkExistingDirectories(prepared.dataDir, platform);
  assertNode(prepared.dataDir, "directory", platform, true);
  for (const path of [
    prepared.databasePath,
    `${prepared.databasePath}-wal`,
    `${prepared.databasePath}-shm`,
  ]) {
    if (existsSync(path)) {
      assertNode(path, "file", platform, true);
    }
  }
}
