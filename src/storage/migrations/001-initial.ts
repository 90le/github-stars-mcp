function requiredTimestamp(column: string): string {
  return `COALESCE(
    typeof(${column})='text'
    AND length(CAST(${column} AS BLOB))=24
    AND ${column} GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND substr(${column},12,2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',${column})=${column},
    0
  )`;
}

function optionalTimestamp(column: string): string {
  return `${column} IS NULL OR ${requiredTimestamp(column)}`;
}

function requiredJson(column: string, root: "array" | "object"): string {
  return `CASE
    WHEN json_valid(${column})=1
      THEN COALESCE(json_type(${column})='${root}',0)
    ELSE 0
  END`;
}

function optionalErrorJson(column: string): string {
  return `${column} IS NULL OR CASE
    WHEN json_valid(${column})=1 THEN COALESCE(
      json_type(${column})='object'
      AND json_type(${column},'$.retryable') IN ('true','false'),
      0
    )
    ELSE 0
  END`;
}

function requiredErrorBoolean(column: string, value: "true" | "false"): string {
  return `CASE
    WHEN json_valid(${column})=1 THEN COALESCE(
      json_type(${column})='object'
      AND json_type(${column},'$.retryable')='${value}',
      0
    )
    ELSE 0
  END`;
}

const ts = requiredTimestamp;
const optionalTs = optionalTimestamp;

export const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY
    CHECK(version BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL UNIQUE
    CHECK(length(name)>0 AND name=trim(name) AND instr(name,char(0))=0),
  checksum TEXT NOT NULL
    CHECK(
      length(CAST(checksum AS BLOB))=64
      AND length(checksum)=64
      AND instr(checksum,char(0))=0
      AND checksum NOT GLOB '*[^0-9a-f]*'
    ),
  applied_at TEXT NOT NULL CHECK(${ts("applied_at")})
) STRICT;`.trim();

export const INITIAL_MIGRATION_SQL = `
${SCHEMA_MIGRATIONS_SQL}

CREATE TABLE runtime_secrets(
  name TEXT PRIMARY KEY
    CHECK(length(name)>0 AND name=trim(name) AND instr(name,char(0))=0),
  value BLOB NOT NULL CHECK(typeof(value)='blob' AND length(value)>=32),
  created_at TEXT NOT NULL CHECK(${ts("created_at")}),
  CHECK(name<>'cursor_hmac_sha256_v1' OR length(value)=32)
) STRICT;

CREATE TABLE leases(
  name TEXT PRIMARY KEY
    CHECK(length(name)>0 AND name=trim(name) AND instr(name,char(0))=0),
  owner_id TEXT NOT NULL
    CHECK(length(owner_id)>0 AND owner_id=trim(owner_id) AND instr(owner_id,char(0))=0),
  acquired_at TEXT NOT NULL CHECK(${ts("acquired_at")}),
  heartbeat_at TEXT NOT NULL CHECK(${ts("heartbeat_at")}),
  expires_at TEXT NOT NULL CHECK(${ts("expires_at")}),
  CHECK(acquired_at<=heartbeat_at AND heartbeat_at<expires_at)
) STRICT;

CREATE TABLE accounts(
  host TEXT NOT NULL CHECK(host='github.com'),
  login TEXT NOT NULL
    CHECK(length(login)>0 AND login=trim(login) AND instr(login,char(0))=0),
  account_id TEXT NOT NULL
    CHECK(length(account_id)>0 AND account_id=trim(account_id) AND instr(account_id,char(0))=0),
  PRIMARY KEY(host,account_id),
  UNIQUE(host,login),
  UNIQUE(host,login,account_id)
) STRICT;

