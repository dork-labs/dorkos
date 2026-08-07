# Implementation Summary: Composer parity: unify the chat and room composers

**Created:** 2026-08-07
**Last Updated:** 2026-08-07
**Spec:** specs/composer-parity/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 4 / 12

## Tasks Completed

### Session 1 - 2026-08-07

**Workers:** phase1-finisher (a4a4a8a5cdae2e81d, opus), dom-harness W2 (ad288e81a0aa26c02, opus), analysis (aa4fd6ee6803fb066, opus). Tasks 1.1–1.3 were built by an earlier, unnamed session that died uncommitted — worker: unknown; its work was verified (typecheck green, 223 tests green) and adopted as ground truth.

- Task 1.1: Move the composer core files into features/composer — worker: unknown (dead prior session; verified + adopted)
- Task 1.2: Write the features/composer barrel + capability-matrix TSDoc — worker: unknown (dead prior session; verified + adopted)
- Task 1.3: Migrate every ChatInput consumer and test mock — worker: unknown (dead prior session; verified + adopted)
- Task 1.4: Phase-1 gate — worker: phase1-finisher (a4a4a8a5cdae2e81d, opus). Committed as `79e72761f` (one commit, phase 1 complete). All gates green: typecheck, lint (0 errors), 169 composer tests, 88 consumer tests, 313 room-view tests, full client suite 9312 tests, dead-path greps empty, use-input-keyboard.ts pure R100. Two compiler-forced deviations verified: `ComposerInputProps` export (TS4023 without it), OverlayLane absent from barrel until 2.2. `git log --follow` on ComposerInput.tsx needs `-M40%` (prettier reflow from longer name). The auto-generated changelog fragment `260807-214409` is a placeholder describing an internal move — task 3.3 replaces it with the real user-facing fragment.

## Files Modified/Created

**Source files:**

- apps/client/src/layers/features/composer/ (new slice: index.ts, ui/ComposerInput.tsx, ui/ComposerAttachments.tsx, ui/ClearArmedHint.tsx, ui/InputActionButton.tsx, ui/use-input-keyboard.ts (pure rename, 0-line diff), ui/use-textarea-resize.ts, model/pending-file.ts)
- Consumers migrated: ChatInputContainer.tsx, ChatPanel.tsx, use-chat-queue.ts, OnboardingConversation.tsx, DashboardComposerSection.tsx, RoomComposer.tsx, dev/showcases/InputShowcases.tsx, dev/sections/chat-sections.ts
- Deviation (reviewed): PendingFile type extracted from features/chat/model/use-file-upload.ts into composer/model/pending-file.ts (FSD cross-feature type requirement the frozen task text missed); import repoints in chat-input-container-types.ts, dev/mock-factories.ts, dev/mock-samples.ts

**Test files:**

- Moved: ComposerInput.test.tsx, ComposerAttachments.test.tsx, InputActionButton-dimmed.test.tsx (import/identifier changes only)
- Mock repoints: ChatInputContainer.test.tsx, ChatPanel.test.tsx, upload-wedge-recovery.test.tsx, use-chat-queue.test.ts, OnboardingConversation.test.tsx, onboarding-skip.test.tsx, DashboardComposerSection.test.tsx, RoomComposer.test.tsx, PlaygroundSearch.test.tsx, use-input-autocomplete.test.ts

## Known Issues

- Spec-freeze PR #847 (docs/dor-946-composer-parity-spec) landing via auto-merge; until it merges, 02-specification.md / 03-tasks.json are readable only from the dor-946-spec worktree. Merge origin/main into this branch after it lands.
- Analysis drift report (Session 1): task text missed the ChatPanel.test.tsx ChatInput mock (D1), undercounted ChatInputContainer.test.tsx mocks (D2), 2.3's "import-path changes only" claim is wrong — the barrel mock needs Root/OverlayLane keys (D3), rename sites beyond named lines (D5), 3.3's dead-path sweep hits contributing/keyboard-shortcuts.md + project-structure.md — fix project-structure.md:74, NOT design-system.md; never touch docs/changelog-archive.mdx (D6/D7), `.chat-input-container` carries a safe-area inset rule in index.css ~1605 — chat-only, must ride Root's className pass-through, never baked into Root (D8).

## Implementation Notes

### Session 1

Orchestration: session 5caf87b1-5dd5-420a-aab2-7dd611e6d2d6 on dc-mbp-m4-2.lan. Worktree: /Users/doriancollier/.dork/workspaces/dorkos/composer-parity (branch composer-parity). Parallel harness worktree: /Users/doriancollier/.dork/workspaces/dorkos/composer-parity-harness (branch composer-parity-harness) building the DOM-parity harness + all three pre-migration baselines against origin/main @ 6141f2747 (valid because phase 1 is zero-DOM-change); its commit gets grafted onto this branch as the first phase-2 commit (P2-0).

Phase-2/3 commit plan (from the analysis agent): P2-0 harness+baselines → P2-1 Root+OverlayLane (2.2 before 2.1, additive) → P2-2 ChatInputContainer migration + chat parity assertion flip (empty diff) → P2-3 dashboard wrap (diff = exactly one wrapper div) → P3-1 RoomComposer migration + chrome-delta flip (diff = exactly root class swap + lane inset swap) → P3-2 docs/playground/changelog/full gate. Adversarial REVIEW.md review before any PR.
