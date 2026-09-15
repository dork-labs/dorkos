# Live agent list — specification

**Umbrella:** DOR-2051 · **Status:** specified 2026-09-15 · **Ideation:** [01-ideation.md](01-ideation.md)

## 1. Outcome

When an agent is registered, renamed or removed — by any path — every open DorkOS window shows the change within about a second, with no reload. When settings change, the sidebar's sections, pins and order follow the same way. Four DorkBot tooling gaps found in the same review are closed.

## 2. Part A — live agents and settings (DOR-2051 core)

### 2.1 Server: `agents_changed`

**Seam.** `packages/mesh/src/agent-registry.ts` is the one place every agent identity write lands (`upsert`, `update`, `remove`, `relocate`). Add an observer there, surfaced on `MeshCore` as `onAgentsChanged(cb)` next to `onUnregister` / `onLivenessChange` / `onAgentAdopted` (`packages/mesh/src/mesh-core.ts:275-312`). Fire it **after** the write commits, once per write, with `{ kind: 'registered' | 'updated' | 'removed', agentId, projectPath?, name?, displayName? }`.

- `upsert` of a new id → `registered`; `upsert` of an existing id, `update`, `relocate` → `updated`; `remove` → `removed`.
- `updateHealth`, `markUnreachable`, `markReachable` **must not** fire it (per-message writes; liveness already has `mesh_liveness_changed`). A test pins this.
- Callbacks are synchronous, throws logged and swallowed, never aborting the write (same contract as `onAgentAdopted`).

**Wire.** In `apps/server/src/index.ts`, next to the `onLivenessChange` wiring (~line 1791): `meshCore.onAgentsChanged(e => eventFanOut.broadcast('agents_changed', { ...e, changedAt }))`. Global audience. Names only, never the manifest body.

**Coverage proof.** A server test drives each mutation path through its real entry point and asserts one `agents_changed` per path: `POST /api/mesh/agents`, `PATCH /api/mesh/agents/:id`, `DELETE /api/mesh/agents/:id`, `POST /api/agents` (register), `agent-updater` self-edit (`PATCH /api/agents/current`), `MeshCore.syncFromDisk`, the reconciler adopting a manifest. The in-session `mesh_register`/`mesh_unregister` tools go through `MeshCore`, so they are covered by construction; assert it for one of them anyway.

### 2.2 Server: `config_changed`

`ConfigManager.onChange` (`apps/server/src/services/core/config-manager.ts:4651`) already reports `{ sections }` after any write (`set`, dotted-path set, reset). Add one subscriber in `index.ts`: `eventFanOut.broadcast('config_changed', { sections, changedAt }, operatorAudience)` — `operatorAudience` from `services/notifications/notification-entitlement.ts`, the same gate `notification` uses. **Payload carries section names only; a test asserts no value from the config reaches the payload.**

### 2.3 Allowlist, docs

- `apps/server/src/services/core/__tests__/sse-event-allowlist.test.ts` must pass: both names are added to `GENERIC_EVENTS` in `apps/client/src/layers/shared/lib/transport/stream-manager.ts` with a comment in the house style (why it exists, who subscribes).
- `docs/integrations/sse-protocol.mdx` global-events table gains two rows; `config_changed` is listed under the addressed events section (it becomes the fifth addressed event; update the "Four events go only to whoever they are about" heading and count).

### 2.4 Client: sync hooks

- `apps/client/src/layers/entities/mesh/model/use-agents-sync.ts` — `useAgentsSync()`: `useEventSubscription('agents_changed', …)`, coalesced (trailing 300–1200 ms, same shape as `usePulseFreshness`), invalidates `['mesh']`, `['agents']` (prefix — both `resolved` and `byPath`), `['team']` (`exact: true`, it is a prefix of member-rooms keys). Literal keys with the same cycle-avoidance comment `use-mesh-update.ts` carries.
- `apps/client/src/layers/entities/config/model/use-config-sync.ts` — `useConfigSync()`: on `config_changed` invalidate `configKeys.current()`, **unless** a config mutation is in flight (`queryClient.isMutating({ mutationKey: … })` — give `useUpdateConfig` / `useUpdateSidebarPrefs` a shared mutation key if they lack one) — then defer to its `onSettled`, which already invalidates.
- Mount both in `AppShell.tsx` beside `useTasksSync()`. Export through each entity barrel.
- Fix `use-mesh-unregister.ts`: also invalidate `['mesh','agent-paths']` and `['agents']`.
- Tests: hook tests with a fake stream (see `use-tasks-sync` tests and `stream-manager.test.ts`), asserting the exact key set, the coalescing, and the in-flight skip.

### 2.5 Browser proof (the bar)

