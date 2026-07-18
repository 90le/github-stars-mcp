import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";
import { RuntimeSecretRepository } from "../../../src/storage/runtime-secret-repository.js";

function runSecretWorker(
  workerId: "1" | "2",
  databasePath: string,
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
          GITHUB_STARS_CONCURRENCY_MODE: "secret",
          GITHUB_STARS_CONCURRENCY_WORKER_ID: workerId,
          GITHUB_STARS_CONCURRENCY_DATABASE: databasePath,
          GITHUB_STARS_CONCURRENCY_COORDINATION: coordinationDirectory,
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
      else
        reject(new Error(`secret worker failed (${String(code)}): ${output}`));
    });
  });
}

describe("RuntimeSecretRepository", () => {
  test("persists one private 32-byte cursor signing key and returns copies", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    const secrets = new RuntimeSecretRepository(database);
    const first = secrets.getOrCreateCursorSigningKey(
      "2026-07-16T00:00:01.000Z",
    );
    const second = secrets.getOrCreateCursorSigningKey(
      "2026-07-16T00:00:02.000Z",
    );

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(
      database
        .prepare(
          `SELECT typeof(value) AS type,length(value) AS length
           FROM runtime_secrets WHERE name='cursor_hmac_sha256_v1'`,
        )
        .get(),
    ).toEqual({ type: "blob", length: 32 });
    first.fill(0);
    expect(
      secrets.getOrCreateCursorSigningKey("2026-07-16T00:00:03.000Z"),
    ).not.toEqual(first);
    database.close();
  });

  test("converges across two connections and survives reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "github-stars-secret-"));
    const path = join(root, "state.sqlite3");
    try {
      const firstDatabase = openSqliteDatabase(path);
      migrateSqliteDatabase(firstDatabase, "2026-07-16T00:00:00.000Z");
      const secondDatabase = openSqliteDatabase(path);
      migrateSqliteDatabase(secondDatabase, "2026-07-16T00:00:00.000Z");
      const first = new RuntimeSecretRepository(
        firstDatabase,
      ).getOrCreateCursorSigningKey("2026-07-16T00:00:01.000Z");
      const second = new RuntimeSecretRepository(
        secondDatabase,
      ).getOrCreateCursorSigningKey("2026-07-16T00:00:01.000Z");
      expect(second).toEqual(first);
      secondDatabase.close();
      firstDatabase.close();

      const reopened = openSqliteDatabase(path);
      migrateSqliteDatabase(reopened, "2026-07-16T00:00:02.000Z");
      expect(
        new RuntimeSecretRepository(reopened).getOrCreateCursorSigningKey(
          "2026-07-16T00:00:03.000Z",
        ),
      ).toEqual(first);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wipes selected bytes when the transaction fails after key validation", () => {
    const primary = new Error("simulated commit failure");
    const selected = Buffer.alloc(32, 7);
    let generated: Buffer | undefined;
    const database = {
      inTransaction: false,
      prepare(sql: string) {
        return sql.includes("INSERT INTO runtime_secrets")
          ? {
              run(input: unknown) {
                generated = (input as { readonly value: Buffer }).value;
              },
            }
          : {
              get() {
                return {
                  value: selected,
                  storage_type: "blob",
                  byte_length: 32,
                };
              },
            };
      },
      transaction(callback: () => unknown) {
        return {
          immediate() {
            callback();
            throw primary;
          },
        };
      },
    } as unknown as Database.Database;

    let thrown: unknown;
    try {
      new RuntimeSecretRepository(database).getOrCreateCursorSigningKey(
        "2026-07-16T00:00:01.000Z",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).cause).toBe(primary);
    expect(generated).toBeDefined();
    expect(Array.from(generated ?? [])).toEqual(new Array(32).fill(0));
    expect(Array.from(selected)).toEqual(new Array(32).fill(0));
  });

  test("does not replace a primary failure when best-effort wiping cannot fill detached bytes", () => {
    const primary = new Error("simulated database failure");
    let generated: Buffer | undefined;
    const database = {
      inTransaction: false,
      prepare() {
        return {
          run(input: unknown) {
            generated = (input as { readonly value: Buffer }).value;
            structuredClone(generated.buffer, {
              transfer: [generated.buffer as ArrayBuffer],
            });
            throw primary;
          },
        };
      },
      transaction(callback: () => unknown) {
        return {
          immediate() {
            callback();
          },
        };
      },
    } as unknown as Database.Database;

    let thrown: unknown;
    try {
      new RuntimeSecretRepository(database).getOrCreateCursorSigningKey(
        "2026-07-16T00:00:01.000Z",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).cause).toBe(primary);
    expect(generated?.byteLength).toBe(0);
  });

  test(
    "two real concurrent processes initialize exactly one key",
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "github-stars-secret-"));
      const path = join(root, "state.sqlite3");
      try {
        const bootstrap = openSqliteDatabase(path);
        migrateSqliteDatabase(bootstrap, "2026-07-16T00:00:00.000Z");
        bootstrap.close();
        await Promise.all([
          runSecretWorker("1", path, root),
          runSecretWorker("2", path, root),
        ]);
        expect(readFileSync(join(root, "result-1"), "utf8")).toBe(
          readFileSync(join(root, "result-2"), "utf8"),
        );
        const database = openSqliteDatabase(path);
        expect(
          database
            .prepare(
              `SELECT COUNT(*) FROM runtime_secrets
               WHERE name='cursor_hmac_sha256_v1'`,
            )
            .pluck()
            .get(),
        ).toBe(1);
        database.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("fails closed for a corrupt stored key without leaking it", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    database.pragma("ignore_check_constraints = ON");
    database
      .prepare(
        `INSERT INTO runtime_secrets(name,value,created_at)
         VALUES ('cursor_hmac_sha256_v1',x'0102','2026-07-16T00:00:00.000Z')`,
      )
      .run();
    database.pragma("ignore_check_constraints = OFF");
    let thrown: unknown;
    try {
      new RuntimeSecretRepository(database).getOrCreateCursorSigningKey(
        "2026-07-16T00:00:01.000Z",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("STORAGE_ERROR");
    expect(JSON.stringify(thrown)).not.toContain("0102");
    database.close();
  });
});
