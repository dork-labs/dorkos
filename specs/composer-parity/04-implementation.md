# Implementation Summary: Composer parity: unify the chat and room composers

**Created:** 2026-08-07
**Last Updated:** 2026-08-07
**Spec:** specs/composer-parity/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 8 / 12

## Tasks Completed

### Session 1 - 2026-08-07

**Workers:** phase1-finisher (a4a4a8a5cdae2e81d, opus), dom-harness W2 (ad288e81a0aa26c02, opus), analysis (aa4fd6ee6803fb066, opus). Tasks 1.1–1.3 were built by an earlier, unnamed session that died uncommitted — worker: unknown; its work was verified (typecheck green, 223 tests green) and adopted as ground truth.

- Task 1.1: Move the composer core files into features/composer — worker: unknown (dead prior session; verified + adopted)
- Task 1.2: Write the features/composer barrel + capability-matrix TSDoc — worker: unknown (dead prior session; verified + adopted)
- Task 1.3: Migrate every ChatInput consumer and test mock — worker: unknown (dead prior session; verified + adopted)
- Task 1.4: Phase-1 gate — worker: phase1-finisher (a4a4a8a5cdae2e81d, opus). Committed as `79e72761f` (one commit, phase 1 complete). All gates green: typecheck, lint (0 errors), 169 composer tests, 88 consumer tests, 313 room-view tests, full client suite 9312 tests, dead-path greps empty, use-input-keyboard.ts pure R100. Two compiler-forced deviations verified: `ComposerInputProps` export (TS4023 without it), OverlayLane absent from barrel until 2.2. `git log --follow` on ComposerInput.tsx needs `-M40%` (prettier reflow from longer name). The auto-generated changelog fragment `260807-214409` is a placeholder describing an internal move — task 3.3 replaces it with the real user-facing fragment.

