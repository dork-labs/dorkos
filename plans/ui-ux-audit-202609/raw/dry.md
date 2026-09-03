# DRY Lens — Findings

Auditor scope: `apps/client/src` — duplicate/near-duplicate components, hooks, and utilities; parallel implementations of the same UI idea; copy-pasted JSX/logic blocks appearing 3+ times.

## Coverage

**Read in full:** `contributing/design-system.md` (all 1270 lines), `.claude/rules/fsd-layers.md`, `.claude/skills/maintaining-dev-playground/SKILL.md`, `.claude/rules/conventions.md` (DRY 3-strike rule), `.claude/rules/components.md`.

**Examined directly (read, not just grepped):** every file in `layers/shared/ui/` by name (full directory listing, ~90 files); full contents of `copy-button.tsx`, `use-copy-feedback.ts`, `badge.tsx`, `skeleton.tsx`, `status-dot.ts`, `section-header.tsx`, `format-compact-age.ts`, `session-utils.ts` (relative-time section), `profile-status.ts`; the empty-state family (`ActivityEmptyState`, `MeshEmptyState`, `TopologyEmptyState`, `RelayEmptyState`, `TasksEmptyState`, `PackageEmptyState`, `ChatEmptyState`); the pill/badge family (`ActorBadge`, `CategoryBadge`, `ScopeBadge`, `BridgeVisibilityBadge`, `ProvenanceChip`); the relay status-color family (`status-colors.ts`, `adapter-state-colors.ts`, `MessageTrace.tsx`, `RelayHealthBar.tsx`, `AdapterCard.tsx`); all three `SessionRow*` variants in `entities/session/ui/` (full contents of `SessionRowCompact.tsx`, targeted reads of `SessionRowSidebar.tsx` and `SessionRowFull.tsx`'s rename logic); the `ManagedMcpServerCard`/`McpServerCard`/`McpServerCardDetails` family (confirmed this one is _correct_ composition, not duplication).

**Grep-swept for patterns, spot-checked a sample:** `Loader2`+`animate-spin` (44 files), `EmptyState` exports (7), `navigator.clipboard` (7, mostly settled), `animate-pulse` (7), relative-time formatting (`formatDistanceToNow`/hand-rolled elapsed-time math, ~15 files), `rounded-full` pill markup (~28 files, most are legitimately distinct shapes — reaction pickers, day dividers — not badge duplicates), `AlertDialog` usage (23, confirmed no `window.confirm` bypass), `SectionHeader` consumers (confirmed already consolidated per its own TSDoc).

**Sampled, not exhaustively read:** `layers/features/*` outside the families above — 60 feature slices exist; this audit read deeply into ~15 of them (session, relay, mesh, marketplace, activity-feed-page, tasks, agent-settings, profile, dashboard-sidebar) and grep-sampled the rest for the signature phrases above. `layers/widgets/*` (17 widgets) was grep-swept only, not deep-read. The dev playground (`dev/`) was not audited by this lens — playground coverage is lens 6's job, though several findings below note whether a shared primitive would give the playground a single home to showcase.

**Not covered:** `apps/site`, `apps/desktop`, `apps/e2e`, server code — out of lens scope per the charter (`apps/client/src` only).

---

### [P2/M] Five independent status-color vocabularies in the relay/adapter surface, after the codebase already fixed this once

**Files:**

- `apps/client/src/layers/shared/ui/status-dot.ts` (the intended single source — `STATUS_DOT_COLOR`, `statusDotClass()`)
- `apps/client/src/layers/entities/relay/lib/adapter-state-colors.ts:12-19` (`ADAPTER_STATE_DOT_CLASS`)
- `apps/client/src/layers/features/relay/lib/status-colors.ts:2-62` (`RELAY_STATUS_COLORS`, plus `getStatusDotColor`/`getStatusTextColor`/`getStatusBorderColor`)
- `apps/client/src/layers/features/relay/ui/MessageTrace.tsx:9-26` (local `statusColor()` switch)
- `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx:18-22` (local `DOT_COLORS` record)
- `apps/client/src/layers/features/relay/ui/adapter/AdapterCard.tsx:82-87` (consumes `ADAPTER_STATE_DOT_CLASS`)

**Evidence:** `status-dot.ts`'s own module doc says exactly what this finding re-discovers: _"A coloured dot is the smallest thing this product draws and the one it drew five different ways: a green that was `bg-green-500` in the sidebar, `bg-emerald-500` in an agent panel, `bg-status-success` in a room and `bg-primary` in a group header — four spellings of one fact... This module is the spelling."_ That fix shipped for identity/sidebar surfaces. But the relay feature never migrated, and independently grew a _sixth_ and _seventh_ spelling on top of the four the doc says it killed:

- `adapter-state-colors.ts:13-18`: `connected: 'bg-green-500'`, `error: 'bg-red-500'`, `starting: 'bg-amber-500 motion-safe:animate-pulse'` — raw palette classes, and a hand-typed `motion-safe:animate-pulse` string duplicating `STATUS_DOT_PULSE` verbatim instead of importing it.
- `status-colors.ts:2-62`: a 15-entry `RELAY_STATUS_COLORS` map with `healthy`/`delivered`/`connected` all independently mapped to `bg-green-500`, `pending`/`starting`/`new` to `bg-blue-500`, etc. — three getter functions (`getStatusDotColor`, `getStatusTextColor`, `getStatusBorderColor`), consumed by `ConversationRow.tsx` and `MessageRow.tsx`.
- `MessageTrace.tsx:10-26`: a third, structurally different map (`delivered → bg-green-500`, `failed → bg-red-500`, `no_subscriber → bg-slate-400`, `sent → bg-yellow-500`, `timeout → bg-gray-500`) — uses `bg-slate-400` and `bg-yellow-500`, colors that appear nowhere else in the other four maps.
- `RelayHealthBar.tsx:18-22`: a fourth map, `healthy: 'bg-emerald-500'` this time (not `bg-green-500`) — the exact "green vs emerald" drift the status-dot.ts doc names as the original bug, reproduced inside one feature.

None of these five relay-local color sources reference `--status-success`/`--status-warning`/`--status-error` tokens or `STATUS_DOT_COLOR`. Every one will drift independently the next time either theme's palette moves, and a reviewer checking "does this dot look right" has five different files to get right instead of one.

**Recommendation:** Extend `StatusSignal`/`STATUS_DOT_COLOR` (or add a small relay-specific adapter function that maps relay's finer-grained states — `starting`, `reconnecting`, `no_subscriber`, `timeout` — onto the four semantic tokens plus a neutral) so all five relay files resolve through the one vocabulary `status-dot.ts` already established. Delete `adapter-state-colors.ts`, `status-colors.ts`, and the two inline maps once their callers are re-pointed. This is squarely a "3+ strikes" case under the repo's own DRY rule (`conventions.md`) — it's five.

---

### [P2/M] No shared `EmptyState` primitive — seven feature-level empty states hand-roll the same icon+headline+description+CTA shape

**Files:**

- `apps/client/src/layers/features/activity-feed-page/ui/ActivityEmptyState.tsx:44-61` (`NoEventsEmptyState`)
- `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx:18-45`
- `apps/client/src/layers/features/mesh/ui/TopologyEmptyState.tsx:12-28`
- `apps/client/src/layers/features/marketplace/ui/PackageEmptyState.tsx:34-58`
- `apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx`
- `apps/client/src/layers/features/tasks/ui/TasksEmptyState.tsx`
- `apps/client/src/layers/features/chat/ui/ChatEmptyState.tsx`

**Evidence:** At least four of these (`ActivityEmptyState`, `MeshEmptyState`, `TopologyEmptyState`, `PackageEmptyState`) are structurally identical — an icon (sometimes in a tinted circle/box, sometimes bare), a bold one-line headline, a muted description line, an optional `<Button>` CTA — reimplemented with drifting details each time:

|                      | icon wrapper                    | headline                           | gap/padding                |
| -------------------- | ------------------------------- | ---------------------------------- | -------------------------- |
| `ActivityEmptyState` | `bg-muted rounded-full p-4`     | `text-sm font-medium`              | `gap-3 py-16`              |
| `MeshEmptyState`     | `bg-muted/50 rounded-xl p-3`    | `text-sm font-medium`              | `gap-3 p-12`               |
| `TopologyEmptyState` | none (bare icon, `/50` opacity) | `text-sm font-medium` (`<h3>`)     | `gap-3` (no fixed padding) |
| `PackageEmptyState`  | none (bare icon)                | `text-base font-semibold` (`<h3>`) | `border-dashed py-16`      |

`grep -rn "export function.*EmptyState"` over `layers/` turns up no `shared/ui` entry at all — every one of these was built from scratch in its own feature slice. `RelayEmptyState` and `TasksEmptyState` have genuinely bespoke content (a ghost message-log preview, a template gallery) and shouldn't collapse into a generic primitive wholesale, but even they re-derive the same "icon-less headline + description + trailing action" footer markup that the other four spend most of their code on.

**Recommendation:** Add `EmptyState` to `shared/ui` (icon slot, headline, description, optional action — matching the shape `contributing/design-system.md`'s Calm Tech language already implies: muted icon, quiet copy, one CTA) and migrate the four structurally-identical call sites onto it. Let `RelayEmptyState`/`TasksEmptyState` compose it for their footer while keeping their bespoke preview content. This also gives lens 6 (playground) one place to showcase "empty state" instead of four.

---

### [P2/S] The inline session-rename state machine is copy-pasted across all three `SessionRow*` variants

**Files:**

- `apps/client/src/layers/entities/session/ui/SessionRowCompact.tsx:32-81`
- `apps/client/src/layers/entities/session/ui/SessionRowSidebar.tsx:116-179` (approx.)
- `apps/client/src/layers/entities/session/ui/SessionRowFull.tsx:39-95`

**Evidence:** All three components define the identical five-piece state machine — `isRenaming`/`setIsRenaming`, `renameValue`/`setRenameValue`, a `committedRef` guard so a commit followed by the resulting blur doesn't double-fire, a `useEffect` that `requestAnimationFrame`s focus onto the input specifically to beat Radix's own focus-restoration after a context menu closes, and `startRename`/`commitRename`/`cancelRename` handlers with the same trim-and-no-op-if-unchanged logic and the same Enter/Escape keydown mapping. `SessionRowFull.tsx:64-80`:

```ts
const startRename = useCallback(() => {
  setRenameValue(session.title);
  setIsRenaming(true);
}, [session.title]);

const commitRename = useCallback(() => {
  if (committedRef.current) return;
  committedRef.current = true;
  const trimmed = renameValue.trim();
  setIsRenaming(false);
  if (!trimmed || trimmed === session.title) return;
  onRename?.(session.id, trimmed);
}, [renameValue, session.id, session.title, onRename]);
```

`SessionRowCompact.tsx:69-76` is the same logic, same variable names, same guard. `SessionRowSidebar.tsx:142-168` is the same again, plus an `endRename()` wrapper that also restores focus to the row (a real, small variation worth preserving, not a reason the rest needs re-deriving). The `requestAnimationFrame` focus-steal-from-Radix comment is duplicated near-verbatim in all three files — the same non-obvious fact, explained three times because the logic that needed explaining was pasted three times.

**Recommendation:** Extract `useInlineRename({ initialValue, onCommit })` into `entities/session/model/` returning `{ isRenaming, renameValue, setRenameValue, inputRef, start, commit, cancel, handleKeyDown }`. Let `SessionRowSidebar` layer its extra focus-restoration behavior on top via a passed `onEnd` callback. This is a 3-strike case per `conventions.md`'s own DRY rule.

---

### [P2/M] Four hand-rolled `rounded-full` pill components duplicate badge base classes instead of extending `Badge`

**Files:**

- `apps/client/src/layers/entities/activity/ui/ActorBadge.tsx:35` — `'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium'`
- `apps/client/src/layers/entities/activity/ui/CategoryBadge.tsx:24` — `'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'`
- `apps/client/src/layers/entities/marketplace/ui/ScopeBadge.tsx:32` — `'inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase'`
- `apps/client/src/layers/features/activity-feed-page/ui/ActivitySinceLastVisit.tsx:126` — `'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'`

**Evidence:** `shared/ui/badge.tsx:6` already centralizes a CVA-driven pill (`badgeVariants`) with the same base shape (`inline-flex items-center ... px-2 py-0.5 text-xs font-medium`), but uses `rounded-md`. Rather than adding a `shape` variant to `Badge` (or a sibling `Pill`/`Chip` primitive) for the `rounded-full` family, four separate entity/feature components hand-copy the base string verbatim and each maintain their own local color-variant lookup (`ACTOR_CONFIG`, `CATEGORY_CONFIG`, `SCOPE_CLASSES`). Each is individually well-documented and correct, but the base pill markup — which never changes across them — is typed out fresh four times, so a future change (say, adjusting the pill's vertical padding for touch-target reasons, lens 8's territory) requires editing four files that never call `<Badge>` at all.

**Recommendation:** Add a `shape: 'rect' | 'pill'` (or equivalent) variant to `badgeVariants` in `shared/ui/badge.tsx`, or a thin `Pill` wrapper in the same file reusing the CVA base. Migrate the four call sites to pass their existing color classes via `className` on top of the shared shape, keeping each file's actual domain logic (the config maps) untouched.

---

### [P3/M] No shared `Spinner` primitive — `<Loader2 className="... animate-spin" />` is hand-typed at 44+ call sites with drifting size syntax

**Files (representative sample of 44 matches):**

- `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx:295,307`
- `apps/client/src/layers/features/chat/ui/tools/ToolCallCard.tsx:23,142`
- `apps/client/src/layers/features/chat/ui/tasks/TaskActiveForm.tsx:20`
- `apps/client/src/layers/features/composer/ui/InputActionButton.tsx:305`
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx:259`
- `apps/client/src/layers/features/tasks/ui/TaskRunHistoryPanel.tsx:68`

**Evidence:** `contributing/design-system.md`'s own "Loading" section (line ~854) documents this as one convention — _"Tool running: spinning icon (Loader2 from lucide)"_ — but there is no component that embodies it; every call site imports `Loader2` from `lucide-react` directly and writes its own `className`. Sampling the 44 hits shows real drift, not just repetition:

- Size: `size-3`, `size-3.5`, `size-4`, `size-5`, `size-8`, `h-5 w-5` (`TopologyGraph.tsx:270`, the old Tailwind v3 two-class spelling) all appear for what is semantically the same "inline loading" affordance in different contexts.
- Icon-size token syntax is inconsistent for the _same_ token: `size-(--size-icon-xs)` (`ToolCallCard.tsx:23`, `TaskActiveForm.tsx:20`) vs `size-[--size-icon-xs]` (`ShapeForkForm.tsx:113`) — two different Tailwind v4 arbitrary-value bracket forms for the identical CSS custom property, so a repo-wide search for one syntax misses the other.
- `aria-hidden` is present on some (`ToolCallCard.tsx:23`, `TaskActiveForm.tsx:20`) and absent on others doing the identical job (`ManagedMcpServerCard.tsx:170`, `ToolCallCard.tsx:142`) — a decorative spinner without `aria-hidden` is read aloud by a screen reader with no label, which is more of an accessibility gap than a DRY one, but it's the direct consequence of 44 independent implementations instead of one.
- Color: most use `text-muted-foreground` (correct per design system), but `TasksView.tsx:39,78` and `TaskRunHistoryPanel.tsx:68` use raw `text-blue-500` for the same "in progress" meaning — another small instance of the status-color drift documented in the finding above.

**Recommendation:** Add a `Spinner` component to `shared/ui` wrapping `Loader2` with a `size` prop (`xs`/`sm`/`md`, mapping to the existing `--size-icon-*` tokens) and `aria-hidden` baked in by default. Migrate call sites opportunistically — this is high file-count but low risk, good for a follow-up sweep rather than one PR.

---

### [P3/S] Two files bypass the shared `Skeleton` primitive with hand-rolled `bg-muted`/`animate-pulse` placeholder divs

**Files:**

- `apps/client/src/layers/features/agents-list/ui/AgentGhostRows.tsx:19-32` (`GhostRow`)
- `apps/client/src/layers/features/marketplace/ui/MarketplaceSourcesView.tsx:192`

**Evidence:** `shared/ui/skeleton.tsx` exists and is well-adopted (49 usages, e.g. `PackageLoadingSkeleton.tsx` composes it correctly). But `AgentGhostRows.tsx:22-30` hand-rolls its own placeholder bars (`<div className="bg-muted h-3 w-32 rounded" />` etc.) instead of `<Skeleton className="h-3 w-32" />`, and `MarketplaceSourcesView.tsx:192` writes `<div className="bg-muted h-20 animate-pulse rounded-xl border" />` directly rather than `<Skeleton className="h-20 rounded-xl border" />`. Both produce a visually similar but not identical pulse (`Skeleton` uses the app's `animate-tasks` keyframe and `bg-accent`; these two use raw `animate-pulse` and `bg-muted`), so a `prefers-reduced-motion` or theme change to the app's pulse animation silently won't reach these two.

**Recommendation:** Swap both to `<Skeleton>`. Only two occurrences (below the repo's 3-strike bar for extracting something new), but since the shared primitive already exists, this is a pure drop-in fix, not a design decision — worth folding into the `EmptyState`/skeleton cleanup pass above rather than opening on its own.

---

### [P3/S] Three independently hand-rolled elapsed-time bucketing implementations, beyond the two the codebase already documents as deliberately different

**Files:**

- `apps/client/src/layers/shared/lib/session-utils.ts:71-95` (`formatRelativeTime`)
- `apps/client/src/layers/shared/lib/format-compact-age.ts:34-42` (`formatCompactAge`)
- `apps/client/src/layers/features/profile/lib/profile-status.ts:27-57` (`durationWords`, `agoWords`)

**Evidence:** This one is partly _already_ handled well — `format-compact-age.ts:1-14`'s module doc explicitly cites `formatRelativeTime` and explains why its output has to differ (compact "5m"/"2h" for a dense row vs. the sentence form "45m ago"/"Yesterday, 3pm"), and `profile-status.ts:40-42` does the same for its own `agoWords`, citing `formatRelativeTime` by name and explaining the "no comma mid-sentence" constraint. The _words_ genuinely need to differ three ways — that part is a settled, well-reasoned decision, not a finding.

What isn't justified is that all three re-derive the same minute/hour/day bucketing arithmetic from scratch: each defines its own `MINUTE_MS`/`HOUR_MS`/`DAY_MS` (or `MS_PER_MINUTE`/`MS_PER_HOUR`) constants and its own `Math.floor(elapsed / X)` cascade of `if` statements. `profile-status.ts:27-35` and `:47-57` even duplicate the arithmetic _within the same file_ (`durationWords` and `agoWords` both re-derive minute/hour/day breakpoints independently). None of the three share a common "break elapsed-ms into a value + unit" helper.

**Recommendation:** Extract a shared, low-level `bucketElapsedMs(ms): { value: number; unit: 'minute' | 'hour' | 'day' }` (or similar) into `shared/lib/`, and have `formatRelativeTime`, `formatCompactAge`, and `profile-status.ts`'s two functions call it and only own their own word choice on top. Lower priority than the other findings here because the current triplication is at least each individually documented and the risk of the three drifting apart in an inconsistent way is bounded (elapsed-time math rarely changes) — P3, not P2.

---

## Not flagged (checked and found settled)

For calibration, these looked like plausible DRY hits and were checked but are legitimate/already-consolidated:

- **Copy-to-clipboard** — `use-copy-feedback.ts` is a single, well-documented mechanism ("the one copy-to-clipboard mechanism in the app... replaces five hand-rolled variants") with exactly one intentional carve-out (`use-file-actions.ts`'s silent-success `copyPath`, itself commented). No action needed.
- **Avatars** — `IdentityAvatar` (`shared/ui/identity-avatar.tsx`) is universally used; grep for hand-rolled circular initial-avatar divs outside it returned nothing.
- **Confirmation dialogs** — all destructive-action confirms route through `AlertDialog` (23 usages); no `window.confirm()` in the client.
- **Section headers** — `shared/ui/section-header.tsx`'s own TSDoc documents that it already replaced two near-identical sidebar implementations; 8 consumers, no stragglers found.
- **MCP server cards** (`ManagedMcpServerCard`, `DiscoveredMcpServerCard`, `McpServerCard`) — read in full; this is correct composition, not duplication. `ManagedMcpServerCard` and (checked structurally) `DiscoveredMcpServerCard` both compose the shared `McpServerCard` shell + `McpServerCardDetails`, each supplying only their own state-machine logic.
