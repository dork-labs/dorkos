---
slug: relay-tool-rename
number: 160
created: 2026-03-21
status: specified
---

# Rename Relay MCP Tools for Clarity

## Overview

Rename two Relay MCP tool name strings so the response strategy is self-documenting:

| Current          | New                   | Semantics                   |
| ---------------- | --------------------- | --------------------------- |
| `relay_query`    | `relay_send_and_wait` | Blocks until reply arrives  |
| `relay_dispatch` | `relay_send_async`    | Returns inbox to poll later |
| `relay_send`     | _(unchanged)_         | Fire-and-forget             |

All three tools publish through the same `relay.publish()` codepath. The only difference is how they handle responses. The current names sound like synonyms for "send a message" and don't communicate the response strategy, which is the actual differentiator.

**Scope:** User-facing tool name strings and their mentions in descriptions, tests, docs, specs, and ADRs. Internal handler/factory function names, subject prefixes, and behavior are unchanged.

## Technical Design

### Rename Map

Every occurrence of `relay_query` in a user-facing context becomes `relay_send_and_wait`. Every occurrence of `relay_dispatch` in a user-facing context becomes `relay_send_async`. The MCP SDK auto-wraps tool names with the `mcp__dorkos__` prefix, so those references update accordingly.

**What changes:**

- Tool name string literals in registration code
- Tool description text that cross-references other tools
- `mcp__dorkos__relay_query` / `mcp__dorkos__relay_dispatch` in tool filter constants
- Agent context documentation in `RELAY_TOOLS_CONTEXT`
- Test assertions and describe block names
- User-facing docs, specs, and ADRs

**What does NOT change:**

