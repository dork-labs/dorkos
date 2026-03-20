---
slug: agent-runtime-review-remediation
number: 99
created: 2026-03-06
status: ideation
---

# Agent Runtime Abstraction — Review Remediation

**Slug:** agent-runtime-review-remediation
**Author:** Claude Code
**Date:** 2026-03-06
**Branch:** preflight/agent-runtime-review-remediation

---

## 1) Intent & Assumptions

- **Task brief:** Address 12 issues identified in the code review of commit `bc0fe8b` (agent-runtime-abstraction refactor). Issues span stale imports, routes bypassing RuntimeRegistry, backward-compatibility shims, type safety gaps, a dead interface stub, and file size violations. All 1168 server tests pass — this is cleanup, not behavior change.
- **Assumptions:**
  - The original spec (`specs/agent-runtime-abstraction/02-specification.md`) is the source of truth for intended design
  - All 12 issues are confirmed via codebase exploration — none were resolved between the review and this ideation
  - The Obsidian plugin is an in-repo consumer (not an external npm package), so import path changes don't require a deprecation window
  - No second runtime is being added yet, but the abstraction should be honest for when one arrives
- **Out of scope:**
  - Adding new runtimes or changing runtime behavior
  - Modifying the `AgentRuntime` interface contract beyond fixing the 3 identified type/design issues
  - Performance optimization of TranscriptReader caching (consolidating the singleton is enough)

## 2) Pre-reading Log

