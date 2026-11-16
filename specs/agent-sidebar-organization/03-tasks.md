# Tasks: Agent Sidebar Organization

**Spec:** `specs/agent-sidebar-organization/02-specification.md`
**Slug:** `agent-sidebar-organization`
**Mode:** full

Give the left sidebar (`DashboardSidebar`) a real organization system: user-defined named groups with per-group sort and persisted collapse, a multi-presence Pinned section, a cross-agent Recent sessions section backed by a new server endpoint, drag-and-drop with keyboard and menu equivalents, and progressive disclosure. Organization state moves to server-persisted user config (`~/.dork/config.json`), replacing the localStorage-only pin state.

- **Phase 1 (Foundation):** 6 tasks
- **Phase 2 (UI core):** 6 tasks
- **Phase 3 (Drag-and-drop & polish):** 4 tasks

**Critical path:** 1.2 -> 1.3 -> 1.5 -> 2.2 -> 2.4 -> 3.1 -> 3.2 -> 3.4

---

## Phase 1: Foundation

### Task 1.1: Add SidebarPrefsSchema, ui.sidebar config, and backfill migration

**Size:** medium · **Priority:** high · **Dependencies:** none · **Parallel with:** 1.2

Add the sidebar organization schema to `packages/shared/src/config-schema.ts`, wire it into `UserConfigSchema.ui`, add the conf migration, document it, and test it. Follow the `adding-config-fields` skill lifecycle: schema -> defaults -> migration -> docs table -> tests.

**Schemas (add to `packages/shared/src/config-schema.ts`, verbatim including TSDoc):**

```ts
export const SidebarGroupSchema = z.object({
  /** Stable id, `crypto.randomUUID()` minted client-side at creation. */
  id: z.string().min(1),
  /** Display name. Duplicates allowed (ids disambiguate). */
  name: z.string().trim().min(1).max(40),
  /** Ordered member agent projectPaths - the durable manual order. */
  agentPaths: z.array(z.string()).default(() => []),
  /** How rows inside this group are ordered. Switching away from 'manual' never mutates agentPaths. */
  sortMode: z.enum(['manual', 'recent', 'name']).default('manual'),
  collapsed: z.boolean().default(false),
});

export const SidebarPrefsSchema = z.object({
  /** Ordered pinned agent projectPaths. Multi-presence references - membership in groups is unaffected. */
  pinned: z.array(z.string()).default(() => []),
  groups: z.array(SidebarGroupSchema).default(() => []),
  /** Ungrouped section ("Agents"): no manual mode - groups are the place for manual curation. */
  ungroupedSortMode: z.enum(['name', 'recent']).default('name'),
  ungroupedCollapsed: z.boolean().default(false),
  recentsCollapsed: z.boolean().default(false),
  groupsHintDismissed: z.boolean().default(false),
});
```

Export the inferred types (`SidebarGroup`, `SidebarPrefs`) alongside the schemas, matching the existing export convention in this file.

**Wire into `ui`:** Add `sidebar: SidebarPrefsSchema.default(() => ({ ...all defaults }))` to the `UserConfigSchema.ui` object, and update the parent `ui` object's `.default()` so the default-produced `ui` value includes a fully-defaulted `sidebar`. Schema defaults must guarantee `ui.sidebar` is always present after a parse (the client selector relies on this).

**Migration (`apps/server/src/services/core/config-manager.ts`):** Append a `backfillSidebarDefaults` migration keyed to the next release version. It must be idempotent: read `store.get('ui')`, and write `sidebar` only when it is absent (`ui.sidebar === undefined`). Model it exactly on the existing `backfillHarnessDefaults` migration in the same file (same keying, same guard style, same write-through shape).

**Docs (`contributing/configuration.md`):** Add a `ui.sidebar` row to the config field table describing the sidebar organization prefs (groups, pinned, per-section sort/collapse, hint dismissal), and add a migration entry for `backfillSidebarDefaults` per the `adding-config-fields` skill.

**Tests:**

- Schema test (alongside `config-schema.ts` in `__tests__/`): parsing `{}` yields `ui.sidebar` with all documented defaults (`pinned: []`, `groups: []`, `ungroupedSortMode: 'name'`, `ungroupedCollapsed: false`, `recentsCollapsed: false`, `groupsHintDismissed: false`); a group parses with its own defaults (`sortMode: 'manual'`, `collapsed: false`, `agentPaths: []`); name >40 chars or empty rejects.
- Migration test in `config-manager.test.ts`: `backfillSidebarDefaults` adds `ui.sidebar` when absent, and is a no-op (idempotent) when `ui.sidebar` already exists (does not overwrite user data).

**Acceptance criteria:**

- [ ] `SidebarGroupSchema` and `SidebarPrefsSchema` exist verbatim (with TSDoc) in `packages/shared/src/config-schema.ts` and inferred types are exported.
- [ ] `UserConfigSchema.ui.sidebar` defaults to a fully-populated `SidebarPrefs`; parsing an empty config produces all sidebar defaults.
- [ ] `backfillSidebarDefaults` is appended to `config-manager.ts`, keyed to the next release version, idempotent, and mirrors `backfillHarnessDefaults`.
- [ ] `contributing/configuration.md` has the `ui.sidebar` field-table row and the migration entry.
- [ ] Schema-defaults test and migration-idempotence test pass (`pnpm vitest run` on both files).

---

### Task 1.2: Add recent-sessions shared schemas, Transport method, HTTP/embedded impls, and OpenAPI regen

**Size:** medium · **Priority:** high · **Dependencies:** none · **Parallel with:** 1.1

Add the shared Zod schemas and Transport surface for the cross-agent recent-sessions feature. No server route yet (that is task 1.3) - this task defines the contract that both sides depend on.

**Shared schemas (`packages/shared/src/schemas.ts`):** Add, with `.openapi()` registration so the OpenAPI generator picks them up:

- `RecentSessionsQuerySchema`: `{ limit: z.coerce.number().int().min(1).max(50).default(10) }` (query param `limit`, int 1-50, default 10).
- `RecentSessionsResponseSchema`: `{ sessions: z.array(SessionSchema), agentActivity: z.record(z.string(), z.string()), warnings: z.array(SessionListWarningSchema).optional() }` where `SessionSchema` and `SessionListWarningSchema` are the existing shared schemas (reuse them; do not redefine). `agentActivity` maps agent `projectPath` -> latest session `updatedAt` (ISO string).
- Export inferred types `RecentSessionsQuery` and `RecentSessionsResponse`.

