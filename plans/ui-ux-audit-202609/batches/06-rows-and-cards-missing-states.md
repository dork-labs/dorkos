[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 6 — Rows and cards missing their own states

**Priority P2 · 8 findings · 8S**
**Scope:** feature-level rows and page-level query states. All single-file class or branch additions; no shared primitive changes. Good parallel work alongside batch 5.

### 6.1 — `SessionRowFull` has no hover state; `SessionRowCompact` does

**P2 · S · lens 9**
`apps/client/src/layers/entities/session/ui/SessionRowFull.tsx:100-139`; compare `SessionRowCompact.tsx:94-98`

**Evidence.** The clickable `motion.div` (`role="button" tabIndex={0}`) carries `'relative z-10 cursor-pointer px-3 py-2'`, and its wrapper is `cn('group relative rounded-lg border-l-2 transition-colors duration-150', isActive && 'text-foreground')` — no `hover:` anywhere in the file outside the nested edit/expand icon buttons, which are themselves `group-hover` opacity-gated. Its sibling one prop away has `isActive ? '…' : 'text-muted-foreground hover:bg-accent hover:text-foreground'`. This is the charter's named case: one row highlights on hover, its sibling does not. Both render real sessions (`SessionsView`, `SessionPopover`).

**Recommendation.** Add a `hover:bg-secondary/60` background to the non-active branch of the outer `motion.div`, matching `SessionRowCompact`'s treatment.

### 6.2 — `tasks/TaskRow`'s primary click target has no hover or focus feedback, unlike its own nested buttons

**P2 · S · lens 9**
`apps/client/src/layers/features/tasks/ui/TaskRow.tsx:169-174`

**Evidence.** The card header — `role="button" tabIndex={0}`, toggles expand/collapse, the row's main interaction — has `'flex cursor-pointer items-center gap-3 p-3'` as its _entire_ className: no `hover:`, no `focus-visible:`. Every action button _inside_ the same card (Approve, Reject, Edit, Delete at lines 254, 260, 268, 288, 299, 368, 374) carries full `hover:bg-accent hover:text-accent-foreground … transition-colors`. The region a user is most likely to click is the one with zero affordance.

**Recommendation.** Add `hover:bg-accent/50 focus-visible:bg-accent/50 transition-colors` (or the `focus-ring` utility) to the row's className.

### 6.3 — `chat/ui/tasks/TaskRow`'s subtask row has no hover or focus state anywhere in the file

**P2 · S · lens 9**
`apps/client/src/layers/features/chat/ui/tasks/TaskRow.tsx:52-70`

**Evidence.** A `role="button" tabIndex={0}` row whose `onMouseEnter`/`onMouseLeave` are wired only to a cross-row dependency-highlight callback, not to its own visual state. A grep of the whole file for `hover:` and `focus-visible` returns zero. The className varies by `task.status` and by dependency-highlight state, never by pointer-hover or keyboard-focus on itself — so a keyboard user tabbing a task list has no indication which row Enter will activate.

**Recommendation.** Add a `hover:bg-muted/40` tint (the documented 5-10% step) plus a `focus-visible:` twin.

### 6.4 — `ActivityPage` never surfaces a fetch error; a failed request looks like a quiet week

**P2 · S · lens 9**
`apps/client/src/layers/widgets/activity/ActivityPage.tsx:32-33`, `apps/client/src/layers/widgets/activity/ui/ActivityTimeline.tsx:95-129`

**Evidence.** Verified in source: `ActivityPage` destructures `{ data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage }` — **no `isError`** — and `ActivityTimeline` branches only on `isLoading` and `items.length === 0`. If the query fails, `allItems` is `[]` and the page renders `ActivityEmptyState`: the same UI a genuinely quiet week produces. A backend problem is indistinguishable from "you haven't done anything." This is a regression from the app's own established pattern — `AccountsRegion.tsx:45-58`, `TeamPage.tsx:114-131` (verified: explicit `isError` branch, "Could not load your team" + Retry), `FeedbackRequestsPanel.tsx:140-161` and `InboxList.tsx:136` all handle it.

**Recommendation.** Thread `isError`/`refetch` out of `useFullActivityFeed` and add an error branch matching the retry pattern already standard elsewhere. Pairs with 17.2, which extracts that pattern into one component.

### 6.5 — `TeamPage` loads with a bare spinner, not a layout-matching skeleton

**P2 · S · lens 9**
`apps/client/src/layers/widgets/team/ui/TeamPage.tsx:103-112`; compare `apps/client/src/layers/features/marketplace/ui/PackageLoadingSkeleton.tsx:1-39`, `apps/client/src/layers/features/dashboard-sidebar/ui/boot/SidebarSkeleton.tsx:1-48`

**Evidence.** Verified in source: the loading branch is a centred `Loader2` spinner with no card or grid shape. When data arrives the page pops from an empty centred dot to a full `grid-cols-1 md:grid-cols-2 xl:grid-cols-3` of `TeamMemberCard`s — the largest layout jump this pattern can produce. The app's own precedent is explicit: `PackageLoadingSkeleton`'s doc comment says "The card structure mirrors `PackageCard` dimensions so the layout does not jump when real data arrives", and `SidebarSkeleton`'s says "It reserves, it does not entertain… at exactly the geometry the real panel uses." Team is the same shape of problem and got the plainer treatment.

**Recommendation.** Add a `TeamRosterSkeleton` mirroring `TeamMemberCard`'s dimensions in the same grid, following `PackageLoadingSkeleton`.

### 6.6 — Dashed border means "not available yet" and "live and serving" on the same page

**P2 · S · lens 9**
`apps/client/src/layers/features/relay/ui/adapter/AdapterCard.tsx:104-114`; compare `apps/client/src/layers/features/connections/ui/AccountsFirstRun.tsx:57`

**Evidence.** On `/connections`, the Accounts section's Gmail/GitHub/Linear/Notion/Slack preview cards use `border border-dashed` to mean "not yet connectable — no Composio key configured", and the Marketplace `?view=installed` empty state uses the same convention for "No packages installed". But the **live, enabled, actively-serving** Claude Code adapter directly above also renders dashed — `isBuiltinClaude && 'border-dashed'`, with no comment explaining why — with a green active dot, a toggled-on switch and "Serving 1 agent" inside a box that everywhere else on the same screen means "this doesn't exist yet."

**Recommendation.** Drop the special-cased dashed border for the built-in adapter; it already carries an "internal" badge. If a distinction is still wanted, use something that does not collide with the empty/unavailable convention — a muted label, not a border style.

### 6.7 — `ScrollThumb`'s draggable thumb has no hover affordance

**P3 · S · lens 9**
`apps/client/src/layers/features/conversation/ui/ScrollThumb.tsx:140-158`

**Evidence.** The thumb is `cursor-pointer` and draggable via `onPointerDown`, but only changes `opacity` based on scroll activity, never in response to `:hover`. A user moving the pointer toward it to grab it gets no cue distinguishing it from decorative scroll-position chrome; the track has no hover treatment either.

**Recommendation.** Add `hover:bg-foreground/40` over the current `bg-border` on the thumb, matching the 5-10% tint-step convention.

### 6.8 — The composer's ring never changes between idle and focused

**P3 · S · lens 9**
Message composer container, rendered on `/` and `/session`; class chain confirmed live via `getComputedStyle`

**Evidence.** The composer's outer container renders `border-ring ring-ring/75 ring-[1px]` unconditionally — not `focus-within:`-gated. Computed box-shadow resolves to the `--ring` token (`hsl(24 88% 55%)`), the same orange the rest of the app reserves for `focus-visible`. Because the composer wears it permanently, a keyboard user tabbing into and away from it sees no change: it looks focused whether or not it is. (Noted, not filed: the composer also auto-focuses on every page load, a defensible chat convention, but it means a keyboard user's first stop is the message box rather than the nav.)

**Recommendation.** Reserve the orange ring for the composer's actual `:focus-within` state with a quieter idle border, so focus is legible there as it is everywhere else.