CREATE TABLE repositories(
  repository_id TEXT PRIMARY KEY
    CHECK(length(repository_id)>0 AND repository_id=trim(repository_id) AND instr(repository_id,char(0))=0),
  repository_database_id TEXT NOT NULL UNIQUE
    CHECK(
      typeof(repository_database_id)='text'
      AND instr(repository_database_id,char(0))=0
      AND (
      repository_database_id='0'
      OR (
        repository_database_id GLOB '[1-9]*'
        AND repository_database_id NOT GLOB '*[^0-9]*'
      )
      )
    ),
  current_version_hash TEXT NOT NULL
    CHECK(
      length(CAST(current_version_hash AS BLOB))=64
      AND length(current_version_hash)=64
      AND instr(current_version_hash,char(0))=0
      AND current_version_hash NOT GLOB '*[^0-9a-f]*'
    ),
  observed_at TEXT NOT NULL CHECK(${ts("observed_at")}),
  FOREIGN KEY(repository_id,current_version_hash)
    REFERENCES repository_versions(repository_id,version_hash)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE repository_versions(
  repository_id TEXT NOT NULL
    CHECK(length(repository_id)>0 AND repository_id=trim(repository_id) AND instr(repository_id,char(0))=0),
  version_hash TEXT NOT NULL
    CHECK(
      length(CAST(version_hash AS BLOB))=64
      AND length(version_hash)=64
      AND instr(version_hash,char(0))=0
      AND version_hash NOT GLOB '*[^0-9a-f]*'
    ),
  owner TEXT NOT NULL CHECK(length(owner)>0 AND owner=trim(owner) AND instr(owner,char(0))=0),
  name TEXT NOT NULL CHECK(length(name)>0 AND name=trim(name) AND instr(name,char(0))=0),
  full_name TEXT NOT NULL CHECK(length(full_name)>0 AND full_name=trim(full_name) AND instr(full_name,char(0))=0),
  description TEXT CHECK(description IS NULL OR instr(description,char(0))=0),
  url TEXT NOT NULL CHECK(length(url)>0 AND url=trim(url) AND instr(url,char(0))=0),
  stargazer_count INTEGER NOT NULL
    CHECK(stargazer_count BETWEEN 0 AND 9007199254740991),
  is_fork INTEGER NOT NULL CHECK(is_fork IN(0,1)),
  is_archived INTEGER NOT NULL CHECK(is_archived IN(0,1)),
  is_disabled INTEGER NOT NULL CHECK(is_disabled IN(0,1)),
  is_private INTEGER NOT NULL CHECK(is_private IN(0,1)),
  visibility TEXT NOT NULL CHECK(visibility IN('public','private','internal')),
  primary_language TEXT
    CHECK(primary_language IS NULL OR (length(primary_language)>0 AND primary_language=trim(primary_language))),
  topics_json TEXT NOT NULL CHECK(${requiredJson("topics_json", "array")}),
  license_spdx_id TEXT CHECK(license_spdx_id IS NULL OR instr(license_spdx_id,char(0))=0),
  pushed_at TEXT CHECK(${optionalTs("pushed_at")}),
  updated_at TEXT NOT NULL CHECK(${ts("updated_at")}),
  PRIMARY KEY(repository_id,version_hash),
  FOREIGN KEY(repository_id) REFERENCES repositories(repository_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE snapshots(
  snapshot_id TEXT PRIMARY KEY
    CHECK(length(snapshot_id)>0 AND snapshot_id=trim(snapshot_id) AND instr(snapshot_id,char(0))=0),
  host TEXT NOT NULL CHECK(host='github.com'),
  login TEXT NOT NULL CHECK(length(login)>0 AND login=trim(login) AND instr(login,char(0))=0),
  account_id TEXT NOT NULL CHECK(length(account_id)>0 AND account_id=trim(account_id) AND instr(account_id,char(0))=0),
  mode TEXT NOT NULL CHECK(mode IN('full','incremental')),
  status TEXT NOT NULL CHECK(status IN('building','complete','failed')),
  list_coverage TEXT NOT NULL CHECK(list_coverage IN('collecting','complete','unavailable','omitted')),
  lease_name TEXT NOT NULL CHECK(length(lease_name)>0 AND lease_name=trim(lease_name) AND instr(lease_name,char(0))=0),
  lease_owner_id TEXT NOT NULL CHECK(length(lease_owner_id)>0 AND lease_owner_id=trim(lease_owner_id) AND instr(lease_owner_id,char(0))=0),
  started_at TEXT NOT NULL CHECK(${ts("started_at")}),
  completed_at TEXT CHECK(${optionalTs("completed_at")}),
  failed_at TEXT CHECK(${optionalTs("failed_at")}),
  repositories_count INTEGER NOT NULL DEFAULT 0
    CHECK(repositories_count BETWEEN 0 AND 9007199254740991),
  stars_count INTEGER NOT NULL DEFAULT 0
    CHECK(stars_count BETWEEN 0 AND 9007199254740991),
  lists_count INTEGER NOT NULL DEFAULT 0
    CHECK(lists_count BETWEEN 0 AND 9007199254740991),
  memberships_count INTEGER NOT NULL DEFAULT 0
    CHECK(memberships_count BETWEEN 0 AND 9007199254740991),
  warning_count INTEGER NOT NULL DEFAULT 0
    CHECK(warning_count BETWEEN 0 AND 9007199254740991),
  source_rate_limit_json TEXT CHECK(
    source_rate_limit_json IS NULL OR json_valid(source_rate_limit_json)=1
  ),
  UNIQUE(snapshot_id,host,login,account_id),
  FOREIGN KEY(host,login,account_id)
    REFERENCES accounts(host,login,account_id),
  CHECK(
    (status='building' AND completed_at IS NULL AND failed_at IS NULL) OR
    (status='complete' AND completed_at IS NOT NULL AND failed_at IS NULL) OR
    (status='failed' AND completed_at IS NULL AND failed_at IS NOT NULL)
  ),
  CHECK(
    (status IN('building','failed') AND list_coverage<>'complete') OR
    (status='complete' AND list_coverage<>'collecting')
  ),
  CHECK(completed_at IS NULL OR completed_at>=started_at),
  CHECK(failed_at IS NULL OR failed_at>=started_at),
  CHECK(list_coverage IN('collecting','complete') OR (lists_count=0 AND memberships_count=0))
) STRICT;

CREATE TABLE snapshot_repositories(
  snapshot_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  version_hash TEXT NOT NULL
    CHECK(
      length(CAST(version_hash AS BLOB))=64
      AND length(version_hash)=64
      AND instr(version_hash,char(0))=0
      AND version_hash NOT GLOB '*[^0-9a-f]*'
    ),
  observed_at TEXT NOT NULL CHECK(${ts("observed_at")}),
  PRIMARY KEY(snapshot_id,repository_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY(repository_id,version_hash)
    REFERENCES repository_versions(repository_id,version_hash) ON DELETE RESTRICT
) STRICT;

CREATE TABLE snapshot_star_staging(
  snapshot_id TEXT NOT NULL,
  repository_id TEXT NOT NULL
    CHECK(length(repository_id)>0 AND repository_id=trim(repository_id) AND instr(repository_id,char(0))=0),
  starred_at TEXT NOT NULL CHECK(${ts("starred_at")}),
  PRIMARY KEY(snapshot_id,repository_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE snapshot_stars(
  snapshot_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  starred_at TEXT NOT NULL CHECK(${ts("starred_at")}),
  PRIMARY KEY(snapshot_id,repository_id),
  FOREIGN KEY(snapshot_id,repository_id)
    REFERENCES snapshot_repositories(snapshot_id,repository_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE user_lists(
  snapshot_id TEXT NOT NULL,
  list_id TEXT NOT NULL CHECK(length(list_id)>0 AND list_id=trim(list_id) AND instr(list_id,char(0))=0),
  name TEXT NOT NULL CHECK(length(name)>0 AND name=trim(name) AND instr(name,char(0))=0),
  slug TEXT NOT NULL CHECK(length(slug)>0 AND slug=trim(slug) AND instr(slug,char(0))=0),
  description TEXT CHECK(description IS NULL OR instr(description,char(0))=0),
  is_private INTEGER NOT NULL CHECK(is_private IN(0,1)),
  created_at TEXT NOT NULL CHECK(${ts("created_at")}),
  updated_at TEXT NOT NULL CHECK(${ts("updated_at")}),
  last_added_at TEXT CHECK(${optionalTs("last_added_at")}),
  PRIMARY KEY(snapshot_id,list_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE list_membership_staging(
  snapshot_id TEXT NOT NULL,
  list_id TEXT NOT NULL CHECK(length(list_id)>0 AND list_id=trim(list_id) AND instr(list_id,char(0))=0),
  repository_id TEXT NOT NULL CHECK(length(repository_id)>0 AND repository_id=trim(repository_id) AND instr(repository_id,char(0))=0),
  PRIMARY KEY(snapshot_id,list_id,repository_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE list_memberships(
  snapshot_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,list_id,repository_id),
  FOREIGN KEY(snapshot_id,list_id)
    REFERENCES user_lists(snapshot_id,list_id) ON DELETE CASCADE,
  FOREIGN KEY(snapshot_id,repository_id)
    REFERENCES snapshot_stars(snapshot_id,repository_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE snapshot_verifications(
  snapshot_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN('collecting','verified')),
  list_coverage TEXT NOT NULL CHECK(list_coverage IN('complete','unavailable','omitted')),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE snapshot_verification_stars(
  snapshot_id TEXT NOT NULL,
  repository_id TEXT NOT NULL CHECK(length(repository_id)>0 AND repository_id=trim(repository_id) AND instr(repository_id,char(0))=0),
  starred_at TEXT NOT NULL CHECK(${ts("starred_at")}),
  PRIMARY KEY(snapshot_id,repository_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshot_verifications(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE snapshot_verification_lists(
  snapshot_id TEXT NOT NULL,
  list_id TEXT NOT NULL CHECK(length(list_id)>0 AND list_id=trim(list_id) AND instr(list_id,char(0))=0),
  name TEXT NOT NULL CHECK(length(name)>0 AND name=trim(name) AND instr(name,char(0))=0),
  slug TEXT NOT NULL CHECK(length(slug)>0 AND slug=trim(slug) AND instr(slug,char(0))=0),
  description TEXT CHECK(description IS NULL OR instr(description,char(0))=0),
  is_private INTEGER NOT NULL CHECK(is_private IN(0,1)),
  created_at TEXT NOT NULL CHECK(${ts("created_at")}),
  updated_at TEXT NOT NULL CHECK(${ts("updated_at")}),
  last_added_at TEXT CHECK(${optionalTs("last_added_at")}),
  PRIMARY KEY(snapshot_id,list_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshot_verifications(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE snapshot_verification_memberships(
  snapshot_id TEXT NOT NULL,
  list_id TEXT NOT NULL CHECK(length(list_id)>0 AND list_id=trim(list_id) AND instr(list_id,char(0))=0),
  repository_id TEXT NOT NULL CHECK(length(repository_id)>0 AND repository_id=trim(repository_id) AND instr(repository_id,char(0))=0),
  PRIMARY KEY(snapshot_id,list_id,repository_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshot_verifications(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE repository_evidence(
  repository_id TEXT NOT NULL,
  source_ref TEXT NOT NULL CHECK(
    length(source_ref) BETWEEN 1 AND 2048
    AND length(CAST(source_ref AS BLOB)) BETWEEN 1 AND 8192
    AND instr(source_ref,char(0))=0
  ),
  content TEXT NOT NULL CHECK(
    length(content)<=65536
    AND length(CAST(content AS BLOB))<=262144
    AND instr(content,char(0))=0
  ),
  etag TEXT CHECK(etag IS NULL OR (
    length(etag) BETWEEN 1 AND 1024
    AND length(CAST(etag AS BLOB))<=4096
    AND instr(etag,char(0))=0
  )),
  truncated INTEGER NOT NULL CHECK(truncated IN(0,1)),
  fetched_at TEXT NOT NULL CHECK(${ts("fetched_at")}),
  expires_at TEXT NOT NULL CHECK(${ts("expires_at")}),
  PRIMARY KEY(repository_id,source_ref),
  FOREIGN KEY(repository_id) REFERENCES repositories(repository_id) ON DELETE CASCADE,
  CHECK(expires_at>fetched_at)
) STRICT;

CREATE TABLE plans(
  plan_id TEXT PRIMARY KEY CHECK(length(plan_id)>0 AND plan_id=trim(plan_id) AND instr(plan_id,char(0))=0),
  state TEXT NOT NULL CHECK(state IN('ready','applying','applied','partial','expired','failed','superseded')),
  host TEXT NOT NULL CHECK(host='github.com'),
  login TEXT NOT NULL CHECK(length(login)>0 AND login=trim(login)),
  account_id TEXT NOT NULL CHECK(length(account_id)>0 AND account_id=trim(account_id)),
  snapshot_id TEXT NOT NULL,
  hash TEXT NOT NULL CHECK(
    length(CAST(hash AS BLOB))=64
    AND length(hash)=64
    AND instr(hash,char(0))=0
    AND hash NOT GLOB '*[^0-9a-f]*'
  ),
  executable_json TEXT NOT NULL CHECK(${requiredJson("executable_json", "object")}),
  created_at TEXT NOT NULL CHECK(${ts("created_at")}),
  expires_at TEXT NOT NULL CHECK(${ts("expires_at")}),
  caller_note TEXT CHECK(caller_note IS NULL OR instr(caller_note,char(0))=0),
  warnings_json TEXT NOT NULL CHECK(${requiredJson("warnings_json", "array")}),
  summary_json TEXT NOT NULL CHECK(${requiredJson("summary_json", "object")}),
  UNIQUE(plan_id,host,login,account_id),
  FOREIGN KEY(snapshot_id,host,login,account_id)
    REFERENCES snapshots(snapshot_id,host,login,account_id),
  CHECK(created_at<expires_at)
) STRICT;

CREATE TABLE plan_operations(
  plan_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id)>0 AND operation_id=trim(operation_id) AND instr(operation_id,char(0))=0),
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK(kind IN('star','unstar','list_create','list_update','list_delete','list_membership_set')),
  operation_json TEXT NOT NULL CHECK(${requiredJson("operation_json", "object")}),
  PRIMARY KEY(plan_id,operation_id),
  UNIQUE(plan_id,sequence),
  UNIQUE(plan_id,operation_id,sequence),
  FOREIGN KEY(plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE plan_operation_dependencies(
  plan_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  depends_on_operation_id TEXT NOT NULL,
  PRIMARY KEY(plan_id,operation_id,depends_on_operation_id),
  FOREIGN KEY(plan_id,operation_id)
    REFERENCES plan_operations(plan_id,operation_id) ON DELETE CASCADE,
  FOREIGN KEY(plan_id,depends_on_operation_id)
    REFERENCES plan_operations(plan_id,operation_id) ON DELETE CASCADE,
  CHECK(operation_id<>depends_on_operation_id)
) STRICT;

CREATE TABLE runs(
  run_id TEXT PRIMARY KEY CHECK(length(run_id)>0 AND run_id=trim(run_id) AND instr(run_id,char(0))=0),
  plan_id TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL CHECK(host='github.com'),
  login TEXT NOT NULL CHECK(length(login)>0 AND login=trim(login)),
  account_id TEXT NOT NULL CHECK(length(account_id)>0 AND account_id=trim(account_id)),
  lease_name TEXT NOT NULL CHECK(length(lease_name)>0 AND lease_name=trim(lease_name) AND instr(lease_name,char(0))=0),
  lease_owner_id TEXT NOT NULL CHECK(length(lease_owner_id)>0 AND lease_owner_id=trim(lease_owner_id) AND instr(lease_owner_id,char(0))=0),
  state TEXT NOT NULL CHECK(state IN('pending','running','completed','partial','failed')),
  failure_mode TEXT NOT NULL CHECK(failure_mode IN('stop','continue')),
  warnings_json TEXT NOT NULL CHECK(${requiredJson("warnings_json", "array")}),
  started_at TEXT NOT NULL CHECK(${ts("started_at")}),
  finished_at TEXT CHECK(${optionalTs("finished_at")}),
  UNIQUE(run_id,plan_id),
  FOREIGN KEY(plan_id,host,login,account_id)
    REFERENCES plans(plan_id,host,login,account_id),
  CHECK(
    (state IN('pending','running') AND finished_at IS NULL) OR
    (state IN('completed','partial','failed') AND finished_at IS NOT NULL)
  ),
  CHECK(finished_at IS NULL OR finished_at>=started_at)
) STRICT;

CREATE TABLE run_operations(
  run_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id)>0 AND operation_id=trim(operation_id) AND instr(operation_id,char(0))=0),
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN('pending','running','succeeded','skipped','failed','unresolved')),
  reconciliation TEXT NOT NULL CHECK(reconciliation IN('not_required','pending','confirmed_applied','confirmed_not_applied','unknown')),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 9007199254740991),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)=1),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)=1),
  external_request_id TEXT CHECK(external_request_id IS NULL OR (length(external_request_id)>0 AND external_request_id=trim(external_request_id))),
  error_json TEXT CHECK(${optionalErrorJson("error_json")}),
  started_at TEXT CHECK(${optionalTs("started_at")}),
  finished_at TEXT CHECK(${optionalTs("finished_at")}),
  PRIMARY KEY(run_id,operation_id),
  UNIQUE(run_id,sequence),
  FOREIGN KEY(run_id,plan_id) REFERENCES runs(run_id,plan_id) ON DELETE CASCADE,
  FOREIGN KEY(plan_id,operation_id,sequence)
    REFERENCES plan_operations(plan_id,operation_id,sequence),
  CHECK(
    (status='pending' AND reconciliation='not_required'
      AND started_at IS NULL AND finished_at IS NULL
      AND external_request_id IS NULL AND error_json IS NULL
      AND CASE WHEN json_valid(after_json)=1 THEN COALESCE(json_type(after_json)='null',0) ELSE 0 END)
    OR
    (status='running' AND reconciliation='pending' AND attempts>=1
      AND started_at IS NOT NULL AND finished_at IS NULL
      AND external_request_id IS NULL AND error_json IS NULL
      AND CASE WHEN json_valid(after_json)=1 THEN COALESCE(json_type(after_json)='null',0) ELSE 0 END)
    OR
    (status='skipped' AND reconciliation='not_required'
      AND started_at IS NULL AND finished_at IS NOT NULL
      AND external_request_id IS NULL AND error_json IS NULL
      AND CASE WHEN json_valid(after_json)=1 THEN COALESCE(json_type(after_json)='null',0) ELSE 0 END)
    OR
    (status='succeeded' AND reconciliation IN('not_required','confirmed_applied')
      AND attempts>=1 AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_json IS NULL)
    OR
    (status='failed' AND reconciliation='confirmed_not_applied'
      AND finished_at IS NOT NULL AND error_json IS NOT NULL
      AND CASE WHEN json_valid(error_json)=1 THEN COALESCE(
        json_type(error_json)='object'
        AND json_type(error_json,'$.retryable') IN('true','false'),0
      ) ELSE 0 END
      AND (
        (started_at IS NULL AND external_request_id IS NULL
          AND CASE WHEN json_valid(after_json)=1 THEN COALESCE(json_type(after_json)='null',0) ELSE 0 END)
        OR (started_at IS NOT NULL AND attempts>=1)
      ))
    OR
    (status='unresolved' AND reconciliation='unknown' AND attempts>=1
      AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND error_json IS NOT NULL AND ${requiredErrorBoolean("error_json", "false")})
  ),
  CHECK(finished_at IS NULL OR started_at IS NULL OR finished_at>=started_at)
) STRICT;

CREATE TABLE run_operation_attempts(
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN('running','succeeded','failed','unresolved')),
  reconciliation TEXT NOT NULL CHECK(reconciliation IN('not_required','pending','confirmed_applied','confirmed_not_applied','unknown')),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)=1),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)=1),
  external_request_id TEXT CHECK(external_request_id IS NULL OR (length(external_request_id)>0 AND external_request_id=trim(external_request_id))),
  error_json TEXT CHECK(${optionalErrorJson("error_json")}),
  started_at TEXT NOT NULL CHECK(${ts("started_at")}),
  finished_at TEXT CHECK(${optionalTs("finished_at")}),
  PRIMARY KEY(run_id,operation_id,attempt),
  FOREIGN KEY(run_id,operation_id)
    REFERENCES run_operations(run_id,operation_id) ON DELETE CASCADE,
  CHECK(
    (status='running' AND reconciliation='pending'
      AND finished_at IS NULL AND external_request_id IS NULL
      AND error_json IS NULL
      AND CASE WHEN json_valid(after_json)=1 THEN COALESCE(json_type(after_json)='null',0) ELSE 0 END)
    OR
    (status='succeeded' AND reconciliation='not_required'
      AND finished_at IS NOT NULL AND error_json IS NULL)
    OR
    (status='failed' AND reconciliation='confirmed_not_applied'
      AND finished_at IS NOT NULL AND error_json IS NOT NULL)
    OR
    (status='unresolved' AND reconciliation='unknown'
      AND finished_at IS NOT NULL AND error_json IS NOT NULL
      AND ${requiredErrorBoolean("error_json", "false")})
  ),
  CHECK(finished_at IS NULL OR finished_at>=started_at)
) STRICT;

CREATE TABLE run_operation_reconciliations(
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 9007199254740991),
  event_sequence INTEGER NOT NULL CHECK(event_sequence BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN('succeeded','failed','unresolved')),
  reconciliation TEXT NOT NULL CHECK(reconciliation IN('confirmed_applied','confirmed_not_applied','unknown')),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)=1),
  error_json TEXT CHECK(${optionalErrorJson("error_json")}),
  observed_at TEXT NOT NULL CHECK(${ts("observed_at")}),
  PRIMARY KEY(run_id,operation_id,event_sequence),
  FOREIGN KEY(run_id,operation_id,attempt)
    REFERENCES run_operation_attempts(run_id,operation_id,attempt) ON DELETE CASCADE,
  CHECK(
    (status='succeeded' AND reconciliation='confirmed_applied' AND error_json IS NULL)
    OR
    (status='failed' AND reconciliation='confirmed_not_applied'
      AND error_json IS NOT NULL AND ${requiredErrorBoolean("error_json", "true")})
    OR
    (status='unresolved' AND reconciliation='unknown'
      AND error_json IS NOT NULL AND ${requiredErrorBoolean("error_json", "false")})
  )
) STRICT;

CREATE INDEX snapshots_latest_complete
  ON snapshots(host,account_id,status,completed_at DESC,snapshot_id DESC);
CREATE INDEX snapshots_recovery_lease
  ON snapshots(status,lease_name,lease_owner_id,started_at,snapshot_id);
CREATE INDEX snapshot_repositories_version
  ON snapshot_repositories(repository_id,version_hash);
CREATE INDEX snapshot_stars_page
  ON snapshot_stars(snapshot_id,repository_id);
CREATE INDEX user_lists_order
  ON user_lists(snapshot_id,name COLLATE BINARY,list_id);
CREATE INDEX staging_memberships_reverse
  ON list_membership_staging(snapshot_id,repository_id,list_id);
CREATE INDEX memberships_reverse
  ON list_memberships(snapshot_id,repository_id,list_id);
CREATE INDEX repository_evidence_expiry
  ON repository_evidence(expires_at,repository_id);
CREATE INDEX dependencies_reverse
  ON plan_operation_dependencies(plan_id,depends_on_operation_id,operation_id);
CREATE INDEX run_operations_sequence
  ON run_operations(run_id,sequence,operation_id);
CREATE INDEX run_operations_plan
  ON run_operations(plan_id,operation_id,run_id);
CREATE INDEX runs_recovery_lease
  ON runs(state,lease_name,lease_owner_id,started_at,run_id);
CREATE INDEX run_attempts_sequence
  ON run_operation_attempts(run_id,operation_id,attempt);
CREATE INDEX reconciliations_sequence
  ON run_operation_reconciliations(run_id,operation_id,event_sequence);
CREATE INDEX reconciliations_attempt
  ON run_operation_reconciliations(run_id,operation_id,attempt,event_sequence);

CREATE TRIGGER run_operation_insert_requires_initial_projection
BEFORE INSERT ON run_operations
WHEN NEW.status<>'pending'
  OR NEW.reconciliation<>'not_required'
  OR NEW.attempts<>0
BEGIN
  SELECT RAISE(ABORT,'run operation must be inserted pending');
END;

CREATE TRIGGER run_operation_attempt_requires_current_projection
BEFORE INSERT ON run_operation_attempts
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM run_operations AS ro
    WHERE ro.run_id=NEW.run_id
      AND ro.operation_id=NEW.operation_id
      AND ro.status='running'
      AND ro.reconciliation='pending'
      AND ro.attempts=NEW.attempt
      AND NEW.status='running'
      AND NEW.reconciliation='pending'
  ) THEN RAISE(ABORT,'attempt requires matching running projection') END;
END;

CREATE TRIGGER reconciliation_requires_current_unresolved_attempt
BEFORE INSERT ON run_operation_reconciliations
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1
    FROM run_operations AS ro
    JOIN run_operation_attempts AS a
      ON a.run_id=ro.run_id
     AND a.operation_id=ro.operation_id
     AND a.attempt=ro.attempts
    WHERE ro.run_id=NEW.run_id
      AND ro.operation_id=NEW.operation_id
      AND ro.status='unresolved'
      AND ro.reconciliation='unknown'
      AND ro.attempts=NEW.attempt
      AND a.status='unresolved'
      AND a.reconciliation='unknown'
      AND a.finished_at IS NOT NULL
      AND NEW.observed_at>=a.finished_at
  ) THEN RAISE(ABORT,'reconciliation requires current unresolved attempt') END;
END;

CREATE TRIGGER reconciled_projection_requires_latest_event
BEFORE UPDATE OF status,reconciliation,after_json,error_json,finished_at
ON run_operations
WHEN OLD.status='unresolved' AND OLD.reconciliation='unknown'
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1
    FROM run_operation_reconciliations AS e
    WHERE e.run_id=NEW.run_id
      AND e.operation_id=NEW.operation_id
      AND e.attempt=NEW.attempts
      AND e.event_sequence=(
        SELECT MAX(e2.event_sequence)
        FROM run_operation_reconciliations AS e2
        WHERE e2.run_id=NEW.run_id AND e2.operation_id=NEW.operation_id
      )
      AND e.status=NEW.status
      AND e.reconciliation=NEW.reconciliation
      AND e.after_json=NEW.after_json
      AND ((e.error_json IS NULL AND NEW.error_json IS NULL) OR e.error_json=NEW.error_json)
      AND NEW.finished_at=e.observed_at
  ) THEN RAISE(ABORT,'reconciled projection requires matching latest event') END;
END;

CREATE TRIGGER reconciliation_events_are_append_only_update
BEFORE UPDATE ON run_operation_reconciliations
BEGIN
  SELECT RAISE(ABORT,'reconciliation events are append-only');
END;

CREATE TRIGGER reconciliation_events_are_append_only_delete
BEFORE DELETE ON run_operation_reconciliations
BEGIN
  SELECT RAISE(ABORT,'reconciliation events are append-only');
END;
`.trim();

export const initialMigration = Object.freeze({
  version: 1,
  name: "initial",
  sql: INITIAL_MIGRATION_SQL,
});