Register both via the `.openapi()` mechanism used by the other request/response schemas in this file so the artifacts regenerate cleanly.

**Transport (`packages/shared/src/transport.ts`):** Add to the `Transport` interface:

```ts
listRecentSessions(limit?: number): Promise<RecentSessionsResponse>;
```

Include a TSDoc comment (enforced by eslint-plugin-jsdoc) describing that it returns the most-recent sessions across all agents plus a per-agent activity map and per-runtime warnings.

**HTTP impl (`apps/client/src/layers/shared/lib/transport/session-methods.ts`):** Implement `listRecentSessions(limit)` calling `GET /api/sessions/recent?limit=<limit>` and parse the response with `RecentSessionsResponseSchema`. Follow the existing method patterns in this file.

**Embedded stub (`apps/client/src/layers/shared/lib/embedded-mode-stubs.ts`):** Embedded mode has no multi-agent roster: `listRecentSessions` returns `{ sessions: [], agentActivity: {}, warnings: [] }`. Also add the method to the direct transport (`apps/client/src/layers/shared/lib/direct/session-methods.ts`) if that file implements the Transport interface - return the same empty envelope there.

**OpenAPI regeneration:** Regenerate the OpenAPI artifacts so the `openapi-fresh` CI check stays green. Commit the regenerated artifact.

**Acceptance criteria:**

- [ ] `RecentSessionsQuerySchema` (limit int 1-50, default 10) and `RecentSessionsResponseSchema` (`sessions`, `agentActivity` record, optional `warnings`) exist in `packages/shared/src/schemas.ts` with `.openapi()` registration and exported types.
- [ ] `Transport.listRecentSessions(limit?: number): Promise<RecentSessionsResponse>` is declared with TSDoc.
- [ ] HTTP transport calls `GET /api/sessions/recent?limit=` and validates the response with the schema.
- [ ] Embedded stub (and DirectTransport, if applicable) returns `{ sessions: [], agentActivity: {}, warnings: [] }`.
- [ ] OpenAPI artifacts regenerated; `openapi-fresh` check passes.
- [ ] `pnpm --filter @dorkos/shared typecheck` and client typecheck pass.

---

### Task 1.3: Build recent-sessions fan-out service and GET /api/sessions/recent route

**Size:** large · **Priority:** high · **Dependencies:** 1.2 · **Parallel with:** 1.4

Build the server service and route that back the cross-agent Recent section. Follows ADR-0310 (runtime-owned session storage, per-runtime degradation via `warnings[]`) and the DOR-203 canonical membership rule (exact cwd match).

**Service (`apps/server/src/services/session/recent-sessions.ts`):** Export `listRecentSessions`:

```ts
listRecentSessions({ runtimes, agentPaths, limit }): Promise<{
  sessions: Session[];              // merged, updatedAt desc, trimmed to limit
  agentActivity: Record<string, string>; // projectPath -> latest session updatedAt (ISO)
  warnings: SessionListWarning[];   // ADR-0310 degradation, aggregated
}>
```

Implementation requirements:

- The service takes `agentPaths: string[]` directly (for testability); the route layer resolves them. Dedupe the incoming paths.
- For each path, call the existing `aggregateSessionList({ runtimes, projectDir: path })` (`apps/server/src/services/session/aggregate-session-list.ts`) with **bounded concurrency of 5** - a simple promise-pool, no new dependency. Each inner call already enforces the per-runtime 2s timeout and produces `warnings[]`; aggregate all of them into one array.
- Apply the canonical membership rule (DOR-203) server-side: keep only sessions whose `cwd` **exactly equals** the agent's `projectPath`. Ghost/cwd-less sessions (DOR-202) are excluded by construction.
- `agentActivity[path]` = max `updatedAt` over that agent's (filtered) sessions, computed **before** the global trim, so it is complete even for agents with no session in the top `limit`. This map powers the client's per-group "Recent activity" sort for free.
- Merge all sessions across paths, sort `updatedAt` desc, slice to `limit`.
- No server-side caching in v1 (the fan-out reads local JSONL/SDK stores; client 30s staleTime + SSE invalidation bounds request rate).

**Route (`apps/server/src/routes/sessions.ts`):** Add `GET /api/sessions/recent`. **Register it BEFORE any `/:id`-style sibling routes** (Express 5 routing - a `/:id` route would otherwise capture `recent`). Validate the query with `RecentSessionsQuerySchema` (`limit` int 1-50, default 10). Resolve agent paths server-side via `meshCore.listWithPaths()`, call `listRecentSessions({ runtimes, agentPaths, limit })`, and return `RecentSessionsResponseSchema`-shaped `{ sessions, agentActivity, warnings }`.

**Tests:** Build on the `aggregate-session-list.test.ts` template using `FakeAgentRuntime` (from `@dorkos/test-utils`):

- `recent-sessions.test.ts` (service): multi-path x multi-runtime fan-out; per-runtime timeout -> `warnings[]` propagation and aggregation; cwd-mismatch exclusion (sessions whose cwd != projectPath dropped); `agentActivity` completeness beyond the trim limit (an agent with a session outside the top `limit` still appears in `agentActivity`); limit/order (merged, updatedAt desc, sliced to limit); path dedupe; concurrency does not drop or duplicate results.
- Route test: query validation (limit clamping/rejection outside 1-50, default 10) + response envelope shape.

**Acceptance criteria:**

- [ ] `recent-sessions.ts` exports `listRecentSessions` with the exact signature above; concurrency is bounded at 5 with a promise-pool and no new dependency.
- [ ] cwd-exact filter applied; `agentActivity` computed pre-trim; sessions merged, sorted updatedAt desc, sliced to limit; warnings aggregated.
- [ ] `GET /api/sessions/recent` is registered before `/:id` siblings, validates with `RecentSessionsQuerySchema`, resolves paths via `meshCore.listWithPaths()`, and returns the response envelope.
- [ ] Service and route tests pass (`pnpm vitest run` on both), covering fan-out, timeout->warnings, cwd exclusion, agentActivity-beyond-trim, and limit/order.
- [ ] `pnpm --filter @dorkos/server typecheck` and `lint` pass.

