---
slug: sidebar-simplification
id: 260819-203828
created: 2026-08-19
status: specified
design-session: .dork/visual-companion/88892-1787170146
---

# Sidebar simplification: two levels, one door, sections, one bottom slot, a polished first paint

**Status:** Approved (decisions 1B · 2A · 3A · 4A + motion + initial load, 2026-08-19)
**Author:** Dorian (decisions) / orchestrating agent (spec)
**Date:** 2026-08-19

## Overview

The cockpit's left sidebar keeps its Heads up / Today / Library _model_ and gets a simpler _surface_: two levels with one header style, one door to an agent, sections that hold anything, one pinned bottom slot, continuity motion, and a first paint that never assembles itself in front of the user. Everything here is in `apps/client` plus small, scoped edits to `packages/shared` (config schema, one boolean table), `apps/server` (one-time data tidy is **not** needed — see 2A), specs/ADRs/docs. No storage model changes.

Evidence and every citation: `research/20260819_sidebar-simplification-review.md` (the review; Appendix C = load trace). Decision record: `design-decisions.md`. The brief: `01-ideation.md`.

## Background / Problem Statement

Measured on the live cockpit (272px panel): zone labels at 16px, section headers at 36px, every row label at 42px — depth is invisible and "Library" names nothing a user recognises. The same agent appears twice (DM room + session) with two click results; a 1:1 DM is a session in disguise that renders final text only. Groups already hold channels and DMs but look agent-only and carry two dead controls. Promos sit inside the scroller with no dismiss control and one that always shows; four cards compete at the bottom on day one. The list grows with the fleet. Initial load pops in from nothing in ~8 beats, flips every face, and restructures the Library a round trip late. Four roll-up rows are pressable and inert; two verbs lie.

## Goals

- G1. One header grammar, one row indent, two levels. Every row label on one x.
- G2. One door to an agent: agent row → session; 1 agent = session, 2+ = group conversation; no standing duplicate list.
- G3. Sections (née groups) are top-level, hold any Library row, always offered; Agents shows recent + pinned + one "All N agents →" row.
- G4. One bottom slot: pinned, one card, × always, dismissal synced.
- G5. Motion explains state changes the user did not cause; nothing loops; reduced motion = instant.
- G6. Initial load paints warm (first frame, final shape) or cold (skeleton → one reveal). Zero layout shift on warm; identity never flips.
- G7. Every pressable does something; every control is real; every verb is true.
- G8. Performance: no per-row prefs subscription; no fleet walk per section; one item index; rebuild budget unchanged (≤5 ms median).

## Non-Goals

- No change to the Heads up / Today rules (caps, holds, digest, overnight archive).
- No storage change: rooms stay rooms, sessions stay sessions (ADR 260808-140954). No merging of transcripts; no server migration of existing DM rooms.
- No nesting beyond one level; no sessions / workspaces / tasks in sections; no smart-section rules over non-agent kinds.
- No "DM is the door" (2B). No onboarding tour. No density toggle / group emoji (DOR-341 stays parked).
- No change to the Obsidian `EmbedSidebar` beyond what the shared primitives give it for free (bottom slot placement, no promo entrance on load).

## Technical Dependencies

- `@tanstack/react-query` 5.101 (present). **Add** `@tanstack/react-query-persist-client` + `@tanstack/query-sync-storage-persister` at the same major (G6).
- `motion` (present) for `layout` / `AnimatePresence`; `useReducedMotion` gates.
- `@dnd-kit` (present) — no version change.
- `conf` migrations for the one new config field (see `adding-config-fields` skill).

## Detailed Design

### D1. Structure (1B)

**Geometry tokens** (CSS custom properties on the sidebar root, consumed by Tailwind arbitrary values):

| Token                | Value | Used by                                                                           |
| -------------------- | ----- | --------------------------------------------------------------------------------- |
| `--sidebar-header-x` | 12px  | all section headers (label text start)                                            |
| `--sidebar-row-x`    | 20px  | row glyph slot start; label = row-x + 18 + 8 = **46px**                           |
| `--sidebar-nested-x` | 12px  | added to header-x / row-x for a section's members (header 24, glyph 32, label 58) |

The panel's `px-2` (8px) stays; `SIDEBAR_ROW_INSET` becomes the token-derived inset. The glyph-action overlay (`left-2`) follows the same token. `apps/e2e/tests/dashboard-sidebar/sidebar-row-gutter.spec.ts` asserts the tokens' computed values, not `16px`.

**One header component.** `SectionHeader` (`shared/ui/section-header.tsx`) gains a `variant="zone"`-free single look: 11px, `font-medium`, `text-sidebar-foreground/70`, no icon, `h-7`. Heads up, Today, Getting started, Pins, Channels, Direct messages, Agents and every section use it. The zone `<h2>` in `SidebarZone.tsx` is removed; the zone `<section>` keeps `data-sidebar-zone` and gains `aria-label={ZONE_LABEL[id]}` (so `library` is still named for AT). `ZONE_LABEL.library` stays as the AT name; it is never painted.

**Headers fold.** Every header toggles its section (click anywhere, Enter/Space), including Heads up and Today, which become collapsible sections with a persisted collapse key (`SidebarSectionIdSchema` gains `now`, `today`; the collapse storage is the existing `ui.sidebar.sections` partial record; the drop-unknown sanitizer makes the enum widening safe). A folded header shows its roll-up (`roll-up-collapsed-section.ts` output) as trailing text; Heads up's roll-up keeps the needs-you count so folding it never hides a prompt silently (the count is the signal). Alt/Option-click on any header folds/unfolds **all** headers (the existing BC-30, widened from Library to the whole panel).

**Hover chrome.** The chevron and the section `+` appear at the right on hover/focus-within (opacity 0→1, 120 ms). The `+` becomes a roving-focus stop (`use-roving-focus.ts` adds `[data-sidebar-section-action]` to `stopsIn`) so New channel / New group message / New agent / New section are keyboard reachable; the group-create and rename inputs are excluded from the `-1` stamping while mounted.

**Rows.** All rows use `SidebarRow` with the glyph slot at `--sidebar-row-x`, `justify-start`; the agent row moves its face into the glyph slot (same 18px slot; the `xs` disc becomes **18px** so `#`, single face and agent face are flush); `AgentIdentity`'s name variant matches the row's 13px. Multi-face DM stack: max **2** faces at sidebar size, `-space-x-3.5` (−14px) → 26px wide, never past the label column. `RoomAvatar` takes `maxFaces` and the overlap as props with these defaults for `size="xs"`.

**Muted rows** (DOR-1098): muted = fewer signals, not dimming. `SidebarRow` drops `opacity-60` for `muted`; a muted row keeps full label contrast and loses bold / badge / dot. (This is the decision already written in DOR-1098; it lands here because rows are restyled.)

**Mobile.** `mobile-tabs.ts` tab label `'Library'` → `'All'` (the tab id stays `library`). Panel content unchanged.

**Spec amendments** (`specs/sidebar-now-today-library`): BC-1/BC-2 (zones are no longer "never accordions" — every header folds; the zone remains a landmark via `aria-label`), BC-3 unchanged, BC-28..BC-33 (Library no longer has a visible heading; sections first), BC-30 (fold-all widened), BC-49 removed (D6). `design-decisions.md` §2/§8/§9/§11 annotated "superseded by sidebar-simplification D1".

### D2. One door (2A)

**Entry points.**

- `NewMenu` items: `new-session` (Session, ⌘N, "Starts with X (last used)") · `new-channel` (Channel…) · `new-message` → label **Group message…** (id unchanged to keep `NEW_MENU_ITEM_IDS` stable) · `new-agent` (Agent…) · `new-group` → label **Section…** (submenu: _Empty section…_, smart presets, _Custom rules…_; smart presets stay gated by `offersGroupAffordances`, the manual entry is not).
- **Picker rule.** `NewDirectMessageMenu` (features/room-membership): the confirm button reads "Start group message" and is enabled at **2+** agents; with exactly one agent selected the button reads "Open session with X" and calls `startNewSession(path)` (resolve-or-mint, the same door as the agent row). The rule is stated inline under the picker: "One agent opens a session. Two or more start a group message."
- `useSectionChrome` deep-link for the Direct messages `+` → `new-message` (unchanged id, new label).
- Team page: `agent-columns.tsx` "Chat with X" → **"Open session with X"** (`aria-label`), icon `MessageSquare` → `SquareArrowOutUpRight`-family (pick an existing lucide icon used for "open"); row click unchanged. Profile: `ProfileHeader` "Message" → **"Open session"**; `profile-message.ts` `kind: 'agent-session'` unchanged.
- Command palette: the existing DM rows stay ("Message Ana" → **"Open conversation with Ana"** — it opens an existing room); no new action.

