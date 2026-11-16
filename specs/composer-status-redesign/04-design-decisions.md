# Design Decisions — Composer + Status Bar Redesign

Visual companion session: `.dork/visual-companion/99756-1784931237/`
Work item: DOR-452

## 1. Composer footer direction

**Screen:** `composer-chrome.html`
**Options:** A) Quiet by default — items promote only when actionable/anomalous. B) One line — merge the chips row and status row, identity left / state right. C) Ambient health strip — a 2px gauge replaces the number list.
**Chosen:** **A + B combined.** Quiet items on one merged line. C rejected as too ambiguous (a colored bar cannot say _which_ thing is wrong, and it needs hover, which mobile lacks).

**Audit that drove it:** the resting footer showed 14 elements across up to 5 stacked rows, backed by 10 preference toggles, a configure popover, per-item right-click hide, and reset-to-defaults. The read: a preferences panel is an admission of a decision that wasn't made; a number that is always 34% is wallpaper, so the 91% that matters doesn't register either.

**Explicitly preserved (the "soul" list):** the `ScanLine` tinted to the agent's own color, the rotating inference verbs, the morphing status strip that collapses to zero height, and shell-history-style `↑` navigation through the message queue.

## 2. Where the reveal lives

**Screen:** `reveal-panel.html`
**Options:** A) Popover on the `⋯`, absorbing the configure panel. B) Unfold in place — the line expands downward into a grid. C) Popover for humans + a right-panel Session tab for debugging.
**Chosen:** **A.** The popover absorbs `StatusBarConfigurePopover` entirely rather than sitting beside it — one surface answering both "what is everything doing?" and "what do I want pinned?". C's right-panel tab is deferred to keep scope honest; the popover carries the diagnostics rows and Copy diagnostics, which covers the debugging need.

**Revisited in DOR-460 — C shipped too, and A stayed.** Deferring the tab was right for scope but wrong on the merits: a popover closes when focus returns to the composer, so it cannot serve someone watching a stuck stream, and forcing both audiences into one container makes it wrong for one of them. The tab is now the roomier readout (full cwd, resolved model id **and** the selected option, stream cursors, time since the last event, cache split, context breakdown, live subagents); the popover stays the two-second peek with the pins. The constraint that keeps them honest is one shared `useSessionDiagnostics` — a second, independent read would have been a bug waiting to happen, and getting there required moving `useSessionStatus`'s optimistic overrides out of component state into a per-session store. Pinning was deliberately **not** duplicated into the tab: pins promote an item into the line, and the feedback for that lives beside the line.

**Pins replace toggles.** Any row can be pinned to override its promotion rule. One verb that means something, versus ten booleans that only ever subtract.

## 3. Alignment

