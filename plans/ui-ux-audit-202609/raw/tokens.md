# Tokens & Consistency — Lens Findings

Auditor: Lens 1 (Tokens & consistency). Scope per charter: `apps/client/src`.

## Coverage

**Ground truth read in full:** `contributing/design-system.md` (all 1270 lines — Color, Typography,
Spacing, Motion durations, Identity grammar, Mobile Responsive Scale, Icon Size Convention, the
`border-<colour>` and `--sidebar`/`--muted` gotchas it documents itself), `contributing/animations.md`,
`.claude/rules/fsd-layers.md` (header). `apps/client/src/index.css` read for every token table cited
below (`@theme inline` block, `:root`/`.dark` HSL values, `--text-3xs`/`--text-2xs`, `--size-icon-*`,
`--_st`/`--_si` mobile multipliers, `--chart-1..5`, `--status-*`, the unlayered `border-color` rule).

**Systematic greps** run across all of `apps/client/src` (excluding `__tests__`/`.test.` files, with
`dev/showcases` mock data treated as lower-signal since it's fixture data, not shipped UI) for: raw
`#hex` literals, `hsl(...)` literals, every arbitrary-bracket Tailwind utility family (`text-[`, `w-[`,
`h-[`, `p-[`/`m-[`/`gap-[` and their directional variants, `rounded-[`, `shadow-[`, `border-[`,
`leading-[`, `tracking-[`, `size-[`), raw Tailwind palette color classes (`bg-red-500`, `text-amber-600`,
etc.) vs. the app's semantic `--status-*`/`--chart-*` tokens, `border-<colour>` utilities (checked
against the documented CSS-cascade-layer bug), `dark:` hand-rolled overrides, `fontFamily`/`font-family`
hardcoding, and the `size-[--size-icon-*]` icon convention vs. raw `size-4`/`h-4 w-4`.

**Read in full or substantial part:** ~35 `shared/ui` primitives (button, checkbox, dialog, sheet,
drawer, select, dropdown-menu, context-menu, command, tooltip, sidebar, sidebar-row, sidebar-menu-node,
identity-avatar, mention-pill, hover-border-gradient, kbd, trust-dial, provenance-chip,
identity-hover-card, responsive-dropdown-menu, responsive-popover, responsive-context-menu,
navigation-layout, section-header, tabbed-dialog, textarea, slider, path-breadcrumb,
PromptSuggestionChips, DirectoryPicker, ConnectionStatusBanner, app-crash-fallback,
route-error-fallback, readable-foreground.ts, scroll-area) out of ~90 in the directory, plus targeted
reads of the flagged non-`shared/ui` files below (mesh/topology, status, relay, marketplace, terminal,
settings/runtimes, command-palette, dashboard-sidebar).

**Sampled, not exhaustively read:** `features/*` and `entities/*` beyond the files grep surfaced and I
opened for citation — coverage there is "every file a pattern hit, read for context," not "every file
in the tree." `dev/` playground and `*.test.tsx` were excluded from the violation counts (mock/fixture
data legitimately uses arbitrary/raw colors) but were grepped to confirm they weren't hiding
production code.

**Not covered:** `apps/site`, `apps/desktop`, `apps/obsidian-plugin` (out of charter scope). Visual/
rendered verification (I did not run the app or a browser) — findings 1 and 2 below rest on reading the
CSS cascade and token definitions directly plus the design system doc's own prior browser-verified
claim for finding 1; I did not re-verify in a live browser.

---

### [P1/M] `border-<colour>` utilities render as the neutral border on 63+ files — a known, still-unfixed CSS bug the codebase keeps writing into

**Current state:** `apps/client/src/index.css:673-675` sets:

```css
*:where(:not(.copilot-view-content *)) {
  border-color: hsl(var(--border));
}
```

