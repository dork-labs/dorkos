/**
 * Whether a committed entry earns the operator a notification, and of which
 * kind (spec `notification-system` task T11, DOR-1388, DOR-1392).
 *
 * Its own seam because the question is about the ROOM's shape rather than
 * about the write: a 1:1 with the operator, or an `@` that names them. Called
 * after the entry and its broadcast are already durable, and it never throws —
 * a notification is the least important thing a post does.
 *
 * @module server/services/rooms/messages/room-message-notifier
 */
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import { notifyRoomMessage as emitRoomMessageNotification } from '../../notifications/emitters/room-messages.js';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import type { RoomCore } from '../service/room-core.js';
import type { RoomAgentLookup } from '../room-errors.js';
import type { RoomStore } from '../room-store.js';

/** The one place a room entry is weighed against the operator's attention. */
export class RoomMessageNotifier {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  /** The mesh agent table, read only to resolve a posting agent's `agents.id`. */
  private readonly agents: RoomAgentLookup;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;
  /** The record-based twin of {@link RoomMessageNotifier.isOwnerAuthor}. */
  private readonly isOwnerRecord: (record: AuthorRecord) => boolean;
  /** Whether the operator has muted a room. Read per post, never captured. */
  private readonly isRoomMuted: (roomId: string) => boolean;

  constructor(core: RoomCore) {
    this.store = core.store;
    this.authors = core.authors;
    this.agents = core.agents;
    this.isOwnerAuthor = core.isOwnerAuthor;
    this.isOwnerRecord = core.isOwnerRecord;
    this.isRoomMuted = core.isRoomMuted;
  }

