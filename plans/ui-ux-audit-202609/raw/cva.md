# Lens 2 — Composition & CVA

Auditor lens: are variants expressed via `class-variance-authority` where a component has ≥2 visual
variants? Prop-driven className spaghetti; boolean-prop explosions that should be variants; missing
`asChild`/slot patterns; primitives that fight Radix instead of wrapping it; components that should
compose smaller primitives.

## Coverage

**Ground truth read first:** `plans/ui-ux-audit-202609/00-charter.md`, `contributing/design-system.md`
(pp. 1–539 in full + targeted greps of the rest), `.claude/rules/fsd-layers.md`,
`.claude/rules/components.md`, `AGENTS.md`, and `decisions/0097-adopt-tailwind-variants-for-multi-slot-components.md`
(the only ADR in `decisions/` that governs this lens).

**`apps/client/src/layers/shared/ui` — 96 entries, ~13k lines of non-test source.**

Read line-by-line (78 files): `button`, `badge`, `banner`, `field`, `mention-pill`, `page-container`,
`responsive-sheet`, `card`, `identity-avatar`, `trust-dial`, `trust-tone`, `status-dot`,
`segmented-control`, `section-header`, `bar-tab-strip`, `option-row`, `setting-row`, `field-card`,
`compact-result-row`, `provenance-chip`, `feed`, `floating-panel`, `bottom-slot`, `tabbed-dialog`,
`responsive-dialog`, `responsive-popover`, `dialog`, `drawer`, `sheet`, `dropdown-menu`, `popover`,
`select`, `tabs`, `table`, `alert-dialog`, `input`, `textarea`, `checkbox`, `switch`, `slider`,
`progress`, `radio-group`, `label`, `separator`, `scroll-area`, `tooltip`, `hover-card`,
`collapsible`, `skeleton`, `kbd`, `inline-code`, `sonner`, `navigation-layout`, `data-table`,
`sidebar-row`, `use-roving-tab-list`, `touch-target`, `copy-button`, `bounded-number-input`,
`password-input`, `path-input`, `path-breadcrumb`, `settings-panel`, `truncated-output`,
`unverified-catalog-notice`, `FeatureDisabledState`, `ConnectionStatusBanner`,
`PromptSuggestionChips`, `ScanLine`, `hover-border-gradient`, `not-found-fallback`,
`permission-mode-scope-note`, `link-safety-modal`, `unattended-autonomy-dialog`, all 7
`form-fields/*` + barrel, all 7 `filter-bar/*` + barrel.

Read in part (key sections + structured greps for variant tables, class ternaries, `data-slot`,
bare `focus:`, `asChild`): `sidebar.tsx` (753 ln), `sidebar-menu-node.tsx` (1005 ln),
`context-menu`, `responsive-context-menu`, `responsive-dropdown-menu`, `identity-hover-card`,
`DirectoryPicker`, `command`, `markdown-content`, `markdown-link`, `markdown-error-boundary`,
`linkified-text`, `input-otp`, `app-crash-fallback`, `route-error-fallback`, `consent-ritual-copy`,
`identity-glyphs`, `index.ts`, `tour-spotlight/*`. **Not opened at all:** `__tests__/*` (out of lens).

**Feature/entity/widget sample — 16 components read**, chosen to cover both the good and the bad
patterns: `features/marketplace/ui/PackageTypeBadge.tsx`, `features/marketplace/ui/PermissionPreviewSection.tsx`,
`features/gen-ui/lib/widget-tone.ts`, `features/chat/ui/chips/ChipTray.tsx`,
`features/chat/ui/chips/TouchChip.tsx`, `features/inbox/ui/InboxRow.tsx`,
`features/agent-settings/ui/McpServerCard.tsx`, `features/settings/ui/runtimes/GlobalTrustRow.tsx`,
`features/conversation/ui/message/message-variants.ts`, `features/conversation/ui/message/MessageActions.tsx`,
`features/mesh/ui/AdapterNode.tsx`, `features/mesh/ui/TopologyPanel.tsx`,
`features/marketplace/ui/MarketplaceSidebar.tsx`, `entities/room/ui/LoudnessMeter.tsx`,
`entities/agent/ui/AgentIdentity.tsx`, `entities/agent/ui/AgentAvatar.tsx`.
Plus three repo-wide structured greps over all 940 component files: every `<Badge` call site (104,
of which 71 override `className`), every `Record<…, string> = {` class table outside `shared/ui` (41),
and every file rendering a raw `<button>` without importing `Button` (40+).

**Skipped, and named so the gap is visible:** the `dev/` playground's 92 showcase files (lens 6 owns
them), `apps/site`, `apps/obsidian-plugin`. I did not run the app or a browser; every finding is
read off source.

**What is already excellent, and should not be "fixed":** `identity-avatar.tsx` (a five-axis cva with
real `compoundVariants` and a documented per-axis derivation), `mention-pill.tsx` (`compoundVariants`
for the hover cross-product), `banner.tsx`, `message-variants.ts` (the one correct `tv({slots})` use),
`McpServerCard.tsx` (three cva calls for three genuinely independent elements), `LoudnessMeter.tsx`,
`sidebar-menu-node.tsx`'s `VARIANT_SLOTS` component table. These are the bar the findings below
measure everything else against.

---

## Findings

### [P1/M] `LinkSafetyModal` hand-rolls a modal beside the `Dialog` primitive, and loses focus trap, focus restore, scroll lock and Escape

**Files:** `apps/client/src/layers/shared/ui/link-safety-modal.tsx:52-125`, compare
`apps/client/src/layers/shared/ui/dialog.tsx:27-48`, `apps/client/src/layers/shared/ui/alert-dialog.tsx:25-41`

