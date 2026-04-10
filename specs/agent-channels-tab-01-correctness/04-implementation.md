# Implementation Summary: Agent Dialog → Channels Tab — Correctness & Architecture Cleanup (01 of 03)

**Created:** 2026-04-10
**Last Updated:** 2026-04-10
**Spec:** specs/agent-channels-tab-01-correctness/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 7 / 7

## Tasks Completed

### Session 1 - 2026-04-10

- Task #1: Create useExternalAdapterCatalog shared hook and ADAPTER_CATEGORY_INTERNAL constant
- Task #2: Add unit tests for useExternalAdapterCatalog hook
- Task #3: Migrate Settings ChannelsTab to use shared useExternalAdapterCatalog hook
- Task #4: Refactor ChannelPicker to accept catalog and setup callback as props
- Task #5: Rewrite agent-settings ChannelsTab with shared hook, memoized Map, collapsed accessors, and inline wizard
- Task #6: Update ChannelsTab test suite for new hook, inline wizard, and removed cross-dialog flow
- Task #7: Run full typecheck, lint, and client test suite

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/entities/relay/model/use-external-adapter-catalog.ts` (new) — shared hook filtering `category: 'internal'` adapters
- `apps/client/src/layers/entities/relay/index.ts` — barrel export for new hook and constant
- `apps/client/src/layers/features/settings/ui/ChannelsTab.tsx` — migrated to `useExternalAdapterCatalog`, removed inline filter
- `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx` — refactored to presentation component with `catalog` and `onRequestSetup` props
- `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx` — rewritten with shared hook, memoized Map, single `resolveAdapterDisplay`, inline `AdapterSetupWizard`

**Test files:**

- `apps/client/src/layers/entities/relay/model/__tests__/use-external-adapter-catalog.test.tsx` (new) — 4 tests for filter, stability, disabled, constant
- `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx` — updated mocks, added 3 new tests (internal filter, inline wizard, no cross-dialog nav)
- `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelPicker.test.tsx` — updated for new props interface
- `apps/client/src/layers/features/settings/__tests__/ChannelsTab.test.tsx` — updated mock for shared hook

## Known Issues

_(None)_

## Implementation Notes

### Session 1

All 7 tasks completed in a single session. Both core bugs are fixed:

1. **Claude Code adapter in channel picker** — Fixed by `useExternalAdapterCatalog` shared hook filtering `category: 'internal'` entries. Both Settings and agent-settings ChannelsTab use this hook.

2. **Context loss on "Set up a new channel"** — Fixed by rendering `AdapterSetupWizard` inline within the agent-settings ChannelsTab instead of closing the AgentDialog and navigating to Settings. Cross-dialog navigation code (`useAgentDialogDeepLink`, `useSettingsDeepLink`) removed entirely.

**Verification:** Typecheck 0 errors, lint 0 errors, 3742/3742 tests passing across 323 test files.