- Internal function names: `createRelayQueryHandler`, `createRelayDispatchHandler`
- Subject prefixes: `relay.inbox.query.*`, `relay.inbox.dispatch.*`
- Error message internal identifiers (the timeout error at line 209 says `relay_query timed out` — this updates to `relay_send_and_wait timed out` since it's user-visible)
- Anything in `packages/relay/` (core library)
- Tool behavior, parameters, or return types

## Implementation Phases

### Phase 1: Source Code (3 files)

#### 1a. `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts`

| Line | Current                                                     | New                                                                   |
| ---- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 209  | `` `relay_query timed out after ${timeoutMs}ms` ``          | `` `relay_send_and_wait timed out after ${timeoutMs}ms` ``            |
| 259  | `Unlike relay_query, relay_dispatch returns immediately`    | `Unlike relay_send_and_wait, relay_send_async returns immediately`    |
| 403  | `'relay_query'`                                             | `'relay_send_and_wait'`                                               |
| 422  | `use relay_dispatch instead`                                | `use relay_send_async instead`                                        |
| 441  | `'relay_dispatch'`                                          | `'relay_send_async'`                                                  |
| 443  | `Unlike relay_query (which blocks), relay_dispatch returns` | `Unlike relay_send_and_wait (which blocks), relay_send_async returns` |
| 463  | `after relay_dispatch completes`                            | `after relay_send_async completes`                                    |

#### 1b. `apps/server/src/services/runtimes/claude-code/tool-filter.ts`

| Line | Current                         | New                                  |
| ---- | ------------------------------- | ------------------------------------ |
| 61   | `'mcp__dorkos__relay_query'`    | `'mcp__dorkos__relay_send_and_wait'` |
| 62   | `'mcp__dorkos__relay_dispatch'` | `'mcp__dorkos__relay_send_async'`    |

#### 1c. `apps/server/src/services/runtimes/claude-code/context-builder.ts`

| Line | Current                                 | New                                               |
| ---- | --------------------------------------- | ------------------------------------------------- |
| 19   | `ephemeral inbox for relay_query`       | `ephemeral inbox for relay_send_and_wait`         |
| 20   | `ephemeral inbox for relay_dispatch`    | `ephemeral inbox for relay_send_async`            |
| 28   | `relay_query(to_subject=`               | `relay_send_and_wait(to_subject=`                 |
| 34   | `relay_dispatch(to_subject=`            | `relay_send_async(to_subject=`                    |
| 53   | `Call relay_dispatch()`                 | `Call relay_send_async()`                         |
| 59   | `relay_send/relay_query/relay_dispatch` | `relay_send/relay_send_and_wait/relay_send_async` |

### Phase 2: Tests (4 files)

#### 2a. `apps/server/src/services/core/__tests__/mcp-relay-tools.test.ts`

| Line | Current                                        | New                                                    |
| ---- | ---------------------------------------------- | ------------------------------------------------------ |
| 255  | `describe('relay_query progress accumulation'` | `describe('relay_send_and_wait progress accumulation'` |

#### 2b. `apps/server/src/services/core/__tests__/mcp-tool-server.test.ts`

| Line | Current                       | New                                |
| ---- | ----------------------------- | ---------------------------------- |
| 477  | `toContain('relay_query')`    | `toContain('relay_send_and_wait')` |
| 478  | `toContain('relay_dispatch')` | `toContain('relay_send_async')`    |
| 506  | `applies to relay_dispatch`   | `applies to relay_send_async`      |

#### 2c. `apps/server/src/services/core/__tests__/tool-filter.test.ts`

| Line | Current                                                 | New                                                       |
| ---- | ------------------------------------------------------- | --------------------------------------------------------- |
| 154  | `'mcp__dorkos__relay_query'`                            | `'mcp__dorkos__relay_send_and_wait'`                      |
| 155  | `'mcp__dorkos__relay_dispatch'`                         | `'mcp__dorkos__relay_send_async'`                         |
| 169  | `'mcp__dorkos__relay_query'`                            | `'mcp__dorkos__relay_send_and_wait'`                      |
| 172  | `'mcp__dorkos__relay_dispatch'`                         | `'mcp__dorkos__relay_send_async'`                         |
| 176  | `includes relay_dispatch and relay_unregister_endpoint` | `includes relay_send_async and relay_unregister_endpoint` |
| 179  | `'mcp__dorkos__relay_dispatch'`                         | `'mcp__dorkos__relay_send_async'`                         |
| 183  | `excludes relay_dispatch and relay_unregister_endpoint` | `excludes relay_send_async and relay_unregister_endpoint` |
| 186  | `'mcp__dorkos__relay_dispatch'`                         | `'mcp__dorkos__relay_send_async'`                         |

#### 2d. `apps/server/src/services/core/__tests__/mcp-server.test.ts`

| Line | Current                       | New                                |
| ---- | ----------------------------- | ---------------------------------- |
| 171  | `toContain('relay_query')`    | `toContain('relay_send_and_wait')` |
| 172  | `toContain('relay_dispatch')` | `toContain('relay_send_async')`    |

### Phase 3: Documentation (1 file)

#### 3a. `docs/guides/relay-messaging.mdx`

| Line | Current                                       | New                             |
| ---- | --------------------------------------------- | ------------------------------- |
| 110  | `relay_query`                                 | `relay_send_and_wait`           |
| 111  | `relay_dispatch`                              | `relay_send_async`              |
| 120  | `**\`relay_query\`\*\*` and all references    | `**\`relay_send_and_wait\`\*\*` |
| 122  | `**\`relay_dispatch\`\*\*` and all references | `**\`relay_send_async\`\*\*`    |

### Phase 4: Changelog (1 file)

#### 4a. `docs/changelog.mdx`

| Line | Current                             | New                                         |
| ---- | ----------------------------------- | ------------------------------------------- |
| 354  | `relay_query progress accumulation` | `relay_send_and_wait progress accumulation` |
| 356  | `relay_dispatch fire-and-poll`      | `relay_send_async fire-and-poll`            |
| 398  | `relay_query blocking MCP tool`     | `relay_send_and_wait blocking MCP tool`     |
| 421  | `Register relay_query`              | `Register relay_send_and_wait`              |

### Phase 5: Decision Records (3 files)

#### 5a. `decisions/0077-relay-dispatch-fire-and-poll-for-long-running-tasks.md`

Update all references to `relay_dispatch` → `relay_send_async` and `relay_query` → `relay_send_and_wait` throughout the document, including:

- Title (line 3 and 10)
- Context section
- Decision section
- Consequences section (lines 29, 31)

#### 5b. `decisions/0081-in-process-progress-aggregation-for-relay-query.md`

Update all references to `relay_query` → `relay_send_and_wait` and `relay_dispatch` → `relay_send_async` throughout the document, including:

- Title (line 3 and 10)
- Context section
- Decision section
- Consequences section (lines 29, 30, 37)

#### 5c. `decisions/manifest.json`

| Line | Current                   | New                   |
| ---- | ------------------------- | --------------------- |
| 593  | `relay_query` in title    | `relay_send_and_wait` |
| 602  | `relay_dispatch` in title | `relay_send_async`    |

#### 5d. `decisions/archive/0078-cca-dispatch-streaming-gated-on-inbox-prefix.md`

Update 2 references to the new tool names.

### Phase 6: Specs (2 spec directories)

#### 6a. `specs/relay-async-query/` (108 occurrences across 5 files)

Bulk find-and-replace across all files in this directory:

- `relay_query` → `relay_send_and_wait`
- `relay_dispatch` → `relay_send_async`

#### 6b. `specs/relay-inbox-lifecycle/` (89 occurrences across 5 files)

Bulk find-and-replace across all files in this directory:

- `relay_query` → `relay_send_and_wait`
- `relay_dispatch` → `relay_send_async`

## Validation

After all changes:

1. **Run tests:** `pnpm vitest run apps/server/src/services/core/__tests__/mcp-relay-tools.test.ts apps/server/src/services/core/__tests__/mcp-tool-server.test.ts apps/server/src/services/core/__tests__/tool-filter.test.ts apps/server/src/services/core/__tests__/mcp-server.test.ts`
2. **Typecheck:** `pnpm typecheck` — no type errors expected (tool names are string literals, not type-level)
3. **Grep for orphans:** `grep -r 'relay_query\|relay_dispatch' apps/server/src/ docs/ decisions/ specs/ --include='*.ts' --include='*.tsx' --include='*.md' --include='*.mdx' --include='*.json'` — should return zero matches (except this spec itself and the research file)
4. **Verify relay_send untouched:** Confirm `relay_send` references are unchanged

## Acceptance Criteria

- [ ] `relay_query` tool name string does not appear anywhere in source, tests, docs, specs, or ADRs (replaced by `relay_send_and_wait`)
- [ ] `relay_dispatch` tool name string does not appear anywhere in source, tests, docs, specs, or ADRs (replaced by `relay_send_async`)
- [ ] `relay_send` tool name string is unchanged
- [ ] All 4 test files pass
- [ ] Typecheck passes
- [ ] Internal function names (`createRelayQueryHandler`, `createRelayDispatchHandler`) are unchanged
- [ ] Subject prefixes (`relay.inbox.query.*`, `relay.inbox.dispatch.*`) are unchanged
- [ ] No behavior changes — only naming

## Risk Assessment

**Risk: LOW**

- Pure string replacement with no semantic changes
- No API contract changes
- No schema migrations
- No runtime behavior changes
- All changes are in a single domain (relay tool naming)
- Easy to verify completeness via grep