This rule is **unlayered** (outside any `@layer` block), and Tailwind v4 generates every utility class
— including `border-destructive`, `border-primary`, `border-amber-500`, `border-status-warning`, etc. —
inside a `@layer utilities` block. Per the CSS cascade-layers spec, unlayered normal-priority
declarations always beat layered ones regardless of specificity, so this near-zero-specificity
universal rule outranks every colored border utility in the app. `contributing/design-system.md:602`
documents this exact mechanism and states it was "verified in a browser": _"`border-destructive`,
`border-primary`, `border-transparent` and every other border colour class in the codebase currently
render as the neutral border... Until that rule is layered (a repo-wide change with its own visual
review), a border colour has to be set **inline**."_

This is not a new discovery — the doc already names it as an open, unfixed problem with a known
remedy. What the audit adds is the blast radius: **63 files** still write a `border-<colour>` utility
expecting it to render, meaning the codebase has kept adding to the problem since it was diagnosed
rather than treating it as a moratorium. A representative sample:

- `layers/features/mesh/ui/DiscoveryView.tsx:262,322` — `border-destructive/30` on an error panel (the
  border is the panel's only color cue beyond the icon; it silently renders gray)
- `layers/features/settings/ui/TunnelDialog.tsx:207-209` — `border-amber-400/40` / `border-destructive/40`
  switched on tunnel machine state (`starting`/`stopping`/`error`) — three states meant to look
  different at a glance, rendering identically
- `layers/features/tasks/ui/TaskTemplateCard.tsx:70` — `border-primary` on the selected-card state
- `layers/features/chat/ui/chips/TouchChip.tsx:148,178` — `border-destructive/40` on an error chip,
  `border-primary` on a focus ring overlay
- `layers/features/marketplace/ui/PackageTypeBadge.tsx:10-14` — five package-type badges each keyed to
  a `border-<colour>/20` that never paints
- `layers/features/gen-ui/ui/nodes/TimelineNode.tsx:22-23`, `RevealNode.tsx:26` — generative-UI node
  borders (`border-status-success`, `border-primary`, `border-status-warning-border`)
- `layers/features/auth/ui/ApiKeysSection.tsx:143`, `layers/features/composer/ui/ComposerRoot.tsx:186`,
  `layers/features/dashboard-attention/ui/FailedRunDetailSheet.tsx:121`, and 50+ more across settings,
  connections, extensions, relay adapter cards.

**Why it falls short:** these components' authors clearly intended a color signal (error red, warning
amber, primary highlight) and it is not there. This is worse than a raw-hex inconsistency finding — it
is dead code shipping in production styling, silently degrading error/warning/selection legibility
across the app, and it will keep growing every time someone reaches for the obvious Tailwind class
without knowing about the trap.

