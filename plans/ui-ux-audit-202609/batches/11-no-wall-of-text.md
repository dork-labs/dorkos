[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 11 — No wall of text

**Priority P2 · 4 findings · 3S · 1M**
**Scope:** the operator's 2026-09-03 directive — no surface shows a large block of static prose by default; the gist goes on screen and detail goes behind an affordance chosen to fit the context.

### 11.1 — Message search shows four sentences of prose before any query

**P2 · S · lens 7**
`apps/client/src/layers/features/command-palette/model/message-search-scope.ts:41-58` (rendered in the message-search dialog); the one-line alternative already exists at `:68-69`

**Evidence.** ⌘⇧F, before typing anything: a "What search covers" heading followed by four bulleted sentences, two of them two lines long — coverage of rooms, coverage of the three runtimes (with a "can take up to five minutes" caveat), what is never searched (tool output, with four named exclusions), and the whole-word matching rule with a worked example. The content is legitimate and satisfies a documented product commitment (spec `message-search` §1.3 G4: a user must be able to learn search's limits without reading a spec), and it is pinned by a copy-length test — but four multi-clause sentences, always visible, before the user has started typing is precisely the pattern the rule targets.

**Recommendation.** Cut the default view to one line — `SEARCH_SCOPE_SUMMARY` at `:68-69` already _is_ that line — and move the four-bullet detail behind a small info affordance, or reveal it once the user has typed and got zero results, which is the moment the whole-word caveat actually matters. This keeps G4's promise without keeping the prose on screen. Update the copy-length test with the change.

### 11.2 — Settings → Notifications is six stacked blocks of explanatory prose

**P2 · M · lens 7**
`apps/client/src/layers/features/settings/ui/tabs/NotificationsTab.tsx`

**Evidence.** A three-sentence intro sits above the controls: _"Agents work while you do something else, so DorkOS has to be able to reach you — and to stay quiet the rest of the time. A knock means something has stopped and is waiting on you. Everything else is news."_ Then every toggle repeats the pattern — bold title plus a full sentence, some two: "Chime every time a turn finishes" carries _"Plays whenever an agent finishes replying, in any session. Off to start with — with a few agents running it is a lot of sound."_ Six such blocks are visible without scrolling. Individually this is the best copy in the app (batch 9 points everything else at it); stacked six deep it is the wall-of-text pattern. A settings panel should be scannable by its bold labels alone.

**Recommendation.** Keep the bold labels as the primary scan layer. Drop the per-toggle sentence to a tooltip or info icon rather than permanent secondary text, or cut each to under ten words and move the "which mode fires when" reasoning into a single collapsible "How this works" block at the top instead of six variations of it.

### 11.3 — The Workspaces page explains what a worktree is twice, back to back

**P2 · S · lenses 3 + 7**
`apps/client/src/layers/widgets/workspaces/ui/WorkspacesPage.tsx:161-164` and `:197-205`

**Evidence.** Verified in source. Page intro: _"Every separate copy of your code found in your workspaces folder. Agents work in these so they never edit the same files at once. This page only reads them."_ Immediately below, the empty-state card: _"A worktree is a second copy of your project, on its own branch, so one agent's edits can't collide with another's. They show up here once they exist in ~/…"_ Both say the same thing in two phrasings, stacked on one screen with no query between them. The raw path in the second is also rendered as plain wrapped prose rather than a code/path element (see 1.1).

**Recommendation.** Keep one explanation. Either drop the page intro — the empty state already carries the concept — or shrink it to a five-word gist ("Copies of your code, per agent.") and let the empty state carry the detail once. Style the path as code, not prose.

### 11.4 — The install dialog decides seven times, independently, how much to open

**P3 · S · lens 11**
`apps/client/src/layers/features/marketplace/ui/PermissionPreviewSection.tsx:170-262`, `InstallConfirmationDialog.tsx:202-275`

**Evidence.** `PermissionPreviewSection` renders seven `<details>` sections, each deciding its own initial state with `const open = defaultOpen ?? items.length <= 3`, and two (Commands, Jobs) forced open. A package with three rows in each of five optional sections opens all of them: roughly 20 rows across seven uppercase headings, above a scope radio group and an agent picker. The per-section heuristic is locally sensible and globally unbounded — there is no dialog-level budget, which is exactly the gap the composer status line closed with `applyStatusBudget`. For Ikechi this is the first security decision the product asks him to make, and a wall of open sections reads as "this is complicated". The constraint is real though: DorkOS is honest by design, so the fix must not _hide_ risk.

**Recommendation.** Keep **Commands** and **Conflicts** always expanded — the component's own doc comment identifies those two as "what a person needs to see before trusting a stranger's package". Collapse Effects, Secrets, Hosts and Dependencies by default, each with its count in the summary so nothing is concealed, and add a one-line verdict above the sections derived from the same data ("Adds 4 skills for all agents. Declares no commands."). Nothing is removed; the reader is given an order to read it in.
