# UI audit — 2026-09-07 (run 2) — pulse

|                             |                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mode**                    | **Pulse** — diff-scoped surface-local lenses plus one rotating whole-tree lens. Not a full run.                                                                                                                                                                                                                                 |
| **Date**                    | 2026-09-07 — the **second** run of this date. Run log at `audits/runs/ui/2026-09-07-2/`; see "Gaps in the audit's own texts"                                                                                                                                                                                                    |
| **Commit**                  | `e849895e4`                                                                                                                                                                                                                                                                                                                     |
| **Commit range**            | `tokens`: `222e41788..e849895e4` (its own stamp, 4 commits). `cva`: whole tree at `e849895e4` — a whole-tree lens has no diff base by design.                                                                                                                                                                                   |
| **Lenses that ran**         | `tokens` (diff-scoped) · `cva` (rotation slot)                                                                                                                                                                                                                                                                                  |
| **Browser leg**             | **Ran for `tokens`, partially degraded** — the client booted on `:6251` and `getComputedStyle` measurement is sound, but the operator's server on `:6242` refuses this origin (403 `Origin not trusted`), so API-backed surfaces were sparse. **Not run for `cva`**, which needs none: every one of its findings is structural. |
| **Lenses that did NOT run** | `copy`, `responsive`, `states`, `motion`, `clutter` — surface-local but **unbaselined** (absent from `stamps.json`), so per skill §1's bootstrap rule they did not run and this pulse refused to invent a diff base for them. `dry`, `organization`, `dx`, `playground`, `componentize` — whole-tree, awaiting a rotation slot. |

**Read this as a pulse, not a verdict on the interface.** Ten of twelve lenses did not run. Two
lenses looked at two narrow questions: what the last four commits did to the token system, and
whether the whole client expresses its visual variants the way the rules say it must.

The fix for the five unbaselined lenses is one scoped `/ui-audit:run` per lens (or one `full`),
which establishes their stamps; from then on they ride every pulse for the cost of a diff.

## Executive summary

**The `cva` lens came back with the best number this audit has produced: fourteen of the
twenty-two findings from the September run are closed.** Both P1s are gone. `LinkSafetyModal` is
a real `Dialog`. `Switch` is one `tv({slots})` table instead of four hand-maintained string
tables. `Badge` grew the `shape`/`size`/`tone`/`asChild` axes that 71 call sites were hand-tuning
around. `forwardRef` is gone from `shared/ui` entirely. `SidebarRow`'s three-state row, which the
September run flagged as `&&` spaghetti, is now a three-axis cva with a documented resolver and
reads as the model the rest of the directory should copy. None of that was inferred; each was
confirmed by opening the file.

What is left has one shape, and it is a hopeful one: **half-finished conversions.** One filter-bar
trigger of four was converted, so the bar now shows two heights. One tone record of five was
centralized, so four components still write the other four out by hand. Nine of twelve variant
objects are exported, so three are not, and the component that pays for one of them does it with a
ternary. This is the residue of real progress, not decay, and each remaining piece is small.

The `tokens` lens, looking only at the four commits since its own stamp, found the diff clean:
its one client commit is a security seam, and it introduced no token defects. The single finding
it filed is a whole-tree one it happened to surface from a changed line, and it rhymes exactly
with what the other lens found: **a number the design system already owns, spelled a second way
by hand.** The 44px touch floor has a constant, `TOUCH_TARGET_MIN_H`, whose own doc says it is
"spelled once". It is spelled seven more times as `min-h-[44px]`, four of those inside the
directory that owns the constant; three more times as private `TOUCH_REACH` constants in the
filter bar, two of which behave differently from the third past `md`; once more as a private
height record in `SectionHeader`; and it is missed entirely by the composer's send button, which
lands at 36px on a phone. `contributing/design-system.md` blesses two of those spellings by name,
which is why the drift happened and why fixing the doc is half the fix.

