# Lens 2 — Composition & CVA (`cva`)

Run: 2026-09-07 (run 2) · scope `lens:cva`, **whole tree** (`apps/client/src`) · commit `e849895e4`
· **code-only, no browser leg** (see Coverage).

## Coverage

### Source of truth, read

`apps/client/src/layers/shared/ui/` — 101 entries. Read in full, line by line (28 files):
`badge.tsx`, `button.tsx`, `card.tsx`, `empty-state.tsx`, `spinner.tsx`, `removable-chip.tsx`,
`switch.tsx`, `path-breadcrumb.tsx`, `option-row.tsx`, `compact-result-row.tsx`,
`provenance-chip.tsx`, `PromptSuggestionChips.tsx`, `segmented-control.tsx`, `status-dot.ts`,
`touch-target.ts`, `README.md`, and the whole `filter-bar/` directory (9 files).
Opened at their hit lines from the sweeps below (23 more): `sheet.tsx`, `sidebar-row.tsx`,
`section-header.tsx`, `setting-row.tsx`, `field.tsx`, `field-card.tsx`, `page-container.tsx`,
`copy-button.tsx`, `link-safety-modal.tsx`, `navigation-layout.tsx`, `responsive-popover.tsx`,
`hover-border-gradient.tsx`, `identity-avatar.tsx`, `responsive-sheet.tsx`, `sidebar.tsx`,
`dialog.tsx`, `alert-dialog.tsx`, `select.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`,
`popover.tsx`, `hover-card.tsx`, `banner.tsx`, plus `__tests__/barrel-props-exports.test.ts`.

