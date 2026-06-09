# Tasks — Auto Mode: Remove the Misplaced Toggle, Adopt Auto as a Permission Mode

**Spec:** `specs/auto-permission-mode/02-specification.md`
**Slug:** `auto-permission-mode`
**Mode:** full
**Generated:** 2026-06-09

## Overview

Two phases, independently shippable in order:

- **Phase 1 (Cleanup, mergeable on its own)** — remove the no-op `autoMode` toggle and all `disableAutoMode` plumbing end-to-end, including a drizzle DROP-COLUMN migration for `auto_mode`. `supportsAutoMode` plumbing is deliberately KEPT (Phase 2 reuses it). `PermissionModeSchema`'s `'auto'` value is KEPT.
- **Phase 2 (Adoption, depends on Phase 1)** — adopt `'auto'` as a model-gated permission mode: a capabilities descriptor, the safety-critical `interactive-handlers.ts` fallback fix (auto → render approval cards, not silent auto-allow), a new `permission_denied` StreamEvent mapped from the SDK `system/permission_denied` message, per-model gating in `PermissionModeItem`, a once-per-session entry-confirmation modal, a denial chip, and a research-preview affordance.

**Task counts:** 12 total — 5 in Phase 1, 7 in Phase 2.

**Critical path:** 1.1 → (1.2 ‖ 1.3 ‖ 1.4) → 1.5 → 2.1 → 2.4 → 2.7 (with 2.2, 2.3 in parallel after 1.5, and 2.5/2.6 fanning out before 2.7).

**Parallel opportunities:**

- Phase 1: 1.2, 1.3, 1.4 run in parallel after 1.1 lands (1.2 also depends on the schema column removal in 1.1).
- Phase 2: 2.1, 2.2, 2.3 run in parallel after Phase 1 completes. Then 2.4, 2.5, 2.6 run in parallel (2.4/2.5 depend on 2.1; 2.6 depends on 2.3). 2.7 is the final serial gate.

---

## Phase 1 — Cleanup

### 1.1 — Remove autoMode from shared schemas, agent-runtime opts, and test-utils fixtures

- **Size:** small · **Priority:** high
- **Dependencies:** none
- **Can run parallel with:** —

**Technical Requirements**

- `packages/shared/src/schemas.ts` — remove `autoMode` from `SessionSchema` (~line 114) and `SessionSettingsSchema` (~line 142). Keep `PermissionModeSchema` and its `'auto'` member.
- `packages/shared/src/agent-runtime.ts` — remove `autoMode?` from the `updateSession` opts type (~line 228).
- `packages/test-utils/src/fake-agent-runtime.ts` — drop `autoMode` from all mock/session fixtures.
- Do NOT remove `supportsAutoMode` anywhere (Phase 2 reuses it).

**Implementation Steps**

1. Edit the two schemas to drop the `autoMode` field; leave `PermissionModeSchema` untouched.
2. Drop `autoMode?` from `agent-runtime.ts` `updateSession` opts.
3. Remove `autoMode` from test-utils fixtures.
4. Run `pnpm --filter @dorkos/shared typecheck`.

**Acceptance Criteria**

- [ ] `SessionSchema` and `SessionSettingsSchema` no longer declare `autoMode`.
- [ ] `PermissionModeSchema` still includes `'auto'`.
- [ ] `supportsAutoMode` plumbing intact in shared.
- [ ] `updateSession` opts no longer accept `autoMode`.
- [ ] `fake-agent-runtime.ts` compiles with no `autoMode` references.

---

### 1.2 — Drop the auto_mode DB column and generate the drizzle DROP migration

- **Size:** small · **Priority:** high
- **Dependencies:** 1.1
- **Can run parallel with:** —

**Technical Requirements**

- `packages/db/src/schema/sessions.ts` line 26 — remove `autoMode: integer('auto_mode', { mode: 'boolean' })`.
- Generate a numbered DROP-COLUMN migration under `packages/db/drizzle/`.
- Migration safety verified: no consumer reads `auto_mode` outside the removed Phase 1 paths.

**Implementation Steps**