**No P1.** Neither lens filed one, and both said why rather than leaving the zero to be read as a
gap: `tokens` looked at a four-commit diff whose only client change was a security seam, and
`cva` closed the two P1s it filed in September and found nothing structural rising to the bar.
The one finding with a visible consequence (the composer's 36px target) is arithmetic off the
source rather than a browser measurement, and is filed P2 for exactly that reason.

**Simplify-first scorecard: ten of eleven findings delete or merge.** Five class tables, three
class strings, three private constants, six redundant attributes, two height records, a nested
ternary and three booleans all go. One finding adds: three `export` keywords and a second
`describe` block in a test that already does the parsing work — and it deletes a ternary while
doing it. Nothing here proposes a new component, a new visual treatment, or a new dependency.

## Stats

| Lens     | P1  | P2  | P3  | Total  |
| -------- | --- | --- | --- | ------ |
| `tokens` | 0   | 0   | 1   | **1**  |
| `cva`    | 0   | 6   | 4   | **10** |
| **All**  | 0   | 6   | 5   | **11** |

Effort mix: 3×M · 8×S · 0×L.

**Findings before dedup: 11. After dedup: 11.** Nothing collapsed. The two lenses saw the _same
theme_ from opposite sides — the 44px touch floor written more than one way — but through four
different files with four different fixes, so they stay four findings under the charter's
"one finding, one fix" rule. Where they overlap is recorded per finding below.

**A note on the `cva` raw file's numbering.** Its findings are unnumbered in their headings but
referenced by number in its prose, and its Counts paragraph slips one label (it credits "five
class tables" to F2 where its own overlap section credits them to F3). The mapping this report
uses, reconstructed from its sweeps and cross-references and consistent with every other
reference in the file:

| Ref | Finding                                                     |
| --- | ----------------------------------------------------------- |
| F1  | Three filter-bar triggers style Radix directly; two heights |
| F2  | `PromptSuggestionChips` states its size axis twice          |
| F3  | Four components re-derive `STATUS_TONE_SURFACE`             |
| F4  | `RoomAvatar` overwrites `IdentityAvatar`'s `data-slot`      |
| F5  | `SectionHeader` hand-maintains the height table             |
| F6  | `InputActionButton` hand-rolls a button beside `Button`     |
| F7  | `PresetPill`'s three booleans and its `default` size token  |
| F8  | Three cva primitives do not export their variants           |
| F9  | `PathBreadcrumb`'s size axis is three expressions           |
| F10 | `CollapsibleCard`'s three conditions, two classes           |

`tokens`'s single finding keeps its own label, **F12**, continuing that lens's numbering from the
2026-09-07 run.

## Verification note

**All 11 findings' citations were opened and checked** — the charter requires every one at or
below twenty findings. Roughly 70 individual `file:line` citations were read, plus every count
claim re-measured with `git grep` against `e849895e4`.

**Nothing failed in substance. Every one of the eleven findings survives.** Five carry a
correction, all of them narrowing or re-pointing rather than killing:

1. **F12 — `touch-target.ts:26` is a blank line.** The constant is at `:44` and the "spelled
   once" docblock the finding quotes is at `:2`. Both exist exactly as described; the citation
   points between them. **Corrected to `touch-target.ts:2,44`.**
2. **F12 — "ten files import `TOUCH_TARGET_MIN_H`" counts the barrel and the source.** Ten files
   contain the name; **eight** are real consumers (`sidebar-row`, `sidebar-menu-node`,
   `bottom-slot`, and five `dashboard-sidebar` files), the other two being `index.ts` and
   `touch-target.ts` itself. The finding's point — the sidebar slice uses it and the menu
   primitives do not — is exact.
3. **F12 — there are no `dev/showcases/*` occurrences of `min-h-[44px]` to leave alone.** The
   recommendation's "leave the showcase occurrences" clause has nothing to bite on; only the
   `MemoryRecallBlock` test assertion does. **Narrowed.** The seven shipped sites, and the fact
   that four are inside `layers/shared/ui/`, are both exact.
4. **F1 — the three `TOUCH_REACH` line numbers are off by 6 to 16.** They are at
   `FilterBarPrimary.tsx:18`, `FilterBarAddFilter.tsx:40`, `FilterBarActiveFilters.tsx:30`, not
   `:12`, `:24`, `:22`. The substance is verbatim correct, including the load-bearing part: the
   `ActiveFilters` copy is the one missing `md:after:hidden`.
5. **F4 — three of the five extra wrappers are cited at the wrong path.** `ScopeBadge.tsx` is in
   `entities/marketplace/ui/`, not `entities/room/ui/`; `ActorBadge.tsx` and `CategoryBadge.tsx`
   are in `entities/activity/ui/`, not `entities/room/ui/` and `features/relay/ui/`. The line
   numbers are right and all three do override a `Badge`'s `data-slot`. `ActorBadge` does it at
   three sites, not one, so the finding is if anything undercounted.

Two further narrowings, both to **F7**, where a claim was overstated:

6. **`gradientText` is not gated on `active`.** The finding says both `glow` and `gradientText`
   are read only inside the `active` branch. `glow` is (`PresetPill.tsx:61`). `gradientText` is
   read at `:70`, outside it, and works whether the pill is active or not. **One boolean is
   unreachable when `active` is false, not two.** The recommendation — one `state` axis replacing
   the booleans — still holds for `glow`; `gradientText` is an independent axis and should be
   named as one.
7. **The "six JSX call sites" for the `default` → `md` rename do not name the prop.** All six
   render the component and take the default (`TaskListPanel.tsx` is also at
   `features/chat/ui/tasks/`, not `features/tasks/ui/`). The rename actually touches **three
   default declarations and three type unions** — `PresetPill.tsx:35`, `TaskRow.tsx:39,119`,
   `PackageCard.tsx:44,85` — and **zero** call sites, which makes it smaller and safer than the
   finding claims, not larger.

Three trims to `cva`'s file lists, so a batch agent does not open files with nothing to change:

- **F3** lists `RevealNode.tsx:25-27` and `DisplayNodes.tsx:47-58` among the re-derivers. Neither
  is one. `RevealNode`'s record maps object shapes (coin, d6, d20, 8ball) onto tokens, and
  `DisplayNodes` simply calls `toneBadgeClass()`. **Both removed from the file list.** The four
  genuine copies — `banner.tsx`, `McpServerCard.tsx`, `widget-tone.ts`, `BoardNode.tsx` — and the
  inline ternary in `ApprovalPrompt.tsx` all hold exactly as described, including the disagreement
  that matters: `widget-tone.ts` spells the fifth rung `default` with `bg-secondary` where
  `status-dot.ts` spells it `neutral` with `bg-muted`.

One coverage statistic in the `cva` raw file is wrong and changes nothing: its sweep 1 reports
**13** files importing `class-variance-authority`; the real count under `layers/**` excluding
tests is **18**. No finding rests on it.

**Nothing was dropped.**

- No finding lacked a citation.
- No finding relitigates a settled decision. Both governing ADRs were checked at source:
  **ADR-0097** (adopt `tailwind-variants` for multi-slot components) is `accepted` and is what F2
  and F5 build on; **ADR-0250** (PackageCard compact variant) is `deprecated` as of 2026-08-06,
  so F7's `variant: 'default' | 'compact'` is genuinely unsettled and fair to raise. The `cva`
  lens also explicitly declined to re-file two things it could have: `sheet.tsx`'s four
  `side ===` branches (September's own recommendation was "convert last, it is upstream shadcn's
  shape") and `NavigationLayout`'s remaining DOM query (the same open half, re-measured rather
  than restated). Both declines are correct.
- No recommendation fights Calm Tech. Every one removes a second spelling or moves a class string
  into a table. None adds a visual treatment.

## Aging the filed findings — DOR-1861 to DOR-1865

Both lenses re-checked all five open items independently, from different angles, and this
synthesis re-measured every count a third time. **All five hold. None is a closure candidate.
Zero dead citations.**

| Item         | Re-measured                                                                                                                                                        | Verdict                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **DOR-1861** | `index.css:861`, `:464`, `:494`, `:590` all present; `Timeline.tsx:519` still `scrollbar-none`; `page-container.tsx:79` still the arbitrary property               | holds unchanged                                  |
| **DOR-1862** | `text-[13px]`: **14 sites in 14 files** = 11 shipped + 2 showcase fixtures + 1 sanctioned. `size-[18px]`: **7 shipped sites**, exact                               | holds; scope of 11 shipped files confirmed exact |
| **DOR-1863** | all 22 `shadow-*` occurrences over 18 primitives still at the lines named (`dialog.tsx:111`, `sheet.tsx:70`, `switch.tsx:85,87`, …)                                | holds unchanged                                  |
| **DOR-1864** | 89 files on the raw palette; `ServerTab.tsx:59` still opens `border-amber-200 bg-amber-50`; `category-colors.ts`, `activity-types.ts`, `status-dot.ts` all present | holds, with one refresh below                    |
| **DOR-1865** | both files in `entities/session/model/status/` present                                                                                                             | holds unchanged                                  |

**The `text-[13px]` disagreement, resolved by measurement.** The two raw files disagreed:
`tokens` said 14 files, `cva` said "still 12 sites in 12 files". **`tokens` is right, and
DOR-1862's own scope of 11 shipped files is right.** The tree has 14 occurrences in 14 files. The
`cva` lens excludes `dev/` from every sweep, which correctly removes 2 showcase fixtures and
gives 12 — but it then counts `responsive-dropdown-menu.tsx:28` as open work, and that one is
**sanctioned by name** in `design-system.md:1088-1091`, which is precisely why the 2026-09-07 run
brought DOR-1862's count down from 12 to 11. So: 14 in the tree, 12 outside the playground,
**11 that DOR-1862 should fix.** No item scope changes.

**One correction to the `tokens` raw file's own aging table.** It reports `size-[18px]` at "13
sites, 7 of them shipped". The shipped 7 is exact and is what DOR-1862 is scoped to. The other
number is 14 non-showcase sites (7 shipped + 7 test assertions), or 20 including the playground.
Recorded so the next pulse does not re-derive it.

**One refresh worth writing back to the tracker.** Commit `48113d455` (DOR-924, the link-safety
seam) edited three files inside DOR-1864's stated scope — `ConfigureStep.tsx`,
`PackageDetailSheet.tsx`, `McpSigninBody.tsx` — but touched only their imports and their anchor
elements. The raw-palette lines survive verbatim (`ConfigureStep.tsx:70`,
`PackageDetailSheet.tsx:172,258`, `McpSigninBody.tsx:85`). DOR-1864's sweep will rebase over
DOR-924; its file list is unchanged.

**One dead citation retired, from the older charter.** The September `cva` run cited
`ConnectionStatusBanner.tsx`, which no longer exists. Nothing in the 2026-09-07 run inherited it,
so no open item carries it. Noted so it is not re-derived.

## Dropped and narrowed

**Dropped: none.** All 11 findings survive.

**Narrowed: 5** (F12 ×3 corrections, F1, F4) — line numbers and paths corrected, one
recommendation clause removed as vacuous.

**Claims reduced: 2** (both F7) — one boolean is state-gated, not two; the rename touches three
declarations, not six call sites.

**File lists trimmed: 1** (F3) — two files removed as non-instances.

**Coverage statistic corrected: 1** (`cva` sweep 1, 13 → 18) — load-bearing on nothing.

## Coverage gaps

Stated so no reader mistakes this for a complete picture:

- **Ten of twelve lenses did not run.** Five for lack of a baseline, five awaiting rotation.
- **The browser leg was degraded again, the same way as 2026-09-07** — the operator's server on
  `:6242` refuses `http://localhost:6251` by origin, so no populated surface was audited at render
  time. This is a known, recorded degrade, not a new one.
- **`cva` read 28 of the 101 entries in `shared/ui` line by line** and opened 23 more at their
  sweep hit lines. `sidebar-menu-node.tsx` (1017 lines) and `sidebar.tsx` (760) were read at
  their variant tables only; `trust-dial.tsx`, `DirectoryPicker.tsx`, `identity-hover-card.tsx`,
  `tour-spotlight/`, `command.tsx`, `data-table.tsx`, `linkified-text.tsx` and `markdown-*` were
  opened only where a sweep hit them, and no claim is made about their interiors.
- **`dev/showcases/*` was audited by neither lens** as a source of violations. They are fixtures,
  and lens 6 (`playground`) owns them.
- **Per-file severity for DOR-1864's 89 raw-palette files** is still not established. It was
  refreshed, not re-audited.

## Batches

Grouped so two batches worked in parallel touch disjoint files. On a scoped run collision class
beats batch size (skill §4), which is why four of the seven batches hold one finding rather than
being padded into a neighbour they would collide with.

**The collision hubs this run.** `apps/client/src/layers/shared/ui/touch-target.ts` and
`contributing/design-system.md` are reached by F12, F1 and F5 together, so those three are one
batch rather than three. `status-dot.ts` and `banner.tsx` are reached by F3 **and** by the
already-open DOR-1864. `sidebar.tsx` and `page-container.tsx` are reached by F8 **and** by the
already-open DOR-1863 and DOR-1861.

**Collisions with the 2026-09-07 run's open items are named per batch below.** None of those five
items has been promoted yet, so nothing is in flight; the collisions are sequencing information
for whoever promotes, not blockers today.

### B1 — One 44px, spelled once · **P2** · 3 findings · 1×M + 2×S

The theme both lenses independently landed on, in one PR. The app owns a constant for its touch
floor whose docblock says it is spelled once; it is spelled once, plus seven arbitrary classes,
plus three private constants, plus one private record. The doc that was meant to prevent this
blesses two spellings in two places.

|     | Finding                                                                                                                                                                                                                                                                                                                                                                            | Sev/Eff |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| F1  | Three of the four filter-bar triggers style a Radix trigger directly with no `asChild`; the fourth was converted, so one bar now has two heights (28px fixed vs 32px growing to 44px on a phone) and three private `TOUCH_REACH` constants under one name, two of which behave differently past `md`. Convert to `<Trigger asChild><Button size="xs">` and delete all six strings. | P2/M    |
| F5  | `SectionHeader` keeps a private `{ fine: 'h-7', coarse: 'h-11' }` record for the axis `SidebarRow` already states as a cva variant sourced from the constant — and the two disagree on `h-` vs `min-h-`, in two components that stack in the same panel and share an absolutely-positioned kebab whose alignment depends on the numbers matching.                                  | P2/S    |
| F12 | 44px is spelled twice: `TOUCH_TARGET_MIN_H` (`min-h-11`) and seven shipped `min-h-[44px]`, four of them inside `layers/shared/ui/` itself. Measured in a real browser at both widths: zero behavioral difference. `design-system.md:1088` names the arbitrary spelling as _the_ one and `:1156` blesses both — fix the doc, then the call sites.                                   | P3/S    |

**Files:** `layers/shared/ui/touch-target.ts`, `contributing/design-system.md`,
`layers/shared/ui/filter-bar/` (`FilterBarPrimary.tsx`, `FilterBarAddFilter.tsx`,
`FilterBarActiveFilters.tsx`, `FilterBarSort.tsx`), `layers/shared/ui/section-header.tsx`,
`layers/shared/ui/responsive-dropdown-menu.tsx`, `layers/shared/ui/responsive-context-menu.tsx`,
`layers/shared/ui/navigation-layout.tsx`,
`layers/features/activity-feed-page/ui/ActivityRow.tsx`,
`layers/features/chat/ui/message/MemoryRecallBlock.tsx` (+ its test).

**Collides with DOR-1861 and DOR-1862** — both edit `contributing/design-system.md`, and DOR-1862
edits `sidebar-row.tsx` and `responsive-dropdown-menu.tsx`, which B1 reads and edits respectively
(different lines: B1 touches `:279,346`, DOR-1862 touches `:28`). Sequence B1 against them rather
than running both at once.

### B2 — The composer's own send button · **P2** · 1 finding · 1×M · **parallel-safe**

F6. `InputActionButton` resolves eight states through a well-built state machine and then paints
each one from a private table that restates three of `buttonVariants`' fills verbatim, on a bare
`motion.button`. So the app's most-pressed control inherits nothing the primitive has learned:
not the newer focus ring, not the disabled handling, not the icon default, and not the size
scale — which has an arithmetic cost of **36px on a phone against the app's own 44px floor**.
Keep `resolveButtonState` and the live regions untouched; swap the `className` column for a
`variant` column and render `<Button asChild variant={…} size="icon-md">` under Motion.

**Files:** `layers/features/composer/ui/InputActionButton.tsx`. Disjoint from every other batch
and from all five open items. The 36px number overlaps lens 8's territory and is cited here as
the cost of the composition gap, not filed as a responsiveness finding — lens 8 has not run.

### B3 — One tone record, not five · **P2** · 1 finding · 1×M

F3. `status-dot.ts` is the app's tone module and its docblock records this exact bug being fixed
once already. `STATUS_TONE_SURFACE` gives background and foreground but no border, so every
consumer drawing a bordered chip writes the record out again and appends one — four copies, one
of them inside `shared/ui` itself, plus an inline two-tone ternary. The copies are not harmless:
`widget-tone.ts` spells the fifth rung `default` with `bg-secondary` where the shared record
spells it `neutral` with `bg-muted`, so a "nothing to report" widget badge and a "nothing to
report" MCP chip are two different greys, and because `WidgetTone` is a wire type the
disagreement is invisible to anyone reading either file alone. Add the border to the shared
record, delete the five tables.

**Files:** `layers/shared/ui/status-dot.ts`, `layers/shared/ui/banner.tsx`,
`layers/features/agent-settings/ui/McpServerCard.tsx`, `layers/features/gen-ui/lib/widget-tone.ts`,
`layers/features/gen-ui/ui/nodes/board/BoardNode.tsx`, `layers/features/ask/ui/ApprovalPrompt.tsx`.

**Collides with DOR-1864** — that item's own file list names `status-dot.ts` and `banner.tsx`, and
it is an L-sized sweep over 89 files. **B3 should land first:** it is the smaller change, it makes
the shared record complete, and DOR-1864's sweep then has one correct target to re-point at
instead of five.

### B4 — One `data-slot` per mark · **P2** · 1 finding · 1×S · **parallel-safe**

F4. `RoomAvatar` passes `data-slot="room-avatar"` into `IdentityAvatar` in three of its four
branches, and `IdentityAvatar` spreads props after its own `data-slot`, so the wrapper's value
wins. The fourth branch wraps a span and leaves the inner faces alone. The result is written down
in the test suite: a one-person DM's disc is found at `[data-slot="room-avatar"]` while a stacked
room's faces are found at `[data-slot="identity-avatar"]` — one visual concept, two selector
names, chosen by how many people are in the room, so "every identity disc on screen" cannot be
selected. `.claude/rules/components.md` names this exact anti-pattern. Five more wrappers do the
same to `Badge` or `IdentityAvatar`. Drop the attribute where the wrapper does not own the
element; a wrapper needing its own hook wants a `data-testid`.

**Files:** `layers/entities/room/ui/RoomAvatar.tsx`,
`layers/entities/room/__tests__/room-marks.test.tsx`,
`layers/entities/agent/ui/AgentAvatar.tsx`, `layers/entities/marketplace/ui/ScopeBadge.tsx`,
`layers/entities/activity/ui/ActorBadge.tsx` (3 sites),
`layers/entities/activity/ui/CategoryBadge.tsx`, `layers/shared/ui/removable-chip.tsx`.

Disjoint from B1, B2, B3, B5, B6, B7. **Near-collision with DOR-1862**, which edits
`identity-avatar.tsx:124` — B4 edits the wrappers, never `identity-avatar.tsx` itself, so they do
not actually touch the same file.

### B5 — The three variant tables the barrel cannot see · **P3** · 1 finding · 1×S

F8. Fourteen files in `shared/ui` define a variant object; eleven are reachable from outside,
three are not (`fieldVariants`, `pageContainerVariants`, `sidebarMenuButtonVariants`). September
counted two; `sidebar.tsx` is the third, so this gap grows when nothing stops it. The cost is
live: `SettingRow` passes `orientation` down to `Field` and then re-states the same axis in a
ternary on top, because it cannot reach `fieldVariants`. Two files already demonstrate the
correct pattern (`alert-dialog.tsx` styles its Action and Cancel by _calling_ `buttonVariants()`,
and `lexical-nodes.ts` builds a class string for a Lexical DOM node where there is no component
to render at all). `barrel-props-exports.test.ts` already walks the barrel and pins every
`*Props` type; a second `describe` doing the same for `*Variants` is what stops the count going
back up.

**Files:** `layers/shared/ui/field.tsx`, `page-container.tsx`, `sidebar.tsx`, `setting-row.tsx`,
`index.ts`, `__tests__/barrel-props-exports.test.ts`.

**Collides with DOR-1863** (`sidebar.tsx` is in its ~24-primitive rename) **and with DOR-1861**
(`page-container.tsx:79`). Different lines in both cases, but the same files: sequence, do not
parallelize. This is the one finding in the run that adds rather than removes — three `export`
keywords and a test block — and it deletes a ternary in exchange.

### B6 — Four axes stated twice · **P3** · 3 findings · 3×S · **parallel-safe**

Three one-file conversions, each the same small shape: one axis, answered in two or three places
that nothing types against each other.

|     | Finding                                                                                                                                                                                                                                                                                             | Sev/Eff |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| F2  | `PromptSuggestionChips` has a `SIZES` record for the button and, eighty lines later, a ternary for the icon. Nothing types the icon branch against the size union, so a third size compiles with the icon silently falling into the `comfortable` half. One `tv({ slots })`, per ADR-0097.          | P2/S    |
| F9  | `PathBreadcrumb`'s one `size` prop is three parallel expressions (one of which never varies) plus a fourth branch on `isLast`, and each clickable segment hand-rolls a raw `<button>` with no shared focus ring and no touch height. The charter names this primitive as load-bearing for overflow. | P3/S    |
| F10 | `CollapsibleCard`'s three-value variant emits two distinct classes, written as three `&&` conditions — so two rungs are byte-identical and nothing makes that visible. This is the transcript's tool/thinking/memory card, one of the most-rendered components in the app.                          | P3/S    |

**Files:** `layers/shared/ui/PromptSuggestionChips.tsx`, `layers/shared/ui/path-breadcrumb.tsx`,
`layers/features/chat/ui/primitives/CollapsibleCard.tsx`. Disjoint from every other batch and
from all five open items.

### B7 — Retire the `default` size token · **P3** · 1 finding · 1×S · **parallel-safe**

F7. `.claude/rules/components.md` retires `size="default"` by name — it says nothing about how
big the thing is, and `<Button size="default">` beside `<Switch size="md">` used to be two
controls that did not line up. It survives in exactly three places: `PresetPill`, `TaskRow`'s
`TaskRowSize`, and `PackageCard`'s `variant`, whose governing ADR-0250 is deprecated as of
2026-08-06 and settles nothing any more. **Verified smaller than filed:** no JSX call site passes
the token, so the rename touches three default declarations and three type unions, and no pixel
moves. `PresetPill` additionally carries three independent visual booleans resolved by a ternary
and two `&&`s, of which `glow` is unreachable unless `active` is true — a state the type system
permits and the render ignores. Give it a cva with `size` and one `state: 'rest' | 'active' |
'glowing'` axis; keep `gradientText` as its own axis (it is not state-gated) and keep the dynamic
gradient in inline `style`, since it is computed per preset.

**Files:** `layers/entities/agent/ui/PresetPill.tsx`, `layers/features/tasks/ui/TaskRow.tsx`,
`layers/features/marketplace/ui/PackageCard.tsx`. Disjoint from every other batch.

**Near-collision with DOR-1864**, which sweeps marketplace features — it names
`PackageDetailSheet.tsx`, not `PackageCard.tsx`, so the files do not actually overlap.

### Parallelism summary

| Batch | Priority | Findings | Effort    | Runs with                          |
| ----- | -------- | -------- | --------- | ---------------------------------- |
| B1    | P2       | 3        | 1×M + 2×S | after/around DOR-1861, DOR-1862    |
| B2    | P2       | 1        | 1×M       | anything                           |
| B3    | P2       | 1        | 1×M       | anything; **land before DOR-1864** |
| B4    | P2       | 1        | 1×S       | anything                           |
| B5    | P3       | 1        | 1×S       | after/around DOR-1863, DOR-1861    |
| B6    | P3       | 3        | 3×S       | anything                           |
| B7    | P3       | 1        | 1×S       | anything                           |

B2, B3, B4, B6 and B7 are mutually disjoint and disjoint from all five open items, so five of the
seven batches can run at once. B1 and B5 are the two that need sequencing, both because of
`contributing/design-system.md` and the `shared/ui` primitives the 2026-09-07 batches already
claim.

## The promotion decision the operator now owes

Same shape as the 2026-09-07 run: each batch emitted here is fenced behind this run's
promotion-decision meta item, and nothing can be dispatched until that fence comes down. Per
batch, choose the **workflow path** (remove the blocking edge; the item enters the normal
lifecycle) or the **audit path** (`/ui-audit:execute` works it while it stays blocked, and closes
it on merge). Close the meta item once every batch in this run is promoted or closed.

Worth deciding alongside it: **the five items from 2026-09-07 are still fenced**, and three of
this run's batches are sequenced against them. Promoting the two runs together is cheaper than
promoting them a week apart.

## Emission record

Emitted to Linear team `DOR` through the `/flow` plugin's `linear-adapter` skill (`cli`
transport, `dorkos` account). Every item carries `source/audit` as provenance. **No `agent/*`
label was written.**

| Batch | Item                                                                       | Fence                |
| ----- | -------------------------------------------------------------------------- | -------------------- |
| —     | **DOR-1866** · `type/meta` · promotion decision for audit run 2026-09-07-2 | the blocker          |
| B1    | **DOR-1867** · one 44px, spelled once                                      | `blockedBy` DOR-1866 |
| B2    | **DOR-1868** · the composer's own send button                              | `blockedBy` DOR-1866 |
| B3    | **DOR-1869** · one tone record, not five                                   | `blockedBy` DOR-1866 |
| B4    | **DOR-1870** · one `data-slot` per mark                                    | `blockedBy` DOR-1866 |
| B5    | **DOR-1871** · the three variant tables the barrel cannot see              | `blockedBy` DOR-1866 |
| B6    | **DOR-1872** · four axes stated twice                                      | `blockedBy` DOR-1866 |
| B7    | **DOR-1873** · retire the `default` size token                             | `blockedBy` DOR-1866 |

**Fence verified by re-query, in both directions:** each batch item reports `blockedBy DOR-1866`
with DOR-1866 open, and DOR-1866 reports `blocks` all seven. Direction checked explicitly — the
meta item is the blocker, not the blocked one.

### Refreshed, not re-filed

Per the pulse's dedup rule, the five items from run 2026-09-07 were **re-measured and commented
on**, never duplicated. Each carries a comment recording what was re-checked and any sequencing
this run's batches impose on it:

| Item     | Refresh                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| DOR-1861 | holds unchanged; now sequenced against B1 (`design-system.md`) and B5 (`page-container.tsx`)       |
| DOR-1862 | both counts confirmed exact; the `text-[13px]` dispute resolved in favour of its existing scope    |
| DOR-1863 | holds unchanged; sequenced against B5 (`sidebar.tsx`)                                              |
| DOR-1864 | file list unchanged after DOR-924; **B3 should land first** so this sweep has one target, not five |
| DOR-1865 | holds unchanged; parallel-safe against everything in this run                                      |

**Aged out for closure: none.** No filed finding's cited code has moved or disappeared.

## Gaps in the audit's own texts

Recorded because the texts are meant to be followed exactly, and these are the points where
following them exactly was not possible. The 2026-09-07 run logged three; two of those are now
fixed in the skill, and one survives here as gap 2.

1. **A second run on one date has nowhere to go.** The run log is keyed on `<date>` (ISO
   `YYYY-MM-DD`, `audits/README.md` and skill §1), and `audits/README.md` also says "create if
   absent, never overwrite". This pulse ran on **2026-09-07**, about forty minutes after the
   baseline run of the same date had already committed `audits/runs/ui/2026-09-07/`. Writing to
   the date key would have clobbered that run's `report.md`. **Improvised:** this run log lives at
   `audits/runs/ui/2026-09-07-2/`, which still sorts chronologically. **Suggested text fix:** in
   `audits/README.md`, state that a second run on one date takes the suffix `-2`, `-3`, … and that
   the meta item's title carries the same suffixed run id.

2. **`profile.md` still names a label that cannot exist on this tracker.** Its Fence-labels note
   names `audit/claimed` for in-progress visibility. The 2026-09-07 run discovered that Linear
   enforces team-wide label-name uniqueness so `claimed` cannot be created twice, fixed skill §5
   to say **`ui-audit/in-progress`**, and created that label — but the profile was not updated in
   the same edit. Verified this run: `ui-audit/in-progress` exists in team `DOR` and
   `audit/claimed` does not. **Suggested text fix:** change `profile.md`'s fence-labels bullet to
   `ui-audit/in-progress`, matching skill §5.

3. **Contract 1 does not say whether a missing lens stops the run or is skipped.**
   `pulse.md` contract 1 says that "with no stamps file, **or with lenses missing from it**, stop
   and say so", which reads as halting the whole pulse. Skill §1's bootstrap rule is phrased
   per-lens ("with no stamps file, or **for a lens missing from it**"). Only `tokens` had a stamp,
   so a literal reading of contract 1 would have aborted this pulse entirely and run nothing —
   including the rotation lens, which needs no stamp at all. **Improvised:** took the skill's
   per-lens reading, ran the one baselined lens plus the rotation slot, and named the five
   unbaselined lenses in the header. **Suggested text fix:** reword contract 1 to "a lens missing
   from `stamps.json` is skipped and named in the report; the pulse stops only when the file
   itself is absent."

4. **Nothing says what a pulse that finds nothing new should emit.** Skill §5 opens "Every
   `/ui-audit:run` and `/ui-audit:pulse` emission creates one per-run `type/meta` item", which on
   a zero-finding pulse would create a promotion-decision item with nothing to promote — instantly
   the stale ledger that §5's own end-of-life rule warns about. This run found eleven findings so
   the path was not exercised, but a weekly schedule will hit it. **Suggested text fix:** add to
   §5 that a run producing no new batches emits nothing at all, creates no meta item, and records
   its refreshes in the run log only.

5. **The browser-leg predicate has no proportionality clause** (minor). Skill §3 says the five
   browser-confirmable lenses get a browser leg "on every scope … whenever the profile supplies a
   dev command and a free port", and adds "this is the predicate; nothing else decides it". So a
   pulse over a four-commit diff whose only client change was a security seam still had to boot a
   client and a browser. It was worth it here — the measurement is what settled F12 — but a
   docs-only week will pay the same cost for nothing. **Suggested text fix:** allow the leg to be
   skipped when no finding in scope is browser-adjudicable, provided the report says so under
   coverage gaps, exactly as a degrade already must.

6. **Whole-tree lenses get a stamp whose `lastAuditedCommit` is not a diff base** (minor).
   Contract 6 says to write stamps for every lens that ran, and `cva` ran — so `stamps.json` now
   carries a `lastAuditedCommit` for a lens that must never be diff-scoped. It is the right thing
   to record (charter rule 7 wants the last-run date), but a future reader could mistake it for a
   diff base. **Suggested text fix:** note in skill §1 that a whole-tree lens's stamp records
   coverage and recency only, and is never a diff base.
