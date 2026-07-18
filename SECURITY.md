# Security Policy

## Supported Versions

The maintainers issue security fixes for the current major release.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| 0.x     | No        |

Upgrade to the newest 1.x release before reporting behavior that an existing patch may have fixed.

## Private vulnerability reporting

Use [GitHub private vulnerability reporting](https://github.com/90le/github-stars-mcp/security/advisories/new) to contact the maintainers. GitHub keeps the draft advisory and its discussion private before publication. The project intends to coordinate disclosure timing with the reporter. The maintainers publish the advisory after they assess user risk and fix readiness.

Do not post suspected security defects in issues, discussions, pull requests, or social media.

Include:

- the affected version, Node.js version, and operating system;
- concise reproduction steps that use fictional repositories and IDs;
- the security impact and the capability boundary an attacker crosses;
- expected and observed behavior;
- sanitized logs, stack traces, or a minimal proof of concept.

Do not include a token, authorization header, private repository metadata, personal data, or credentials for a live account. Replace sensitive values with clear placeholders. State whether the report depends on a private repository without naming it.

The maintainers will assess the report, reproduce it with isolated fixtures, and discuss a fix and disclosure plan with you. Project staffing and issue complexity vary, so this policy sets no response or repair deadline.

## Product Security Boundary

GitHub Stars MCP runs as a local stdio process and sends requests to GitHub's official API. It stores repository metadata, snapshots, plans, and audit records in a local SQLite database. That database can contain metadata from private starred repositories.

The server does not store GitHub tokens. It reads a token from the process environment or the GitHub CLI credential store and keeps the resolved value in process memory.

The GitHub adapter permits Star and User List operations named in its allowlist. The product cannot delete, archive, transfer, rename, change the visibility of, or modify the contents of a code repository. Report any path that bypasses the immutable plan and expected-hash apply workflow.

## Out of Scope

Reports must describe behavior in this repository or its published package. GitHub platform defects, compromised user devices, social engineering, and attacks that require a reporter to publish their own token belong with the relevant vendor or account owner.

Do not test against another person's account, private data, or repositories. Use scripted fixtures or an account and repositories created for your test.
