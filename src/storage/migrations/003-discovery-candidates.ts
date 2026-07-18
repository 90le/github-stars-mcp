const DISCOVERY_CANDIDATES_SQL = `
CREATE TABLE discovery_candidates(
  host TEXT NOT NULL CHECK(host='github.com'),
  login TEXT NOT NULL CHECK(length(login)>0 AND login=trim(login)),
  account_id TEXT NOT NULL CHECK(length(account_id)>0 AND account_id=trim(account_id)),
  repository_id TEXT NOT NULL,
  query TEXT NOT NULL CHECK(length(query)>0 AND query=trim(query)),
  state TEXT NOT NULL CHECK(state IN('discovered','selected','dismissed','starred')),
  first_discovered_at TEXT NOT NULL,
  last_discovered_at TEXT NOT NULL,
  PRIMARY KEY(host,login,account_id,repository_id),
  FOREIGN KEY(host,login,account_id) REFERENCES accounts(host,login,account_id),
  FOREIGN KEY(repository_id) REFERENCES repositories(repository_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX discovery_candidates_page
  ON discovery_candidates(host,account_id,state,last_discovered_at DESC,repository_id);
`.trim();

export const discoveryCandidatesMigration = Object.freeze({
  version: 3,
  name: "discovery-candidates",
  sql: DISCOVERY_CANDIDATES_SQL,
});
