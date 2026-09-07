[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 17 — Componentization: extract what's been copied

**Priority P2 · 12 findings · 5S · 7M**
**Scope:** the repo's own three-strike DRY rule (`.claude/rules/conventions.md`), applied. Each finding names the shared thing to build and the call sites to migrate. Several depend on batch 14 landing first (the `Badge` shape variant in particular).

### 17.1 — Seven independent empty-state components; no shared `EmptyState`

**P2 · M · lenses 3 + 12**
`apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx:18-45`, `mesh/ui/TopologyEmptyState.tsx:12-28`, `marketplace/ui/PackageEmptyState.tsx:34-58`, `activity-feed-page/ui/ActivityEmptyState.tsx:44-61`, `relay/ui/RelayEmptyState.tsx`, `tasks/ui/TasksEmptyState.tsx`, `chat/ui/ChatEmptyState.tsx`

**Evidence.** A `grep -rn "export function.*EmptyState"` over `layers/` turns up no `shared/ui` entry at all — every one was built from scratch in its own feature slice. At least four are structurally identical (icon, bold one-line headline, muted description, optional `<Button>` CTA) with drifting details:

|                      | icon wrapper                    | headline                           | gap/padding                |
| -------------------- | ------------------------------- | ---------------------------------- | -------------------------- |
| `ActivityEmptyState` | `bg-muted rounded-full p-4`     | `text-sm font-medium`              | `gap-3 py-16`              |
| `MeshEmptyState`     | `bg-muted/50 rounded-xl p-3`    | `text-sm font-medium`              | `gap-3 p-12`               |
| `TopologyEmptyState` | none (bare icon, `/50` opacity) | `text-sm font-medium` (`<h3>`)     | `gap-3` (no fixed padding) |
| `PackageEmptyState`  | none (bare icon)                | `text-base font-semibold` (`<h3>`) | `border-dashed py-16`      |

`MeshEmptyState` is already the generic shape the charter describes (`icon: LucideIcon`, `headline`, `description`, optional `action`, optional `preview`) and `DeniedView.tsx:1-30` already reuses it across a sibling feature — it just stayed scoped to `features/mesh/` instead of moving to `shared/ui`, so everyone else reinvented it.

**Recommendation.** Promote `MeshEmptyState`'s shape to `shared/ui` as `EmptyState`, keeping the `preview` slot, and migrate `TopologyEmptyState`, `PackageEmptyState` and `ActivityEmptyState`'s two internal variants onto it, deleting the bespoke wrappers. Leave `ChatEmptyState`, `TasksEmptyState` and `RelayEmptyState` as feature-owned compositions — they carry genuinely bespoke content (state-machine branching, a template gallery, a ghost message-log preview) — but let them compose the shared primitive for their footer. This also gives batch 20 one place to showcase "empty state" instead of four.

### 17.2 — Four page-level widgets hand-roll the identical "couldn't load, retry" state

**P2 · M · lens 12**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:84-97`, `widgets/team/ui/TeamPage.tsx:116-129`, `widgets/team/ui/TeamRoute.tsx:96-109`, `features/feedback-requests/ui/FeedbackRequestsPanel.tsx:142-158`

**Evidence.** Verified in source (TeamPage read in full). All four share the exact same outer class (`flex h-full flex-col items-center justify-center gap-3 p-8 text-center`), the same icon wrapper (`bg-destructive/10 rounded-xl p-3` around a `TriangleAlert` at `size-6`), the same two-line structure (`text-sm font-medium` headline + `text-muted-foreground text-xs` line), and the same `Button size="sm" onClick={() => void refetch()}`. Only the two lines of copy differ. Even the Tailwind class order is identical — copy-paste, not coincidental resemblance. A fifth query-error surface will copy the fourth, because there is nothing to reach for.

**Recommendation.** Extract `QueryErrorState` in `shared/ui` taking `title`, `description` and `onRetry`, and swap all four onto it. Effort is small per call site but crosses widget/feature boundaries, so scope it as one slice. 6.4 is the fifth consumer waiting to be written.

### 17.3 — Four features independently invented the same "label left, value right" row

**P2 · M · lens 12**
`apps/client/src/layers/features/agent-settings/ui/McpServerCardDetails.tsx:19-23` (`DetailRow`), `features/status/ui/UsageStatusItem.tsx:26-33` (`DetailRow`), `features/status/ui/SessionInspector.tsx:304-340` (`Row`), `entities/session/ui/SessionDetailsPanel.tsx:146-161` (`DetailRow`)

**Evidence.** Four names for one idea (three `DetailRow`, one `Row`), four different alignment strategies for the same two columns — `grid grid-cols-[5.5rem_1fr]`, `flex justify-between gap-3`, `flex items-baseline gap-2`, `flex items-start gap-2` with a fixed `w-16` label — and four different subsets of the features a detail row plausibly needs: `SessionInspector` adds `wrap`, `indent` and `swatch`; `SessionDetailsPanel` adds `copyable` rendering a `CopyButton`; neither of the other two has any. Each feature re-derived its own subset instead of inheriting the union. `shared/ui` has `field.tsx`/`field-card.tsx`/`setting-row.tsx` for form-oriented label/control pairs but nothing for read-only label/value display, so every panel that needed one wrote its own.

**Recommendation.** Design one `DetailRow` (or `KeyValueRow`) in `shared/ui` that is the union of the four call sites' props (`label`, `value`/`children`, `wrap`, `indent`, `swatch`, `copyable`, `valueClassName`), then migrate all four. This is the highest-value extraction in this batch: it removes real, currently-diverging duplication rather than pre-emptively unifying things that merely look alike.

### 17.4 — Four `rounded-full` pill components duplicate the badge shell instead of composing `Badge`

**P2 · M · lenses 3 + 12**
`apps/client/src/layers/entities/activity/ui/ActorBadge.tsx:30-42`, `entities/activity/ui/CategoryBadge.tsx:20-32`, `entities/marketplace/ui/ScopeBadge.tsx:28-39`, `entities/room/ui/BridgeVisibilityBadge.tsx:71-74`, `features/activity-feed-page/ui/ActivitySinceLastVisit.tsx:126`; compare `apps/client/src/layers/shared/ui/badge.tsx:5-19`

**Evidence.** The shared `badgeVariants` shell is `inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium`. None of these import `Badge` — each hand-writes its own version with small unexplained drift: `CategoryBadge` `rounded-full px-2 py-0.5`, `ScopeBadge` `rounded-full px-1.5 py-0.5 text-[9px] … uppercase`, `ActorBadge`'s neutral variant `rounded-full border px-2 py-0.5 text-xs`, `BridgeVisibilityBadge` `h-6 … rounded-full border px-2.5 text-[11px]`. Four slightly different pill geometries, none of them the actual component. The reason is structural: `Badge` only ships `rounded-md`, so the pill shape every one of these wanted is not available from the primitive. Each also maintains its own colour-variant lookup (`ACTOR_CONFIG`, `CATEGORY_CONFIG`, `SCOPE_CLASSES`), so a future change to the pill's vertical padding — lens 8's territory — means editing four files that never call `<Badge>`.

**Recommendation.** Add a `shape: 'default' | 'pill'` variant to `badgeVariants` (pairs with 14.4's `size`/`tone` axes), then have `CategoryBadge`, `ScopeBadge`, `ActorBadge`'s neutral case and `ActivitySinceLastVisit` render `<Badge shape="pill" className={colorClass}>`, keeping their domain config maps untouched. `BridgeVisibilityBadge` is a disclosure trigger styled as a label — its own doc is explicit it must never look like a `Badge` — so leave it a `<button>`, but let it pull its shell classes from the same `badgeVariants({ shape: 'pill' })` output.

### 17.5 — About ten files hand-roll the `Card` shell instead of importing `Card`

**P2 · M · lens 12**
Read in full: `apps/client/src/layers/features/connections/ui/ProviderSetupCard.tsx:48`, `connections/ui/ClaimCard.tsx:114`, `extensions/ui/ExtensionCard.tsx:64`. Grep-matched, same shell: `features/mesh/ui/AgentNode.tsx`, `marketplace/ui/PackageLoadingSkeleton.tsx`, `gen-ui/ui/WidgetSkeleton.tsx`, `gen-ui/ui/WidgetErrorCard.tsx`, `connections/ui/{AgentAccounts,AccountsList,ServiceGrid,AccountsFirstRun}.tsx`, `notifications/ui/PermissionPrimer.tsx`, `onboarding/ui/OnboardingWidgetCard.tsx`

**Evidence.** `shared/ui/card.tsx:5-16` defines `Card` as exactly `bg-card text-card-foreground shadow-soft flex flex-col gap-4 rounded-lg border p-4`. `ProviderSetupCard.tsx:48` is a bare `<div className="bg-card rounded-lg border p-4">` — the same classes minus `shadow-soft`/`gap-4`/`text-card-foreground` — on a plain div. `ClaimCard.tsx:114` is the same idea with `shadow-soft` added back by hand. `ExtensionCard.tsx:64` imports `Badge`, `Button` and `Switch` from `shared/ui` on line 4 and still hand-writes `'bg-card rounded-xl border p-4'` for its own shell. This is the clearest "ad-hoc reimplementation of something `shared/ui` already solves" in the audit: the component exists, is imported for its siblings in the same file, and is skipped for the one job it does.

**Recommendation.** Sweep the ~10 hits and swap the outer wrapper for `<Card>` (with `CardContent`/`CardFooter` where the structure already separates body from actions). Where a file genuinely wants `rounded-xl` instead of `rounded-lg`, that is a signal `Card` is missing a `size`/`radius` variant — add it via cva, matching the pattern every other primitive in the folder uses, rather than a reason to keep reimplementing. While adding variants: `Card` has no cva axes at all despite `design-system.md` documenting a `card-interactive` utility specifically for it, and only 4 files in the whole client apply that utility — a `variant: 'static' | 'interactive'` wiring it in would make the hover affordance reachable from the primitive (see 5.6).

### 17.6 — Three feature-promo dialogs are the same layout, copy-pasted three times

**P2 · S · lens 12**
`apps/client/src/layers/features/feature-promos/ui/dialogs/SchedulesDialog.tsx:15-32`, `RelayAdaptersDialog.tsx:15-33`, `AgentChatDialog.tsx:14-32`

**Evidence.** All three import `PromoDialogProps` from `../../model/promo-types` and render, in order: (1) a `flex items-center gap-3` header with a `size-10` icon badge in a `rounded-lg bg-gradient-to-br from-{color}-500/10 to-{color}-600/10` box next to an `h3 text-sm font-medium` + `p text-muted-foreground text-xs` pair; (2) a `bg-muted/50 space-y-3 rounded-lg p-4` box with exactly two `flex items-start gap-3` bullets, each icon + `text-xs font-medium` title + `text-muted-foreground text-xs` description; (3) a `flex justify-end gap-2` footer with a ghost dismiss and a primary CTA. Only the icons, the gradient colour (indigo/purple/emerald) and the copy differ. This is 3-for-3 — every promo dialog that exists follows the identical layout, in a `dialogs/` directory with a shared props type designed for growth — so the fourth will be a fourth copy-paste. (The gradient icon badge is also worth a look against `design-system.md`'s "Purple/brand gradients" anti-pattern; flagged here only as a byproduct.)

**Recommendation.** Extract `PromoDialogLayout` (`icon`, `iconTint`, `title`, `subtitle`, `highlights: {icon, title, description}[]`, `primaryAction`, `secondaryAction`) in `features/feature-promos/ui/`, and rewrite all three as data passed to it. A fourth promo dialog then costs a data literal instead of 30 lines of re-typed markup.

### 17.7 — The inline session-rename state machine is copy-pasted across all three `SessionRow` variants

**P2 · S · lens 3**
`apps/client/src/layers/entities/session/ui/SessionRowCompact.tsx:32-81`, `SessionRowSidebar.tsx:116-179`, `SessionRowFull.tsx:39-95`

**Evidence.** All three define the identical five-piece machine: `isRenaming`/`setIsRenaming`, `renameValue`/`setRenameValue`, a `committedRef` guard so a commit followed by the resulting blur does not double-fire, a `useEffect` that `requestAnimationFrame`s focus onto the input specifically to beat Radix's focus restoration after a context menu closes, and `startRename`/`commitRename`/`cancelRename` with the same trim-and-no-op-if-unchanged logic and the same Enter/Escape mapping. Same variable names, same guard, three times. The `requestAnimationFrame` focus-steal comment — a genuinely non-obvious fact — is duplicated near-verbatim in all three files, because the logic that needed explaining was pasted three times. `SessionRowSidebar` adds a real, small variation worth preserving (an `endRename()` that also restores focus to the row).

**Recommendation.** Extract `useInlineRename({ initialValue, onCommit })` into `entities/session/model/`, returning `{ isRenaming, renameValue, setRenameValue, inputRef, start, commit, cancel, handleKeyDown }`. Let `SessionRowSidebar` layer its extra focus restoration on top via a passed `onEnd`.

### 17.8 — Fifteen hand-rolled height-collapse transitions at three durations, under three local names

**P2 · M · lens 10**
`features/chat/ui/tools/ToolCallCard.tsx:66` (0.2s), `chat/ui/input/QueuePanel.tsx:69` (0.2s, no easing), `features/tasks/ui/TaskBuilder.tsx:71` (`ANIMATION_TRANSITION`, 0.2s, used at `:395,425,462`), `chat/ui/message/ErrorMessageBlock.tsx:9` (`collapseTransition`, 0.25s), `features/ask/ui/QuestionPrompt.tsx:12` (`collapseTransition`, 0.25s — a byte-identical second definition), `features/tasks/ui/TaskRow.tsx:339` (0.3s), `chat/ui/primitives/CollapsibleCard.tsx:86` (0.3s), plus inline variants in `settings/ui/{TunnelSettings.tsx:10,TunnelSetup.tsx:8,TunnelConnected.tsx:37}` and `chat/ui/tasks/{TaskDetail.tsx:92,TaskDetailPanel.tsx:20,TaskActiveForm.tsx:16,TaskListPanel.tsx:77}`

**Evidence.** Fifteen call sites hand-roll the same three-line variant object for the same gesture (`height: 0 ↔ 'auto'` plus opacity). Durations are 200ms, 250ms and 300ms depending on which file you land in, and two files declare an identically named `collapseTransition` constant independently. `animations.md:449` says it outright — "Define variants at **module scope** (not inline) to avoid object recreation on every render" — and the guide already publishes the canonical `collapseVariants` + `collapseTransition` shape at `:420-427`. Nothing exports it, so every author retypes it and picks a number. A user expanding a tool card and then a task row sees the same gesture at two speeds.

**Recommendation.** Export `COLLAPSE_VARIANTS` and `COLLAPSE_TRANSITION` (one duration — 200ms, `cubic-bezier(0, 0, 0.2, 1)`) from `layers/shared/lib`, alongside the `--msg-*` and `--identity-*` families that already do this properly, and replace all fifteen. Pairs with 5.4 so the CSS and JS collapses agree.

### 17.9 — No shared `Spinner` — `Loader2 + animate-spin` at 44 call sites with drifting size and missing `aria-hidden`

**P3 · M · lens 3**
Representative: `features/mesh/ui/DiscoveryView.tsx:295,307`, `chat/ui/tools/ToolCallCard.tsx:23,142`, `chat/ui/tasks/TaskActiveForm.tsx:20`, `composer/ui/InputActionButton.tsx:305`, `shared/ui/DirectoryPicker.tsx:259`, `features/tasks/ui/TaskRunHistoryPanel.tsx:68`, `agent-settings/ui/ManagedMcpServerCard.tsx:170`, `mesh/ui/TopologyGraph.tsx:270`, `features/tasks/ui/TasksView.tsx:39,78`

**Evidence.** `design-system.md`'s "Loading" section documents this as one convention ("Tool running: spinning icon (`Loader2` from lucide)") but there is no component embodying it; every call site imports `Loader2` directly and writes its own className. Sampling the 44 hits shows real drift, not just repetition. **Size:** `size-3`, `size-3.5`, `size-4`, `size-5`, `size-8`, and `h-5 w-5` (`TopologyGraph.tsx:270`, the old Tailwind v3 spelling) all appear for the same "inline loading" affordance. **Token syntax:** `size-(--size-icon-xs)` (`ToolCallCard.tsx:23`) vs `size-[--size-icon-xs]` (`ShapeForkForm.tsx:113`) — two Tailwind v4 arbitrary-value forms for one CSS property, so a repo-wide search for one misses the other. **Accessibility:** `aria-hidden` is present on some (`ToolCallCard.tsx:23`, `TaskActiveForm.tsx:20`) and absent on others doing the identical job (`ManagedMcpServerCard.tsx:170`, `ToolCallCard.tsx:142`) — a decorative spinner without it is read aloud with no label. **Colour:** most use `text-muted-foreground` correctly, but `TasksView.tsx:39,78` and `TaskRunHistoryPanel.tsx:68` use raw `text-blue-500` for the same "in progress" meaning (see 4.4).

**Recommendation.** Add a `Spinner` to `shared/ui` wrapping `Loader2` with a `size` prop mapping to the `--size-icon-*` tokens and `aria-hidden` baked in by default. Migrate call sites opportunistically — high file-count, low risk, better as a follow-up sweep than one PR.

### 17.10 — Two files bypass the shared `Skeleton` primitive with hand-rolled pulses

**P3 · S · lens 3**
`apps/client/src/layers/features/agents-list/ui/AgentGhostRows.tsx:19-32`, `features/marketplace/ui/MarketplaceSourcesView.tsx:192`

**Evidence.** `shared/ui/skeleton.tsx` exists and is well adopted (49 usages; `PackageLoadingSkeleton.tsx` composes it correctly). But `AgentGhostRows.tsx:22-30` hand-rolls its placeholder bars (`<div className="bg-muted h-3 w-32 rounded" />`) instead of `<Skeleton className="h-3 w-32" />`, and `MarketplaceSourcesView.tsx:192` writes `<div className="bg-muted h-20 animate-pulse rounded-xl border" />`. Both produce a visually similar but not identical pulse — `Skeleton` uses the app's `animate-tasks` keyframe and `bg-accent`; these use raw `animate-pulse` and `bg-muted` — so a `prefers-reduced-motion` or theme change to the app's pulse silently will not reach them.

**Recommendation.** Swap both to `<Skeleton>`. Only two occurrences, below the three-strike bar for extracting something new — but the primitive already exists, so this is a drop-in fix, not a design decision. Fold into whichever sweep touches these files.

### 17.11 — Three hand-rolled elapsed-time bucketings re-derive the same arithmetic

**P3 · S · lens 3**
`apps/client/src/layers/shared/lib/session-utils.ts:71-95` (`formatRelativeTime`), `shared/lib/format-compact-age.ts:34-42` (`formatCompactAge`), `features/profile/lib/profile-status.ts:27-57` (`durationWords`, `agoWords`)

**Evidence.** Partly already handled well: `format-compact-age.ts:1-14` explicitly cites `formatRelativeTime` and explains why its output must differ (compact "5m"/"2h" for a dense row vs the sentence form "45m ago"/"Yesterday, 3pm"), and `profile-status.ts:40-42` does the same. The _words_ genuinely need to differ three ways — that part is settled and not a finding. What is not justified is that all three re-derive the same minute/hour/day arithmetic from scratch: each defines its own `MINUTE_MS`/`HOUR_MS`/`DAY_MS` constants and its own `Math.floor(elapsed / X)` cascade, and `profile-status.ts` duplicates it _within the same file_ (`durationWords` at `:27-35` and `agoWords` at `:47-57` both re-derive the breakpoints independently).

**Recommendation.** Extract a low-level `bucketElapsedMs(ms): { value: number; unit: 'minute' | 'hour' | 'day' }` into `shared/lib/`, and have all four functions call it and own only their word choice on top. P3 because each is individually documented and elapsed-time math rarely changes, so the drift risk is bounded.

### 17.12 — Two near-identical removable filter chips

**P3 · S · lens 12**
`apps/client/src/layers/features/tasks/ui/TasksPanel.tsx:211-224` (`AgentFilterChip`), `apps/client/src/layers/shared/ui/filter-bar/FilterBarActiveFilters.tsx:134-142`

**Evidence.** Both render a `rounded-full border px-2 text-xs` pill with a label and a trailing `X` button styled `hover:text-foreground -mr-0.5 rounded-full p-0.5`. The shared implementation already exists in `shared/ui` — the feature simply could not reach for it, because the filter-bar's chip is coupled to `FilterBarContext` and `TasksPanel`'s agent filter is not wired to it. Only two instances today (below the three-strike bar, hence P3), but it is the same visual and interaction contract drawn twice for a structural reason, and dismissible filters are common enough that a third is likely.

**Recommendation.** Extract the presentational half — label plus dismiss button, no context dependency — as `<RemovableChip label onRemove>` in `shared/ui`, and have both `FilterBarActiveFilters` and `TasksPanel`'s `AgentFilterChip` render it.
