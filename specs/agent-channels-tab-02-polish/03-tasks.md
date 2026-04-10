# Agent Channels Tab — Visual Polish: Task Breakdown

**Spec:** `specs/agent-channels-tab-02-polish/02-specification.md`
**Generated:** 2026-04-10
**Mode:** Full decomposition

---

## Phase 1: Foundation — Shared Helpers & Constants

### Task 1.1 — Extract shared adapter state color and label constants

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create `apps/client/src/layers/features/relay/lib/adapter-state-colors.ts` exporting two maps:

- `ADAPTER_STATE_DOT_CLASS` — Tailwind classes for the adapter status dot. Color semantics: green = connected, gray (`bg-muted-foreground`) = disconnected (idle), red = error, amber + `motion-safe:animate-pulse` = transient (starting, stopping, reconnecting).
- `ADAPTER_STATE_LABEL` — Humanized labels: Connected, Ready, Error, Connecting…, Stopping…, Reconnecting….

Both typed as `Record<AdapterStatus['state'], string>`. Export from the `@/layers/features/relay` barrel.

---

### Task 1.2 — Extract shared buildPreviewSentence helper and refactor BindingDialog

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Create `apps/client/src/layers/features/mesh/lib/build-preview-sentence.ts` with a function that maps session strategies to humanized phrases:

- `per-chat` → "One thread for each conversation"
- `per-user` → "One thread for each person"
- `stateless` → "No memory between messages"

Appends " in {chatDisplayName}" or " · {channelType}" when provided.

Refactor `BindingDialog.tsx` to remove its inline `buildPreviewSentence` and `STRATEGY_LABELS`, importing the shared helper instead. Create a test file with 6 unit tests covering all strategy mappings and suffix combinations.

---

## Phase 2: Shared UI Extension

### Task 2.1 — Extend NavigationLayoutPanelHeader with description prop

**Size:** Small | **Priority:** High | **Dependencies:** None

Add an optional `description?: React.ReactNode` prop to `NavigationLayoutPanelHeader` in `apps/client/src/layers/shared/ui/navigation-layout.tsx`. On desktop, renders as `text-muted-foreground text-xs leading-relaxed` below the title. On mobile, not rendered. Restructures the desktop layout from a single flex row to a `space-y-1` vertical stack with the title/actions row inside. Add 2 tests to the existing navigation-layout test file.

---

## Phase 3: AgentDialog Updates

### Task 3.1 — Reorder AgentDialog sidebar tabs and add Channels panel subtitle

**Size:** Small | **Priority:** High | **Dependencies:** 2.1

In `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`, reorder the `AGENT_TABS` array from Identity → Personality → Tools → Channels to Identity → Channels → Personality → Tools. The `defaultTab` stays `'identity'`.

Add the `description` prop to the Channels panel header (in the consumer or ChannelsTab, wherever the header is rendered): "Connect this agent to messaging platforms so it can send and receive messages."

Verify `openAgentDialogToTab` call sites still work (string-based, order-agnostic).

---

## Phase 4: Card Redesign

### Task 4.1 — Redesign ChannelBindingCard with progressive disclosure

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.2

Major rewrite of `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx`:

**New prop surface:** Adds `channelIconId`, `channelAdapterType`, `chatDisplayName`. State type becomes `'connected' | 'disconnected' | 'error' | 'connecting'`.

**New layout:**

- Brand icon (32px `AdapterIcon`) with status-dot overlay (bottom-right, `ring-background` ring)
- Primary text: channel name + em-dash + chat display name (if present)
- Secondary text: preview sentence (muted italic) or error message (red)
- Restricted pill (outline Badge with tooltip) only when permissions deviate from defaults
- Always-visible kebab menu (`DropdownMenu` with Edit + Remove)
- Remove confirmation via AlertDialog (unchanged)

**Deleted:** Raw strategy badge, raw chatId badge, three per-permission icons, hover-reveal Edit/Remove buttons, standalone status dot.

---

## Phase 5: Wiring & Data Flow

### Task 5.1 — Create BoundChannelRow wrapper and update ChannelsTab data flow

**Size:** Medium | **Priority:** High | **Dependencies:** 4.1

Create `apps/client/src/layers/features/agent-settings/ui/BoundChannelRow.tsx` — a thin wrapper that calls `useObservedChats(binding.adapterId)` to resolve raw `chatId` to `chatDisplayName`, then renders `ChannelBindingCard`.

Update `ChannelsTab.tsx`:

- Extend `AdapterDisplay` to carry `iconId` and `adapterType`
- Surface transient states as `'connecting'` instead of normalizing to `'disconnected'`
- Replace `<ChannelBindingCard>` with `<BoundChannelRow>` in the binding list

---

## Phase 6: Empty States

### Task 6.1 — Implement three distinct empty states in ChannelsTab

**Size:** Medium | **Priority:** High | **Dependencies:** 5.1

