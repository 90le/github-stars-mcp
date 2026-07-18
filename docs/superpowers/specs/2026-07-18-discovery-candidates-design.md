# Discovery Candidate Bridge Design

## Goal

Allow repositories returned by `github_repositories_discover` to enter the existing audited Star/List planning flow without changing the meaning or counts of completed Star snapshots.

## Design

Persist discovered repository metadata in an account-scoped candidate table keyed by immutable GitHub repository ID and version hash. Candidate rows record discovery query, evidence summary, first/last discovered timestamps, and lifecycle state. Discovery remains read-only from GitHub's perspective but writes local state.

Expose candidate reads through a bounded MCP tool. Extend change-plan resolution so Star and List membership operations may reference candidate repository IDs; the planner resolves candidate metadata and binds the plan to the current complete Star snapshot. Applying the plan continues to use the existing explicit hash and read-only safeguards.

## Safety and consistency

- Candidates never enter `snapshot_repositories`, `snapshot_stars`, or snapshot counts until a later GitHub sync observes them as starred.
- Candidate identity is immutable; metadata updates create a new version hash.
- Candidate queries are paginated and account-bound.
- Existing Star/List plans and snapshot validation remain unchanged for snapshot repository IDs.
- Candidate-backed plans fail closed when the candidate is missing, stale, private, archived, or identity-mismatched.

## Verification

Add unit tests for candidate persistence and lifecycle, contract tests for the new MCP tool and candidate-backed plans, migration checks, docs/tool-reference checks, and a local full verification run.