**Recommendation:** this deserves to be treated as a Hard-Rule-adjacent defect, not routine polish.
Two paths, both already implied by the doc: (1) do the repo-wide layering fix the doc calls for — move
the `*:where(...)` rule into a layer below `utilities` (or scope it more narrowly so it stops shadowing
color utilities) and visually re-review the app, which fixes all 63 sites at once; or (2) if the layering
fix is deferred, add an ESLint rule banning `border-<semantic-or-palette-colour>` class strings outside
`shared/ui` (mirroring `TeamMemberCard`'s inline-declaration workaround the doc already documents) so
the count stops growing while the real fix is scheduled. Given the scope, option 1 is the Calm-Tech-
correct one: one CSS fix, not 63 component patches.

---

### [P1/L] Arbitrary `text-[Npx]` sizes bypass the defined type ramp — and the mobile-scaling system — across ~150 files, shared/ui included

**Current state:** `index.css:87-90` defines two sub-`text-xs` tokens specifically so nothing has to
drop to a raw pixel value:

```css
--text-3xs: calc(0.625rem * var(--_st) * var(--user-font-scale, 1)); /* 10px desktop */
--text-2xs: calc(0.6875rem * var(--_st) * var(--user-font-scale, 1)); /* 11px desktop */
```

Both multiply by `--_st`, the mobile-scale multiplier (`design-system.md` "Mobile Responsive Scale":
`text-3xs` 10px→12.5px, `text-2xs` 11px→13.75px on mobile) and by the user's own font-scale setting.
Despite this, the app overwhelmingly reaches for the arbitrary-bracket form instead, which compiles to
a **literal, unscaled** `font-size` that participates in neither mobile scaling nor the user's font-size
preference:

- `text-[10px]`: **164 occurrences across 94 files** (grep, non-test, non-`/dev/`)
- `text-[11px]`: **86 occurrences across 50 files**
- `text-[9px]`: 10 occurrences (below the whole ramp — there is no token for it at all), including
  `layers/features/right-panel/ui/AttentionCountBadge.tsx:39` and
  `layers/features/mesh/ui/BindingEdge.tsx:165,170`

This isn't confined to feature code — it's in `shared/ui` itself, the primitives the rest of the app
composes from:

- `layers/shared/ui/kbd.tsx:8` — `text-[10px]` on every keyboard-shortcut badge in the app
- `layers/shared/ui/trust-dial.tsx:423` — `text-[10px]`
- `layers/shared/ui/provenance-chip.tsx:85` — `text-[10px]`
- `layers/shared/ui/identity-hover-card.tsx:96,332` — `text-[11px]` and `text-[10px]`
- `layers/shared/ui/responsive-dropdown-menu.tsx:232,322` — `text-[10px]` (twice, same pattern)

And representative feature-layer hits: `layers/entities/session/ui/SessionRowCompact.tsx:151`,
`layers/features/mesh/ui/BindingEdge.tsx:150`, `layers/features/mesh/ui/TopologyLegend.tsx:31,107`,
`layers/features/command-palette/ui/PaletteFooter.tsx:14`, `layers/features/status/ui/ContextItem.tsx`,
`layers/features/dashboard-sidebar/ui/SessionSwitcher.tsx:378` (`text-[10px]` combined with an arbitrary
`tracking-[0.05em]`) — the pattern spans mesh/topology, command palette, sidebar, status, marketplace,
relay, and settings almost uniformly.

**Why it falls short:** two separate problems stack here. First, plain inconsistency — the design
system explicitly defines these two sizes as tokens (`contributing/design-system.md`'s Typography
scale table lists `text-xs`/`text-sm`/`text-lg`, and the two 3xs/2xs tokens exist in code even though
the doc's own table doesn't enumerate them), so writing `text-[10px]` next to a sibling's `text-3xs` is
an unforced inconsistency. Second, and more serious: **the arbitrary form silently opts out of the
mobile-scaling system the design system treats as a core feature.** A 10px label reads as the intended
smallest size on desktop and stays exactly 10px on a 375px phone, while a `text-3xs` sibling would grow
to 12.5px per the documented mobile multiplier. Given the sheer count, most of the app's finest-grained
text (timestamps, badges, kbd hints, legends, tracking-line labels) is currently exempt from the
responsive-type-scale contract the design system advertises.

**Recommendation:** mechanical find/replace, `text-[10px]` → `text-3xs`, `text-[11px]` → `text-2xs`,
starting with the `shared/ui` primitives listed above since they're the highest-leverage fix (one change
propagates everywhere `Kbd`/`ProvenanceChip`/`IdentityHoverCard`/`ResponsiveDropdownMenu` are used). The
`text-[9px]` sites need a decision first — either a genuine `text-4xs` token if 9px is a real, repeated
need, or a bump to `text-3xs` if 9px was just "whatever looked right" (the badge/label context of most
`text-[9px]` hits suggests the latter). Worth a lint rule (`text-\[[0-9]+px\]` banned outside `dev/`)
once the backlog is cleared, so the fix doesn't erode again.

---

### [P2/L] The documented icon-sizing convention (`size-[--size-icon-*]`) is defined but essentially unadopted — icons don't scale on mobile

**Current state:** `index.css:98-100` defines a three-step icon scale that multiplies by `--_si`
(`--mobile-scale-icon`, default 1.25×):

