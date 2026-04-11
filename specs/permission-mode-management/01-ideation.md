---
slug: permission-mode-management
number: 230
created: 2026-04-10
status: ideation
---

# Permission Mode Management

**Slug:** permission-mode-management
**Author:** Claude Code
**Date:** 2026-04-10
**Branch:** preflight/permission-mode-management

---

## Source Material

- **Existing spec #135:** `specs/agent-permission-mode/01-ideation.md` and `02-specification.md` — covers adapter binding permission modes only (never implemented, 0/7 tasks). This new spec supersedes #135 by addressing the full permission mode story across both chat UI and adapter bindings.

---

## 1) Intent & Assumptions

- **Task brief:** Permission modes in the chat client UI sometimes don't "stick" — changing the mode during streaming has no effect until the next query. The application only displays 4 of the 6 SDK-supported permission modes (`dontAsk` and `auto` are missing). We need: (1) mid-stream mode changes via SDK `setPermissionMode()`, (2) all 6 modes supported, (3) dynamic mode rendering from runtime capabilities, (4) optimistic UI updates in the status bar, (5) graceful handling of `auto` mode's strict prerequisites, (6) a runtime-agnostic architecture that works with future runtimes.

- **Assumptions:**
  - The Claude Agent SDK `Query` object exposes `.setPermissionMode(mode)` for mid-stream changes
  - The `Query` object is already tracked in `runtime-cache.ts` (accessible during streaming)
  - `RuntimeCapabilities.supportedPermissionModes` is the right abstraction for per-runtime mode lists
  - The existing `/api/capabilities` endpoint already serves runtime capabilities to the client
  - The existing optimistic update pattern in `use-session-status.ts` is architecturally sound
  - `auto` mode prerequisites (Team/Enterprise plan, admin-enabled, Sonnet 4.6/Opus 4.6, Anthropic API only) cannot be detected from the SDK — we must try and handle failure gracefully

