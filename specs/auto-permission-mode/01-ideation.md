---
slug: auto-permission-mode
number: 253
created: 2026-06-09
status: ideation
---

# Auto Mode: Remove the Misplaced Toggle, Adopt Auto as a Permission Mode

**Slug:** auto-permission-mode
**Author:** Claude Code
**Date:** 2026-06-09
**Branch:** preflight/auto-permission-mode

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS surfaces an "Auto" boolean toggle in the Model Config popover's "Mode" section (next to "Fast") that is misplaced and effectively a no-op. Meanwhile the _real_ auto mode — `permissionMode: 'auto'`, a classifier-gated permission posture — exists in the schema but is never selectable. **Phase 1:** remove the no-op toggle and its plumbing. **Phase 2:** adopt `'auto'` as a proper, model-gated permission mode with the safety UX a research-preview autonomy feature requires.
- **Scope decision (user):** **Both, phased (full).** Phase 1 is independently ship-able; Phase 2 adopts the mode with full safety UX.
- **Assumptions:**
  - DorkOS continues to drive Claude Code via the Agent SDK `query()` per session (non-interactive transport).
  - We keep DorkOS's existing approval-card UX for `default` mode unchanged.
  - `'auto'` is offered only where the active model reports `supportsAutoMode` (SDK rejects it otherwise).
- **Out of scope:**
  - Surfacing `'dontAsk'` (separately deferred — see `runtime-constants.ts` comment + research/20260315).
  - A per-session "lock out of auto mode" control (the `disableAutoMode` opt-out) — deferred power-user feature (see §6 / Open Questions).
  - Workflow-launch confirmation UX (never shown in Agent-SDK transport — see §5 Fact 6).

---

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` — `CLAUDE_CODE_CAPABILITIES.permissionModes.values` lists only 4 modes (`default`, `acceptEdits`, `plan`, `bypassPermissions`); `'auto'` and `'dontAsk'` deliberately omitted. This is why `'auto'` never appears in the dropdown.
- `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx` — renders modes from `caps.permissionModes.values`. Already has `MODE_ICONS.auto = Sparkles`, `MODE_WARN.auto = true`, `FALLBACK_LABELS.auto = 'Auto'`. No entry-confirmation today; danger modes only get a red tint.
- `apps/client/src/layers/features/status/ui/ModelConfigPopover.tsx` — `ModeSection` renders the `Fast` + `autoMode` toggles; `autoMode` maps to `disableAutoMode`. `supportsAutoMode` is plumbed but only used to show the toggle.
- `apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts:218-251` — `createCanUseTool` only renders approval cards when `permissionMode === 'default'`; **all other modes auto-allow** at the callback.
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:272-277` — injects `disableAutoMode: 'disable'` when `session.autoMode === false`.
- `packages/db/src/schema/sessions.ts:26` — `autoMode: integer('auto_mode', { mode: 'boolean' })` — a real persisted column.
- `research/20260315_agent_runtime_permission_modes.md`, `research/claude-code-sdk-agent-capabilities.md`, `research/runtime-upgrades/.../0.2.112-to-0.3.168/impact-assessment.md` — permission-mode taxonomy, evaluation order, `supportsAutoMode`/`disableAutoMode` provenance.
- ADRs: **0240** (permission passthrough to SDK without allowlist), **0256** (RuntimeCapabilities shape / `PermissionModeDescriptor`), **0260** (persist per-session settings), **0261** (always launch with `allowDangerouslySkipPermissions`).

---

## 3) Codebase Map

### Phase 1 — Removal blast radius (`autoMode` / `disableAutoMode` / `supportsAutoMode`)

**Shared / types / DB**

- `packages/shared/src/schemas.ts` — `SessionSchema.autoMode` (~:114), `SessionSettingsSchema.autoMode` (~:142). Keep `PermissionModeSchema` `'auto'` (Phase 2 needs it).
- `packages/shared/src/agent-runtime.ts` — `updateSession` opts `autoMode?` (~:228).
- `packages/db/src/schema/sessions.ts:26` — `auto_mode` column → **new drizzle migration to DROP COLUMN**.
- `packages/test-utils/src/fake-agent-runtime.ts` — mock session fixtures.

**Server**

