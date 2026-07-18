# Bilingual README Implementation Plan

> **For agentic workers:** Execute this focused documentation plan inline with the existing repository checks.

**Goal:** Add concise, synchronized English and Simplified Chinese project overviews that explain the AI-native GitHub Stars and User Lists workflow.

**Architecture:** Keep `README.md` as the English canonical landing page and add `README.zh-CN.md` as a structurally equivalent Chinese translation. Each file links to the other, while detailed schemas and operational guidance remain in `docs/`.

**Tech Stack:** Markdown, existing documentation contract checks, Prettier.

## Global Constraints

- Preserve the AI-first MCP positioning; do not describe this as a human-operated browser or interactive CLI.
- Document only the nine implemented MCP tools and supported GitHub mutations.
- Keep the read-only default and plan → inspect → apply safety workflow explicit.
- Do not claim repository deletion, repository-content modification, or unrestricted GitHub API access.

## Task 1: English landing page

**Files:** Modify `README.md`.

- [ ] Add the `English | 简体中文` language switch at the top.
- [ ] Lead with one-sentence value proposition, quick install, core capabilities, safety model, limitations, and links to detailed docs.
- [ ] Keep commands and version `1.0.0` consistent with package metadata.

## Task 2: Chinese landing page

**Files:** Create `README.zh-CN.md`.

- [ ] Mirror the English README structure and explain the same nine tools and safety boundaries in Simplified Chinese.
- [ ] Keep code blocks, environment names, tool names, and links identical where they are technical identifiers.

## Task 3: Verification

- [ ] Run Prettier and the documentation contract checks.
- [ ] Run the focused documentation tests and inspect the final diff for untranslated or contradictory claims.
- [ ] Commit the documentation change and push it to `main` only after checks pass.
