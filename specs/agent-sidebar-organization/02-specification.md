---
slug: agent-sidebar-organization
id: 260716-235616
created: 2026-07-16
status: specified
linearIssue: DOR-329
---

# Agent Sidebar Organization: User-Defined Groups, Pinned Multi-Presence, and Recent Sessions

**Status:** Approved
**Author:** Claude (flow, DOR-329), commissioned by Dorian
**Date:** 2026-07-16

## Overview

Give the left sidebar (`DashboardSidebar`) a real organization system: user-defined named **groups** (Slack-style sections) with per-group sort and persisted collapse, a **Pinned** section that is multi-presence (a pinned agent also stays in its home group), a cross-agent **Recent** sessions section backed by a new server endpoint, drag-and-drop (with keyboard and menu equivalents), and progressive disclosure so a 3-agent cockpit stays as clean as today while a 30-agent fleet becomes navigable. Organization state moves to server-persisted user config, replacing the localStorage-only pin state.

Research grounding: `research/20260716_slack_sidebar_organization_ux.md` and `research/20260716_cross_app_sidebar_organization_patterns.md`. Design rationale and the 14 resolved decisions: `01-ideation.md` §5.

## Background / Problem Statement

Users running many agents have exactly two tools today: a binary Pinned/Other split (localStorage-only, lost across browsers) and alphabetical order. Two concrete pains, straight from the operator brief:

