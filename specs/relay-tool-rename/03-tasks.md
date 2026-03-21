# relay-tool-rename: Task Breakdown

> Generated: 2026-03-21 | Mode: full | Spec: [02-specification.md](./02-specification.md)

## Summary

8 tasks across 7 phases. Pure string replacement -- no behavior changes.

| Phase | Name             | Tasks | Dependencies         |
| ----- | ---------------- | ----- | -------------------- |
| 1     | Source Code      | 3     | None                 |
| 2     | Tests            | 1     | Phase 1              |
| 3     | Documentation    | 1     | Phase 1              |
| 4     | Changelog        | 1     | Phase 1              |
| 5     | Decision Records | 1     | Phase 1              |
| 6     | Specs            | 1     | Phase 1              |
| 7     | Validation       | 1     | Phases 2, 3, 4, 5, 6 |

## Parallelism

```
Phase 1: [1.1] [1.2] [1.3]  ── all parallel
              │
Phase 2:    [2.1]            ── depends on all of Phase 1
              │
Phases 3-6: [3.1] [4.1] [5.1] [6.1]  ── all parallel, each depends on 1.1
              │
Phase 7:    [7.1]            ── depends on 2.1, 3.1, 4.1, 5.1, 6.1
```

---

## Phase 1: Source Code

### 1.1 Rename tool strings in relay-tools.ts

**Size:** small | **Priority:** high | **Parallel with:** 1.2, 1.3

File: `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts`

7 string replacements:

- L209: `relay_query timed out` -> `relay_send_and_wait timed out`
- L259: `Unlike relay_query, relay_dispatch` -> `Unlike relay_send_and_wait, relay_send_async`
- L403: `'relay_query'` -> `'relay_send_and_wait'`
- L422: `use relay_dispatch instead` -> `use relay_send_async instead`
- L441: `'relay_dispatch'` -> `'relay_send_async'`
- L443: `Unlike relay_query (which blocks), relay_dispatch returns` -> `Unlike relay_send_and_wait (which blocks), relay_send_async returns`
- L463: `after relay_dispatch completes` -> `after relay_send_async completes`

Do NOT change internal function names or subject prefixes.

---

### 1.2 Rename tool filter constants in tool-filter.ts

**Size:** small | **Priority:** high | **Parallel with:** 1.1, 1.3

File: `apps/server/src/services/runtimes/claude-code/tool-filter.ts`

2 replacements:

- L61: `'mcp__dorkos__relay_query'` -> `'mcp__dorkos__relay_send_and_wait'`
- L62: `'mcp__dorkos__relay_dispatch'` -> `'mcp__dorkos__relay_send_async'`

---

### 1.3 Rename tool references in context-builder.ts

**Size:** small | **Priority:** high | **Parallel with:** 1.1, 1.2

File: `apps/server/src/services/runtimes/claude-code/context-builder.ts`

6 replacements in the `RELAY_TOOLS_CONTEXT` string:

- L19: `ephemeral inbox for relay_query` -> `ephemeral inbox for relay_send_and_wait`
- L20: `ephemeral inbox for relay_dispatch` -> `ephemeral inbox for relay_send_async`
- L28: `relay_query(to_subject=` -> `relay_send_and_wait(to_subject=`
- L34: `relay_dispatch(to_subject=` -> `relay_send_async(to_subject=`
- L53: `Call relay_dispatch()` -> `Call relay_send_async()`
- L59: `relay_send/relay_query/relay_dispatch` -> `relay_send/relay_send_and_wait/relay_send_async`

---

## Phase 2: Tests

### 2.1 Update test assertions in all 4 test files

**Size:** medium | **Priority:** high | **Depends on:** 1.1, 1.2, 1.3

14 replacements across 4 files:

- `mcp-relay-tools.test.ts` (1 change)
- `mcp-tool-server.test.ts` (3 changes)
- `tool-filter.test.ts` (8 changes)
- `mcp-server.test.ts` (2 changes)

Run tests after to confirm all pass.

---

## Phase 3: Documentation

### 3.1 Update relay-messaging.mdx docs

**Size:** small | **Priority:** medium | **Depends on:** 1.1 | **Parallel with:** 4.1, 5.1, 6.1

File: `docs/guides/relay-messaging.mdx`

Replace all `relay_query` -> `relay_send_and_wait` and `relay_dispatch` -> `relay_send_async`. At least 4 specific lines identified (110, 111, 120, 122).

---

## Phase 4: Changelog

### 4.1 Update changelog.mdx references

**Size:** small | **Priority:** medium | **Depends on:** 1.1 | **Parallel with:** 3.1, 5.1, 6.1

File: `docs/changelog.mdx`

4 replacements at lines 354, 356, 398, 421.

---

## Phase 5: Decision Records

### 5.1 Update ADRs and decisions manifest

**Size:** medium | **Priority:** medium | **Depends on:** 1.1 | **Parallel with:** 3.1, 4.1, 6.1

4 files:

- `decisions/0077-relay-dispatch-fire-and-poll-for-long-running-tasks.md` (bulk replace)
- `decisions/0081-in-process-progress-aggregation-for-relay-query.md` (bulk replace)
- `decisions/manifest.json` (2 title updates)
- `decisions/archive/0078-cca-dispatch-streaming-gated-on-inbox-prefix.md` (2 references)

---

## Phase 6: Specs

### 6.1 Bulk rename in spec directories

**Size:** medium | **Priority:** medium | **Depends on:** 1.1 | **Parallel with:** 3.1, 4.1, 5.1

Two directories:

- `specs/relay-async-query/` -- 108 occurrences across 5 files
- `specs/relay-inbox-lifecycle/` -- 89 occurrences across 5 files

Bulk `relay_query` -> `relay_send_and_wait` and `relay_dispatch` -> `relay_send_async`. Do NOT change internal function names or subject prefixes.

---

## Phase 7: Validation

### 7.1 Validate rename completeness and run full checks

**Size:** small | **Priority:** high | **Depends on:** 2.1, 3.1, 4.1, 5.1, 6.1

1. Run all 4 test files -- all must pass
2. `pnpm typecheck` -- no errors
3. Grep for orphaned `relay_query` / `relay_dispatch` -- should be zero (except this spec and research files, plus internal function names and subject prefixes)
4. Verify `relay_send` references unchanged
5. Verify new names present in expected locations
