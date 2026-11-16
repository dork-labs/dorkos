---
slug: relay-subject-folder-names
number: 158
created: 2026-03-21
status: specified
authors:
  - Claude Code
---

# Use Subject Strings as Mailbox Folder Names Instead of SHA-256 Hashes

## Status

Specified

## Overview

Replace opaque SHA-256 hash directory names in Relay mailboxes with human-readable subject strings. Currently `mailboxes/{12-char-hex}/` becomes `mailboxes/{subject}/` — e.g., `relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP/` instead of `02cdb2a9d371/`.

This is a focused refactoring that removes the `hashSubject()` function and its `node:crypto` dependency from the endpoint registry, replacing the hash-based directory naming with direct subject string usage. All downstream consumers already treat the hash as an opaque string key and require zero changes.

## Background / Problem Statement

The `EndpointRegistry` in `packages/relay/src/endpoint-registry.ts` computes a 12-character SHA-256 hex prefix for each subject string and uses that as the Maildir directory name:

```typescript
// Current — endpoint-registry.ts:36-37
export function hashSubject(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, HASH_LENGTH);
}
```

This produces directory names like `02cdb2a9d371/` under `~/.dork/relay/mailboxes/`. The problems:

1. **Opaque to operators** — `ls ~/.dork/relay/mailboxes/` shows meaningless hex strings. The subject-to-hash mapping only exists in process memory.
2. **No safety benefit** — subjects are already validated by `validateSubject()` to contain only `[a-zA-Z0-9_-]` tokens separated by dots (the POSIX Portable Filename Character Set). The hash was never needed for filesystem safety.
3. **No security benefit** — mailboxes live under `~/.dork/` with `0o700` permissions. The hash provides no access control.
4. **Unnecessary dependency** — `node:crypto` is imported solely for this hash computation.

## Goals

- Replace `mailboxes/{hash}/` with `mailboxes/{subject}/` for human-readable directory names
- Remove `hashSubject()` function, `HASH_LENGTH` constant, and `node:crypto` import from `endpoint-registry.ts`
- Remove `hashSubject` from `@dorkos/relay` public exports
- Maintain API compatibility by setting `EndpointInfo.hash = subject` (downstream consumers unchanged)
- Document the decision in an ADR

## Non-Goals

- Renaming `EndpointInfo.hash` field to `EndpointInfo.id` (follow-up cleanup)
- Renaming the SQLite `endpointHash` column in `@dorkos/db` (semantic drift acceptable)
- Building a migration utility for existing hash-named directories (mailboxes are ephemeral)
- Windows filesystem compatibility testing (not a target platform; subjects are Windows-safe anyway)

## Technical Dependencies

- No new dependencies required
- **Removes** dependency on `node:crypto` in `endpoint-registry.ts`
- Relies on existing subject validation in `packages/relay/src/subject-matcher.ts` (`VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/`, `MAX_TOKEN_COUNT = 16`)

## Detailed Design

### Architecture

No architectural changes. The refactoring is confined to how `EndpointRegistry` computes the directory name for a given subject. All other modules consume `EndpointInfo.hash` as an opaque string key — they work identically whether the value is a 12-char hex hash or the full subject string.

### Implementation Approach

**Strategy:** Set `EndpointInfo.hash = subject` to preserve API shape. All downstream consumers (`DeliveryPipeline`, `WatcherManager`, `SqliteIndex`, `DeadLetterQueue`) use `endpoint.hash` as a Map key or path segment — no changes needed.

### File Changes

#### 1. `packages/relay/src/endpoint-registry.ts` (PRIMARY)

**Remove:**

- Line 14: `import { createHash } from 'node:crypto';`
- Line 24: `const HASH_LENGTH = 12;`
- Lines 26-37: `hashSubject()` function and its JSDoc

**Modify `registerEndpoint()` (lines 75-107):**

```typescript
// Before (lines 90-91):
const hash = hashSubject(subject);
const maildirPath = join(this.mailboxesDir, hash);

// After:
const maildirPath = join(this.mailboxesDir, subject);
```

```typescript
// Before (lines 97-103):
const info: EndpointInfo = {
  subject,
  hash,
  maildirPath,
  registeredAt: new Date().toISOString(),
};

// After:
const info: EndpointInfo = {
  subject,
  hash: subject,
  maildirPath,
  registeredAt: new Date().toISOString(),
};
```

