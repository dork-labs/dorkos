---
slug: auto-permission-mode
number: 253
created: 2026-06-09
status: specified
---

# Specification — Auto Mode: Remove the Misplaced Toggle, Adopt Auto as a Permission Mode

**Slug:** auto-permission-mode
**Source:** `specs/auto-permission-mode/01-ideation.md`
**Date:** 2026-06-09

---

## Overview

DorkOS exposes an "Auto" boolean toggle in the Model Config popover's **Mode** section (beside "Fast"). It maps to the Claude Agent SDK `Settings.disableAutoMode` and is **effectively a no-op**: it opts out of auto _permission_ mode, but DorkOS never enters auto mode (`permissionMode: 'auto'` is omitted from the runtime's `permissionModes.values`, and nothing sets it). It is also a **permissions** concept misplaced in the **model** menu, and it duplicates the name/icon of the real `'auto'` permission mode.

This spec delivers two phases:

- **Phase 1 (cleanup, independently mergeable):** remove the no-op `autoMode` toggle and all its plumbing, including the persisted `auto_mode` DB column. Keep the per-model `supportsAutoMode` capability plumbing (Phase 2 reuses it).
- **Phase 2 (feature):** adopt `'auto'` as a real, model-gated permission mode in the Permission Mode menu — a classifier-gated autonomy posture — with the safety UX a research-preview feature requires: per-model gating, a once-per-session entry confirmation, classifier-denial surfacing, a research-preview label, and a safety-critical fix so the classifier's interactive fallback renders approval cards.

## Goals

- Remove a control that does nothing observable and violates conceptual integrity (permissions ≠ model settings).
- Make `'auto'` a first-class, honestly-presented permission mode available only where the active model supports it.
- Preserve DorkOS's safety posture: never silently auto-allow tools; surface autonomous denials.

## Non-Goals

- Surfacing `'dontAsk'` (separately deferred — see `runtime-constants.ts` comment).
- A per-session "lock out of auto mode" guard (reusing `disableAutoMode`) — deferred power-user feature.
- Workflow-launch confirmation UX (never shown in Agent-SDK transport).
- Changing `default`/`acceptEdits`/`plan`/`bypassPermissions` behavior.

---

## Decisions (carried from ideation §6, finalized)

| #   | Decision                    | Resolution                                                                                                                                                                |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope                       | Both phases, in one spec; Phase 1 lands first (independently mergeable).                                                                                                  |
| 2   | The `autoMode` toggle       | Remove toggle + all plumbing. **Keep** `supportsAutoMode` plumbing (Phase 2 reuses it).                                                                                   |
| 3   | `auto_mode` DB column       | DROP via a new drizzle migration. Verified safe — no consumers outside the removed paths.                                                                                 |
| 4   | Per-model gating            | Client filters `'auto'` out of the permission dropdown when `!selectedModel.supportsAutoMode`, with an explanatory tooltip.                                               |
| 5   | Approval cards in auto mode | Bypassed by design — the classifier decides at SDK evaluation step 3, before `canUseTool`.                                                                                |
| 6   | Classifier fallback         | **Safety-critical:** when `canUseTool` is reached in `auto` mode (classifier paused after 3 consecutive / 20 total blocks), render approval cards (treat like `default`). |
| 7   | Entry confirmation          | **Once per session** (client-side per-session state; no persistence). Modal on first switch to `auto` in a given session.                                                 |
| 8   | Risk signaling              | Reuse Sparkles icon + red danger tint; add a "research preview" label.                                                                                                    |
| 9   | Classifier-denial surfacing | **Confirmed feasible.** Map the SDK `system/permission_denied` message → a `permission_denied` StreamEvent → a read-only "blocked" chip in the message stream.            |

---

## Technical Design

### Phase 1 — Remove the no-op `autoMode` toggle

Delete the `autoMode` field and `disableAutoMode` mapping end-to-end. **Do not** remove `supportsAutoMode` (kept for Phase 2).

**Shared / DB**

- `packages/shared/src/schemas.ts` — remove `autoMode` from `SessionSchema` (~:114) and `SessionSettingsSchema` (~:142). Keep `PermissionModeSchema` `'auto'`.
- `packages/shared/src/agent-runtime.ts` — remove `autoMode?` from `updateSession` opts (~:228).
- `packages/db/src/schema/sessions.ts:26` — remove the `auto_mode` column; run `pnpm --filter @dorkos/db drizzle-kit generate` to produce a numbered `DROP COLUMN` migration under `packages/db/drizzle/`.
- `packages/test-utils/src/fake-agent-runtime.ts` — drop `autoMode` from fixtures.

**Server**

