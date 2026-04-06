# Implementation Summary: Settings Dialog File Splits

**Created:** 2026-04-06
**Last Updated:** 2026-04-06
**Spec:** specs/settings-dialog-01-file-splits/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 34 / 34

## Result

Pure refactor splitting four oversized Settings dialog files under the 300-line ceiling defined in `.claude/rules/file-size.md`. Zero behavior changes, zero UX changes. Verified by 3,488 unit tests + 11/12 manual smoke scenarios in Chrome.

| File                                             | Before | After |                Δ |
| ------------------------------------------------ | -----: | ----: | ---------------: |
| `ui/SettingsDialog.tsx`                          |    491 |   177 |             −314 |
| `ui/ExternalMcpCard.tsx` → `ui/external-mcp/...` |    540 |   171 |             −369 |
| `ui/ToolsTab.tsx`                                |    436 |   155 |             −281 |
| `ui/TunnelDialog.tsx`                            |    490 |   241 |             −249 |
| **Total (4 target files)**                       |  1,957 |   744 | **−1,213 (62%)** |

The remaining 1,213 lines moved into 16 new focused files spread across `config/`, `lib/`, `model/`, `ui/tabs/`, `ui/tools/`, and `ui/external-mcp/`, plus one promotion to `shared/ui` and one to `shared/lib`. All new files are under 206 lines.

## Tasks Completed

### Session 1 — 2026-04-06

**All 34 tasks completed across 11 batches.** Execution mode: parallel batches with holistic gate review per batch (the originally selected per-task two-stage review was deemed impractical for main-context budget after Batch 1 — see Implementation Notes below for rationale).

**Phase 1 — ToolsTab refactor (6 tasks)**

- #1 Create config/tool-inventory.ts (1.1)
- #2 Extract tools/ToolCountBadge.tsx (1.2)
- #3 Extract tools/SchedulerSettings.tsx (1.3)
- #4 Extract tools/ToolGroupRow.tsx (1.4)
- #5 Slim ToolsTab.tsx and move Reset button into it (1.5)
- #6 Phase 1 verification gate (1.6)

**Phase 2 — ExternalMcpCard refactor + shared promotion (14 tasks)**

- #7 Move useCopyFeedback hook to shared/lib (2.1)
- #8 Export useCopyFeedback from shared/lib barrel (2.2)
- #9 Create shared/ui/copy-button.tsx (2.3)
- #10 Update ServerTab.tsx to use shared useCopyFeedback (2.4)
- #11 Extract lib/external-mcp-snippets.ts (2.5)
- #12 Create external-mcp/DuplicateToolWarning.tsx (2.6)
- #13 Create external-mcp/EndpointRow.tsx (2.7)
- #14 Create external-mcp/ApiKeySection.tsx (2.8)
- #15 Create external-mcp/RateLimitSection.tsx (2.9)
- #16 Create external-mcp/SetupInstructions.tsx (2.10)
- #17 Create new external-mcp/ExternalMcpCard.tsx shell (2.11)
- #18 Delete top-level ExternalMcpCard.tsx and update ToolsTab import (2.12)
- #19 Update ExternalMcpCard.test.tsx import path (2.13)
- #20 Phase 2 verification gate (2.14)

**Phase 3 — TunnelDialog refactor (5 tasks)**

- #21 Create model/tunnel-view-state.ts (3.1)
- #22 Create model/use-tunnel-machine.ts (3.2 — owns 11 useStates, 7 useEffects, 1 useRef, all eslint-disable comments verbatim)
- #23 Create model/use-tunnel-actions.ts (3.3)
- #24 Slim TunnelDialog.tsx to consume hooks (3.4)
- #25 Phase 3 verification gate (3.5)

**Phase 4 — SettingsDialog refactor (6 tasks)**

- #26 Extract ui/RemoteAccessAction.tsx (4.1)
- #27 Create tabs/AppearanceTab.tsx (4.2)
- #28 Create tabs/PreferencesTab.tsx (4.3)
- #29 Create tabs/StatusBarTab.tsx (4.4)
- #30 Slim SettingsDialog.tsx to consume new components (4.5)
- #31 Phase 4 verification gate (4.6)

**Phase 5 — Verification gate (3 tasks)**

- #32 Full pnpm typecheck/test/lint gate (5.1) — 19/19 turbo tasks, 3,488/3,488 tests, lint clean
- #33 File-size verification (5.2) — all 4 targets <300, largest helper 206
- #34 Final 12-scenario manual smoke test in Chrome (5.3) — 11/12 PASS, 1 SKIPPED (deep-link not externally drivable)

## Files Modified/Created

**Source files created (16 new):**

- `apps/client/src/layers/features/settings/config/tool-inventory.ts` (99 lines)
- `apps/client/src/layers/features/settings/lib/external-mcp-snippets.ts`
- `apps/client/src/layers/features/settings/model/tunnel-view-state.ts` (44)
- `apps/client/src/layers/features/settings/model/use-tunnel-machine.ts` (206)
- `apps/client/src/layers/features/settings/model/use-tunnel-actions.ts` (149)
- `apps/client/src/layers/features/settings/ui/RemoteAccessAction.tsx`
- `apps/client/src/layers/features/settings/ui/external-mcp/DuplicateToolWarning.tsx` (28)
- `apps/client/src/layers/features/settings/ui/external-mcp/EndpointRow.tsx` (23)
- `apps/client/src/layers/features/settings/ui/external-mcp/ApiKeySection.tsx` (125)
- `apps/client/src/layers/features/settings/ui/external-mcp/RateLimitSection.tsx` (75)
- `apps/client/src/layers/features/settings/ui/external-mcp/SetupInstructions.tsx` (90)
- `apps/client/src/layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx` (171 — new shell)
- `apps/client/src/layers/features/settings/ui/tabs/AppearanceTab.tsx` (90)
- `apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx` (108)
- `apps/client/src/layers/features/settings/ui/tabs/StatusBarTab.tsx` (50)
- `apps/client/src/layers/features/settings/ui/tools/ToolCountBadge.tsx` (26)
- `apps/client/src/layers/features/settings/ui/tools/SchedulerSettings.tsx` (85)
- `apps/client/src/layers/features/settings/ui/tools/ToolGroupRow.tsx` (115)
- `apps/client/src/layers/shared/ui/copy-button.tsx` (45 — promoted from features/settings)
- `apps/client/src/layers/shared/lib/use-copy-feedback.ts` (moved from features/settings/lib)

**Source files modified:**

- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — slimmed 491 → 177 lines, consumes the new tab components and `RemoteAccessAction`
- `apps/client/src/layers/features/settings/ui/ToolsTab.tsx` — slimmed 436 → 155 lines, moved Reset button in from SettingsDialog
- `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` — slimmed 490 → 241 lines, consumes `useTunnelMachine` + `useTunnelActions`
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx` — swapped local `useCopy` for shared `useCopyFeedback`
- `apps/client/src/layers/features/settings/ui/TunnelConnected.tsx` — `useCopyFeedback` import path updated
- `apps/client/src/layers/shared/lib/index.ts` — exports `useCopyFeedback`
- `apps/client/src/layers/shared/ui/index.ts` — exports `CopyButton`
- `apps/client/src/layers/features/settings/__tests__/ExternalMcpCard.test.tsx` — import path updated to `../ui/external-mcp/ExternalMcpCard`

**Source files deleted:**

- `apps/client/src/layers/features/settings/ui/ExternalMcpCard.tsx` (legacy 540-line top-level file — relocated into `external-mcp/`)
- `apps/client/src/layers/features/settings/lib/use-copy-feedback.ts` (relocated to `shared/lib/`)

**Test files moved:**

- `apps/client/src/layers/shared/lib/__tests__/use-copy-feedback.test.ts` (moved from `features/settings/__tests__/`)

## Verification Evidence

**Phase 5 full gate (task #32 / spec 5.1):**

- `pnpm typecheck`: `Tasks: 19 successful, 19 total` (exit 0)
- `pnpm test -- --run`: `Test Files 300 passed (300), Tests 3488 passed (3488)` (exit 0)
- `pnpm lint`: `Tasks: 15 successful, 15 total` (exit 0). 8 client warnings + 1 server warning, ALL pre-existing on main (verified by diffing against a stashed baseline). Zero new warnings introduced.

**Phase 5 file-size gate (task #33 / spec 5.2):**

- All 4 target files < 300 (largest: TunnelDialog at 241)
- All 16 new helper files < 300 (largest: use-tunnel-machine.ts at 206)

**Phase 5 manual smoke (task #34 / spec 5.3) — driven via chrome-devtools-mcp on http://localhost:6241:**

1. Appearance tab — PASS (theme cycle, Reset)
2. Preferences tab — PASS (toggles persist)
3. Status Bar tab — PASS (11 registry items, Reset)
4. Server tab — PASS (all config rows render)
5. Tools tab — PASS (Core count badge, Tasks toggle, scheduler expand)
6. Channels tab — PASS (catalog renders)
7. Agents tab — PASS (default agent + runtime cards)
8. Advanced tab — PASS (logging + danger zone)
9. Remote Access dialog — PASS (TunnelDialog opens to landing/setup view)
10. External MCP card — PASS (warning, endpoint, API key section, snippet tabs all render; rate limit toggle works)
11. Mobile viewport (375×812) — PASS (drill-in pattern works on every tab)
12. Deep-link — SKIPPED (Zustand store not exposed on `window`; pre-existing limitation, not a regression — see Known Issues)

## Known Issues

- **Pre-existing lint warning in `SettingsDialog.tsx`** — `react-hooks/set-state-in-effect` on the deep-link `useEffect`. The line number drifted from 122 to 47 because of the file split, but the warning predates this spec. Out of scope; baseline carries forward.
- **Pre-existing nested-`<button>` hydration warnings** in `AdapterRuntimeCard` and `AgentsTab` test output (Switch inside a wrapping button). Originated in commit 348e8e0a, unrelated to this spec. Tests pass.
- **Pre-existing Radix `aria-hidden` warning** when opening Settings on mobile after the Sheet sidebar is open. Stacking interaction in untouched primitives. Worth filing as a separate a11y issue.
- **Deep-link verification cannot be exercised externally** — `useAppStore.getState().openSettingsToTab(...)` is module-scoped to React. The action exists and is unit-tested, but no `window` global or URL search-param surface drives it from a fresh page. Two paths to make this externally testable: (a) expose the store in dev mode via `window.__dorkos`, or (b) implement spec `settings-dialog-03-url-deeplinks` (already in the planned-followons list).

## Implementation Notes

### Session 1

**Review approach pivot.** The user originally selected "Standard: two-stage review per task". After Batch 1 (12 tasks) completed, the orchestrator determined that running ~70+ review agents across the remaining 22 tasks would saturate main-context budget. The user approved a pivot to **holistic batch-level gates**: after each batch the orchestrator runs `pnpm typecheck` + `pnpm vitest run` on the touched test surface + `pnpm eslint` on touched directories, with spot-checks on the load-bearing slim/integration tasks (1.5, 2.11, 3.4, 4.5). The phase verification tasks (1.6, 2.14, 3.5, 4.6) and the Phase 5 gate (5.1, 5.2, 5.3) were the formal review gates. This caught the same class of regressions as per-task review (typecheck breaks, lint warnings, test failures) while consuming a fraction of the agent budget.

**No regressions detected at any point.** Across 11 batches, every holistic gate passed on first run. Two task-level minor concerns surfaced: (1) Prettier whitespace reformatting in `DuplicateToolWarning.tsx` produced byte-different but render-identical source; (2) Task #5 ended without a final task report due to an agent turn limit, but the on-disk state was already correct and verified by direct inspection.

**Cross-phase dependency was load-bearing.** Phase 1 task #5 ("Slim ToolsTab") was responsible for moving the Tools "Reset to defaults" button OUT of `SettingsDialog.tsx:411-433` and INTO `ToolsTab.tsx`, atomically with the slim. This dependency was critical: Phase 4's slim of `SettingsDialog.tsx` (task #30) depended on Phase 1 having already removed that block, otherwise the panel would have double-rendered the Tools header during the gap between phases. The dependency was correctly captured at decompose time (task 4.5 blockedBy: 1.5) and the agent prompts called it out explicitly.

**Parallelism efficiency.** Sequential equivalent: 34 tasks. Compressed into 11 batches with max 12 parallel agents in Batch 1. Effective speedup: ~3x. The longest critical path was the Phase 2 chain (2.1 → 2.2 → 2.3 → 2.10 → 2.11 → 2.12 → 2.13 → 2.14), which gated the final Phase 5 gate.

**Architecture validation.** The new directory structure follows FSD strictly:

- `config/` (pure data) — `tool-inventory.ts`
- `lib/` (pure utilities) — `external-mcp-snippets.ts`
- `model/` (hooks/state) — three tunnel files
- `ui/` (presentation) — tabs, tools, external-mcp subdirectories
- `shared/lib/` and `shared/ui/` — promoted `useCopyFeedback` and `CopyButton`

The promotion from `features/settings/lib` → `shared/lib` (for `useCopyFeedback`) was forced by FSD rules: the new `shared/ui/copy-button.tsx` cannot legally import from `features/`. This was anticipated by the spec's §6.3 decision and executed cleanly.