**Current state.** The app's single link-confirmation surface — reached from every markdown link in
every answer (`MarkdownLink`), from gen-UI `url` actions and from MCP App iframes — is a bare
`createPortal` into `document.body`:

```tsx
// link-safety-modal.tsx:52-70
return createPortal(
  <div className="fixed inset-0 z-50 flex items-center justify-center" …>
    <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
    <div
      className="bg-background relative mx-4 flex w-full max-w-md flex-col gap-4 rounded-xl border p-6 shadow-lg"
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}
      role="dialog" aria-modal="true" aria-label={…} tabIndex={-1}
    >
```

**Why it falls short.** `aria-modal="true"` is a claim the markup does not keep. Nothing focuses the
container (`tabIndex={-1}` makes it focusable but no `.focus()` or `autoFocus` ever runs), so a
keyboard user who activates a link keeps focus on the anchor **behind** the overlay: `Escape` never
reaches the `onKeyDown` handler, `Tab` walks the page underneath, and the backdrop is a `<div>` with
an `onClick` rather than a real dismissal layer. There is no scroll lock and no focus restore on
close. Radix's `Dialog` — sitting in the same folder, already wrapped as `DialogContent`, already
portalling — provides every one of those for free. The file's own docblock justifies only the
_portalling_ ("to escape transform-based containing blocks"), which `DialogPortal` also does; nothing
in `decisions/` or `specs/` requires a hand-rolled dialog here. `.claude/rules/components.md`
("Composition: Radix + `asChild`") points the other way.

**Recommendation.** Re-express it as `<Dialog open={isOpen} onOpenChange={…}><DialogContent>` with
`DialogTitle`/`DialogDescription` carrying the `title`/`detail` strings it already computes, keeping
the Streamdown-compatible `LinkSafetyModalProps` signature unchanged so the three call sites do not
move. The three hand-rolled buttons inside become `<Button variant="outline">` / `<Button>` (see the
icon-button finding below). No visual change is intended — this is the same box with the behaviour
it already claims to have.

---

### [P1/S] `FilterBarSort` nests an interactive `<span role="button">` inside a Radix trigger button, and the direction toggle is unreachable by keyboard

**File:** `apps/client/src/layers/shared/ui/filter-bar/FilterBarSort.tsx:37-61`

**Current state.**

```tsx
<DropdownMenuTrigger data-slot="filter-bar-sort" className="… inline-flex h-7 …">
  Sort: {currentLabel}
  <span
    role="button"
    tabIndex={-1}
    onClick={toggleDirection}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { … } }}
    aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
  >
```

**Why it falls short.** `DropdownMenuTrigger` renders a real `<button>`, so this is a button nested
in a button — invalid HTML that browsers unnest unpredictably, and exactly the defect `SidebarRow`'s
`trailingAction` docblock (`sidebar-row.tsx:322-364`) exists to make unrepeatable. Worse, the nested
control is `tabIndex={-1}`, so **the ascending/descending toggle has no keyboard path at all**: the
`onKeyDown` it carries can never fire, because focus can never land there, and the Enter/Space that
does reach the trigger is consumed by Radix to open the menu. Reversing a sort is a primary list
operation with no keyboard equivalent anywhere else in the bar. It also fails the "hover-revealed
chrome always has two other paths" rule in `contributing/design-system.md` §Accessibility contract.

**Recommendation.** Split the two controls: render the trigger with `asChild` over a
`<Button variant="outline" size="xs">` for "Sort: {label}", and put the direction toggle **beside**
it as its own `<Button variant="ghost" size="icon-xs" aria-label=…>` sibling, not inside it. Both
then get a real tab stop, the shared `focus-visible` ring, and the responsive touch height.

---

### [P2/L] Variant-shaped code across `shared/ui` bypasses `cva`/`tv`, against both `.claude/rules/components.md` and ADR-0097

**Files (all cited lines read):**
`switch.tsx:7-32,44-65` · `PromptSuggestionChips.tsx:20-23,98-102` · `path-breadcrumb.tsx:29-31,43-48` ·
`copy-button.tsx:44` · `section-header.tsx:33,52-55,182-190` · `sidebar-row.tsx:125,556-563` ·
`ConnectionStatusBanner.tsx:35-47` · `ScanLine.tsx:32-36` · `sheet.tsx:60-70` ·
`filter-bar/FilterBarPrimary.tsx:46-47` · `filter-bar/FilterBarSort.tsx:41` ·
`filter-bar/FilterBarAddFilter.tsx:284` · `filter-bar/FilterBarActiveFilters.tsx:81,136` ·
`option-row.tsx:26-30` · `provenance-chip.tsx:84-91` · `field-card.tsx:78-80` ·
`navigation-layout.tsx:329-333,351-357`

**Current state.** `.claude/rules/components.md` §Required Patterns is explicit for this directory:
"**Shadcn primitives** (`layers/shared/ui/`): follow the existing files — `cva` variants,
`data-slot="component-name"` attribute on the root element, `cn()` for class merging, export both the
component and its `componentVariants`." Eight files in `shared/ui` do this (`button`, `badge`,
`banner`, `field`, `identity-avatar`, `mention-pill`, `page-container`, `responsive-sheet`, plus
`sidebar`). At least seventeen other multi-variant components express the same shape three other
ways instead:

