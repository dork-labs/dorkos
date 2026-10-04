# Implementation: Back, forward and history for each desktop tab

**Spec:** `specs/desktop-tab-history/02-specification.md`
**Work item:** DOR-2107
**Worktree:** `dorkos-worktrees/dor-2107-tab-history`, branch `dor-2107-tab-history`, base `67511dad1`

### Session 1 - 2026-10-04

**Workers:** one Opus implementer (tasks 1.1-1.4 and both review-fix rounds), one Opus reviewer (two passes). Task 1.5 (changelog, docs, desktop drive) done by the orchestrator.

- Task #1.1: per-tab history stack in the tab store — done
- Task #1.2: record replaces; back/forward/jump actions — done
- Task #1.3: Back, Forward, History controls in the desktop header — done
- Task #1.4: keys and mouse side buttons — done
- Task #1.5: changelog, docs, real desktop drive — done

**Deviations from the spec (reviewed):**

- `goToActiveTab` re-syncs with `replace: true`, guarded to the same tab at the same href, so a loader redirect to the current location never adds an entry or wipes Forward.
- Opening or closing a modal dialog (`?settings=`, `?tasks=` …) rewrites the current entry instead of adding one. Profile chains (`profile`, `profilePage`) keep their own pushes so Back walks them.
- Identical neighbouring entries are collapsed, so Back and Forward always change the page.
- A router traversal onto the entry before or after the cursor moves the cursor instead of pushing.
- Keys and mouse buttons are ignored during IME composition and while a dialog or menu is open.

**Review:** an independent adversarial review found 6 issues on pass 1 (no blockers) and 1 should-fix on pass 2; all fixed with tests that fail without the fix. Final pass: ready, no blockers.

**Proof:** driven in the real Electron desktop app (dev build from this worktree, isolated data dir): clicks build a per-tab stack, `Cmd+[` / `Cmd+]`, the Back/Forward buttons, mouse button 4, the History menu jump, and a second tab with its own separate stack all behaved as specified.
