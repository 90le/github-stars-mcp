import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  STATE_DATABASE_BASENAME,
  prepareStateDirectory,
  validateStateFilesAfterOpen,
} from "../../../src/storage/state-directory.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";

function runStateWorker(
  workerId: "1" | "2",
  stateRoot: string,
  coordinationDirectory: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const child = spawn(
      process.execPath,
      [
        vitest,
        "run",
        "test/integration/storage/concurrency-worker.test.ts",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_STARS_CONCURRENCY_MODE: "state",
          GITHUB_STARS_CONCURRENCY_WORKER_ID: workerId,
          GITHUB_STARS_CONCURRENCY_COORDINATION: coordinationDirectory,
          GITHUB_STARS_CONCURRENCY_STATE_ROOT: stateRoot,
        },
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(new Error(`state worker failed (${String(code)}): ${output}`));
      }
    });
  });
}

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

test.skipIf(process.platform === "win32")(
  "treats a POSIX backslash as filename text while rejecting a real symlink ancestor",
  () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
    try {
      const literalBackslashDirectory = join(root, "literal\\component");
      const target = join(literalBackslashDirectory, "target");
      const link = join(literalBackslashDirectory, "link");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, link, "dir");
      expect(() => prepareStateDirectory(join(link, "state"))).toThrow(
        /symbolic link|junction/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["", "-wal", "-shm"] as const)(
  "rejects a pre-existing database-family link at %s before SQLite open",
  (suffix) => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
    try {
      const dataDir = join(root, "state");
      const databasePath = join(dataDir, STATE_DATABASE_BASENAME);
      const target = join(root, `target${suffix || "-database"}`);
      mkdirSync(dataDir);
      if (process.platform === "win32") {
        mkdirSync(target);
        symlinkSync(target, `${databasePath}${suffix}`, "junction");
      } else {
        writeFileSync(target, "");
        symlinkSync(target, `${databasePath}${suffix}`, "file");
      }
      expect(() => prepareStateDirectory(dataDir)).toThrow(
        /symbolic link|junction/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["-wal", "-shm"] as const)(
  "rejects a pre-existing non-regular sidecar at %s before SQLite open",
  (suffix) => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
    try {
      const dataDir = join(root, "state");
      mkdirSync(dataDir);
      mkdirSync(join(dataDir, `${STATE_DATABASE_BASENAME}${suffix}`));
      expect(() => prepareStateDirectory(dataDir)).toThrow(/filesystem type/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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

test("requires the main database file to exist after open", () => {
  const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
  try {
    const prepared = prepareStateDirectory(join(root, "state"));
    rmSync(prepared.databasePath);
    expect(() => validateStateFilesAfterOpen(prepared)).toThrow(
      /cannot inspect state file/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a main database renamed away after open", () => {
  const root = mkdtempSync(join(tmpdir(), "github-stars-state-"));
  try {
    const prepared = prepareStateDirectory(join(root, "state"));
    renameSync(prepared.databasePath, `${prepared.databasePath}.moved`);
    expect(() => validateStateFilesAfterOpen(prepared)).toThrow(
      /cannot inspect state file/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "two real first-start processes converge when the shared state directory is missing",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-state-race-"));
    try {
      const stateRoot = join(root, "shared");
      await Promise.all([
        runStateWorker("1", stateRoot, root),
        runStateWorker("2", stateRoot, root),
      ]);
      for (let index = 0; index < 8; index += 1) {
        const prepared = prepareStateDirectory(
          join(stateRoot, `round-${String(index)}`),
        );
        expect(statSync(prepared.databasePath).isFile()).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
    typeof process.getuid !== "function" ||
    process.getuid() === 0,
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