- **Hand-maintained `Record<Size, string>` lookup tables** — `switch.tsx:13-25` (`TRACK_SIZES` +
  `THUMB_SIZES`), `PromptSuggestionChips.tsx:20-23` (`SIZES`), `section-header.tsx:33,52-55`
  (`SECTION_HEADER_HEIGHT`, `SECTION_HEADER_GUTTER`), `sidebar-row.tsx:125` (`SIDEBAR_ROW_HEIGHT`).
- **Inline ternaries on a prop** — `path-breadcrumb.tsx:29-31` (three `size === 'sm' ? … : …` in a
  row), `copy-button.tsx:44`, `ScanLine.tsx:32-36`, `ConnectionStatusBanner.tsx:37-39,43-46`,
  `sheet.tsx:62-69` (four `side === 'x' &&` branches), `option-row.tsx:28-29`,
  `provenance-chip.tsx:86-89`, `navigation-layout.tsx:354-356`.
- **A whole class string duplicated per branch** — `link-safety-modal.tsx:94-98` selects between two
  ~15-class strings with a ternary; the four filter-bar triggers repeat
  `inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs` verbatim in four files.

**Why it falls short.** Three consequences, all observable in the current source. (1) The variant
system is implicit: nothing types `size` against the table, so `PromptSuggestionChips` has to restate
its axis a second time on the icon (`size === 'compact' ? 'size-3' : 'size-3.5'`, line 102) and the
two can drift. (2) `cn()`/tailwind-merge does not run over a template-literal concatenation —
`path-breadcrumb.tsx:46-48` builds `labelClass` with backticks, so a caller could never override it
and conflicting utilities would both reach the DOM. (3) Cross-component drift: the four filter-bar
chips are the same control drawn four times, and the day one grows a focus ring the other three will
not. ADR-0097 (accepted, not superseded) already settled the tooling: "CVA remains for single-element
shadcn primitives" and `tailwind-variants` `tv({slots})` for multi-slot components.

**Recommendation.** One pass per component, no design change:

- Move each `Record<…, string>` table into a `cva()` `variants` block and keep the exported
  `componentVariants` the rule asks for.
- Convert the four filter-bar triggers into one `filterTriggerVariants` cva exported from
  `filter-bar/`, or better: `<Trigger asChild><Button variant="outline" size="xs">`.
- `sheet.tsx`'s `side` is upstream shadcn's shape — convert it last, and only together with an
  upstream-sync note, since it is the one case where diverging costs future merges.

---

### [P2/M] `Switch` is a two-slot component with one shared axis — the exact case ADR-0097 adopted `tailwind-variants` for — and it hand-rolls four string tables instead

**File:** `apps/client/src/layers/shared/ui/switch.tsx:7-65`

**Current state.** The track and the thumb both respond to one `size` axis, and the thumb's translate
distance must stay in lockstep with the track's width. That relationship is currently maintained by
hand across four constants, one of which is built by **string concatenation across three
breakpoints**:

```ts
const RESPONSIVE_THUMB =
  'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 ' +
  'sm:h-5 sm:w-5 sm:data-[state=checked]:translate-x-5 ' +
  'md:h-4 md:w-4 md:data-[state=checked]:translate-x-4';
```

and selected with `isResponsive ? RESPONSIVE_TRACK : TRACK_SIZES[resolvedSize]` at lines 53 and 60.

**Why it falls short.** ADR-0097 names this shape precisely: "TV is used when a component has multiple
DOM elements that need to respond to the same variant axes simultaneously." The ADR is accepted and
`tailwind-variants@^3.3.1` is already a dependency — but it is used in exactly **one** file in the
whole client (`features/conversation/ui/message/message-variants.ts`), so the decision was implemented
for `MessageItem` and never reached the primitive that needs it most. Meanwhile `sm`'s translate
(`translate-x-3` on a `w-7` track with a `w-3` thumb) and `lg`'s (`translate-x-7` on `w-14`/`w-6`) are
derived by hand and nothing checks them.

**Recommendation.** `export const switchVariants = tv({ slots: { root, thumb }, variants: { size: {…}, responsive: {…} } })`,
with the responsive breakpoints as a second axis rather than an `isResponsive` boolean short-circuit.
`Switch` then reads `const { root, thumb } = switchVariants({ size, responsive })`. Same output, one
place where a size and its travel are stated together.

---

### [P2/M] Six components carry an independent `responsive?: boolean` prop, each with its own hand-written breakpoint table

**Files:** `button.tsx:44-59,64` · `input.tsx:5-6,17` · `select.tsx:10-14,24` and `select.tsx:67-71,81` ·
`tabs.tsx:7-9,17` · `switch.tsx:28-32,41`

**Current state.** Every one of these declares its own `responsive` flag and then answers the same
question — "is this a thumb-sized target below `md`?" — with its own numbers:
`RESPONSIVE_SIZE_CLASSES` (a `Partial<Record<ButtonSize, string>>` covering six of eight sizes),
`responsive ? 'h-11 md:h-9' : 'h-9'` (Input, SelectTrigger), `responsive ? 'py-3 md:py-1.5' : 'py-1.5'`
(SelectItem), `responsive ? 'h-11 md:h-9' : 'h-9'` (TabsList), and Switch's three-breakpoint string.
Separately, `touch-target.ts` exports `TOUCH_TARGET_MIN_H = 'min-h-11'` as "the smallest a control may
be under a thumb, spelled once", and `SIDEBAR_ROW_HEIGHT` / `SECTION_HEADER_HEIGHT` answer the same
question a third way with a `{ fine, coarse }` record.