---

### Task 1.4: Build use-sidebar-prefs hook with optimistic updates and pure mutation helpers

**Size:** large · **Priority:** high · **Dependencies:** 1.1 · **Parallel with:** 1.3

Build the client data layer for reading and mutating sidebar organization state. New file `apps/client/src/layers/entities/config/model/use-sidebar-prefs.ts`, barrel-exported from the `entities/config` index.

**Hooks:**

- `useSidebarPrefs()` - selects `ui.sidebar` from the existing `useConfig()` query (`entities/config/model/use-config.ts`). Schema defaults guarantee presence, so no null-guarding is needed.
- `useUpdateSidebarPrefs()` - a TanStack Query mutation taking a `(prev: SidebarPrefs) => SidebarPrefs` updater. It must:
  - Send the **complete** `ui.sidebar` object on every write via `transport.updateConfig({ ui: { sidebar: nextSidebar } })`. Rationale: `PATCH /api/config` deep-merges objects but **replaces arrays wholesale** (verified `deepMerge`, `apps/server/src/routes/config.ts:25-53`), so clients always send the whole section; writes are deterministic last-write-wins per whole-section.
  - Perform an **optimistic update** on the config query cache: `onMutate` cancels in-flight config queries, snapshots the current config, applies the updater via `setQueryData`; `onError` rolls back to the snapshot; `onSettled` invalidates the config query. Optimistic writes are what make drag-drop and pin toggles feel instant (0ms perceived latency).

**Pure helpers (exported for tests):** All take `prev: SidebarPrefs` and return the next `SidebarPrefs` (immutably); no mutation of inputs:

- `pinPath(prev, path)` - append `path` to `pinned` if absent (idempotent).
- `unpinPath(prev, path)` - remove `path` from `pinned`.
- `moveToGroup(prev, path, groupId | null)` - remove `path` from ALL groups' `agentPaths`, then append to the target group's `agentPaths`; `groupId === null` means ungroup (removed from all groups, added to none). Enforces the disjointness invariant: a path never appears in two groups.
- `createGroup(prev, name) -> { next, id }` - mint `id` via `crypto.randomUUID()`, append a new expanded group (`collapsed: false`, `sortMode: 'manual'`, `agentPaths: []`) with the given name; return both the next prefs and the new id.
- `renameGroup(prev, groupId, name)` - set the group's `name`.
- `deleteGroup(prev, groupId)` - remove the group; its members implicitly return to ungrouped (they are simply no longer in any group's `agentPaths`).
- `reorderGroup(prev, from, to)` - move a group within the `groups` array (bounds-checked).
- `reorderWithinGroup(prev, groupId, from, to)` - reorder `agentPaths` inside a group (bounds-checked).
- `reorderPinned(prev, from, to)` - reorder the `pinned` array (bounds-checked).
- `setGroupSortMode(prev, groupId, mode)` - set a group's `sortMode`; MUST NOT mutate `agentPaths` (switching away from 'manual' never destroys manual order).
- Collapse setters: `setGroupCollapsed(prev, groupId, collapsed)`, `setUngroupedCollapsed(prev, collapsed)`, `setRecentsCollapsed(prev, collapsed)` (and a `setGroupsHintDismissed(prev, dismissed)` for the hint card).

**Tests (`__tests__/use-sidebar-prefs.test.ts`):**

- `pinPath`/`unpinPath` idempotence.
- `moveToGroup` disjointness invariant: after moving a path already in group A into group B, it appears only in B (never in two groups); ungroup (`null`) removes from all groups.
- `deleteGroup` returns members to ungrouped (they vanish from all `agentPaths`).
- `reorder*` bounds handling (out-of-range indices are safe no-ops).
- `setGroupSortMode` does not mutate `agentPaths`.
- Optimistic mutation: `onMutate` applies the updater to the cache; `onError` rolls back to the snapshot on transport failure (use a mock transport whose `updateConfig` rejects).

**Acceptance criteria:**

- [ ] `useSidebarPrefs()` selects `ui.sidebar` from the config query.
- [ ] `useUpdateSidebarPrefs()` sends the complete `ui.sidebar` on every write and performs optimistic update (cancel + snapshot + setQueryData), rollback on error, invalidate on settled.
- [ ] All listed pure helpers are exported, immutable, and enforce the disjointness invariant.
- [ ] Unit tests pass (`pnpm vitest run`), including the disjointness invariant and optimistic-rollback cases.
- [ ] Client typecheck and lint pass.

---

### Task 1.5: Build use-recent-sessions hook and extend global session-stream bridge

**Size:** small · **Priority:** high · **Dependencies:** 1.2, 1.3 · **Parallel with:** none

Build the client query hook for the Recent section and wire cache invalidation into the existing global session stream bridge (ADR-0265).

**Hook (`apps/client/src/layers/entities/session/model/use-recent-sessions.ts`):** New file, barrel-exported from the `entities/session` index:

- `useRecentSessions(limit = 10)` - TanStack Query hook calling `transport.listRecentSessions(limit)`.
  - `queryKey: ['sessions', 'recent', limit]`
  - `staleTime: 30_000` (30s)
- Returns the `{ sessions, agentActivity, warnings }` envelope. The `agentActivity` map is consumed by the client's per-group "Recent activity" sort.

**Stream-bridge invalidation (`apps/client/src/layers/entities/session/model/use-global-session-stream.ts`):** Extend the existing global session stream bridge (ADR-0265: global session stream -> query-cache bridging) so that on session lifecycle events it ALSO invalidates the `['sessions', 'recent']` query key (in addition to whatever it already invalidates). This keeps the Recent section live as sessions are created/updated across agents, alongside the 30s staleTime.

**Tests:**

- `use-recent-sessions` test: hook calls `transport.listRecentSessions` with the given limit and exposes the returned envelope; queryKey is `['sessions','recent',limit]` and staleTime is `30_000` (use `createMockTransport` from `@dorkos/test-utils`).
- Stream-bridge test: a simulated session lifecycle event triggers invalidation of `['sessions', 'recent']` (assert `queryClient.invalidateQueries` is called with that key, following the existing bridge test patterns).

**Acceptance criteria:**

- [ ] `useRecentSessions(limit = 10)` exists with `queryKey: ['sessions', 'recent', limit]` and `staleTime: 30_000`, calling `transport.listRecentSessions(limit)`.
- [ ] The global session stream bridge invalidates `['sessions', 'recent']` on session lifecycle events, without breaking its existing invalidations.
- [ ] Both tests pass (`pnpm vitest run`).
- [ ] Client typecheck and lint pass.

---

### Task 1.6: One-time localStorage pin migration and full removal of legacy pin state

**Size:** medium · **Priority:** high · **Dependencies:** 1.4 · **Parallel with:** none

Migrate legacy localStorage pin state into server config once, then delete every legacy pin code path. Codebase-excellence rule: no tolerated legacy patterns.

**One-time migration effect (in `DashboardSidebar` mount):** Add a one-time client-side migration effect that runs on `DashboardSidebar` mount:

- If `localStorage['dorkos-pinned-agents']` exists:
  - If the server `pinned` array (from `useSidebarPrefs()`) is **empty**, seed it from the stored array (**order preserved**) via `useUpdateSidebarPrefs()` (using the `pinPath` helper or a direct set of `pinned`).
  - In **both** cases (whether or not it seeded), remove the `localStorage['dorkos-pinned-agents']` key afterward. Its presence _is_ the migration flag; server state wins when non-empty.
- The effect must run at most once and be safe across re-mounts (once the key is gone, it does nothing).

Note: the legacy localStorage key name is `dorkos-pinned-agents` (referenced by `STORAGE_KEYS.PINNED_AGENTS`).

**Full removal of legacy pin state (app-store):** Delete from the Zustand app-store core slice:

- `pinnedAgentPaths` state field
- `pinAgent` action
- `unpinAgent` action
- `PINNED_AGENTS` entry from `STORAGE_KEYS`
- the `pinnedAgentPaths` cleanup line inside `resetPreferences()`
- the **auto-pin of `agents.defaultAgent`** on first run (Resolved Q2: removed - with progressive disclosure the small-fleet flat list is already clean; seeding state the user did not create contradicts the "organization is user investment" principle). Remove the code that auto-pins the default agent entirely.

Update every consumer of the removed store fields/actions to use the new `useSidebarPrefs()` / `useUpdateSidebarPrefs()` surface (or remove the now-dead usage). Leave no references to the deleted symbols.

Note: "Reset preferences" must leave server-side organization intact (it is config, not a local preference) - only legacy local keys are cleared. Since `pinnedAgentPaths` is being removed from the store entirely, `resetPreferences()` simply no longer touches pin state.

**Tests:**

- Migration effect test (jsdom, `createMockTransport`): with `localStorage['dorkos-pinned-agents']` set and server `pinned` empty, mounting seeds `pinned` from the stored array in order and removes the localStorage key; with server `pinned` non-empty (server-wins case), it does NOT overwrite but still removes the key; running twice does nothing the second time.
- Confirm (via grep in the test or a lint pass) there are zero remaining references to `pinnedAgentPaths`, `pinAgent`, `unpinAgent`, or `STORAGE_KEYS.PINNED_AGENTS`.

**Acceptance criteria:**

- [ ] One-time migration seeds server `pinned` from `localStorage['dorkos-pinned-agents']` (order preserved) only when server `pinned` is empty, and always removes the localStorage key afterward.
- [ ] `pinnedAgentPaths`, `pinAgent`, `unpinAgent`, `STORAGE_KEYS.PINNED_AGENTS`, and the `resetPreferences()` pin line are fully removed from the app-store; no references remain anywhere.
- [ ] The auto-pin of `agents.defaultAgent` is removed.
- [ ] Migration tests (seed-once, server-wins, idempotent-on-remount) pass.
- [ ] `pnpm knip` shows no new dead code from removed symbols; client typecheck and lint pass.

---

## Phase 2: UI core

### Task 2.1: Build pure sort-agents helpers (manual/name/recent)

**Size:** small · **Priority:** high · **Dependencies:** none · **Parallel with:** 1.1, 1.2, 1.3, 1.4

Build the pure sort helpers used by group sections and the ungrouped section. New file `apps/client/src/layers/features/dashboard-sidebar/model/sort-agents.ts` (create the `model/` directory if absent).

**Function:**

```ts
sortAgentPaths(
  paths: string[],
  mode: 'manual' | 'name' | 'recent',
  ctx: { displayNames: Record<string, string>; agentActivity: Record<string, string> },
): string[]
```

Semantics:

- `manual` = return `paths` as-is (order preserved, no sorting).
- `name` = sort by `localeCompare` on the disambiguated display name (from the `displayNames` map, which mirrors the existing display-name disambiguation logic in the sidebar).
- `recent` = sort by `agentActivity[path]` (ISO timestamp) descending; **missing timestamps sort last**; **name tiebreak** (fall back to `localeCompare` on display name when timestamps are equal or both missing).
- Pure and stable: never mutate the input array; produce a new array.

Note: the ungrouped ("Agents") section only ever uses `name` or `recent` (no manual mode); groups use all three.

**Tests (`__tests__/sort-agents.test.ts`):**

- `manual` returns input order unchanged.
- `name` sorts alphabetically by disambiguated display name via `localeCompare`.
- `recent` sorts by `agentActivity` desc.
- Missing-activity handling: paths absent from `agentActivity` sort after paths that have timestamps.
- Name tiebreak: equal/both-missing timestamps break ties by display name.
- Stability: no input mutation; deterministic output.

**Acceptance criteria:**

- [ ] `sortAgentPaths(paths, mode, { displayNames, agentActivity })` implements manual/name/recent exactly as above.
- [ ] Missing timestamps sort last; ties break by display name; input never mutated.
- [ ] All sort-helper tests pass (`pnpm vitest run`).
- [ ] Client typecheck and lint pass.

---

### Task 2.2: Build sidebar section components and rewrite DashboardSidebar orchestrator with progressive disclosure

**Size:** large · **Priority:** high · **Dependencies:** 1.4, 1.5, 2.1 · **Parallel with:** none

Build the section components and rewrite `DashboardSidebar.tsx` (currently 395 lines) into a slim orchestrator that composes them, applying the progressive-disclosure rules. All new components live under `apps/client/src/layers/features/dashboard-sidebar/ui/` and are barrel-exported only where externally needed.

**Components to build:**

- `RecentSessionsSection.tsx` - the "Recent" section: collapsible, renders up to 5 `RecentSessionRow`. Consumes `useRecentSessions()`; collapse state from `ui.sidebar.recentsCollapsed`.
- `RecentSessionRow.tsx` - agent glyph via `useAgentVisual` + session title + relative time; clicking navigates to resume that session.
- `PinnedSection.tsx` - the "Pinned" section: renders pinned agents as references (multi-presence - a pinned agent still renders in its home group/ungrouped list too). Order from `ui.sidebar.pinned`.
- `AgentGroupSection.tsx` - one user-defined group: `GroupHeader` + member rows (sorted via `sortAgentPaths` by the group's `sortMode`) + an empty-state hint when the group has no (known) members.
- `UngroupedSection.tsx` - the "Agents" section: renders a header ONLY when groups or pins exist; otherwise renders a header-less flat list (today's exact look). Sort via `ui.sidebar.ungroupedSortMode` (`name` or `recent` only).
- `GroupHeader.tsx` - chevron + name, inline rename input, hover-reveal sort + "..." menus (built in task 2.4/2.5).
- `GroupCreateInput.tsx` - inline create row (built out in task 2.4; scaffold it here so sections can host it).

Use the shadcn `SidebarGroup`/`SidebarGroupLabel`/`SidebarMenu*` primitives (the same primitives that power temporal session grouping) with hover-reveal `SidebarGroupAction` affordances.

**DashboardSidebar orchestrator rewrite:** Slim `DashboardSidebar.tsx` to: data wiring (roster via `useMeshAgentPaths`/`useResolvedAgents`, `useSidebarPrefs`, `useRecentSessions`), section composition, and the migration effect (added in task 1.6). Compute group-membership maps in `useMemo` keyed on config + roster.

**Sidebar order, top to bottom:** Search row -> Recent -> Pinned -> groups (user-defined order) -> Agents (ungrouped).

**Stale-path rule:** paths referencing unknown agents (unregistered, roster mid-scan) are **filtered at render, never pruned on write**. Filter unknown paths out of each section at render time; do not mutate config.

**Progressive-disclosure rules (render matrix, apply exactly):**

| Condition                                    | Render                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agentCount < 2` or no recent sessions       | Recent section hidden entirely                                                         |
| `pinned.length === 0`                        | Pinned section hidden (existing behavior)                                              |
| `groups.length === 0 && pinned.length === 0` | Ungrouped renders as a header-less flat list - today's exact look                      |
| group with only-unknown/no member paths      | group renders with quiet empty hint "Drag agents here" (persisted, never auto-deleted) |
| roster loading                               | existing skeleton behavior; Recent shows 3 skeleton rows                               |
| recents `warnings[]` non-empty               | render what loaded; warnings logged to console only (sidebar stays calm)               |

Collapse state (groups, ungrouped, recents) persists via config; **default expanded**. New groups are created expanded.

**Tests (jsdom, `createMockTransport` from `@dorkos/test-utils` - not a hand-rolled mock):** DashboardSidebar rendering matrix:

- flat vs organized: with 0 groups and 0 pins the Agents list renders header-less (flat); with groups/pins present, section headers appear and order is Recent -> Pinned -> groups -> Agents.
- multi-presence duplicate rows: a pinned agent that also belongs to a group renders **twice** - assert both the Pinned row and the group row exist for the same agent.
- Recent visibility: hidden when `agentCount < 2` or no recent sessions; shown otherwise; shows 3 skeleton rows while roster loads.
- empty group renders the "Drag agents here" hint and is not auto-deleted.

**Acceptance criteria:**

- [ ] All listed section components exist and render via shadcn sidebar primitives.
- [ ] `DashboardSidebar` is a slim orchestrator; section order is Search -> Recent -> Pinned -> groups -> Agents; membership maps computed in `useMemo`.
- [ ] Every progressive-disclosure row in the matrix is honored (Recent hidden <2 agents/no sessions; Pinned hidden when empty; flat list when 0 groups & 0 pins; empty-group hint; skeletons; warnings console-only).
- [ ] Unknown paths are filtered at render, config is never pruned on write.
- [ ] Rendering-matrix tests pass, including the multi-presence duplicate-rows assertion.
- [ ] Client typecheck and lint pass; FSD layer rules respected (imports via barrels only).

---

### Task 2.3: Build unified AgentRowMenuItems and wire into row context + dropdown menus

**Size:** medium · **Priority:** high · **Dependencies:** 1.4 · **Parallel with:** none

Fix the prior spec's dual-menu drift landmine: define agent-row menu items ONCE and render them into both the Radix ContextMenu (right-click) and DropdownMenu ("...") variants. New file `apps/client/src/layers/features/dashboard-sidebar/ui/AgentRowMenuItems.tsx`.

**Component:** A single item-definition component that renders the SAME item list into both menu variants. The Radix `ContextMenu` and `DropdownMenu` use different primitive components for items/submenus, so parametrize the variant (e.g. an `as`/`variant` prop or slot components) but keep ONE source of item definitions - there must be no second, hand-copied list.

**Items (identical in both variants):** Existing agent-row items (preserve whatever the current row menu has) PLUS:

- `Pin` / `Unpin` (toggles based on whether the agent's path is in `ui.sidebar.pinned`; uses `pinPath`/`unpinPath` via `useUpdateSidebarPrefs`).
- `Move to group >` submenu:
  - a checkmark on the agent's current group (if any),
  - `Remove from group` (shown only when the agent is currently in a group; calls `moveToGroup(prev, path, null)`),
  - a divider,
  - `New group...` (opens the inline group-create flow - wired in task 2.4).

**Wiring:** Wire `AgentRowMenuItems` into `AgentListItem.tsx` (the "..." DropdownMenu) and `AgentContextMenu.tsx` (the right-click ContextMenu), replacing their previously-duplicated item lists so both render from the shared definition.

**Tests:**

- Parity regression test: render `AgentRowMenuItems` in the ContextMenu variant and the DropdownMenu variant with the same props, and assert the two produce the **identical set of items/labels** (the drift-landmine regression guard).
- Pin/Unpin reflects membership in `pinned`; `Move to group` submenu shows the checkmark on the current group and shows `Remove from group` only when grouped.

**Acceptance criteria:**

- [ ] `AgentRowMenuItems` renders one shared item definition into both ContextMenu and DropdownMenu variants (no duplicated list).
- [ ] Items include existing row actions + Pin/Unpin + `Move to group >` submenu (current-group checkmark, `Remove from group` when grouped, divider, `New group...`).
- [ ] `AgentListItem` and `AgentContextMenu` both consume `AgentRowMenuItems`.
- [ ] Parity regression test asserts identical items across both variants and passes.
- [ ] Client typecheck and lint pass.

---

### Task 2.4: Build group CRUD flows: inline create, rename, delete dialog, and New-group entry points

**Size:** medium · **Priority:** high · **Dependencies:** 2.2, 2.3 · **Parallel with:** none

Wire up the full group create/rename/delete UX across the header, row menu, and hint CTA.

**Inline create (`GroupCreateInput.tsx`):** Inline create row: an input that commits on **Enter** and cancels on **Esc**. Validation: name must be **1-40 characters** (trimmed); empty or >40 is invalid and does not commit. On commit, call `createGroup(prev, name)` via `useUpdateSidebarPrefs`. New groups are created **expanded**.

**Inline rename (`GroupHeader.tsx`):** Group header "Rename" swaps the name label for an inline input (same Enter-commit / Esc-cancel / 1-40 char validation as create); on commit calls `renameGroup`.

**Delete with AlertDialog (non-empty groups):** Group header menu "Delete group":

- **Empty group**: deletes immediately (trivially reversible), calling `deleteGroup`.
- **Non-empty group**: opens a shadcn `AlertDialog` before deleting. Copy (verbatim):
  - title: `Delete group "{name}"?`
  - body: `Its N agents move back to Agents. Nothing is deleted.` (N = member count)
  - confirm button: `Delete group`
  - On confirm, call `deleteGroup`; members implicitly return to the ungrouped "Agents" list.

**Group header "Sort by" and menu:** The group header "..." menu (and its right-click ContextMenu, at parity) contains: `Rename`, `Sort by >` (Manual / Recent activity / Name, radio - calls `setGroupSortMode`), `Delete group`. Section headers have full ContextMenu parity with their "..." menu.

**"New group" entry points (all three):**

- The sidebar header "+" menu: `AddAgentMenu.tsx` gains a `New group` item that opens the inline create.
- The `Move to group > New group...` submenu item (from `AgentRowMenuItems`, task 2.3) opens inline create AND moves that agent into the new group on commit.
- The hint card CTA (task 3.3) `New group` button opens inline create.

**Tests:**

- Inline create validation: Enter with a 1-40 char name commits (calls `createGroup`); empty or >40 char does not commit; Esc cancels without creating.
- Inline rename: commits via `renameGroup`; Esc cancels.
- Delete: empty group deletes immediately (no dialog); non-empty group opens the AlertDialog with the exact title/body/confirm copy, and confirming calls `deleteGroup`.
- `New group` from the `AddAgentMenu` "+" menu opens the inline create input.

**Acceptance criteria:**

- [ ] Inline create commits on Enter, cancels on Esc, validates 1-40 chars, creates an expanded group.
- [ ] Inline rename works with the same key/validation behavior.
- [ ] Empty-group delete is immediate; non-empty-group delete shows the AlertDialog with exact copy and returns members to Agents on confirm.
- [ ] `Sort by >` radio wires to `setGroupSortMode`; header menu has ContextMenu parity.
- [ ] All three `New group` entry points (header "+", Move-to-group submenu, hint CTA) open the inline create.
- [ ] Group-CRUD tests pass; client typecheck and lint pass.

---

### Task 2.5: Add collapsed-group activity rollup with single aggregated subscription

**Size:** small · **Priority:** medium · **Dependencies:** 2.2 · **Parallel with:** none

A collapsed group header shows a small activity dot when any member agent currently has active work. Implement with a SINGLE aggregated subscription - explicitly NOT one subscription per hidden member (perf landmine at 100+ agents flagged by the prior spec).

**Hook (`entities/session/model/use-agents-aggregate-status.ts`):** Add `useAgentsAggregateStatus(paths: string[])` beside the existing `useAgentHottestStatus` (`apps/client/src/layers/entities/session/model/use-agent-hottest-status.ts`), reading from the same status store. Use a **single aggregated subscription** with `useShallow` set-comparison so it does not resubscribe per member. It returns whether ANY of the given `paths` currently has active work (one boolean / aggregated status), computed in O(1) subscriptions regardless of member count.

**Wiring (`GroupHeader.tsx` / `AgentGroupSection.tsx`):** When a group is collapsed, render a small activity dot in the header when `useAgentsAggregateStatus(group.agentPaths)` reports active work. When expanded, the per-row status indicators already cover it (no header dot needed).

**Tests:**

- `useAgentsAggregateStatus` returns true when any member path is active, false when none are; changing which paths are active flips the result.
- Uses a single subscription (assert it does not create one subscription per path - e.g. verify via the store-subscription mock that subscription count is independent of `paths.length`).
- GroupHeader renders the dot only when collapsed AND a member is active.

**Acceptance criteria:**

- [ ] `useAgentsAggregateStatus(paths)` exists beside `useAgentHottestStatus`, single aggregated subscription with `useShallow`, O(1) in member count.
- [ ] Collapsed group header shows the activity dot iff a member agent has active work.
- [ ] Tests confirm aggregate correctness and single-subscription behavior.
- [ ] Client typecheck and lint pass.

---

### Task 2.6: Delete dead RecentAgentItem, final DashboardSidebar slimming, barrel audit

**Size:** small · **Priority:** medium · **Dependencies:** 2.2 · **Parallel with:** none

Remove dead code and finish the extraction cleanup for the dashboard-sidebar feature.

**Delete dead code:**

- Delete `apps/client/src/layers/features/dashboard-sidebar/ui/RecentAgentItem.tsx` and its test file (`__tests__/RecentAgentItem.test.tsx` or equivalent). It has zero non-test consumers (dead code, confirmed in ideation Codebase Map).
- Remove any barrel export of `RecentAgentItem` from the feature index.

**Final DashboardSidebar slimming pass:** With all section components extracted (task 2.2) and CRUD/menus wired (2.3-2.5), do a final pass on `DashboardSidebar.tsx` so it is purely an orchestrator: data wiring, section composition, and the migration effect - no leftover inline section markup, no dead imports, no commented-out code. The original file was 395 lines; it should now be substantially smaller.

**Barrel exports audit:** Audit `apps/client/src/layers/features/dashboard-sidebar/index.ts` (and any nested barrels): export only what is consumed externally; remove exports for internal-only components; ensure all cross-layer imports go through barrels (FSD rule). Run `pnpm knip` (after building dists) to confirm no dead exports remain from the refactor.

**Tests:** Confirm the `RecentAgentItem` test is deleted and the suite still passes. No new test needed for the barrel audit; rely on `pnpm knip` + typecheck + lint.

**Acceptance criteria:**

- [ ] `RecentAgentItem.tsx` and its test are deleted; no remaining references or barrel exports.
- [ ] `DashboardSidebar.tsx` is a slim orchestrator with no leftover inline section markup or dead imports.
- [ ] Feature barrel exports only externally-consumed symbols; `pnpm knip` reports no new dead code.
- [ ] Client typecheck and lint pass; full sidebar test suite green.

---

## Phase 3: Drag-and-drop & polish

### Task 3.1: Add dnd-kit, build SidebarDnd and use-sidebar-dnd drop-semantics reducer

**Size:** large · **Priority:** high · **Dependencies:** 2.2, 2.3, 2.4 · **Parallel with:** none

Add the drag-and-drop layer over the section list. Introduces the repo's first dnd dependency.

**Dependencies (`apps/client`):** Add `@dnd-kit/core` + `@dnd-kit/sortable` to `apps/client`. These are new to the repo (verified: no dnd library installed anywhere). `KeyboardSensor` implements the WCAG 2.2 §2.5.7 keyboard protocol (Space pick up / arrows move / Space drop / Esc cancel) with ARIA live-region announcements.

**`SidebarDnd.tsx` (`features/dashboard-sidebar/ui/`):** Wraps the section list in a dnd-kit `DndContext`:

- Sensors: `PointerSensor` with `activationConstraint: { distance: 8 }` (so a click/expand still wins over a drag) + `KeyboardSensor`.
- `DragOverlay` renders the dragged row.
- Valid drop targets get a visible ring using the `focus-ring` token when hovered/targeted.
- ARIA announcements via dnd-kit's `announcements` config, worded per operation (e.g. "Moved api-server to group Clients").

**`use-sidebar-dnd.ts` (`features/dashboard-sidebar/model/`):** A PURE drop-semantics reducer plus dnd-kit event handlers. Given a drag source and drop target, it maps to the correct `useUpdateSidebarPrefs` helper call. Implement the FULL semantics table verbatim:

| Drag                                     | Drop target                        | Effect                                                                                           |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Group header                             | between other group headers        | reorder `groups` array (`reorderGroup`)                                                          |
| Agent row (ungrouped or in a group)      | group body or **collapsed** header | membership move (`moveToGroup`); appended at end (or drop index if the target group is `manual`) |
| Agent row (ungrouped or in a group)      | Pinned section                     | `pinPath` (reference added; home membership unchanged)                                           |
| Agent row inside a `manual` group        | within same group                  | reorder `agentPaths` (`reorderWithinGroup`)                                                      |
| Agent row inside a `name`/`recent` group | within same group                  | no reorder (sort mode owns order); drag out/into other targets still works                       |
| Pinned row                               | within Pinned                      | reorder `pinned` (`reorderPinned`)                                                               |
| Pinned row                               | anywhere outside Pinned            | `unpinPath` (Finder drag-out gesture; membership untouched)                                      |
| Agent row in a group                     | Agents (ungrouped) section         | remove from group (`moveToGroup(prev, path, null)`)                                              |

Sessions are never draggable.

**Reducer unit tests (`__tests__/use-sidebar-dnd.test.ts`):** Cover EVERY row of the table above, including:

- no-op drops (drop onto the same position; drop of a `name`/`recent` group row within its own group = no reorder).
- unknown/invalid targets (drop with no valid target = no state change).
- membership move appends at end for non-manual target groups, uses drop index for `manual` target groups.
- drag out of Pinned anywhere-outside triggers `unpinPath` and leaves home membership untouched.

Test at the reducer level, NOT via synthetic pointer events (repo rule).

**Acceptance criteria:**

- [ ] `@dnd-kit/core` + `@dnd-kit/sortable` added to `apps/client`.
- [ ] `SidebarDnd` provides `DndContext` with PointerSensor (distance 8) + KeyboardSensor, DragOverlay, drop-target rings, and per-operation ARIA announcements.
- [ ] `use-sidebar-dnd.ts` pure reducer implements every row of the semantics table, mapping to the correct prefs helper.
- [ ] Reducer unit tests cover every table row plus no-op and unknown-target cases and pass.
- [ ] Client typecheck and lint pass.

---

### Task 3.2: Accessibility pass: dnd announcements, keyboard sorting, focus-visible, mobile menu-only

**Size:** medium · **Priority:** high · **Dependencies:** 3.1 · **Parallel with:** none

Complete the WCAG 2.2 §2.5.7 accessibility story: every drag operation has a single-pointer (menu) and keyboard path, and all new interactive elements are keyboard- and screen-reader-usable.

**dnd ARIA announcements per operation:** Refine dnd-kit's `announcements` config so each operation produces a clear live-region message: pick up, move over a target, drop ("Moved api-server to group Clients"), and cancel. Announcements must be specific per operation type (reorder group, move to group, pin, unpin, remove from group, reorder within group).

**Keyboard sorting flows:** Verify the `KeyboardSensor` protocol works end to end: Space picks up a row, arrow keys move it between valid targets, Space drops, Esc cancels. Keyboard covers sorting (reorder within a section and across groups); moves are also reachable via the menus (`Move to group`, `Pin`/`Unpin`) for full single-pointer coverage.

**Focus-visible states:** Ensure `focus-visible` states on ALL new interactive elements: group headers, sort/"..." menu triggers, inline create/rename inputs, `Move to group` submenu items, RecentSessionRow, pin toggles, hint card CTA/dismiss. Use the design-system focus-ring token.

**Mobile (Sheet) verification:** On mobile the sidebar is a `Sheet`; drag is disabled (touch drag conflicts with scroll). Verify that the **long-press context menu** covers ALL operations (move to group, pin/unpin, remove from group, rename/delete/sort on headers) so there is no mobile-only dead end. Confirm no drag handlers are active in the mobile Sheet.

**Tests:**

- Announcement wording test: each operation type produces the expected announcement string (test dnd-kit `announcements` callbacks directly).
- Keyboard: assert new interactive elements are focusable and expose correct roles/labels (jsdom RTL); menus reachable by keyboard.
- Mobile: assert drag is disabled and the long-press menu exposes the full operation set in the Sheet variant.

**Acceptance criteria:**

- [ ] Per-operation ARIA announcements are specific and correct for every drag operation.
- [ ] Keyboard sorting (Space/arrows/Space/Esc) works; every drag operation also has a menu path.
- [ ] All new interactive elements have visible `focus-visible` states using the focus-ring token.
- [ ] Mobile Sheet has drag disabled and the long-press menu covers every operation.
- [ ] Accessibility tests pass; client typecheck and lint pass.

---

### Task 3.3: Build GroupsHintCard, group empty-state, and motion polish

**Size:** medium · **Priority:** medium · **Dependencies:** 2.2 · **Parallel with:** none

Add the discovery affordance and finishing motion polish.

**`GroupsHintCard.tsx` (`features/dashboard-sidebar/ui/`):** A one-time dismissible hint card, shown ONLY when `agentCount >= 8 && groups.length === 0 && !ui.sidebar.groupsHintDismissed`. Content: heading "Group your agents", a one-line how-to, a `[New group]` CTA (opens the inline create, per task 2.4), and a dismiss X. Dismissing sets `groupsHintDismissed: true` via `useUpdateSidebarPrefs` (persisted; never shown again). Copy follows the `writing-for-humans` voice (plain, no hype).

**Group empty-state:** A group with only-unknown or no member paths renders a quiet empty hint "Drag agents here" (persisted, never auto-deleted). Ensure this reads well and is styled calmly (this was scaffolded in task 2.2; finalize its visual here).

**Motion polish:** Add `AnimatePresence` on section/row transitions (group create/delete, section collapse/expand, row enter/leave, hint card mount/dismiss) using `motion/react`, consistent with the existing `AnimatePresence` variants already used in the sidebar. Do not invent new easings/durations - reuse the existing variant tokens so motion feels like one system.

**Tests:**

- Hint card threshold: shown at >=8 agents & 0 groups & not dismissed; hidden below 8 agents, when a group exists, or when dismissed. Dismiss sets `groupsHintDismissed` and hides it.
- Empty-state hint renders for an empty/only-unknown group.

**Acceptance criteria:**

- [ ] `GroupsHintCard` shows only at >=8 agents with 0 groups and not dismissed; CTA opens inline create; dismiss persists `groupsHintDismissed`.
- [ ] Group empty-state "Drag agents here" renders calmly and is never auto-deleted.
- [ ] Motion uses `AnimatePresence` consistent with existing sidebar variants (no new easings/durations).
- [ ] Hint-threshold and empty-state tests pass; client typecheck and lint pass.

---

### Task 3.4: Changelog fragment, configuration docs verification, sidebar guide, dev-playground assessment

**Size:** small · **Priority:** medium · **Dependencies:** 2.4, 2.5, 2.6, 3.1, 3.2, 3.3 · **Parallel with:** none

Final documentation and release-prep pass.

**Changelog fragment:** Create `changelog/unreleased/<id>-agent-sidebar-groups.md` where `<id>` is a fresh timestamp id from `.claude/scripts/id.ts` (`YYMMDD-HHMMSS`), filename `<id>-agent-sidebar-groups.md`. Write it in the `writing-for-humans` voice (plain enough for a smart 9th grader who does not code). Cover, in user-facing terms:

- named groups for your agents (create, rename, delete, drag to organize),
- pinned agents now also stay in their group (multi-presence),
- a new "Recent" section: your latest sessions across all agents, one click to resume,
- organization now syncs across every device/browser signed into the instance.
- Under a **Changed** heading, note the **removal of the auto-pin of the default agent** (small fleets now render as a clean flat list; describe it as "we no longer auto-pin your default agent"). Do NOT edit `CHANGELOG.md` directly (fragments compile at release).

**Configuration docs verification:** Verify `contributing/configuration.md` has the `ui.sidebar` field-table row and the `backfillSidebarDefaults` migration entry (added in task 1.1). Fix any drift so the docs match the shipped schema exactly.

**Sidebar guide (docs/):** If a `docs/` cockpit or sidebar guide page exists (Fumadocs MDX), add a short "Organize your agents" section covering groups, pinning, and the Recent section. If no such guide exists, note that in the completion report and skip (do not create a new top-level guide unprompted).

**Dev-playground candidacy assessment:** Assess whether the new sidebar components (section components, `GroupsHintCard`, `GroupCreateInput`, group header states) belong in the Dev Playground (`apps/client/src/dev/`), per the `maintaining-dev-playground` skill. If they are good showcase candidates (stateful, visually distinct), add or update a showcase; otherwise record the assessment decision in the completion report.

**Acceptance criteria:**

- [ ] Changelog fragment created in `changelog/unreleased/` with a fresh timestamp id, `writing-for-humans` voice, covering groups/pinned-multi-presence/Recent/sync, and noting the auto-pin removal under Changed. `CHANGELOG.md` not edited directly.
- [ ] `contributing/configuration.md` verified to match the shipped `ui.sidebar` schema and migration.
- [ ] docs/ sidebar guide updated if one exists (or explicit note that none exists).
- [ ] Dev-playground candidacy assessed and acted on (showcase added or decision recorded).