1. Remove the column from `sessions.ts`.
2. Run `pnpm --filter @dorkos/db drizzle-kit generate`.
3. Inspect generated SQL — confirm it drops `auto_mode` and only `auto_mode` (SQLite drizzle may rewrite the table; verify no other columns lost).
4. Commit the migration file and the updated snapshot/journal.

**Acceptance Criteria**

- [ ] `sessions.ts` no longer declares `auto_mode`.
- [ ] A new numbered migration drops `auto_mode` and only `auto_mode`.
- [ ] Drizzle snapshot/journal regenerated consistently.
- [ ] Server boots and persists/reads session settings without `auto_mode`.

---

### 1.3 — Remove autoMode/disableAutoMode server plumbing

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1
- **Can run parallel with:** 1.2, 1.4

**Technical Requirements**

- `apps/server/src/routes/sessions.ts` — remove `autoMode` from PATCH destructure/apply and `applyStoredSettings` (~lines 40, 169, 182, 201).
- `apps/server/src/services/core/runtime-registry.ts` — remove from `SettingsRow` (~12), `rowToSettings` (~23), `pickSettings` (~34), both SQL select clauses (~228, 275).
- `apps/server/src/services/runtimes/claude-code/agent-types.ts` line 13 — remove `autoMode?` from `AgentSession`.
- `apps/server/src/services/runtimes/claude-code/sessions/session-store.ts` — remove init/hydrate/update handling (~83, 113, 125, 195, 243).
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` line 204 — remove `autoMode?` from `updateSession` opts.
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` lines 272-277 — drop the `disableAutoMode` branch; settings block becomes `if (session.fastMode) { … fastMode … }`.
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` — drop `autoMode?` from opts.
- KEEP `supportsAutoMode` in `runtime-cache.ts` (lines 73, 84) and everywhere else.

**Implementation Steps**

1. Strip `autoMode` from routes, registry (rows/select/pick), agent-types, session-store, runtime opts, test-mode.
2. Delete the `disableAutoMode` injection in `message-sender.ts`; keep the `fastMode` branch.
3. `grep -rn "autoMode\b" apps/server/src | grep -v supportsAutoMode` returns nothing; `grep -rn "disableAutoMode" apps/server/src` returns nothing.
4. `pnpm --filter @dorkos/server typecheck`.

**Acceptance Criteria**

- [ ] No `autoMode` field or `disableAutoMode` mapping remains in server source.
- [ ] `supportsAutoMode` plumbing intact in `runtime-cache.ts` and downstream.
- [ ] `message-sender.ts` no longer references `disableAutoMode`; `fastMode` branch preserved.
- [ ] Server typechecks.

---

### 1.4 — Remove autoMode client plumbing — Mode section becomes Fast-only

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1
- **Can run parallel with:** 1.2, 1.3

**Technical Requirements**

- `apps/client/src/layers/features/status/ui/ModelConfigPopover.tsx` — remove `autoMode`/`supportsAutoMode` from `ModeSectionProps`; remove the Auto `ModeToggle` (lines 240-247); remove the popover's `autoMode`/`onChangeAutoMode` props + state and the Auto-dependent `showModes` derivation. `ModeSection` becomes Fast-only (KEEP the section).
- `apps/client/src/layers/entities/session/model/use-session-status.ts` — remove `SessionStatusData.autoMode` (line 19), `localAutoMode` (line 50), derivation (line 78), `statusData.autoMode` (line 85), updateSession/effect handling.
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx` lines 290-291 — remove `autoMode`/`onChangeAutoMode` props passed to `ModelConfigPopover`.

**Implementation Steps**

1. Reduce the Mode section to a Fast-only toggle; drop Auto props/state from the popover.
2. Remove `autoMode` from the session-status hook (state, derivation, statusData, updateSession/effects).
3. Remove the two `autoMode`/`onChangeAutoMode` props from `ChatStatusSection`.
4. `pnpm --filter @dorkos/client typecheck`; verify popover shows only Fast.

**Acceptance Criteria**

