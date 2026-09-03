# UI States Audit — findings

Lens: **UI states** — hover, active/pressed, focus-visible, disabled, loading, empty, error, skeleton.

## Coverage

**Read in full before auditing:** `plans/ui-ux-audit-202609/00-charter.md`, `contributing/design-system.md` (all 1270 lines, including §Interaction States, §Tool Call Cards, §Hover Pattern Mobile Alternatives, §Identity interaction grammar), `contributing/animations.md`, `.claude/rules/{fsd-layers,components,conventions}.md`.

**Examined directly (read source, not just grepped):**

- `shared/ui`: `button.tsx`, `skeleton.tsx`, `data-table.tsx`, `checkbox.tsx`, `switch.tsx`, `input.tsx`, `copy-button.tsx`, `link-safety-modal.tsx`, `DirectoryPicker.tsx`, `filter-bar/FilterBarSort.tsx` — a broad slice of the ~90 shared primitives, weighted toward ones with custom interactive rows rather than the straight shadcn/Radix wraps (`select`, `tabs`, `popover`, `dialog`, etc., which inherit Radix's own state handling and were spot-checked but not read end to end).
- A programmatic scan of every `.tsx` under `layers/{features,widgets,entities}` (excluding `__tests__` and `/dev/`) for `<div>`/`<span>` elements carrying `onClick`, cross-checked by hand for `hover:`/`focus-visible`/`role`/`tabIndex` presence — 12 hits, each read in context.
- A second scan for files calling `.map()` without any of `isLoading`/`isPending`/`isError`/an empty-length check, to surface list surfaces silently missing a state branch — 88 raw hits, triaged by hand (most are static config arrays, not data-backed lists); the real ones are below.
- Every file named `*Row.tsx` under `layers/` (37 files) — grepped for `hover:`/`onClick`/`focus-visible` counts and the outliers read in full.
- Deep reads: `features/chat/ui/tools/ToolCallCard.tsx` + `features/chat/ui/primitives/CollapsibleCard.tsx` (shared by 5 consumers), `entities/session/ui/SessionRowFull.tsx` + `SessionRowCompact.tsx`, `features/tasks/ui/TaskRow.tsx`, `features/chat/ui/tasks/TaskRow.tsx`, `widgets/team/ui/TeamPage.tsx` + `features/team-roster/ui/TeamRosterGrid.tsx`, `widgets/activity/ui/ActivityTimeline.tsx` + `widgets/activity/ActivityPage.tsx`, `widgets/connections/ui/AccountsRegion.tsx` + `MessagingRegion.tsx`, `features/feedback-requests/ui/FeedbackRequestsPanel.tsx`, `features/inbox/ui/InboxList.tsx`, `features/marketplace/ui/PackageCard.tsx` + `PackageLoadingSkeleton.tsx`, `features/dashboard-sidebar/ui/boot/SidebarSkeleton.tsx`.
- Checked `decisions/` for anything settling `CollapsibleCard`/tool-card hover styling or `Button` press feedback before flagging either — found nothing that overrides the design system's own stated defaults.

**Sampled but not read in depth (named for honest gap-tracking):** `canvas/`, `gen-ui/` node renderers, `terminal/`, `extensions/`, `mcp-apps/`, `room-management/`, `schedule-approval/`, `onboarding/`, `tours/`, `shapes/`, `presence-strip/`, `right-panel/`, `one-bar/`, `mobile-tabs/`, `control-center/`, `pulse/`, `home/` widgets, `diff-review/`, `file-explorer/`, `cloud-link/`, `auth/`, `full-power-door/`, `telemetry-consent/`, `report-issue/`, `notifications/`, `jump-back-in/`, `dashboard-attention/`, `dashboard-activity/`, `top-nav/`, most of `settings/`'s ~20 tab files. The Dev Playground (24 pages) was not driven live; findings are static-analysis only, not verified in a running browser.

**Not flagged despite touching this lens:** the sidebar's hover/focus/mobile-touch system (`sidebar-row.tsx`, `sidebar.tsx`, `sidebar-menu-node.tsx`) — `design-system.md` documents it in exhaustive, recently-dated detail (§Separation by tint, §Zones and Sections, §Accessibility contract, §Hover Pattern Mobile Alternatives) and spot checks matched the doc; a fresh pass looked like the lowest-yield place to spend time here.

---

### [P1/S] The shared `Button` primitive has no active/press feedback

`contributing/design-system.md` states as a universal rule (not a per-component opt-in): "**Active/Press:** Scale down to 0.97-0.98 for 100ms. Immediate, tactile." At least 15 hand-rolled interactive elements implement exactly this — `layers/shared/ui/sidebar.tsx:490` (`active:scale-[0.97]`), `layers/shared/ui/sidebar-row.tsx:555` (`active:scale-[0.98]`), `layers/entities/session/ui/SessionRowCompact.tsx:95` (`active:scale-[0.98]`), `layers/features/team-roster/ui/TeamMemberCard.tsx:240` (`active:scale-[0.99]`), `layers/features/profile/ui/ProfileRow.tsx:173` (`active:scale-[0.99]`), `layers/features/entry-actions/ui/EntryActionMenu.tsx:72,90` (`active:scale-95`), among others.

But `layers/shared/ui/button.tsx:7-39` — the `buttonVariants` cva powering every `<Button>` in the app across all 7 variants and 8 sizes — has no `active:` class anywhere in the string, and `Button` (lines 68-91) never uses `whileTap` either. `disabled:pointer-events-none disabled:opacity-50` is the only state suffix present. Every ordinary dialog "Save", toolbar action, or form submit button in DorkOS — the single most-instantiated interactive primitive in the codebase — gives zero tactile feedback on press, while a session row or a sidebar item two clicks away does.

**Recommendation:** add `active:scale-[0.98] transition-transform` (matching the 0.97-0.98 spec, `100ms`) to `buttonVariants`' base string in `button.tsx:8`. One line, cascades to every Button instance app-wide.

---

### [P1/S] `CollapsibleCard` — the tool-call/thinking/subagent/memory card shared by 5 consumers — has no hover state and no focus-visible ring

`contributing/design-system.md`'s own "Tool Call Cards" section documents: "**Hover:** border darkens slightly, subtle shadow appears." `layers/features/chat/ui/primitives/CollapsibleCard.tsx` is the one component behind `ToolCallCard`, `ThinkingBlock`, `SubagentBlock`, `CollapsibleRun`, and `MemoryRecallBlock` (confirmed by grep — all 5 import it). Its outer card (`CollapsibleCard.tsx:50-58`) has `border-l-2` only (no full border to darken) and no `hover:` class beyond `dimmed && !expanded && 'opacity-50 hover:opacity-100'` — which only fires on _already-dimmed, completed_ cards, is an opacity fade rather than the documented border/shadow, and does nothing for a running or expanded card. The header `<button>` (lines 61-67) that actually toggles the card has no `hover:bg-*` background at all, and — more significantly — no `focus-visible:` ring class anywhere in the file. Every other interactive primitive in `shared/ui` uses either the `focus-ring` utility or an explicit `focus-visible:ring-*` class (see `button.tsx:8`, `input.tsx:18`, `copy-button.tsx:50`); this one, rendered dozens of times in every session transcript, falls back to the browser's unstyled default outline — the one interaction spec explicitly bans as "wired to nothing" in reverse (here it's the opposite failure: a real, reachable control with no branded ring).

**Recommendation:** add `hover:border-l-muted-foreground/50 hover:shadow-soft transition-shadow` (or equivalent, scoped to the state Calm Tech already uses for `card-interactive`) to the card wrapper, and add `focus-ring` (the shared utility from `index.css:558`) to the header `<button>` className at `CollapsibleCard.tsx:64`. One file, fixes all 5 consumers at once.

---

### [P1/S] `FilterBarSort`'s direction toggle is keyboard-unreachable

`layers/shared/ui/filter-bar/FilterBarSort.tsx:46-60`:

```tsx
<span
  role="button"
  tabIndex={-1}
  onClick={toggleDirection}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { ... toggleDirection(...) } }}
  className="hover:bg-muted -mr-1 rounded p-0.5"
  aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
>
```

This element has a full keyboard handler (`onKeyDown` for Enter/Space) and an `aria-label`, signaling it's meant to be keyboard-operable — but `tabIndex={-1}` removes it from the tab sequence entirely, so no keyboard user can ever focus it to trigger that handler. It's also nested inside a `DropdownMenuTrigger` (`FilterBarSort.tsx:38`), which Radix renders as a `<button>` — an interactive `role="button"` inside a real `<button>` is invalid HTML on top of the focus problem. The sort-direction toggle (ascending/descending) is mouse-only. `design-system.md`'s own rule cuts the other way too ("never put a `focus-visible:` ring on something no keyboard can reach") — this is the same defect from the opposite direction: real behavior with no way to reach it.

**Recommendation:** pull the direction toggle out of the `DropdownMenuTrigger` as a sibling real `<button type="button">` with `tabIndex={0}` (default) and a `focus-ring`/`focus-visible:` class, so it's both valid HTML and keyboard-reachable. `FilterBar` is used across every filterable list surface (`filter-bar/` is charter-listed shared/ui), so this is one fix with broad reach.

---

### [P2/S] Sibling inconsistency: `SessionRowFull` has no hover state, `SessionRowCompact` does

`layers/entities/session/ui/SessionRowFull.tsx:100-139` — the row's clickable `motion.div` (`role="button" tabIndex={0}`, lines 125-139) carries `className="relative z-10 cursor-pointer px-3 py-2"` and the wrapping `motion.div` at line 108 is `className={cn('group relative rounded-lg border-l-2 transition-colors duration-150', isActive && 'text-foreground')}` — no `hover:` anywhere in the file outside the nested edit/expand icon buttons (line 157, 166-170), which are themselves opacity-gated to `group-hover`. An _inactive_ full-variant session row gives the user no feedback that it is hovering a clickable target at all.

Compare `layers/entities/session/ui/SessionRowCompact.tsx:94-98`, same `SessionRow` family, one prop away:

```tsx
className={cn(
  ...
  isActive ? '...' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
)
```

This is exactly the pattern the charter calls out by name: "one row highlights on hover, its sibling does not." Both variants render real sessions — `SessionRow` (`entities/session/ui/SessionRow.tsx`) is consumed by `features/session-list/ui/SessionsView.tsx` (the Obsidian embed's chrome, per `design-system.md`'s Sidebar section) and `features/status/ui/SessionPopover.tsx`.

**Recommendation:** add a `hover:bg-secondary/60`-class background (or reuse the `bg-secondary` the active state already uses at a lower opacity) to the non-active branch of `SessionRowFull.tsx`'s outer `motion.div`, matching `SessionRowCompact`'s treatment.

---

### [P2/S] `tasks/ui/TaskRow.tsx`'s primary click target has no hover or focus-visible feedback, unlike its own nested buttons

`layers/features/tasks/ui/TaskRow.tsx:169-174` — the entire card header (`role="button" tabIndex={0}`, toggles expand/collapse, the row's main interaction):

```tsx
<div
  role="button"
  tabIndex={0}
  className="flex cursor-pointer items-center gap-3 p-3"
  onClick={onToggleExpand}
  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggleExpand()}
>
```

`flex cursor-pointer items-center gap-3 p-3` is the entire className — no `hover:`, no `focus-visible:`. Meanwhile every action button _inside_ this same card (Approve/Reject/Edit/Delete, lines 254, 260, 268, 288, 299, 368, 374) carries a full `hover:bg-accent hover:text-accent-foreground ... transition-colors` treatment. The one region a user is most likely to click — the row itself, to expand it — is the one region with zero affordance.

**Recommendation:** add `hover:bg-accent/50 focus-visible:bg-accent/50 transition-colors` (or the `focus-ring` utility) to the row's className at line 172.

---

### [P2/S] `chat/ui/tasks/TaskRow.tsx` subtask row has no hover or focus-visible state anywhere in the file

`layers/features/chat/ui/tasks/TaskRow.tsx:52-70` — a `role="button" tabIndex={0}` row (toggles a subtask's expanded detail) with `onMouseEnter`/`onMouseLeave` wired only to a cross-row dependency-highlight callback (`onHover`), not to its own visual state. A grep of the whole file for `hover:` and `focus-visible` returns zero matches. The row's className (lines 61-69) varies by `task.status` (completed/in-progress/pending) and by dependency-highlight state, but never by pointer-hover or keyboard-focus on itself — a keyboard user tabbing through a task list gets no indication which row is about to activate on Enter, and a mouse user gets no rollover cue distinct from the dependency-highlight side effect.

**Recommendation:** add a `hover:bg-muted/40` (or similar low-contrast tint, matching the "5-10% background tint" the Interaction States doc specifies) plus a `focus-visible:` twin to the row className.

---

### [P2/S] `ActivityPage` never surfaces a fetch error — a failed request renders identically to "nothing happened this week"

`layers/widgets/activity/ActivityPage.tsx:32-33` destructures `useFullActivityFeed(queryFilters)` as `{ data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage }` — no `isError`. `layers/widgets/activity/ui/ActivityTimeline.tsx:95-129` only branches on `isLoading` and `items.length === 0`; there is no error branch at all. If the activity query fails after the initial load (or the very first load fails and the hook settles `isLoading: false` with no data), `allItems` is `[]` and the page renders `ActivityEmptyState` — the same UI a genuinely quiet week produces. A real backend problem is indistinguishable from "you haven't done anything."

This is a real regression from the app's own established pattern: `widgets/connections/ui/AccountsRegion.tsx:45-58` (explicit isError branch, "Couldn't load your services" + retry), `widgets/team/ui/TeamPage.tsx:114-131` ("Could not load your team" + retry), `features/feedback-requests/ui/FeedbackRequestsPanel.tsx:140-161` ("Couldn't load your reports" + retry), and `features/inbox/ui/InboxList.tsx:136` all handle this exact case. Activity is the odd one out among the app's major query-backed list surfaces.

**Recommendation:** thread `isError`/`refetch` out of `useFullActivityFeed` and add an error branch to `ActivityTimeline` (or a sibling conditional in `ActivityPage`) matching the retry-button pattern already standard elsewhere in the app.

---

### [P2/S] `TeamPage`'s loading state is a bare spinner, not a layout-matching skeleton — inconsistent with the app's established pattern

`layers/widgets/team/ui/TeamPage.tsx:103-112`:

```tsx
if (isLoading) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Loader2
        aria-label="Loading the team"
        className="text-muted-foreground size-5 animate-spin"
      />
    </div>
  );
}
```

A centered spinner with no card/grid shape. When data arrives, the page pops from an empty centered dot to a full responsive grid of `TeamMemberCard`s (`TeamRosterGrid.tsx`, `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3`) — the largest possible layout jump this pattern can produce.

Compare the app's own precedent, which the charter explicitly asks auditors to check for: `layers/features/marketplace/ui/PackageLoadingSkeleton.tsx:1-39` — its own doc comment states "The card structure mirrors `PackageCard` dimensions so the layout does not jump when real data arrives" — and `layers/features/dashboard-sidebar/ui/boot/SidebarSkeleton.tsx:1-48`, whose doc comment says "It reserves, it does not entertain... at exactly the geometry the real panel uses, so when the real rows arrive nothing under the operator's pointer moves." Team is a comparably major, card-grid surface (same shape problem PackageLoadingSkeleton already solved) and got the plainer treatment.

**Recommendation:** add a `TeamRosterSkeleton` mirroring `TeamMemberCard`'s dimensions in the same grid, following the `PackageLoadingSkeleton` precedent already in the codebase.

---

### [P3/S] `Button`'s disabled state omits `cursor-not-allowed`, present on sibling primitives

`design-system.md`'s Disabled section: "Opacity 0.5. No cursor change beyond `not-allowed`." `layers/shared/ui/button.tsx:8` sets `disabled:pointer-events-none disabled:opacity-50` — no `disabled:cursor-not-allowed`. `layers/shared/ui/input.tsx:16` sets `disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50`, and `layers/shared/ui/checkbox.tsx:17` sets `disabled:cursor-not-allowed disabled:opacity-50`. In practice `pointer-events-none` makes the omission mostly moot for `Button` (the cursor falls through to whatever is beneath it either way), but the three primitives' cva strings disagree with each other for no documented reason, and a future edit that drops `pointer-events-none` from `Button` (to allow a `title` tooltip on hover, say) would silently regress the cursor too.

**Recommendation:** add `disabled:cursor-not-allowed` to `button.tsx:8` for consistency with `input.tsx`/`checkbox.tsx`, independent of whether `pointer-events-none` stays.

---

### [P3/S] `AdapterNode` ghost placeholder has hover feedback but no focus-visible ring

`layers/features/mesh/ui/AdapterNode.tsx:154-168` — the "Add adapter" ghost node is a `role="button" tabIndex={0}` div with `hover:opacity-70` on its className (line 157) but no `focus-visible:` class anywhere in the block. It's keyboard-operable (`onKeyDown` handles Enter/Space) and correctly reachable, but a keyboard user tabbing through the topology graph gets no visual confirmation this node is focused before pressing Enter.

**Recommendation:** add `focus-ring` (or an explicit `focus-visible:ring-2 focus-visible:ring-ring` twin to the existing `hover:opacity-70`) to the className at line 157.

---

### [P3/S] `ScrollThumb`'s draggable thumb has no hover affordance distinguishing it as grabbable

`layers/features/conversation/ui/ScrollThumb.tsx:153-158` — the thumb element (`cursor-pointer`, draggable via `onPointerDown`) only changes `opacity` based on scroll activity (visible/faded), never in response to `:hover`. A user moving the pointer toward the thumb to grab it gets no rollover cue (darker fill, wider hit target) confirming it's interactive versus just decorative scroll-position chrome — the track itself (`role="presentation"`, line 140-152) also has no `hover:` treatment.

**Recommendation:** add a subtle `hover:bg-foreground/40` (over the current `bg-border`) to the thumb, matching the "5-10% tint step" Interaction States convention.