```css
--size-icon-xs: calc(0.75rem * var(--_si)); /* 12px → 15px mobile */
--size-icon-sm: calc(1rem * var(--_si)); /* 16px → 20px mobile */
--size-icon-md: calc(1.25rem * var(--_si)); /* 20px → 25px mobile */
```

`contributing/design-system.md`'s "Icon Size Convention" section is explicit: _"use `size-[--size-icon-*]`
for all icon sizing"_ and shows `<Check className="size-[--size-icon-xs] ..." />` as the pattern. In
practice, only **2 files** use it — `layers/features/shapes/ui/ShapeSwitcherDialog.tsx` (11 uses) and
`layers/features/shapes/ui/ShapeForkForm.tsx` (1 use) — both from the same feature slice. Everywhere
else, icons are sized with plain Tailwind spacing utilities that happen to match the same desktop
pixel values but carry no mobile multiplier: `size-4` alone appears in **141 files**, and
`layers/shared/ui/button.tsx:8` bakes `size-4` in as the default for every unsized `<svg>` inside a
`Button` (`[&_svg:not([class*='size-'])]:size-4`) — meaning the majority of icon-bearing buttons in the
app inherit the non-scaling default before a call site ever gets a chance to opt in.

**Why it falls short:** `size-4` (16px, Tailwind's static `--spacing` scale) and `size-[--size-icon-sm]`
(also 16px on desktop) are visually identical on desktop, which is exactly why the drift went
unnoticed — the difference only shows up at <768px, where the documented convention grows icons 25%
and the actual codebase does not. Given the design system spends an entire section on why touch-context
icons should be larger (matching the same "bigger on mobile" logic behind `--mobile-scale-interactive`
and the 44px touch-target rules), this gap is a real, if subtle, responsiveness regression on the
majority of the app's iconography — not just a naming inconsistency.

**Recommendation:** given the scale of adoption (2 files vs. 141), treat `ShapeSwitcherDialog`/
`ShapeForkForm` as the pilot and either (a) confirm the convention going forward and migrate `shared/ui`
defaults first (starting with `button.tsx`'s default-`size-4` rule, which would fix icon scaling for
every button in one place), or (b) if `size-[--size-icon-*]` was an experiment that didn't pan out,
retire the doc section and the two files that adopted it, so the doc stops promising behavior the app
doesn't have. Don't leave both states shipping side by side.

---

### [P2/M] Five components hand-roll their own red/amber/emerald status vocabulary instead of the app's `--status-*` tokens — the exact "four spellings of one color" problem the codebase already fixed once, recurring

**Current state:** `layers/shared/ui/status-dot.ts` exists specifically because the app once drew the
same status color five different ways (`bg-green-500`, `bg-emerald-500`, `bg-primary`,
`bg-status-success` — its own module doc says so) and unified them behind `STATUS_DOT_COLOR`/
`statusDotClass()`, which read the theme-calibrated `--color-status-success`/`--color-status-warning`/
`--color-status-error` tokens (`index.css:144-160`, HSL values tuned separately per light/dark mode,
e.g. `--status-success: 152 69% 24%` light vs. a different value in `.dark`). That fix did not reach
sibling "severity" indicators elsewhere in the app, which independently reinvented the same red/amber/
green mapping with raw Tailwind palette classes that are **not** theme-calibrated:

- `layers/features/status/ui/ConnectionItem.tsx:30,37,44,59` — `bg-amber-500` / `bg-emerald-500` /
  `bg-red-500` for connection state, plus `:113` `text-red-500`/`text-amber-500` on the hover card icon
- `layers/features/top-nav/ui/SystemHealthDot.tsx:7-8` — `bg-amber-500`, `bg-red-500`
- `layers/entities/session/ui/SessionContextGauge.tsx:12-13` — `text-amber-500`, `text-red-500` (its own
  comment says _"matching `ContextItem`'s amber/red vocabulary"_ — i.e. explicitly copying a second
  ad-hoc source rather than the shared token)
- `layers/features/status/ui/ContextItem.tsx:48` — the vocabulary `SessionContextGauge` copies from
- `layers/features/relay/ui/RelayHealthBar.tsx:20-22` — `bg-emerald-500` / `bg-amber-500` / `bg-red-500`
- `layers/shared/ui/ConnectionStatusBanner.tsx:38-39` (in `shared/ui` itself) —
  `bg-red-500/10 text-red-600 dark:text-red-400` / `bg-amber-500/10 text-amber-600 dark:text-amber-400`,
  with a **manually written `dark:` variant** doing by hand what `--status-error-fg`/`--status-warning-fg`
  already do automatically
- `layers/shared/ui/provenance-chip.tsx:87,129` (also `shared/ui`) — `bg-amber-500/15 text-amber-700
dark:text-amber-400`

**Why it falls short:** this is precisely the drift the design system's own Sidebar section warns
about ("Status colour stays on the semantic tokens, which are already calibrated per theme... No raw
hex, and no new... variable — one ramp is the point"), just outside the sidebar. Each raw `amber-500`/
`red-500` is tuned for a generic Tailwind gray backdrop, not this app's specific off-white/near-black
surfaces, so contrast and "does this still look calm in dark mode" were never verified the way the
`--status-*` tokens' per-theme HSL values were. The `ConnectionStatusBanner` and `provenance-chip` cases
are the most concerning because they're `shared/ui` primitives other features build on, not one-off
feature code.

**Recommendation:** migrate all six files to `bg-status-warning`/`bg-status-error`/`bg-status-success`
(dot fills) and `text-status-warning-fg`/`text-status-error-fg`/`bg-status-warning-bg` etc. (text/banner
tints) — the token set already has fill, bg, border and fg variants sized for exactly these two use
cases (`index.css:144-160`). This deletes every hand-written `dark:` variant in the process, since the
tokens are already theme-aware. Where a component needs the _dot_ specifically, prefer importing
`STATUS_DOT_COLOR`/`statusDotClass()` directly rather than re-deriving the mapping a sixth time.

---

### [P2/S] `TASK_COLORS` re-implements the app's existing 5-color categorical palette with fixed, non-theme-tuned literals

**Current state:** `index.css` defines `--chart-1` through `--chart-5` twice — once under `:root`
(`:404-408`, e.g. `--chart-3: 152 60% 36%`) and once under `.dark` (`:493-497`, `--chart-3: 152 55% 50%`
— deliberately lighter in dark mode for legibility), exposed as `bg-chart-1`…`bg-chart-5` /
`text-chart-1`… via `--color-chart-*` (`:127-131`). This is the app's answer to "I need N mutually
distinguishable colors for a list of same-kind items," and `layers/features/gen-ui/ui/nodes/ChartNode.tsx:21-25`
uses it exactly that way. `layers/features/chat/model/use-background-tasks.ts:24-29` has the identical
need — a stable color per concurrently-running background task — and solves it independently:

```ts
export const TASK_COLORS = [
  'hsl(210 80% 60%)', // blue
  'hsl(150 60% 50%)', // green
  'hsl(270 60% 65%)', // purple
  'hsl(36 90% 55%)', // amber
  'hsl(340 75% 60%)', // rose
] as const;
```

**Why it falls short:** these five literal HSL values are identical in light and dark mode, unlike
`--chart-1..5`, which the codebase already tuned per-theme for exactly this reason. A background-task
color picked from this pool will not get the same light/dark legibility care the identical-shaped
`ChartNode` palette already received — this is light/dark drift by omission, and it is also a small DRY
violation (two hard-coded 5-item palettes solving one problem).

**Recommendation:** replace `TASK_COLORS` with the `--chart-1..5` tokens (`hsl(var(--chart-1))` etc.),
or if the exact hues need to differ from the chart palette for a documented reason, add the values as
proper `--task-chart-*` tokens in `index.css` with light/dark variants rather than literals in a
`.ts` model file.

---

### [P2/S] Terminal panel hardcodes its font stack independently of `--font-mono`, so a user's font override never reaches it

**Current state:** `layers/features/terminal/ui/TerminalInstance.tsx:329-332`
(`readTerminalTheme`) already derives the terminal's background/foreground from
`getComputedStyle(container)` specifically so the terminal "matches the active (light/dark) theme," per
its own doc comment. But the font isn't given the same treatment — `:135-136` sets xterm's `fontFamily`
to a literal string:

```ts
fontFamily:
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
```

`contributing/design-system.md`'s Typography section: _"Users can override font family via Settings →
Appearance. The app store (`setFontFamily`) loads Google Fonts dynamically and updates
`--font-sans`/`--font-mono` via JavaScript. Avoid hardcoding specific font names in component styles."_

**Why it falls short:** the component already proves it knows how to read live theme state off the DOM
for color, and explicitly does not extend that to font — so a user who sets a custom monospace font in
Settings → Appearance sees it in every code block and message but not in the terminal panel, which
silently keeps the hardcoded system-mono stack. This is exactly the hardcoding the doc calls out as an
anti-pattern.

**Recommendation:** read `--font-mono` off `getComputedStyle(container).fontFamily` (or off `:root`) the
same way `readTerminalTheme` already reads color, and pass that into the `Terminal` constructor instead
of the literal string. xterm requires a resolved string at construction time, so this needs to happen at
the same point `readTerminalTheme` runs, not via a class name.

---

### [P3/S] `ExecutionExceptionsStrip` falls back to a raw `#888` instead of the app's identity-color resolver

**Current state:** `layers/features/settings/ui/runtimes/ExecutionExceptionsStrip.tsx:112`:

```tsx
<AgentAvatar color={agent.color ?? '#888'} emoji={agent.icon ?? '\u{1F916}'} size="xs" />
```

Every other `AgentAvatar` call site in the app (`SidebarModelRow.tsx:359`, `SessionSwitcher.tsx:282`,
`AgentListItem.tsx:200`) passes `visual.color` sourced from `useAgentVisual`, which resolves through
`resolveIdentityFace` (`shared/lib/identity-face.ts`) — the function `contributing/design-system.md`'s
Identity section describes as hashing a deterministic color from the agent's id when no explicit color
is set, specifically so a colorless agent still reads as _an_ identity rather than falling back to a
flat gray.

**Why it falls short:** this is the one production call site that skips the resolver and writes a
literal `#888` instead, so an agent with no manifest color renders differently here (flat mid-gray) than
it would anywhere else in the app (a hashed, identity-specific hue). It's a minor, one-line-scope
inconsistency, but it's a real behavioral divergence from the rest of the identity system for the exact
"color missing" case the resolver exists to handle.

**Recommendation:** resolve `agent.color` the same way the other three call sites do (via
`useAgentVisual`/`resolveIdentityFace`) rather than inlining a fallback hex.

---

### [P3/S] Off-grid arbitrary indentation paddings repeated across sibling components

**Current state:** the 4px/8-point grid (`design-system.md` Spacing section: _"All spacing values are
multiples of 4px"_) is broken by two small clusters of arbitrary values that don't land on a 4px
boundary and are each repeated across near-identical sibling components rather than being one-off:

- `pl-[18px]` (not a multiple of 4 — 16px or 20px are the adjacent grid values) appears identically in
  three relay adapter-card files: `layers/features/relay/ui/adapter/AdapterCardError.tsx:21`,
  `AdapterCardBindings.tsx:58`, `AdapterCardHeader.tsx:95` — all three indenting sub-content under an
  adapter card header by the same odd amount.
- `pl-[1.375rem]` (22px, also off-grid) appears in `layers/features/settings/ui/runtimes/RuntimeCard.tsx:564`
  and `layers/entities/runtime/ui/RuntimeSetupDialog.tsx:557`, both aligning a caption under a row with
  a leading icon.

**Why it falls short:** because each value is copy-pasted across multiple files rather than defined
once, the codebase has committed to "18px" and "22px" as if they were tokens without ever making them
one — a future adjustment (e.g. matching the icon-slot width these paddings are visually chasing) means
hunting down 3 and 2 call sites respectively instead of touching one shared value.

**Recommendation:** if the icon-slot alignment these paddings approximate is a real, recurring layout
need (indent a caption to align under a leading icon), it deserves a small shared utility or a
`--indent-under-icon` custom property rather than a hand-copied magic number; at minimum, land both
values on the 4px grid (16px/20px, 20px/24px) so they're at least expressible as standard `pl-4`/`pl-5`
utilities.

---

### [P3/S] `NewMenu.tsx` uses `text-[12px]` where `text-xs` already gives the same value

**Current state:** `layers/features/dashboard-sidebar/ui/NewMenu.tsx:394` sets
`text-[12px] font-medium` on a sidebar pill. `text-xs` is 12px on the desktop base scale
(`design-system.md` Scale table). This is the only `text-[12px]` in the non-test, non-`/dev/` codebase
— an isolated case, unlike the systemic `10px`/`11px` pattern above — but it's a pure redundancy: the
arbitrary value adds nothing `text-xs` doesn't already provide, while (per Finding 2) it does lose the
mobile-scale multiplier.

**Recommendation:** `text-[12px]` → `text-xs`.

---

### [P3/M] Marketplace type/status badges hand-roll raw Tailwind palette + manual `dark:` pairs instead of a shared categorical or semantic token

**Current state:** `layers/features/marketplace/ui/PackageTypeBadge.tsx:10-14` assigns each of five
package types its own `border-<colour>/20 bg-<colour>/10 text-<colour>-600 dark:text-<colour>-400`
combination (blue/purple/emerald/amber/rose) written out by hand five times. Two sibling marketplace
files do the same for "featured"/"needs attention" style badges with different colors again:
`layers/features/marketplace/ui/InstalledPackagesView.tsx:76,81` (`bg-blue-100 ... dark:bg-blue-900`,
`bg-amber-100 ... dark:bg-amber-900`) and `PackageDetailSheet.tsx:171` (the same amber pair).

**Why it falls short:** this is the categorical-palette gap from Finding 5 recurring in badge form (five
distinct, hand-tuned light/dark pairs where `--chart-1..5` already solves "N distinguishable, theme-
aware categories") plus the `border-<colour>` bug from Finding 1 (the `border-blue-500/20` etc. on these
same badges render as neutral gray today). Every `dark:` pair here is also hand-maintained rather than
riding a token that already flips automatically.

**Recommendation:** fold into the Finding 1 and Finding 5 fixes rather than treating separately — once
`--chart-1..5` (or a small dedicated `--marketplace-type-*` set, if five is fixed by the type enum and
color meaning matters more than mutual distinguishability) exists as the source of truth, `PackageTypeBadge`
collapses from five hand-tuned pairs to five token references, and stops being three more sites hit by
the `border-<colour>` bug.

---

## Summary of scale (for prioritization)

| Pattern                                                                               | Files                       | Where                                                            |
| ------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `border-<colour>` renders as neutral (Finding 1)                                      | 63                          | app-wide                                                         |
| `text-[10px]`/`text-[11px]`/`text-[9px]` instead of `text-3xs`/`text-2xs` (Finding 2) | ~150 incl. 5 in `shared/ui` | app-wide, concentrated in mesh/topology, status, command-palette |
| Raw `size-4` icons vs. documented `size-[--size-icon-*]` (Finding 3)                  | 141 vs. 2                   | app-wide incl. `button.tsx` default                              |
| Ad-hoc red/amber/emerald status vocab vs. `--status-*` (Finding 4)                    | 6 (2 in `shared/ui`)        | status, relay, connections, top-nav                              |