1. **Grouping** — no way to arrange agents into arbitrary user-defined groups (by project, client, cadence — whatever the user's mental model is).
2. **Recent sessions** — no way to see "what was I just doing?" across agents; sessions are only discoverable per-agent, after expanding a row or drilling into `/session`.

The prior `agent-sidebar-redesign` spec explicitly deferred these as Non-Goals ("Custom named sections (Slack-style user-created groups)", "Drag-to-reorder agents", "Server-side persistence of pin state"). This spec implements them.

## Goals

- User-defined named groups: create, rename, delete, reorder; move agents in/out via drag-and-drop, context menu, and keyboard.
- Per-group sort (Manual / Recent activity / Name) where switching modes never destroys manual order.
- Per-section persisted collapse state; collapsed groups roll up member activity to a header dot.
- Pinned as multi-presence references (pinned agents also render in their home group/ungrouped list).
- A "Recent" section: the latest sessions across **all** agents, one click from resume.
- Server-persisted organization state (`~/.dork/config.json`), synced across every client of the instance; one-time migration from localStorage pins.
- Progressive disclosure: zero new chrome for small unorganized fleets; discovery affordances appear as the fleet grows.
- Accessibility: WCAG 2.2 §2.5.7 — every drag operation has a single-pointer (menu) and keyboard path.

## Non-Goals

- Rule-based "smart groups" (Telegram-style) — strongest v2 candidate; the schema deliberately leaves room (a future `kind` discriminator on groups).
- Inline sidebar search/filter (Cmd+K palette remains the finder; it already has agent frecency).
- Muting/hiding agents; unread/count badges; group nesting; emoji/color on groups.
- Multi-group membership for one agent (Pinned is the cross-cutting mechanism).
- Session drag-and-drop; touch drag on mobile (long-press menu is the mobile path).
- Obsidian embedded mode (`App.tsx` never renders `DashboardSidebar`; `updateConfig` is a no-op on DirectTransport).
- Frecency-ranked sessions (recency is correct for episodic sessions; frecency stays palette-side).

## Technical Dependencies

- **`@dnd-kit/core` + `@dnd-kit/sortable`** (new dependencies, `apps/client`): accessible drag-and-drop; `KeyboardSensor` implements the WCAG keyboard protocol (Space pick up / arrows move / Space drop / Esc cancel) with ARIA live-region announcements. Docs: https://docs.dndkit.com. This is the repo's first dnd dependency (verified: none installed anywhere).
- Existing: Zod 4 config schema, `conf` migrations, TanStack Query 5, Zustand, shadcn sidebar primitives, `motion/react`, Radix ContextMenu/DropdownMenu.

## Detailed Design

### 1. Data model — `UserConfigSchema.ui.sidebar`

In `packages/shared/src/config-schema.ts`:

```ts
export const SidebarGroupSchema = z.object({
  /** Stable id, `crypto.randomUUID()` minted client-side at creation. */
  id: z.string().min(1),
  /** Display name. Duplicates allowed (ids disambiguate). */
  name: z.string().trim().min(1).max(40),
  /** Ordered member agent projectPaths — the durable manual order. */
  agentPaths: z.array(z.string()).default(() => []),
  /** How rows inside this group are ordered. Switching away from 'manual' never mutates agentPaths. */
  sortMode: z.enum(['manual', 'recent', 'name']).default('manual'),
  collapsed: z.boolean().default(false),
});

export const SidebarPrefsSchema = z.object({
  /** Ordered pinned agent projectPaths. Multi-presence references — membership in groups is unaffected. */
  pinned: z.array(z.string()).default(() => []),
  groups: z.array(SidebarGroupSchema).default(() => []),
  /** Ungrouped section ("Agents"): no manual mode — groups are the place for manual curation. */
  ungroupedSortMode: z.enum(['name', 'recent']).default('name'),
  ungroupedCollapsed: z.boolean().default(false),
  recentsCollapsed: z.boolean().default(false),
  groupsHintDismissed: z.boolean().default(false),
});
```

`ui.sidebar: SidebarPrefsSchema.default(() => ({ ...all defaults }))`, and the parent `ui` object's `.default()` updated to include it.

**Semantics:**

- Agent identity key = `projectPath` (matches the existing pin store and the mesh `agents` table's unique column).
- An agent appears in **at most one** group (`agentPaths` across groups are disjoint; writes enforce this by removing the path from any other group on move).
- Paths referencing unknown agents (unregistered, roster mid-scan) are **filtered at render, never pruned on write** (ideation decision #14). Pruning of a specific path happens only through explicit user actions (unpin, remove from group).
- **Migration** (`apps/server/src/services/core/config-manager.ts`): append `backfillSidebarDefaults` keyed to the next release version, idempotent (`store.get('ui')` → write `sidebar` only when absent), following `backfillHarnessDefaults` exactly. Follow the `adding-config-fields` skill lifecycle (schema → defaults → migration → docs table in `contributing/configuration.md` → tests).

**Write protocol:** `PATCH /api/config` deep-merges objects but **replaces arrays wholesale** (verified `deepMerge`, `apps/server/src/routes/config.ts:25-53`). Clients therefore always send the **complete** `ui.sidebar` object on every write: `transport.updateConfig({ ui: { sidebar: nextSidebar } })`. This makes writes deterministic (last-write-wins per whole-section) and avoids partial-array merge ambiguity.

### 2. Server — `GET /api/sessions/recent`

**New service** `apps/server/src/services/session/recent-sessions.ts`:

```
listRecentSessions({ runtimes, agentPaths, limit }): Promise<{
  sessions: Session[];              // merged, updatedAt desc, trimmed to limit
  agentActivity: Record<string, string>; // projectPath → latest session updatedAt (ISO)
  warnings: SessionListWarning[];   // ADR-0310 degradation, aggregated
}>
```

- Enumerate agents server-side via `meshCore.listWithPaths()` (route layer resolves this; the service takes `agentPaths: string[]` for testability). Dedupe paths.
- For each path, call the existing `aggregateSessionList({ runtimes, projectDir: path })` with **bounded concurrency of 5** (simple promise-pool; no new dependency). Each inner call already enforces the per-runtime 2s timeout and produces `warnings[]` — aggregate them all.
- Apply the canonical membership rule (DOR-203) server-side: keep only sessions whose `cwd` exactly equals the agent's `projectPath`. Ghost/cwd-less sessions (DOR-202) are excluded by construction.
- `agentActivity[path]` = max `updatedAt` over that agent's (filtered) sessions — computed **before** the global trim, so it is complete even for agents with no session in the top `limit`. This map powers the client's per-group "Recent activity" sort for free.
- Merge all sessions, sort `updatedAt` desc, slice to `limit`.

**Route** (`apps/server/src/routes/sessions.ts`): `GET /api/sessions/recent` — register **before** any `/:id`-style sibling routes (Express 5 routing). Query schema `RecentSessionsQuerySchema` (`packages/shared/src/schemas.ts`): `limit` int 1–50 default 10. Response `RecentSessionsResponseSchema = { sessions: SessionSchema[], agentActivity: record, warnings?: SessionListWarning[] }` with `.openapi()` registration; regenerate the OpenAPI artifacts so the `openapi-fresh` CI check stays green.

**Transport** (`packages/shared/src/transport.ts`): add `listRecentSessions(limit?: number): Promise<RecentSessionsResponse>`. HTTP impl in `apps/client/.../transport/session-methods.ts`; embedded stub in `embedded-mode-stubs.ts` returns `{ sessions: [], agentActivity: {}, warnings: [] }` (embedded mode has no multi-agent roster).

**No server-side caching** in v1: the fan-out reads local JSONL/SDK stores; client caching (30s `staleTime`) plus SSE invalidation bounds request rate.

### 3. Client data layer

- **`entities/config/model/use-sidebar-prefs.ts`** (new):
  - `useSidebarPrefs()` — selects `ui.sidebar` from the existing `useConfig()` query (schema defaults guarantee presence).
  - `useUpdateSidebarPrefs()` — mutation that takes a `(prev: SidebarPrefs) => SidebarPrefs` updater, sends the complete object, and performs an **optimistic update** on the config query cache (`onMutate` cancel + snapshot + `setQueryData`; rollback `onError`; invalidate `onSettled`). Optimistic writes are what make drag-drop and pin toggles feel instant.
  - Pure helpers (exported for tests): `pinPath`, `unpinPath`, `moveToGroup(prev, path, groupId | null)` (removes from all groups, appends to target; `null` = ungroup), `createGroup(prev, name) → { next, id }`, `renameGroup`, `deleteGroup` (members implicitly return to ungrouped), `reorderGroup(prev, from, to)`, `reorderWithinGroup`, `reorderPinned`, `setGroupSortMode`, `setCollapsed` variants.
- **`entities/session/model/use-recent-sessions.ts`** (new): `useRecentSessions(limit = 10)` — `queryKey: ['sessions', 'recent', limit]`, `staleTime: 30_000`. Extend the existing global session stream bridge (`use-global-session-stream.ts`, ADR-0265) to also invalidate `['sessions', 'recent']` on session lifecycle events.
- **Legacy pin migration + removal:** one-time client-side migration effect (in `DashboardSidebar` mount): if `localStorage['dorkos-pinned-agents']` exists → if server `pinned` is empty, seed it from the stored array (order preserved) via `useUpdateSidebarPrefs`; in both cases remove the localStorage key afterwards (its presence _is_ the migration flag; server state wins when non-empty). Then **delete** `pinnedAgentPaths`/`pinAgent`/`unpinAgent` from the app-store, `PINNED_AGENTS` from `STORAGE_KEYS`, and its line in `resetPreferences()` — no tolerated legacy patterns. The **auto-pin of `agents.defaultAgent` is removed** (superseded: small fleets render as a clean flat list; see Resolved Q2).
- **Sort helpers** (`features/dashboard-sidebar/model/sort-agents.ts`, pure): `sortAgentPaths(paths, mode, { displayNames, agentActivity })` — `manual` = as-is; `name` = `localeCompare` on disambiguated display name (existing `displayNames` map logic); `recent` = `agentActivity` desc, missing timestamps last, name tiebreak.

### 4. Component architecture (`features/dashboard-sidebar`)

`DashboardSidebar.tsx` (395 lines) slims to an orchestrator; new components, all barrel-exported only where externally needed:

```
ui/DashboardSidebar.tsx        orchestrator: data wiring, section composition, migration effect
ui/RecentSessionsSection.tsx   "Recent" — collapsible, ≤5 RecentSessionRow
ui/RecentSessionRow.tsx        agent glyph (useAgentVisual) + session title + relative time → navigate
ui/PinnedSection.tsx           "Pinned" — sortable references
ui/AgentGroupSection.tsx       one user group: GroupHeader + member rows (+ empty-state hint)
ui/UngroupedSection.tsx        "Agents" — header only when groups/pins exist
ui/GroupHeader.tsx             chevron/name, inline rename input, hover-reveal sort + "…" menus
ui/GroupCreateInput.tsx        inline create row (Enter commits, Esc cancels, 1–40 char validation)
ui/AgentRowMenuItems.tsx       ONE menu-item definition rendered into BOTH Radix ContextMenu and
                               DropdownMenu variants — fixes the prior spec's dual-menu drift landmine
ui/GroupsHintCard.tsx          one-time dismissible hint (≥8 agents, 0 groups)
ui/SidebarDnd.tsx              DndContext: sensors, collision detection, DragOverlay, a11y announcements
model/use-sidebar-dnd.ts       pure drop-semantics reducer + dnd-kit event handlers
model/sort-agents.ts           pure sort helpers
```

**Deleted:** `ui/RecentAgentItem.tsx` + its test (dead code, zero non-test consumers).

**Sidebar order, top to bottom:** Search row → Recent → Pinned → groups (user-defined order) → Agents (ungrouped). All section headers use `SidebarGroup`/`SidebarGroupLabel` (the same primitives as the temporal session grouping), with hover-reveal `SidebarGroupAction` affordances and full `ContextMenu` parity on headers.

**Menus (unified via `AgentRowMenuItems`):**

- Agent row (both right-click ContextMenu and "…" DropdownMenu, identical items): existing items + `Pin`/`Unpin` + `Move to group ▸` submenu (checkmark on current group, `Remove from group` when grouped, divider, `New group…`).
- Group header ("…" + right-click): `Rename`, `Sort by ▸` (Manual / Recent activity / Name, radio), `Delete group`. Deleting a **non-empty** group opens an `AlertDialog` — copy: title "Delete group "{name}"?", body "Its N agents move back to Agents. Nothing is deleted.", confirm "Delete group". Empty groups delete immediately.
- "New group" entry points: the sidebar header "+" menu (`AddAgentMenu` gains a `New group` item), the `Move to group ▸ New group…` submenu, and the hint card CTA.

### 5. Drag-and-drop semantics (`use-sidebar-dnd.ts`)

dnd-kit `DndContext` wraps the section list. Sensors: `PointerSensor` (`activationConstraint: { distance: 8 }` so click/expand still wins) + `KeyboardSensor`. `DragOverlay` renders the dragged row; valid drop targets get a visible ring (`focus-ring` token). ARIA announcements via dnd-kit's `announcements` config, worded per operation ("Moved api-server to group Clients").

| Drag                                     | Drop target                        | Effect                                                                     |
| ---------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Group header                             | between other group headers        | reorder `groups` array                                                     |
| Agent row (ungrouped or in a group)      | group body or **collapsed** header | membership move (`moveToGroup`); appended at end (or drop index if manual) |
| Agent row (ungrouped or in a group)      | Pinned section                     | `pinPath` (reference added; home membership unchanged)                     |
| Agent row inside a `manual` group        | within same group                  | reorder `agentPaths`                                                       |
| Agent row inside a `name`/`recent` group | within same group                  | no reorder (sort mode owns order); drag out/into other targets still works |
| Pinned row                               | within Pinned                      | reorder `pinned`                                                           |
| Pinned row                               | anywhere outside Pinned            | `unpinPath` (Finder drag-out gesture; membership untouched)                |
| Agent row in a group                     | Agents (ungrouped) section         | remove from group                                                          |

Every operation above is also reachable via menus (single-pointer, WCAG 2.2 §2.5.7) and via keyboard (KeyboardSensor for sorting; menus for moves). Sessions are never draggable. Mobile (Sheet): drag disabled; long-press context menu covers all operations.

### 6. Progressive disclosure & states

| Condition                                                       | Render                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agentCount < 2` or no recent sessions                          | Recent section hidden entirely                                                         |
| `pinned.length === 0`                                           | Pinned section hidden (existing behavior)                                              |
| `groups.length === 0 && pinned.length === 0`                    | Ungrouped renders as a header-less flat list — today's exact look                      |
| group with only-unknown/no member paths                         | group renders with quiet empty hint "Drag agents here" (persisted, never auto-deleted) |
| `agentCount ≥ 8 && groups.length === 0 && !groupsHintDismissed` | `GroupsHintCard`: "Group your agents" + one-line how + [New group] CTA + dismiss X     |
| roster loading                                                  | existing skeleton behavior; Recent shows 3 skeleton rows                               |
| recents `warnings[]` non-empty                                  | render what loaded; warnings logged to console only (sidebar stays calm)               |

Collapse state (groups, ungrouped, recents) persists via config; **default expanded** (Slack FTUX research). New groups are created expanded.

### 7. Collapsed-group activity rollup

A collapsed group header shows a small activity dot when any member agent currently has active work. Implement with a **single aggregated subscription** (`useAgentsAggregateStatus(paths: string[])` beside the existing `useAgentHottestStatus`, same store, `useShallow` set compare) — explicitly NOT one subscription per hidden member (perf landmine flagged by the prior spec at 100+ agents).

## User Experience

- **Kai (10 agents, 5 projects):** right-clicks `api-server` → Move to group → New group… → types "Acme" → Enter. Drags three more rows into "Acme" (or long-press menu on mobile). Pins `api-server`; it now sits in Pinned _and_ stays in Acme. Sets Acme's sort to Recent activity — the hottest agent floats up. Collapses "Experiments"; its dot lights when a background agent inside finishes. After a context switch, the Recent section's top row is the session he left 10 minutes ago — one click resumes it.
- **New user (2 agents):** sidebar is exactly today's flat list. No group chrome, no hint, no Recent section until a second agent has sessions. First organizational affordance encountered naturally: "Move to group" in the context menu, or the "+" menu.
- **Errors:** config PATCH failure → optimistic state rolls back, destructive-free (a failed group create simply disappears; a toast is unnecessary — the inline input reopens with the typed name preserved is NOT required, keep simple rollback). Recents endpoint degradation → partial list renders, no error chrome in the sidebar.
- **Exit paths:** delete a group → members return to Agents; unpin → reference disappears, agent remains in its home; "Reset preferences" leaves server-side organization intact (it is config, not a local preference) — only legacy local keys are cleared.

## Testing Strategy

TDD per repo standard; tests alongside source in `__tests__/`.

- **Unit (pure logic, highest density):** `sort-agents.ts` (3 modes, missing activity, name tiebreak, stability); `use-sidebar-prefs` helpers (pin/unpin idempotence, moveToGroup disjointness invariant — a path never appears in two groups, deleteGroup returns members, reorder bounds); `use-sidebar-dnd` drop reducer (every row of the semantics table above, including no-op drops and unknown targets).
- **Client component (jsdom, `createMockTransport` from `@dorkos/test-utils` — not the hand-rolled mock):** DashboardSidebar rendering matrix (flat vs organized; pinned multi-presence renders the same agent twice — assert both rows; hint card threshold logic; Recent visibility rules); group CRUD flows (inline create validation 1–40 chars, rename, non-empty delete confirm); `AgentRowMenuItems` renders identical items in both variants (regression test for the drift landmine); migration effect (seeds from localStorage once, removes key, server-wins case); optimistic update rollback on transport failure.
- **Server:** `recent-sessions.test.ts` on the `aggregate-session-list.test.ts` template — multi-path × multi-runtime fan-out with `FakeAgentRuntime`, per-runtime timeout → `warnings[]` propagation, cwd-mismatch exclusion, `agentActivity` completeness beyond the trim limit, limit/order; route test for query validation + envelope; `config-manager.test.ts` migration body test (`backfillSidebarDefaults` idempotence).
- **E2E:** none required for merge; a Playwright group-create + drag scenario is a stretch task (P3, optional).
- **Mocking:** Transport boundary only (repo rule); dnd tested at the reducer level, not via synthetic pointer events.

## Performance Considerations

- Fan-out endpoint is O(agents × runtimes) local reads with concurrency 5 and existing 2s per-runtime timeouts; client hits it at most every 30s (staleTime) plus SSE-driven invalidations. Acceptable for the tens-of-agents scale; revisit with a server-side cache if fleets reach hundreds.
- No sidebar virtualization (unchanged stance from the prior spec); the aggregate-status hook keeps collapsed groups O(1) subscriptions. Group membership maps computed in `useMemo` keyed on config + roster.
- Optimistic config writes keep every interaction (drag, pin, collapse) at 0ms perceived latency.

## Security Considerations

- No new privileged surface: the endpoint reads session metadata already exposed per-agent by `GET /api/sessions`; config writes go through the existing validated `PATCH /api/config` (prototype-pollution keys already rejected; `ui.sidebar` contains no secrets).
- Group names are user text rendered as text nodes (React escaping); length-capped at 40 by Zod.

## Documentation

- `contributing/configuration.md`: add `ui.sidebar` to the field table + migration entry (per `adding-config-fields`).
- Changelog fragment `changelog/unreleased/<id>-agent-sidebar-groups.md` (writing-for-humans voice): groups, pinned staying in groups, Recent section, syncs across devices.
- If a docs/ cockpit/sidebar guide exists, add a short "Organize your agents" section (verify during execution).

## Implementation Phases

- **Phase 1 — foundation (server + data):** `SidebarPrefsSchema` + `ui.sidebar` + migration + config docs/tests; recent-sessions service + route + shared schemas + OpenAPI regen; transport method + embedded stub; `use-sidebar-prefs` (+ helpers) with optimistic updates; `use-recent-sessions` + stream-bridge invalidation; localStorage pin migration; app-store pin removal.
- **Phase 2 — UI core:** section components, group CRUD (inline create/rename, delete dialog), unified `AgentRowMenuItems`, per-group sort, progressive-disclosure rules, Recent section UI, activity-rollup dot with aggregated subscription, `RecentAgentItem` deletion, DashboardSidebar slimming.
- **Phase 3 — dnd + polish:** dnd-kit integration (`SidebarDnd`, `use-sidebar-dnd`), keyboard + announcements, hint card, motion polish (AnimatePresence on section/row transitions consistent with existing variants), changelog fragment, docs, dev-playground assessment.

## Open Questions

- ~~Q1: Should ungrouped agents support manual ordering?~~ **(RESOLVED)** No. Answer: groups are the manual-curation surface; ungrouped offers `name`/`recent` sort only. Rationale: keeps drop semantics unambiguous (a drop on "Agents" always means "remove from group", never "reorder"), and matches the mental model that organizing = grouping.
- ~~Q2: Keep the auto-pin of `agents.defaultAgent`?~~ **(RESOLVED)** Remove it. Answer: superseded — with progressive disclosure the small-fleet flat list is already clean, and seeding state the user didn't create contradicts the "organization is user investment" principle. The removal is called out in the changelog fragment.
- ~~Q3: Confirm-dialog on group delete?~~ **(RESOLVED)** Only for non-empty groups. Answer: empty-group deletion is trivially reversible; non-empty deletion discards curation (which order/membership took effort to build), so one calm AlertDialog with honest copy.

## Related ADRs

- ADR-0043 — agent storage file-first write-through (constrains where organization state may NOT live).
- ADR-0310 — runtime-owned session storage; aggregated listing with per-runtime degradation (the recents endpoint follows its envelope contract).
- ADR-0265 — global session stream → query-cache bridging (recents invalidation rides it).
- New draft ADRs seeded by this spec: sidebar organization state in user config; cross-agent recent-sessions fan-out endpoint; dnd-kit adoption.

## References

- DOR-329 (Linear); `specs/agent-sidebar-organization/01-ideation.md`
- `research/20260716_slack_sidebar_organization_ux.md`; `research/20260716_cross_app_sidebar_organization_patterns.md`
- Prior art: `specs/agent-sidebar-redesign/` (implemented predecessor; its Non-Goals are this spec's scope), `specs/agent-centric-ux/` (palette frecency)
- dnd-kit: https://docs.dndkit.com · WCAG 2.2 §2.5.7: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements
