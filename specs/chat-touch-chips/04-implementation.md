# Implementation Record — chat-touch-chips

**Merged:** 2026-08-01, main `b9625af05` (PR #694); spec/design artifacts merged earlier as PR #690 (`2a206d108`). Tracker: DOR-817. Autonomous /flow run (SPECIFY → DONE) pre-approved by Dorian, orchestrated with delegated phase agents in the `feat/chat-touch-chips` worktree.

## What shipped

Per-turn touch-chip strip in the chat transcript: deduplicated chips for every file/URL/command a turn handled, verb-specific live animations (scan/beam/scribble/pen/swallow/ping/cursor), pile absorption with count badge, settled summary line with filterable bounded tray (grouped ⇄ chronological), canvas click-through, read→edit in-place upgrade morph, reduced-motion opacity-only fallbacks, plus the app-wide `animate-tasks` keyframe fix. Dev playground: six Chips showcase sections; simulator: "Touch Chips" bursty scenario. All client-side (`apps/client/src/layers/features/chat/{lib,ui/chips}`) per ADR 260801-141804 — no server or schema changes.

## Deviations from the spec worth knowing

- Dedup keys are namespaced by target space (`file:`/`url:`/`run:`/`grep:`/`websearch:`); relative and absolute paths alias-merge (absolute wins the label and canvas target).
- Diffstat comes from Edit inputs' line counts (`parseEditInput` precedent) — the spec's `structuredPatch` never existed. Write-created files carry additions; overwrites carry none.
- The virtualizer needed no re-measure plumbing (MessageList's `measureElement` ResizeObserver already covers subtree growth); the strip pays a boundedness contract instead.
- Live layout is gated on the turn's streaming state, not instantaneous tool liveness (the adversarial review measured an 11–28×/turn unmount strobe in the naive version).
- Upgrade-pulse acknowledgement lives in a strip-level ledger so the morph survives chip remounts (window churn re-mounts chips; per-chip mount state never fires in production).

## Verification

710 test files / 8416 client tests green; 143 chip-specific tests, mutation-hardened (7/8 targeted mutations red correctly). Three-reviewer adversarial pass per REVIEW.md found 7 blockers (strobe, inert morph, path dedup, heredoc fake tombstones, clickable rm-globs, reduced-motion parked bands, double magnifier) — all fixed and re-verified with MutationObserver browser evidence: exactly one live→settled transition per turn, one real upgrade pulse, zero console errors, a11y tree verified in Chromium.

## Known residuals (filed as follow-ups on DOR-817 close)

- Tray-open state resets when the in-progress turn id swaps at turn end.
- `.animate-tasks` elements are permanently "unstable" to Playwright's actionability checker (no current test targets one).
- Canvas click-through validated to dispatch correctly, but the playground renders no canvas; end-to-end canvas open unverified in the real cockpit.
- Non-openable chips (commands, globs, searches) are focusable buttons with no action — kept for tooltip/AT reachability; revisit if tab-stop noise bothers keyboard users.
