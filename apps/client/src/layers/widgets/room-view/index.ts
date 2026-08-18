/**
 * Room view widget — a room's history (spec `rooms` §7).
 *
 * Two addresses, one widget: `/channels?id=` reads any room, and `/` reads
 * #team through the same {@link RoomSurface} (team-room-home spec D3.2). The
 * page components are addresses; the surface is the room.
 *
 * @module widgets/room-view
 */
export { ChannelsPage } from './ui/ChannelsPage';
/**
 * What a channel — and a DM, which is a channel by another name — can do. The
 * one table that says how this surface differs from the session's, read by the
 * `Conversation.Root` this widget mounts and by the Dev Playground's benches.
 */
export { DM_CAPABILITIES, ROOM_CAPABILITIES } from './model/room-capabilities';
/**
 * The room itself, exported so the app shell can render #team as the home tab.
 * A host contributes an address and the chrome above the feed — never a second
 * copy of a room.
 */
export { RoomSurface } from './ui/RoomSurface';
export type { RoomSurfaceProps } from './ui/RoomSurface';
/**
 * One row of a room's history, exported for the Dev Playground's entry-actions
 * bench (`/dev/entry-actions`) — the surface a reviewer eyeballs the hover
 * toolbar on. The playground's rule is that it renders the REAL component and
 * never a copy of its markup, and this row's toolbar is held in place by
 * layout the row itself owns, so a copy would be the one thing that cannot
 * catch a layout defect. Nothing in the routed app imports it from here.
 */
export { RoomEntryRow } from './ui/RoomEntryRow';
/**
 * The thread side panel, exported for the Dev Playground's thread bench
 * (`/dev/rooms`) for the same reason `RoomEntryRow` is: the playground renders
 * the real component, never a copy of its markup. Nothing in the routed app
 * imports it from here — the room view mounts it itself.
 */
export { RoomThreadPanel } from './ui/RoomThreadPanel';
/**
 * The row that holds a message between pressing Enter and the room echoing it
 * back, exported for the Dev Playground's delivery bench (`/dev/rooms`) — the
 * only place its two states can be reviewed on demand, since producing a real
 * one takes a slow link or a dead stream. Nothing in the routed app imports it
 * from here; the timeline and the thread panel mount it themselves.
 */
export { RoomPendingRow } from './ui/RoomPendingRow';
/**
 * The files posted with a message, exported for the Dev Playground's delivery
 * bench (`/dev/rooms`) for the same reason `RoomPendingRow` is: producing a
 * real one on demand means uploading a file into a room, and the case worth
 * eyeballing — a thumbnail beside a download chip beside a long filename — is
 * the one nobody has lying around. Nothing in the routed app imports it from
 * here; `RoomEntryRow` mounts it itself.
 */
export { RoomEntryAttachments } from './ui/RoomEntryAttachments';
/**
 * Seeds what a room knows about its agents — how each one runs, and the face
 * each one wears — for a subtree, exported for the Dev Playground's identity
 * bench. A mention pill's hover card reads it from context (see
 * `agent-info-context`), so a benched `RoomEntryRow` needs one above it or its
 * cards can only ever be shown bare. The routed app feeds it
 * `useRoomAgentDirectory`, which reads the real fleet.
 */
export { AgentInfoProvider } from './model/agent-info-context';
export type { RoomAgentDirectory } from './model/agent-info-context';
export type { RosterAgentInfo } from './lib/agent-details';
/**
 * The faces half of a {@link RoomAgentDirectory}, projected from its info half.
 *
 * Exported so a caller seeding the provider builds the two halves the way the
 * real hook does rather than rebuilding the map by hand — a hand-rolled one can
 * key faces differently from the info beside it, which is precisely the
 * divergence this directory exists to prevent.
 */
export { agentFacesByRef } from './lib/agent-details';