**Why it falls short.** The touch floor is one product decision (`design-system.md` §Spacing, P4 AC-4)
recorded in five different vocabularies, and `Button`'s own comment (`button.tsx:46-52`) is the only
place that explains what the gate actually means. `SelectItem`'s 44px-equivalent is expressed as
padding while `SelectTrigger`'s is a height, so a "compact" select is compact in one half and not the
other. A `responsive` boolean is also a variant wearing a boolean's clothes: `responsive={false}`
appears 6 times in `filter-bar/` alone, always meaning "this is chrome, not a target" — which is a
named density, not a negation.

**Recommendation.** Introduce one axis name — `density: 'touch' | 'compact'` (default `touch`) — as a
cva variant on each primitive, sourced from one shared table so the breakpoint and the height live in
one file. Keep `responsive` as a deprecated alias for exactly one release if call-site churn is a
concern; there are ~20 call sites.

---

### [P2/M] `Badge` has one axis and no `size`/`tone`, so 71 of its 104 call sites hand-tune `className` — and the app now has four different badge type sizes

**Files:** `apps/client/src/layers/shared/ui/badge.tsx:5-29`; call sites incl.
`features/mesh/ui/TopologyPanel.tsx:38,48,92,96` (`text-xs`), `features/mesh/ui/AdapterNode.tsx:128`
(`text-[10px]`), `features/mesh/ui/AgentHealthDetail.tsx:117,132` (`text-[0.625rem]`),
`features/mesh/ui/AgentNode.tsx:100,104,109,225` (`text-[10px]`),
`features/marketplace/ui/PackageTypeBadge.tsx:68-77`

**Current state.** `badgeVariants` has exactly one axis (`variant`: default/secondary/destructive/
outline) and a fixed `text-xs`. Measured across the client: **104 `<Badge` call sites, 71 of which
pass `className`** — and the overwhelming majority of those overrides are re-stating a size
(`text-xs`, `text-[10px]`, `text-[0.625rem]`, `text-[11px]`) or a tone
(`text-muted-foreground`, status colours, raw palette).

**Why it falls short.** A primitive that two-thirds of its consumers have to correct is not a
primitive, it is a starting point. The concrete cost is a type ramp the design system does not have:
`text-[0.625rem]` and `text-[10px]` are the same 10px written two ways, one file apart in the same
feature. It also violates the rule's own anti-pattern example ("NEVER skip className merging" is
satisfied, but the spirit — express the variation as a variant — is not).

**Recommendation.** Add two axes to `badgeVariants`: `size: 'xs' | 'sm'` (10px / 12px, the two that
actually exist) and `tone: 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'brand'` sourced from
the `--status-*` tokens that `banner.tsx:17-22` and `features/gen-ui/lib/widget-tone.ts:9-15` already
map. Then sweep the 71 call sites; most collapse to `<Badge size="xs">` or `<Badge tone="warning">`.

---

### [P2/S] `Badge` renders a hard `<div>` with no `asChild`, so it cannot be a link and is invalid inside a paragraph

**File:** `apps/client/src/layers/shared/ui/badge.tsx:23-28`

**Current state.** `function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> …)`
returning `<div className={cn(badgeVariants({ variant }), className)} {...props} />`. No `data-slot`,
no `asChild`, no `Slot.Root`.

**Why it falls short.** `.claude/rules/components.md` names Radix + `asChild` as _the_ composition
pattern for this codebase (~144 uses), and every sibling primitive that can be a trigger supports it
(`Button` at `button.tsx:76`, `SidebarMenuSubButton` at `sidebar.tsx:706`). A badge is routinely a
link ("3 overrides" opening a panel), a `<span>` inside running prose, or a `TooltipTrigger` — and
today each of those needs a wrapper element, which changes the layout. A block `<div>` inside a
`<p>` is also invalid HTML that React will happily render.

**Recommendation.** Match the current upstream shadcn badge: `asChild?: boolean`,
`const Comp = asChild ? Slot.Root : 'span'`, `data-slot="badge"`, and swap the base element from
`div` to `span`. Also replace the bare `focus:ring-2 focus:ring-ring focus:ring-offset-2` on line 6
with `focus-visible:` (see the focus finding).

---

### [P2/M] Shared primitives hand-roll icon buttons instead of composing `Button`, duplicating the same six-utility recipe eight times

**Files:** `floating-panel.tsx:218-235` (two identical strings) · `copy-button.tsx:46-52` ·
`path-input.tsx:52-61` · `truncated-output.tsx:48-54` · `link-safety-modal.tsx:73-80,93-107,112-120` ·
`responsive-dialog.tsx:219-230` · `responsive-popover.tsx:132-135` ·
`filter-bar/FilterBarActiveFilters.tsx:139-146` · `features/chat/ui/chips/ChipTray.tsx:104-125`

**Current state.** `FloatingPanel` writes the same 11-utility string twice, 8 lines apart:

```tsx
// floating-panel.tsx:222-223 and :231-232, byte-identical
className =
  'text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring inline-flex items-center justify-center rounded-md p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none';
```

`CopyButton` writes a near-miss of the same recipe, `PathInput`'s Browse writes a third, and
`LinkSafetyModal` writes three more. `Button` already encodes all of it as
`variant="ghost" size="icon-sm"` — with, additionally, the responsive touch height these do not get.

**Why it falls short.** Nine hand-rolled icon buttons in `shared/ui` is nine places the focus ring,
the disabled state and the 44px mobile floor have to be remembered. Two of them already forgot the
floor (`copy-button.tsx` is `p-1` around a 14px glyph ≈ 22px; `path-input.tsx`'s Browse is
`px-3 py-2`), which the mobile touch sweep would reject, and two forgot `focus-visible` entirely in
favour of bare `focus:`. `shared/ui` is allowed to import `shared/ui` — `not-found-fallback.tsx:16`
and `password-input.tsx:45` already do exactly this correctly.