Rules and prior art read first: `audits/README.md`, `audits/ui.md`,
`.claude/skills/auditing-ui/assets/auditor-prompt.md`, `.claude/rules/components.md` (in full —
it is this lens's binding contract and it changed materially since the last run),
`.claude/rules/fsd-layers.md`, `contributing/design-system.md` §Custom-Utilities / §Page-width /
§Anti-Patterns, `AGENTS.md` §Quality Standard, `decisions/0097-adopt-tailwind-variants-for-multi-slot-components.md`
(accepted, governs this lens) and `decisions/0250-package-card-compact-variant.md`
(**deprecated 2026-08-06** — so `PackageCard`'s `variant` is no longer settled by it).

### Prior runs read (validity rule 7)

Two:

1. **`plans/ui-ux-audit-202609/raw/cva.md`** — the September 2026 run of this lens, 22 findings.
2. **`audits/runs/ui/2026-09-07/raw/tokens.md`** and its `report.md` — the only committed run, a
   different lens, read for the five open Linear items and for its shared/ui citations.

**Closed since the September run, each verified by sweep or by opening the file.** This lens's
tree moved more than any other: `DOR-1761` and `DOR-1763` landed between the runs and closed
fourteen of the twenty-two.

| September finding                                           | Status now                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — `LinkSafetyModal` hand-rolls a modal                   | **Closed.** It is a real `Dialog` now, with a documented `useLayoutEffect` focus-restore for the trigger-less case (`link-safety-modal.tsx:40-62`).                                                                                                                             |
| P1 — `FilterBarSort` nests a button in a button             | **Closed.** Two sibling `Button`s in a wrapper (`FilterBarSort.tsx:42-69`). The fix created a new, smaller defect — F1 below.                                                                                                                                                   |
| P2 — `Switch` hand-rolls four string tables                 | **Closed.** `tv({slots})` (`switch.tsx:83-91`), and a test derives the responsive table from the base one.                                                                                                                                                                      |
| P2 — `Badge` has one axis, 71/104 call sites hand-tune      | **Closed in substance.** `shape`/`size`/`tone`/`asChild` all landed (`badge.tsx:7-88`). Re-measured below.                                                                                                                                                                      |
| P2 — `Badge` renders a hard `<div>`, no `asChild`           | **Closed.** `<span>` + `Slot.Root` + `data-slot` (`badge.tsx:78-87`).                                                                                                                                                                                                           |
| P2 — `CollapsibleFieldCard` restates `FieldCard`'s classes  | **Closed.** It composes `FieldCard` and says so in a comment (`field-card.tsx:93-96`).                                                                                                                                                                                          |
| P2 — `ConnectionStatusBanner` re-implements `Banner`        | **Closed.** The file no longer exists.                                                                                                                                                                                                                                          |
| P2 — `PathInput` re-implements `Input`                      | **Closed.** `path-input.tsx:52` is the wrapper only.                                                                                                                                                                                                                            |
| P2 — three primitives take no `className`/rest props        | **Closed.** All three take `React.ComponentProps<'div'>` and spread (`option-row.tsx:22-41`, `compact-result-row.tsx:16-32`, `path-breadcrumb.tsx:18-43`).                                                                                                                      |
| P2 — ~20 primitives carry no `data-slot`                    | **Largely closed** (DOR-1761), and `.claude/rules/components.md` now records the remaining gap as deliberate. Not re-filed. A NEW `data-slot` defect is F4 below.                                                                                                               |
| P2 — two shadcn dialects, `forwardRef` frozen mid-migration | **Closed.** `rg -c forwardRef layers/shared/ui/` returns nothing.                                                                                                                                                                                                               |
| P2 — `ResponsivePopoverContent` widens Radix's unions       | **Closed.** No `side?: string` / `as '…'` cast remains in the file.                                                                                                                                                                                                             |
| P2 — bare `focus:` rings in five primitives                 | **Closed** in `shared/ui`. Six bare-`focus:` sites survive in `features/`, all textareas and destructive buttons — lens 9's, not re-filed here.                                                                                                                                 |
| P2 — `AgentIdentity` runs three parallel `cva()` calls      | **Closed.** It is on `tailwind-variants` now.                                                                                                                                                                                                                                   |
| P3 — `SidebarRow`'s three-state row solved with `&&`        | **Closed, and exemplary.** `sidebarRowVariants` (`sidebar-row.tsx:139-166`) is a three-axis cva with a `sidebarRowState()` resolver.                                                                                                                                            |
| P3 — `HoverBorderGradient` takes an untyped `as`            | **Closed.** The escape hatch was removed, with a comment saying nobody used it (`hover-border-gradient.tsx:34`).                                                                                                                                                                |
| P2 — `PackageTypeBadge` maps types onto raw palette         | **Closed.** `--package-*` tokens (`PackageTypeBadge.tsx:18-38`).                                                                                                                                                                                                                |
| P2/L — variant-shaped code across `shared/ui` bypasses cva  | **Partly open, re-scoped.** 8 of the 17 files it listed are fixed outright. What is left is not one sweep any more; it is F2, F5, F9 and F10 below.                                                                                                                             |
| P2 — primitives hand-roll icon buttons instead of `Button`  | **Mostly closed** in `shared/ui` (`sheet.tsx:85-94`, `FilterBarActiveFilters.tsx:111-118` and `RemovableChip` all compose `Button` now). Still open in `features/` — F6.                                                                                                        |
| P2/L — `NavigationLayout` hand-rolls a tablist              | **Half closed.** `role="toolbar"` is gone and the ids are `useId()`-scoped (`navigation-layout.tsx:69,195-205,354`). It still queries `[role="tab"]` out of the DOM at `:225` rather than using `useRovingTabList`. Re-measured, not re-filed as new: it is the same open half. |
| P3 — cva'd primitives do not export their variants          | **Open, re-measured (2 → 3)** → F8.                                                                                                                                                                                                                                             |
| P2 — `sheet.tsx`'s four `side ===` branches                 | **Open, unchanged** (`sheet.tsx:71-78`). Not re-filed: September's own recommendation was "convert last, it is upstream shadcn's shape", and nothing has changed that.                                                                                                          |

### Scripted sweeps, run to exhaustion

All over `apps/client/src/layers/**`, excluding `__tests__/`, `*.test.*` and `dev/` (lens 6 owns
the playground). Every sweep's hits were opened at their hit lines.

1. Files importing `class-variance-authority` (**13**) vs `tailwind-variants` (**4**) vs the 101
   entries in `shared/ui`.
2. Every `*Variants` definition and whether it is exported from its file and from the barrel.
3. `Record<…Size|Variant|Tone|Kind|Type|State|Status|Level|Severity…, string>` class tables
   (**34 hits**), each opened to separate label maps from class maps.
4. Components declaring ≥4 boolean props (**30 files**), each opened to separate visual booleans
   from behavioural ones.
5. `cn(...)` calls with three or more `&&` branches (**17 files**).
6. Radix `*Trigger` elements carrying a `className` **without** `asChild` (PCRE2 lookahead) —
   exactly **3 hits**, all in one directory. That is F1.
7. Files rendering a raw `<button>` that never import `Button` (**40+ files**), ranked.
8. Components with a `variant`/`tone`/`size`/`kind`/`density` prop and **no** cva/tv import (**39
   files**), each opened.
9. `size` prop unions across the tree, for vocabulary agreement between siblings (**5 hits**).
10. `data-slot="…"` passed into a capitalised JSX element — i.e. a wrapper overwriting a
    primitive's own slot name (**6 components**). That is F4.
11. Every re-derivation of `STATUS_TONE_*` (`bg-status-*-bg`, `text-status-*-fg`) — **14 files**.
12. `<Badge` call sites (**104**) and how many pass `className` (**80**) or `tone` (**12**),
    then a per-utility histogram of what those overrides actually say.

### Explicitly skipped

- **`dev/showcases/*`** — fixtures, lens 6's. Excluded from every count above.
- **No browser leg, and this lens does not need one.** Every finding here is structural: a
  variant table, an export, a slot name, a class string read against the primitive that already
  owns it. Nothing below rests on how a surface probably looks, so the charter's P2 cap on
  visual inference does not bind any of them — but nothing below is filed P1 either, because the
  one finding with a visible consequence (F6's 36px phone target) is a **measurement** I did not
  take in a browser, only an arithmetic from the source. It is filed P2 and says so.
- **`sidebar-menu-node.tsx` (1017 lines) and `sidebar.tsx` (760)** were read at their sweep hits
  and at their variant tables, not line by line. Both are large enough that a full read is its
  own pass; I say so rather than implying coverage I do not have.
- **`trust-dial.tsx`, `DirectoryPicker.tsx`, `identity-hover-card.tsx`, `tour-spotlight/`,
  `command.tsx`, `data-table.tsx`, `linkified-text.tsx`, `markdown-*`** — opened only where a
  sweep hit them. No finding is claimed about their interiors.
- **Colour choice.** Where I cite a class, the question I am asking is "should this be an axis on
  a primitive that exists", never "is this the right colour". Colour is lens 1's, and DOR-1861…65
  already hold it.

### Overlap with already-filed work

- **DOR-1864** (status colour off the raw palette, 89 files) does **not** cover F3. F3 is about
  code already on the `--status-*` tokens that re-derives a record `shared/ui` exports.
- **DOR-1862** (`text-[13px]`, `size-[18px]`) touches `sidebar-row.tsx:145` and
  `identity-avatar.tsx:124`, both of which I opened. No finding here re-states either.
- **DOR-1863** (one elevation vocabulary) touches `sheet.tsx:70`, `switch.tsx:85,87` and
  `path-input.tsx:52`, all of which I opened for other reasons. Not re-filed.

**Stale-citation check on the five open items — all five are still accurate.** I re-ran each
item's own sweep against this tree: `text-[13px]` is still 12 sites in 12 files and
`size-[18px]` still 7 sites (DOR-1862); every one of the ~24 `shadow-*` primitives DOR-1863
names is still at the line it names (`dialog.tsx:111`, `alert-dialog.tsx:82`, `sheet.tsx:70`,
`popover.tsx:30`, `hover-card.tsx:45`, `dropdown-menu.tsx:65,225`, `select.tsx:59,85`,
`context-menu.tsx:101,124`, `sidebar.tsx:243,309`, `input.tsx:31`, `textarea.tsx:19`,
`button.tsx:36`, `checkbox.tsx:43`, `radio-group.tsx:51`, `slider.tsx:57`, `switch.tsx:85,87`,
`path-input.tsx:52` — 22 occurrences over 18 files, matching); the raw-palette count is still
**89 files** and `ServerTab.tsx:59` still opens with `border-amber-200 bg-amber-50` (DOR-1864);
both files DOR-1865 names still exist; and `Timeline.tsx:519` still carries `scrollbar-none`
and `page-container.tsx:79` still carries `[scrollbar-gutter:stable_both-edges]` (DOR-1861).
**One caveat worth passing on:** the September `cva` run cited `ConnectionStatusBanner.tsx`,
which no longer exists — if any of the five items inherited that citation from the earlier
charter, it is dead. Nothing in the 2026-09-07 `tokens.md` cites it, so I believe they did not.

---

### [P2/M] Three of the four filter-bar triggers still style a Radix trigger directly, and fixing only the fourth left the bar with two heights and two touch behaviours

**Files.** `apps/client/src/layers/shared/ui/filter-bar/FilterBarPrimary.tsx:54-65` ·
`filter-bar/FilterBarAddFilter.tsx:278-288` · `filter-bar/FilterBarActiveFilters.tsx:90-100` ·
`filter-bar/FilterBarSort.tsx:42-69` · `button.tsx:45,72-83` ·
`filter-bar/FilterBarPrimary.tsx:12`, `FilterBarAddFilter.tsx:24`, `FilterBarActiveFilters.tsx:22`
(the three private `TOUCH_REACH` constants) · `touch-target.ts:1-63`.

**Current state.** Sweep 6 — every Radix `*Trigger` in the client that carries a `className`
without `asChild` — returns **exactly three hits, and all three are in this one directory**:

```tsx
// FilterBarPrimary.tsx:56-57
'border-input hover:bg-accent hover:text-accent-foreground inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs';
// FilterBarAddFilter.tsx:281 — same recipe, dashed border
// FilterBarActiveFilters.tsx:93 — same recipe, primary border, px-2
```

Their fourth sibling was converted when the September P1 was fixed, and it now reads
`<DropdownMenuTrigger asChild><Button variant="outline" size="sm">` (`FilterBarSort.tsx:44-47`).

**Why it falls short.** The half-conversion is measurable, not stylistic. `Button`'s `sm` is
`h-8` (`button.tsx:45`) and its `responsive` default adds `h-11 md:h-8`
(`button.tsx:77,114,134`). So in one bar, on one screen: Sort is **32px** on a desktop and grows
to **44px** on a phone, while Primary, Add-filter and Active-filters are **28px** at every width.
The three also each declare their own private hit-area constant —

```ts
// FilterBarPrimary.tsx:12 and FilterBarAddFilter.tsx:24
const TOUCH_REACH = 'relative after:absolute after:-inset-x-1 after:-inset-y-2 md:after:hidden';
// FilterBarActiveFilters.tsx:22 — the same name, WITHOUT `md:after:hidden`
```

— three copies of one recipe under one name, two of which behave differently past `md`, and
`touch-target.ts` (the module whose whole docblock is "the smallest a control may be under a
thumb, **spelled once**") does not export it. `.claude/rules/components.md` §Composition names
Radix + `asChild` as the pattern; §Sizes names one ordinal scale. This directory is the only
place in the client that opts out of both.

**Recommendation.** Convert the three triggers to `<Trigger asChild><Button variant="outline"
size="xs" …>` — `xs` is `h-6` and is the rung nearest today's 28px, so nothing jumps — and delete
the three class strings and the three `TOUCH_REACH` constants outright. If a 28px rung is genuinely
wanted, add it to `buttonVariants` once rather than to three call sites. Two `after:` variants of
one hit-area recipe is the drift the conversion removes; if the pseudo-element expansion is still
needed after the touch heights come from `Button`, it belongs in `touch-target.ts` beside its
siblings, exported once. Net effect: four controls, one height, one vocabulary, three constants
and three class strings deleted.

---

### [P2/M] Four components re-derive `STATUS_TONE_SURFACE` because the shared record stops one class short — and one of the four is inside `shared/ui`

**Files.** `apps/client/src/layers/shared/ui/status-dot.ts:82-89` (the record) ·
`shared/ui/banner.tsx:15-22` · `features/agent-settings/ui/McpServerCard.tsx:51-64` ·
`features/gen-ui/lib/widget-tone.ts:9-24` · `features/gen-ui/ui/nodes/board/BoardNode.tsx:69-75` ·
`features/gen-ui/ui/nodes/DisplayNodes.tsx:47-58` · `features/gen-ui/ui/nodes/RevealNode.tsx:25-27` ·
`features/ask/ui/ApprovalPrompt.tsx:421-422`.

**Current state.** `status-dot.ts` is the app's tone module and its docblock is explicit about
why (`:36-50`: "seven of them, at the last count… the four records below are the only places a
tone turns into classes"). `STATUS_TONE_SURFACE` gives background + foreground. It gives no
border. So every consumer that draws a bordered chip writes the record out again and appends one:

```ts
// status-dot.ts:83-89                    // McpServerCard.tsx:56-60 — byte-identical, all five rungs
success: 'bg-status-success-bg text-status-success-fg',
warning: 'bg-status-warning-bg text-status-warning-fg',
…
neutral: 'bg-muted text-muted-foreground',

// widget-tone.ts:11-14 — the same four, plus `border-status-*-border`
// banner.tsx:18-20    — the same three, plus `border-status-*-border`, inside shared/ui itself
// ApprovalPrompt.tsx:421-422 — two of them, as an inline ternary
```

`BoardNode.tsx:69-75` is a fifth copy of a different record, `STATUS_TONE_TEXT`.

**Why it falls short.** `AGENTS.md` §Quality Standard rules out two vocabularies for one idea,
and `status-dot.ts`'s own module doc is the record of this exact bug being fixed once already.
The copies are not harmless: `widget-tone.ts` spells the fifth rung `default` where
`status-dot.ts` spells it `neutral` and gives it `bg-secondary` rather than `bg-muted`, so a
"nothing to report" widget badge and a "nothing to report" MCP chip are two different greys. And
because `WidgetTone` is a wire type from `@dorkos/shared/ui-widget`, that disagreement is
invisible to anyone reading either file alone.

**Recommendation.** Add the border to the shared record — either fold it in
(`'bg-status-success-bg text-status-success-fg border-status-success-border'`) or add one
`STATUS_TONE_SURFACE_BORDERED` beside it — then delete `McpServerCard`'s `chipVariants` table,
`TONE_BADGE_CLASSES`, `WIN_TONE_TEXT` and `banner.tsx`'s three rungs, pointing each at the
record. `widget-tone.ts` keeps only the one line that matters: mapping the wire's `default` onto
the app's `neutral`. Five tables deleted, one class added.

---

### [P2/M] `InputActionButton` hand-rolls an eight-state button beside `Button`, restating three of its `variant` fills verbatim — and lands at 36px on a phone against the app's own 44px floor

**Files.** `apps/client/src/layers/features/composer/ui/InputActionButton.tsx:69-109`
(`BUTTON_CONFIG`), `:264-278` (the dedicated stop button), `:302-341` (the main slot) ·
compare `shared/ui/button.tsx:32-38,45-51,72-83` · `shared/ui/touch-target.ts:27-44`.

**Current state.** The composer's primary control resolves eight states through a well-built
`resolveButtonState()` (`:132-163`) and then paints each one from a private table:

```ts
send:   'bg-primary text-primary-foreground hover:bg-primary/90',        // buttonVariants variant:'default', verbatim
stop:   'bg-destructive text-destructive-foreground hover:bg-destructive/90', // ≈ variant:'destructive'
queue:  'bg-muted text-muted-foreground hover:bg-muted/80',              // ≈ variant:'secondary'
```

and applies them to a bare `motion.button` with `'focus-ring rounded-lg p-1.5 transition-colors
max-md:p-2'` (`:329`). The second, dedicated stop button (`:273`) writes the destructive fill a
second time in the same file.

**Why it falls short.** The state machine is not the problem — it is the best part of the file,
and it should survive untouched. The problem is that its **output** is a private re-statement of
`buttonVariants`, so this control does not inherit anything the primitive has learned: not
`focus-visible:ring-[3px]` (it uses the older `focus-ring` utility), not
`disabled:pointer-events-none disabled:cursor-not-allowed` (it re-implements the first half by
hand at `:331`), not the `[&_svg:not([class*='size-'])]` icon default, and not the size scale.
That last one has an arithmetic consequence: `p-2` around a `--size-icon-sm` glyph is
8 + 20 + 8 = **36px** on a phone, where `touch-target.ts:27-44` states the floor as 44 and
`Button size="icon-md"` already spends exactly that. This is the app's most-pressed control.

**Recommendation.** Keep `resolveButtonState`, `BUTTON_ICON` and the live regions exactly as
they are. Replace `BUTTON_CONFIG`'s `className` column with a `variant` column
(`'default' | 'destructive' | 'secondary'`) and render `<Button asChild variant={…}
size="icon-md">` over the `motion.button`, so Motion keeps the element and `Button` supplies the
recipe. `cancel-upload`'s hover-turns-red is the one fill with no primitive equivalent — leave it
as a `className` on top, which is what `className` is for. Delete the duplicated destructive
string at `:273` the same way. _(The 36px measurement overlaps lens 8, which owns touch targets;
it is cited here as the cost of the composition gap, not filed as a responsiveness finding.)_

---

### [P2/S] `RoomAvatar` overwrites `IdentityAvatar`'s `data-slot` in three of its four branches, so the same mark answers to two different selector names depending on member count

**Files.** `apps/client/src/layers/entities/room/ui/RoomAvatar.tsx:136-142,148-163,192-200`
(the three overrides) and `:167-188` (the stacked branch, which does **not** override the inner
faces) · `layers/entities/room/__tests__/room-marks.test.tsx:77,92,131,144` ·
`.claude/rules/components.md` §Required Patterns.

**Current state.** `RoomAvatar` has four branches. The non-DM branch stamps `data-slot="room-avatar"`
onto a `<Hash>` (fine — it owns that element). The one-face branch and the counterpart branch
pass `data-slot="room-avatar"` **into `<IdentityAvatar>`**, whose own root already carries
`data-slot="identity-avatar"` and spreads props after it, so the wrapper's value wins. The
stacked branch wraps a `<span data-slot="room-avatar">` around faces that keep their own slot.

**Why it falls short.** `.claude/rules/components.md` names this exactly: "A component whose root
IS another `shared/ui` primitive inherits that primitive's `data-slot` rather than adding a
second, conflicting one — the attribute holds one value, and the inner primitive's own selectors
depend on that value staying what it is." The consequence is already written down in the test
suite: `room-marks.test.tsx:131` finds a single DM's disc at `[data-slot="room-avatar"]`, while
`:92` and `:144` find the stacked faces at `[data-slot="identity-avatar"]` — one visual concept,
two selector names, chosen by how many people are in the room. Anything that later wants "every
identity disc on screen" cannot be written. The same override appears in five more places
(`AgentAvatar.tsx:75-76`, `ScopeBadge.tsx:30-31`, `ActorBadge.tsx:33-34`,
`CategoryBadge.tsx:22-23`, `removable-chip.tsx:40-41`), each clobbering `identity-avatar` or
`badge`.

**Recommendation.** Drop the `data-slot` from the three `RoomAvatar` branches that render an
`IdentityAvatar` — the mark keeps `identity-avatar`, which is what it is — and keep it only on
the two elements `RoomAvatar` genuinely owns (the `<Hash>` and the stack `<span>`), which is
already enough for the two tests that need to find a room's mark. Then do the same for the five
badge/avatar wrappers: a wrapper that needs its own hook wants a `data-testid`, not a second
value in a single-valued styling seam. Six deletions, no additions, and the rule stops being
contradicted by the tree it governs.

---

### [P2/S] `SectionHeader` hand-maintains the pointer-height table `SidebarRow` already states as a cva axis, and the two disagree on `h-` versus `min-h-`

**Files.** `apps/client/src/layers/shared/ui/section-header.tsx:36,55-58,214-215,323`
· compare `shared/ui/sidebar-row.tsx:139-166` · `shared/ui/touch-target.ts:44`.

**Current state.** The two components stack in the same panel and must line up. `SidebarRow`
expresses the axis as a variant:

```ts
// sidebar-row.tsx:152
pointer: { fine: 'min-h-7', coarse: TOUCH_TARGET_MIN_H },
```

`SectionHeader` — same directory, same panel, same `pointer` derivation
(`section-header.tsx:214`, `isMobile ? 'coarse' : 'fine'`) — keeps two private records instead:

```ts
// section-header.tsx:36
const SECTION_HEADER_HEIGHT = { fine: 'h-7', coarse: 'h-11' } as const;
// :55-58
const SECTION_HEADER_GUTTER = { fine: { one: …, two: 'pr-14' }, coarse: { one: …, two: 'pr-22' } };
```

and carries a third visual axis, `emphasized`, as a bare `&&` at `:223`, plus a fourth,
`hasSectionAction`, as a ternary inside a ternary at `:319,323`.

**Why it falls short.** Two things. First, the two files disagree in a way nothing would catch:
the row's floor is `min-h-7`/`min-h-11` (it may grow — a two-line row does) while the header's is
`h-7`/`h-11` (fixed). Second, `sidebar-row.tsx`'s own docblock (`:127-138`) argues at length that
the coarse heights "have to be equal, not merely both ≥40", because the kebab is absolutely
positioned inside the row — and the header draws the same kebab
(`section-header.tsx:319`, `kebabClassName`) from a number kept in a different file. The
`SIDEBAR_ROW_GUTTER`-stays-out-of-the-cva reasoning at `sidebar-row.tsx:135-138` is the only part
that genuinely cannot be a variant; the height is not covered by it.

**Recommendation.** Give `SectionHeader` a `sectionHeaderVariants` cva with the same three axis
names the row uses — `pointer`, plus `emphasized` and `action` as rungs rather than conditions —
and source the `coarse` height from `TOUCH_TARGET_MIN_H` exactly as the row does, so the two
cannot drift. Keep `SECTION_HEADER_GUTTER` outside it, for the reason the row already documents
for its own gutter. Two records become one variant table; the `&&` and the nested ternary go.

---

### [P2/S] `PromptSuggestionChips` states its one size axis twice — a size table for the button and a ternary for the icon

**Files.** `apps/client/src/layers/shared/ui/PromptSuggestionChips.tsx:17-23,98-103`.

**Current state.** Unchanged since September, so this is a re-measurement rather than a restatement:

```ts
const SIZES: Record<PromptSuggestionChipSize, string> = {
  compact: 'max-w-[200px] gap-1.5 px-2.5 py-1 text-xs',
  comfortable: 'min-h-9 max-w-[280px] gap-2 px-3 py-1.5 text-sm',
};
```

and then, 80 lines later, inside the render:

```tsx
<Sparkles className={cn('shrink-0', size === 'compact' ? 'size-3' : 'size-3.5')} />
```

**Why it falls short.** Two DOM elements answering one axis is the exact shape ADR-0097 adopted
`tailwind-variants` for, and `switch.tsx:83-91` is now the working proof in this same directory
that it reads well here. Today the axis is implicit: nothing types the icon's branch against
`PromptSuggestionChipSize`, so adding a third size compiles with the icon silently falling into
the `comfortable` half of a boolean ternary. The prop's own TSDoc (`:9-16`) is excellent and
explains what each size is FOR; it just describes a relationship the code does not encode.

**Recommendation.** One `tv({ slots: { chip, icon }, variants: { size: { compact: {…}, comfortable: {…} } } })`,
with the button recipe moving out of the inline `cn()` at `:99` and the two icon sizes moving
beside their button sizes. Same output, one table, and a third size becomes one row. Keep the
TSDoc verbatim.

---

### [P3/S] Three cva primitives still do not export their variants object, and `SettingRow` pays for one of them in a ternary

**Files.** `apps/client/src/layers/shared/ui/field.tsx:104-121,322-332` (`fieldVariants`) ·
`shared/ui/page-container.tsx:14-22` (`pageContainerVariants`) ·
`shared/ui/sidebar.tsx:490` (`sidebarMenuButtonVariants`) · the cost:
`shared/ui/setting-row.tsx:52-59` · `.claude/rules/components.md` §Required Patterns ·
`shared/ui/__tests__/barrel-props-exports.test.ts:1-14` ·
`shared/ui/alert-dialog.tsx:153,163,177`.

**Current state.** Fourteen files in `shared/ui` define a variant object. Nine export it
(`button`, `badge`, `card`, `banner`, `empty-state`, `spinner`, `mention-pill`, `sidebar-row`,
`switch`), and `identity-avatar` and `responsive-sheet` export theirs through the barrel. Three
do not: `fieldVariants`, `pageContainerVariants`, `sidebarMenuButtonVariants`. September counted
two; `sidebar.tsx` is the third.

`SettingRow` is the concrete cost, unchanged since September. It passes `orientation` down to
`Field` and then adds its own ternary for the same axis on top:

```tsx
// setting-row.tsx:53-57
<Field orientation={orientation} className={cn(
  orientation === 'horizontal' ? 'items-center justify-between gap-4' : 'gap-1.5', className)}>
```

**Why it falls short.** The rule states the export as required for this directory, and
`alert-dialog.tsx:163,177` is the live demonstration of why — it styles its Action and Cancel by
calling `buttonVariants()` / `buttonVariants({ variant: 'outline' })` rather than nesting a
`Button`, and its docblock at `:153` teaches callers to do the same. Two more files reach for an
exported variant object the same way: `BridgeVisibilityBadge.tsx:76` and
`lexical-nodes.ts:151`, the latter building a class string for a Lexical DOM node where there is
no component to render at all. There is a test that walks the real
barrel and pins every component's `*Props` type; there is no equivalent for `*Variants`, which is
why this gap survived a sweep that closed its neighbours.

**Recommendation.** Export all three from their files and from the barrel, then fold
`SettingRow`'s ternary into `fieldVariants` as `orientation`'s own rungs, deleting it. Extend
`barrel-props-exports.test.ts` with the same walk for `*Variants` — it already parses the barrel
and the sources, so this is a second `describe` in a file that does all the hard work already,
and it is what stops the count going back up.

---

### [P3/S] `PresetPill` is three independent boolean visual props and a size token the rules ban by name

**Files.** `apps/client/src/layers/entities/agent/ui/PresetPill.tsx:19-27,35-37,45-55` ·
`.claude/rules/components.md` §Required Patterns ("Sizes are one ordinal scale") ·
compare `shared/ui/badge.tsx:14-17` (`shape: 'pill'`) · also
`features/tasks/ui/TaskRow.tsx:39` and `features/marketplace/ui/PackageCard.tsx:44`.

**Current state.**

```ts
active?: boolean;        // @default false
size?: 'sm' | 'default'; // @default 'default'
glow?: boolean;          // @default false
gradientText?: boolean;  // @default false
```

resolved by a ternary and two `&&`s inside one `cn()` (`:48-55`) plus a nested inline `style`
object (`:56-66`). No cva, no `data-slot`, and the pill geometry
(`inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium`) is written out
rather than taken from `Badge shape="pill"`, which exists for precisely this
("The pill was the shape four components wanted and could not get" — `badge.tsx:11-13`).

**Why it falls short.** `size: 'sm' | 'default'` is the one spelling the rules retire by name:
"No token named `default`: it says nothing about how big the thing is, and `<Button
size="default">` beside `<Switch size="md">` used to be two controls that did not line up
(DOR-1761)." Sweep 9 finds it surviving in exactly three places — here, `TaskRowSize` at
`TaskRow.tsx:39` (`'default' | 'compact' | 'minimal'`), and `PackageCard`'s `variant` at `:44`,
whose governing ADR-0250 is **deprecated** as of 2026-08-06, so nothing settles it any more.
`glow` and `gradientText` are also not independent of `active` — both are only read inside the
`active` branch (`:57-64,70`), so two of the three booleans are unreachable when the third is
false, which is a state the type system currently permits and the render silently ignores.

**Recommendation.** Rename the size rung `md` in all three components — six JSX call sites in
total (`PersonalityPicker.tsx:163`, `TasksPanel.tsx:192`, `TasksList.tsx:139`,
`TaskListPanel.tsx:107`, `FeaturedRail.tsx:68`, `PackageGrid.tsx:158`), and the pixels do not
move — and give `PresetPill` a cva with `size` and one `state: 'rest' | 'active' |
'glowing'` axis replacing the three booleans, so the unreachable combinations stop being
expressible. The dynamic gradient genuinely needs inline `style` — it is computed from a
per-preset colour — so that stays; only the class half moves into the variant table. If the pill
geometry then matches `Badge shape="pill"`, compose it and delete the recipe.

---

### [P3/S] `PathBreadcrumb`'s size axis is three parallel expressions, and each segment hand-rolls a button

**Files.** `apps/client/src/layers/shared/ui/path-breadcrumb.tsx:14,34-36,55-60,69-79`.

**Current state.** One `size?: 'sm' | 'md'` prop, answered in three separate places:

```ts
const textClass = size === 'sm' ? 'text-2xs' : 'text-xs';
const chevronClass = 'size-(--size-icon-xs)'; // does not vary at all
const maxWidth = size === 'sm' ? 'max-w-[80px]' : 'max-w-[120px]';
```

then a fourth branch on `isLast` at `:59`, and an interactive segment that renders a raw
`<button>` with `'hover:bg-accent rounded px-1 py-0.5 transition-colors'` (`:70-76`) rather than
`<Button variant="ghost" size="xs">`.

**Why it falls short.** The charter names this primitive by name as one of the two the overflow
rules reach for, so it is load-bearing. A caller reading the props sees one axis; a maintainer
adding a third size edits two consts and remembers the `chevronClass` that deliberately does not
move. The hand-rolled segment button also means the one part of a breadcrumb a person actually
clicks has neither the shared `focus-visible` ring nor a touch height.

**Recommendation.** One `pathBreadcrumbVariants` cva with `size` driving the label class and the
max-width together, and `<Button variant="ghost" size="xs" className="h-auto px-1 py-0.5">` for
the clickable segment. Leave `chevronClass` as the constant it already is — a fixed value that a
comment can state is fixed beats a variant rung that never varies.

---

### [P3/S] `CollapsibleCard`'s three-value variant emits two distinct classes, written as three conditions

**Files.** `apps/client/src/layers/features/chat/ui/primitives/CollapsibleCard.tsx:14-15,64-66`.

**Current state.**

```tsx
variant === 'default'  && 'border-l-muted-foreground/30',
variant === 'thinking' && 'border-l-muted-foreground/20',
variant === 'memory'   && 'border-l-muted-foreground/20',
```

**Why it falls short.** Two of the three rungs are byte-identical, so the axis has two visual
values wearing three names — and stated as three `&&` conditions there is nothing to notice that
from. This is the transcript's tool/thinking/memory card, one of the most-rendered components in
the app, so the axis will be asked to grow. As conditions, a fourth value means a fourth line and
a fourth chance to paste the same alpha.

**Recommendation.** A three-rung `cva` on the card root. If `thinking` and `memory` are meant to
be the same weight, say so in the table by giving them one shared rung name and mapping both
inputs onto it — one rung, two callers — which is the simplification; if they were meant to
differ and one was pasted, the table makes that visible in a way three `&&`s never will.

---

## Counts

| Severity | Count |
| -------- | ----- |
| P1       | 0     |
| P2       | 6     |
| P3       | 4     |

Effort: 3×M, 7×S, 0×L. **Nine of the ten findings delete more than they add** — five class
tables (F2), three class strings and three constants (F1), six attributes (F4), two records
(F5), a ternary (F8), three booleans (F7).

**Zero P1, on a lens with no browser leg — and that is a real result, not a degraded one.** The
September run of this lens filed two P1s; both are closed, and I opened both files to confirm it.
Every finding below P1 here is structural and provable from source, so nothing was capped by the
charter's visual-inference rule. The one finding with a visible consequence, F6's 36px phone
target, is arithmetic off `touch-target.ts` rather than a measurement, and is filed P2 for that
reason. The bigger result is the ratio: fourteen of September's twenty-two findings are closed
outright, and the four largest remaining defects (F1, F3, F5, F8) are all **half-finished
conversions** — one filter-bar trigger of four, one tone record of five, one sidebar component of
two, nine variant exports of twelve. That is the shape this lens should watch next run.
