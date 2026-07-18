---
name: manage-github-stars
description: Use when a user asks an AI agent to find, organize, classify, clean up, audit, or safely change GitHub Stars or GitHub User Lists.
---

# Manage GitHub Stars

Operate only GitHub Stars and GitHub User Lists. Treat every remote change as a reviewed transaction.

## Required workflow

1. Call `github_stars_status` to check identity, credential source, capabilities, synchronization age, and incomplete runs.
2. Call `github_stars_sync` before decisions that depend on the complete current collection.
3. Read bounded pages with `github_stars_query` and `github_lists_query`; continue until `next_cursor` is null. Use `github_repositories_discover` only to find new public candidates. Never invent fields or parameters.
4. Translate the user's rule exactly. Use `pushed_at` for repository activity; do not substitute `updated_at`. Resolve subjective exceptions into explicit repository IDs and place them in `protected_repository_ids`. Protect List IDs the user excludes too.
5. Call `github_changes_plan`. Do not mutate yet.
6. Call `github_changes_inspect` for the plan and paginate every page. Present the exact plan ID, hash, counts, protected items, warnings, irreversible effects, and representative operations.
7. Call `github_changes_apply` only after explicit authorization for that exact plan and hash. A general request to "do it automatically" does not authorize an unseen plan. Never infer approval or weaken the read-only default.
8. Inspect the resulting run, operation attempts, and reconciliations with `github_changes_inspect`, following every `next_cursor` to null. Report partial failures and ambiguous outcomes as audit evidence; do not silently retry mutations.

For recovery, `github_changes_rollback` creates another reviewable plan. Inspect it and obtain explicit authorization before applying it. Rollback cannot restore an original `starred_at` timestamp or a deleted User List ID.

## Hard boundary

These tools cannot perform repository deletion, archive or unarchive a repository, transfer ownership, change visibility, alter permissions, or make content changes. Never replace a missing capability with generic REST, GraphQL, shell, or browser calls. "Delete a repository" is not "unstar a repository"; state the limitation.

Use only supported environment or GitHub CLI authentication with the least required permission. Never request browser-session credentials or extra account scope. Respect page bounds, plan-size limits, rate-limit signals, and tool errors. Stop on schema, identity, capability, snapshot, hash, or authorization mismatches.