**Recommendation.** Replace each with `<Button variant="ghost" size="icon-sm" aria-label=…>` (or
`icon-xs` where 24px is genuinely wanted, with the `responsive={false}` opt-out stated). Where the
button wraps a Radix `Close`/`Trigger`, use `asChild`. `ChipTray`'s filter toggles want
`<Button variant="outline" size="xs" aria-pressed=…>` rather than their own bordered-pill string.

---

### [P2/S] `CollapsibleFieldCard` restates `FieldCard`'s class string instead of composing it

**File:** `apps/client/src/layers/shared/ui/field-card.tsx:11-19` vs `:66-70`

**Current state.**

```tsx
// FieldCard, line 15
className={cn('bg-card overflow-hidden rounded-lg border', className)}
// CollapsibleFieldCard, line 69 — same file, same string, hand-copied
className={cn('bg-card overflow-hidden rounded-lg border', className)}
```

Both are exported from the same module, and the collapsible one already composes `FieldCardContent`
on line 84.

**Why it falls short.** The whole point of the pair is that a collapsible field card _is_ a field
card. Restating the frame means a change to the card's surface (a radius token, a shadow, the
`bg-card` decision) lands in one of two places. It is a four-line fix that removes a whole class of
future drift.

**Recommendation.** `<FieldCard className={className} data-slot="collapsible-field-card">` wrapping
the trigger and content. Keep the distinct `data-slot`, drop the duplicated string.

---

### [P2/S] `ConnectionStatusBanner` re-implements `Banner`'s severity ladder next door, with raw palette colours

**Files:** `apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx:34-51` vs
`apps/client/src/layers/shared/ui/banner.tsx:15-25,70-127`

**Current state.** `ConnectionStatusBanner` picks between two hardcoded palette pairs with a ternary:

```tsx
isDisconnected
  ? 'bg-red-500/10 text-red-600 dark:text-red-400'
  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
```

and hand-picks the icon with a second ternary. Eleven files away, `banner.tsx` is a cva with a
documented four-rung severity ladder (`critical`/`warning`/`info`/`neutral`), per-variant icons
(`VARIANT_ICON`), the correct `role="alert"` vs `role="status"` split, `--status-*` tokens calibrated
for both themes and the Obsidian bridge, and a dismiss slot.

**Why it falls short.** `design-system.md` §Banners is unambiguous that `Banner` is _the_ full-width
standing-condition surface and that "Colors come from the `--status-*` tokens, so light/dark and the
Obsidian bridge stay correct". A lost server link is textbook `critical`; reconnecting is `warning`.
The raw `red-500`/`amber-500` also bypasses the `--status-warning-dot` contrast work documented in
`status-dot.ts:43-51`. And `ConnectionStatusBanner` announces nothing — no `role`, no `aria-live` —
so a screen-reader user is never told the link dropped, which `Banner` would have supplied.

**Recommendation.** `<Banner variant={isDisconnected ? 'critical' : 'warning'} icon={isDisconnected ? WifiOff : Wifi}>`.
Keep the component as the thin wrapper that maps `ConnectionState` → variant + sentence; delete the
class ternary.

---

### [P2/S] `PathInput` re-implements `Input`'s recipe rather than composing it

**File:** `apps/client/src/layers/shared/ui/path-input.tsx:32-48`

**Current state.** The container copies `Input`'s border/background/shadow recipe
(`dark:bg-input/30 border-input … shadow-xs transition-[color,box-shadow]`) and moves the focus ring
to `focus-within:`; the inner `<input>` then re-writes the placeholder colour, the `h-11 md:h-9`
responsive height and the disabled treatment by hand.

**Why it falls short.** It is `Input`'s recipe minus the parts that were forgotten: no
`aria-invalid:` styling, no `selection:` colours, no `file:` handling, no `text-base md:text-sm`
mobile-zoom guard. When `Input` next changes (it has a `responsive` flag today that this will not
inherit), the path field silently stops matching every other field in the app.

**Recommendation.** Keep the wrapper for the divider + Browse zone, but render `<Input>` inside it
with `className="border-0 bg-transparent shadow-none focus-visible:ring-0"`, so the field's own
recipe stays one file. Browse becomes `<Button variant="ghost" size="sm">`.

---

### [P2/S] Three shared primitives accept no `className` and spread no rest props, so they cannot be placed

**Files:** `option-row.tsx:3-14,25-31` · `compact-result-row.tsx:1-12,23-26` · `path-breadcrumb.tsx:3-12,33`

**Current state.** `OptionRow` takes `isSelected`, `isFocused`, `control`, `children` and a
`'data-selected'?: boolean` — and nothing else; the caller cannot pass a margin, a `data-testid`, a
ref or an `id`. `CompactResultRow` works around exactly this with an index-signature hack
(`[key: \`data-${string}\`]: string | undefined`) so that *only* data attributes get through, and
hardcodes its whole surface (`bg-muted/50 rounded-msg-tool shadow-msg-tool border px-3 py-1`).
`PathBreadcrumb`has neither`className`nor a spread, and builds its classes with template literals
(lines 46-48) so`cn()`/tailwind-merge never runs.

**Why it falls short.** `.claude/rules/components.md` states the contract: "`cn()` … for all
conditional/merged classes; caller `className` goes last so it can override." A `shared/ui`
component that cannot be positioned by its host is not shareable — it forces a wrapper `<div>` at
every call site, which is how a component's spacing ends up being a property of whoever wrapped it.
`OptionRow`'s `isSelected` + `'data-selected'` pair is the same fact taken twice, which is a bug
waiting to be filed.