Replace the single-line empty state with three context-aware empty states:

- **State A (Relay off):** Plug2 icon, "The Relay message bus is off", CTA → `openSettingsToTab('advanced')`
- **State B (No adapters):** Radio icon, "No channels available", CTA → `openSettingsToTab('channels')`
- **State C (No bindings):** Radio icon, "Let this agent reach the outside world", CTA is the ChannelPicker rendered inline

State D (bindings exist) renders the standard list with ChannelPicker below. All empty states use `rounded-xl border border-dashed px-6 py-10`.

---

## Phase 7: Picker & Color Sweep

### Task 7.1 — Update ChannelPicker with brand icons and humanized state labels

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 7.2

In `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx`:

- Remove the local `STATE_DOT_CLASS` map; use shared `ADAPTER_STATE_DOT_CLASS`
- Replace standalone status dots with `AdapterIcon` (20px) + overlay dot pattern
- Replace raw state labels with humanized `ADAPTER_STATE_LABEL` (Connected, Ready, Error, Connecting…)
- Replace `Plus` icon in "Available to set up" section with per-adapter brand icons
- Extend `ChannelItem` interface with `iconId` and `adapterType`

---

### Task 7.2 — Sweep color semantics across Settings ChannelSettingRow and Relay AdapterCard

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 7.1

**ChannelSettingRow:** Replace the local `resolveStatusDotClass` function with one that uses the shared `ADAPTER_STATE_DOT_CLASS`. Disconnected changes from `bg-gray-400` to `bg-muted-foreground`. Starting changes from `bg-blue-400` to `bg-amber-500 motion-safe:animate-pulse`.

**AdapterCard:** Use shared constants for all states except the Relay-specific "connected but unbound = amber" case. Disconnected changes to `bg-muted-foreground`. Starting changes from `bg-blue-400` to amber pulse. Replace `animate-tasks` with `motion-safe:animate-pulse` for accessibility.

---

## Phase 8: Tests

### Task 8.1 — Rewrite ChannelBindingCard tests for the new progressive disclosure design

**Size:** Large | **Priority:** High | **Dependencies:** 4.1 | **Parallel with:** 8.2

Full rewrite of `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelBindingCard.test.tsx`. Remove all old tests for raw strategy badges, chatId badges, per-permission icons, and hover-reveal buttons. Add new tests for:

- AdapterIcon rendering with iconId
- Status dot colors for all 4 states (connected, disconnected, error, connecting)
- Preview sentence display and error message replacement
- Restricted pill presence/absence for all 3 permission flags
- Always-visible kebab menu with Edit and Remove
- Remove confirmation dialog flow
- Absence of raw jargon (strategy, chatId)
- Primary text with em-dash chat display name
- Error border styling

Mock `AdapterIcon` and `buildPreviewSentence`.

---

### Task 8.2 — Update ChannelsTab tests for new empty states and BoundChannelRow

**Size:** Large | **Priority:** High | **Dependencies:** 6.1 | **Parallel with:** 8.1

Update `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx`:

- Add mocks for `useAppStore` (for `openSettingsToTab`), `useObservedChats`, `AdapterIcon`, `buildPreviewSentence`
- Add tests for all three empty states (A: relay off, B: no adapters, C: no bindings)
- Test CTA button click handlers call correct `openSettingsToTab` variants
- Test no-bindings state renders ChannelPicker as CTA
- Update existing binding-list tests for new prop shapes and BoundChannelRow rendering

---

## Phase 9: Verification

### Task 9.1 — Run typecheck, lint, and full client test suite

**Size:** Medium | **Priority:** High | **Dependencies:** 8.1, 8.2, 7.1, 7.2

Run the full verification pipeline:

1. `pnpm typecheck` — zero errors
2. `pnpm lint` — zero errors, no new warnings
3. Full client test suite — all tests pass
4. Individual test files for all 5 modified/created test files
5. `pnpm format` — auto-fix formatting

Fix any issues found. Common problems: missing props on call sites, import path mismatches, unused imports from deleted code, FSD layer violations.

---

## Dependency Graph

```
Phase 1 (parallel):  1.1 ──────────────────────┐
                      1.2 ─────────────┐        │
                                       │        │
Phase 2:              2.1 ─────┐       │        │
                               │       │        │
Phase 3:              3.1 ◄────┘       │        │
                                       │        │
Phase 4:              4.1 ◄────────────┴────────┘
                        │
Phase 5:              5.1 ◄────┘
                        │
Phase 6:              6.1 ◄────┘
                        │
Phase 7 (parallel):   7.1 ◄── 1.1     7.2 ◄── 1.1
                        │                │
Phase 8 (parallel):   8.1 ◄── 4.1     8.2 ◄── 6.1
                        │                │
Phase 9:              9.1 ◄────────────┴─┴── 7.1, 7.2
```

**Total:** 11 tasks across 9 phases. ~3 large, ~5 medium, ~3 small.
