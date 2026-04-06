# Task Breakdown: Settings Dialog File Splits

Generated: 2026-04-06
Source: `specs/settings-dialog-01-file-splits/02-specification.md`
Last Decompose: 2026-04-06 (full mode — first decomposition)

## Overview

Pure refactor splitting four oversized files in `apps/client/src/layers/features/settings/ui/` under the 300-line ceiling enforced by `.claude/rules/file-size.md`. **No behavior changes**, **no UX changes** — those belong to follow-on specs (`settings-dialog-02-tabbed-primitive`, `settings-dialog-03-url-deeplinks`, `settings-dialog-04-playground`).

| Target file           | Current | Goal |
| --------------------- | ------: | ---: |
| `SettingsDialog.tsx`  |     491 | ~140 |
| `ExternalMcpCard.tsx` |     540 | ~150 |
| `ToolsTab.tsx`        |     436 | ~120 |
| `TunnelDialog.tsx`    |     490 | ~180 |

The remaining ~1,400 lines move to ~18 small, single-responsibility files inside `features/settings/`, plus one promotion of `CopyButton` + `useCopyFeedback` to `shared/`.

**Phase ordering**: Phase 1 → Phase 4 has a hard dependency (Phase 1 moves the Tools "Reset to defaults" button into `ToolsTab.tsx`, which Phase 4 relies on). Phases 2 and 3 are independent of Phases 1 and 4. Phase 5 is the final verification gate.

**Task counts**: 6 (P1) + 14 (P2) + 5 (P3) + 6 (P4) + 3 (P5) = **34 tasks**.

---

## Phase 1: ToolsTab Refactor

### Task 1.1: [P1] Create config/tool-inventory.ts

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 1.2, 1.3, 1.4

**Source**: `apps/client/src/layers/features/settings/ui/ToolsTab.tsx` lines 31-118
**Destination**: `apps/client/src/layers/features/settings/config/tool-inventory.ts` (NEW — also creates the `config/` directory)

Pure data file — no React imports. Exports `TOOL_INVENTORY`, `ToolDomainKey`, `GlobalConfigKey`, `CONFIG_KEY_MAP`, `ToolGroupDef`, `TOOL_GROUPS`. Module-level TSDoc references `services/runtimes/claude-code/tool-filter.ts` per spec §11.

**Acceptance**:

- [ ] All six exports present
- [ ] Module-level TSDoc references the parallel server file
- [ ] No React imports
- [ ] < 100 lines

### Task 1.2: [P1] Extract tools/ToolCountBadge.tsx

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 1.1, 1.3, 1.4

**Source**: `ToolsTab.tsx` lines 224-251
**Destination**: `apps/client/src/layers/features/settings/ui/tools/ToolCountBadge.tsx` (NEW)

Extract the `ToolCountBadge` component verbatim, promote to a named export. Imports only from `@/layers/shared/ui` (`Badge`, `Tooltip`, `TooltipContent`, `TooltipTrigger`).

**Acceptance**:

- [ ] Named export `ToolCountBadge`
- [ ] TSDoc on exported function
- [ ] Markup byte-identical
- [ ] < 50 lines

### Task 1.3: [P1] Extract tools/SchedulerSettings.tsx

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 1.1, 1.2, 1.4

**Source**: `ToolsTab.tsx` lines 253-321
**Destination**: `apps/client/src/layers/features/settings/ui/tools/SchedulerSettings.tsx` (NEW)

Extract `SchedulerSettings` (Concurrent runs / Timezone with all 13 IANA options / Run history). Imports only from `@/layers/shared/ui`.

**Acceptance**:

- [ ] Named export with TSDoc
- [ ] All 13 timezone select items preserved
- [ ] Min/max validators preserved (1-10 concurrent, 1+ retention)
- [ ] < 100 lines

### Task 1.4: [P1] Extract tools/ToolGroupRow.tsx

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1, 1.2 | **Parallel with**: 1.3

**Source**: `ToolsTab.tsx` lines 120-222
**Destination**: `apps/client/src/layers/features/settings/ui/tools/ToolGroupRow.tsx` (NEW)

Imports `ToolDomainKey`/`ToolGroupDef` from `../../config/tool-inventory` and `ToolCountBadge` from `./ToolCountBadge`. Preserves all aria-labels and the `Collapsible` expansion logic.

**Acceptance**:

- [ ] Named export with TSDoc
- [ ] All aria-labels preserved exactly
- [ ] < 130 lines

### Task 1.5: [P1] Slim ToolsTab.tsx and move Reset button into it

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1, 1.2, 1.3, 1.4 | **Parallel with**: none

**Source/Destination**: `apps/client/src/layers/features/settings/ui/ToolsTab.tsx` (rewrite) + edit `SettingsDialog.tsx` lines 411-433 to remove the inline `<NavigationLayoutPanelHeader>` for Tools.

Slimmed `ToolsTab.tsx` consumes the four new files, owns its own `<NavigationLayoutPanelHeader actions={<ResetButton …/>}>Tools</NavigationLayoutPanelHeader>`, and absorbs the Tools Reset handler (`transport.updateConfig({ agentContext: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true } })` + `queryClient.invalidateQueries({ queryKey: ['config'] })`). Inline `ResetButton` is ~6 lines and is NOT promoted (deferred per spec §6.4). The Tools panel in `SettingsDialog.tsx` shrinks to just `<NavigationLayoutPanel value="tools"><ToolsTab /></NavigationLayoutPanel>` so we don't end up with a duplicate header during Phase 1.

**Acceptance**:

- [ ] `ToolsTab.tsx` < 150 lines (target ~120)
- [ ] No inline `TOOL_INVENTORY`/`TOOL_GROUPS`/`CONFIG_KEY_MAP`/`ToolGroupRow`/`ToolCountBadge`/`SchedulerSettings`
- [ ] `SettingsDialog.tsx:411-433` Tools `<NavigationLayoutPanelHeader>` block removed
- [ ] `pnpm typecheck` passes

### Task 1.6: [P1] Phase 1 verification — typecheck, tests, smoke

**Size**: Small | **Priority**: High | **Dependencies**: 1.5

```bash
pnpm typecheck
pnpm vitest run apps/client/src/layers/features/settings/__tests__/SettingsDialog.test.tsx
pnpm vitest run apps/client/src/layers/features/settings
wc -l apps/client/src/layers/features/settings/ui/ToolsTab.tsx
```

Manual smoke (spec §8.1): toggle each tool group, expand Tasks scheduler, click Reset, verify ExternalMcpCard renders, no console errors.

---

## Phase 2: ExternalMcpCard Refactor

### Task 2.1: [P2] Move useCopyFeedback hook to shared/lib

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: none

**Source**: `apps/client/src/layers/features/settings/lib/use-copy-feedback.ts` + its test at `apps/client/src/layers/features/settings/__tests__/use-copy-feedback.test.ts`
**Destination**: `apps/client/src/layers/shared/lib/use-copy-feedback.ts` + `apps/client/src/layers/shared/lib/__tests__/use-copy-feedback.test.ts`

Move the file (with test). In the new location, change `import { TIMING } from '@/layers/shared/lib'` to `import { TIMING } from './constants'` to avoid the self-referential alias cycle.

**Update consumer imports** (NOTE: spec only mentions ServerTab + ExternalMcpCard, but `TunnelConnected.tsx:7` ALSO imports `useCopyFeedback` from the old path):

- `ExternalMcpCard.tsx` line 19 → `'@/layers/shared/lib'`
- `TunnelConnected.tsx` line 7 → `'@/layers/shared/lib'`
- (`ServerTab.tsx` updated separately in task 2.4)

Delete the old source + test file after the move.

**Acceptance**:

- [ ] New file + test in `shared/lib/`
- [ ] Old file + test deleted
- [ ] All three consumers (ExternalMcpCard, TunnelConnected, eventually ServerTab) use the new import path
- [ ] `pnpm typecheck` + tests pass

### Task 2.2: [P2] Export useCopyFeedback from shared/lib barrel

**Size**: Small | **Priority**: High | **Dependencies**: 2.1

Edit `apps/client/src/layers/shared/lib/index.ts` to add `export { useCopyFeedback } from './use-copy-feedback';`.

### Task 2.3: [P2] Create shared/ui/copy-button.tsx

**Size**: Small | **Priority**: High | **Dependencies**: 2.1, 2.2 | **Parallel with**: none

**Source**: inline `CopyButton` from `ExternalMcpCard.tsx` lines 35-49
**Destination**: `apps/client/src/layers/shared/ui/copy-button.tsx` (NEW)

