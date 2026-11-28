/**
 * What the space side hands the computer side's read surfaces at startup
 * (spec `computer-side-starts-alone` §5.12, I7's resolvers).
 *
 * Each surface on the computer side produces its list or stream unfiltered
 * and reads who may see it, and what only the space side holds, through a
 * slot it owns. This step fills those slots from the space side's own rules,
 * the way `setQueuedChatView` is filled. Each slot's unset answer is
 * fail-closed (the operator alone hears, nothing is read, nothing moves), so a
 * surface used before this runs shows less, never more.
 *
 * @module startup/space-views
 */
import { isPersonPrincipal } from '../lib/caller-principal.js';
import { operatorAudience } from '../services/notifications/notification-entitlement.js';
import { projectRegistry } from '../services/projects/project-registry.js';
import { moveRunSessions } from '../services/tasks/session/active-run-sessions.js';
import { moveBeatChats } from '../services/heartbeats/heartbeat-store.js';
import { setSessionListSpaceView } from '../services/session/catalog/session-list-space-view.js';
import { setChatRowsPort } from '../services/session/chat-rows/chat-rows-port.js';
import { computerChatRows } from '../services/session/chat-messages/computer-chat-rows.js';
import type { ChatMessageStore } from '../services/session/chat-messages/chat-message-store.js';
import { setScheduledChatMoves } from '../services/session/origin/rekey-moves.js';
import { deliverSessionStream } from '../services/core/streams/screen/session-stream-delivery.js';
import {
  watchSessionRelaySwitch,
  wireSessionRelay,
  type SessionRelayWiring,
} from '../services/core/session-relay/index.js';
import { remoteAccessOn } from '../middleware/remote-access-switch.js';

/**
 * Hand the session-list stream who may hear about each session, and which
 * project a folder belongs to.
 *
 * Every person, about every session: on this computer every caller that is not
 * an agent reads as its owner, who reads every chat (`routes/audit-reader.ts`),
 * and only a person reads the stream (DOR-4986). Anything else is refused, so
 * the rule stays closed if another kind of reader ever reaches it.
 */
export function wireSessionListSpaceView(): void {
  setSessionListSpaceView({
    audience: () => isPersonPrincipal,
    projectOf: (cwd) => projectRegistry.peek(cwd),
  });
}

/**
 * Hand the computer side its view of the chat-message rows: a rekey carries
 * them, and a Claude Code history reads the stops other chats made.
 *
 * @param store - The chat-message store startup just wired.
 */
export function wireChatRowsPort(store: ChatMessageStore): void {
  setChatRowsPort(computerChatRows(store));
}

/**
 * Hand the session rekey how a scheduled chat's rows move with it: the task
 * run's and the beat's (DOR-3703).
 */
export function wireScheduledChatMoves(): void {
  setScheduledChatMoves((db, fromId, toId) => {
    moveRunSessions(db, fromId, toId);
    moveBeatChats(db, fromId, toId);
  });
}

/**
 * Wire the session relay: the owner's own DorkOS on the web is answered with
 * the same origin lookups and room port the session routes use, so a room
 * turn, a task run or a beat reads the same there as here (spec
 * `everything-is-a-space` B2), read per request and never copied. The space
 * side hands it the session stream and who may hear its presence. Switching
 * Chat from the web off closes a live relay at once.
 *
 * @param pieces - Mesh, the origin lookups and the room port.
 */
export function wireSessionRelayStep(
  pieces: Pick<SessionRelayWiring, 'meshCore' | 'origins' | 'roomSessionPlace'>
): void {
  wireSessionRelay({
    ...pieces,
    remoteAccessOn,
    deliverSessionStream,
    ownerAudience: operatorAudience,
  });
  watchSessionRelaySwitch();
}
