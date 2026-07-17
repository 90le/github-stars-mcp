import { describe, expect, test } from "vitest";
import {
  migrateSqliteDatabase,
  migrationChecksum,
  openSqliteDatabase,
  SQLITE_MIGRATIONS,
  type SqliteMigration,
} from "../../../src/storage/sqlite-database.js";

describe("SQLite migrations", () => {
  test("supports an empty binary migration list", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z", []);
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(0);
    database.close();
  });
  test("creates the complete strict schema with hardened pragmas", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");

    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .pluck()
      .all();

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "leases",
        "repositories",
        "repository_versions",
        "snapshots",
        "snapshot_repositories",
        "snapshot_star_staging",
        "snapshot_stars",
        "user_lists",
        "list_membership_staging",
        "list_memberships",
        "snapshot_verifications",
        "runtime_secrets",
      ]),
    );
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("trusted_schema", { simple: true })).toBe(0);
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  test("rejects noncanonical timestamps and malformed required JSON", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");

    expect(() =>
      database
        .prepare(
          `INSERT INTO leases
             (name, owner_id, acquired_at, heartbeat_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "sync",
          "owner",
          "2026-07-16T24:00:00.000Z",
          "2026-07-17T00:00:00.000Z",
          "2026-07-17T01:00:00.000Z",
        ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO schema_migrations
             (version, name, checksum, applied_at)
           VALUES (2, 'bad', ?, '2026-02-30T00:00:00.000Z')`,
        )
        .run("a".repeat(64)),
    ).toThrow();
    database.close();
  });

  test("is idempotent and records an authenticated contiguous prefix", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z");
    expect(
      database
        .prepare(
          "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
        )
        .all(),
    ).toEqual([
      {
        version: 1,
        name: SQLITE_MIGRATIONS[0]!.name,
        checksum: migrationChecksum(SQLITE_MIGRATIONS[0]!),
      },
    ]);
    database.close();
  });

  test("rejects a gap in the migration ledger", () => {
    const database = openSqliteDatabase(":memory:");
    database.exec(
      `CREATE TABLE schema_migrations(
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT`,
    );
    database
      .prepare(
        "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)",
      )
      .run(2, "future", "a".repeat(64), "2026-07-16T00:00:00.000Z");
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z"),
    ).toThrow(/gap/u);
    database.close();
  });

  test("rejects a database newer than the binary", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO schema_migrations(version,name,checksum,applied_at)
         VALUES (2,'future',?,'2026-07-16T00:00:01.000Z')`,
      )
      .run("a".repeat(64));
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:02.000Z"),
    ).toThrow(/newer/u);
    database.close();
  });

  test("rejects checksum drift", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    database
      .prepare("UPDATE schema_migrations SET checksum=? WHERE version=1")
      .run("b".repeat(64));
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z"),
    ).toThrow(/drift/u);
    database.close();
  });

  test("rejects migration name drift", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    database
      .prepare("UPDATE schema_migrations SET name='renamed' WHERE version=1")
      .run();
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z"),
    ).toThrow(/drift/u);
    database.close();
  });

  test("rolls back a migration that fails after partial DDL", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    const broken: SqliteMigration = {
      version: 2,
      name: "broken",
      sql: "CREATE TABLE partial(value TEXT) STRICT; SELECT no_such_function();",
    };
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", [
        ...SQLITE_MIGRATIONS,
        broken,
      ]),
    ).toThrow();
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='partial'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(1);
    database.close();
  });
});
