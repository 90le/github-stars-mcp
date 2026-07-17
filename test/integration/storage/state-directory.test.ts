import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getuid } from "node:process";
import {
  STATE_DATABASE_BASENAME,
  prepareStateDirectory,
  validateStateFilesAfterOpen,
} from "../../../src/storage/state-directory.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";

test("prepares an absolute data directory with the fixed database name", () => {
  const root = mkdtempSync(join(tmpdir(), "github-stars-mcp-"));
  const dataDir = join(root, "state");
  try {
    const prepared = prepareStateDirectory(dataDir);
    expect(prepared.databasePath).toBe(join(dataDir, STATE_DATABASE_BASENAME));
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.platformLimitations)).toBe(true);
    expect(prepared.platformLimitations.join(" ")).toMatch(
      process.platform === "win32"
        ? /ACL|reparse-point|filename-open race/u
        : /openat|component-replacement races/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects relative, UNC, extended, and device paths", () => {
  expect(() => prepareStateDirectory("relative-state")).toThrow();
  expect(() =>
    prepareStateDirectory("\\\\server\\share\\state", "win32"),
  ).toThrow();
  expect(() => prepareStateDirectory("\\\\?\\C:\\state", "win32")).toThrow();
  expect(() => prepareStateDirectory("\\\\.\\C:\\state", "win32")).toThrow();
});

test("rejects a static junction in an existing path component", () => {
  const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target);
    symlinkSync(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => prepareStateDirectory(join(link, "child"))).toThrow(
      /symbolic link|junction/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a non-regular database or sidecar after open", () => {
  const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
  try {
    const prepared = prepareStateDirectory(join(root, "state"));
    const database = openSqliteDatabase(prepared.databasePath);
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    validateStateFilesAfterOpen(prepared);
    database.close();

    mkdirSync(`${prepared.databasePath}-wal`);
    expect(() => validateStateFilesAfterOpen(prepared)).toThrow(
      /filesystem type/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a prepared object whose database path escapes the data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
  try {
    const prepared = prepareStateDirectory(join(root, "state"));
    expect(() =>
      validateStateFilesAfterOpen({
        ...prepared,
        databasePath: join(root, "other.sqlite3"),
      }),
    ).toThrow(/fixed state basename/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "does not require ordinary POSIX ancestors such as the filesystem root to be user-owned",
  () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
    try {
      expect(() => prepareStateDirectory(join(root, "state"))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hardens existing POSIX state modes without inventing missing owner permissions",
  () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
    try {
      const dataDir = join(root, "state");
      const databasePath = join(dataDir, STATE_DATABASE_BASENAME);
      mkdirSync(dataDir, { mode: 0o751 });
      writeFileSync(databasePath, "", { mode: 0o644 });
      chmodSync(dataDir, 0o751);
      chmodSync(databasePath, 0o644);
      prepareStateDirectory(dataDir);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);

      chmodSync(dataDir, 0o500);
      chmodSync(databasePath, 0o400);
      prepareStateDirectory(dataDir);
      expect(statSync(dataDir).mode & 0o777).toBe(0o500);
      expect(statSync(databasePath).mode & 0o777).toBe(0o400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "rejects database and sidecar symlinks",
  () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
    try {
      const linkedDataDir = join(root, "linked-state");
      mkdirSync(linkedDataDir);
      const target = join(root, "target");
      writeFileSync(target, "");
      symlinkSync(target, join(linkedDataDir, STATE_DATABASE_BASENAME), "file");
      expect(() => prepareStateDirectory(linkedDataDir)).toThrow(
        /symbolic link/u,
      );

      const prepared = prepareStateDirectory(join(root, "regular-state"));
      symlinkSync(target, `${prepared.databasePath}-wal`, "file");
      expect(() => validateStateFilesAfterOpen(prepared)).toThrow(
        /symbolic link/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(
  process.platform === "win32" ||
    typeof getuid !== "function" ||
    getuid() === 0,
)("rejects a POSIX state directory owned by another user", () => {
  const dataDir = "/";
  expect(() =>
    validateStateFilesAfterOpen({
      dataDir,
      databasePath: join(dataDir, STATE_DATABASE_BASENAME),
      platformLimitations: [],
    }),
  ).toThrow(/owned by the current user/u);
});
