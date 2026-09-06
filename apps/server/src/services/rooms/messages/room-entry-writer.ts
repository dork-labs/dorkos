/**
 * Everything a post does once the room and the writer's standing in it are
 * settled: the mentions, the cascade stamp, the row, the publish, and the
 * dispatch that follows it.
 *
 * Two very different callers agree on nothing else and share all of this — a
 * person or an agent posting into a room they belong to, and the inbound
 * bridge writing a message from somebody who is not on this machine at all.
 *
 * @module server/services/rooms/messages/room-entry-writer
 */
import { ulid } from 'ulidx';
import type { DbTransaction } from '@dorkos/db';
import type { Room, RoomAttachment, RoomEntry, RoomMoment } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import type { AuthorRecord, AuthorRegistry, ExternalAuthorIdentity } from '../author-registry.js';
import { deriveCascade } from '../cascade-guard.js';
import type { RoomLimitsResolver } from '../limits/room-limits.js';
import { resolveAddressing } from '../mentions.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import type { RoomMessageNotifier } from './room-message-notifier.js';
import type { RoomPublisher } from '../service/room-publisher.js';
import type { RoomRoster } from '../room-roster.js';
import type { PostTrigger, PostedEntry } from '../service/room-service-deps.js';
import type { RoomStore } from '../room-store.js';
import type { RoomDispatchSummary, RoomTriggerDispatcher } from '../room-trigger.js';

/**
 * Resolve the two thread pointers an entry is written with.
 *
 * **This is where the one-level rule lives, and it is the whole of it**
 * (ADR 260728-022013). The schema permits `parent_entry_id` to name a reply;
 * the service refuses to write one, on the same reasoning 260726-170125 gave
 * and every surveyed product shares. So the depth ceiling is a policy a later
 * ADR can revisit by changing the `if` below — not a shape a migration would
 * have to undo. Opening a second level means deriving
 * `threadRootEntryId = parent.threadRootEntryId ?? parent.id` here instead of
 * throwing; nothing else in the schema has an opinion.
 *
 * Refusing beats flattening: a reader who thought they had branched twice and
 * got one branch has been lied to.
 *
 * @param store - The room table, for resolving the entry being replied to.
 * @param roomId - The room the entry is being written into.
 * @param replyTo - The entry it answers, or undefined for a top-level entry.
 * @returns The `parentEntryId` / `threadRootEntryId` pair to persist.
 */
export function threadPointers(
  store: RoomStore,
  roomId: string,
  replyTo: string | undefined
): { parentEntryId: string | null; threadRootEntryId: string | null } {
  if (replyTo === undefined) return { parentEntryId: null, threadRootEntryId: null };
  // Scoped to this room, so an entry id from a room the caller can see cannot
  // pull a reply into a conversation it does not belong to.
  const root = store.getEntryById(roomId, replyTo);
  if (!root) throw new RoomError('ENTRY_NOT_FOUND', 'No such entry in this room');
  if (root.threadRootEntryId !== null) {
    throw new RoomError('NESTED_THREAD', 'A thread reply cannot hang off another reply');
  }
  return { parentEntryId: root.id, threadRootEntryId: root.id };
}

/** A message that arrived from somebody outside this machine. */
export interface RoomExternalPostInput {
  /**
   * Who wrote it, on which platform, through which bot. Never `null`: a
   * message with no resolvable platform user id gets no author at all and is
   * dropped by the caller before it reaches here (§4.1).
   */
  identity: ExternalAuthorIdentity;
  /** What they wrote, exactly as they wrote it. */
  text: string;
  /** The entry this answers, when the platform said so. */
  replyTo?: string;
  /**
   * One extra `@`-name for the bound agent, from the platform's own bot handle
   * (`getMe().username`, §5.4). Threaded to
   * {@link RoomRoster.addressingCandidates} so `@botusername` resolves to the
   * agent; `ingest` rewrites nothing, and this never touches the stored text.
   */
  mentionAugment?: { agentPath: string; names: readonly string[] };
  /**
   * Runs inside the entry's OWN transaction, handed the committed entry's id.
   * This is what makes §5.2 step 6 — the inbound external ref — atomic with the
   * entry write (A5.6: both rows or neither), since `better-sqlite3` is
   * synchronous and the ref shares this transaction.
   */
  recordRef?: (entryId: string, tx: DbTransaction) => void;
}