An e2e or manual pass, recorded in the PR: open the app, register an agent through the API (`POST /api/mesh/agents`) from a terminal, and the row appears **without** any reload or focus change; rename it (`PATCH`), the row's name changes; delete it, the row disappears; patch `ui.sidebar` through `PATCH /api/config`, the section changes. Two windows open at once: both follow. Playwright spec under `apps/e2e` preferred; screenshots acceptable if the existing e2e harness cannot drive the second window.

### 2.6 Skill pack

`packages/operating-skills/src/skills/managing-agents.ts` (the pack is TypeScript strings, seeded by `seed.ts`; bump the version in `pack.ts`): after a register/rename/remove, the app updates on its own; never tell a person to refresh. The version bump in `pack.ts` is what makes an existing DorkBot re-seed.

## 3. Part B — DorkBot tooling gaps

### 3.1 `list_capabilities` accepts a call without `limit` (bug)

Reproduce first: through the in-session `dorkos` MCP server (`capability-mcp-tools.ts` → Agent SDK `tool()` with `capabilityInputShape`), call `list_capabilities` with `{}`. Expected: the default page. Observed 2026-09-15 on 0.75.1: `MCP error -32602 … limit: expected nonoptional, received undefined`. Find whether the default is lost in `capabilityInputShape`, in the Agent SDK's raw-shape wrapper, or in the JSON-schema round trip; fix at the cause, not with `.optional()` sprinkled on one field (check every capability input with a `.default`). Add a test that invokes the projected tool with `{}` for every capability whose schema has defaults.

### 3.2 `mesh_register` identity fields

In `apps/server/src/services/runtimes/claude-code/mcp-tools/mesh-tools.ts` (and the external server's projection of the same definition): add optional `displayName`, `icon` (single emoji), `color` (hex) and pass them through `registerByPath`'s `partial`. Fix the `name` description: it is the immutable slug used for the relay subject; say so, and derive a slug from a display name with spaces rather than storing "DorkOS Cloud" as a slug (reuse whatever `createAgentWorkspace` uses to slugify). The HTTP `RegisterAgentRequestSchema.overrides` already accepts these — no shared-schema change. Skill pack: mention the three fields.

### 3.3 Targeted sidebar-group capabilities

Two `act`-tier operator capabilities in `operator-capabilities.ts`, backed by the same validated write path as `config_patch`:

- `operator.sidebar_add_to_group { group: string (name or id), items: SidebarItemRef[], createIfMissing?: boolean }` — reads config fresh, finds the group by id then case-insensitive name, appends items not already present (`sameSidebarItem` from `@dorkos/shared/config-schema`), writes back the **whole `ui.sidebar` section** (the write contract). Membership is single-parent, so an item already in another manual group is **moved**: it is lifted out of every other group exactly as the client's `moveToGroup` does, and the groups it left come back as `movedFrom: [{ groupId, name }]`. Apart from those, every other group is untouched. Returns the group as saved.
- `operator.sidebar_remove_from_group { group, items }` — symmetric.

Person-only settings guard applies as for `config_patch`. Update `mcp-server.test.ts` tool counts and `tool-exposure.ts` if these should be visible by default (they should: DorkBot organising the sidebar is the "Ask DorkBot" use case). Skill pack: prefer these over `config_patch` for sidebar changes.

### 3.4 `feedback_draft` capability

`operator.feedback_draft { kind: 'bug' | 'feature' | 'runtime', title?: string, body?: string }`, tier `observe` (it sends nothing). Builds the same prefilled GitHub URL `dorkos feedback --print` builds — `packages/shared/src/feedback.ts` already exports `buildIssueUrl(report)` and the `FeedbackReport` shape; the CLI gathers its report in `packages/cli/src/commands/feedback.ts` (`gatherCliReport`) and the client in `apps/client/src/layers/shared/lib/build-issue-report.ts`. The capability gathers the server-side report (version, OS, runtimes, sanitised flags via `sanitizeFlags`) and calls the shared builder; do not add a third URL builder. Returns `{ url, filledFields }`. Skill pack (`packages/operating-skills/src/skills/answering-dorkos-questions.ts`): how to answer "can you file a bug" — draft it, show the link, never claim the CLI is off-limits.

## 4. Sequencing

| Wave           | Tasks                           | Why                                                                                                          |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1 (parallel)   | A (2.1–2.6), B1 (3.1), B2 (3.2) | Disjoint surfaces.                                                                                           |
| 2 (sequential) | B3 (3.3) then B4 (3.4)          | Both add operator capabilities and touch the tool-count tests; one in the queue at a time, the next stacked. |

## 5. Not done / follow-ups

- Obsidian embedded mode: no generic events by design; the sidebar there still relies on stale times.
- A `Transport`-level event for embedded mode is out of scope.
- `mesh_liveness_changed` stays a separate event; a future refactor could fold health into `agents_changed` with a `kind`, but the per-message write volume argues against it.