Per spec §6.3, exposes `CopyButtonProps { value, label?, className?, size? }`. Default `label = 'Copy to clipboard'`, default `size = 'sm'` (renders `size-3.5` icons matching current usage). Imports `useCopyFeedback` from `@/layers/shared/lib`. Add to `shared/ui/index.ts` barrel.

**Acceptance**:

- [ ] Component + props interface match spec §6.3 contract verbatim
- [ ] TSDoc on component AND on each prop field
- [ ] `'md'` size renders `size-4`
- [ ] Re-exported from `shared/ui/index.ts`

### Task 2.4: [P2] Update ServerTab.tsx to use shared useCopyFeedback

**Size**: Small | **Priority**: Medium | **Dependencies**: 2.2 | **Parallel with**: 2.3

**Source**: `apps/client/src/layers/features/settings/ui/ServerTab.tsx` lines 73-82 — local `useCopy` helper to delete

Add `import { useCopyFeedback } from '@/layers/shared/lib';`, delete the local `useCopy()`, replace call sites with `useCopyFeedback()`. Remove now-unused imports (`useState`, `useCallback`, `TIMING` may all become unused).

**Acceptance**:

- [ ] No local `useCopy` defined
- [ ] Lint clean (no unused imports)

### Task 2.5: [P2] Extract lib/external-mcp-snippets.ts

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 2.1, 2.6, 2.7, 2.8, 2.9, 2.10

**Source**: `ExternalMcpCard.tsx` lines 55-102
**Destination**: `apps/client/src/layers/features/settings/lib/external-mcp-snippets.ts` (NEW)

Pure helper. Exports `buildSnippets(endpoint, apiKey)` returning `ExternalMcpSnippets { claudeCode, claudeCodeCli, cursor, windsurf }`. No React. Output byte-identical to current behavior for same inputs.

### Task 2.6: [P2] Create external-mcp/DuplicateToolWarning.tsx

**Size**: Small | **Priority**: Medium | **Dependencies**: none | **Parallel with**: 2.5, 2.7, 2.8, 2.9, 2.10

**Source**: `ExternalMcpCard.tsx` lines 240-254
**Destination**: `apps/client/src/layers/features/settings/ui/external-mcp/DuplicateToolWarning.tsx` (NEW — creates the `external-mcp/` subdirectory)

No props. Warning banner with `AlertTriangle` icon and the duplicate-tool-names message. Markup byte-identical.

### Task 2.7: [P2] Create external-mcp/EndpointRow.tsx

**Size**: Small | **Priority**: Medium | **Dependencies**: 2.3 | **Parallel with**: 2.5, 2.6, 2.8, 2.9, 2.10

**Source**: `ExternalMcpCard.tsx` lines 256-268
**Destination**: `apps/client/src/layers/features/settings/ui/external-mcp/EndpointRow.tsx` (NEW)

Props: `{ endpoint: string }`. Uses the new shared `CopyButton`.

### Task 2.8: [P2] Create external-mcp/ApiKeySection.tsx

**Size**: Medium | **Priority**: High | **Dependencies**: 2.1, 2.2 | **Parallel with**: 2.5, 2.6, 2.7, 2.9, 2.10

**Source**: `ExternalMcpCard.tsx` lines 416-540 (interface + four-state component)
**Destination**: `apps/client/src/layers/features/settings/ui/external-mcp/ApiKeySection.tsx` (NEW)

Props per spec §6.3 (`authConfigured`, `authSource`, `generatedKey`, `keyError`, `onGenerate`, `onRotate`, `onRemove`). All four states preserved (env-managed, none-configured, just-generated, configured-masked). The inline `<button>` for the just-generated copy action stays as-is (NOT swapped for shared `CopyButton` because the icon size and padding differ — preserving identical visual output is the priority).

**Acceptance**:

- [ ] All four states render byte-identical to source
- [ ] Inline copy `<button>` preserved
- [ ] Imports `useCopyFeedback` from `@/layers/shared/lib`
- [ ] < 150 lines

### Task 2.9: [P2] Create external-mcp/RateLimitSection.tsx

**Size**: Small | **Priority**: Medium | **Dependencies**: none | **Parallel with**: 2.5, 2.6, 2.7, 2.8, 2.10

**Source**: `ExternalMcpCard.tsx` lines 281-336
**Destination**: `apps/client/src/layers/features/settings/ui/external-mcp/RateLimitSection.tsx` (NEW)

