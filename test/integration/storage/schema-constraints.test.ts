import { describe, expect, test } from "vitest";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";

const expectedTables = [
  "accounts",
  "discovery_candidates",
  "leases",
  "list_membership_staging",
  "list_memberships",
  "plan_operation_dependencies",
  "plan_operations",
  "plans",
  "repositories",
  "repository_evidence",
  "repository_versions",
  "run_operation_attempts",
  "run_operation_reconciliations",
  "run_operations",
  "runs",
  "runtime_secrets",
  "schema_migrations",
  "snapshot_repositories",
  "snapshot_star_staging",
  "snapshot_stars",
  "snapshot_verification_lists",
  "snapshot_verification_memberships",
  "snapshot_verification_stars",
  "snapshot_verifications",
  "snapshots",
  "user_lists",
] as const;

function migrated() {
  const database = openSqliteDatabase(":memory:");
  migrateSqliteDatabase(database, "2026-07-16T00:00:00.000Z");
  return database;
}

describe("migrated schema constraints", () => {
  test("creates exactly the 26 approved STRICT tables", () => {
    const database = migrated();
    const rows = database
      .prepare(
        `SELECT name,sql FROM sqlite_schema
         WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { readonly name: string; readonly sql: string }[];
    expect(rows.map((row) => row.name)).toEqual(expectedTables);
    expect(rows.every((row) => /\)\s*STRICT$/iu.test(row.sql))).toBe(true);
    database.close();
  });

  test("installs exactly the locked nonautomatic indexes and relationship triggers", () => {
    const database = migrated();
    const indexes = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type='index' AND sql IS NOT NULL
         ORDER BY name`,
      )
      .pluck()
      .all();
    expect(indexes).toEqual([
      "dependencies_reverse",
      "discovery_candidates_page",
      "memberships_reverse",
      "reconciliations_attempt",
      "repository_evidence_expiry",
      "run_operations_plan",
      "run_operations_sequence",
      "runs_recovery_lease",
      "snapshot_repositories_version",
      "snapshots_latest_complete",
      "snapshots_recovery_lease",
      "staging_memberships_reverse",
      "user_lists_order",
    ]);
    const triggers = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type='trigger' AND sql IS NOT NULL
         ORDER BY name`,
      )
      .pluck()
      .all();
    expect(triggers).toEqual([
      "reconciled_projection_requires_latest_event",
      "reconciliation_events_are_append_only_delete",
      "reconciliation_events_are_append_only_update",
      "reconciliation_requires_current_reconcilable_attempt",
      "run_operation_attempt_requires_current_projection",
      "run_operation_insert_requires_initial_projection",
    ]);
    database.close();
  });

  test.each([
    [
      "snapshot_stars",
      "sqlite_autoindex_snapshot_stars_1",
      "SELECT repository_id FROM snapshot_stars WHERE snapshot_id=? ORDER BY repository_id",
      ["snapshot"],
    ],
    [
      "run_operation_attempts",
      "sqlite_autoindex_run_operation_attempts_1",
      `SELECT attempt FROM run_operation_attempts
       WHERE run_id=? AND operation_id=? ORDER BY attempt`,
      ["run", "operation"],
    ],
    [
      "run_operation_reconciliations",
      "sqlite_autoindex_run_operation_reconciliations_1",
      `SELECT event_sequence FROM run_operation_reconciliations
       WHERE run_id=? AND operation_id=? ORDER BY event_sequence`,
      ["run", "operation"],
    ],
  ] as const)(
    "uses the composite primary-key autoindex for %s ordered queries",
    (table, autoindex, sql, parameters) => {
      const database = migrated();
      const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as {
        readonly name: string;
        readonly origin: string;
      }[];
      expect(indexes).toContainEqual(
        expect.objectContaining({ name: autoindex, origin: "pk" }),
      );
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...parameters) as { readonly detail: string }[];
      expect(plan.map((row) => row.detail).join("\n")).toContain(autoindex);
      database.close();
    },
  );

  test("rejects hashes containing an embedded NUL", () => {
    const database = migrated();
    const nulHash = `${"a".repeat(32)}\0${"a".repeat(31)}`;
    expect(Buffer.byteLength(nulHash)).toBe(64);
    expect(() =>
      database
        .prepare(
          `INSERT INTO schema_migrations(version,name,checksum,applied_at)
           VALUES (2,'nul',?,'2026-07-16T00:00:00.000Z')`,
        )
        .run(nulHash),
    ).toThrow();
    database.close();
  });

  test.each(["a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`])(
    "rejects non-lowercase-64-hex hash %s",
    (hash) => {
      const database = migrated();
      expect(() =>
        database
          .prepare(
            `INSERT INTO schema_migrations(version,name,checksum,applied_at)
             VALUES (2,'bad-hash',?,'2026-07-16T00:00:00.000Z')`,
          )
          .run(hash),
      ).toThrow();
      database.close();
    },
  );

  test.each(["0", "1", "9", "10", "9007199254740992"])(
    "accepts canonical unsigned repository database ID %s",
    (databaseId) => {
      const database = migrated();
      const hash = "a".repeat(64);
      database.exec("BEGIN");
      database
        .prepare(
          `INSERT INTO repositories(
             repository_id,repository_database_id,current_version_hash,observed_at
           ) VALUES ('R_1',?,?, '2026-07-16T00:00:00.000Z')`,
        )
        .run(databaseId, hash);
      database
        .prepare(
          `INSERT INTO repository_versions(
             repository_id,version_hash,owner,name,full_name,description,url,
             stargazer_count,is_fork,is_archived,is_disabled,is_private,
             visibility,primary_language,topics_json,license_spdx_id,pushed_at,updated_at
           ) VALUES (
             'R_1',?,'o','n','o/n',NULL,'https://github.com/o/n',
             0,0,0,0,0,'public',NULL,'[]',NULL,NULL,'2026-07-16T00:00:00.000Z'
           )`,
        )
        .run(hash);
      expect(() => database.exec("COMMIT")).not.toThrow();
      database.close();
    },
  );

  test.each(["", "+1", "-1", "01", "1x", " 1"])(
    "rejects noncanonical repository database ID %j",
    (databaseId) => {
      const database = migrated();
      expect(() =>
        database
          .prepare(
            `INSERT INTO repositories(
               repository_id,repository_database_id,current_version_hash,observed_at
             ) VALUES ('R_1',?,?,'2026-07-16T00:00:00.000Z')`,
          )
          .run(databaseId, "a".repeat(64)),
      ).toThrow();
      database.close();
    },
  );

  test.each([
    "2026-07-16T00:00:00Z",
    "2026-07-16T00:00:00.00Z",
    "2026-07-16T00:00:00.000+00:00",
    "2026-02-30T00:00:00.000Z",
    "2026-07-16T24:00:00.000Z",
  ])("rejects noncanonical timestamp %s", (timestamp) => {
    const database = migrated();
    expect(() =>
      database
        .prepare(
          `INSERT INTO leases(name,owner_id,acquired_at,heartbeat_at,expires_at)
           VALUES ('sync','owner',?,?,'2026-07-17T00:00:00.000Z')`,
        )
        .run(timestamp, timestamp),
    ).toThrow();
    database.close();
  });
});
