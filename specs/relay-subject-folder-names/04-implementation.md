# Implementation Summary: Use Subject Strings as Mailbox Folder Names Instead of SHA-256 Hashes

**Created:** 2026-03-21
**Last Updated:** 2026-03-21
**Spec:** specs/relay-subject-folder-names/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 9 / 9

## Tasks Completed

### Session 1 - 2026-03-21

1. [P1] Remove `hashSubject` and use subject directly in `endpoint-registry.ts`
2. [P1] Remove `hashSubject` import from `relay-publish.ts` and use subject directly
3. [P1] Remove `hashSubject` import from `adapter-delivery.ts` and use subject directly
4. [P1] Add deprecation JSDoc to `EndpointInfo.hash` in `types.ts`
5. [P1] Remove `hashSubject` from public exports in `index.ts`
6. [P2] Update `endpoint-registry.test.ts` — remove `hashSubject` tests, update assertions
7. [P2] Update `relay-core.test.ts` hash length assertion
8. [P2] Update `maildir-store.test.ts` `TEST_ENDPOINT` to realistic subject
9. [P3] Full verification — tests, typecheck, lint all pass

## Files Modified/Created

**Source files:**

- `packages/relay/src/endpoint-registry.ts` — Removed `hashSubject()`, `HASH_LENGTH`, `node:crypto` import; use subject directly as directory name
- `packages/relay/src/relay-publish.ts` — Removed `hashSubject` import; pass subject directly to dead-letter methods
- `packages/relay/src/adapter-delivery.ts` — Removed `hashSubject` import; use subject for `adapter:${subject}` indexing
- `packages/relay/src/types.ts` — Added `@deprecated` JSDoc to `EndpointInfo.hash`
- `packages/relay/src/index.ts` — Removed `hashSubject` from exports

**Test files:**

- `packages/relay/src/__tests__/endpoint-registry.test.ts` — Removed `hashSubject` describe block; updated registration assertions to verify `hash === subject`
- `packages/relay/src/__tests__/relay-core.test.ts` — Replaced `hash.length === 12` with `hash === 'relay.agent.backend'`
- `packages/relay/src/__tests__/maildir-store.test.ts` — Changed `TEST_ENDPOINT` from `'abc123'` to `'relay.test.subject'`

**Decision records:**

- `decisions/0170-use-subject-strings-as-mailbox-directory-names.md` — ADR documenting the decision

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- All 5 source file changes and 3 test file updates completed
- Full test suite: 1387 server tests passed, all packages pass
- Typecheck: 13/13 packages pass
- No `hashSubject`, `HASH_LENGTH`, or `node:crypto` references remain in core relay source
- Downstream consumers (maildir-store, delivery-pipeline, watcher-manager, dead-letter-queue, sqlite-index) required zero changes — they consume `endpoint.hash` as an opaque string key
