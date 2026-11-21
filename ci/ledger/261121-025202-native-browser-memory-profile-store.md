---
id: 261121-025202
title: Keep the native browser witness independent of SQLite ABI
kind: hygiene
status: proposed
actor: agent
gates: [wf.desktop-smoke.packaged-runtime]
prs: [4037]
ratchet-release: []
field-changes: []
---

The packaged smoke rebuilds better-sqlite3 for Electron (ABI146), but its public
Chrome witness runs in Node24 (ABI137). The witness's in-memory database still
loads that native binary and fails at createDb before opening a browser.

Replace only the CI fixture's records with an in-memory LocalBrowserProfileStore.
Its HMAC-SHA256 payload matches production: the versioned domain, profile id,
agent id, canonical folder and creation timestamp. Compare equal-length signatures
with timingSafeEqual and use a fresh key per witness. Keep real production
selection, initialization, access and birth-proof checks. Only the person's
openForPerson path initializes and binds the agent profile.

This is fixture dependency hygiene, with no pipeline speed claim. No server,
workflow, retry, timeout, runner, permission or quality floor changes. The
fallback was explicitly requested so a native fixture does not require a
production storage refactor. Both the store and browser helper refuse outside CI.

Contract tests retain person-first, reuse, unknown-chat and unshare checks; add
a fixed independent HMAC vector, tampered-field/signature and foreign-record
refusals. The browser helper test makes SQLite construction throw. Revert or
repair if the witness constructs SQLite again, accepts a tampered binding, or
requires any production admission change. Native proof remains with macOS CI.