- [ ] Mode section shows only Fast; no Auto toggle.
- [ ] Popover/`ModeSectionProps` no longer include `autoMode`/`onChangeAutoMode`/`supportsAutoMode` (toggle-related).
- [ ] `use-session-status.ts` exposes no `autoMode` and carries no `localAutoMode`.
- [ ] `ChatStatusSection` no longer passes `autoMode`/`onChangeAutoMode`.
- [ ] Client typechecks.

---

### 1.5 — Update affected tests; typecheck + targeted vitest green

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.2, 1.3, 1.4
- **Can run parallel with:** —

**Technical Requirements**

- Update: `session-store-settings.test.ts`, `runtime-registry.test.ts`, `sessions.test.ts`, `ModelConfigPopover.test.tsx`, the `use-session-status` hook test — drop `autoMode`/`disableAutoMode`; keep `supportsAutoMode` assertions.

**Implementation Steps**

1. Strip `autoMode` from fixtures/assertions; remove any `disableAutoMode` injection test.
2. Assert the Mode section renders only Fast in `ModelConfigPopover.test.tsx`.
3. Run `pnpm typecheck`, `pnpm lint`.
4. Run the targeted server + client suites listed above.

**Acceptance Criteria**

- [ ] No `autoMode`/`disableAutoMode` references remain outside git history; `supportsAutoMode` intact.
- [ ] All listed suites pass.
- [ ] `pnpm typecheck` and `pnpm lint` pass.

---

## Phase 2 — Adoption

### 2.1 — Add the 'auto' permission-mode descriptor to CLAUDE_CODE_CAPABILITIES

- **Size:** small · **Priority:** high
- **Dependencies:** 1.1, 1.2, 1.3, 1.4, 1.5
- **Can run parallel with:** 2.2, 2.3

**Technical Requirements**

- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` — add to `CLAUDE_CODE_CAPABILITIES.permissionModes.values`:
  ```ts
  {
    id: 'auto',
    label: 'Auto',
    description:
      'A safety classifier approves or denies tool calls automatically — fewer interruptions on long autonomous runs. Research preview.',
  }
  ```
- Leave `'dontAsk'` omitted with its existing comment. SDK passthrough is already generic (ADR-0240); no further server change needed (confirmed by `claude-code-runtime-interactive.test.ts:625`).

**Implementation Steps**

1. Append the `'auto'` descriptor to the `values` array.
2. `pnpm --filter @dorkos/server typecheck`; confirm capabilities now return five permission-mode values.

**Acceptance Criteria**

- [ ] `permissionModes.values` includes the `'auto'` descriptor with the exact id/label/description.
- [ ] `'dontAsk'` remains omitted.
- [ ] Existing capability tests and `claude-code-runtime-interactive.test.ts` pass.

---

### 2.2 — Safety-critical fallback fix in interactive-handlers.ts

- **Size:** small · **Priority:** high
- **Dependencies:** 1.1, 1.2, 1.3, 1.4, 1.5
- **Can run parallel with:** 2.1, 2.3

**Technical Requirements**

- `apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts` (~line 237) — change the approval gate so `'auto'` is treated like `'default'`:
  ```ts
  if (session.permissionMode === 'default' || session.permissionMode === 'auto') {
    return handleToolApproval(session, context.toolUseID, toolName, input, context);
  }
  ```
- `AskUserQuestion` routing and `READ_ONLY_TOOLS`/`DORKOS_AGENT_TOOLS` auto-allow preceding the gate stay unchanged; other non-`default`/non-`auto` modes keep auto-allow.
- Rationale: in `'auto'` the classifier resolves at SDK step 3 and `canUseTool` is reached ONLY after the classifier's fallback (3 consecutive / 20 total blocks) — an approval card is then the correct, safe response, not silent auto-allow.

**Implementation Steps**

1. Update the gate condition to include `'auto'`.
2. Add a unit test: in `'auto'` mode, a non-read-only/non-agent tool → `handleToolApproval` (not `{ behavior: 'allow' }`); keep cases proving `default` approval and `acceptEdits`/`bypassPermissions` auto-allow.
3. Run the interactive-handlers vitest; `pnpm --filter @dorkos/server typecheck`.

**Acceptance Criteria**

- [ ] In `'auto'` mode, the fallback reaching `canUseTool` raises approval cards (no silent auto-allow).
- [ ] Unit test asserts `auto` → `handleToolApproval`.
- [ ] `default` behavior and other modes' auto-allow unchanged.

---

### 2.3 — Add permission_denied StreamEvent (schema) + map SDK system/permission_denied

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1, 1.2, 1.3, 1.4, 1.5
- **Can run parallel with:** 2.1, 2.2

**Technical Requirements**

- `packages/shared/src/schemas.ts`:
  - Add `'permission_denied'` to `StreamEventTypeSchema` (the enum near line 29).
  - Add `PermissionDeniedEventSchema` with shape `{ toolCallId: string; toolName: string; reasonType?: string; reason?: string; message: string }` (mirror existing `*EventSchema` style with `.openapi(...)`).
  - Add it to the `StreamEventSchema.data` union (~line 757).
- `apps/server/src/services/runtimes/claude-code/sdk/event-mappers/system-event-mapper.ts` — add a branch for `message.subtype === 'permission_denied'` (`SDKPermissionDeniedMessage`: `tool_name`, `tool_use_id`, `decision_reason_type`, `decision_reason`, `message`). Map:
  - `toolCallId` ← `tool_use_id`
  - `toolName` ← `tool_name`
  - `reasonType` ← `decision_reason_type` (carries `'classifier'` among discriminators)
  - `reason` ← `decision_reason`
  - `message` ← `message`
    Yield one `{ type: 'permission_denied', data: … }` event. Also remove `permission_denied` from the catch-all/unknown-subtype log path.

**Implementation Steps**

1. Extend the StreamEvent enum + union; define the payload schema.
2. Add the mapper branch with the exact field mapping.
3. Add a unit test feeding `SDKPermissionDeniedMessage` (`decision_reason_type: 'classifier'`): asserts one mapped `permission_denied` event and no unknown-subtype warning.
4. `pnpm --filter @dorkos/shared typecheck`, `pnpm --filter @dorkos/server typecheck`, run the mapper vitest.

**Acceptance Criteria**

- [ ] `StreamEventTypeSchema` includes `'permission_denied'`; `StreamEventSchema.data` accepts the payload.
- [ ] Mapper converts `system/permission_denied` with the exact field mapping.
- [ ] `permission_denied` no longer hits the catch-all log; unit test proves mapping + absence of warning.

---

### 2.4 — Client per-model gating of 'auto' in PermissionModeItem + tooltip

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.1
- **Can run parallel with:** 2.2, 2.3, 2.5

**Technical Requirements**

- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx` — compute `modelSupportsAutoMode`: `useModels(sessionId)` → find entry matching `status.model` → read `supportsAutoMode`; pass to `PermissionModeItem`.
- `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx` — accept `modelSupportsAutoMode`; filter `'auto'` out of the rendered descriptor list when `!modelSupportsAutoMode`; show tooltip "Auto mode requires Opus 4.6+ or Sonnet 4.6". Existing `MODE_ICONS.auto`/`MODE_WARN.auto`/`FALLBACK_LABELS.auto` cover icon/tint/label.

**Implementation Steps**

1. Derive `modelSupportsAutoMode` in `ChatStatusSection` and thread it down.
2. Filter `'auto'` and render the tooltip when unsupported in `PermissionModeItem`.
3. Add unit tests for the supported (rendered) and unsupported (hidden + tooltip) cases.
4. `pnpm --filter @dorkos/client typecheck`; run the `PermissionModeItem` vitest.

**Acceptance Criteria**

- [ ] `'auto'` appears only when the active model reports `supportsAutoMode`.
- [ ] When unsupported, `'auto'` is hidden with the explanatory tooltip.
- [ ] `ChatStatusSection` derives `modelSupportsAutoMode` from `useModels(sessionId)` + active `status.model`.
- [ ] Unit tests cover both cases.

---

### 2.5 — Once-per-session entry confirmation modal + per-session client state

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.1
- **Can run parallel with:** 2.4, 2.6