- Task 2.2 + 2.1: Composer.OverlayLane and Composer.Root — worker: phase1-finisher (a4a4a8a5cdae2e81d, opus), continuing as phase-2 W1. Committed as `1bfee3d3a` (P2-1, additive: nothing renders the new parts yet). Built 2.2 first so its barrel edit cleared before 2.1 touched the same file. Gates: typecheck green, lint 0 errors / 112 warnings (unchanged from phase 1, so the new files add none), composer slice 5 files / 180 tests. Both new tests were mutation-checked: forcing the drop-capable branch fails the no-dropzone test, and reversing the `cn()` merge order fails the caller-override test. D8 honored — `.chat-input-container` is never baked into Root and reaches the element only via the caller's `className`, pinned by a test that the non-Tailwind token survives the merge.
- Task 2.3 + 2.4: ChatInputContainer composes Composer.Root and OverlayLane, chat parity flipped — worker: phase1-finisher (a4a4a8a5cdae2e81d, opus), as phase-2 W1. Committed as `2bb9a4c15` (P2-2). Container 411 → 384 lines. All 5 DOM-parity states diff EMPTY against the baselines committed in `247ac851a`; no baseline re-recorded. Mutation-checked: dropping `className="chat-input-container"` reds all five with exactly `class token "chat-input-container" removed`. The ScanLine-vs-overlay ordering delta stayed unreachable in all five states, as task 2.3 predicted.
- Task 2.5: the dashboard hero adopts Composer.Root — worker: same. Committed as P2-3. Wrapped with NO `onFilesDropped`. Parity assertion written positively (section unchanged; child 1 is a `div` carrying exactly Root's chrome; its single child diffs empty against the old subtree) rather than by counting diff entries, because the differ walks children positionally and an inserted wrapper reports as a cascade at that index. Mutation-checked: wiring `onFilesDropped` reds both cases (`role: 'presentation'` appears, and a file input mounts).
- Phase-1 review fixes — worker: same. Committed as the follow-up to `1bfee3d3a`. Replaced two deep imports into slice internals (`ChatInputContainer.test.tsx`, `ChatPanel.test.tsx`) with the `vi.importActual` pattern on the barrel; split the `@module` TSDoc to lead the file with a short TSDoc left on `Composer`; added TSDoc to `ComposerInput`.

## Files Modified/Created

**Source files:**

- apps/client/src/layers/features/composer/ (new slice: index.ts, ui/ComposerInput.tsx, ui/ComposerAttachments.tsx, ui/ClearArmedHint.tsx, ui/InputActionButton.tsx, ui/use-input-keyboard.ts (pure rename, 0-line diff), ui/use-textarea-resize.ts, model/pending-file.ts)
- Consumers migrated: ChatInputContainer.tsx, ChatPanel.tsx, use-chat-queue.ts, OnboardingConversation.tsx, DashboardComposerSection.tsx, RoomComposer.tsx, dev/showcases/InputShowcases.tsx, dev/sections/chat-sections.ts
- Deviation (reviewed): PendingFile type extracted from features/chat/model/use-file-upload.ts into composer/model/pending-file.ts (FSD cross-feature type requirement the frozen task text missed); import repoints in chat-input-container-types.ts, dev/mock-factories.ts, dev/mock-samples.ts

**Test files:**

- Moved: ComposerInput.test.tsx, ComposerAttachments.test.tsx, InputActionButton-dimmed.test.tsx (import/identifier changes only)
- Mock repoints: ChatInputContainer.test.tsx, ChatPanel.test.tsx, upload-wedge-recovery.test.tsx, use-chat-queue.test.ts, OnboardingConversation.test.tsx, onboarding-skip.test.tsx, DashboardComposerSection.test.tsx, RoomComposer.test.tsx, PlaygroundSearch.test.tsx, use-input-autocomplete.test.ts

## Known Issues

- **NEEDS A BROWSER CHECK before the PR — the dashboard hero's `m-2`.** Task 2.5 flagged that `Composer.Root`'s chrome includes `m-2`, which the hero did not have, and said to pass `className="m-0"` if it double-spaces. It was wrapped WITHOUT an override (the task's primary instruction, and what the parity assertion is written against), but the arithmetic says there is a real misalignment to look at: `DashboardPage` already pads the column (`mx-auto max-w-4xl px-4 py-6`), the `<h2>` sits flush at the section's left edge, and `m-2` insets the card 8px from it — so the heading and the composer below it are no longer left-aligned, and the gap under the heading becomes `mb-3` + 8px. Whoever does the visual pass decides: if it reads wrong, the fix is one line, `<Composer.Root className="m-0">`, and the parity test's `ROOT_CHROME` constant swaps `m-2` for `m-0`. Root's default must NOT be weakened — chat is the reference chrome.
- **`247ac851a` did not typecheck** (fixed in `2bb9a4c15`). Its `ChatInputContainer-dom-parity.test.tsx` imported `PendingFile` from `../model/use-file-upload`, which stopped exporting it when phase 1 moved the type into the composer slice. All 35 of its tests were green anyway, because vitest strips types without checking them — a red `tsc` sat underneath a green suite. Worth remembering for the remaining harness work: a green vitest run is not evidence that the branch typechecks.

- **Recorded deviation — the phase-1 commit message is wrong about playground ids.** Commit `79e72761f` claims the Dev Playground registry entries "keep the `id` values stable so deep links survive". They did not stay stable and could not: `apps/client/src/dev/sections/chat-sections.ts` now carries `id: 'composer-input'` and `id: 'composer-attachments'` (was `chatinput` / `filechipbar`). The registry enforces `section.id === slugify(section.title)` — emitted by `PlaygroundSection.tsx:14` and asserted by `playground-registry.test.ts:81` — so retitling to `Composer.Input` / `Composer.Attachments` forces the id to follow. Task 1.3's instruction to keep ids stable was unsatisfiable alongside its own retitle instruction. The change is correct; the commit message's claim about it is not. History is deliberately NOT rewritten — this note is the correction, and the two old `#chatinput` / `#filechipbar` deep links are broken (dev-only surface, no user impact).
- **Flagged for the PR description, NOT to be changed unilaterally — the capability matrix's Dashboard column is wrong.** The matrix in `composer/index.ts`'s module TSDoc marks Queue-while-busy, Prompt suggestions, and Interactive input panel as `yes` for Dashboard, which contradicts what `DashboardComposerSection` actually composes. Under the slice's own doctrine (composition IS the capability declaration), a matrix that disagrees with the composition is exactly the parallel declaration the doctrine warns about. The matrix text was frozen verbatim by the spec (task 1.2 requires it verbatim), so it stays as-is until the spec owner rules on it. Raise it in the PR description.

- Spec-freeze PR #847 (docs/dor-946-composer-parity-spec) landing via auto-merge; until it merges, 02-specification.md / 03-tasks.json are readable only from the dor-946-spec worktree. Merge origin/main into this branch after it lands.
- Analysis drift report (Session 1): task text missed the ChatPanel.test.tsx ChatInput mock (D1), undercounted ChatInputContainer.test.tsx mocks (D2), 2.3's "import-path changes only" claim is wrong — the barrel mock needs Root/OverlayLane keys (D3), rename sites beyond named lines (D5), 3.3's dead-path sweep hits contributing/keyboard-shortcuts.md + project-structure.md — fix project-structure.md:74, NOT design-system.md; never touch docs/changelog-archive.mdx (D6/D7), `.chat-input-container` carries a safe-area inset rule in index.css ~1605 — chat-only, must ride Root's className pass-through, never baked into Root (D8).

## Implementation Notes

### Session 1

Orchestration: session 5caf87b1-5dd5-420a-aab2-7dd611e6d2d6 on dc-mbp-m4-2.lan. Worktree: /Users/doriancollier/.dork/workspaces/dorkos/composer-parity (branch composer-parity). Parallel harness worktree: /Users/doriancollier/.dork/workspaces/dorkos/composer-parity-harness (branch composer-parity-harness) building the DOM-parity harness + all three pre-migration baselines against origin/main @ 6141f2747 (valid because phase 1 is zero-DOM-change); its commit gets grafted onto this branch as the first phase-2 commit (P2-0).

Phase-2/3 commit plan (from the analysis agent): P2-0 harness+baselines → P2-1 Root+OverlayLane (2.2 before 2.1, additive) → P2-2 ChatInputContainer migration + chat parity assertion flip (empty diff) → P2-3 dashboard wrap (diff = exactly one wrapper div) → P3-1 RoomComposer migration + chrome-delta flip (diff = exactly root class swap + lane inset swap) → P3-2 docs/playground/changelog/full gate. Adversarial REVIEW.md review before any PR.
