[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 14 — Shared primitives: composition debt

**Priority P2 · 13 findings · 8S · 3M · 2L**
**Scope:** `shared/ui` internals. `.claude/rules/components.md` and ADR-0097 already settle the tooling; these are the places the folder does not follow its own rules. No visual change is intended by any of them. 14.1 and 14.10 are spec-sized and should split out.

### 14.1 — Variant-shaped code across `shared/ui` bypasses `cva`/`tv`

**P2 · L · lens 2**
`switch.tsx:7-32,44-65` · `PromptSuggestionChips.tsx:20-23,98-102` · `path-breadcrumb.tsx:29-31,43-48` · `copy-button.tsx:44` · `section-header.tsx:33,52-55,182-190` · `sidebar-row.tsx:125,556-563` · `ConnectionStatusBanner.tsx:35-47` · `ScanLine.tsx:32-36` · `sheet.tsx:60-70` · `filter-bar/FilterBarPrimary.tsx:46-47`, `FilterBarSort.tsx:41`, `FilterBarAddFilter.tsx:284`, `FilterBarActiveFilters.tsx:81,136` · `option-row.tsx:26-30` · `provenance-chip.tsx:84-91` · `field-card.tsx:78-80` · `navigation-layout.tsx:329-333,351-357`

**Evidence.** `.claude/rules/components.md` §Required Patterns is explicit for this directory: "follow the existing files — `cva` variants, `data-slot` attribute on the root, `cn()` for class merging, export both the component and its `componentVariants`." Eight files do this. At least seventeen other multi-variant components express the same shape three other ways: hand-maintained `Record<Size, string>` lookup tables (`switch.tsx`'s `TRACK_SIZES`/`THUMB_SIZES`, verified; `SECTION_HEADER_HEIGHT`; `SIDEBAR_ROW_HEIGHT`); inline ternaries on a prop (`path-breadcrumb.tsx` has three `size === 'sm' ? … : …` in a row; `sheet.tsx` has four `side === 'x' &&` branches, verified); and whole class strings duplicated per branch (the four filter-bar triggers repeat `inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs` verbatim in four files).

Three observable consequences. (1) The variant system is implicit: nothing types `size` against the table, so `PromptSuggestionChips` restates its axis a second time on the icon (`size === 'compact' ? 'size-3' : 'size-3.5'`) and the two can drift. (2) `cn()`/tailwind-merge never runs over a template-literal concatenation — `path-breadcrumb.tsx:46-48` builds `labelClass` with backticks, so a caller could never override it and conflicting utilities would both reach the DOM. (3) Cross-component drift: the four filter-bar chips are one control drawn four times, and the day one grows a focus ring the other three will not.

**Recommendation.** One pass per component, no design change. Move each `Record<…, string>` into a `cva()` `variants` block and export the `componentVariants` the rule asks for. Convert the four filter-bar triggers into one `filterTriggerVariants` exported from `filter-bar/`, or better, `<Trigger asChild><Button variant="outline" size="xs">`. Convert `sheet.tsx`'s `side` last and only with an upstream-sync note — it is the one case where diverging costs future shadcn merges.

### 14.2 — `Switch` is the two-slot case ADR-0097 adopted `tailwind-variants` for, and hand-rolls four string tables instead

**P2 · M · lens 2**
`apps/client/src/layers/shared/ui/switch.tsx:7-65`

**Evidence.** Verified in source. Track and thumb both respond to one `size` axis, and the thumb's translate distance must stay in lockstep with the track's width — maintained by hand across four constants, one built by string concatenation across three breakpoints:

```ts
const RESPONSIVE_THUMB =
  'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 ' +
  'sm:h-5 sm:w-5 sm:data-[state=checked]:translate-x-5 ' +
  'md:h-4 md:w-4 md:data-[state=checked]:translate-x-4';
```

selected with `isResponsive ? RESPONSIVE_TRACK : TRACK_SIZES[resolvedSize]`. ADR-0097 names this shape precisely: "TV is used when a component has multiple DOM elements that need to respond to the same variant axes simultaneously." The ADR is accepted, `tailwind-variants` is already a dependency — and it is used in exactly **one** file in the whole client (`features/conversation/ui/message/message-variants.ts`), so the decision was implemented for `MessageItem` and never reached the primitive that needs it most. `sm`'s translate (`translate-x-3` on a `w-7` track with a `w-3` thumb) and `lg`'s (`translate-x-7` on `w-14`/`w-6`) are derived by hand and nothing checks them.

**Recommendation.** `export const switchVariants = tv({ slots: { root, thumb }, variants: { size: {…}, responsive: {…} } })`, with the responsive breakpoints as a second axis rather than an `isResponsive` boolean short-circuit. Same output, one place where a size and its travel are stated together.

### 14.3 — `Badge` is the least-finished primitive in the directory

**P2 · S · lenses 2 + 5**
`apps/client/src/layers/shared/ui/badge.tsx:3,5-29`, `apps/client/src/layers/shared/ui/index.ts:19`

**Evidence.** Verified in source. 88 JSX call sites, second only to `Button`, and it has none of the four things `Button` next door has: no `asChild` despite Radix `asChild` being the named house composition pattern (~144 uses), no `data-slot`, no exported `BadgeProps`, and a `<div>` root — so a badge inside a `<p>` is invalid HTML that React renders happily, and a badge that should be a link has to be wrapped rather than composed, which changes the layout. It also imports `cn` relatively (`../lib/utils`, see 15.9) and carries the bare `focus:ring-2` from 3.5.

**Recommendation.** Bring it to `Button`'s shape in one small PR: `asChild?: boolean` with `Slot.Root`, root element `<span>` (inline by default, which is what a badge is), `data-slot="badge"` plus `data-variant`, `export type BadgeProps` on the barrel, and `focus-visible:`. No visual change — `inline-flex` makes `span` and `div` render identically here. Add `size` only after 15.5's vocabulary lands, so it is born speaking the settled scale.

### 14.4 — `Badge` has one axis, so 71 of its 104 call sites hand-tune `className`

**P2 · M · lens 2**
`apps/client/src/layers/shared/ui/badge.tsx:5-29`; call sites incl. `features/mesh/ui/TopologyPanel.tsx:38,48,92,96` (`text-xs`), `AdapterNode.tsx:128` (`text-[10px]`), `AgentHealthDetail.tsx:117,132` (`text-[0.625rem]`), `AgentNode.tsx:100,104,109,225` (`text-[10px]`), `features/marketplace/ui/PackageTypeBadge.tsx:10-29,68-77`

**Evidence.** Verified: `badgeVariants` has exactly one axis (`variant`: default/secondary/destructive/outline) and a fixed `text-xs`. Measured across the client: **104 `<Badge` call sites, 71 of which pass `className`**, and the overwhelming majority of those overrides restate a size (`text-xs`, `text-[10px]`, `text-[0.625rem]`, `text-[11px]`) or a tone (`text-muted-foreground`, status colours, raw palette). A primitive two-thirds of its consumers have to correct is a starting point, not a primitive. The concrete cost is a type ramp the design system does not have: `text-[0.625rem]` and `text-[10px]` are the same 10px written two ways, one file apart in the same feature. `PackageTypeBadge` is the most concrete case — a `Record<MarketplacePackageType, string>` of six raw-palette triples (`blue-500/20`, `purple-500/10`, `emerald-500`, `amber-500`, `rose-500`, plus a seventh `cyan-500`), with `dark:` variants written by hand for the foreground only, so the `/10` backgrounds are not re-tuned for dark where a 10%-alpha blue over `0 0% 4%` reads very differently than over `0 0% 98%`. Its `border-<colour>/20` classes are also three more sites hit by 4.1.

**Recommendation.** Add two axes to `badgeVariants`: `size: 'xs' | 'sm'` (the two sizes that actually exist) and `tone: 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'brand'` sourced from the `--status-*` tokens that `banner.tsx:17-22` and `features/gen-ui/lib/widget-tone.ts:9-15` already map. Then sweep the 71 call sites; most collapse to `<Badge size="xs">` or `<Badge tone="warning">`. Express package types as a map to tone names, or — if six distinct identity hues are genuinely wanted for scannability in the browse grid — define them as `--package-*` tokens in `index.css` once. Either way the call site stops carrying colour literals.

### 14.5 — Nine hand-rolled icon buttons in `shared/ui` instead of composing `Button`

**P2 · M · lens 2**
`floating-panel.tsx:218-235` (two byte-identical strings 8 lines apart) · `copy-button.tsx:46-52` · `path-input.tsx:52-61` · `truncated-output.tsx:48-54` · `link-safety-modal.tsx:73-80,93-107,112-120` · `responsive-dialog.tsx:219-230` · `responsive-popover.tsx:132-135` · `filter-bar/FilterBarActiveFilters.tsx:139-146` · `features/chat/ui/chips/ChipTray.tsx:104-125`

**Evidence.** `FloatingPanel` writes the same 11-utility string twice, eight lines apart: `'text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring inline-flex items-center justify-center rounded-md p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none'`. `CopyButton` writes a near-miss of the same recipe, `PathInput`'s Browse writes a third, `LinkSafetyModal` writes three more. `Button` already encodes all of it as `variant="ghost" size="icon-sm"`, plus the responsive touch height these do not get. Nine hand-rolled icon buttons is nine places the focus ring, the disabled state and the 44px mobile floor have to be remembered — and two already forgot the floor (`copy-button.tsx` is `p-1` around a 14px glyph, ≈22px; `path-input.tsx`'s Browse is `px-3 py-2`) while two forgot `focus-visible` for bare `focus:`. `shared/ui` may import `shared/ui`: `not-found-fallback.tsx:16` and `password-input.tsx:45` already do this correctly.

**Recommendation.** Replace each with `<Button variant="ghost" size="icon-sm" aria-label=…>` (or `icon-xs` where 24px is genuinely wanted, with the `responsive={false}` opt-out stated). Where the button wraps a Radix `Close`/`Trigger`, use `asChild`. `ChipTray`'s filter toggles want `<Button variant="outline" size="xs" aria-pressed=…>` rather than their own bordered-pill string.

### 14.6 — `CollapsibleFieldCard` restates `FieldCard`'s class string instead of composing it

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/field-card.tsx:11-19` vs `:66-70`

**Evidence.** Both are exported from the same module and both write `className={cn('bg-card overflow-hidden rounded-lg border', className)}` — the same string, hand-copied. The collapsible one already composes `FieldCardContent` on line 84, so the composition is half done. The whole point of the pair is that a collapsible field card _is_ a field card; restating the frame means a change to the card's surface lands in one of two places.

**Recommendation.** `<FieldCard className={className} data-slot="collapsible-field-card">` wrapping the trigger and content. Keep the distinct `data-slot`, drop the duplicated string. Four lines.

### 14.7 — `ConnectionStatusBanner` re-implements `Banner`'s severity ladder next door, with raw palette colours

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx:34-51` vs `apps/client/src/layers/shared/ui/banner.tsx:15-25,70-127`

**Evidence.** `ConnectionStatusBanner` picks between two hardcoded palette pairs with a ternary — `'bg-red-500/10 text-red-600 dark:text-red-400'` vs `'bg-amber-500/10 text-amber-600 dark:text-amber-400'` — and hand-picks the icon with a second ternary. Eleven files away, `banner.tsx` is a cva with a documented four-rung severity ladder (`critical`/`warning`/`info`/`neutral`), per-variant icons, the correct `role="alert"` vs `role="status"` split, `--status-*` tokens calibrated for both themes and the Obsidian bridge, and a dismiss slot. `design-system.md` §Banners is unambiguous that `Banner` is _the_ full-width standing-condition surface. A lost server link is textbook `critical`; reconnecting is `warning`. Worse, `ConnectionStatusBanner` announces nothing — no `role`, no `aria-live` — so a screen-reader user is never told the link dropped, which `Banner` would have supplied.

**Recommendation.** `<Banner variant={isDisconnected ? 'critical' : 'warning'} icon={isDisconnected ? WifiOff : Wifi}>`. Keep the component as the thin wrapper mapping `ConnectionState` → variant + sentence; delete the class ternary. Pairs with 19.3, which moves this file into `features/relay` where its single consumer lives.

### 14.8 — `PathInput` re-implements `Input`'s recipe minus the parts that were forgotten

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/path-input.tsx:32-48`

**Evidence.** The container copies `Input`'s border/background/shadow recipe (`dark:bg-input/30 border-input … shadow-xs transition-[color,box-shadow]`) and moves the focus ring to `focus-within:`; the inner `<input>` then re-writes the placeholder colour, the `h-11 md:h-9` responsive height and the disabled treatment by hand. What it does not carry: `aria-invalid:` styling, `selection:` colours, `file:` handling, and the `text-base md:text-sm` mobile-zoom guard. When `Input` next changes, the path field silently stops matching every other field in the app.

**Recommendation.** Keep the wrapper for the divider and Browse zone, but render `<Input>` inside it with `className="border-0 bg-transparent shadow-none focus-visible:ring-0"`, so the field's recipe stays in one file. Browse becomes `<Button variant="ghost" size="sm">`.

### 14.9 — `ResponsivePopoverContent` widens Radix's `side`/`align` unions to `string` and casts them back

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/responsive-popover.tsx:97-110`

**Evidence.** The props type is `React.ComponentPropsWithoutRef<typeof PopoverContent> & { side?: string; align?: string }`, and the render does `side={side as 'top' | 'bottom' | 'left' | 'right'}` / `align={align as 'start' | 'center' | 'end'}`. The intersection _widens_ a prop the inherited type already had right, and the casts re-narrow it without checking — so a caller writing `side="botom"` type-checks and silently gets undefined positioning. This is a primitive fighting Radix's types rather than wrapping them, and AGENTS.md §Quality Standard puts "types precise" in the non-negotiable column.

**Recommendation.** Delete the `& { side?: string; align?: string }` intersection and both casts; the inherited props are already correct. The mobile branch, which ignores them, needs no type change.

### 14.10 — `NavigationLayout` hand-rolls a tablist, a roving tabindex and a `role="toolbar"` wrapper while both replacements sit in the same folder

**P2 · L · lens 2**
`apps/client/src/layers/shared/ui/navigation-layout.tsx:164-256,304-372` vs `use-roving-tab-list.ts:84-164` and `tabs.tsx`

**Evidence.** `NavigationLayoutSidebar` wraps its `role="tablist"` in a `<div id={id} role="toolbar" onKeyDown={…}>` and implements Arrow/Home/End by querying `[role="tab"]` out of the DOM and reading `data-value` off the results. `NavigationLayoutItem` sets `tabIndex={isActive ? 0 : -1}` by hand and, on mobile, renders `<motion.button role="button">` — an explicit role a `<button>` already has. Meanwhile `use-roving-tab-list.ts`, in the same directory, implements exactly this WAI-ARIA pattern correctly, with a documented automatic-activation model, Delete-to-close and a fallback-focus contract, and is used by the desktop window-tab strip.

Three defects follow from the hand-roll: a `role="toolbar"` wrapping a `role="tablist"` is a composite widget inside a composite widget that assistive tech has no model for; the `aria-controls`/`id` wiring (`nav-item-${value}` / `nav-panel-${value}`) is global rather than scoped, so two `NavigationLayout`s on one screen collide on ids; and reading navigation order out of the DOM makes order depend on render order rather than on a list the component owns. It is also the third roving-focus implementation in the client.

**Recommendation.** In preference order: (a) have `NavigationLayoutSidebar` consume `useRovingTabList` — it already holds the ordered ids in `itemsRef`, so `getTabProps(id)` replaces the DOM query, the `tabIndex` arithmetic and the `role="toolbar"` wrapper outright; or (b) if the drill-in behaviour makes that awkward, at minimum drop the `toolbar` wrapper, scope the ids with `useId()`, and delete the redundant `role="button"`. Either way this is spec-sized — it is the settings dialog's navigation.

### 14.11 — `AgentIdentity` runs three parallel `cva()` calls keyed on one axis, plus a layout ternary

**P2 · S · lens 2**
`apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx:10-50,141-149`

**Evidence.** `identityVariants` (root gap), `nameVariants` (name type) and `detailVariants` (detail type) are three separate cva definitions each declaring the same four-value `size` axis and the same `defaultVariants: { size: 'sm' }`. A fourth consequence of `size` — whether the lockup stacks — is a ternary derived from the resolved size at `:142`. Four expressions of one axis, three kept in sync by hand and the fourth invisible to the type system; adding an `xl` means editing four places and remembering the ternary. ADR-0097 named this exact shape when adopting `tv({ slots })`, and `message-variants.ts` is the working proof it reads well here. (The sibling `LoudnessMeter.tsx:10-22` documents the opposite call correctly — one slot, so cva is right there.)

**Recommendation.** One `tv({ slots: { root, label, name, detail }, variants: { size: {…} } })`, with `label`'s `flex-col` moving into the `md`/`lg` size branches so the stacking rule is stated with the sizes rather than beside them. Keep the `agentIdentityVariants` export for compatibility.

### 14.12 — `SidebarRow`'s three-state appearance is a compound-variant problem solved with conditional `&&`

**P3 · S · lens 2**
`apps/client/src/layers/shared/ui/sidebar-row.tsx:550-569`

**Evidence.** `isActive ? 'bg-sidebar-accent …' : 'text-sidebar-foreground/70 hover:…'` followed by `emphasized && !isActive && !muted && 'text-sidebar-foreground font-medium'`, plus `showSecondLine ? 'items-start py-1.5' : 'items-center'` and the `SIDEBAR_ROW_HEIGHT[pointer]` lookup. `isActive`/`emphasized`/`muted` are not three independent booleans — they are one four-valued state (`active` > `muted` > `emphasized` > `rest`), and the `&& !isActive && !muted` guard is the precedence rule written as a condition. cva's `compoundVariants` states exactly this, and `identity-avatar.tsx:154-158` and `mention-pill.tsx:70-81` already use it in this folder. P3 rather than P2 because the current code is correct and thoroughly documented; the cost is future — a fourth state means a fourth negation.

**Recommendation.** A `sidebarRowVariants` cva with axes `state` (derived once from the three props), `pointer` and `lines`, keeping `SIDEBAR_ROW_GUTTER` outside the cva since its docblock establishes it must be the last class in the merge, after the caller's `className`. Do this only alongside the `SIDEBAR_ROW_GUTTER` browser test, which is what protects the ordering.

### 14.13 — `HoverBorderGradient` takes an untyped `as` prop where `asChild` is the house pattern

**P3 · S · lens 2**
`apps/client/src/layers/shared/ui/hover-border-gradient.tsx:27,33,59`

**Evidence.** `as: Tag = 'button'` typed `React.ElementType`, spread with `React.HTMLAttributes<HTMLElement>`. `React.ElementType` erases the prop contract entirely — passing `as={Link}` type-checks and then drops every TanStack Router prop, and `onMouseEnter`/`onMouseLeave` attach to whatever the tag turns out to be. This is the onboarding CTA, the first branded moment a user sees, and therefore the component most likely to be asked to become a link.

**Recommendation.** `asChild?: boolean` + `Slot.Root`, matching `Button`. One call site to update.