**Technical Requirements**

- Add client-only per-session state (e.g. a `Set<sessionId>` of confirmed sessions) in `session-chat-store`, with a record action and a check selector. No server/schema persistence.
- On selecting `'auto'` (handler wired through `ChatStatusSection`): if the session hasn't confirmed, open a modal (explains what the classifier blocks; "research preview"; Confirm / Cancel) instead of applying immediately. On Confirm: record the session and apply `updateSession({ permissionMode: 'auto' })`. On Cancel: no change. Subsequent same-session switches apply directly.

**Implementation Steps**

1. Add per-session confirmed-state + actions to the store.
2. Wire the selection handler to gate first switch behind the modal.
3. Implement Confirm (record + `updateSession`) and Cancel (no-op) paths.
4. Add unit tests: first selection opens modal and defers `updateSession` until Confirm; Confirm records + applies; second selection applies directly without modal; Cancel leaves mode unchanged and unrecorded.
5. `pnpm --filter @dorkos/client typecheck`; run the modal/store vitest.

**Acceptance Criteria**

- [ ] First switch to `'auto'` shows the modal (classifier explanation + "research preview" + Confirm/Cancel).
- [ ] Confirm applies `updateSession({ permissionMode: 'auto' })` and records the session.
- [ ] Subsequent same-session switches skip the modal.
- [ ] No server/schema persistence; state lives only in the client store.

---

### 2.6 — Denial chip from permission_denied event + research-preview tag

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.3
- **Can run parallel with:** 2.4, 2.5

**Technical Requirements**

- Handle the `permission_denied` StreamEvent in the chat stream handler → append a read-only "blocked" chip to the message stream, styled distinctly from user denials. Copy: "Blocked by auto-mode classifier: {reason}" (use `reason`/`message`); label specifically when `reasonType === 'classifier'`. Chip is read-only (no actions).
- Add a small "Preview" tag on the `Auto` option in `PermissionModeItem` alongside the Sparkles icon + danger tint.

**Implementation Steps**

1. Add the `permission_denied` case to the stream reducer/handler; render the chip.
2. Add the "Preview" tag to the `Auto` option.
3. Add unit tests: stream handler appends a read-only classifier-labeled chip (with reason) for a `permission_denied` event; `Auto` option renders the "Preview" tag.
4. `pnpm --filter @dorkos/client typecheck`; run the stream-handler + `PermissionModeItem` vitest.

**Acceptance Criteria**

- [ ] `permission_denied` renders a read-only "blocked" chip distinct from user denials, classifier-labeled when `reasonType === 'classifier'`.
- [ ] `Auto` option shows a "Preview" tag alongside Sparkles + danger tint.
- [ ] Unit tests cover the chip and the preview tag.

---

### 2.7 — Verify Phase 2 end-to-end (typecheck, lint, vitest, live dev :6242)

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
- **Can run parallel with:** —

**Technical Requirements**

- Static + tests: `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run` (including interactive-handlers fallback, system-event-mapper `permission_denied`, `PermissionModeItem` gating + preview, confirmation-modal/store, denial-chip stream-handler).
- Live dev on isolated port :6242 (do not collide with :4242).

**Implementation Steps**

1. Run the three static/test gates.
2. Start dev on :6242. On an Opus 4.8 session: open the Permission Mode dropdown → confirm `'auto'` visible with Sparkles + danger tint + "Preview" tag.
3. Select `'auto'` → confirm the once-per-session modal appears; Confirm. Re-select → confirm modal does NOT reappear.
4. Trigger a benign classifier-blocked action → confirm the "Blocked by auto-mode classifier: …" chip renders.
5. Switch to a non-supporting model (Haiku) → confirm `'auto'` hidden with tooltip.

**Acceptance Criteria**

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run` all pass.
- [ ] Live: `'auto'` visible on Opus 4.8 with icon/tint/preview; modal once per session; benign block renders the denial chip; `'auto'` hidden on Haiku with tooltip.
- [ ] After the classifier's interactive fallback, tool calls raise approval cards (no silent auto-allow) — spot-checked or covered by task 2.2's unit test.