- `apps/server/src/routes/sessions.ts` — PATCH destructure/apply (~:40, :169, :182, :201).
- `apps/server/src/services/core/runtime-registry.ts` — `SettingsRow`, `rowToSettings`, `pickSettings`, two select clauses (~:12, :23, :34, :228, :275).
- `apps/server/src/services/runtimes/claude-code/sessions/session-store.ts` — `AgentSession.autoMode`, init/hydrate/update (~:50, :83, :113, :125, :195, :243).
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:272-277` — drop the `disableAutoMode` branch (becomes `if (session.fastMode) { … }`).
- `apps/server/src/services/runtimes/claude-code/messaging/runtime-cache.ts:73,84` — `supportsAutoMode` map (drop, unless Phase 2 reuses it — see note).
- `test-mode-runtime.ts`, route/registry/session-store tests.

**Client**

- `ModelConfigPopover.tsx` — `ModeSectionProps` (drop `supportsAutoMode`, `autoMode`), the Auto `ModeToggle` (:240-247), popover props/state (`autoMode`, `onChangeAutoMode`), `showModes` derivation. **`ModeSection` becomes Fast-only.**
- `use-session-status.ts` — `SessionStatusData.autoMode` (:19), `localAutoMode` state (:50), derivation (:78), `statusData` (:85), updateSession handling + effect deps.
- `ChatStatusSection.tsx:290-291` — `autoMode`/`onChangeAutoMode` props.
- Tests: `ModelConfigPopover.test.tsx`, `use-session-status.test.tsx`.

> **Note:** `supportsAutoMode` should **not** be removed if Phase 2 lands in the same spec — Phase 2 reuses it for per-model gating. Keep the server→client plumbing of `supportsAutoMode`; only remove the `autoMode` boolean and `disableAutoMode`.

### Phase 2 — Adoption touchpoints (`permissionMode: 'auto'`)

- `runtime-constants.ts:32-53` — **add** an `{ id: 'auto', label: 'Auto', description: … }` descriptor to `permissionModes.values`.
- `PermissionModeItem.tsx` — **per-model filter:** drop `'auto'` from the rendered descriptor list when `!selectedModel.supportsAutoMode`; needs the active model's capability (today it only consumes runtime caps). Add a tooltip explaining the model requirement; add a "research preview" affordance.
- `interactive-handlers.ts:237-251` — **fallback fix:** when `permissionMode === 'auto'` and `canUseTool` is reached (classifier fallback), render approval cards instead of auto-allowing (treat like `default`).
- Schema/passthrough/`setPermissionMode` — **already generic** (ADR-0240); `'auto'` flows through with no server change beyond the descriptor + fallback fix. Confirmed by `claude-code-runtime-interactive.test.ts:625`.
- New UI: entry-confirmation modal (first switch to `auto`); classifier-denial surfacing in the message stream (feasibility caveat — see §6).

### Data flow

`PermissionModeItem` → `status.updateSession({ permissionMode })` → PATCH `/sessions/:id` → `session-store.updateSession` → live `query.setPermissionMode('auto')` + persisted; next turn `message-sender` passes `permissionMode` to SDK `query()`; SDK classifier (step 3) decides; only fallback reaches `canUseTool` (step 5).

### Blast radius summary

- **Phase 1:** ~12 areas across shared/db/server/client + 1 migration. Mechanical; well-covered by existing tests.
- **Phase 2:** 1 server descriptor + 1 safety fix + per-model UI filter + 2 new UI surfaces (modal, denial chip).

---

## 4) Root Cause Analysis (why the toggle is a no-op)

- **Observed vs expected:** The "Auto" toggle in the model menu suggests a meaningful per-session setting, but toggling it produces **no observable behavior change** in normal use.
- **Evidence / root cause:** `autoMode === false` injects `Settings.disableAutoMode: 'disable'`, which prevents _entering_ auto permission mode. But nothing in DorkOS ever enters auto mode (`permissionMode: 'auto'` is omitted from `permissionModes.values`, and no code sets it). So the toggle opts out of a state that is unreachable → inert. It also conflates a **permissions** concept into the **model** menu, and duplicates the `'auto'` permission mode's name/icon.
- **Provenance:** `autoMode`/`disableAutoMode` were wired mechanically alongside `fastMode` during SDK-driven model discovery (commit `896d2196`); the 0.3.168 upgrade triage never evaluated auto mode as a feature (`research/.../triage-decisions.md`).
- **Decision:** Remove it (Phase 1). It fails the Honest-by-design, Less-but-better, and conceptual-integrity filters.

---

## 5) Research

(Full report from the research agent; reuses `research/20260315_agent_runtime_permission_modes.md`, `research/claude-code-sdk-agent-capabilities.md`.)

- **Fact 1 — Model-gated.** `'auto'` is TS-SDK-only, requires Claude Code ≥ v2.1.83, and is supported only on Opus 4.6+/Sonnet 4.6 (Anthropic API) or Opus 4.7/4.8 (Bedrock/Vertex/Foundry, `CLAUDE_CODE_ENABLE_AUTO_MODE=1`). `supportsAutoMode` already tracked per model → **gate the UI on it.**
- **Fact 2 — Classifier replaces `canUseTool` for resolved actions.** Evaluation order: Hooks → deny rules → **permission-mode check (auto classifier, step 3)** → allow rules → `canUseTool` (step 5). Classifier-approved/denied actions never reach `canUseTool`; **DorkOS approval cards are intentionally bypassed in auto mode** (correct). The classifier is a server-side two-stage Sonnet-4.6 check (fast filter → CoT), sees user messages + tool calls + CLAUDE.md (tool _results_ stripped to resist injection).
- **Fact 3 — Fallback gap (safety-critical).** After **3 consecutive** or **20 total** classifier blocks, auto mode **pauses** and the SDK resumes calling `canUseTool`. DorkOS currently auto-allows in non-`default` modes → post-fallback it would silently allow everything. **Must render approval cards in the auto-mode fallback.**
- **Fact 4 — `AskUserQuestion` still works** (routed before the mode check in `createCanUseTool`).
- **Fact 5 — `disableAutoMode` is a real opt-out lock**, not pure no-op — but it locks out a currently-unreachable state. Reusable later as a per-session "no auto mode" guard (deferred).
- **Fact 6 — Workflow-launch confirmation never shows in Agent-SDK transport** (treated like `claude -p`); `skipWorkflowUsageWarning` is effectively always on for DorkOS. Workflow subagents run `acceptEdits`; `Task`-spawned subagents inherit `auto` and are classifier-checked at spawn/run/finish.
- **Fact 7 — Entering auto mode strips broad allow rules** (`Bash(*)` etc.); DorkOS uses narrow `mcp__dorkos__*` filters, so low practical impact (note it).
- **UX patterns:** risk-graduated color (we have danger tint), prominent active-mode badge (PermissionModeItem already shows it), first-entry confirmation (CLI/Desktop both gate it), a "recently denied / blocked by classifier" feed, easy exit, and a "research preview" label.

**Recommendation:** Adopt `'auto'` as a model-gated permission mode; bypass approval cards by design but fix the fallback; add first-entry confirmation + classifier-denial surfacing + research-preview labeling.

---

## 6) Decisions

| #   | Decision                        | Choice                                                                                                             | Rationale                                                                                                                                                     |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Spec scope                      | **Both, phased (full)**                                                                                            | Phase 1 ships the honesty fix immediately; Phase 2 adopts the real feature with proper safety UX. (User-selected.)                                            |
| 2   | Phase 1 — the `autoMode` toggle | **Remove toggle + all plumbing**; keep `supportsAutoMode` plumbing (Phase 2 reuses it)                             | No-op, misplaced (permissions in the model menu), duplicative with `permissionMode: 'auto'`.                                                                  |
| 3   | `auto_mode` DB column           | **DROP via new drizzle migration**                                                                                 | Remove cruft cleanly; column is unused after Phase 1. SQLite + drizzle-kit generate the DROP.                                                                 |
| 4   | Per-model gating of `'auto'`    | **Client filters `'auto'` out when `!selectedModel.supportsAutoMode`** + tooltip                                   | SDK 400s on unsupported models; never show a dead option (honest-by-design). Gating must live client-side (caps are per-runtime; support is per-model).       |
| 5   | Approval cards in auto mode     | **Bypassed by design** (classifier decides at step 3)                                                              | Matches SDK semantics; the point of the mode.                                                                                                                 |
| 6   | Classifier-fallback behavior    | **Render approval cards when `canUseTool` is reached in `auto` mode** (treat like `default`)                       | Safety-critical: prevents silent full-allow after the classifier pauses (Fact 3).                                                                             |
| 7   | First-entry confirmation        | **Add a one-time confirmation modal on first switch to `auto`** (with "don't show again")                          | Research-preview + autonomy risk; mirrors CLI/Desktop opt-in. New DorkOS pattern (today even bypass is immediate) — could later extend to bypass.             |
| 8   | Risk signaling                  | **Reuse existing Sparkles + red danger tint; add a "research preview" label**                                      | Consistent with `bypassPermissions`; sets expectations that behavior may change.                                                                              |
| 9   | Classifier-denial surfacing     | **Intent: read-only "blocked by safety classifier" chip in the message stream** — _feasibility to confirm in spec_ | Honest visibility of autonomous decisions. Open: confirm which SDK event (if any) carries classifier denials in SDK transport; if none, defer to a follow-up. |

**Open questions for `/ideate-to-spec`:**

- Does the SDK emit a consumable event for classifier denials in `query()` transport (decision #9)? If not, scope the denial-surfacing as best-effort/deferred.
- Should the first-entry confirmation be global or per-session? (Lean: global "don't ask again," stored in user config.)
- Migration safety: confirm no other consumer reads `auto_mode` before dropping (exploration found none beyond the removed paths).

**Phasing:** Phase 1 (cleanup + migration) is independently mergeable and should land first. Phase 2 (adoption) depends on Phase 1 (frees the "Auto" name/icon for the permission mode) and on decisions #4/#6/#7/#9.

---

_Discovery: 2 parallel agents (Explore + research-expert). Prior session established the root cause; agents confirmed exact blast radius (file:line) and authoritative SDK auto-mode semantics._
