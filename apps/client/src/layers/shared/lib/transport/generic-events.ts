/**
 * The broadcast names the unified `/api/events` stream forwards to generic
 * subscribers. `StreamManager` dispatches each of these to
 * `subscribeEvent`; a name missing here is silently dropped, so add new
 * events as the server emits them.
 *
 * @module shared/lib/transport/generic-events
 */

/** Broadcast names forwarded from the unified events stream to subscribers. */
export const GENERIC_EVENTS = [
  'connected',
  'tunnel_status',
  'extension_reloaded',
  'commands_changed',
  'relay_connected',
  'relay_message',
  'relay_backpressure',
  'relay_signal',
  'relay_bindings_changed',
  'relay_adapters_changed',
  'relay_flow',
  'relay_dead_letter',
  // A NEW unclaimed chat was recorded (connection-scoping spec
  // `specs/connection-scoping/` §Part 3) — fired once per chat, damped, so a
  // spammy stranger never re-fires it. No UI subscribes yet (DOR-857 wires
  // the claim-feed cards); listed here so the event reaches dispatch instead
  // of being silently dropped once that surface exists.
  'relay_chat_unclaimed',
  // Individual `relay_chat_unclaimed` broadcasts were rate-limited this
  // window (adversarial review MAJOR 4) — fired at most once per window so a
  // burst of strangers messaging a public bot is visible as "a burst
  // happened," not silently dropped once past the cap. No UI subscribes yet.
  'relay_chat_unclaimed_burst',
  'task_run_failed',
  // A finished run's output grew: its agent reported back after the run's own
  // turn ended (DOR-2717). The run list re-reads on it.
  'task_run_updated',
  // How much of one account is used changed (spec `claude-account-fleet` D2):
  // payload `AccountUsage`, throttled per account on the server. The session
  // stream binding applies it to every open session on that account (§6 U).
  'account_usage',
  // A task definition changed (created, edited, deleted). The standing
  // unattended-autonomy banner reads it: a task dialled up to Full autonomy has
  // to raise the banner as the form closes, not on the next page load.
  'tasks_changed',
  // An agent was paused everywhere or its pause was lifted (spec `audit-trail`
  // PR5). A stamp only: the paused badges re-read the list on it.
  'agent_pauses_changed',
  'mesh_liveness_changed',
  'approval_pending',
  'approval_resolved',
  // An agent asked the owner for an app, or one of those requests was answered,
  // expired or failed (DOR-2415). A stamp only: the chat card, the room card and
  // the Connections page's Needs you strip re-read their owner-scoped list on it,
  // so answering in one window retires the card in every other.
  'connector_agent_requests_changed',
  // A running extension's tools joined or left the capability registry
  // (DOR-2685). A counter only: the permissions page re-reads its list on it,
  // so a tool an extension adds shows up, and one it takes away goes, live.
  'capabilities_changed',
  // A blocking condition began or stopped standing (DOR-1570). A standing kind
  // stores no row while it stands, so these are the only live news that a
  // schedule was proposed or an approval is waiting — which is what the desktop
  // shell draws its native banner from. No app surface subscribes: the app
  // already derives both from state it holds (the tasks query, and
  // `approval_pending`). Listed so the event reaches dispatch rather than being
  // silently dropped the day a surface does want it.
  'standing_pending',
  'standing_resolved',
  // An agent is parked on something only a person can answer — a tool approval,
  // a question, or an MCP elicitation — and the answer is wanted from wherever
  // the reader happens to be, not only inside that session. Raised once when the
  // prompt appears and once when it is answered, cancelled or times out; the
  // countdown in between is local, ticked from the start time inside the
  // interaction. See `specs/unified-conversation` §3.
  'interaction_pending',
  'interaction_resolved',
  // Rooms (spec `rooms`, ADR 260726-170125). The ENTRIES of a room ride that
  // room on its own durable stream (`/api/rooms/:id/events`); these seven are
  // the global signals for a reader NOT connected to it — the room list
  // changing, an activity bump that reorders the list and marks a room unread,
  // the count of agents working in it, and a read cursor moving.
  'room_created',
  'room_updated',
  'room_member_added',
  'room_member_removed',
  'room_activity',
  // A room has agents working in it, or has stopped having them. Ephemeral and
  // claim-time, where `room_activity` above is durable and entry-time — which is
  // exactly why it is a sixth name rather than a payload field on the fifth.
  'room_presence',
  // Somebody moved their read cursor — the same person on a second device, most
  // of the time. One event for every kind of thread a person reads (a room, an
  // agent session, the inbox), so a subscriber filters on `threadKind` rather
  // than listening for a name per surface. A cursor in a room carries the unread
  // count the list should now draw, which is what lets a badge cleared on one
  // screen clear on the other without waiting for a poll.
  'read_cursor',
  // The whole session list is stale — drop it and refetch (spec
  // `claude-code-accounts` D5). Emitted when the Claude accounts move: the
  // restarted watcher upserts sessions from the roots it now watches but never
  // removes the ones it stopped watching, so without this a sidebar keeps
  // showing the union of the old and new account sets until a reload.
  'session_list_invalidated',
  // The Inbox (spec `notification-system`). One upsert event carrying a whole
  // notification, and one saying which ones were marked read so a badge cleared
  // on the laptop clears on the phone. Both are ADDRESSED: they carry what an
  // agent is doing and what is waiting on a person, so an agent principal
  // receives neither.
  'notification',
  'notification_read',
  // An agent was registered, renamed or removed, by any path that reaches the
  // mesh registry — the routes, the `mesh_register`/`mesh_unregister` tools,
  // `create_agent`, a marketplace install, an agent editing itself, or the
  // reconciler adopting a manifest it found on disk. `useAgentsSync`
  // (entities/mesh) reads it and refreshes the agent caches, so a registration
  // shows up in every open window instead of waiting out a 30-second stale time
  // (DOR-2052). Names and ids only — no directory, no manifest; the hook
  // invalidates and refetches rather than reading the payload at all.
  'agents_changed',
  // Settings were written — `PATCH /api/config`, `dorkos config set`, an
  // agent's `config_patch`. `useConfigSync` (entities/config) reads it and
  // re-reads the config, which is what makes the sidebar's sections, pins and
  // order follow a change made in another window. ADDRESSED like the two
  // `notification` events above: settings are a person's surface. The payload
  // carries the SECTION NAMES only — never a value, because config holds
  // credentials.
  'config_changed',
  // A Community connection was added, connected, told to reconnect, or
  // removed — most urgently because the person left the Community or was
  // removed from it. `useCommunityConnectionsSync` (entities/community)
  // refetches the owner-scoped connection list, and the app-level revocation
  // watcher erases and routes away from an ended Community, in seconds rather
  // than on the next 30-second poll. ADDRESSED and CONTENT-FREE: a stamp only,
  // because this stream cannot tell one local owner's windows from another's.
  'community_connections_changed',
  // An edit in a dev-linked folder was acted on (DOR-2696, spec
  // `marketplace-dev-link` §6): which package, what reloaded, and any build
  // error. `useDevLinkReloadSync` (entities/marketplace) keeps it for the
  // Installed row ("Reloaded 4s ago", or that it couldn't reload) and refreshes
  // the installed, dev link and extension lists. ADDRESSED like
  // `config_changed`: it names folders, so no agent receives it.
  'marketplace_dev_link_reloaded',
  // Whether DorkOS is keeping this computer awake, and for what (spec
  // `keep-awake`): the whole status, pushed on every change, coalesced to at
  // most two a second. `useKeepAwakeSync` (entities/keep-awake) writes it
  // straight into the query cache the top-bar cup and Settings read. Counts
  // only; nothing in it names a session.
  'keep_awake_status',
] as const;

/** A member of {@link GENERIC_EVENTS}. */
export type GenericEventName = (typeof GENERIC_EVENTS)[number];