**Screen:** `alignment-final.html`
**Decision:** strict two-cluster. **Left** = who and where (agent identity · directory · git, plus the strip's prose). **Right** = state and numbers (context · usage · connection · model · `⋯`). One flexible gap; **no separator ever touches that gap** — a middot floating in whitespace is what reads as "centered". Identical at every breakpoint.

**This exposed a shipped bug:** seven `justify-center … md:justify-start` / `sm:justify-start` flips mean identical content is centered on phone and left-aligned on desktop. Worst on `StreamingContent`, which centers _and_ animates the verb container width — so on mobile the icon slides left while the elapsed time slides right, and the row breathes in and out on every verb rotation.

## 4. Mobile overflow

**Screen:** `mobile-overflow.html`
**Problem:** a 375px viewport leaves ~343px of bar. A realistic degraded state (agent, cwd, dirty git, reconnecting, context 78%, plan mode, Codex runtime, model, `⋯`) needs ~568px — 166% over. The inversion: every promotion rule fires under stress, which is exactly when the user is on their phone trying to find out what broke.

**Chosen:** a **measured budget** — never scroll, never wrap. Fill the right cluster by severity until the budget runs out; the remainder becomes a `+N` count on `⋯`. Measurement via `ResizeObserver` on the bar container, **not** `useIsMobile()` (a single 768px boolean that cannot see zoom, Dynamic Type, or the sidebar opening).

**Decided by the operator's delegation:** Tier C budget = **3**. The top two slots are usually genuine problems and the third gives them context; two felt artificially scarce when three fit. Budgets degrade to 2 naturally on narrower screens because the measurement is real.

**Invariant:** `⋯` is `shrink-0`, always last, always ≥44px, never droppable. Nothing is ever lost — only one tap away.

**Consequence:** the mobile problem deletes the mobile feature. Capping the bar at one line of ≤3 items leaves nothing to collapse, so the entire drag-to-collapse apparatus goes — and with it a gesture conflict (`touch-action: pan-y` on an ancestor blocks the inner `overflow-x-auto`, making overflowed items **unreachable today**).

## 5. Shortcut chips

**Decision (operator):** delete `ShortcutChips` entirely; teach `/` and `@` through the placeholder hints instead.
**Rationale:** the duplication is literal — `placeholder-hints.json` already contains _"Type @ to mention a file"_ and _"Type / to browse commands"_. Two permanent surfaces, one lesson. It also dissolves the retirement-counter question: the placeholder only appears when the composer is empty and idle, so it teaches exactly when there's nothing better to look at and vanishes the moment you type.
**Moved, not deleted:** `AgentIdentity` and its `AgentChipContextMenu` relocate to the status line's left cluster.

## 6. Newline escape

**Screen:** `newline-escape.html`
**Requested as:** `/` + Enter. **Built as:** `\` + Enter.
**Why the correction:** in Claude Code the escape is backslash. In DorkOS, `/` at line start opens the command palette and `use-input-keyboard.ts:120` already intercepts Enter to select a command — so `/`+Enter cannot submit prematurely, and building on it would require one keystroke to both pick a command and insert a newline. `\` is plain text, the palette stays closed, and Enter submits: that is the reported bug.
**Rule:** count consecutive backslashes before the caret. Odd → eat one, insert newline, don't submit. Even (incl. zero) → normal Enter. Shell semantics, so `\\` stays a literal.
**Bonus:** `Option+Enter` also inserts a newline. There is no `altKey` check anywhere in the composer today, so Option+Enter currently submits.

## Operator decisions delegated to the agent

| Question                          | Decision                                                    | Rationale                                                                                             |
| --------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Tier C item budget                | **3**                                                       | Two problems + one context item.                                                                      |
| Pin persistence scope             | **Global**, not per-agent                                   | One `ui.statusBar.pins` list in server config. Per-agent is a future enhancement.                     |
| Hint rotation settling            | **Stop after 3 complete cycles**, persisted as one integer  | Self-limiting; no per-affordance tracking. A new user sees every hint 3× then it goes static forever. |
| `"Press Esc twice to clear"` hint | **Dropped**, and the footgun fixed                          | Don't advertise a destructive no-undo path.                                                           |
| Right-panel Session tab           | **Deferred**                                                | Popover + diagnostics rows + Copy diagnostics covers the need.                                        |
| `ConnectionItem.failedAttempts`   | **Wire it** if the count is reachable, else delete the prop | Currently a dead branch either way.                                                                   |

## Final design summary

The composer footer is **one line**. Left cluster: agent identity (with context menu), directory, git — truncating right-to-left under pressure. Right cluster: promoted status items by severity, then `⋯` as a fixed anchor. Nothing is centered at any breakpoint; no separator abuts the flexible gap.

Items are silent unless their promotion rule fires (thresholds in `02-specification.md`). `cache`, `sound`, and `refresh` never enter the line at all — cache is diagnostics, and the other two are settings that can never be news. Pins override promotion but never bypass the mobile budget.

Clicking `⋯` (or `⌘.`) opens the **Session** popover — every item with its live value, a pin per configurable row, unpinnable diagnostics rows, and **Copy diagnostics**. On mobile it is a `Drawer` bottom sheet sorted attention-first, with any urgent truncated action promoted to a full-width button at the top.