**The Library rule (model).** A room is a _hand-made 1:1 DM_ when `kind === 'dm'` **and** its roster is exactly one agent plus the viewer **and** it is not bridged (`bridge == null`). `build-library-sections.ts` **excludes** hand-made 1:1 DMs from the Direct messages section (reason `library:dm-suppressed-1to1`). They still appear in Today and in ⌘K. **Amended at implementation (2026-08-21):** "the existing rules" was not enough — Today's membership is interaction-based, so an agent-initiated line the operator has never opened had no row on any surface. Today gains one clause: a suppressed 1:1 with a directed unread is eligible whether or not it has ever been opened (reason `today:dm-suppressed-unread`), drawn as the room's own row. A room the operator HAS been in stays eligible by the ordinary rule (BC-16 otherwise unchanged; a directed unread was already exempt from the cap and the overnight boundary). The agent row gains an **unread dot** when its hand-made 1:1 DM has a directed unread (`derive-unread-signal.ts` → `agentRow` via a `dmUnreadByAgentPath` map built once in `buildSidebarItems`). This needs no server migration: existing rooms simply stop being listed.

**Agent-initiated DMs** (`notify-dm.ts`) are hand-made-shaped by roster; they follow the same rule: Today + agent-row dot. Bridged private chats (`bridge != null`) keep their Direct messages row.

**Group DM title follows its roster** (DOR-772): `directMessageTitle` recomputes the display title from the roster when the room's title was auto-generated (title equals the previous roster-derived title); a user-renamed title is left alone. Server: `room-roster.ts` add-member path updates `title` when it matches the derived title. Fits here because group messages become the only hand-made DM shape.

**Spec amendments:** `sidebar-now-today-library` BC-34 (unchanged in substance, now the only door), BC-45; `rooms` §8.5 resolved ("converged: the session is the 1:1 conversation; DMs are for 2+ participants and for lines an agent or a bridge opens"), §14.4 "A DM has no cwd" corrected; `docs/concepts/rooms.mdx` one paragraph.

### D3. Sections + Agents (3A)

**Rename.** Every user-facing "group" for this feature becomes "section": `NewMenu` (`Section…`, `Empty section…`, `Custom rules…`), `SectionHeaderMenuItems` (`Rename section`, `Delete section`, `Mute section`, `Edit rules`, `Convert to manual section`), `AgentRowMenuItems` / `RoomRowMenuItems` (`Move to section ▸`, `Remove from section`, `New section…`), `GroupCreateInput` placeholder, empty hint "Drag channels, conversations or agents here" / "No agents match these rules", DnD announcements (`use-sidebar-dnd.ts` copy), `create-flow-store` copy. Schema field names (`groups`, `SidebarGroupSchema`) are **not** renamed (persisted).