/** The shared write half of every post that reaches a room's log. */
export class RoomEntryWriter {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly roster: RoomRoster;
  private readonly bridges: BridgeStore;
  private readonly triggers: RoomTriggerDispatcher;
  /** What bounds automatic replies in one room. Read per write. */
  private readonly limitsFor: RoomLimitsResolver;

  constructor(
    core: RoomCore,
    private readonly publisher: RoomPublisher,
    private readonly notifier: RoomMessageNotifier
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.roster = core.roster;
    this.bridges = core.bridges;
    this.triggers = core.triggers;
    this.limitsFor = core.limitsFor;
  }

  /**
   * Write a message that arrived from somebody outside this machine, minting
   * their author on their first message and joining them to the roster in the
   * SAME transaction as that message (chats-as-channels spec §4.1–§4.2).
   *
   * The seam the inbound bridge calls. It exists rather than the bridge calling
   * {@link RoomService.post} because three of this path's properties have no
   * expression in that one:
   *
   * - **The author is minted from a platform identity, not supplied.** Nothing
   *   outside this machine may name an author id, and the identity it IS keyed
   *   on is address-free (`external-authors.ts`).
   * - **Membership is lazy.** A bridged group of two hundred projects a roster
   *   row per person who has SPOKEN, never one per person who exists (§4.2).
   *   `post` would refuse the first message of every one of them.
   * - **The join is atomic with the message.** A log holding a post from
   *   somebody its roster says was never in the room is a record that
   *   contradicts itself, and the room log is the audit trail this whole
   *   feature offers in exchange for letting strangers reach a model (§9.4).
   *
   * **Bridged rooms only.** An external author in an ordinary room would be a
   * stranger in the operator's private conversation, so the bridge row is
   * checked here rather than trusted from the caller — the same
   * refuse-before-doing shape the create path takes.
   *
   * They join by the room's own seed, which for a person is
   * `seedResponseMode`'s inert default: nothing ever auto-triggers a human, so
   * the column is a stored enum value rather than a claim about behaviour.
   *
   * @param roomId - The bridged room the chat projects into.
   * @param input - The message and its platform identity; see
   *   {@link RoomExternalPostInput}, which documents each field.
   * @returns The committed entry, the author it was written as, and whether
   *   this message is what put them on the roster.
   */
  postExternal(
    roomId: string,
    input: RoomExternalPostInput
  ): { entry: RoomEntry; author: AuthorRecord; joined: boolean } {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const bridge = this.bridges.findBridgeByRoom(roomId);
    if (!bridge || bridge.archivedAt !== null) {
      throw new RoomError(
        'NOT_A_BRIDGED_ROOM',
        'Only a room bridged to an external chat can hold a message from outside this machine'
      );
    }

    const author = this.authors.resolveExternal(input.identity);
    const joining = this.store.getMember(roomId, author.id) === null;
    const entry = this.writePost(
      room,
      { authorId: author.id, text: input.text, replyTo: input.replyTo },
      joining
        ? (tx) => void this.store.addMember(this.roster.externalJoin(room, author), tx)
        : undefined,
      { mentionAugment: input.mentionAugment, recordRef: input.recordRef }
    );
    // After the commit, never inside it: a broadcast is not rolled back, and a
    // roster event for a join that failed would leave every open cockpit
    // showing a member the database does not have.
    if (joining) eventFanOut.broadcast('room_member_added', { roomId, authorId: author.id });
    return { entry, author, joined: joining };
  }