- **Out of scope:**
  - Per-tool granular permissions (e.g., "allow Bash but not file writes") — just the runtime's top-level mode
  - OpenCode-specific permission mode mapping (deferred until that runtime exists)
  - Adapter binding permission modes (spec #135 scope — can be implemented as a follow-up using the same expanded schema)
  - `allowedTools` configuration UI (separate feature)
  - Claude Code admin settings detection for `auto` mode gating

## 2) Pre-reading Log

- `packages/shared/src/schemas.ts`: `PermissionModeSchema = z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions'])` — **missing `dontAsk` and `auto`**
- `packages/shared/src/agent-runtime.ts`: `AgentRuntime` interface with `RuntimeCapabilities.supportedPermissionModes: PermissionMode[]`, `SessionOpts.permissionMode` (required), `MessageOpts.permissionMode` (optional per-message override)
- `apps/client/src/layers/entities/session/model/use-session-status.ts`: Optimistic UI pattern with `localPermissionMode` state + convergence effect. **Bug:** `if (opts.permissionMode)` is a falsy guard that prevents reverting to `"default"` (empty string is falsy, but `"default"` is truthy — actually this specific bug depends on the guard structure; needs verification)
- `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx`: Dropdown with 4 modes (Shield/ClipboardList/ShieldCheck/ShieldOff icons), descriptions, dangerous mode in red
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx`: Orchestrates all status bar items, wires `useSessionStatus` to PermissionModeItem callbacks
- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts`: `CLAUDE_CODE_CAPABILITIES.supportedPermissionModes: ['default', 'plan', 'acceptEdits', 'bypassPermissions']` — **missing 2 modes**
- `apps/server/src/services/runtimes/claude-code/message-sender.ts` (lines 223-231): **Bug:** Allowlist check silently falls back to `default` for any mode not in the 3-value hardcoded list (`bypassPermissions`, `plan`, `acceptEdits`). Must be changed to a passthrough for all valid `PermissionMode` values.
- `apps/server/src/services/runtimes/claude-code/runtime-cache.ts`: Tracks active `Query` objects per session. Model caching with memory → disk → lazy warm-up (24h TTL).
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`: `updateSession()` writes to in-memory session store but does NOT call `setPermissionMode()` on active query — **this is the root cause of "modes don't stick"**
- `apps/server/src/routes/sessions.ts`: `PATCH /api/sessions/:id` accepts `permissionMode` in `UpdateSessionRequestSchema`, calls `runtime.updateSession()`
- `apps/server/src/routes/capabilities.ts`: `GET /api/capabilities` returns `RuntimeCapabilities` including `supportedPermissionModes`
- `apps/server/src/routes/models.ts`: `GET /api/models` returns `ModelOption[]` — the caching pattern we reference
- `packages/test-utils/src/fake-agent-runtime.ts`: `FakeAgentRuntime` implements all `AgentRuntime` methods as `vi.fn()` spies
- `specs/agent-permission-mode/02-specification.md`: Existing spec #135 for adapter binding permission modes (never implemented)

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/shared/src/schemas.ts` — `PermissionModeSchema` enum (needs expansion from 4 → 6)
  - `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx` — Permission mode dropdown UI (needs 2 new modes)
  - `apps/client/src/layers/entities/session/model/use-session-status.ts` — Optimistic UI hook (needs falsy-guard fix)
  - `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx` — Status bar orchestration
  - `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — `updateSession()` must call `setPermissionMode()` on active query
  - `apps/server/src/services/runtimes/claude-code/message-sender.ts` — Allowlist bug, needs passthrough for all valid modes
  - `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` — `supportedPermissionModes` needs 2 new entries
  - `apps/server/src/services/runtimes/claude-code/runtime-cache.ts` — Stores active `Query` objects, needed for mid-stream `setPermissionMode()`

- **Shared dependencies:**
  - `PermissionModeSchema` (shared/schemas.ts) — consumed by runtime, session, binding, and UI
  - `RuntimeCapabilities` (shared/agent-runtime.ts) — declares what modes each runtime supports
  - `Transport` interface (shared/transport.ts) — `getCapabilities()` method for client-side fetching
  - TanStack Query — session cache, capabilities cache, optimistic updates

- **Data flow:**

  Current (broken for mid-stream):

  ```
  User clicks mode in PermissionModeItem
    → setLocalPermissionMode(newMode)          [optimistic UI]
    → transport.updateSession({ permissionMode })
    → PATCH /api/sessions/:id
    → runtime.updateSession() writes to session store
    → NEXT sendMessage() reads session.permissionMode
    → message-sender maps to SDK options
    → query({ options: { permissionMode } })
  ```

  Fixed (mid-stream support):

  ```
  User clicks mode in PermissionModeItem
    → setLocalPermissionMode(newMode)          [optimistic UI]
    → transport.updateSession({ permissionMode })
    → PATCH /api/sessions/:id
    → runtime.updateSession() writes to session store
    → IF active query exists for session:
        → query.setPermissionMode(newMode)     [immediate effect]
    → ELSE: next sendMessage() uses new mode   [deferred effect]
  ```

- **Feature flags/config:** None — permission modes are always available

- **Potential blast radius:**
  - Direct: 6 files (schema, runtime-constants, message-sender, claude-code-runtime, PermissionModeItem, use-session-status)
  - Indirect: Test files for each of the above, FakeAgentRuntime
  - No breaking changes — additive schema expansion with backward-compatible defaults

## 4) Root Cause Analysis

This is a feature enhancement with embedded bug fixes. The primary "modes don't stick" issue has a clear root cause:

- **Observed:** User changes permission mode during streaming → mode appears to change in UI (optimistic) → but Claude's current tool approval behavior doesn't change until the next message
- **Expected:** Mode change takes effect immediately, even during active streaming
- **Root cause:** `runtime.updateSession()` writes the new mode to the in-memory session store but does NOT call `query.setPermissionMode()` on the active SDK `Query` object. The SDK designed `setPermissionMode()` specifically for this use case.
- **Evidence:** `message-sender.ts` reads `session.permissionMode` once at query start (line 223). No subsequent reads. The `Query` object in `runtime-cache.ts` is never mutated after creation.
- **Fix:** In `claude-code-runtime.ts` `updateSession()`, if an active query exists for the session, call `query.setPermissionMode(opts.permissionMode)`.

Additional bugs discovered:

1. **`message-sender.ts` allowlist fallback** (lines 223-228): Silently falls back to `default` for any mode not in `['bypassPermissions', 'plan', 'acceptEdits']`. Must passthrough all valid `PermissionMode` values.
2. **`use-session-status.ts` falsy guard**: `if (opts.permissionMode)` — needs verification that this doesn't prevent reverting to `"default"` mode.

## 5) Research

### Claude Agent SDK Permission Modes (Complete — All 6)

| Mode                | What runs without asking                  | Headless behavior                                          | Risk level  |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------- | ----------- |
| `default`           | Reads only                                | Prompts via `canUseTool`                                   | Low         |
| `plan`              | Reads only (no writes)                    | Same as default; Claude writes a plan                      | Very low    |
| `acceptEdits`       | Reads + file edits + common FS cmds       | Prompts for non-file tools                                 | Medium      |
| `dontAsk`           | Only pre-approved `allowedTools` entries  | Denies anything not in allowlist; never calls `canUseTool` | Medium      |
| `bypassPermissions` | Everything (except protected paths)       | Requires `allowDangerouslySkipPermissions: true`           | High        |
| `auto`              | Everything, with background AI classifier | Non-interactive: 3 consecutive or 20 total blocks aborts   | Medium-High |

### `auto` Mode Requirements (All Must Be Met)

- SDK version: Claude Code v2.1.83+
- Account plan: Team, Enterprise, or API (not Pro or Max)
- Admin must enable in Claude Code admin settings
- Model: Sonnet 4.6 or Opus 4.6 only
- Provider: Anthropic API only (not Bedrock, Vertex, Foundry)

### `auto` Mode Quirks

- Silently drops broad allow rules on entry (`Bash(*)`, wildcarded interpreters, `Agent` rules)
- Narrow rules like `Bash(npm test)` carry over
- Non-interactive: 3 consecutive tool blocks or 20 total blocks aborts the session

### Key SDK Methods

- `query({ options: { permissionMode } })` — set mode at query time
- `query.setPermissionMode(mode)` — change mode mid-stream (immediate effect)
- `allowDangerouslySkipPermissions: true` — required for `bypassPermissions` mode

### Known Gotchas

1. **No dynamic discovery API** — modes are statically typed, no `listPermissionModes()` exists
2. **`bypassPermissions` + root user = crash** — requires `IS_SANDBOX: '1'` env var
3. **Subagent inheritance** — `bypassPermissions` propagates to all subagents, cannot be overridden
4. **`allowedTools` doesn't constrain `bypassPermissions`** — only `disallowedTools` (deny rules) work

### Potential Solutions

**1. SDK `setPermissionMode()` mid-stream (Chosen)**

- Call `q.setPermissionMode(newMode)` on the active Query when session is updated
- Pros: Instant effect, no stream interruption, SDK-designed for this
- Cons: Requires access to active Query object (already tracked in runtime-cache)
- Complexity: Low — one-line addition in `updateSession()`

**2. Abort and re-query**

- Cancel active query, restart with new mode on next message
- Pros: Simple, stateless
- Cons: Loses current turn, terrible UX
- Complexity: Low, but bad UX

**3. Queue for next query (current behavior — causes the bug)**

- Mode change only applies on next `sendMessage()`
- Pros: Already implemented
- Cons: Source of "modes don't stick" — user confusion

### Recommendation

**SDK `setPermissionMode()` mid-stream** is the correct fix. The `Query` object is already tracked. One-line addition to `updateSession()`. Combined with schema expansion (4 → 6 modes), message-sender passthrough fix, and `auto` mode graceful failure handling, this creates a complete, runtime-agnostic permission mode management system.

## 6) Decisions

| #   | Decision                        | Choice                                                              | Rationale                                                                                                                                                                                                                                                          |
| --- | ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Mid-stream mode change strategy | SDK `setPermissionMode()` on active Query                           | The SDK method exists for exactly this use case. The Query object is already tracked in runtime-cache. Immediate effect, no stream interruption. Approach B (abort) has terrible UX; approach C (queue) is the current bug.                                        |
| 2   | `auto` mode handling            | Always show, fail gracefully                                        | Prerequisites can't be detected from SDK. Show in picker, attempt on selection. If SDK rejects, surface clear toast with requirements, revert to previous mode. Discoverable + honest.                                                                             |
| 3   | Runtime-agnostic mode discovery | Runtime declares via `RuntimeCapabilities.supportedPermissionModes` | Already the architectural pattern. Each runtime self-describes its supported modes. Client fetches via `/api/capabilities` and renders dynamically. Future runtimes just declare their own list — UI adapts automatically. No shared hardcoded list in the client. |