**Top-level render.** `build-library-sections.ts` emits sections as **peers**: `[...sections (prefs.groups order), pins, channels, dms, agents]` — sections first. `SidebarSectionModel.subsections` is removed (with its "one level" contract moved onto the section itself: a section's members are the one nested level; the type no longer admits nesting). `SIDEBAR_LIBRARY_SECTION_IDS` stays for the four fixed ids; sections keep `group:<id>` ids. Alt-click fold-all enumerates the zone's sections as before. `useSectionChrome`'s group branch is unchanged in behaviour; the creation field mounts **above the first section** (or where the Agents header was if no sections exist) — the "New section…" from any row lands in one predictable place (fixes defect #9).

**Always offered.** `NewMenu` shows `new-group` for everyone; `offersGroupAffordances` gates only the smart presets and the `Custom rules…` entry.

**Honest controls.** `groupSection` applies `group.displayFilter` through `filteredAgentRows` and emits `options` so the header radio reads from the model; the "Mute section" item is **hidden** for smart sections (the evaluator is stale by design) and `apply-mute-rules.ts` keeps skipping them; a mixed section sorted by "Recent activity" uses `room.lastActivityAt` for rooms (resolver returns the room's timestamp, not `null`); stale `filterSidebarItems` doc lines deleted; spec R3 vs code: spec amended to match code (ungrouped Agents has no manual reorder — the list is recency/name sorted).

**Agents = recent + pinned.** The Agents section lists agents whose `attention !== 'inactive'` **or** that are pinned/in a section (unchanged), where `inactive` tightens to **7 days since the viewer's last interaction or the agent's last activity, whichever is later** (`agent-attention.ts` threshold constant → 7 d; currently lenient), with a **floor of 8**: if fewer than 8 agents qualify, the most recently active inactive agents fill up to 8. The reveal row `"N inactive"` is replaced by **`All N agents →`** (`target: { kind: 'command', id: 'open-team' }` → `navigate({ to: '/team' })`), always present when `N > shown`. The dead `section-count` roll-up target is thereby gone; `automated` toggles the Today automated fold (`todayRevealStore.toggle()`), `working` and `now-overflow` navigate to `/` (home is #team, where presence shows) — closes DOR-1105.

**Channels sort pref** (DOR-906): `SidebarSectionsSchema` per-section `sortMode` already exists for Agents; `channels` and `dms` gain the same (`name | recent`), default `name`; `buildChannelsHeaderMenuNodes` offers Sort; conf migration keyed to the next semver per `adding-config-fields`. Small and adjacent; lands here.

**Back-compat removal** (DOR-588): `tolerateLegacySidebarEncoding` + `normalizeSidebarPrefs` removed (one release has passed). Lands here because this wave touches the prefs reader.

**Spec amendments:** `sidebar-groups` (top-level, rename), `smart-agent-groups` (copy), `sidebar-now-today-library` BC-28 (order), BC-32 (an empty section still renders).

### D4. Bottom slot (4A)

**Component.** `features/dashboard-sidebar/ui/SidebarBottomSlot.tsx` (new): a sibling of `SidebarContent` inside the sidebar `<nav>`, `shrink-0 px-2 pb-2 empty:p-0`. It takes an ordered list of **candidates** and renders the first whose `show` is true:

| Priority | Candidate                                 | Source of truth                            | Dismiss                               |
| -------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------- |
| 1        | Getting-started progress (`ProgressCard`) | `useOnboarding().shouldShowGettingStarted` | existing `dismissOnboarding`          |
| 2        | Update pill (`UpdatePill`)                | existing                                   | existing (`dismissedUpgradeVersions`) |
| 3        | Profile prompt (`ProfilePromptCard`)      | existing `useProfile()` gate               | existing                              |
| 4        | Promo (`PromoCard`, `maxUnits=1`)         | `usePromoSlot('dashboard-sidebar')`        | **new** `×` → `dismissPromo`          |

`AppShell.tsx` stops rendering `ProgressCard` / `ProfilePromptCard` in `SidebarFooter`; `SidebarFooterStrip` keeps only the nav strip + Ask DorkBot (the `UpdatePill` moves into the slot). The slot is mounted by `DashboardSidebar.tsx` (so a marketplace takeover replaces it with the body) and by `EmbedSidebar.tsx` for `agent-sidebar`. Mobile: the slot renders at the bottom of the **Home** panel in `MobileTabsLayout`.

**Dismissal in config.** `UserConfigSchema.ui.promos.dismissedIds: string[]` (new; additive, default `[]`, conf migration per `adding-config-fields`; agent-writable per the existing policy tables — add the leaf to `config-disclosure.ts`, `config-write-policy.ts`, `default-verdicts.ts`). `app-store-preferences.ts` `dismissedPromoIds` / `dismissPromo` route to config; the localStorage key is read once as a one-time import then ignored. `promoEnabled` stays where it is.

**Promo registry.** `remote-access.shouldShow` → `!ctx.isDesktopApp && !ctx.remoteAccessConfigured` (`PromoContext` gains the two facts; the desktop fact exists in `isElectron`-style helpers, remote access = `config.remoteAccess?.enabled`/tunnel config — whichever the config exposes; if no such fact exists, the promo is **deleted**). `maxUnits` for the slot = 1. The `PromoCard` gains the `×` (`aria-label="Dismiss"`), `layout` gated by reduced motion.

**Motion.** The slot's entrance (height + opacity, 160 ms) plays only when a card newly qualifies **after boot** (`mountedAtBoot` ref); × collapses height. Never on first paint.

**Playground.** `PromoShowcases` gains "Bottom slot in a 272px panel with an overflowing list" (four states: progress / update / profile / promo) and the stale "Dismiss a promo card above" copy is fixed.

### D5. Motion (approved)

- **Fold**: `SidebarSection` body wraps in `motion.div` with `animate={{ height }}` spring (stiffness 400, damping 36, ≈180 ms), chevron `rotate` 0/−90; the roll-up text fades in 120 ms once folded. Reduced motion: instant.
- **Arrive**: rows entering Today / Heads up after boot get `initial={{ opacity: 0, y: -6 }}` → `animate` 160 ms and a one-shot tint (`data-arrived` class with a 200 ms CSS keyframe on `background-color`, `motion-safe:`). Keyed by row id; `AnimatePresence initial={false}` on the list so boot never animates. Leaving rows fade 120 ms.
- **Move**: `layout` on `SidebarModelRow` inside `SidebarMenu` (per section) so a reorder after the Today hold releases, a "Move to section", the 4 am archive and the agent list's recency reshuffle slide instead of pop. `layoutDependency` is the section's row-id list; `MotionConfig reducedMotion="user"` covers reduced motion.
- **Drag**: `SidebarDndPrimitives` overlay `scale: 1.02`, shadow token; drop target ring `inset 0 0 0 2px var(--ring)/45%` instead of the background wash; settle via dnd-kit's default spring (keep).
- **Bottom slot**: D4.
- **Hover reveals**: opacity only, 120 ms.
- **Budget**: every added animation is ≤200 ms except the fold spring (≈180 ms); nothing loops; `prefers-reduced-motion` → none. The existing holds (Today order hold, Getting-started return, all-clear) are unchanged.

### D6. Initial load (§6 of design-decisions)

**Boot state.** `useSidebarState` exposes `boot: 'cold' | 'warm' | 'settled'`: `warm` when every boot query is hydrated from the persisted cache on mount (`queryClient.getQueryState(key)?.dataUpdatedAt > 0` before the first fetch resolves), `cold` otherwise, `settled` once the **boot gate** opens. Boot gate = `config/current` ∧ rooms ∧ threads ∧ mesh ∧ (manifests ∨ no paths) ∧ recent-sessions ∧ roster, **or** 1500 ms elapsed since mount (then `settled` with per-query degradation — pending sources read as empty as today). `rosterResolved` is replaced by this gate for `useJourneyFacts` and retirement.

**Skeleton.** `SidebarZones` renders `SidebarSkeleton` (new, built from `SidebarMenuSkeleton`) while `boot === 'cold'`: three header bones + 8 row bones at the final geometry (token-driven), `aria-busy` on the nav, no live region text. The header team name renders a skeleton pill while the roster is pending on a cold boot (never the word "Your team" for a returning user; the cache covers the warm case). Ask DorkBot stays disabled until mesh answers.

**One reveal.** When `cold → settled`: `AnimatePresence mode="wait"` cross-fades skeleton → zones once (160 ms opacity + 4 px rise; zones stagger 30 ms, rows do not). `warm`: no animation (`initial={false}`). Reduced motion: instant.

**Persisted cache.** `shared/lib/query-client.ts` wires `persistQueryClient` with `createSyncStoragePersister({ storage: window.localStorage, key: 'dorkos:rq:<origin>' })`, `buster: __APP_VERSION__`, `maxAge: 24h`, `dehydrateOptions.shouldDehydrateQuery` allow-list: `['config','current']`, `roomKeys.list()`, `roomKeys.threads()`, `['mesh','agent-paths']`, `agentKeys.resolved(*)`, `['recent-sessions', *]`, the team roster key. Only when the transport is `HttpTransport` (web); the embed never persists. `main.tsx` switches to `PersistQueryClientProvider`. Hydration is synchronous (sync persister) so the first render sees cached data. Dev: the Dev Playground gets a "Clear sidebar cache" control.

**One fetch per fact.** `useOnboarding` / `SidebarHeaderBlock` / `useTours` / `useProfile` move from `['config']` to `configKeys.current()` (one query; `useConfig` is the reader); `useJumpBackIn` and `useSidebarState` share `['recent-sessions', 24]` with `select` for the sidebar's first 10. `useDigestFacts`'s once-a-day latch reads prefs only once they are settled (`boot === 'settled'`).

**Identity.** Agent rows and DM faces never paint before manifests on a cold boot (the gate); the path-hash fallback stays for directories without a manifest and is final for them. The `sidebar-item.ts:110-138` comment is deleted; `resolveAgentVisual` is unchanged. DOR-1143 closes with a unit test: given manifests, the face equals the manifest face on the first painted model.

**Scroll-to-active.** `use-scroll-to-active.ts` latches the anchor at the first `settled` model; the initial positioning runs in `useLayoutEffect` with `behavior: 'auto'`; smooth scroll only on anchor changes after settle.

**Removed.** BC-49 `welcomeBack` prop, its `useState` latch and the CSS glow (`index.css`), with the spec amendment. The whole-app `motion.div key="main-app"` fade stays (one 200 ms fade is calm); the blank gate at `AppShell.tsx:433` shortens to the cached-config case automatically (config is in the persisted cache).

**Evidence.** Browser test `apps/e2e/tests/dashboard-sidebar/boot-stability.spec.ts`: seed, load once (cold), reload (warm) → assert (a) no skeleton on warm, (b) every row's `boundingBox` at +100 ms equals at +2000 ms, (c) no `data-arrived` rows on boot, (d) agent face `data-emoji` at first paint equals after settle. Unit: boot-gate truth table; `shouldDehydrateQuery` allow-list; `boot` transitions.

### D7. Honesty fixes (Wave 0) and dead code

- Dead glyph kinds `face-stack` / `person-avatar` removed from `SidebarIconId`/row builders (RoomRow derives faces from the item index; the generic row never needed them).
- Unused `SidebarRowModel` fields `origin`, `projectLabel`, `actions`, `status`, `liveCount` removed (with their producers); `LIVE_CHIP_MIN`/`LIVE_CHIP_THRESHOLD` → one constant in `library-rows.ts`, consumed by `AgentListItem` through the model (`liveCount` returns as the **one** consumed field, or the UI keeps its own derivation and the model's copy goes — pick one; the spec picks **model-provided `liveCount`**, UI stops calling `useLiveSessionCount` per row).
- `SidebarChrome` memo deps cleanup; `SidebarChrome` reuses the model's `itemIndex` (exposed on `SidebarState`) instead of building a second one; stale `SidebarDnd.tsx:78-80` comment; stale `filterSidebarItems` docs; `ConversationSurface` `'dm'` gets its one reader (the capability table's docblock) or is removed — **removed** (the value is write-only; `surface` narrows to `'session' | 'room'`, `RoomSurface` writes `'room'`).
- Vocabulary: `SidebarIconId` `discovery` and `digest` collapse to `digest`; `SidebarSection.tsx:25` container keyed by section **id** (`dms`) not label.

### D8. Performance

- `RoomRow` is `React.memo`; the six mutation hooks and `useSidebarPrefs` move behind the row's menu (`useRoomRowMenu(roomId)` mounted only when the menu opens) and the pin/mute/group reads come from `SidebarChrome` context (one subscription).
- `useSectionChrome`'s `unreadIds` and `smartGroupCandidates` are computed once in `SidebarZones` and passed via `SidebarChrome` context.
- `useRovingFocus.sync` runs on `[sectionRowIds]` not every commit (plus a `MutationObserver` for the inputs), or is debounced to an animation frame — pick the former.
- `useSidebarState` splits the 20-dep memo into `slowInputs` (agents, rooms, prefs, manifests) and `fastInputs` (now, attention, signals) so a clock tick rebuilds only the rules that read time; `buildSidebarModel` signature unchanged (the two objects are spread into one `SidebarState`).

### Code structure

New files: `ui/SidebarBottomSlot.tsx`, `ui/SidebarSkeleton.tsx`, `model/use-boot-state.ts`, `shared/lib/query-persister.ts`, `apps/e2e/tests/dashboard-sidebar/boot-stability.spec.ts`, `ui/rooms/use-room-row-menu.ts`. Every other change edits files named in the review. No new FSD layers; `features/dashboard-sidebar` imports `features/feature-promos` and `features/onboarding` components through their barrels (already the case for promos); if the FSD lint rejects feature→feature for the progress/profile cards, the slot's **candidates are passed in from the app shell** (`AppShell` builds the candidate list; the slot is a dumb arbiter in `shared/ui`).

### API / data model changes

- `UserConfigSchema.ui.promos.dismissedIds: string[]` (new, additive) + conf migration + agent-policy leaf entries.
- `SidebarSectionIdSchema` adds `now`, `today`; per-section `sortMode` for `channels`/`dms` (additive).
- No server routes change. `room-roster.ts` title-follows-roster for auto-titled DMs (server, small).

## User Experience

**Returning user, reload.** The app paints in one frame: header with their team name, Heads up (if any), Today, their sections, Channels, Direct messages (group messages and bridged chats), Agents (recent + pinned, "All 31 agents →"), one bottom card (or none), footer. Nothing moves. Background refetch reconciles; a row that changed slides.

**Day-one user.** Skeleton for one round trip (or less), one reveal: Getting started (5 suggestions), Channels (#team), Agents (DorkBot), the progress card in the bottom slot. `+ New` → Session · Channel… · Group message… · Agent… · Section….

**Talking to an agent.** Click an agent → its session. `+ New › Group message…` → pick 2+ → a conversation; pick one → "Open session with X". An agent that messages you → a Today row with a dot and a dot on its row; click the Today row to read. Team page / profile → "Open session".

**Organising.** Right-click any row → Move to section ▸ / New section…; drag any row onto a section; sections sit above Channels; fold any header (Alt-click folds all); folded headers show "3 · 1 unread".

**Errors / exits.** A query failing on boot → the gate times out at 1.5 s, the panel paints what it has, the failing source reads empty (today's behaviour) and the existing query error toast reports it. Dismissing the last bottom card → the slot collapses to zero height. Reduced motion → every animation is instant, the cold boot shows the skeleton then the panel with no cross-fade.

## Testing Strategy

- **Unit (vitest):** token-driven geometry (snapshot of computed classes); headers fold incl. Heads up/Today and persist; fold-all widened; DM stack ≤2 faces; hand-made-1:1 suppression rule + agent-row dot; picker 1-vs-2+ rule; section rename copy (`one-create-surface` and menu tests updated, not weakened); top-level sections order; `displayFilter` applied to sections (a test that fails when the filter is ignored); mixed "Recent" sort with rooms; Agents recent+pinned floor; `All N agents →` command; roll-up targets navigate; bottom-slot arbiter priority + dismiss persistence; `remote-access` trigger; boot-gate truth table; `shouldDehydrateQuery` allow-list; one config query key (a test that greps for `['config']` literal usages and fails on any); `useJumpBackIn`/sidebar share one key; scroll-to-active latches at settle; motion components render instantly under reduced motion; `RoomRow` memo (render-count test on a prefs write).
- **Integration:** `DashboardSidebar.test.tsx` (the 200-line / no-model-read guard stays green; promo mock replaced by a slot assertion); `SidebarZones.damping-seam`; `MobileTabsLayout` (tab label, Home-panel slot).
- **E2E (Playwright):** `sidebar-row-gutter.spec.ts` (tokens), `sidebar-groups.spec.ts` (+ drag a room into a section, + New section from a room row), new `boot-stability.spec.ts`, `mobile-sidebar-navigation.spec.ts` (label), `direct-messages` spec (picker rule), a bottom-slot spec (pinned while list scrolls; × persists across reload).
- **Mocking:** `FakeAgentRuntime` + fixtures (`model/fixtures/*` gain `boot` and a `sections` case); the persister is injected (no real localStorage in unit tests).
- Every new test carries a purpose comment and a "what failure it catches" note; reviewers re-seed each fixed defect to prove the test discriminates.

## Performance Considerations

Rebuild budget unchanged (`build-sidebar-model.performance.test.ts` ≤5 ms). D8 removes N per-row prefs subscriptions and N+4 fleet walks. Persisted cache adds one synchronous `JSON.parse` on boot (≤200 KB for 60 rooms / 30 agents / 24 sessions; measured in the PR). `layout` animations are scoped per section (`layoutDependency`) to avoid whole-panel FLIP on every tick.

## Security Considerations

The persisted cache holds room titles, session titles and agent names in `localStorage` — the same data already rendered on screen, keyed by server origin; it is cleared on app-version bump (`buster`) and by "Clear sidebar cache". The embed does not persist. No new endpoints; the one new config leaf is non-secret and agent-writable like its siblings.

## Documentation

- `docs/concepts/rooms.mdx` (one paragraph: one agent = session, two or more = group message; agent-initiated lines show in Today).
- `docs/` sidebar guide (if one exists: update headers/sections/bottom slot; if none, a short "The sidebar" concept page is **in scope**).
- `contributing/design-system.md`: the three tokens.
- Changelog fragments per PR (`covers:` block, plain language).
- Spec amendments: `sidebar-now-today-library`, `sidebar-groups`, `smart-agent-groups`, `feature-promo-system`, `rooms` (§8.5/§14.4).
- ADRs (extracted at SPECIFY): one door (2A), top-level sections holding any Library item (3A), bottom-slot arbiter (4A), boot-from-local-cache + one-reveal (D6). Draft ADRs are seeded with this spec.
- Product media: re-capture the sidebar shots after Wave 6 (`capturing-product-media`).

## Implementation Phases

- **Wave 0 — honesty fixes** (independent, parallel): D7 + DM stack + verbs + DOR-1105 targets (`automated`/`working`/`now-overflow`; `section-count` is replaced in Wave 4) + keyboard `+`.
- **Wave 1 — structure (D1)**; **Wave 2 — bottom slot (D4)** — parallel (disjoint files).
- **Wave 3 — one door (D2)**; **Wave 4 — sections + Agents (D3)** — 3 then 4 (both touch `NewMenu`), or parallel with 4 rebasing.
- **Wave 5 — initial load (D6)**: 5a one-fetch-per-fact + boot gate + skeleton + reveal + scroll-to-active + BC-49 removal; 5b persisted cache + boot-stability e2e.
- **Wave 6 — motion (D5)** after 1/2/4.
- **Wave 7 — performance (D8) + docs + spec amendments + media + Linear close-out.**

## Open Questions

- ~~Fold-all-headers?~~ **(RESOLVED)** Yes — one rule; Heads up's folded roll-up keeps the needs-you count. Rationale: an exception costs more to learn than a count costs to read.
- ~~"Recent" threshold and floor for Agents?~~ **(RESOLVED)** 7 days (viewer interaction or agent activity), floor 8. Rationale: a week is the unit people think in; eight rows is the visible part of the section on a laptop.
- ~~Bottom-slot priority?~~ **(RESOLVED)** progress > update > profile > promo. Rationale: a blocked setup beats a version nudge beats a profile nicety beats marketing.
- ~~Mobile tab label?~~ **(RESOLVED)** "All". Rationale: it is the everything panel; "Library" named a heading that no longer exists.
- ~~Tidy existing hand-made 1:1 DMs?~~ **(RESOLVED)** No migration — the Library rule suppresses them; they remain reachable and appear in Today when active. Rationale: zero data risk, same visible result.
- ~~`remote-access` promo?~~ **(RESOLVED)** real trigger if the config exposes a remote-access fact, else delete. Rationale: an always-on promo is an ad.
- ~~Group message vs channel later?~~ **(RESOLVED)** noted as a follow-up idea, not decided here.

## Related ADRs

260808-140954 (threads durable; sessions durable in `/session`) — unchanged · 260726-170125 (room ≠ session) — unchanged · 260818-002805 (one Conversation compound) — unchanged · 260717-001409 (sidebar org in `ui.sidebar`) — extended (new leaves) · 260721-170411 (smart groups rule-derived) — unchanged · 260728-112203 (merge queue) — process · New: see Documentation.

## References

`research/20260819_sidebar-simplification-review.md` · `specs/sidebar-now-today-library/*` · `specs/sidebar-groups/*` · `specs/smart-agent-groups/*` · `specs/feature-promo-system/*` · `specs/rooms/02-specification.md` §8.5/§14.4 · `specs/unified-conversation/*` · Linear DOR-1105, DOR-1098, DOR-906, DOR-1143, DOR-772, DOR-588, DOR-1094, DOR-1097, DOR-654, DOR-1220, DOR-603, DOR-341, DOR-329.