**Recommendation.** Give all three `React.ComponentProps<'div'>` (or `'span'`) with `className` last
in the `cn()` and `{...props}` on the root; delete `CompactResultRow`'s index-signature workaround
and `OptionRow`'s duplicate `data-selected` (derive it from `isSelected`); replace `PathBreadcrumb`'s
template literals with `cn()`.

---

### [P2/M] Roughly twenty `shared/ui` primitives carry no `data-slot` on their root, breaking the styling seam the newer files depend on

**Files (root element cited):** `badge.tsx:28` · `select.tsx:20,42` · `tabs.tsx:13,30,48` ·
`switch.tsx:50` · `dialog.tsx:16,33` · `drawer.tsx:21,51` · `dropdown-menu.tsx:16,37,49,64` ·
`setting-row.tsx:41` · `section-header.tsx:277` · `copy-button.tsx:46` · `option-row.tsx:25` ·
`compact-result-row.tsx:23` · `path-breadcrumb.tsx:33` · `provenance-chip.tsx:83` ·
`trust-dial.tsx:310` · `feed.tsx:70` · `PromptSuggestionChips.tsx:78` · `ConnectionStatusBanner.tsx:34` ·
`FeatureDisabledState.tsx:19` · `link-safety-modal.tsx:53` · `tabbed-dialog.tsx` (root)

**Current state.** 51 of the files in `shared/ui` contain no `data-slot` string at all. About twenty
of those are genuine primitives with a root element that should carry one; the rest are hooks,
contexts, or wrappers around something that already stamps its own.

**Why it falls short.** This is not cosmetic. `data-slot` is the styling and testing seam the newer
half of this folder is built on: `field.tsx:17,56,70-71,126` selects on
`has-[>[data-slot=checkbox-group]]`, `[&>[data-slot=field-label]]`, `has-[>[data-slot=field-content]]`;
`sidebar-row.tsx:623` and the sidebar browser tests address `[data-slot="sidebar-row-title"]` /
`[data-slot="sidebar-row-trailing-reservation"]`; `bar-tab-strip.tsx:164`'s scrollbar hiding is
implemented in `index.css` **by `data-slot` selector** because a utility class could not beat the
unlayered global. A primitive without the attribute cannot participate in any of that, and the
inconsistency means an author cannot tell by looking whether the seam exists. The rule states it as
a required pattern for this directory.

**Recommendation.** Add `data-slot="<kebab-name>"` to each root (and to the sub-parts of `dialog`,
`drawer`, `dropdown-menu`, `select`, `tabs`, which are the four families where every other menu/overlay
family in the folder already has them). Mechanical, one PR, no visual change; pair it with the
forwardRef migration below since it touches the same files.

---

### [P2/M] Two shadcn authoring dialects coexist in one folder, and the older one is the one the rule says not to add more of

**Files, old dialect (`React.forwardRef` + `displayName`):** `dialog.tsx:12,27,73,85` ·
`drawer.tsx:17,45,78,90` · `dropdown-menu.tsx:11,33,45,57,80,105,125,149` · `select.tsx:16,37,73` ·
`tabs.tsx:11,26,44` · `alert-dialog.tsx:10,25,65,77,89,97` · `switch.tsx:44` · `hover-card.tsx:20`
**New dialect (React-19 function component + `data-slot`):** `sheet.tsx` · `popover.tsx` ·
`checkbox.tsx` · `radio-group.tsx` · `label.tsx` · `separator.tsx` · `scroll-area.tsx` ·
`tooltip.tsx` · `collapsible.tsx` · `table.tsx` · `card.tsx` · `button.tsx` · `badge.tsx` ·
`slider.tsx` · `skeleton.tsx`

**Current state.** Roughly a 30/70 split. `.claude/rules/components.md` §Required Patterns:
"**React 19 refs**: `ref` is a regular prop — new components take `ref` in props, no `forwardRef`.
Existing `forwardRef` in `ui/` is fine; don't add more."

