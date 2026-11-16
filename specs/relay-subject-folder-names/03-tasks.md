# Task Breakdown: relay-subject-folder-names

**Spec:** `specs/relay-subject-folder-names/02-specification.md`
**Generated:** 2026-03-21
**Mode:** Full decomposition

## Summary

Replace opaque SHA-256 hash directory names in Relay mailboxes with human-readable subject strings. This is a focused refactoring that removes `hashSubject()`, its `node:crypto` dependency, and updates all call sites to use the subject string directly.

**Total tasks:** 9 across 3 phases
**Estimated effort:** Small (most tasks are single-file, mechanical changes)

---

## Phase 1: Source Changes (5 tasks)

All Phase 1 tasks can be executed in parallel.

### Task 1.1 — Remove hashSubject and use subject directly in endpoint-registry.ts

**Size:** Medium | **Priority:** High | **Dependencies:** None

Modify `packages/relay/src/endpoint-registry.ts`:

- Remove `import { createHash } from 'node:crypto'`
- Remove `const HASH_LENGTH = 12`
- Remove `hashSubject()` function and its JSDoc
- In `registerEndpoint()`: replace `hashSubject(subject)` with direct `subject` usage
- Set `hash: subject` in the `EndpointInfo` object
- Update module-level JSDoc to remove SHA-256 references

### Task 1.2 — Remove hashSubject import from relay-publish.ts

**Size:** Small | **Priority:** High | **Dependencies:** None

Modify `packages/relay/src/relay-publish.ts`:

- Remove `import { hashSubject } from './endpoint-registry.js'`
- In `deadLetter()`: remove `const subjectHash = hashSubject(subject)` and pass `subject` directly to `ensureMaildir()` and `deadLetterQueue.reject()`

### Task 1.3 — Remove hashSubject import from adapter-delivery.ts

**Size:** Small | **Priority:** High | **Dependencies:** None

Modify `packages/relay/src/adapter-delivery.ts`:

- Remove `import { hashSubject } from './endpoint-registry.js'`
- In `deliver()`: remove `const subjectHash = hashSubject(subject)` and use `adapter:${subject}` for `endpointHash`

### Task 1.4 — Add deprecation JSDoc to EndpointInfo.hash

**Size:** Small | **Priority:** Medium | **Dependencies:** None

Modify `packages/relay/src/types.ts`:

- Add `@deprecated` JSDoc to `EndpointInfo.hash`: "Equals `subject`. Kept for API compatibility -- will be renamed to `id` in a future release."

### Task 1.5 — Remove hashSubject from public exports

**Size:** Small | **Priority:** High | **Dependencies:** None

Modify `packages/relay/src/index.ts`:

- Change `export { EndpointRegistry, hashSubject }` to `export { EndpointRegistry }`

---

## Phase 2: Test Updates (3 tasks)

Tasks 2.1-2.3 can be executed in parallel. Tasks 2.1 and 2.2 depend on Task 1.1.

### Task 2.1 — Update endpoint-registry.test.ts

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Modify `packages/relay/src/__tests__/endpoint-registry.test.ts`:

- Remove `hashSubject` import
- Remove entire `hashSubject` describe block (4 tests)
- Update `registerEndpoint` test: `expect(info.hash).toBe(subject)` and `expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', subject))`
- Replace "hash determinism" describe block with "directory naming" block that verifies `hash === subject` and maildir path derivation from subject

### Task 2.2 — Update relay-core.test.ts

**Size:** Small | **Priority:** High | **Dependencies:** 1.1

Modify `packages/relay/src/__tests__/relay-core.test.ts`:

- Replace `expect(info.hash.length).toBe(12)` with `expect(info.hash).toBe('relay.agent.backend')`
- Remove the now-redundant `expect(info.hash).toBeDefined()` line

### Task 2.3 — Update maildir-store.test.ts

**Size:** Small | **Priority:** Low | **Dependencies:** None

Modify `packages/relay/src/__tests__/maildir-store.test.ts`:

- Change `const TEST_ENDPOINT = 'abc123'` to `const TEST_ENDPOINT = 'relay.test.subject'`

---

## Phase 3: Verification (1 task)

### Task 3.1 — Run full test suite, typecheck, and lint

**Size:** Small | **Priority:** High | **Dependencies:** All previous tasks

Run verification commands:

1. `pnpm vitest run packages/relay/` -- all relay tests pass
2. `pnpm typecheck` -- zero type errors
3. `pnpm lint` -- zero lint errors
4. `pnpm test -- --run` -- all tests across all packages pass

---

## Files Modified

| File                                                     | Change                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/relay/src/endpoint-registry.ts`                | Remove `hashSubject`, `HASH_LENGTH`, `node:crypto`; use subject directly |
| `packages/relay/src/relay-publish.ts`                    | Remove `hashSubject` import; use subject in dead-letter path             |
| `packages/relay/src/adapter-delivery.ts`                 | Remove `hashSubject` import; use subject in SQLite index                 |
| `packages/relay/src/types.ts`                            | Add `@deprecated` JSDoc to `EndpointInfo.hash`                           |
| `packages/relay/src/index.ts`                            | Remove `hashSubject` from exports                                        |
| `packages/relay/src/__tests__/endpoint-registry.test.ts` | Remove hash tests, update assertions                                     |
| `packages/relay/src/__tests__/relay-core.test.ts`        | Update hash length assertion                                             |
| `packages/relay/src/__tests__/maildir-store.test.ts`     | Update `TEST_ENDPOINT` value                                             |

## Files NOT Modified

These files use `endpoint.hash` or `endpointHash` as an opaque string key and require zero changes:

- `packages/relay/src/maildir-store.ts`
- `packages/relay/src/delivery-pipeline.ts`
- `packages/relay/src/watcher-manager.ts`
- `packages/relay/src/dead-letter-queue.ts`
- `packages/relay/src/sqlite-index.ts`
- `packages/relay/src/relay-core.ts`
- `packages/relay/src/relay-endpoint-management.ts`
