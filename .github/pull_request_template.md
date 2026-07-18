## Summary

Describe the user-visible or internal contract this pull request changes. Link the issue when one exists.

## Verification

- [ ] I added a failing test before changing production behavior, or this pull request changes documentation only.
- [ ] I ran the focused tests listed below.
- [ ] I ran `npm run verify`.
- [ ] I ran the package smoke test for my platform when this change affects packaging, startup, native dependencies, or the CLI.

Commands and results:

```text
Replace this line with commands and results.
```

## GitHub Safety

Select one GitHub mutation allowlist statement:

- [ ] The GitHub mutation allowlist is unchanged.
- [ ] The GitHub mutation allowlist changed. I listed each operation below and requested a security review.

Allowlist operations added, removed, or changed:

```text
None
```

- [ ] This change adds no generic REST, GraphQL, URL, request-path, shell, repository-administration, or repository-contents capability.
- [ ] Each GitHub write still requires an immutable plan and expected hash.
- [ ] Tests cover redaction, preconditions, audit records, and retry behavior for each changed mutation path.

## Data and Credentials

- [ ] The commit contains no real token, authorization header, private repository metadata, personal data, or live-account mutation fixture.
- [ ] Logs and examples use fictional values.
- [ ] Pull-request CI needs no credential that can mutate a GitHub account.

## Documentation and Compatibility

- [ ] I updated public documentation for behavior, configuration, schema, or command changes.
- [ ] I documented database migrations or state compatibility changes.
- [ ] I tested the supported Node.js versions or explained why the normal matrix covers this change.