**Why it falls short.** The rule tolerates the old dialect but the folder is not converging on the
new one — it is frozen mid-migration, which `AGENTS.md` §Quality Standard names directly ("no
half-finished migrations… when something is superseded, remove it"). The practical cost is that the
two dialects are not interchangeable to a reader: `hover-card.tsx:20-26` needed a `forwardRef` for a
real reason and had to write a docblock explaining why it differs from _its own file's_ other
wrappers, which is a comment that only exists because the baseline is ambiguous. The old dialect also
correlates exactly with the missing `data-slot` set above — the same eight files.

**Recommendation.** Convert the eight remaining `forwardRef` files to the React-19 form in one PR,
adding `data-slot` as you go (the two changes touch the same lines). `hover-card.tsx`'s deliberate
ref forwarding survives untouched — in React 19 it is just `ref` in props, and its docblock gets
shorter.

---

### [P2/S] `ResponsivePopoverContent` widens Radix's `side`/`align` unions to `string` and casts them back

**File:** `apps/client/src/layers/shared/ui/responsive-popover.tsx:97-110`

**Current state.**

```tsx
}: React.ComponentPropsWithoutRef<typeof PopoverContent> & { side?: string; align?: string }) {
  …
  <PopoverContent
    side={side as 'top' | 'bottom' | 'left' | 'right'}
    align={align as 'start' | 'center' | 'end'}
```

**Why it falls short.** The intersection with `{ side?: string }` _widens_ the prop that
`ComponentPropsWithoutRef<typeof PopoverContent>` already typed correctly, and the two `as` casts
then re-narrow it without checking. A caller writing `side="botom"` type-checks and silently gets
undefined positioning behaviour. This is a primitive fighting Radix's own types rather than wrapping
them — and `AGENTS.md` §Quality Standard puts "types precise" in the non-negotiable column, for the
architect who reads source before adopting.

**Recommendation.** Delete the `& { side?: string; align?: string }` intersection and both casts; the
inherited props are already right. The mobile branch, which ignores them, needs no type change.

---

### [P2/L] `NavigationLayout` hand-rolls a tablist, a roving tabindex and a `role="toolbar"` wrapper while `useRovingTabList` and Radix `Tabs` both sit in the same folder

**Files:** `apps/client/src/layers/shared/ui/navigation-layout.tsx:164-256,304-372` vs
`apps/client/src/layers/shared/ui/use-roving-tab-list.ts:84-164` and
`apps/client/src/layers/shared/ui/tabs.tsx`

**Current state.** `NavigationLayoutSidebar` wraps its `role="tablist"` in a
`<div id={id} role="toolbar" onKeyDown={…}>` (line 253) and implements Arrow/Home/End by querying
`[role="tab"]` out of the DOM and reading `data-value` attributes off the results (lines 213-249).
`NavigationLayoutItem` sets `tabIndex={isActive ? 0 : -1}` by hand (line 349) and, on mobile, renders
`<motion.button role="button">` (line 325) — an explicit role that a `<button>` already has.
Meanwhile `use-roving-tab-list.ts` in the same directory implements exactly this WAI-ARIA pattern,
correctly, with a documented automatic-activation model, Delete-to-close and a fallback-focus
contract, and is used by the desktop window-tab strip.

**Why it falls short.** Three specific defects follow from the hand-roll: a `role="toolbar"` element
wrapping a `role="tablist"` is a composite-widget-inside-a-composite-widget that assistive tech does
not have a model for; the `aria-controls`/`id` wiring (`nav-item-${value}` / `nav-panel-${value}`)
is global rather than scoped, so two `NavigationLayout`s on one screen collide on ids; and reading
navigation order out of the DOM means the order depends on render order rather than on a list the
component owns. It is also the third roving-focus implementation in the client, after
`use-roving-tab-list.ts` and `shared/model/interaction/use-roving-focus`.

**Recommendation.** Two options, in preference order. (a) Have `NavigationLayoutSidebar` consume
`useRovingTabList` — it already has the ordered ids in the item registry (`itemsRef`), so
`getTabProps(id)` replaces the DOM query, the `tabIndex` arithmetic and the `role="toolbar"` wrapper
outright. (b) If the drill-in behaviour makes that awkward, at minimum drop the `toolbar` wrapper,
scope the ids with `useId()`, and delete the redundant `role="button"`. Either way this is a spec-sized
change — it is the settings dialog's navigation.

---

### [P2/S] `AgentIdentity` runs three parallel `cva()` calls keyed on one `size` axis plus a layout ternary — the multi-slot case ADR-0097 exists for

**File:** `apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx:10-50,141-149`

**Current state.** `identityVariants` (root gap), `nameVariants` (name type), `detailVariants`
(detail type) are three separate cva definitions each declaring the same four-value `size` axis and
the same `defaultVariants: { size: 'sm' }`. A fourth consequence of `size` — whether the lockup
stacks — is a ternary derived from the resolved size on line 142
(`const isStacked = resolvedSize === 'md' || resolvedSize === 'lg'`).

**Why it falls short.** Four expressions of one axis, three of which must be kept in sync by hand and
the fourth of which is invisible to the type system. Adding an `xl` means editing four places and
remembering the ternary. ADR-0097 named this exact shape when adopting `tv({ slots })`, and
`message-variants.ts` is the working proof it reads well in this codebase. (The sibling
`LoudnessMeter.tsx:10-22` documents the opposite call correctly — one slot, so cva is right there.)

**Recommendation.** One `tv({ slots: { root, label, name, detail }, variants: { size: {…} } })`,
with `label`'s `flex-col` moving into the `md`/`lg` size branches so the stacking rule is stated with
the sizes rather than beside them. Keep the `agentIdentityVariants` export for compatibility.

---

### [P2/S] Bare `focus:` rings in five shared primitives, against an explicit rule

**Files:** `badge.tsx:6` · `dialog.tsx:41` (dialog close button) · `sheet.tsx:76` (sheet close button) ·
`responsive-dialog.tsx:223` (fullscreen toggle) · `select.tsx:23` (select trigger)

**Current state.** `.claude/rules/components.md` §Required Patterns: "**Focus styles**:
`focus-visible:` (keyboard only), never bare `focus:`." Five primitives use `focus:ring-2` /
`focus:ring-1` / `focus:outline-none`. Everything else in the folder is already `focus-visible:`.

**Why it falls short.** A bare `focus:` ring fires on mouse click, so every close of a dialog and
every open of a select paints a 2px ring nobody asked for — which is precisely the chrome-at-rest
that `design-system.md` §Anti-Patterns rules out ("Chrome that renders at rest"). It is also a
path-rule violation, which `AGENTS.md` Hard Rule 8 makes binding. _(Overlaps lens 9 — UI states;
listed here because all five are in primitives whose variant recipes this lens is rewriting anyway,
so it is one edit, not two.)_

**Recommendation.** Mechanical swap to `focus-visible:` in those five class strings. Dialog and sheet
close buttons should become `<Button variant="ghost" size="icon-sm" asChild>` per the icon-button
finding, which fixes it for free.

---

### [P2/S] `PackageTypeBadge` maps six package types onto raw palette strings instead of a badge `tone` axis

**File:** `apps/client/src/layers/features/marketplace/ui/PackageTypeBadge.tsx:10-29,68-77`

**Current state.** A `Record<MarketplacePackageType, string>` of six raw-palette triples
(`blue-500/20`, `purple-500/10`, `emerald-500`, `amber-500`, `rose-500`, plus a seventh `cyan-500`
constant for connectors), passed to `<Badge variant="outline" className={cn(…)}>`.

**Why it falls short.** It is the `Badge`-has-no-tone-axis finding in its most concrete form: seven
hues, none of them from the theme, applied by className override, with `dark:` variants written by
hand for the foreground only (the `/10` backgrounds are not re-tuned for dark, where a 10%-alpha
blue over `0 0% 4%` reads very differently than over `0 0% 98%`). `design-system.md` §Brand Accent is
explicit that structural surfaces stay on tokens.

**Recommendation.** After the `Badge` `tone` axis lands, express the package types as a small map to
tone names (or, if six distinct identity hues are genuinely wanted for scannability in the browse
grid, define them as `--package-*` tokens in `index.css` once and reference those). Either way the
call site should stop carrying colour literals.

---

### [P3/S] `SidebarRow`'s three-state row appearance is a compound-variant problem solved with conditional `&&`

**File:** `apps/client/src/layers/shared/ui/sidebar-row.tsx:550-569`

**Current state.**

```tsx
isActive
  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
emphasized && !isActive && !muted && 'text-sidebar-foreground font-medium',
```

plus `showSecondLine ? 'items-start py-1.5' : 'items-center'` and the pointer lookup
`SIDEBAR_ROW_HEIGHT[pointer]`.

**Why it falls short.** `isActive`/`emphasized`/`muted` are not three independent booleans — they are
one four-valued state (`active` > `muted` > `emphasized` > `rest`), and the `&& !isActive && !muted`
guard is the precedence rule written as a condition. cva's `compoundVariants` states exactly this,
and `identity-avatar.tsx:154-158` and `mention-pill.tsx:70-81` already use it in this same folder.
This is a P3 rather than P2 because the current code is _correct_ and thoroughly documented — the
cost is future: a fourth state means a fourth negation in the guard.

**Recommendation.** `sidebarRowVariants` cva with axes `state` (derived once from the three props),
`pointer`, and `lines`, keeping `SIDEBAR_ROW_GUTTER` outside the cva since its docblock
(`sidebar-row.tsx:62-97`) establishes that it must be the last class in the merge, after the caller's
`className`. Do this only alongside the `SIDEBAR_ROW_GUTTER` browser test, which is what protects the
ordering.

---

### [P3/S] Two cva'd primitives do not export their variants object, against the folder's stated contract

**Files:** `field.tsx:64-83` (`fieldVariants`) · `page-container.tsx:14-22` (`pageContainerVariants`)

**Current state.** The rule says shared primitives "export both the component and its
`componentVariants`". `button`, `badge`, `banner`, `mention-pill`, `identity-avatar` and
`responsive-sheet` do; `field.tsx` and `page-container.tsx` define a cva and export only the
component.

**Why it falls short.** `alert-dialog.tsx:93,103` is the live demonstration of why the export matters
— it styles its Action and Cancel by calling `buttonVariants()` directly rather than nesting a
`Button`. `SettingRow` (`setting-row.tsx:41-46`) currently reaches for the same thing and cannot: it
passes `orientation` down to `Field` **and then adds its own ternary** (`orientation === 'horizontal' ? 'items-center justify-between gap-4' : 'gap-1.5'`)
on top, because it has no way to read or extend the axis `Field` already owns.

**Recommendation.** Export both. Then fold `SettingRow`'s ternary into `fieldVariants` as a compound
of `orientation`, so the row's spacing is stated once with the orientation that causes it.

---

### [P3/S] `HoverBorderGradient` takes an untyped `as` prop where `asChild` is the house pattern

**File:** `apps/client/src/layers/shared/ui/hover-border-gradient.tsx:27,33,59`

**Current state.** `as: Tag = 'button'` typed `React.ElementType`, spread with
`React.HTMLAttributes<HTMLElement>`.

**Why it falls short.** `React.ElementType` erases the prop contract entirely — passing `as={Link}`
type-checks and then drops every TanStack Router prop, and `onMouseEnter`/`onMouseLeave` are attached
to whatever the tag turns out to be. `.claude/rules/components.md` names Radix + `asChild` as the
composition pattern, and this is the onboarding CTA — the first branded moment a user sees
(`design-system.md` §Brand Accent), so it is the component most likely to be asked to become a link.

**Recommendation.** `asChild?: boolean` + `Slot.Root`, matching `Button`. One call site to update.

---

## Notes on lens boundaries

- The raw-palette colours I cite (`ConnectionStatusBanner`, `PackageTypeBadge`, `copy-button.tsx:32`'s
  `text-green-500`, `provenance-chip.tsx:87`'s `amber-500/15`, `trust-tone.ts:52`'s `text-amber-600`)
  belong to **lens 1 (Tokens)** for the colour question. I cite them only where the _shape_ of the fix
  is "this should be a variant axis on an existing primitive".
- The duplicated chip/pill/empty-state JSX across `filter-bar/`, `features/chat/ui/chips/` and the
  marketplace belongs to **lens 3 (DRY)** and **lens 12 (Componentization)** for the "make one
  component" framing. My version is narrower: the primitives that already exist are not composable
  enough for those call sites to have used them.
- Bare `focus:` overlaps **lens 9 (UI states)**; the nested-button and unreachable-toggle findings
  overlap whichever lens owns accessibility. Dedup at synthesis.
