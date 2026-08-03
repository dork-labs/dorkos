# Implementation Summary: Runtimes settings redesign — per-runtime cards, default as a state, runtime-declared settings

**Created:** 2026-08-03
**Last Updated:** 2026-08-03
**Spec:** specs/runtimes-settings-redesign/02-specification.md

## Session

- **Worktree:** `~/.dork/workspaces/dorkos/dor-888-runtimes-declaration` (branch `dor-888-runtimes-declaration`, PR 1 / P1 declaration layer)
- **Tracker:** DOR-888
- **Orchestration:** main-session orchestrator + resumable Opus/Sonnet implementation agents; batch-level verification gates (standing operator preference) + adversarial REVIEW.md review before each PR

## Progress

**Status:** In Progress
**Tasks Completed:** 9 / 25

## Tasks Completed

### Session 1 - 2026-08-03

- Task 1.1: Add RuntimeSettingsCapability to the shared runtime interface (requiredness pinned via @ts-expect-error, proven failure-capable)
- Task 1.2: Declare settings capabilities in all four runtime adapters (wire projection pinned for claude-code + test-mode)
- Task 1.3: Sweep every RuntimeCapabilities fixture (17 client + 1 test-utils fixes; FakeAgentRuntime gained a `settings` override lever: `FakeAgentRuntimeOptions` + `DEFAULT_FAKE_SETTINGS`; playground transport carries the three real declarations)
- Task 1.4: Conformance settings assertions via exported `@internal` `validateSettingsCapability(settings): string[]` + standalone 9-case prove-it-can-fail test; seeded-defect red run recorded (opencode `configSection: ''` failed its conformance spec with the exact new message)
- Task 1.5: `settings` added to `RuntimeCapabilitiesSchema` (openapi-registry.ts) + `docs/api/openapi.json` regenerated via `pnpm docs:export-api`; second regen md5-identical. PR-body note: the schema deliberately documents a subset (already omits commandIntents/nativeContext/logBackedHistory); settings is included because the tab is a client contract
- Task 1.6: `describeExecutionDefaults(capabilities, runtimes?)` capability-driven; `CONFIG_SECTION_BY_RUNTIME` deleted; `isRuntimesConfigSection` guard; caller injection at routes/config.ts (cycle avoided). DEVIATION (deliberate, pinned by test): `resolveSessionDefaults` also read the map — it now takes `configSection?: string | null` opt; an UNREGISTERED runtime no longer seeds its config section by name. Fixture repairs in runtime-registry.test.ts + room-turn-runner.test.ts (cast-free doubles 1.3 could not see)
- Task 1.7: server free of `runtimeSupportsEffort` — `resolveSessionDefaults` takes `supportsEffort?: boolean` (omitted → true, permissive), overlay routes the answer through a widened `SessionSettingsOverlayPort.get` returning narrow `getCapabilities`; prove-it-can-fail: hardcoding the gate red 7 tests
- Task 1.9: `settingsForRuntime` selector in entities/runtime; `configSectionForRuntime`/runtime-config-section.ts deleted; both consumers re-pointed; capability-map-not-loaded case falls back to the global trust leaf (tested + commented). NOTE for P2: shared `createMockTransport().getCapabilities()` registers only claude-code — add codex/opencode there, then delete the local override in ExecutionDefaultsCard.test.tsx
- Task 1.10: adding-a-runtime.md documents `settings` (three-part RuntimeCapabilities section, field table, renderer + static/dynamic paragraphs, real claude-code example)

## Files Modified/Created

**Source files:**

_(None yet)_

**Test files:**

_(None yet)_

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

_(Implementation in progress)_