Props per spec §6.3: `{ rateLimit: McpConfig['rateLimit']; onUpdate: (patch) => void }`. Conditional inputs only render when `rateLimit.enabled === true`. HTML `id`s preserved (`mcp-max-requests`, `mcp-window-secs`).

### Task 2.10: [P2] Create external-mcp/SetupInstructions.tsx

**Size**: Medium | **Priority**: High | **Dependencies**: 2.3, 2.5 | **Parallel with**: 2.6, 2.7, 2.8, 2.9

**Source**: `ExternalMcpCard.tsx` lines 338-408
**Destination**: `apps/client/src/layers/features/settings/ui/external-mcp/SetupInstructions.tsx` (NEW)

Props: `{ endpoint, apiKey }`. Owns its own `setupOpen`/`setupTab` state (moved from parent — no parent code depends on them). Calls `buildSnippets(endpoint, apiKey)` from `../../lib/external-mcp-snippets`. Uses shared `CopyButton`. Three tab labels: "Claude Code", "Cursor", "Windsurf". CLI command snippet only renders when `setupTab === 'claude-code'`.

### Task 2.11: [P2] Create new external-mcp/ExternalMcpCard.tsx shell

**Size**: Medium | **Priority**: High | **Dependencies**: 2.3, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10 | **Parallel with**: none

**Source**: rewrite of `ExternalMcpCard.tsx` (current top-level)
**Destination**: `apps/client/src/layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx` (NEW)

Owns the card shell, the three useStates (`expanded`, `generatedKey`, `keyError`), the five `useCallback`s (`invalidateConfig`, `handleToggle`, `handleGenerateKey`, `handleRotateKey`, `handleRemoveKey`, `handleUpdateRateLimit`), and the `statusBadge` JSX. Composes the five sub-components in this order: `DuplicateToolWarning → EndpointRow → ApiKeySection → RateLimitSection → SetupInstructions`.

**Acceptance**: < 200 lines (target ~150). All aria-labels preserved.

### Task 2.12: [P2] Delete top-level ExternalMcpCard.tsx and update ToolsTab import

**Size**: Small | **Priority**: High | **Dependencies**: 2.11

Per spec §6.1 decision (relocation, not shim): delete `apps/client/src/layers/features/settings/ui/ExternalMcpCard.tsx` and update `ToolsTab.tsx` import to `./external-mcp/ExternalMcpCard`.

### Task 2.13: [P2] Update ExternalMcpCard.test.tsx import path

**Size**: Small | **Priority**: High | **Dependencies**: 2.12

Per spec Q4 (§13): keep test at `apps/client/src/layers/features/settings/__tests__/ExternalMcpCard.test.tsx`, only update the import path to `'../ui/external-mcp/ExternalMcpCard'`.

### Task 2.14: [P2] Phase 2 verification — typecheck, tests, smoke

**Size**: Small | **Priority**: High | **Dependencies**: 2.4, 2.13

```bash
pnpm typecheck
pnpm vitest run apps/client/src/layers/features/settings
pnpm vitest run apps/client/src/layers/shared/lib/__tests__/use-copy-feedback.test.ts
pnpm lint
wc -l apps/client/src/layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx
```

Smoke (spec §8.1 ExternalMcpCard scenarios): expand card, generate API key, rotate, remove; toggle rate limiting; switch setup snippet tabs and copy each; verify ServerTab + TunnelConnected still copy correctly via shared hook.

---

## Phase 3: TunnelDialog Refactor

### Task 3.1: [P3] Create model/tunnel-view-state.ts

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: none

**Source**: `TunnelDialog.tsx` lines 28-63
**Destination**: `apps/client/src/layers/features/settings/model/tunnel-view-state.ts` (NEW — creates `model/` directory)

Pure types + constants + `deriveViewState`. Exports: `TunnelState`, `ViewState`, `START_TIMEOUT_MS = 15_000`, `STUCK_STATE_TIMEOUT_MS = 30_000`, `LATENCY_INTERVAL_MS = 30_000`, `deriveViewState(tokenConfigured, showSetup, tunnelState)`.

### Task 3.2: [P3] Create model/use-tunnel-machine.ts

**Size**: Large | **Priority**: High | **Dependencies**: 3.1

**Source**: `TunnelDialog.tsx` lines 67-176 (state + useEffects) + 269-282 (derived values)
**Destination**: `apps/client/src/layers/features/settings/model/use-tunnel-machine.ts` (NEW)

