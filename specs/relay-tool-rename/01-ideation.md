---
slug: relay-tool-rename
number: 160
created: 2026-03-21
status: specified
---

# Rename Relay MCP Tools for Clarity

**Slug:** relay-tool-rename
**Author:** Claude Code
**Date:** 2026-03-21
**Branch:** preflight/relay-tool-rename

---

## 1) Intent & Assumptions

- **Task brief:** Rename the user-facing Relay MCP tool name strings so the response strategy is self-documenting. `relay_query` becomes `relay_send_and_wait` (blocks until reply), `relay_dispatch` becomes `relay_send_async` (returns inbox to poll). `relay_send` stays as-is (fire-and-forget).
- **Assumptions:**
  - Only user-facing tool name strings and their mentions in docs/tests/descriptions change
  - Internal handler/factory function names (e.g. `createRelayQueryHandler`) stay unchanged
  - Subject prefixes (`relay.inbox.query.*`, `relay.inbox.dispatch.*`) stay unchanged
  - No behavior changes — only naming
- **Out of scope:**
  - Renaming internal code (`createRelayQueryHandler`, `createRelayDispatchHandler`, etc.)
  - Changing tool behavior or API routes
  - Modifying the relay core library (`packages/relay/`)
  - Changing subject prefix patterns used for inbox routing

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts` (471 lines): Primary tool definitions. Tool names registered as string literals at lines ~403 (`'relay_query'`) and ~441 (`'relay_dispatch'`). Tool descriptions cross-reference each other (e.g., "use relay_dispatch instead" in the relay_query description).
- `apps/server/src/services/runtimes/claude-code/tool-filter.ts` (163 lines): Tool allowlists. Lines ~61-62 contain `'mcp__dorkos__relay_query'` and `'mcp__dorkos__relay_dispatch'` in the `RELAY_TOOLS` constant.
- `apps/server/src/services/runtimes/claude-code/context-builder.ts` (371 lines): Agent documentation context injected into system prompts. `RELAY_TOOLS_CONTEXT` string references all three tool names in workflow examples.
- `apps/server/src/services/core/__tests__/mcp-relay-tools.test.ts`: Test suite with describe block referencing `relay_query`.
- `apps/server/src/services/core/__tests__/mcp-tool-server.test.ts`: Tool registration tests asserting `toolNames.toContain('relay_query')` and `toolNames.toContain('relay_dispatch')`.
- `apps/server/src/services/core/__tests__/tool-filter.test.ts`: Filter tests asserting tool names with `mcp__dorkos__` prefix.
- `apps/server/src/services/core/__tests__/mcp-server.test.ts`: MCP server tests asserting tool name registration.
- `specs/relay-async-query/02-specification.md`: Feature spec with ~40+ references to old tool names.
- `specs/relay-inbox-lifecycle/02-specification.md`: Enhancement spec with ~50+ references.
- `decisions/0077-relay-dispatch-fire-and-poll-for-long-running-tasks.md`: ADR documenting the dispatch pattern.
- `decisions/0081-in-process-progress-aggregation-for-relay-query.md`: ADR documenting query progress.
- `docs/guides/relay-messaging.mdx`: User-facing documentation with ~10-20 references.
- `packages/relay/src/adapters/claude-code-adapter.ts`: Uses subject prefixes (`relay.inbox.dispatch.*`, `relay.inbox.query.*`) — NOT tool names. No changes needed.
- `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`: Uses subject prefixes, not tool names. No changes needed.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts` — Tool handler definitions and registration
  - `apps/server/src/services/runtimes/claude-code/tool-filter.ts` — Tool allowlist constants
  - `apps/server/src/services/runtimes/claude-code/context-builder.ts` — Agent context documentation
- **Shared dependencies:**
  - `packages/relay/src/adapters/claude-code-adapter.ts` — Uses subject prefixes (not tool names, no changes)
  - `packages/relay/src/relay.ts` — Core publish/subscribe (no tool name references)
- **Data flow:** Tool name string → MCP SDK wraps as `mcp__dorkos__<name>` → tool-filter checks against allowlist → context-builder injects documentation → agent invokes tool by name
- **Feature flags/config:** None — tool names are hardcoded string literals
- **Potential blast radius:**
  - **Direct (3 source files):** relay-tools.ts, tool-filter.ts, context-builder.ts
  - **Tests (4 files):** mcp-relay-tools.test.ts, mcp-tool-server.test.ts, tool-filter.test.ts, mcp-server.test.ts
  - **Specs (2 files):** relay-async-query spec, relay-inbox-lifecycle spec
  - **Docs (1 file):** relay-messaging.mdx
  - **ADRs (2 files):** 0077, 0081
  - **Total: ~12 files, ~180-200 string replacements**

## 4) Root Cause Analysis

_Not applicable — this is a rename, not a bug fix._

## 5) Research

Research saved to `research/20260321_relay_tool_naming_proposal.md`.

- **Potential solutions:**
  1. **Proposed names (`relay_send_and_wait`, `relay_send_async`)**
     - Pros: Fully self-documenting; response strategy is in the name; `send_and_wait` reads naturally as "send, then wait for reply"; `send_async` clearly signals non-blocking with pollable result
     - Cons: Longer names (16-19 chars vs 11-14); departs from the `domain_verb` pattern used by other tools; no direct industry precedent for `send_and_wait` as a tool name
     - Complexity: Low
     - Maintenance: Low

  2. **Hybrid adjectives (`relay_query_wait`, `relay_dispatch_async`)**
     - Pros: Shorter; preserves original verb identity; minimal pattern disruption
     - Cons: Suffixes feel tacked-on; `query_wait` is redundant (query already implies waiting); doesn't solve the core issue that `query` and `dispatch` don't communicate the response strategy
     - Complexity: Low
     - Maintenance: Low

  3. **Status quo with improved descriptions**
     - Pros: Zero migration cost; names are brief and industry-aligned (NATS uses `Request` for sync)
     - Cons: Doesn't solve the discoverability problem; agents must read descriptions to understand semantics; the three names sound like synonyms for "send a message"
     - Complexity: None
     - Maintenance: None

- **Recommendation:** Approach 1 (proposed names). The whole point of the rename is that the tool names should communicate their response strategy without requiring agents to read descriptions. The hybrid approach doesn't achieve this — `query_wait` is still opaque about _what_ it's waiting for. The proposed names make the response pattern a first-class part of the tool's identity.

## 6) Decisions

| #   | Decision      | Choice                                               | Rationale                                                                                                                              |
| --- | ------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Naming scheme | Proposed: `relay_send_and_wait` + `relay_send_async` | Fully self-documenting. Makes the response strategy explicit in the name. User confirmed this over hybrid and status-quo alternatives. |