**`getEndpointByHash()` method:** No changes needed — it linear-scans `this.endpoints` matching `info.hash === hash`, which continues to work since `hash` is now the subject string.

#### 2. `packages/relay/src/relay-publish.ts`

**Remove:**

- Line 13: `import { hashSubject } from './endpoint-registry.js';`

**Modify `deadLetter()` method (lines 319-331):**

```typescript
// Before (lines 324-325, 330):
const subjectHash = hashSubject(subject);
await this.deps.maildirStore.ensureMaildir(subjectHash);
// ...
await this.deps.deadLetterQueue.reject(subjectHash, envelope, reason);

// After:
await this.deps.maildirStore.ensureMaildir(subject);
// ...
await this.deps.deadLetterQueue.reject(subject, envelope, reason);
```

#### 3. `packages/relay/src/adapter-delivery.ts`

**Remove:**

- Line 10: `import { hashSubject } from './endpoint-registry.js';`

**Modify `deliver()` method (lines 63-67):**

```typescript
// Before:
const subjectHash = hashSubject(subject);
this.sqliteIndex.insertMessage({
  // ...
  endpointHash: `adapter:${subjectHash}`,
  // ...
});

// After:
this.sqliteIndex.insertMessage({
  // ...
  endpointHash: `adapter:${subject}`,
  // ...
});
```

#### 4. `packages/relay/src/types.ts`

**Update JSDoc on `EndpointInfo.hash` (line 69):**

```typescript
// Before:
export interface EndpointInfo {
  subject: string;
  hash: string;
  maildirPath: string;
  registeredAt: string;
}

// After:
export interface EndpointInfo {
  subject: string;
  /** @deprecated Equals `subject`. Kept for API compatibility — will be renamed to `id` in a future release. */
  hash: string;
  maildirPath: string;
  registeredAt: string;
}
```

**Update JSDoc on `DeadLetter.endpointHash`** similarly if present — note that the field now stores the subject string rather than a computed hash.

#### 5. `packages/relay/src/index.ts`

**Remove `hashSubject` from exports (line 18):**

```typescript
// Before:
export { EndpointRegistry, hashSubject } from './endpoint-registry.js';

// After:
export { EndpointRegistry } from './endpoint-registry.js';
```

### Files That Need NO Changes

These modules use `endpoint.hash` or `endpointHash` as an opaque string key. They work identically whether the value is a hex hash or a subject string:

- `packages/relay/src/maildir-store.ts` — receives endpoint identifier as parameter, constructs paths
- `packages/relay/src/delivery-pipeline.ts` — uses `endpoint.hash` as circuit breaker Map key
- `packages/relay/src/watcher-manager.ts` — uses `endpoint.hash` as Map key for watchers
- `packages/relay/src/dead-letter-queue.ts` — receives `endpointHash` parameter for path resolution
- `packages/relay/src/sqlite-index.ts` — stores/queries by `endpointHash` column (now stores subject string)
- `packages/relay/src/relay-core.ts` — composes sub-modules, no direct hash usage
- `packages/relay/src/relay-endpoint-management.ts` — passes `EndpointInfo` through

### Data Flow (After Change)

```
Subject string → validateSubject() → EndpointRegistry.registerEndpoint()
  → maildirPath = join(mailboxesDir, subject)    [direct, no hash]
  → EndpointInfo { subject, hash: subject, maildirPath }
  → MaildirStore, DeliveryPipeline, WatcherManager, SqliteIndex, DeadLetterQueue
```

## User Experience

**Before:** `ls ~/.dork/relay/mailboxes/` shows:

```
02cdb2a9d371/  00744772b841/  a1f3e8b90c42/
```

**After:** `ls ~/.dork/relay/mailboxes/` shows:

```
relay.agent.myproject.backend/  relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP/  relay.inbox.01JKABCDEF/
```

No UI changes. No API changes. No configuration changes. The improvement is purely in filesystem observability for operators inspecting the data directory.

## Testing Strategy

### Unit Tests

#### `packages/relay/src/__tests__/endpoint-registry.test.ts`

**Remove the `hashSubject` describe block** (lines 38-62) — the function no longer exists.

**Update `registerEndpoint` tests:**