  /**
   * Everything a post does once the room and the writer's standing in it have
   * been settled — shared by {@link RoomService.post} and
   * {@link RoomService.postExternal}, which settle those two things very
   * differently and agree on nothing else.
   *
   * @param room - The room, already resolved and known un-archived.
   * @param input - The post itself.
   * @param within - Extra writes to run inside the entry's own transaction,
   *   strictly BEFORE the entry is inserted, so the membership exists for the
   *   whole life of the entry and a crash can never leave a log holding a post
   *   from somebody its roster says was never in the room (chats-as-channels
   *   §4.2). Passed straight through to {@link RoomStore.appendEntry}.
   * @param opts.mentionAugment - Extra `@`-names for the bound agent, threaded to
   *   {@link RoomRoster.addressingCandidates} (chats-as-channels §5.4). Only a
   *   bridged inbound message carries one.
   * @param opts.recordRef - Runs inside the SAME transaction as the entry write,
   *   handed the entry's id once it is known — the inbound external ref (§5.2
   *   step 6), made atomic with the entry it names (A5.6). Composed with
   *   `within` rather than replacing it, so a first message both joins its author
   *   and records its ref in one transaction.
   * @param opts.bind - Runs inside the same transaction too, but on the far side
   *   of the insert — {@link RoomStore.appendEntry}'s `bind` hook, handed the
   *   entry's id. It is separate from `recordRef` rather than folded into it
   *   because the two want opposite orderings: a bridge ref has no foreign key
   *   and may be written first, while binding a `room_attachments` row points a
   *   foreign key AT the entry and fails with `FOREIGN KEY constraint failed`
   *   unless the entry is already there.
   */
  writePost(
    room: Room,
    input: {
      authorId: string;
      text: string;
      sessionId?: string;
      trigger?: PostTrigger;
      replyTo?: string;
      moment?: RoomMoment;
      answersEntryId?: string;
    },
    within?: (tx: DbTransaction) => void,
    opts?: {
      mentionAugment?: { agentPath: string; names: readonly string[] };
      recordRef?: (entryId: string, tx: DbTransaction) => void;
      bind?: (entryId: string, tx: DbTransaction) => void;
      attachments?: RoomAttachment[];
    }
  ): PostedEntry {
    const roomId = room.id;

    // Provenance follows the TURN, not the call — and where there is no turn,
    // who is writing decides, never the shape of the call. An agent can post
    // here directly (`POST /api/rooms/:id/entries` carries no trigger), both
    // while its turn runs and from a shell with nothing in flight at all;
    // `deriveCascade` refuses a fresh cascade to either. Only a human resets the
    // count, which is what spec §6 says and what the setting's own docs promise.
    const author = this.authors.getById(input.authorId);
    const trigger = input.trigger ?? this.triggers.activeTurnFor(input.authorId);

    // WHICH TURN wrote this, which is a different question from which cascade it
    // belongs to (DOR-1434). The dispatcher hands its own id down with the
    // trigger it delivers under; every other write inside a turn — the progress
    // notes an agent posts through the rooms tool, an aside turn's `post_to_room`
    // writes included — is found by asking the claim held on THIS room. Anything
    // with no turn behind it stamps `null` and costs one turn on its own, which
    // is what every row cost before this column existed.
    //
    // Two writes that look like they belong to a turn and honestly do not. The
    // welcome-back greeter's own posts — the status line, and the offer it posts
    // once the aside turn's claim is already released — are the greeter speaking
    // for an agent rather than a turn writing, and no claim is held at either
    // moment. And a cross-room `post_to_room`: the lookup is keyed on the room
    // the entry lands in, so an agent mid-turn in room A posting a note into
    // room B holds no claim in B and the note counts as one message there. Both
    // are accepted rather than overlooked — see the DOR-1434 amendment on
    // ADR 260823-000217.
    const dispatchId =
      input.trigger?.dispatchId ?? this.triggers.dispatchFor(roomId, input.authorId) ?? null;

    // Resolved ONCE, here, and both halves of the answer are kept: who this
    // message reached, and who it named but could not reach because that
    // member's agent is gone. The second half is what stops a released name
    // becoming a silent one (ADR 260801-003051) — the dispatcher writes the
    // room's answer to it below.
    const addressed = resolveAddressing(
      input.text,
      this.roster.addressingCandidates(roomId, opts?.mentionAugment)
    );
    const id = ulid();
    // The ref write shares the entry's transaction, so both land or neither does
    // (§5.2, A5.6). Composed with `within` — a bridged first message both joins
    // its author (`within`) and records its inbound ref (`recordRef`) in the one
    // transaction — and built only when there is something extra to run, so an
    // ordinary post pays nothing.
    const recordRef = opts?.recordRef;
    const transactional =
      within || recordRef
        ? (tx: DbTransaction) => {
            within?.(tx);
            recordRef?.(id, tx);
          }
        : undefined;
    // The far side of the insert, and deliberately not folded into
    // `transactional` above — see `opts.bind`. Built only when there is one, so
    // an ordinary post pays nothing here either.
    const bindAfterInsert = opts?.bind;
    const bindTransactional = bindAfterInsert
      ? (tx: DbTransaction) => bindAfterInsert(id, tx)
      : undefined;
    const entry = this.store.appendEntry(
      {
        roomId,
        id,
        authorId: input.authorId,
        kind: 'post',
        // The milestone rides beside the words, never instead of them: a moment
        // a client cannot read is a blank line in the feed.
        body: {
          text: input.text,
          ...(input.moment && { moment: input.moment }),
          ...(input.answersEntryId !== undefined && { answersEntryId: input.answersEntryId }),
        },
        mentions: addressed.mentions,
        // The per-occurrence positions of those mentions, resolved in the SAME
        // pass and stored beside them so the client draws pills without ever
        // re-parsing the body (`.claude/rules/room-conduct.md`).
        mentionSpans: addressed.spans,
        sessionId: input.sessionId ?? null,
        dispatchId,
        ...threadPointers(this.store, roomId, input.replyTo),
        ...deriveCascade(id, {
          trigger,
          // An author row that has vanished is treated as an agent — the
          // conservative read, since the only thing this decides is whether the
          // writer may reset a spend limit.
          authorKind: author?.kind ?? 'agent',
          maxAgentDepth: this.limitsFor(roomId).maxAgentDepth,
        }),
        createdAt: new Date().toISOString(),
      },
      transactional,
      bindTransactional
    );

    this.publisher.publishEntry(entry, opts?.attachments ?? []);
    // Never on the transaction, never before the entry is durable: a
    // notification is the least important thing this write does, and it must
    // never be able to delay or fail the post that produced it (mirrors the
    // dispatch try/catch immediately below).
    this.notifier.notifyRoomMessage(room, entry, author, addressed.mentions);
    // Trigger-only, both ways: the post reaches its readers now, and whoever it
    // addresses answers on their own schedule. Deliberately not awaited — the
    // HTTP 202 must not wait on a model call, and the reply arrives on the same
    // SSE stream as everything else when it comes.
    //
    // **A committed post must never fail because dispatching from it did.** The
    // entry above is written, published and gone; `dispatch` runs its target
    // selection SYNCHRONOUSLY, so anything it throws — a SQLite write under
    // contention, most plausibly — surfaced at the route as a 500 for a message
    // that is sitting in the log. The poster saw their own successful message
    // fail. Losing the replies to it is bad and visible in the room; losing the
    // message is worse and looks like a broken product.
    //
    // What it hands back is the same synchronous decision it has always made,
    // now said out loud: who the message reached, and who it reached and will not
    // be answered by. A throw leaves that unanswerable, so the caller is told
    // nothing rather than told "nobody" — the post stands either way.
    let dispatch: RoomDispatchSummary | null = null;
    try {
      dispatch = this.triggers.dispatch(room, entry, addressed.unreachable);
    } catch (err) {
      logger.error('[rooms] a committed post could not be dispatched from', {
        roomId,
        entryId: entry.id,
        authorId: input.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ...entry, dispatch };
  }
}