  /**
   * Raise `dm.received` / `mention.received` for one committed entry, when it
   * earned either (spec `notification-system` task T11, DOR-1388).
   *
   * **Never notifies the operator about their own words** — `isOwnerAuthor`
   * alone, and that is the whole check. An earlier revision also treated any
   * HUMAN author in a `dm`-kind room as the operator, reasoning that a
   * bridged private chat is always the operator's own conversation. That is
   * false: a bridged `dm` room is minted from an unclaimed chat somebody ELSE
   * started with the bot (`postExternal`), so its human party can be a real
   * collaborator, not the operator's own phone. Their words in that room have
   * to reach the operator like anyone else's, which is why this gate is
   * `isOwnerAuthor` and nothing wider.
   *
   * **A real person's message in a 1:1 DM raises `dm.received` exactly as an
   * agent's does** (DOR-1392). `dm.received` used to also require
   * `author.kind === 'agent'`, which left the case with the strongest claim on
   * the operator's attention — a human colleague writing to them in a private
   * chat — as the one kind of DM that stayed silent. What makes an entry "a
   * message to you" is the ROOM, not who typed it, so the gate is `kind:
   * 'dm'` plus {@link RoomMessageNotifier.isOneOnOneDmWithOperator} and nothing about
   * author kind. Every other property of the kind is untouched: still one row
   * per room per five-minute window, still silent when the room is muted,
   * still cleared when the read cursor passes it, still never relayed out of
   * the app.
   *
   * DorkOS's own voice cannot arrive here at all — every system-authored write
   * ({@link RoomService.postMoment}, {@link RoomService.postMergeEvent},
   * {@link RoomService.postNotice}) goes straight to the store rather than
   * through `writePost` — so widening the gate off `author.kind` cannot turn
   * the room's own narration into "DorkOS messaged you".
   *
   * **A bridged echo of DorkOS's own outbound post never reaches this
   * method either.** `isBotSender` (`adapters/telegram/inbound.ts`) drops any
   * inbound update whose sender is itself a bot account — which the bot's
   * own delivery always is — before `postExternal` ever mints an author or
   * writes an entry, so that suppression is structural and upstream of this
   * seam. What this gate does NOT catch is the operator genuinely texting
   * their own agent from their own phone: that is a real external human
   * author (`platform:` naturalKey, not `isOwnerAuthor`), so their own message
   * comes back to them as one `dm.received`. Accepted deliberately, and far
   * cheaper than silently dropping every real collaborator's message; the fix
   * is the platform-identity link ("this Telegram account is me"), which
   * retires the echo for `dm.received` and `mention.received` in one move.
   *
   * A ghost author (its row vanished, ADR 260801-003051) is skipped outright:
   * there is nobody's name to put in a title.
   *
   * **A DM that also happens to name the operator raises `dm.received` only,
   * never both.** `isDirectMessage` already says the operator was reached;
   * a redundant `mention.received` for the same entry would be a second
   * banner for one message the operator is about to open from the first. The
   * collapse holds when the DM is muted, which is the only case where it costs
   * anything: muting a 1:1 conversation silences it whole. That is the point —
   * inside a DM an `@` addresses nobody new, since every word there already
   * reaches the operator, so honouring one would let any writer reopen a
   * conversation the operator deliberately closed.
   *
   * Never throws: called after the entry and its broadcast are already
   * durable, so a problem here must not be able to touch either.
   *
   * @param room - The room the entry landed in.
   * @param entry - The committed entry.
   * @param author - Its author, or `undefined` for a ghost.
   * @param mentions - The author ids this entry's resolved `@`-mentions name.
   */
  notifyRoomMessage(
    room: Room,
    entry: RoomEntry,
    author: AuthorRecord | null,
    mentions: readonly string[]
  ): void {
    try {
      if (!author) return;
      if (this.isOwnerAuthor(author.id)) return;

      const mentionsOperator = mentions.some((id) => this.isOwnerAuthor(id));
      const isDirectMessage = room.kind === 'dm' && this.isOneOnOneDmWithOperator(room.id);
      if (!isDirectMessage && !mentionsOperator) return;

      emitRoomMessageNotification({
        roomId: room.id,
        roomName: room.title,
        entryId: entry.id,
        entrySeq: entry.seq,
        ...(author.kind === 'agent' && { agentId: this.agents.byPath(author.naturalKey)?.id }),
        fromName: author.displayName,
        text: entry.body.text,
        isDirectMessage,
        // Suppressed once the entry already raised dm.received — see the
        // method doc. A mention in any OTHER room still notifies normally.
        mentionsOperator: mentionsOperator && !isDirectMessage,
        roomMuted: isDirectMessage && this.isRoomMuted(room.id),
      });
    } catch (err) {
      logger.warn('[rooms] could not evaluate whether an entry should notify', {
        roomId: room.id,
        entryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Whether a `dm`-kind room is genuinely a 1:1 between the operator and one
   * agent — exactly one agent on the roster, AND the operator among its human
   * members.
   *
   * This is the WHOLE of what makes an entry a DM to the operator, for any
   * author (DOR-1392): the shape of the roster, never the kind of whoever
   * happened to type.
   *
   * Holds whether the room is a plain two-member DM or a bridged one that has
   * also gained the operator's own external phone identity as a third, human
   * member (chats-as-channels §3.4) — a human member never changes this
   * answer, only another AGENT does, which is exactly the agent-to-agent DM
   * the three-way rule forces the owner onto (`room-conduct.md`) and the agent
   * half of this check exists to exclude.
   *
   * The operator half exists for the other edge the three-way rule leaves:
   * an agent may open a `dm` room for itself alone, with nobody else on the
   * roster at all ("Ana notes", `three-way-rule.test.ts`). One agent, zero
   * humans, is not a DM with anybody — there is nobody there to notify.
   *
   * Reads the owner check off the record `getMany` already fetched rather
   * than `isOwnerAuthor(id)`, which re-queries by id — the exact cost
   * `AuthorRegistry.isOwner`'s own doc warns a caller already holding the
   * roster should not pay (`author-registry.ts`).
   *
   * @param roomId - The room. Only ever called for a `dm`-kind room.
   */
  private isOneOnOneDmWithOperator(roomId: string): boolean {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((member) => member.authorId));
    let agentCount = 0;
    let operatorPresent = false;
    for (const member of members) {
      const record = authors.get(member.authorId);
      if (!record) continue;
      if (record.kind === 'agent') {
        agentCount += 1;
        if (agentCount > 1) return false;
      } else if (this.isOwnerRecord(record)) {
        operatorPresent = true;
      }
    }
    return agentCount === 1 && operatorPresent;
  }
}
