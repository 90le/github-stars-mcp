import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { RuntimeSecretRepository } from "../../../src/storage/runtime-secret-repository.js";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";

const mode = process.env.GITHUB_STARS_CONCURRENCY_MODE;
const workerId = process.env.GITHUB_STARS_CONCURRENCY_WORKER_ID;
const databasePath = process.env.GITHUB_STARS_CONCURRENCY_DATABASE;
const coordinationDirectory = process.env.GITHUB_STARS_CONCURRENCY_COORDINATION;
const enabled =
  (mode === "migration" || mode === "secret") &&
  (workerId === "1" || workerId === "2") &&
  typeof databasePath === "string" &&
  typeof coordinationDirectory === "string";

test.skipIf(!enabled)(
  "coordinates one real external SQLite worker",
  async () => {
    const readyPath = join(coordinationDirectory!, `ready-${workerId!}`);
    writeFileSync(readyPath, "ready", { encoding: "utf8", flag: "wx" });
    const deadline = Date.now() + 15_000;
    while (
      (!existsSync(join(coordinationDirectory!, "ready-1")) ||
        !existsSync(join(coordinationDirectory!, "ready-2"))) &&
      Date.now() < deadline
    ) {
      await delay(10);
    }
    expect(existsSync(join(coordinationDirectory!, "ready-1"))).toBe(true);
    expect(existsSync(join(coordinationDirectory!, "ready-2"))).toBe(true);

    const database = openSqliteDatabase(databasePath!);
    if (mode === "migration") {
      migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    } else {
      const key = new RuntimeSecretRepository(
        database,
      ).getOrCreateCursorSigningKey("2026-07-16T00:00:01.000Z");
      writeFileSync(
        join(coordinationDirectory!, `result-${workerId!}`),
        Buffer.from(key).toString("hex"),
        { encoding: "utf8", flag: "wx" },
      );
    }
    database.close();

    if (mode === "secret") {
      expect(
        readFileSync(
          join(coordinationDirectory!, `result-${workerId!}`),
          "utf8",
        ),
      ).toHaveLength(64);
    }
  },
);
