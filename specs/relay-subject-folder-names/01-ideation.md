---
slug: relay-subject-folder-names
number: 158
created: 2026-03-21
status: ideation
---

# Use Subject Strings as Mailbox Folder Names Instead of SHA-256 Hashes

**Slug:** relay-subject-folder-names
**Author:** Claude Code
**Date:** 2026-03-21
**Branch:** preflight/relay-subject-folder-names

---

## 1) Intent & Assumptions

- **Task brief:** Replace opaque SHA-256 hash folder names (`mailboxes/{12-char-hex}/`) with human-readable subject strings (`mailboxes/{subject}/`) so that `ls` on the mailboxes directory shows meaningful names like `relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP/` instead of `02cdb2a9d371/`.
- **Assumptions:**
  - Subject strings are already filesystem-safe — `validateSubject()` enforces `[a-zA-Z0-9_-]+` tokens separated by dots
  - No migration utility is needed — mailboxes are ephemeral (re-registered on server start), so old hash-named folders become harmless orphans
  - The `hash` field on `EndpointInfo` can be set equal to `subject` to preserve API shape, deferring a full rename to a separate cleanup
  - An ADR should document this decision (as specified in the task brief)
- **Out of scope:**
  - Renaming `EndpointInfo.hash` → `EndpointInfo.id` across the codebase (separate follow-up)
  - Renaming the SQLite `endpointHash` column (semantic drift is acceptable; the column stores a string key)
  - Migration utility for existing hash-named directories (users delete `~/.dork/relay/mailboxes/` or it regenerates on restart)
  - Windows filesystem compatibility (not a stated target, though the subject character set is Windows-safe anyway)

## 2) Pre-reading Log