Owns the full state machine: `useQuery(['config'])`, 11 `useState`s, 1 `useRef`, 7 `useEffect`s (config sync, domain sync, passcode sync, showSetup reset, disconnect/reconnect toasts, stuck-state recovery, latency measurement). Returns the full `TunnelMachine` interface from spec §6.5.

**Critical**: Effect ordering and dependency arrays MUST be preserved verbatim. ALL `eslint-disable` comments must be copied verbatim with their explanatory text — they document legitimate React `set-state-in-effect` exceptions.

**Acceptance**:

- [ ] All 7 useEffects in same order
- [ ] All eslint-disable comments preserved
- [ ] Returns the TunnelMachine shape from spec §6.5
- [ ] `pnpm lint` clean

### Task 3.3: [P3] Create model/use-tunnel-actions.ts

**Size**: Medium | **Priority**: High | **Dependencies**: 3.2

**Source**: `TunnelDialog.tsx` lines 178-267
**Destination**: `apps/client/src/layers/features/settings/model/use-tunnel-actions.ts` (NEW)

Args per spec §6.5: `{ machine, transport, queryClient }`. Returns `TunnelActions { handleToggle, handleSaveToken, handleSaveDomain, handlePasscodeToggle, handleSavePasscode }`. Each action wraps `useCallback`. Bare state setter calls (`setState('starting')`) become `machine.setState('starting')`.

**Implementation note**: Verify whether `Transport` is exported from `@/layers/shared/lib` or `@/layers/shared/model` before writing. If neither, type as `ReturnType<typeof useTransport>`.

### Task 3.4: [P3] Slim TunnelDialog.tsx to consume hooks

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1, 3.2, 3.3

**Source/Destination**: `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` (rewrite, target ~180 lines)

Slim shell consumes `useTunnelMachine` and `useTunnelActions`. Adds local `viewMotion` const consolidating `variants`/`initial`/`animate`/`exit`/`transition` so the six `<motion.div>` wrappers each spread it. All view branches render the same children with the same props.

**Acceptance**:

- [ ] No `useState`/`useEffect`/`useCallback` action-handlers remain
- [ ] `viewMotion` spread on every `<motion.div>`
- [ ] `broadcastTunnelChange` import removed (now in `use-tunnel-actions`)
- [ ] < 250 lines (target ~180)

### Task 3.5: [P3] Phase 3 verification — typecheck, tunnel tests, smoke

**Size**: Small | **Priority**: High | **Dependencies**: 3.4

```bash
pnpm typecheck
pnpm vitest run apps/client/src/layers/features/settings/__tests__/TunnelDialog.test.tsx
pnpm vitest run apps/client/src/layers/features/settings/__tests__/TunnelConnected.test.tsx
pnpm vitest run apps/client/src/layers/features/settings/__tests__/TunnelConnecting.test.tsx
pnpm vitest run apps/client/src/layers/features/settings/__tests__/tunnel-utils.test.ts
wc -l apps/client/src/layers/features/settings/ui/TunnelDialog.tsx
```

Manual: full state machine cycles `off → starting → connected → off` and `off → starting → error → retry → off`. Verify disconnect/reconnect toasts, latency display, passcode set/save, domain save.

---

## Phase 4: SettingsDialog Refactor

### Task 4.1: [P4] Extract ui/RemoteAccessAction.tsx

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 4.2, 4.3, 4.4

**Source**: `SettingsDialog.tsx` lines 73-105
**Destination**: `apps/client/src/layers/features/settings/ui/RemoteAccessAction.tsx` (NEW)

Both mobile (`motion.button` with spring) and desktop (regular `button`) branches preserved with identical markup.

### Task 4.2: [P4] Create tabs/AppearanceTab.tsx

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 4.1, 4.3, 4.4

**Source**: `SettingsDialog.tsx` lines 212-292
**Destination**: `apps/client/src/layers/features/settings/ui/tabs/AppearanceTab.tsx` (NEW)

Parameterless named export. Reads `theme`/`setTheme` from `useTheme()`, reads `fontFamily`/`setFontFamily`/`fontSize`/`setFontSize`/`resetPreferences` from `useAppStore`. Owns its own `<NavigationLayoutPanelHeader>` with the "Reset to defaults" button (handler: `resetPreferences()` + `setTheme('system')`). Three Select rows: Theme, Font family, Font size.

