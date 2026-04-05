# Channels & Agent Adapters — Task Breakdown

**Spec:** `specs/channels-and-agent-adapters/02-specification.md`
**Generated:** 2026-04-04
**Mode:** Full (4 phases, 17 tasks)

---

## Phase 1: Vocabulary Rename

Low risk, high visibility. All tasks in this phase can run in parallel (except 1.6 which depends on all others).

| ID  | Task                                                                    | Size  | Priority | Dependencies | Parallel        |
| --- | ----------------------------------------------------------------------- | ----- | -------- | ------------ | --------------- |
| 1.1 | Rename Session Sidebar 'Adapters' section to 'Channels'                 | small | high     | —            | 1.2-1.5         |
| 1.2 | Rename Relay Panel feature-disabled message and section headers         | small | high     | —            | 1.1,1.3-1.5     |
| 1.3 | Rename empty state CTAs from 'adapter' to 'channel'                     | small | high     | —            | 1.1-1.2,1.4-1.5 |
| 1.4 | Rename command palette entry from 'Relay Messaging' to 'Channels'       | small | high     | —            | 1.1-1.3,1.5     |
| 1.5 | Rename Agent Dialog Connections tab label to 'Channels' with Radio icon | small | high     | —            | 1.1-1.4         |
| 1.6 | Update existing tests for vocabulary changes                            | small | high     | 1.1-1.5      | —               |

### 1.1 — Session Sidebar Vocabulary

**File:** `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`

- `<SidebarGroupLabel>` text: "Adapters" -> "Channels"
- Disabled message: "Relay disabled for this agent" -> "Channels disabled for this agent"
- Empty state: "No adapters configured" -> "No channels configured"
- Aria-label: "Open Relay panel" -> "Open Channels panel"
- TSDoc: "adapter" -> "channel"

### 1.2 — Relay Panel & ConnectionsTab Headers

**Files:**

- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` — feature disabled description: "Channels require Relay. Start DorkOS with relay enabled."
- `apps/client/src/layers/features/relay/ui/ConnectionsTab.tsx` — section headers: "Active Channels" / "Available Channels", empty text updates

### 1.3 — Empty State CTAs

**Files:**

- `apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx` — button "Set Up a Channel", body copy updated
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx` — JSDoc update on prop

### 1.4 — Command Palette

**File:** `apps/client/src/layers/features/command-palette/model/palette-contributions.ts`

- Label: "Relay Messaging" -> "Channels"
- Update 3 test files with matching string changes

### 1.5 — Agent Dialog Tab Label

**File:** `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`

- Icon: `Plug2` -> `Radio`
- Tab value: "connections" -> "channels"
- Panel header: "Connections" -> "Channels"

### 1.6 — Test Updates

Audit and fix all test files referencing old vocabulary. Run full test suite.

---

## Phase 2: Agent Dialog Channels Tab

Core new functionality. Depends on Phase 1 for naming.

| ID  | Task                                                        | Size   | Priority | Dependencies | Parallel |
| --- | ----------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 2.1 | Add openSettingsToTab and openAgentDialogToTab to app-store | medium | high     | 1.5          | —        |
| 2.2 | Build ChannelBindingCard component                          | medium | high     | 1.5          | 2.3      |
| 2.3 | Build ChannelPicker popover component                       | medium | high     | 1.5          | 2.2      |
| 2.4 | Build ChannelsTab and wire into AgentDialog                 | large  | high     | 2.1-2.3      | —        |
| 2.5 | Write tests for Phase 2 components                          | large  | high     | 2.2-2.4      | —        |

### 2.1 — Navigation Helpers

**Files:**

- `apps/client/src/layers/shared/model/app-store/app-store-panels.ts` — add `settingsInitialTab`, `openSettingsToTab()`, `agentDialogInitialTab`, `openAgentDialogToTab()`
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — consume `settingsInitialTab`
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — consume `agentDialogInitialTab`

### 2.2 — ChannelBindingCard

**New file:** `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx`

Shows: status dot, channel name, strategy badge, chat filter badge, permission icons, hover Edit/Remove actions. Remove button has confirmation dialog.

### 2.3 — ChannelPicker

**New file:** `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx`

Popover listing configured channels with status. Disabled/already-bound channels shown but not selectable. Footer: "Set up a new channel..." navigates to Settings.

### 2.4 — ChannelsTab (Agent Dialog)

**New file:** `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`

Replaces old ConnectionsTab. Three states: populated (binding cards + picker), no bindings (CTA), no channels system-wide (navigate to Settings). Mesh Health footer. Wired into AgentDialog, old ConnectionsTab.tsx deleted.

### 2.5 — Phase 2 Tests

Test files for ChannelBindingCard, ChannelPicker, and ChannelsTab covering CRUD operations, navigation, and all three states.

---

## Phase 3: Settings Tabs

