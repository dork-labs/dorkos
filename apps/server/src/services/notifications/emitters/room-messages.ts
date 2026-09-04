/**
 * Turns a room entry into `dm.received` / `mention.received` (spec
 * `notification-system` task T11, DOR-1388).
 *
 * **The decision lives in the rooms domain, not here.** Whether an entry is "a
 * DM to the operator" or "a mention of the operator" depends on roster
 * membership, author kind, and the bridged-DM identity model — all rooms-domain
 * facts `room-service.ts`'s `writePost` already has in hand at the one seam
 * every post and every bridged inbound message passes through. This module only
 * shapes what the rooms domain already decided into the two `notify()` calls,
 * so the rooms domain does not have to know about tiers, previews, or the
 * registry.
 *
 * @module services/notifications/emitters/room-messages
 */
import { notify } from '../notification-service.js';

/** Longest a preview may run before it is cut, e.g. on a phone lock screen. */
const PREVIEW_MAX_CHARS = 120;

/** What one room entry is, as far as this module needs to know. */
export interface RoomMessageNotifyInput {
  roomId: string;
  /** The channel's title. Unused for a DM-only raise, but cheap either way. */
  roomName: string;
  entryId: string;
  /** The entry's room-local `seq` — carried so a read cursor can mark it read. */
  entrySeq: number;
  /** The mesh agent id, when the author is an agent. Absent for a human. */
  agentId?: string;
  /** The author's display name. */
  fromName: string;
  /** The entry's raw text — chat content, never tool input or output. */
  text: string;
  /**
   * Whether `room-service.ts` decided this entry is a DM to the operator: a
   * `kind: 'dm'` room that is genuinely a 1:1 with them, written by anyone but
   * them — an agent, or a real person on the far side of a bridged private chat
   * (see the `dm.received` registry entry for the full reasoning).
   */
  isDirectMessage: boolean;
  /** Whether the entry's resolved mentions name the operator. */
  mentionsOperator: boolean;
  /**
   * Whether the operator has muted this room. Consulted only for
   * `isDirectMessage` — `mentionsOperator` always notifies, mute or not.
   */
  roomMuted: boolean;
}

/**
 * Raise whichever of `dm.received` / `mention.received` this entry earned.
 *
 * Both `notify()` calls are fire-and-forget and never throw — the same
 * contract every other emitter in this directory holds itself to, so a
 * notification problem can never fail the post that produced it.
 *
 * @param input - What the entry is and what the rooms domain decided about it.
 */
export function notifyRoomMessage(input: RoomMessageNotifyInput): void {
  const preview = previewOf(input.text);

  if (input.isDirectMessage && !input.roomMuted) {
    void notify('dm.received', {
      roomId: input.roomId,
      entryId: input.entryId,
      entrySeq: input.entrySeq,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      fromName: input.fromName,
      preview,
    });
  }

  if (input.mentionsOperator) {
    void notify('mention.received', {
      roomId: input.roomId,
      entryId: input.entryId,
      entrySeq: input.entrySeq,
      roomName: input.roomName,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      fromName: input.fromName,
      preview,
    });
  }
}

/**
 * The first non-empty line of an entry's text, truncated to
 * {@link PREVIEW_MAX_CHARS} — glanceable on a desktop banner or a phone lock
 * screen, and never more than the opening of what was actually said.
 *
 * @param text - The entry's raw body text.
 */
function previewOf(text: string): string {
  const firstLine =
    text
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? '';
  if (firstLine.length <= PREVIEW_MAX_CHARS) return firstLine;
  return `${firstLine.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}
