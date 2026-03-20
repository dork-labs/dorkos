---
slug: agent-permission-mode
number: 135
created: 2026-03-15
status: ideation
---

# Agent Permission Mode for Adapter Bindings

**Slug:** agent-permission-mode
**Author:** Claude Code
**Date:** 2026-03-15
**Branch:** preflight/agent-permission-mode

---

## 1) Intent & Assumptions

- **Task brief:** When messages are sent to agents via external adapters (Slack, Telegram), responses often fail to complete because the agent requires tool approval — e.g., Claude Code's "default" mode prompts for permission on file edits and shell commands. We need to expose runtime-specific permission modes (like `acceptEdits`, `bypassPermissions`) so users can configure how autonomous an agent should be when receiving adapter messages. The key design question is where this setting belongs: binding, adapter, or runtime level.

- **Assumptions:**
  - The `AgentRuntime` interface already abstracts runtime-specific capabilities, including `supportedPermissionModes`
  - `PermissionModeSchema` already defines the enum (`default`, `plan`, `acceptEdits`, `bypassPermissions`)
  - `MessageOpts.permissionMode` exists but is never populated from adapter/binding context
  - Different runtimes have different permission models (Claude Code has 4+ modes; OpenCode has a different system)
  - Bindings already carry per-adapter-agent permission flags (`canReply`, `canInitiate`, `canReceive`)
  - The Pulse scheduler already uses `acceptEdits` as its default for headless runs

- **Out of scope:**
  - Per-tool granular permissions (e.g., "allow Bash but not file writes") — just the runtime's top-level mode
  - Creating new permission models — we surface what the runtime supports
  - Changes to how Claude Code SDK handles permission modes internally
  - Adapter-level configuration (too coarse; resolved in clarification)

## 2) Pre-reading Log

- `packages/shared/src/schemas.ts`: `PermissionModeSchema` = `z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions'])` — the canonical enum
- `packages/shared/src/agent-runtime.ts`: `SessionOpts.permissionMode` (required at session creation), `MessageOpts.permissionMode` (optional per-message override), `RuntimeCapabilities.supportedPermissionModes` (array of modes the runtime supports)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`: Declares `CLAUDE_CODE_CAPABILITIES` with `supportedPermissionModes: ['default', 'plan', 'acceptEdits', 'bypassPermissions']` and `supportsPermissionModes: true`
- `apps/server/src/services/runtimes/claude-code/message-sender.ts` (lines 154-179): Maps `session.permissionMode` to SDK options; sets `allowDangerouslySkipPermissions: true` when mode is `bypassPermissions`
- `packages/shared/src/relay-adapter-schemas.ts` (lines 272-289): `AdapterBindingSchema` has `canInitiate`, `canReply`, `canReceive` but **no `permissionMode` field** — this is the gap
- `apps/server/src/services/relay/binding-store.ts` (lines 129-143): `update()` method signature includes only `sessionStrategy`, `label`, `chatId`, `channelType`, `canInitiate`, `canReply`, `canReceive` — no `permissionMode`
- `apps/server/src/services/relay/binding-router.ts` (lines 107-178): Routes inbound messages, creates sessions, enriches payload with `__bindingPermissions` — but never injects `permissionMode`
- `apps/server/src/services/relay/adapter-manager.ts`: Uses hardcoded `permissionMode: 'auto'` in `ensureSession()` — **bug**: `'auto'` is not a valid value in `PermissionModeSchema`
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx` (lines 139-142): UI state for `canInitiate`, `canReply`, `canReceive` — no `permissionMode` selector
- `contributing/relay-adapters.md`: Complete adapter lifecycle guide, config patterns, manifest structure
- `decisions/0085-agent-runtime-interface-as-universal-abstraction.md`: Established `AgentRuntime` as the universal abstraction with `RuntimeCapabilities`
- `decisions/0047-most-specific-first-binding-resolution.md`: Binding resolution scoring algorithm

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/shared/src/relay-adapter-schemas.ts` — AdapterBinding schema (needs `permissionMode` field)
  - `packages/shared/src/schemas.ts` — PermissionModeSchema enum definition
  - `packages/shared/src/agent-runtime.ts` — AgentRuntime interface, SessionOpts, MessageOpts, RuntimeCapabilities
  - `apps/server/src/services/relay/binding-store.ts` — Binding persistence, CRUD
  - `apps/server/src/services/relay/binding-router.ts` — Inbound message routing, session creation
  - `apps/server/src/services/relay/adapter-manager.ts` — Adapter lifecycle (contains `'auto'` bug)
  - `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — RuntimeCapabilities definition
  - `apps/server/src/services/runtimes/claude-code/message-sender.ts` — Permission mode → SDK options mapping
  - `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx` — Binding create/edit UI

- **Shared dependencies:**
  - `PermissionModeSchema` (shared/schemas.ts) — used by runtime, session, and will be used by binding
  - `RuntimeCapabilities` (shared/agent-runtime.ts) — declares what modes each runtime supports
  - TanStack Query hooks for bindings (`useBindings`, `useCreateBinding`, `useUpdateBinding`)

- **Data flow:**

  ```
  Slack message → SlackAdapter → relayCore.publish('relay.human.slack.{chatId}')
    → BindingRouter.handleInbound() → resolve binding → check canReceive
    → resolveSession(binding, chatId) → runtime.ensureSession(sessionId, opts)
    → [MISSING: inject binding.permissionMode into opts]
    → runtime.sendMessage(sessionId, content, messageOpts)
    → message-sender.ts maps permissionMode → SDK options
    → SDK query() with permissionMode
  ```