```typescript
// Before (line 75):
expect(info.hash).toBe(hashSubject(subject));

// After:
expect(info.hash).toBe(subject);
```

```typescript
// Before (line 76):
expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', info.hash));

// After:
expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', subject));
```

```typescript
// Before (lines 311-317 — "maildir path is derived from hash"):
const expectedHash = hashSubject(subject);
expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', expectedHash));

// After — rename test to "maildir path is derived from subject":
expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', subject));
```

**Remove import:** `hashSubject` from line 5.

#### `packages/relay/src/__tests__/relay-core.test.ts`

```typescript
// Before (line 93):
expect(info.hash.length).toBe(12);

// After:
expect(info.hash).toBe('relay.agent.backend');
```

#### `packages/relay/src/__tests__/maildir-store.test.ts`

```typescript
// Before (line 13):
const TEST_ENDPOINT = 'abc123';

// After:
const TEST_ENDPOINT = 'relay.test.subject';
```

This is optional but recommended — it makes the test self-documenting about what the identifier represents.

### Integration Tests

No new integration tests needed. Existing relay integration tests in `relay-core.test.ts` already exercise the full endpoint registration → maildir creation flow. After updating the hash length assertion, they validate the new behavior.

### E2E Tests

No E2E tests needed — this is an internal storage detail with no UI surface.

## Performance Considerations

None. Directory name length has zero impact on `readdir`/`rename` at this scale. Path length is structurally bounded by `MAX_TOKEN_COUNT = 16` — worst-case subject ~220 chars, well under `NAME_MAX = 255` bytes. Full path stays under 300 chars, far below Linux `PATH_MAX = 4096` and macOS limit of 1023 chars.

## Security Considerations

No security impact. The hash provided no access control — `~/.dork/` is already `0o700` (owner-only). Subject strings contain no sensitive information. The `validateSubject()` function in `subject-matcher.ts` already prevents path traversal attacks by enforcing `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/` — no `/`, `\`, `..`, or other dangerous characters can appear.

## Documentation

- **ADR:** Create an ADR documenting this decision and rationale (see Implementation Phases)
- **No user-facing docs needed** — this is an internal storage detail
- **No contributing guide updates** — the change is self-evident in code

## Implementation Phases

### Phase 1: ADR + Source Changes

1. Create ADR documenting the decision to use subject strings as directory names
2. Modify `endpoint-registry.ts`: remove `hashSubject()`, `HASH_LENGTH`, `node:crypto` import; use subject directly
3. Modify `relay-publish.ts`: remove `hashSubject` import; pass subject directly to dead-letter methods
4. Modify `adapter-delivery.ts`: remove `hashSubject` import; use subject directly for indexing
5. Update `types.ts`: add deprecation JSDoc to `EndpointInfo.hash`
6. Update `index.ts`: remove `hashSubject` from exports

### Phase 2: Test Updates

1. Update `endpoint-registry.test.ts`: remove `hashSubject` tests, update registration assertions
2. Update `relay-core.test.ts`: replace `hash.length === 12` assertion
3. Update `maildir-store.test.ts`: change `TEST_ENDPOINT` to realistic subject (optional)
4. Run full test suite: `pnpm vitest run packages/relay/`

### Phase 3: Verification

1. Run `pnpm typecheck` — confirm no type errors
2. Run `pnpm lint` — confirm no lint errors
3. Run `pnpm test -- --run` — confirm all tests pass
4. Manual verification: start dev server, check `ls apps/server/.temp/.dork/relay/mailboxes/` shows subject-named directories

## Open Questions

No open questions. The approach is straightforward, validated by research, and confirmed by codebase exploration. All decisions have been made in the ideation phase.

## Related ADRs

- **ADR-0010:** `decisions/0010-use-maildir-for-relay-message-storage.md` — Established Maildir design (superseded by ADR-0013)
- **ADR-0013:** `decisions/0013-hybrid-maildir-sqlite-storage.md` — Current hybrid storage architecture
- **New ADR (to be created):** Documents this change from hash-based to subject-based directory naming

## References

- Ideation: `specs/relay-subject-folder-names/01-ideation.md`
- Research: `research/20260321_relay_subject_folder_names.md`
- Subject validation: `packages/relay/src/subject-matcher.ts` (lines 28, 35)
- POSIX Portable Filename Character Set: `[A-Za-z0-9._-]`