- `apps/server/src/routes/sessions.ts` — remove `autoMode` from PATCH destructure/apply and `applyStoredSettings` (~:40, :169, :182, :201).
- `apps/server/src/services/core/runtime-registry.ts` — remove from `SettingsRow`, `rowToSettings`, `pickSettings`, both select clauses (~:12, :23, :34, :228, :275).
- `apps/server/src/services/runtimes/claude-code/agent-types.ts:13` — remove `autoMode?` from `AgentSession`.
- `apps/server/src/services/runtimes/claude-code/sessions/session-store.ts` — remove init/hydrate/update handling (~:83, :113, :125, :195, :243).
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts:204` — remove `autoMode?` from updateSession opts type.
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:272-277` — drop the `disableAutoMode` branch; the settings block becomes `if (session.fastMode) { … fastMode … }`.
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` — drop `autoMode?` from opts.

**Client**

- `apps/client/src/layers/features/status/ui/ModelConfigPopover.tsx` — remove `autoMode`/`supportsAutoMode` from `ModeSectionProps`, the Auto `ModeToggle` (:240-247), the popover's `autoMode`/`onChangeAutoMode` props + state. `ModeSection` becomes **Fast-only** (keep the section; it renders just the Fast toggle).
- `apps/client/src/layers/entities/session/model/use-session-status.ts` — remove `SessionStatusData.autoMode` (:19), `localAutoMode` (:50), derivation (:78), `statusData.autoMode` (:85), and updateSession/effect handling.
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx:290-291` — remove `autoMode`/`onChangeAutoMode` props.

**Tests:** update `session-store-settings.test.ts`, `runtime-registry.test.ts`, `sessions.test.ts`, `ModelConfigPopover.test.tsx`, `use-session-status.test.tsx` to drop `autoMode`.

### Phase 2 — Adopt `'auto'` as a permission mode

#### 2.1 Server — offer the mode

- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` — add to `CLAUDE_CODE_CAPABILITIES.permissionModes.values`:
  ```ts
  {
    id: 'auto',
    label: 'Auto',
    description:
      'A safety classifier approves or denies tool calls automatically — fewer interruptions on long autonomous runs. Research preview.',
  }
  ```
  Passthrough to the SDK is already generic (ADR-0240); `setPermissionMode('auto')` and per-turn `permissionMode` need no further server change. (Confirmed: `claude-code-runtime-interactive.test.ts:625`.)

#### 2.2 Server — safety-critical fallback fix

- `apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts:237` — change the approval gate so `'auto'` is treated like `'default'`:
  ```ts
  if (session.permissionMode === 'default' || session.permissionMode === 'auto') {
    return handleToolApproval(session, context.toolUseID, toolName, input, context);
  }
  ```
  Rationale: in `'auto'`, the classifier resolves at SDK step 3 and `canUseTool` is normally never reached. It is reached **only** after the classifier's fallback (3 consecutive / 20 total blocks), at which point an approval card is the correct, safe response — not the current silent auto-allow.

#### 2.3 Server — surface classifier denials

- Add a `permission_denied` StreamEvent to `packages/shared/src/schemas.ts` (event-type enum + payload schema):
  ```ts
  // payload
  { toolCallId: string; toolName: string; reasonType?: string; reason?: string; message: string }
  ```
- `apps/server/.../sdk/event-mappers/system-event-mapper.ts` — map `message.subtype === 'permission_denied'` (`SDKPermissionDeniedMessage`: `tool_name`, `tool_use_id`, `decision_reason_type`, `decision_reason`, `message`) → the new event. (Also removes it from the catch-all log.)

#### 2.4 Client — gating, confirmation, denial chip

- **Per-model gating:** `ChatStatusSection` computes `modelSupportsAutoMode` from the active model (`useModels(sessionId)` → find `status.model` → `supportsAutoMode`) and passes it to `PermissionModeItem`. `PermissionModeItem` filters `'auto'` out of the rendered descriptor list when `!modelSupportsAutoMode`; when filtered, show a tooltip ("Auto mode requires Opus 4.6+ or Sonnet 4.6"). Existing `MODE_ICONS.auto`/`MODE_WARN.auto`/`FALLBACK_LABELS.auto` already cover icon/tint/label.
- **Once-per-session confirmation:** add client-only per-session state (e.g. a `Set<sessionId>` in `session-chat-store`). On selecting `'auto'`, if the session hasn't confirmed yet, open a confirmation modal (what the classifier blocks; "research preview"; Confirm / Cancel). On confirm, record the session and apply `updateSession({ permissionMode: 'auto' })`. No server/schema persistence.
- **Denial chip:** handle the `permission_denied` StreamEvent in the chat stream handler → render a read-only chip in the message stream ("Blocked by auto-mode classifier: {reason}"), styled distinctly from user denials. Label specifically when `reasonType === 'classifier'`.
- **Research-preview affordance:** small "Preview" tag on the `Auto` option in the dropdown.

#### Data flow (Phase 2)

`PermissionModeItem` (auto shown only if model supports it) → confirm-once modal → `updateSession({ permissionMode: 'auto' })` → PATCH → `setPermissionMode('auto')` live + persisted → next turn `query({ permissionMode: 'auto' })` → SDK classifier (step 3) approves/denies; denials emit `system/permission_denied` → `permission_denied` event → denial chip. Only the classifier's fallback reaches `canUseTool` (step 5) → approval card.

---

## Implementation Phases & Tasks

**Phase 1 — Cleanup (mergeable on its own)**

1. Remove `autoMode` from shared schemas + `agent-runtime` opts + test-utils fixtures.
2. Remove the `auto_mode` column; generate the drizzle DROP migration.
3. Remove server plumbing (routes, runtime-registry, agent-types, session-store, claude-code-runtime opts, message-sender `disableAutoMode`, test-mode-runtime).
4. Remove client plumbing (ModelConfigPopover Mode section → Fast-only, use-session-status, ChatStatusSection).
5. Update affected tests; `pnpm typecheck` + targeted vitest green.

**Phase 2 — Adoption (depends on Phase 1)**

6. Add the `'auto'` descriptor to `CLAUDE_CODE_CAPABILITIES`.
7. Fallback fix in `interactive-handlers.ts` (`'auto'` → approval cards) + unit test.
8. Add `permission_denied` StreamEvent (schema) + map `system/permission_denied` + unit test.
9. Client: per-model gating in `PermissionModeItem` (+ tooltip) wired from `ChatStatusSection`.
10. Client: once-per-session confirmation modal + per-session state.
11. Client: denial chip in the stream handler/UI + research-preview tag.
12. Verify: typecheck, lint, vitest; live dev — enable `auto` on an Opus 4.8 session, trigger a benign block, confirm the denial chip + that the option is hidden on a non-supporting model.

---

## Acceptance Criteria

**Phase 1**

- No `autoMode`/`disableAutoMode` references remain (grep clean outside history); `supportsAutoMode` plumbing intact.
- The Model Config Mode section shows **only** Fast; no "Auto" toggle.
- DB migration drops `auto_mode`; server boots and reads/writes session settings without it.
- `pnpm typecheck`, `pnpm lint`, and the affected test suites pass.

**Phase 2**

- `'auto'` appears in the Permission Mode dropdown **only** when the active model reports `supportsAutoMode`; otherwise hidden with an explanatory tooltip.
- First switch to `'auto'` in a session shows the confirmation modal; subsequent switches in the same session do not.
- In `'auto'` mode, normal tool calls do not raise approval cards (classifier decides); a classifier denial renders a read-only "blocked" chip.
- After the classifier's interactive fallback, tool calls **do** raise approval cards (no silent auto-allow).
- Active `'auto'` mode is visible in the status bar with the Sparkles icon + danger tint + "preview" affordance.

---

## Testing Strategy

- **Unit (server):** `interactive-handlers` fallback gate (auto → `handleToolApproval`); `system-event-mapper` `permission_denied` → event (+ no catch-all log); session-store/registry/route tests updated for Phase 1.
- **Unit (client):** `PermissionModeItem` filters `'auto'` by `modelSupportsAutoMode`; confirmation modal fires once per session; `ModelConfigPopover` Mode section Fast-only.
- **Integration:** SSE path emits `permission_denied`; `claude-code-runtime-interactive` still passes `permissionMode: 'auto'` through.
- **Live:** isolated dev server (`:6242`); Opus 4.8 session → enable auto (confirm modal) → benign blocked action → denial chip; switch to Haiku → `'auto'` hidden.

## Risks & Mitigations

- **Silent over-permissive fallback** (primary risk) → Task 7 makes auto fallback render approval cards; explicit unit test.
- **Migration data loss** → DROP only the verified-unused `auto_mode` column; no other consumers (verified).
- **Model/provider variance** (`supportsAutoMode` differs across API/Bedrock/Vertex) → gate purely on the SDK-reported per-model flag; no hardcoding.
- **Research-preview churn** → "preview" labeling sets expectations; logic keys off SDK capability flags, not model names.

## Open Questions

_All ideation open questions resolved:_

- **Classifier-denial event feasibility** → **Resolved:** `SDKPermissionDeniedMessage` (`subtype: 'permission_denied'`, `decision_reason_type` discriminator incl. `'classifier'`) is in the `SDKMessage` union — map it (Task 8).
- **Confirmation scope** → **Resolved:** once per session (client-only state).
- **Migration safety** → **Resolved:** no `auto_mode` consumers beyond the in-scope removal paths.

## References

- Ideation: `specs/auto-permission-mode/01-ideation.md`
- Research: `research/20260315_agent_runtime_permission_modes.md`, `research/claude-code-sdk-agent-capabilities.md`, `research/runtime-upgrades/claude-agent-sdk/0.2.112-to-0.3.168/impact-assessment.md`
- ADRs: 0240 (permission passthrough), 0256 (RuntimeCapabilities shape), 0260 (per-session settings), 0261 (always-launch bypass capability)
- SDK: `SDKPermissionDeniedMessage` (sdk.d.ts:3448), `PermissionMode` union (sdk.d.ts:2011), `Settings.disableAutoMode` (sdk.d.ts:5555)
