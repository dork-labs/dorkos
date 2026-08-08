/**
 * Room view widget — a room's history at `/channels` (spec `rooms` §7).
 *
 * @module widgets/room-view
 */
export { ChannelsPage } from './ui/ChannelsPage';
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
 * The thread side panel and its "N replies" row under a thread root, exported
 * for the Dev Playground's thread bench (`/dev/rooms`) for the same reason
 * `RoomEntryRow` is: the playground renders the real components, never a copy
 * of their markup. Nothing in the routed app imports them from here — the
 * room view mounts both itself.
 */
export { RoomThreadPanel } from './ui/RoomThreadPanel';
export { RoomThreadReplyRow } from './ui/RoomThreadReplyRow';
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
 * Seeds "how each agent runs" for a subtree, exported for the Dev Playground's
 * identity bench — a mention pill's hover card reads it from context (see
 * `agent-info-context`), so a benched `RoomEntryRow` needs one above it or its
 * cards can only ever be shown bare. The routed app mounts
 * `RoomAgentInfoProvider` instead, which reads the real fleet.
 */
export { AgentInfoProvider } from './model/agent-info-context';
export type { RosterAgentInfo } from './lib/agent-details';
