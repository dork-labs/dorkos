# Blintz markdown polish tasks

Canonical decomposition: `03-tasks.json`. Tracker: DOR-2038. Progress uses the Task API vocabulary (`completed`, `in_progress`, `pending`); the installed flow JSON schema does not define progress fields, so the canonical JSON carries only its supported decomposition fields. This execution projection is backed by `04-implementation.md` and the flow runtime trail.

Implementation and verification tasks are completed. Task 3.2 remains in progress for exact pushed host review, PR CI, DorkOS merge and cleanup. Actual final closure will be recorded in the tracker after those gates; this artifact does not claim closure.

### Task 1.1: [blintz-editor-polish] [P1] Consolidate scoped prose, semantic lists and live theme variables

In Blintz remove Nord imports/setup and fixed One Dark styling; own typography within the editor boundary. Use inherited documented variables while preserving --crepe compatibility. Make list node-view hosts li elements, suppress duplicate native markers, align markers to the first text baseline and define tight/nested/loose spacing. Preserve ordered starts. Replace code surface/text/syntax colors with live variables. Acceptance: semantic tests pass and browser computed styles show exactly one marker, valid list DOM and correct nearest host light/dark colors, including OS mismatch.

Dependencies: none. Status: completed.

### Task 1.2: [blintz-editor-polish] [P1] Repair content fidelity and accessible node views

In Blintz preserve inline hard breaks while removing only intended standalone legacy empty-paragraph artifacts. Make task checkboxes keyboard operable with meaningful names/state. Add accessible table labels and focus/touch access to hover controls. Contain wide tables in a positioned scrolling wrapper. Read-only images must use static captions and omit editing controls. Acceptance: parsing/roundtrip tests, keyboard tasks, read-only image checks and narrow browser overflow tests pass.

Dependencies: none. Status: completed.

### Task 2.1: [blintz-editor-polish] [P2] Bridge DorkOS semantic tokens and expose the real editor playground

In DorkOS map semantic HSL colors and fonts at the shared BlintzCanvas boundary without remounting on theme change. Add /dev/markdown with real reading/editing/source/narrow/empty fixtures and prescribed route/navigation registration. Add browser coverage for light/dark, both opposite OS schemes, live theme roundtrip without content/selection/undo loss, prose/code/syntax/control colors, list geometry and table containment. All existing session/file/room consumers remain on the shared wrapper.

Dependencies: 1.1. Status: completed.

### Task 2.2: [blintz-editor-polish] [P2] Build the standalone visual regression laboratory

Evolve Blintz bakeoff into a deterministic standalone Markdown specimen and editing lab with explicit theme controls, read-only and editable cases, narrow/mobile layout and comparison views where useful. Add Playwright browser setup, representative screenshot baselines and computed semantic/style assertions. Cover the full Markdown grammar, list DOM/markers, task keyboard actions, source editing, hardbreak fidelity, theme instance/content/selection/undo preservation and wide tables. Add CI and document test/baseline-review commands.

Dependencies: 1.1, 1.2. Status: completed.

### Task 2.3: [blintz-editor-polish] [P2] Review and update the editor dependency graph

Review current compatible dependencies in Blintz, remove packages made obsolete by the new styling, update justified versions and the lockfile, and verify build/typecheck/tests. Record meaningful compatibility findings. DorkOS consumes a released Blintz package before final validation; no committed file paths or temporary local package links are allowed.

Dependencies: none. Status: completed.

### Task 3.1: [blintz-editor-polish] [P3] Complete visual and behavioral acceptance in both applications

Run the complete specimen in light and dark modes at desktop and narrow/mobile sizes, including both OS/host mismatch permutations. Inspect screenshots directly and test computed typography/colors, list spacing/markers, code surfaces/syntax, table overflow and interactive controls. Verify theme changes retain editor identity, Markdown, selection and undo. Iterate all observed defects within this scope; save verification commands/results and visual evidence. Run the required repository checks against final changes.

Dependencies: 2.1, 2.2, 2.3. Status: completed.

### Task 3.2: [blintz-editor-polish] [P3] Review, merge and close both repositories cleanly

Obtain independent adversarial review of both final branches before opening their PRs, fix findings, run required gates, open clear evidence-backed PRs and merge only after green checks. Land/release Blintz before final DorkOS dependency verification. Finish any relevant followups, mark DOR-2038 done with evidence and agent/completed, ensure both task worktrees have no uncommitted or unpushed work, then remove them. Do not touch unrelated worktrees.

Dependencies: 3.1. Status: in_progress.