- `apps/obsidian-plugin/src/views/CopilotView.tsx` (lines 12-14): Imports from stale `@dorkos/server/services/agent-manager` path
- `apps/server/package.json` (lines 7-9): Export shims map old paths to new locations
- `apps/server/src/routes/relay.ts` (line 25, 243): Imports module-level `transcriptReader` singleton, bypasses RuntimeRegistry
- `apps/server/src/routes/commands.ts` (lines 2, 11-24): Maintains own `CommandRegistryService` cache, never uses RuntimeRegistry
- `apps/server/src/services/core/index.ts` (line 7): Re-exports `ClaudeCodeRuntime as AgentManager`, leaks claude-code internals
- `packages/shared/src/agent-runtime.ts` (lines 23-25): `SseResponse` only has `on(event: string, cb: () => void)`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` (lines 572-581): `watchSession()` is dead stub
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` (lines 588-590): `acquireLock()` casts `SseResponse as Response`
- `packages/shared/src/agent-runtime.ts` (lines 249, 252): `setMeshCore` and `setRelay` use `unknown` types
- `apps/server/src/services/runtimes/claude-code/transcript-reader.ts` (line 383): Module-level singleton export alongside class
- `packages/relay/src/adapters/claude-code-adapter.ts` (line 114): `AgentManagerLike` interface naming
- `apps/server/src/index.ts` (lines 274-279): `sessionBroadcaster` placed on `app.locals`
- `apps/server/src/routes/sessions.ts` (line 356): Accesses broadcaster via `req.app.locals.sessionBroadcaster`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`: 687 lines total, `sendMessage()` spans lines 271-494 (224 lines)
- `apps/server/src/services/core/__tests__/agent-manager*.test.ts`: 4 test files with stale naming in wrong directory
- `packages/shared/src/agent-runtime.ts`: Full interface — 253 lines, well-structured, defines `RuntimeCapabilities`, `SessionOpts`, `MessageOpts`
- `apps/server/src/routes/sessions.ts`: Reference pattern for correct `runtimeRegistry.getDefault()` usage
- `apps/server/src/routes/models.ts`: Minimal 7-line example of correct runtime access pattern
- `research/20260306_agent_runtime_interface_design_patterns.md`: Research on SseResponse, watchSession, DI patterns, and shim removal strategies

## 3) Codebase Map

**Primary components/modules:**

| File                                                                   | Role                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/shared/src/agent-runtime.ts`                                 | Universal `AgentRuntime` interface + `SseResponse`, `RuntimeCapabilities`, DI method signatures |
| `apps/server/src/services/core/runtime-registry.ts`                    | Registry of runtimes keyed by type; routes call `getDefault()`                                  |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` | Claude Code runtime (687 lines) — session mgmt, messaging, SDK integration                      |
| `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` | Watches JSONL files, broadcasts sync events via SSE                                             |
| `apps/server/src/services/runtimes/claude-code/session-lock.ts`        | Session write locks with TTL; accepts Express `Response`                                        |
| `apps/server/src/services/runtimes/claude-code/transcript-reader.ts`   | Reads SDK JSONL transcripts; has stale module-level singleton                                   |
| `apps/server/src/services/runtimes/claude-code/command-registry.ts`    | Scans `.claude/commands/` for slash commands                                                    |
| `apps/server/src/services/core/index.ts`                               | Barrel that leaks claude-code internals via re-exports                                          |
| `apps/server/src/routes/relay.ts`                                      | Route that bypasses RuntimeRegistry                                                             |
| `apps/server/src/routes/commands.ts`                                   | Route that bypasses RuntimeRegistry                                                             |
| `apps/server/src/routes/sessions.ts`                                   | Route with correct RuntimeRegistry usage (reference)                                            |
| `apps/obsidian-plugin/src/views/CopilotView.tsx`                       | External consumer with stale import paths                                                       |
| `packages/relay/src/adapters/claude-code-adapter.ts`                   | Uses stale `AgentManagerLike` naming                                                            |

**Shared dependencies:**

- `runtimeRegistry` — correct routes import from `services/core/runtime-registry.ts`
- `app.locals.sessionBroadcaster` — escape hatch for session sync
- `@dorkos/shared/agent-runtime` — interface contract all runtimes implement

**Data flow (correct pattern):**

```
Route → runtimeRegistry.getDefault() → runtime.method() → response
```

**Data flow (incorrect patterns being fixed):**

```
relay.ts:    Route → import transcriptReader singleton → transcriptReader.getSession()
commands.ts: Route → CommandRegistryService cache → registry.getCommands()
sessions.ts: Route → app.locals.sessionBroadcaster → broadcaster.registerClient(res)
```

**Potential blast radius:**

- Direct: ~15 files need changes
- Tests: 4 test files renamed + relocated (2,180 lines)
- Packages: `@dorkos/shared` (interface), `@dorkos/relay` (type naming)
- Plugin: `apps/obsidian-plugin` (import paths)

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

Full research saved at `research/20260306_agent_runtime_interface_design_patterns.md`.

### SseResponse Interface (Issue #5)

| Approach                          | Description                                                                 | Verdict         |
| --------------------------------- | --------------------------------------------------------------------------- | --------------- |
| **Narrow to `'close'` event**     | `on(event: 'close', cb: () => void): void` — express intent, eliminate cast | **Recommended** |
| Keep current, update lock manager | No interface change but remains too broad                                   | Rejected        |
| Use Express Response directly     | Couples session-lock to Express                                             | Rejected        |

Narrowing `SseResponse` to declare `on(event: 'close', ...)` follows the hexagonal port principle: the shared interface declares what the application needs. Express satisfies it structurally.

### watchSession() Design (Issue #6)

| Approach                                | Description                                                                                                   | Verdict         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------- |
| **Make it real via registerCallback()** | Add callback path to SessionBroadcaster; implement watchSession(); remove getSessionBroadcaster() from routes | **Recommended** |
| Remove from interface                   | Sacrifices abstraction; routes need type narrowing                                                            | Rejected        |
| Keep stub + TODO                        | Misleading contract                                                                                           | Rejected        |

VS Code `FileSystemWatcher` precedent: change notification belongs on the interface, returns `() => void` unsubscribe.

### Cross-Package DI (Issue #7)

| Approach                             | Description                                                                       | Verdict         |
| ------------------------------------ | --------------------------------------------------------------------------------- | --------------- |
| **Narrow port interfaces in shared** | Define `AgentRegistryPort` + `RelayPort` capturing only methods the runtime calls | **Recommended** |
| unknown + internal type guards       | Zero type safety at call sites                                                    | Rejected        |
| Generic type parameters              | Identical to unknown in practice                                                  | Rejected        |

TypeScript structural typing means `MeshCore` satisfies `AgentRegistryPort` without `implements` — no circular deps.

### Shim Removal (Issues #1, #4, #9, #12)

Immediate removal recommended for internal monorepo. Grep all consumers, batch-migrate, delete, verify with typecheck.

## 6) Decisions

| #   | Decision                | Choice                   | Rationale                                                                                                                                                              |
| --- | ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | watchSession() handling | Make it real now         | User decision. Invest ~3 files to make the interface honest. Routes call `runtime.watchSession()` instead of `app.locals.sessionBroadcaster`. Clean abstraction today. |
| 2   | Shim removal strategy   | Immediate removal        | User decision. Internal monorepo with no external npm consumers — no deprecation window needed. Grep + batch-migrate + delete + typecheck.                             |
| 3   | Spec scope              | All 4 groups in one spec | User decision. All 12 issues are cleanup from the same refactor (~15-20 file changes). Keeps remediation atomic.                                                       |