- **Feature flags/config:** None — permission mode is a pure runtime setting

- **Potential blast radius:**
  - Direct: 5 files (schema, binding-store, binding-router, adapter-manager, BindingDialog)
  - Indirect: 4 test files
  - No breaking changes — new optional field with sensible default

## 4) Root Cause Analysis

N/A — this is a feature, not a bug fix.

(Note: there IS a bug discovered during exploration — `adapter-manager.ts` passes `permissionMode: 'auto'` which is not a valid enum value. This should be fixed as part of this work.)

## 5) Research

### Claude Agent SDK Permission Modes

The Claude Agent SDK supports these permission modes:

| Mode                | Behavior                                           | Use Case                           |
| ------------------- | -------------------------------------------------- | ---------------------------------- |
| `default`           | Prompts for all tool usage                         | Interactive CLI sessions           |
| `plan`              | Can read files but prompts for writes              | Planning/review workflows          |
| `acceptEdits`       | Auto-approves file edits, prompts for Bash/network | Headless coding tasks              |
| `bypassPermissions` | Auto-approves everything                           | Fully autonomous, trusted contexts |

In headless (non-TTY) contexts, `default` mode causes tools to be **auto-denied** (not stalled), which means the agent skips tools silently. The SDK uses `allowDangerouslySkipPermissions: true` for bypass mode.

### OpenCode Permission System

OpenCode uses a different model: per-tool allow/deny lists rather than named modes. It doesn't map cleanly to Claude Code's modes but can be abstracted via `RuntimeCapabilities` — future runtimes declare their own supported modes.

### Multi-Runtime Orchestration Patterns

Agent orchestration frameworks (CrewAI, AutoGen, LangGraph) generally handle this at the agent or task level, not per-communication-channel. However, DorkOS's binding model is unique — a single agent can serve multiple adapters with different trust levels (local CLI vs. public Slack workspace).

### Potential Solutions

**1. Binding-level permission mode (Recommended)**

- Add `permissionMode` to `AdapterBindingSchema`
- Each adapter-agent pair configures its own mode
- Pros: Maximum granularity, natural UI placement alongside existing permissions, different trust levels per channel
- Cons: Slightly more fields per binding
- Complexity: Medium
- Maintenance: Low (leverages existing `PermissionModeSchema`)

**2. Agent/Runtime-level permission mode**

- Set on the agent itself, all bindings share the same mode
- Pros: Simpler mental model
- Cons: Can't differentiate trust levels (Slack vs. Telegram vs. local); a single agent serving a public Slack and a private Telegram group would need the same mode
- Complexity: Low
- Maintenance: Low

**3. Adapter-level permission mode**

- Set on the adapter instance, all agents connected via that adapter use the same mode
- Pros: Fewest configuration points
- Cons: Too coarse; can't vary by agent for the same adapter; mixes infrastructure config with session semantics
- Complexity: Low
- Maintenance: Low

**4. Message-level override only**

- Use `MessageOpts.permissionMode` in enriched payload
- Pros: Already exists in the interface, maximum flexibility
- Cons: No UI for users; adapters must parse payload; error-prone
- Complexity: Low (no schema change)
- Maintenance: Medium (no validation)

### Security Considerations

- **External adapters are inherently less trusted** than local CLI — any Slack workspace member who can message the bot can trigger agent actions
- `bypassPermissions` on external-facing bindings is a significant security risk — full filesystem access via any Slack message
- The `acceptEdits` mode is the right balance for most adapter use cases: agents can edit files (the core value proposition) but Bash/network tools get auto-denied in headless contexts
- A UI warning/acknowledgment for `bypassPermissions` on external adapters is the honest, Dieter Rams approach

### Recommendation

**Binding-level permission mode** with `acceptEdits` as the default. This leverages all existing plumbing (`PermissionModeSchema`, `RuntimeCapabilities`, `MessageOpts`), provides per-binding granularity for different trust levels, and places the setting naturally alongside existing binding permissions in the UI.

The default of `acceptEdits` matches the Pulse scheduler's precedent for headless agent runs — it lets agents do file-editing work without blocking while constraining Bash/network operations.

## 6) Decisions

| #   | Decision                                 | Choice                              | Rationale                                                                                                                                                                                                                                          |
| --- | ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where should permission mode live?       | Binding level                       | Both agents converged strongly on this. Binding already contains adapter-to-agent routing logic and permission flags (canReply, canInitiate). Natural placement. Allows different modes per adapter-agent pair (Slack=acceptEdits, Telegram=plan). |
| 2   | Default permission mode for new bindings | `acceptEdits`                       | Matches Pulse scheduler precedent for headless runs. Lets agents edit files without blocking. Bash/network tools auto-denied in headless mode rather than stalling. Best balance of autonomy and safety.                                           |
| 3   | Security UX for `bypassPermissions`      | Warning with acknowledgment         | AlertDialog warning that any user in the Slack workspace/Telegram chat can trigger unrestricted agent actions. Requires explicit confirmation. Honest by design (Dieter Rams: "Good design is honest").                                            |
| 4   | Filter modes by runtime capabilities?    | Yes, filter by runtime capabilities | Only show modes the agent's runtime supports (via `RuntimeCapabilities.supportedPermissionModes`). Prevents invalid configurations. The data already exists — ClaudeCodeRuntime declares its supported modes.                                      |