### Task 4.3: [P4] Create tabs/PreferencesTab.tsx

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 4.1, 4.2, 4.4

**Source**: `SettingsDialog.tsx` lines 294-377
**Destination**: `apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx` (NEW)

Parameterless export. Nine SettingRow toggles in source order: showTimestamps, expandToolCalls, autoHideToolCalls, showShortcutChips, showTaskCelebrations, enableNotificationSound, enableTasksNotifications, promoEnabled, devtoolsOpen.

### Task 4.4: [P4] Create tabs/StatusBarTab.tsx (folds in StatusBarSettingRow)

**Size**: Small | **Priority**: High | **Dependencies**: none | **Parallel with**: 4.1, 4.2, 4.3

**Source**: `SettingsDialog.tsx` lines 62-70 (StatusBarSettingRow helper) + lines 379-401 (Status Bar panel body)
**Destination**: `apps/client/src/layers/features/settings/ui/tabs/StatusBarTab.tsx` (NEW)

Local helper `StatusBarSettingRow` (private — not exported). `StatusBarTab` renders `<NavigationLayoutPanelHeader actions={…resetStatusBarPreferences…}>` and maps `STATUS_BAR_REGISTRY` items.

### Task 4.5: [P4] Slim SettingsDialog.tsx to consume new components

**Size**: Medium | **Priority**: High | **Dependencies**: 1.5, 4.1, 4.2, 4.3, 4.4 | **Parallel with**: none

**Source/Destination**: `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` (full rewrite, target ~140 lines)

**What stays**: function signature/props, `useState` for `activeTab`, deep-link `useEffect`, `useQuery(['config'])`, `ResponsiveDialog` + `NavigationLayout` skeleton, sidebar items + extension tabs, panel loop (with extension tabs in `Suspense`), `TunnelDialog` and `ServerRestartOverlay` siblings, `<RemoteAccessAction>` reference.

**What goes**: `StatusBarSettingRow` helper, inline `RemoteAccessAction` component, Appearance/Preferences/StatusBar inline panel bodies, `useTheme()` call, all preference destructuring from `useAppStore`, `queryClient` import, Tools panel inline `<NavigationLayoutPanelHeader>` (already removed in Phase 1).

**Critical**: The `<NavigationLayoutPanelHeader>` blocks for Server, Channels, Agents, Advanced STAY inlined here per spec §6.2 because their existing tab components return content only without a header. Header normalization is the next spec's job.

**Acceptance**:

- [ ] < 200 lines (target ~140)
- [ ] No `useTheme` import
- [ ] No preference destructuring (only `settingsInitialTab` selector remains)
- [ ] No `queryClient` import
- [ ] `RemoteAccessAction` and `StatusBarSettingRow` no longer defined inline

### Task 4.6: [P4] Phase 4 verification — typecheck, full tests, smoke

**Size**: Small | **Priority**: High | **Dependencies**: 4.5

```bash
pnpm typecheck
pnpm test -- --run
pnpm vitest run apps/client/src/layers/features/settings/__tests__/SettingsDialog.test.tsx
wc -l apps/client/src/layers/features/settings/ui/SettingsDialog.tsx
```

Smoke (spec §8.1): cycle through all 8 tabs, verify Remote Access opens, deep-link via `useAppStore.getState().openSettingsToTab('tools')`.

---

## Phase 5: Verification Gate

### Task 5.1: [P5] Run typecheck, full test suite, lint

**Size**: Small | **Priority**: High | **Dependencies**: 1.6, 2.14, 3.5, 4.6

```bash
pnpm typecheck
pnpm test -- --run
pnpm lint
```

All three must exit with code 0. If any fail, return to the offending phase, fix the regression, re-run this gate.

### Task 5.2: [P5] Verify file sizes with wc -l

**Size**: Small | **Priority**: High | **Dependencies**: 5.1

```bash
wc -l apps/client/src/layers/features/settings/ui/{SettingsDialog,ToolsTab,TunnelDialog}.tsx \
      apps/client/src/layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx
```

Targets per spec §1: SettingsDialog ~140, ToolsTab ~120, TunnelDialog ~180, ExternalMcpCard ~150. All four MUST be < 300. No new files should exceed 300 either.

### Task 5.3: [P5] Final manual smoke test (12 scenarios)

**Size**: Medium | **Priority**: High | **Dependencies**: 5.2

Run the complete checklist from spec §8.1 against the dev server:

