import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
  migrateSqliteDatabase,
  openSqliteDatabase,
} from "../../../src/storage/sqlite-database.js";

const time = "2026-07-16T00:00:00.000Z";
const later = "2026-07-16T00:01:00.000Z";

function migrated(): Database.Database {
  const database = openSqliteDatabase(":memory:");
  migrateSqliteDatabase(database, time);
  return database;
}

function insertAccountAndSnapshot(
  database: Database.Database,
  snapshotId = "snap_1",
): void {
  database
    .prepare(
      `INSERT INTO accounts(host,login,account_id)
       VALUES ('github.com','octocat','U_1')
       ON CONFLICT(host,account_id) DO NOTHING`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO snapshots(
         snapshot_id,host,login,account_id,mode,status,list_coverage,
         lease_name,lease_owner_id,started_at,completed_at
       ) VALUES (
         ?,'github.com','octocat','U_1','full','complete','complete',
         'sync','owner',?,?
       )`,
    )
    .run(snapshotId, time, later);
}

function insertRepository(
  database: Database.Database,
  repositoryId = "R_1",
  databaseId = "1",
  hash = "a".repeat(64),
): void {
  database.exec("BEGIN");
  database
    .prepare(
      `INSERT INTO repositories(
         repository_id,repository_database_id,current_version_hash,observed_at
       ) VALUES (?,?,?,?)`,
    )
    .run(repositoryId, databaseId, hash, time);
  database
    .prepare(
      `INSERT INTO repository_versions(
         repository_id,version_hash,owner,name,full_name,description,url,
         stargazer_count,is_fork,is_archived,is_disabled,is_private,
         visibility,primary_language,topics_json,license_spdx_id,pushed_at,updated_at
       ) VALUES (
         ?,?,'owner','repo','owner/repo',NULL,'https://github.com/owner/repo',
         1,0,0,0,0,'public','TypeScript','[]',NULL,NULL,?
       )`,
    )
    .run(repositoryId, hash, time);
  database.exec("COMMIT");
}

function insertPlanRunGraph(
  database: Database.Database,
  includeOperation = true,
): void {
  insertAccountAndSnapshot(database);
  database
    .prepare(
      `INSERT INTO plans(
         plan_id,state,host,login,account_id,snapshot_id,hash,executable_json,
         created_at,expires_at,caller_note,warnings_json,summary_json
       ) VALUES (
         'plan_1','ready','github.com','octocat','U_1','snap_1',?,
         '{}',?,'2026-07-17T00:00:00.000Z',NULL,'[]','{}'
       )`,
    )
    .run("a".repeat(64), time);
  database
    .prepare(
      `INSERT INTO plan_operations(
         plan_id,operation_id,sequence,kind,operation_json
       ) VALUES ('plan_1','op_1',0,'star','{}')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO runs(
         run_id,plan_id,host,login,account_id,lease_name,lease_owner_id,
         state,failure_mode,warnings_json,started_at,finished_at
       ) VALUES (
         'run_1','plan_1','github.com','octocat','U_1','apply','owner',
         'running','stop','[]',?,NULL
       )`,
    )
    .run(time);
  if (includeOperation) {
    database
      .prepare(
        `INSERT INTO run_operations(
           run_id,plan_id,operation_id,sequence,status,reconciliation,attempts,
           before_json,after_json,external_request_id,error_json,started_at,finished_at
         ) VALUES (
           'run_1','plan_1','op_1',0,'pending','not_required',0,
           '{}','null',NULL,NULL,NULL,NULL
         )`,
      )
      .run();
  }
}

describe("raw SQL relationship and JSON constraints", () => {
  test("requires exact three-column account bindings", () => {
    const database = migrated();
    database
      .prepare(
        "INSERT INTO accounts(host,login,account_id) VALUES ('github.com','one','U_1')",
      )
      .run();
    expect(() =>
      database
        .prepare(
          `INSERT INTO snapshots(
             snapshot_id,host,login,account_id,mode,status,list_coverage,
             lease_name,lease_owner_id,started_at
           ) VALUES (
             'snap','github.com','other','U_1','full','building','omitted',
             'sync','owner',?
           )`,
        )
        .run(time),
    ).toThrow();
    database.close();
  });

  test("rejects mismatched pinned versions and orphan final Stars", () => {
    const database = migrated();
    insertAccountAndSnapshot(database);
    insertRepository(database);
    expect(() =>
      database
        .prepare(
          `INSERT INTO snapshot_repositories(
             snapshot_id,repository_id,version_hash,observed_at
           ) VALUES ('snap_1','R_1',?,?)`,
        )
        .run("b".repeat(64), time),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO snapshot_stars(snapshot_id,repository_id,starred_at)
           VALUES ('snap_1','R_1',?)`,
        )
        .run(time),
    ).toThrow();
    database.close();
  });

  test("prevents cross-snapshot membership splicing", () => {
    const database = migrated();
    insertAccountAndSnapshot(database, "snap_1");
    insertAccountAndSnapshot(database, "snap_2");
    insertRepository(database);
    for (const snapshotId of ["snap_1", "snap_2"]) {
      database
        .prepare(
          `INSERT INTO snapshot_repositories(
             snapshot_id,repository_id,version_hash,observed_at
           ) VALUES (?,'R_1',?,?)`,
        )
        .run(snapshotId, "a".repeat(64), time);
    }
    database
      .prepare(
        `INSERT INTO snapshot_stars(snapshot_id,repository_id,starred_at)
         VALUES ('snap_2','R_1',?)`,
      )
      .run(time);
    database
      .prepare(
        `INSERT INTO user_lists(
           snapshot_id,list_id,name,slug,description,is_private,
           created_at,updated_at,last_added_at
         ) VALUES ('snap_1','L_1','List','list',NULL,0,?,?,NULL)`,
      )
      .run(time, time);
    expect(() =>
      database
        .prepare(
          `INSERT INTO list_memberships(snapshot_id,list_id,repository_id)
           VALUES ('snap_1','L_1','R_1')`,
        )
        .run(),
    ).toThrow();
    database.close();
  });

  test.each([
    "not-json",
    "null",
    "[]",
    "{}",
    '{"retryable":0}',
    '{"retryable":1}',
    '{"retryable":"true"}',
    '{"retryable":[]}',
    '{"retryable":{}}',
    '{"retryable":null}',
  ])("rejects non-Boolean retryable error JSON %s", (errorJson) => {
    const database = migrated();
    insertPlanRunGraph(database);
    expect(() =>
      database
        .prepare(
          `UPDATE run_operations SET
             status='failed',reconciliation='confirmed_not_applied',
             error_json=?,finished_at=?
           WHERE run_id='run_1' AND operation_id='op_1'`,
        )
        .run(errorJson, later),
    ).toThrow();
    database.close();
  });

  test.each([
    ["executable_json", "[]"],
    ["executable_json", "null"],
    ["warnings_json", "{}"],
    ["summary_json", "[]"],
    ["summary_json", "not-json"],
  ])("rejects wrong required JSON root in %s", (column, value) => {
    const database = migrated();
    insertAccountAndSnapshot(database);
    expect(() =>
      database
        .prepare(
          `INSERT INTO plans(
             plan_id,state,host,login,account_id,snapshot_id,hash,
             executable_json,created_at,expires_at,caller_note,warnings_json,
             summary_json
           ) VALUES (
             'plan','ready','github.com','octocat','U_1','snap_1',?,
             ${column === "executable_json" ? "?" : "'{}'"},
             ?,'2026-07-17T00:00:00.000Z',NULL,
             ${column === "warnings_json" ? "?" : "'[]'"},
             ${column === "summary_json" ? "?" : "'{}'"}
           )`,
        )
        .run(
          "a".repeat(64),
          ...(column === "executable_json" ? [value] : []),
          time,
          ...(column === "warnings_json" ? [value] : []),
          ...(column === "summary_json" ? [value] : []),
        ),
    ).toThrow();
    database.close();
  });

  test("enforces evidence bounds, Boolean, and strict expiry", () => {
    const database = migrated();
    insertRepository(database);
    const insert = database.prepare(
      `INSERT INTO repository_evidence(
         repository_id,source_ref,content,etag,truncated,fetched_at,expires_at
       ) VALUES ('R_1',?,?,?,?,?,?)`,
    );
    expect(() =>
      insert.run("source", "x".repeat(65_537), null, 0, time, later),
    ).toThrow();
    expect(() => insert.run("source", "", null, 2, time, later)).toThrow();
    expect(() => insert.run("source", "", "", 0, time, later)).toThrow();
    expect(() => insert.run("source", "", null, 0, time, time)).toThrow();
    expect(() => insert.run("", "", null, 0, time, later)).toThrow();
    database.close();
  });

  test("rejects invalid repository Booleans and empty normalized List names or slugs", () => {
    const database = migrated();
    insertAccountAndSnapshot(database);
    insertRepository(database);
    expect(() =>
      database
        .prepare(
          `INSERT INTO repository_versions(
             repository_id,version_hash,owner,name,full_name,description,url,
             stargazer_count,is_fork,is_archived,is_disabled,is_private,
             visibility,primary_language,topics_json,license_spdx_id,pushed_at,
             updated_at
           ) VALUES (
             'R_1',?,'owner','repo','owner/repo',NULL,
             'https://github.com/owner/repo',1,2,0,0,0,'public',NULL,'[]',
             NULL,NULL,?
           )`,
        )
        .run("b".repeat(64), time),
    ).toThrow();
    const insertList = database.prepare(
      `INSERT INTO user_lists(
         snapshot_id,list_id,name,slug,description,is_private,
         created_at,updated_at,last_added_at
       ) VALUES ('snap_1','L_1',?,?,NULL,0,?,?,NULL)`,
    );
    expect(() => insertList.run("", "slug", time, time)).toThrow();
    expect(() => insertList.run("Name", "", time, time)).toThrow();
    database.close();
  });

  test("rejects duplicate final Star, List, and membership identities", () => {
    const database = migrated();
    insertAccountAndSnapshot(database);
    insertRepository(database);
    database
      .prepare(
        `INSERT INTO snapshot_repositories(
           snapshot_id,repository_id,version_hash,observed_at
         ) VALUES ('snap_1','R_1',?,?)`,
      )
      .run("a".repeat(64), time);
    const insertStar = database.prepare(
      `INSERT INTO snapshot_stars(snapshot_id,repository_id,starred_at)
       VALUES ('snap_1','R_1',?)`,
    );
    insertStar.run(time);
    expect(() => insertStar.run(time)).toThrow();
    const insertList = database.prepare(
      `INSERT INTO user_lists(
         snapshot_id,list_id,name,slug,description,is_private,
         created_at,updated_at,last_added_at
       ) VALUES ('snap_1','L_1','List','list',NULL,0,?,?,NULL)`,
    );
    insertList.run(time, time);
    expect(() => insertList.run(time, time)).toThrow();
    const insertMembership = database.prepare(
      `INSERT INTO list_memberships(snapshot_id,list_id,repository_id)
       VALUES ('snap_1','L_1','R_1')`,
    );
    insertMembership.run();
    expect(() => insertMembership.run()).toThrow();
    database.close();
  });

  test("requires operation JSON to have an object root", () => {
    const database = migrated();
    insertAccountAndSnapshot(database);
    database
      .prepare(
        `INSERT INTO plans(
           plan_id,state,host,login,account_id,snapshot_id,hash,executable_json,
           created_at,expires_at,caller_note,warnings_json,summary_json
         ) VALUES (
           'plan_1','ready','github.com','octocat','U_1','snap_1',?,
           '{}',?,'2026-07-17T00:00:00.000Z',NULL,'[]','{}'
         )`,
      )
      .run("a".repeat(64), time);
    expect(() =>
      database
        .prepare(
          `INSERT INTO plan_operations(
             plan_id,operation_id,sequence,kind,operation_json
           ) VALUES ('plan_1','op_1',0,'star','[]')`,
        )
        .run(),
    ).toThrow();
    database.close();
  });

  test("requires attempt and event sequences to start at one", () => {
    const database = migrated();
    insertPlanRunGraph(database);
    expect(() =>
      database
        .prepare(
          `INSERT INTO run_operation_attempts(
             run_id,operation_id,attempt,status,reconciliation,before_json,
             after_json,external_request_id,error_json,started_at,finished_at
           ) VALUES (
             'run_1','op_1',0,'running','pending','{}','null',
             NULL,NULL,?,NULL
           )`,
        )
        .run(time),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO run_operation_reconciliations(
             run_id,operation_id,attempt,event_sequence,status,reconciliation,
             after_json,error_json,observed_at
           ) VALUES (
             'run_1','op_1',1,0,'succeeded','confirmed_applied','{}',NULL,?
           )`,
        )
        .run(later),
    ).toThrow();
    database.close();
  });
});

describe("run attempt and reconciliation triggers", () => {
  test("accepts only an initial pending operation projection", () => {
    const database = migrated();
    insertPlanRunGraph(database, false);
    const insert = database.prepare(
      `INSERT INTO run_operations(
         run_id,plan_id,operation_id,sequence,status,reconciliation,attempts,
         before_json,after_json,external_request_id,error_json,started_at,finished_at
       ) VALUES (
         'run_1','plan_1','op_1',0,@status,@reconciliation,@attempts,
         '{}','null',NULL,NULL,@startedAt,NULL
       )`,
    );
    expect(() =>
      insert.run({
        status: "running",
        reconciliation: "pending",
        attempts: 1,
        startedAt: time,
      }),
    ).toThrow(/must be inserted pending/u);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) FROM run_operations
           WHERE run_id='run_1' AND operation_id='op_1'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(() =>
      insert.run({
        status: "pending",
        reconciliation: "not_required",
        attempts: 0,
        startedAt: null,
      }),
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT status,reconciliation,attempts
           FROM run_operations
           WHERE run_id='run_1' AND operation_id='op_1'`,
        )
        .get(),
    ).toEqual({
      status: "pending",
      reconciliation: "not_required",
      attempts: 0,
    });
    database.close();
  });

  test("requires an attempt to match the current running projection", () => {
    const database = migrated();
    insertPlanRunGraph(database);
    const insertAttempt = database.prepare(
      `INSERT INTO run_operation_attempts(
         run_id,operation_id,attempt,status,reconciliation,before_json,
         after_json,external_request_id,error_json,started_at,finished_at
       ) VALUES (
         'run_1','op_1',1,'running','pending','{}','null',
         NULL,NULL,?,NULL
       )`,
    );
    expect(() => insertAttempt.run(time)).toThrow(
      /matching running projection/u,
    );
    database
      .prepare(
        `UPDATE run_operations SET
           status='running',reconciliation='pending',attempts=1,started_at=?
         WHERE run_id='run_1' AND operation_id='op_1'`,
      )
      .run(time);
    expect(() => insertAttempt.run(time)).not.toThrow();
    database.close();
  });

  test("binds reconciliation events to the current ambiguous attempt and projection", () => {
    const database = migrated();
    insertPlanRunGraph(database);
    database
      .prepare(
        `UPDATE run_operations SET
           status='running',reconciliation='pending',attempts=1,started_at=?
         WHERE run_id='run_1' AND operation_id='op_1'`,
      )
      .run(time);
    database
      .prepare(
        `INSERT INTO run_operation_attempts(
           run_id,operation_id,attempt,status,reconciliation,before_json,
           after_json,external_request_id,error_json,started_at,finished_at
         ) VALUES (
           'run_1','op_1',1,'running','pending','{}','null',
           NULL,NULL,?,NULL
         )`,
      )
      .run(time);
    const ambiguousError = JSON.stringify({
      code: "INTERNAL_ERROR",
      message: "ambiguous",
      retryable: false,
      details: {},
    });
    database
      .prepare(
        `UPDATE run_operation_attempts SET
           status='unresolved',reconciliation='unknown',after_json='{}',
           error_json=?,finished_at=?
         WHERE run_id='run_1' AND operation_id='op_1' AND attempt=1`,
      )
      .run(ambiguousError, later);
    database
      .prepare(
        `UPDATE run_operations SET
           status='unresolved',reconciliation='unknown',after_json='{}',
           error_json=?,finished_at=?
         WHERE run_id='run_1' AND operation_id='op_1'`,
      )
      .run(ambiguousError, later);

    const eventInsert = database.prepare(
      `INSERT INTO run_operation_reconciliations(
         run_id,operation_id,attempt,event_sequence,status,reconciliation,
         after_json,error_json,observed_at
       ) VALUES (
         'run_1','op_1',1,1,'succeeded','confirmed_applied','{"ok":true}',NULL,?
       )`,
    );
    expect(() => eventInsert.run(time)).toThrow(
      /current reconcilable attempt/u,
    );
    database.exec("BEGIN");
    eventInsert.run("2026-07-16T00:02:00.000Z");
    expect(() =>
      database
        .prepare(
          `UPDATE run_operations SET
             status='succeeded',reconciliation='confirmed_applied',
             after_json='{"ok":true}',error_json=NULL,finished_at=?
           WHERE run_id='run_1' AND operation_id='op_1'`,
        )
        .run("2026-07-16T00:03:00.000Z"),
    ).toThrow(/matching latest event/u);
    database.exec("ROLLBACK");

    database.exec("BEGIN");
    eventInsert.run("2026-07-16T00:02:00.000Z");
    database
      .prepare(
        `UPDATE run_operations SET
           status='succeeded',reconciliation='confirmed_applied',
           after_json='{"ok":true}',error_json=NULL,finished_at=?
         WHERE run_id='run_1' AND operation_id='op_1'`,
      )
      .run("2026-07-16T00:02:00.000Z");
    database.exec("COMMIT");
    expect(() =>
      database
        .prepare(
          `UPDATE run_operation_reconciliations SET after_json='{}'
           WHERE run_id='run_1' AND operation_id='op_1'`,
        )
        .run(),
    ).toThrow(/append-only/u);
    expect(() =>
      database
        .prepare(
          `DELETE FROM run_operation_reconciliations
           WHERE run_id='run_1' AND operation_id='op_1'`,
        )
        .run(),
    ).toThrow(/append-only/u);
    database.close();
  });
});
