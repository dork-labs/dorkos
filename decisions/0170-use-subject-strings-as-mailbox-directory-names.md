---
number: 170
title: Use Subject Strings as Mailbox Directory Names
status: accepted
created: 2026-03-21
spec: relay-subject-folder-names
superseded-by: null
---

# 170. Use Subject Strings as Mailbox Directory Names

## Status

Accepted

## Context

The Relay endpoint registry hashes subject strings into 12-character SHA-256 hex prefixes for use as Maildir directory names under `~/.dork/relay/mailboxes/`. This produces opaque folder names like `02cdb2a9d371/` that cannot be identified without reading messages inside them or inspecting in-memory state. The hash-to-subject mapping only exists while the server runs.

Relay subjects are validated by `validateSubject()` to contain only `[a-zA-Z0-9_-]` tokens separated by dots — the POSIX Portable Filename Character Set. The hash provides no filesystem safety benefit (subjects are already safe), no security benefit (mailboxes are under `~/.dork/` with `0o700` permissions), and no performance benefit (path length is bounded by `MAX_TOKEN_COUNT = 16`).

## Decision

Use the validated subject string directly as the mailbox directory name instead of computing a SHA-256 hash. Remove the `hashSubject()` function, `HASH_LENGTH` constant, and `node:crypto` import from `endpoint-registry.ts`. Set `EndpointInfo.hash = subject` for API compatibility — all downstream consumers use the hash as an opaque string key and require no changes.

## Consequences

### Positive

- `ls ~/.dork/relay/mailboxes/` shows human-readable names like `relay.agent.myproject.backend/` instead of `02cdb2a9d371/`
- Removes `node:crypto` dependency from the endpoint registry
- Removes unnecessary code complexity (function, constant, import)
- Aligns with Maildir++ convention of using meaningful folder names

### Negative

- Existing hash-named directories become orphans on upgrade (acceptable — mailboxes are ephemeral, re-registered on server start)
- `EndpointInfo.hash` field becomes semantically inaccurate (mitigated by JSDoc deprecation note; full rename deferred)
- SQLite `endpointHash` column name drifts from its contents (acceptable semantic drift)