1. Settings → Appearance: change theme/font/size, click Reset
2. Settings → Preferences: toggle each of the 9 switches
3. Settings → Status Bar: toggle items, click Reset
4. Settings → Server: verify all 9 config rows render
5. Settings → Tools: toggle each group, expand Tasks scheduler, click Reset
6. Settings → Channels: catalog renders
7. Settings → Agents: dropdown + runtime cards render
8. Settings → Advanced: logging rows + Reset/Restart buttons
9. Remote Access (sidebar): full state machine landing → setup → ready → connecting → connected → off
10. Tools → External MCP card: expand, generate key, rotate, change rate limit, switch snippet tabs, copy each
11. Mobile viewport (375px): verify drill-in works on every tab + the mobile `RemoteAccessAction`
12. Deep-link: `useAppStore.getState().openSettingsToTab('tools')` opens to Tools

**Acceptance**: All 12 scenarios pass with no console errors. Visual rendering byte-identical to main.

---

## Dependency Graph Summary

```
Phase 1 (parallel where possible)
  1.1 ─┬─→ 1.4 ─┐
  1.2 ─┘        ├→ 1.5 → 1.6
  1.3 ──────────┘

Phase 2 (parallel sub-component creation, then sequential integration)
  2.1 → 2.2 → 2.3 ──────────────────┐
                                     │
  (2.5/2.6/2.7/2.8/2.9/2.10 parallel)→ 2.11 → 2.12 → 2.13 → 2.14
       ↑   ↑   ↑   ↑                 │
       │   └───┴───┴── (2.7 needs 2.3, 2.10 needs 2.3+2.5, 2.8 needs 2.1/2.2)
  2.4 ─────────────────────────────────────────────────────→ 2.14

Phase 3 (sequential — each step builds on the prior)
  3.1 → 3.2 → 3.3 → 3.4 → 3.5

Phase 4 (parallel extraction, sequential slim)
  4.1 ─┐
  4.2 ─┤
  4.3 ─┼→ 4.5 → 4.6
  4.4 ─┘   ↑
  1.5 ─────┘  (Phase 4 slim depends on Phase 1's Reset button move)

Phase 5
  1.6, 2.14, 3.5, 4.6 → 5.1 → 5.2 → 5.3
```

**Key cross-phase edges**:

- Phase 4 task 4.5 (slim SettingsDialog) depends on Phase 1 task 1.5 (which moves the Tools Reset button into ToolsTab and removes the inline header from SettingsDialog).
- Phase 2 tasks 2.7, 2.8, 2.10 depend on the shared `CopyButton`/`useCopyFeedback` promotion (2.1-2.3).
- Phase 5 verification depends on all four phase verifications.

## Notes / Findings During Decomposition

- **Source line counts verified** with `wc -l`: SettingsDialog 491, ExternalMcpCard 540, ToolsTab 436, TunnelDialog 490 — all match spec §1.
- **Test file location correction**: spec §6.6 says `use-copy-feedback.test.ts` lives at `features/settings/lib/__tests__/`, but it actually lives at `apps/client/src/layers/features/settings/__tests__/use-copy-feedback.test.ts` (single flat tests dir). Task 2.1 uses the actual current path.
- **Additional consumer not in spec**: `apps/client/src/layers/features/settings/ui/TunnelConnected.tsx:7` also imports `useCopyFeedback` from `'../lib/use-copy-feedback'`. Task 2.1 covers updating this third consumer.
- **`AdvancedTab.tsx` clipboard inline**: spec §2 mentions `AdvancedTab.tsx` reimplements the copy pattern, but spec §4 explicitly scopes only `ServerTab.tsx` for the inline-`useCopy` swap. `AdvancedTab.tsx` uses `navigator.clipboard.writeText` directly without a `useCopy` wrapper — leaving it alone matches the spec's narrow scope.
- **Phase 1 / Phase 4 ordering subtlety**: Phase 1 task 1.5 must remove the Tools `<NavigationLayoutPanelHeader>` from `SettingsDialog.tsx` (lines 411-433) at the same time it adds a header to `ToolsTab.tsx`, otherwise the user would see a duplicate header during the window between Phase 1 and Phase 4. The task description makes this explicit.
- **`ApiKeySection` inline copy button**: keeps its own `<button>` with `size-4` icons rather than the new `CopyButton` because the existing icon size and padding differ. Preserving identical visual output is the priority per non-goals.
