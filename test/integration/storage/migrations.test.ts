import { describe, expect, test } from "vitest";
import {
  migrateSqliteDatabase,
  migrationChecksum,
  openSqliteDatabase,
  SQLITE_MIGRATIONS,
  type SqliteMigration,
} from "../../../src/storage/sqlite-database.js";

const CURRENT_MIGRATION_COUNT = SQLITE_MIGRATIONS.length;
const NEXT_MIGRATION_VERSION = CURRENT_MIGRATION_COUNT + 1;

function expectRollbackRemainsUsable(
  database: ReturnType<typeof openSqliteDatabase>,
): void {
  database.exec(
    `BEGIN IMMEDIATE;
     CREATE TABLE rollback_probe(value TEXT) STRICT;
     ROLLBACK;`,
  );
  expect(database.inTransaction).toBe(false);
  expect(
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='rollback_probe'",
      )
      .get(),
  ).toBeUndefined();
}

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
           VALUES (?, 'bad', ?, '2026-02-30T00:00:00.000Z')`,
        )
        .run(NEXT_MIGRATION_VERSION, "a".repeat(64)),
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
    ).toEqual(
      SQLITE_MIGRATIONS.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migrationChecksum(migration),
      })),
    );
    database.close();
  });

  test("upgrades an authenticated version-one database without checksum drift", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(
      database,
      "2026-07-16T00:00:00.000Z",
      SQLITE_MIGRATIONS.slice(0, 1),
    );
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(1);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type='trigger'
             AND name='reconciliation_requires_current_unresolved_attempt'`,
        )
        .pluck()
        .get(),
    ).toBe("reconciliation_requires_current_unresolved_attempt");
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type='trigger'
             AND name='reconciliation_requires_current_reconcilable_attempt'`,
        )
        .pluck()
        .get(),
    ).toBeUndefined();

    migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z");
    expect(
      database
        .prepare(
          "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
        )
        .all(),
    ).toEqual(
      SQLITE_MIGRATIONS.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migrationChecksum(migration),
      })),
    );
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type='trigger'
             AND name LIKE 'reconciliation_requires_current_%_attempt'
           ORDER BY name`,
        )
        .pluck()
        .all(),
    ).toEqual(["reconciliation_requires_current_reconcilable_attempt"]);
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
         VALUES (?,'future',?,'2026-07-16T00:00:01.000Z')`,
      )
      .run(NEXT_MIGRATION_VERSION, "a".repeat(64));
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
      version: NEXT_MIGRATION_VERSION,
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
    ).toBe(CURRENT_MIGRATION_COUNT);
    database.close();
  });

  test.each([
    "bEgIn",
    "cOmMiT",
    "rOlLbAcK",
    "sAvEpOiNt rogue",
    "rElEaSe rogue",
    "eNd",
  ])("rejects top-level migration transaction control: %s", (control) => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    const escaping: SqliteMigration = {
      version: NEXT_MIGRATION_VERSION,
      name: "transaction-escape",
      sql: `/* harmless leading comment */ -- another comment
            \uFEFF${control}; CREATE TABLE escaped(value TEXT) STRICT;`,
    };
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", [
        ...SQLITE_MIGRATIONS,
        escaping,
      ]),
    ).toThrow(/transaction control/u);
    expect(database.inTransaction).toBe(false);
    database.close();
  });

  test("rejects COMMIT before executing any migration body or ledger write", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    const escaping: SqliteMigration = {
      version: NEXT_MIGRATION_VERSION,
      name: "commit-escape",
      sql: `CREATE TABLE must_not_persist(value TEXT) STRICT;
            COMMIT;
            CREATE TABLE also_must_not_persist(value TEXT) STRICT;
            BEGIN IMMEDIATE;`,
    };
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", [
        ...SQLITE_MIGRATIONS,
        escaping,
      ]),
    ).toThrow(/transaction control/u);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type='table' AND name IN
             ('must_not_persist','also_must_not_persist')`,
        )
        .all(),
    ).toEqual([]);
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(CURRENT_MIGRATION_COUNT);
    expect(database.inTransaction).toBe(false);
    database.close();
  });

  test("rejects migration accessors without invoking or persisting them", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    let getterCalls = 0;
    const hostile = {
      version: NEXT_MIGRATION_VERSION,
      name: "accessor-escape",
      get sql(): string {
        getterCalls += 1;
        if (getterCalls === 1) {
          database.exec("CREATE TABLE getter_side_effect(value TEXT) STRICT;");
          return "CREATE TABLE apparently_safe(value TEXT) STRICT;";
        }
        return `CREATE TABLE getter_payload(value TEXT) STRICT;
                COMMIT;
                BEGIN IMMEDIATE;`;
      },
    } satisfies SqliteMigration;

    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", [
        ...SQLITE_MIGRATIONS,
        hostile,
      ]),
    ).toThrow(/plain data/u);
    expect(getterCalls).toBe(0);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type='table' AND name IN
             ('getter_side_effect','apparently_safe','getter_payload')`,
        )
        .all(),
    ).toEqual([]);
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(CURRENT_MIGRATION_COUNT);
    expectRollbackRemainsUsable(database);
    database.close();
  });

  test("rejects proxied migration definitions without invoking traps", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    let trapCalls = 0;
    const proxied = new Proxy<SqliteMigration>(
      {
        version: NEXT_MIGRATION_VERSION,
        name: "proxy-escape",
        sql: "CREATE TABLE proxy_payload(value TEXT) STRICT;",
      },
      {
        get(target, property, receiver) {
          trapCalls += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
        getOwnPropertyDescriptor(target, property) {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        getPrototypeOf(target) {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", [
        ...SQLITE_MIGRATIONS,
        proxied,
      ]),
    ).toThrow(/plain data/u);
    expect(trapCalls).toBe(0);
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='proxy_payload'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(CURRENT_MIGRATION_COUNT);
    expectRollbackRemainsUsable(database);
    database.close();
  });

  test("rejects proxied migration arrays without invoking traps", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    let trapCalls = 0;
    const proxied = new Proxy<readonly SqliteMigration[]>(
      [
        ...SQLITE_MIGRATIONS,
        {
          version: NEXT_MIGRATION_VERSION,
          name: "proxy-array-escape",
          sql: "CREATE TABLE proxy_array_payload(value TEXT) STRICT;",
        },
      ],
      {
        get(target, property, receiver) {
          trapCalls += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
        getOwnPropertyDescriptor(target, property) {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        getPrototypeOf(target) {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", proxied),
    ).toThrow(/plain data/u);
    expect(trapCalls).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(CURRENT_MIGRATION_COUNT);
    expectRollbackRemainsUsable(database);
    database.close();
  });

  test("rejects unknown migration fields before DDL or ledger writes", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    const migration = {
      version: NEXT_MIGRATION_VERSION,
      name: "unknown-field",
      sql: "CREATE TABLE unknown_field_payload(value TEXT) STRICT;",
      source: "hostile",
    };

    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", [
        ...SQLITE_MIGRATIONS,
        migration,
      ]),
    ).toThrow(/plain data/u);
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='unknown_field_payload'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(CURRENT_MIGRATION_COUNT);
    expectRollbackRemainsUsable(database);
    database.close();
  });

  test("uses one migration snapshot across SQLite callback reentry", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    const migration = {
      version: NEXT_MIGRATION_VERSION,
      name: "snapshot-reentry",
      sql: `CREATE TABLE reentry_snapshot(value TEXT) STRICT;
            SELECT mutate_migration_definition();`,
    };
    const expectedChecksum = migrationChecksum(migration);
    const migrations: SqliteMigration[] = [...SQLITE_MIGRATIONS, migration];
    database.function("mutate_migration_definition", () => {
      migration.name = "mutated-after-exec-started";
      migration.sql =
        "CREATE TABLE mutated_definition_payload(value TEXT) STRICT;";
      migrations[CURRENT_MIGRATION_COUNT] = {
        version: NEXT_MIGRATION_VERSION,
        name: "replaced-after-exec-started",
        sql: "CREATE TABLE replaced_definition_payload(value TEXT) STRICT;",
      };
      return 1;
    });

    migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", migrations);
    expect(
      database
        .prepare(
          "SELECT version,name,checksum FROM schema_migrations WHERE version=?",
        )
        .get(NEXT_MIGRATION_VERSION),
    ).toEqual({
      version: NEXT_MIGRATION_VERSION,
      name: "snapshot-reentry",
      checksum: expectedChecksum,
    });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type='table' AND name IN
             ('mutated_definition_payload','replaced_definition_payload')`,
        )
        .all(),
    ).toEqual([]);
    database.close();
  });

  test("rejects checksum accessors without invoking them", () => {
    let getterCalls = 0;
    const hostile = {
      version: NEXT_MIGRATION_VERSION,
      name: "checksum-accessor",
      get sql(): string {
        getterCalls += 1;
        return "CREATE TABLE checksum_accessor(value TEXT) STRICT;";
      },
    } satisfies SqliteMigration;

    expect(() => migrationChecksum(hostile)).toThrow(/plain data/u);
    expect(getterCalls).toBe(0);
  });

  test("allows transaction words in comments, literals, and trigger bodies", () => {
    const database = openSqliteDatabase(":memory:");
    migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
    const safe: SqliteMigration = {
      version: NEXT_MIGRATION_VERSION,
      name: "lexical-safety",
      sql: `-- COMMIT and ROLLBACK are documentation here.
            /* BEGIN; SAVEPOINT ignored; RELEASE ignored; END; */
            CREATE TABLE lexical_safe(
              value TEXT DEFAULT 'COMMIT',
              "BEGIN" TEXT,
              \`END\` TEXT,
              [SAVEPOINT] TEXT
            ) STRICT;
            CREATE TRIGGER lexical_safe_trigger
            AFTER INSERT ON lexical_safe
            BEGIN
              SELECT CASE
                WHEN NEW.value='ROLLBACK' THEN 'SAVEPOINT'
                ELSE 'RELEASE'
              END;
              SELECT RAISE(ROLLBACK, 'not executed by this test');
            END;`,
    };
    expect(() =>
      migrateSqliteDatabase(database, "2026-07-16T00:00:01.000Z", [
        ...SQLITE_MIGRATIONS,
        safe,
      ]),
    ).not.toThrow();
    expect(
      database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(NEXT_MIGRATION_VERSION);
    database.close();
  });
});