- `decisions/0010-use-maildir-for-relay-message-storage.md`: Established Maildir design; superseded by ADR-0013 (Hybrid Maildir + SQLite)
- `packages/relay/src/endpoint-registry.ts`: Defines `hashSubject()` function (SHA-256 truncated to 12 hex chars, lines 36-38) and `EndpointRegistry` class that creates `mailboxes/{hash}/` directories
- `packages/relay/src/types.ts`: `EndpointInfo` interface has `hash`, `subject`, `maildirPath`, `registeredAt` fields. Comment already notes "lowercase alphanumeric + dots" subjects being filesystem-safe
- `packages/relay/src/subject-matcher.ts`: `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/`, `MAX_TOKEN_COUNT = 16` — validates all subjects before they reach the registry
- `packages/relay/src/relay-publish.ts`: Imports and uses `hashSubject()` on line 324 for dead-letter directory creation when no endpoints exist
- `packages/relay/src/adapter-delivery.ts`: Uses `hashSubject()` on line 63 to compute `adapter:{hash}` key for SQLite indexing
- `packages/relay/src/sqlite-index.ts`: Stores and queries by `endpointHash` column in the `relayIndex` table
- `packages/relay/src/delivery-pipeline.ts`: Uses `endpoint.hash` as circuit breaker Map key and signal emission key
- `packages/relay/src/watcher-manager.ts`: Uses `endpoint.hash` as Map key for tracking file watchers
- `packages/relay/src/dead-letter-queue.ts`: Uses `endpointHash` parameter for maildir path resolution
- `packages/relay/src/index.ts`: Exports `hashSubject` publicly (line 18) — must be removed
- `packages/relay/src/__tests__/endpoint-registry.test.ts`: Tests assert hash determinism and `info.hash.length === 12`
- `packages/relay/src/__tests__/relay-core.test.ts`: Integration test checks `info.hash.length === 12` (line 93)
- `research/20260321_relay_subject_folder_names.md`: Research report confirming filesystem safety of subject strings

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/relay/src/endpoint-registry.ts` — Central registry; contains `hashSubject()` function to remove
  - `packages/relay/src/types.ts` — `EndpointInfo` type with `hash` field
  - `packages/relay/src/relay-publish.ts` — Dead-letter routing uses `hashSubject()`
  - `packages/relay/src/adapter-delivery.ts` — Adapter delivery indexing uses `hashSubject()`
  - `packages/relay/src/index.ts` — Public export of `hashSubject`

- **Shared dependencies:**
  - `node:crypto` — Provides `createHash()` for SHA-256; import will be removed
  - `packages/relay/src/subject-matcher.ts` — Subject validation (stays as-is, confirms safety)
  - `@dorkos/db` — `relayIndex` table schema with `endpointHash` column (no change needed)

- **Data flow:**

  ```
  Subject string → validateSubject() → EndpointRegistry.registerEndpoint()
    → hashSubject() → 12-char hex hash [REMOVE]
    → use subject directly as directory name [NEW]
    → EndpointInfo { subject, hash: subject, maildirPath }
    → MaildirStore, DeliveryPipeline, WatcherManager, SqliteIndex, DeadLetterQueue
  ```

- **Feature flags/config:** None

- **Potential blast radius:**
  - **Direct changes (5 files):**
    1. `endpoint-registry.ts` — Remove `hashSubject()`, `HASH_LENGTH`; use subject as directory name
    2. `relay-publish.ts` — Remove `hashSubject()` import; pass subject directly
    3. `adapter-delivery.ts` — Remove `hashSubject()` import; use subject for indexing
    4. `types.ts` — Update `EndpointInfo.hash` JSDoc to note it now equals `subject`
    5. `index.ts` — Remove `hashSubject` export
  - **Test changes (3+ files):**
    1. `__tests__/endpoint-registry.test.ts` — Remove hash-length assertions, verify subject-based naming
    2. `__tests__/relay-core.test.ts` — Remove `info.hash.length === 12` assertion
    3. `__tests__/maildir-store.test.ts` — Update `TEST_ENDPOINT = 'abc123'` to realistic subject (optional but recommended)
  - **No changes needed (6 files):** `maildir-store.ts`, `delivery-pipeline.ts`, `watcher-manager.ts`, `dead-letter-queue.ts`, `relay-core.ts`, `relay-endpoint-management.ts` — these use `endpoint.hash` as an opaque string key, which continues to work when `hash === subject`

## 4) Root Cause Analysis

_Not applicable — this is a refactoring, not a bug fix._

## 5) Research

Research report: `research/20260321_relay_subject_folder_names.md`

- **Potential solutions:**
  1. **Direct subject string as folder name** — Use the validated subject string directly as the directory name. Subjects contain only `[a-zA-Z0-9_-]` tokens separated by dots — the POSIX Portable Filename Character Set. Safe on Linux, macOS, and Windows. Path length bounded by `MAX_TOKEN_COUNT = 16`, worst-case ~220 chars per component (under 255-byte `NAME_MAX`). _Complexity: Low. Maintenance: Low._

  2. **Keep hash, add symlinks or index file** — Maintain hash directories but add a reverse-lookup file. Adds complexity with zero benefit; symlinks don't survive cross-filesystem operations; an index file duplicates what's already in memory. _Complexity: Medium. Maintenance: Medium._

  3. **Sanitized/slugified subject string** — Apply dot-to-underscore conversion or similar encoding. Unnecessary given validation already ensures safety; creates an encoding layer that must be decoded; dots in directory names are universally safe and idiomatic in Maildir++. _Complexity: Low. Maintenance: Low but adds pointless indirection._

- **Security considerations:** No concern. Mailboxes live under `~/.dork/` with `0o700` permissions. The hash provides no access control — the subject-to-hash mapping is in memory, readable by the same user. RabbitMQ hashes because queue names allow arbitrary characters; DorkOS subjects are validated before they reach storage.

- **Performance considerations:** None. Directory name length has zero impact on `readdir`/`rename` at this scale. Path length is structurally bounded well within OS limits.

- **Recommendation:** Approach 1 — direct subject string. The validator already does the work the hash was compensating for.

## 6) Decisions

No ambiguities identified — task brief and research findings were sufficiently clear. Both the codebase exploration and independent research converge on the same approach: use subject strings directly, set `EndpointInfo.hash = subject` for API compatibility, remove `hashSubject()` entirely.
