[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 4 — Tokens that don't paint

**Priority P1 · 9 findings · 5S · 2M · 2L**
**Scope:** the design tokens exist, are correct, and are not what the app actually renders. The first two items are large sweeps and want their own PRs; the rest fit one slice each.

### 4.1 — `border-<colour>` renders as the neutral border on 69 files

**P1 · M · lens 1**
`apps/client/src/index.css:673-675`; 69 affected files including `layers/features/mesh/ui/DiscoveryView.tsx:262,322`, `layers/features/settings/ui/TunnelDialog.tsx:207-209`, `layers/features/tasks/ui/TaskTemplateCard.tsx:70`, `layers/features/chat/ui/chips/TouchChip.tsx:148,178`, `layers/features/marketplace/ui/PackageTypeBadge.tsx:10-14`, `layers/features/gen-ui/ui/nodes/TimelineNode.tsx:22-23`

**Evidence.** Verified in source:

```css
*:where(:not(.copilot-view-content *)) {
  border-color: hsl(var(--border));
}
```

This rule is **unlayered**. Tailwind v4 generates every utility inside `@layer utilities`, and per the cascade-layers spec an unlayered normal-priority declaration always beats a layered one regardless of specificity — so this near-zero-specificity universal rule outranks every coloured border utility in the app. `contributing/design-system.md:602` documents the exact mechanism and states it was "verified in a browser". What this audit adds is the blast radius: **69 files** (counted) still write a `border-<colour>` expecting it to render. `TunnelDialog` switches between `border-amber-400/40`, `border-destructive/40` and neutral on tunnel state — three states meant to look different at a glance, rendering identically. `TaskTemplateCard`'s `border-primary` selected state does not paint. This is dead styling shipping in production, and the count keeps growing because the obvious Tailwind class is a trap.

**Recommendation.** Treat as Hard-Rule-adjacent, not polish. Do the layering fix the doc already calls for — move the `*:where(…)` rule into a layer below `utilities`, or scope it narrowly enough that it stops shadowing colour utilities — then visually re-review. That fixes all 69 sites at once, which is the Calm-Tech-correct answer over 69 component patches. If the layering fix must be deferred, add an ESLint rule banning `border-<colour>` outside `shared/ui` so the count stops growing.

### 4.2 — Arbitrary `text-[Npx]` bypasses the type ramp and the mobile scale — 203 hits

**P1 · L · lenses 1 + 8**
`apps/client/src/index.css:87-90` (the tokens); 203 occurrences across ~100 files, 76 files at `text-[10px]` alone. In `shared/ui` itself: `kbd.tsx:8`, `trust-dial.tsx:423`, `provenance-chip.tsx:85`, `identity-hover-card.tsx:96,332`, `responsive-dropdown-menu.tsx:232,322`, `sidebar-row.tsx:191,555`, `section-header.tsx:187,214`

**Evidence.** Counted by grep. `index.css` defines two sub-`text-xs` tokens specifically so nothing has to drop to a raw pixel value:

```css
--text-3xs: calc(0.625rem * var(--_st) * var(--user-font-scale, 1)); /* 10px → 12.5px mobile */
--text-2xs: calc(0.6875rem * var(--_st) * var(--user-font-scale, 1)); /* 11px → 13.75px mobile */
```

Both multiply by `--_st`, the mobile-scale multiplier, and by the user's own font-scale setting. An arbitrary-bracket value compiles to a literal, unscaled `font-size` that participates in neither. So most of the app's finest-grained text — timestamps, badges, kbd hints, legends, mesh node chips, model pickers — is exempt from the responsive type-scale contract the design system advertises, and two visually identical 10px labels in adjacent components scale differently on a phone. `text-[9px]` (10 hits, e.g. `AttentionCountBadge.tsx:39`, `BindingEdge.tsx:165,170`) is below the whole ramp with no token at all.

**Recommendation.** Mechanical replace: `text-[10px]` → `text-3xs`, `text-[11px]`/`text-[0.6875rem]` → `text-2xs`. Start with the `shared/ui` primitives listed above — one change propagates everywhere `Kbd`/`ProvenanceChip`/`IdentityHoverCard`/`ResponsiveDropdownMenu` are used. The `text-[9px]` sites need a decision first: a real `text-4xs` token, or a bump to `text-3xs`. Legitimate exceptions stay literal and should be commented: `kbd.tsx` if shortcut hints are deliberately desktop-only, and the `text-[13px]`/`text-[17px]` iOS-HIG values in `responsive-dropdown-menu.tsx`. Add a lint rule banning `text-\[[0-9]+px\]` outside `dev/` once the backlog clears.

### 4.3 — The documented icon-size convention has two adopters against 141 files

**P2 · L · lens 1**
`apps/client/src/index.css:98-100`, `apps/client/src/layers/shared/ui/button.tsx:8`; adopters: `layers/features/shapes/ui/ShapeSwitcherDialog.tsx`, `ShapeForkForm.tsx` (verified — exactly these two files)

**Evidence.** `index.css` defines a three-step icon scale multiplying by `--_si` (12→15px, 16→20px, 20→25px on mobile), and `design-system.md`'s Icon Size Convention says "use `size-[--size-icon-*]` for all icon sizing". Verified: **two files** use it, both in one feature slice. Elsewhere icons are sized with plain `size-4` (141 files), and `button.tsx:8` bakes `[&_svg:not([class*='size-'])]:size-4` in as the default for every unsized `<svg>` inside a `Button` — so the majority of icon-bearing buttons inherit the non-scaling default before a call site can opt in. On desktop the two are visually identical, which is why the drift went unnoticed; below 768px the convention grows icons 25% and the codebase does not.

**Recommendation.** Decide, then finish. Either (a) confirm the convention and migrate `shared/ui` defaults first — starting with `button.tsx`'s default rule, which fixes icon scaling for every button in one place — or (b) retire the doc section and the two adopting files. Do not leave both states shipping side by side.

### 4.4 — Status colour is spelled seven ways across relay, status, tasks, top-nav and `shared/ui`

**P2 · M · lenses 1 + 3 + 12**
Intended source: `apps/client/src/layers/shared/ui/status-dot.ts`. Divergent: `layers/entities/relay/lib/adapter-state-colors.ts:12-19`, `layers/features/relay/lib/status-colors.ts:2-62`, `layers/features/relay/ui/MessageTrace.tsx:9-26`, `layers/features/relay/ui/RelayHealthBar.tsx:18-22`, `layers/features/tasks/ui/TaskRow.tsx:72-82`, `layers/features/status/ui/ConnectionItem.tsx:30,37,44,59,113`, `layers/features/top-nav/ui/SystemHealthDot.tsx:7-8`, `layers/entities/session/ui/SessionContextGauge.tsx:12-13`, `layers/features/status/ui/ContextItem.tsx:48`, `layers/shared/ui/ConnectionStatusBanner.tsx:38-39`, `layers/shared/ui/provenance-chip.tsx:87,129`

**Evidence.** `status-dot.ts`'s own module doc records the original bug: _"a green that was `bg-green-500` in the sidebar, `bg-emerald-500` in an agent panel, `bg-status-success` in a room and `bg-primary` in a group header — four spellings of one fact… This module is the spelling."_ That fix reached identity and sidebar surfaces and stopped. Verified in source: `tasks/TaskRow.tsx`'s `StatusDot` still returns `'bg-yellow-500'` / `'bg-neutral-400'` / `'bg-green-500'` — raw palette, no tokens, no `statusDotClass` — while `RoomRow.tsx:413`, `SessionSwitcher.tsx:423` and `SessionRowSidebar.tsx:248` all call it correctly. Relay independently grew four more maps, including `RelayHealthBar`'s `healthy: 'bg-emerald-500'` against `status-colors.ts`'s `healthy: 'bg-green-500'` — the exact green-versus-emerald drift the doc names as the original bug, reproduced inside one feature. `MessageTrace` adds `bg-slate-400` and `bg-yellow-500`, colours in none of the other maps. `adapter-state-colors.ts` even hand-types `motion-safe:animate-pulse`, duplicating `STATUS_DOT_PULSE` verbatim rather than importing it. Two of the offenders are `shared/ui` primitives, and `ConnectionStatusBanner` hand-writes `dark:` variants doing by hand what `--status-error-fg`/`--status-warning-fg` already do.

**Recommendation.** Extend `StatusSignal`/`STATUS_DOT_COLOR` (or add a thin relay adapter mapping `starting`/`reconnecting`/`no_subscriber`/`timeout` onto the four semantic tokens plus a neutral) so all of these resolve through the one vocabulary. Delete `adapter-state-colors.ts`, `status-colors.ts` and the two inline maps once callers are re-pointed. Migrate the text/banner tints to `text-status-*-fg`/`bg-status-*-bg`, which deletes every hand-written `dark:` variant in the process. This is the repo's own three-strike DRY rule at seven strikes.

### 4.5 — `TASK_COLORS` re-implements the app's categorical palette with fixed, non-theme-tuned literals

**P2 · S · lens 1**
`apps/client/src/layers/features/chat/model/use-background-tasks.ts:24-29`; compare `apps/client/src/index.css` `--chart-1..5` (`:404-408` light, `:493-497` dark) and `layers/features/gen-ui/ui/nodes/ChartNode.tsx:21-25`

**Evidence.** `--chart-1..5` exists as the app's answer to "N mutually distinguishable colours for same-kind items", and is deliberately tuned per theme (`--chart-3: 152 60% 36%` light vs `152 55% 50%` dark). `use-background-tasks.ts` has the identical need — a stable colour per concurrently-running background task — and hard-codes five `hsl(...)` literals identical in light and dark.

**Recommendation.** Replace `TASK_COLORS` with `hsl(var(--chart-1))`…`hsl(var(--chart-5))`. If the hues genuinely need to differ, add `--task-chart-*` tokens in `index.css` with light/dark variants rather than literals in a `.ts` model file.

### 4.6 — Terminal hardcodes its font stack, so a user's font override never reaches it

**P2 · S · lens 1**
`apps/client/src/layers/features/terminal/ui/TerminalInstance.tsx:135-136`; compare `:329-332` (`readTerminalTheme`)

**Evidence.** The component already derives the terminal's background and foreground from `getComputedStyle(container)` specifically so it "matches the active (light/dark) theme", per its own doc comment. It does not extend that to the font: xterm's `fontFamily` is a literal `'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'`. `design-system.md`'s Typography section: _"Users can override font family via Settings → Appearance… Avoid hardcoding specific font names in component styles."_ So a custom monospace font appears in every code block and message but not in the terminal.

**Recommendation.** Read `--font-mono` off `getComputedStyle(container).fontFamily` at the same point `readTerminalTheme` runs, and pass it into the `Terminal` constructor. xterm needs a resolved string at construction, so this cannot be a class name.

### 4.7 — `ExecutionExceptionsStrip` falls back to a raw `#888` instead of the identity resolver

**P3 · S · lens 1**
`apps/client/src/layers/features/settings/ui/runtimes/ExecutionExceptionsStrip.tsx:112`

**Evidence.** `<AgentAvatar color={agent.color ?? '#888'} …>`. Every other `AgentAvatar` call site (`SidebarModelRow.tsx:359`, `SessionSwitcher.tsx:282`, `AgentListItem.tsx:200`) passes `visual.color` from `useAgentVisual`, which resolves through `resolveIdentityFace` — the function that hashes a deterministic colour from the agent's id precisely so a colourless agent still reads as _an_ identity rather than flat grey. This is the one production site that skips it, for the exact case the resolver exists to handle.

**Recommendation.** Resolve `agent.color` through `useAgentVisual`/`resolveIdentityFace` like the other three call sites.

### 4.8 — Off-grid indentation paddings copy-pasted across sibling components

**P3 · S · lens 1**
`pl-[18px]` in `layers/features/relay/ui/adapter/AdapterCardError.tsx:21`, `AdapterCardBindings.tsx:58`, `AdapterCardHeader.tsx:95`; `pl-[1.375rem]` in `layers/features/settings/ui/runtimes/RuntimeCard.tsx:564`, `layers/entities/runtime/ui/RuntimeSetupDialog.tsx:557`

**Evidence.** `design-system.md`'s Spacing section: "All spacing values are multiples of 4px." 18px and 22px are not, and each is copy-pasted across multiple files rather than defined once — so the codebase has committed to them as if they were tokens without making them one. Both are visually chasing the same thing: aligning a caption under a leading icon.

**Recommendation.** If "indent a caption under a leading icon" is a real recurring need, give it a shared utility or an `--indent-under-icon` custom property. At minimum land both on the 4px grid (`pl-4`/`pl-5`, `pl-5`/`pl-6`) so they are expressible as standard utilities.

### 4.9 — `NewMenu` uses `text-[12px]` where `text-xs` is the same value

**P3 · S · lens 1**
`apps/client/src/layers/features/dashboard-sidebar/ui/NewMenu.tsx:394`

**Evidence.** `text-xs` is 12px on the desktop base scale. This is the only `text-[12px]` in the non-test, non-`dev/` codebase — an isolated redundancy, unlike the systemic 10px/11px pattern in 4.2 — and it still loses the mobile-scale multiplier.

**Recommendation.** `text-[12px]` → `text-xs`. Fold into the 4.2 sweep.