Independent of Phase 2 (except shared navigation helpers from 2.1).

| ID  | Task                                                 | Size   | Priority | Dependencies | Parallel |
| --- | ---------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 3.1 | Build ChannelSettingRow component                    | small  | medium   | 1.2          | 3.2, 3.3 |
| 3.2 | Build Settings ChannelsTab and add to SettingsDialog | large  | medium   | 3.1, 2.1     | —        |
| 3.3 | Build AdapterRuntimeCard component                   | medium | medium   | —            | 3.1, 3.2 |
| 3.4 | Expand AgentsTab with Agent Adapters section         | medium | medium   | 3.3          | —        |
| 3.5 | Write tests for Phase 3 components                   | large  | medium   | 3.1-3.4      | —        |

### 3.1 — ChannelSettingRow

**New file:** `apps/client/src/layers/features/settings/ui/ChannelSettingRow.tsx`

Compact row: status dot, channel name + metadata (label, agent count), Configure button, enable/disable toggle.

### 3.2 — Settings ChannelsTab

**New file:** `apps/client/src/layers/features/settings/ui/ChannelsTab.tsx`

Two sections: Active Channels (ChannelSettingRow per instance in FieldCard) and Available Channels (CatalogCard grid). Reuses CatalogCard and AdapterSetupWizard from relay feature. Added to SettingsDialog sidebar between Tools and Agents with Radio icon.

### 3.3 — AdapterRuntimeCard

**New file:** `apps/client/src/layers/features/settings/ui/AdapterRuntimeCard.tsx`

Expandable card: icon, name, status badge, description, toggle in header. Body expands/collapses with 200ms animation. Coming-soon cards are dashed/dimmed.

### 3.4 — AgentsTab Expansion

**File:** `apps/client/src/layers/features/settings/ui/AgentsTab.tsx`

Add Agent Adapters section between default agent selector and DorkBot reset. Hardcoded RUNTIME_ADAPTERS constant: Claude Code (active, expandable config), OpenAI (coming soon), Local Model (coming soon). Config rows are read-only for now.

### 3.5 — Phase 3 Tests

Test files for ChannelSettingRow, AdapterRuntimeCard, Settings ChannelsTab, and AgentsTab expansion.

---

## Phase 4: Agents Page + Navigation

Depends on Phase 2 for Agent Dialog Channels tab as navigation target.

| ID  | Task                                              | Size   | Priority | Dependencies  | Parallel |
| --- | ------------------------------------------------- | ------ | -------- | ------------- | -------- |
| 4.1 | Add channel badges to AgentRow                    | medium | medium   | 1.2           | 4.2      |
| 4.2 | Wire bidirectional navigation across all surfaces | medium | medium   | 2.1, 2.4      | 4.1      |
| 4.3 | Write tests for AgentRow badges and navigation    | medium | medium   | 4.1, 4.2      | —        |
| 4.4 | Full integration verification and typecheck       | medium | high     | 2.5, 3.5, 4.3 | —        |

### 4.1 — AgentRow Channel Badges

**File:** `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`

Add `useBindings()` and `useAdapterCatalog()` to derive channel names per agent. Render `Badge variant="outline"` for each channel after the runtime badge. Show muted "no channels" text when relay is enabled but no bindings exist.

### 4.2 — Bidirectional Navigation

**Files:**

- `AgentRow.tsx` — add "Channels" button that opens AgentDialog at channels tab
- `AgentDialog.tsx` — add optional `initialTab` prop for local instance use
- ChannelPicker footer -> Settings (already done in 2.4)
- Channels Panel -> Agent Dialog noted as follow-up

### 4.3 — Phase 4 Tests

Tests for channel badges (0, 1, multiple bindings), relay disabled state, and navigation initialTab behavior.

### 4.4 — Integration Verification

Full `pnpm typecheck`, `pnpm test -- --run`, `pnpm lint`. Vocabulary audit grep. Verify old ConnectionsTab.tsx removed. Verify barrel exports.

---

## Execution Summary

| Phase                        | Tasks  | Parallel Opportunities            | Estimated Size |
| ---------------------------- | ------ | --------------------------------- | -------------- |
| 1: Vocabulary Rename         | 6      | 5 tasks in parallel, then 1       | Small          |
| 2: Agent Dialog Channels Tab | 5      | 2.2+2.3 parallel, rest sequential | Large          |
| 3: Settings Tabs             | 5      | 3.1+3.3 parallel, rest sequential | Large          |
| 4: Agents Page + Navigation  | 4      | 4.1+4.2 parallel, rest sequential | Medium         |
| **Total**                    | **17** |                                   |                |

**Critical path:** Phase 1 (all) -> Phase 2 (2.1 -> 2.2+2.3 -> 2.4 -> 2.5) -> Phase 4 (4.4)

**Phase 3 can run in parallel with Phase 2** after task 2.1 completes (shared navigation helpers).
