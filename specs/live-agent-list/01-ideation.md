# Live agent list — ideation

**Umbrella:** DOR-2051 · **Project:** Live Agent List & DorkBot Tools · **Date:** 2026-09-15

## 1. The moment that started this

The operator pressed "Ask DorkBot" and asked it to register two sibling projects as agents and put them in a sidebar section. DorkBot did both (the `mesh_register` MCP tool, then `config_patch` on `ui.sidebar.groups`). Nothing in the sidebar changed. It changed only after Cmd+R. DorkBot even said "if they don't show up, refresh the page" — twice. Most people would not know to do that, and the ones who do would still be right to call it a bug.

## 2. What is actually wrong (traced, not guessed)

The app already has one live channel: the `/api/events` WebSocket, which the client's `StreamManager` reads and fans out by event name. The server broadcasts on it for sessions, rooms, tasks, relay traffic, approvals, notifications, tunnel status and mesh **liveness** (an agent going offline). It broadcasts **nothing** when:

- an agent is **registered, renamed, or removed** (any path: HTTP routes, the in-session and external `mesh_register` / `mesh_unregister` tools, `create_agent`, marketplace agent installs, the 5-minute reconciler adopting a `.dork/agent.json`, an agent editing itself through `update_agent`);
- **settings** are written (`PATCH /api/config`, the `config_patch` capability, the CLI's `dorkos config set`).

The sidebar draws its agent rows from `['mesh','agent-paths']` (30s stale) plus `['agents','resolved',…]` (60s), and its sections from `['config','current']` (30s). TanStack Query refetches a stale query only on window focus or a stream reconnect. Staying in one window means neither happens.

Consequences beyond DorkBot: a second window or the phone shows the old list; `dorkos agent register` from a terminal does nothing visible; the reconciler's adoption is invisible until a reload; and the app's own "remove agent" button likely leaves the row for up to 30s, because `use-mesh-unregister.ts` invalidates `['mesh','agents']` and `['team']` but not `['mesh','agent-paths']`, which is what the sidebar reads (to be confirmed in the browser during execute).

There is already a precedent for exactly this fix, twice over: `tasks_changed` (DOR-1380) exists because a schedule an agent proposed through `tasks_create` was invisible until reload, and `session_list_invalidated` exists because an account switch left the sidebar showing a stale union. Both are one broadcast on the server and one small `use*Sync` hook in `AppShell`.

## 3. What else the same transcript showed

Reviewing DorkBot's whole conversation surfaced four tooling gaps that belong in the same programme because they are what a person hits right after "add an agent":

1. **`list_capabilities` rejected two calls** with `Invalid arguments … limit: expected nonoptional, received undefined`, although `catalog-projection.ts` gives `limit` a Zod `.default`. A turn lost to plumbing, on the one tool that is supposed to find every other tool.
2. **`mesh_register` cannot set `displayName`, `icon` or `color`**, so the new agents got random emoji and colours. Its `name` parameter is described as "Display name override" but is written as the immutable slug, so "DorkOS Cloud" (with a space) became a slug.
3. **No targeted sidebar-group capability.** To add three items to one section the agent had to re-send the _entire_ `ui.sidebar.groups` array through `config_patch` (arrays replace wholesale). A drag in the UI at the same moment would have been silently lost, and a typo would have deleted every other section.
4. **Agents cannot draft feedback.** DorkBot said it was "not allowed to run the dorkos command"; no such rule exists, and `dorkos feedback --print` already prints the prefilled report link. A `feedback_draft` capability makes "report this" a one-turn answer and stops the guessing.

## 4. Who this is for

- **Kai** runs ten agents and registers new ones from whatever window is nearest. A list that lies until reload is a control panel he stops trusting.
- **Ikechi** directs agents in chat. When DorkBot says "done", the sidebar must agree, or he learns that DorkBot's "done" means nothing.
- **Priya** reads source before adopting. Two ad-hoc broadcasts bolted onto two routes would fail her review; one observer at the registry seam, mirroring the seams that already exist (`onUnregister`, `onLivenessChange`, `onAgentAdopted`), passes.

## 5. Options considered

| Option                                                                       | Verdict                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poll faster (drop stale times)                                               | No. Every window would hammer the server for a change that happens once an hour, and it still lags.                                                                                                                                                                                           |
| Broadcast from each route/tool that mutates agents                           | No. Seven call sites today; the eighth forgets. The reconciler and marketplace paths have no route at all.                                                                                                                                                                                    |
| **One observer at the mesh registry seam + one on `configManager.onChange`** | **Yes.** Every write path, present and future, passes through `AgentRegistry` (`upsert`/`update`/`remove`/`relocate`) and through `ConfigManager` (which already has `onChange` carrying section names). Two broadcasts, two sync hooks.                                                      |
| Carry the full new agent/config in the event payload                         | No. The client already knows how to refetch; a payload copy is a second source of truth that drifts. Names and ids only. `config_changed` carries **section names, never values**: config holds secrets.                                                                                      |
| Make `config_changed` a global broadcast                                     | No. Settings are a person's surface; agents connected to `/api/events` do not need to know a person changed their sidebar. Address it with the existing `operatorAudience`, like `notification`. `agents_changed` stays global: an agent's own roster changing is legitimate news for agents. |

## 6. Settled decisions (do not re-derive)

1. Two new event names: `agents_changed` and `config_changed`. Both go on `GENERIC_EVENTS` in `stream-manager.ts` **and** pass `sse-event-allowlist.test.ts`; both get a row in `docs/integrations/sse-protocol.mdx`.
2. `agents_changed` fires from a `MeshCore.onAgentsChanged` observer fed by the registry's identity writes only. Health and liveness writes (`updateHealth`, `markUnreachable`, `markReachable`) must **not** fire it: they happen on every message and already have `mesh_liveness_changed`.
3. `config_changed` fires from `configManager.onChange`, payload `{ sections: string[], changedAt }`, `operatorAudience`.
4. Client: one hook per entity, mounted in `AppShell` beside `useTasksSync`: `useAgentsSync` invalidates `['mesh']`, `['agents']`, `['team']` (exact prefixes, coalesced like `usePulseFreshness`); `useConfigSync` invalidates `configKeys.current()` when `sections` includes `ui` (or any section — the query is one object; keep it simple and invalidate on any section).
5. The client's own optimistic sidebar writes stay as they are. A broadcast lands after the server write, so a refetch it triggers returns the post-write state. The hook skips the refetch while a config mutation is in flight (`queryClient.isMutating` on the config mutation key) so a rapid drag sequence cannot see its own tail reverted.
6. The four tooling gaps are separate tasks, separate PRs, sequenced on the operator-capabilities surface (its tests count tools).
7. Obsidian embedded mode gets no generic events. Documented, accepted, unchanged.
8. DorkBot's skill pack (`packages/operating-skills`) gets one sentence: the app updates live, never tell a person to refresh; and one on how to draft feedback.
