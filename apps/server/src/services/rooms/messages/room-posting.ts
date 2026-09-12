/**
 * Posting into a room: the guarded write a person or an agent reaches, the
 * agent's own `post_to_room`, and the files a post may carry.
 *
 * Both public paths land in the same {@link RoomEntryWriter.writePost}, which
 * is the design: `post_to_room` is `post` with three refusals added and
 * nothing removed, so it can only ever be narrower.
 *
 * @module server/services/rooms/messages/room-posting
 */
import type { RoomAttachment, RoomMoment } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import type { RoomCore } from '../service/room-core.js';
import type { RoomEntryWriter } from './room-entry-writer.js';
import { RoomError } from '../room-errors.js';
import type { PostTrigger, PostedEntry } from '../service/room-service-deps.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/** Everything one post carries. */
export interface RoomPostInput {
  /** Who is posting. */
  authorId: string;
  /** What they wrote. */
  text: string;
  /** The session that produced it, if any. */
  sessionId?: string;
  /** Cascade provenance, when a trigger produced this. */
  trigger?: PostTrigger;
  /** The entry this answers, when it is a thread reply. */
  replyTo?: string;
  /**
   * Files already uploaded into this room, in the order they should render.
   * Resolved and refused BEFORE anything is written, then bound inside the
   * entry's own transaction.
   */
  attachmentIds?: readonly string[];
  /**
   * The milestone this post marks, for an agent-minted moment (spec D5.1). Set
   * by `postMoment` and by nothing else: no request body carries one, which is
   * what keeps a moment something this install observed rather than something a
   * caller claimed. Minting one buys no extra permission — the post is written
   * by the same path, with the same membership check, cascade stamp and turn
   * budget behind it.
   */
  moment?: RoomMoment;
  /**
   * The message this post answers, set by the dispatcher on every
   * agent-authored reply. Distinct from `replyTo`, which picks a THREAD: a
   * channel post has no thread and still answers something, and a room posts in
   * arrival order whatever a message responds to.
   */
  answersEntryId?: string;
  /**
   * Author ids the writer addressed and resolved for itself, unioned with
   * whatever the text names.
   *
   * The `CommunityAdapter` port is the caller this exists for: its `post`
   * carries mentions across the seam, and a member addressed with no `@` in the
   * message is unreachable without them. Filtered to this room's own members —
   * see `withCallerMentions` in {@link RoomEntryWriter}'s module — so supplying
   * an id is never a way to reach somebody outside it.
   */
  mentions?: readonly string[];
}

/** The two doors a message comes through, and the files it may bring. */
export class RoomPosting {
  private readonly store: RoomStore;
  private readonly attachments: AttachmentRowStore;
  private readonly triggers: RoomTriggerDispatcher;
  /** The live `uploads.maxFiles`. Read per post, so a change takes effect. */
  private readonly maxAttachmentsPerEntry: () => number;
  private readonly maxPostsPerTurn: () => number;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly writer: RoomEntryWriter
  ) {
    this.store = core.store;
    this.attachments = core.attachments;
    this.triggers = core.triggers;
    this.maxAttachmentsPerEntry = core.maxAttachmentsPerEntry;
    this.maxPostsPerTurn = core.maxPostsPerTurn;
  }

  /**
   * Write a post: resolve its mentions against the roster, allocate its `seq`,
   * stamp its cascade provenance, and publish it to the room's readers.
   *
   * A post with no trigger starts a fresh cascade at depth 0 — which is what
   * makes a human able to re-engage a room the guard has stopped.
   *
   * **`replyTo` is what makes this a thread reply**, and it is the only way to
   * write one (ADR 260728-022013). It names an entry in THIS room; the reply
   * lands in the same log, under the same roster, spending the same budget, and
   * — the point of the change — inside the same `(room_id, cascade_root)`
   * ancestry set, so a cascade that goes through a thread is bounded by the same
   * rule as one that does not.
   *
   * @param roomId - The room.
   * @param input - The post itself; see {@link RoomPostInput}, which documents
   *   each field.
   * @returns The committed entry, carrying what writing it asked of the room —
   *   see {@link PostedEntry}.
   */
  post(roomId: string, input: RoomPostInput): PostedEntry {
    const room = this.visibility.requireVisibleRoom(roomId, input.authorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    // Seeing a room is not being in it. The owner can see every room but still
    // has to join one before speaking in it; for everybody else the visibility
    // check above already required membership, so this is a no-op.
    if (!this.store.getMember(roomId, input.authorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }
    // Resolved before the write, so a refusal leaves the room exactly as it was.
    const attachments = this.resolveAttachments(roomId, input.authorId, input.attachmentIds);
    const attachmentIds = attachments.map((file) => file.id);
    return this.writer.writePost(room, input, undefined, {
      bind: (entryId, tx) => {
        const bound = this.attachments.bind(roomId, attachmentIds, entryId, tx);
        // **Asserted, not assumed.** `bind` re-checks `entry_id IS NULL`, so a
        // file that another post claimed between resolution and here simply
        // does not update — and without this check the entry would commit
        // carrying a reference to a file it does not own, which is the one
        // state the foreign key cannot catch. Throwing rolls the whole
        // transaction back, entry included, which is exactly the outcome:
        // either the message and all its files land, or none of it does.
        if (bound !== attachmentIds.length) {
          throw new RoomError(
            'ATTACHMENT_ALREADY_POSTED',
            'That file was attached to another message first'
          );
        }
      },
      attachments,
    });
  }

  /**
   * Post because the agent decided to — `post_to_room` (room-participation spec
   * §10.2), and the only caller is the rooms capability domain.
   *
   * **It is `post` with three things added and nothing removed**, which is the
   * whole design: the tool must not become a second write path. Membership, the
   * archive check, mention resolution, the cascade stamp, the SSE publish and the
   * dispatch all come from {@link RoomService.post} unchanged, so a bound that
   * holds for a person's message holds for this. Two of the three are refusals,
   * so the additions can only ever make this narrower than `post`, never wider.
   *
   * What it adds:
   *
   * - **Channels and threads only WHILE THE TURN'S TEXT STILL POSTS** (§2.6, as
   *   reversed by spec `tool-only-room-replies` §D3). In text mode the reply IS
   *   the message in a DM: the agent was unambiguously addressed, answering is
   *   obligatory, and the turn's own text already lands — so a second way to say
   *   the same thing there would be a second way for it to fail, and would buy
   *   nothing. Under a tool-only turn none of that is true any more: nothing the
   *   turn writes is posted, so refusing here would leave the agent unable to
   *   answer a direct message at all. The refusal is therefore conditioned on the
   *   resolved reply mode rather than removed, and it is still spelled
   *   `!== 'channel'` — `rooms.kind` is a text column narrowed by an unchecked
   *   cast, and an unknown kind never gets more reach than a DM.
   * - **A per-turn post ceiling** — `TOO_MANY_POSTS_THIS_TURN`,
   *   `rooms.maxPostsPerTurn` (§D9). Under the flip, posting is the only voice an
   *   agent has and nothing else bounds how often it uses it;
   *   `.claude/rules/room-conduct.md` says a bound is a mechanism, never a
   *   prompt. Asked AFTER the stop mark and BEFORE the write, so a refusal never
   *   costs a claim mark and never spends a post.
   * - **A turn somebody STOPPED is refused** — `TURN_WAS_STOPPED`, DOR-1313. An
   *   interrupt is delivered rather than obeyed, so a stopped turn may still be
   *   running and reach for this; the room already throws away its narration and
   *   this is the same refusal on the half the turn speaks for itself. It stands
   *   until the room gives that agent another turn there
   *   (`RoomTriggerDispatcher.stoppedHere`, where both its limits are written
   *   down).
   * - **The turn is marked as having spoken**, so the narration that turn writes
   *   back to its session is not ALSO posted (see {@link ActiveClaim.spokeViaTool}).
   *
   * What it deliberately does not add is a fresh cascade. Provenance follows the
   * turn: a post made mid-turn inherits that turn's stamp through `activeTurnFor`,
   * and a post made with nothing in flight is stamped at the ceiling under its own
   * root — silent, triggering nobody. Speaking on purpose is not a way to reset a
   * bound.
   *
   * What it also does not add is a turn. A post made mid-turn carries that turn's
   * `dispatch_id`, so an agent that says what it is doing three times before it
   * answers has taken one turn against `maxTurnsPerAgentPerCascade`, not four
   * (DOR-1434). Being legible is not a thing this room charges for.
   *
   * @param roomId - The room to post into.
   * @param input.authorId - The agent posting, resolved from its identity by the
   *   capability — never read off the tool's arguments.
   * @param input.text - What to say.
   * @param input.replyTo - The entry this answers, to land it in that thread.
   * @returns The committed entry, carrying what writing it asked of the room —
   *   see {@link PostedEntry}.
   */
  postFromTool(
    roomId: string,
    input: {
      authorId: string;
      text: string;
      replyTo?: string;
      /**
       * Files this agent already staged into the room, unbound, in render
       * order (spec `canvas-agent-seat` §4). Bound inside the entry's own
       * transaction by {@link RoomPosting.post}, so the message and its files
       * land together or neither does.
       */
      attachmentIds?: readonly string[];
    }
  ): PostedEntry {
    const room = this.visibility.requireVisibleRoom(roomId, input.authorId);
    // The turn this post is being made from inside, when there is one. Read
    // once, before every refusal below, because three separate things need it:
    // the mode conditioning the DM refusal, the ceiling, and the answer/session
    // pointers a tool post has never carried.
    const turn = this.triggers.activeTurnHere(roomId, input.authorId);
    // `!== 'channel'`, never `=== 'dm'`: `rooms.kind` is a text column narrowed by
    // an unchecked cast, so an unrecognized kind takes the narrower branch
    // (`.claude/rules/room-conduct.md`).
    //
    // **Conditioned on the reply mode since DOR-1613** (spec
    // `tool-only-room-replies` §D3). In text mode the refusal is exactly as
    // right as it was: the reply genuinely IS the message there. In a tool-only
    // turn it is false — nothing the turn writes is posted — so keeping it would
    // leave the agent structurally unable to answer a direct message.
    if (turn?.replyMode !== 'tool-only' && room.kind !== 'channel') {
      throw new RoomError(
        'TOOL_POST_NOT_IN_DM',
        'This is a direct message and your reply is being posted for you, so there is nothing to post here. Just answer.'
      );
    }
    // **A stopped turn says nothing here either** (DOR-1313). The room already
    // throws away the narration of a turn somebody stopped; this is the same
    // refusal on the other half of that turn's voice, and it is the half that
    // measurably got through — an interrupt that reached a process still
    // spawning left the turn running, and it posted its whole answer by hand
    // twenty-three seconds after the room said everything had been stopped.
    // Refused rather than silently dropped: the agent is the one holding the
    // pen, and telling it beats letting it believe it spoke.
    if (this.triggers.stoppedIn(roomId, input.authorId)) {
      logger.info('[rooms] refused a stopped turn a post of its own', {
        roomId,
        authorId: input.authorId,
      });
      throw new RoomError(
        'TURN_WAS_STOPPED',
        'This conversation was stopped, so nothing more from this turn is posted. Wait for the next message before answering here.'
      );
    }
    // **The per-turn ceiling** (spec `tool-only-room-replies` §D9). Read per call
    // rather than captured, like every other live bound this service is handed,
    // so moving the number in Settings takes effect on the very next post.
    //
    // Asked AFTER the stop mark, so a turn that was going to be refused anyway
    // does not spend a post on the way out — the same ordering the reaction
    // budget keeps — and BEFORE the write, so a refusal never leaves a claim
    // marked as having spoken.
    //
    // `postsThisTurn` is `undefined` when this agent holds no claim here, and
    // that is not zero: a post with no turn behind it is not part of one, so
    // there is no per-turn ceiling to apply. It already costs a turn against the
    // cascade budget on its own.
    if (turn !== undefined) {
      const ceiling = this.maxPostsPerTurn();
      if (turn.postsThisTurn >= ceiling) {
        logger.info('[rooms] refused a turn a further post', {
          roomId,
          authorId: input.authorId,
          ceiling,
        });
        throw new RoomError(
          'TOO_MANY_POSTS_THIS_TURN',
          `You have already posted ${ceiling} ${ceiling === 1 ? 'message' : 'messages'} in this conversation during this turn, which is the limit. Consolidate the rest into one message next turn.`
        );
      }
    }
    const entry = this.post(roomId, {
      ...input,
      // **What a tool post has never carried, and now must** (spec
      // `tool-only-room-replies` §D8). The turn-text path passes both; a tool
      // post passed neither, so `sessionId` fell to `null` and the "answers
      // this" pointer was simply absent. That was survivable while a deliberate
      // post was rare. Under the flip it is EVERY agent reply in the product:
      // the room would stop drawing the pointer, and no entry could be traced
      // back to the session that wrote it.
      //
      // Both facts are in hand at write time — the live claim knows the entry it
      // is answering, and the `(room, agent)` binding is the session that turn
      // runs on — so they are filled from there rather than trusted from the
      // caller. Only for a post made INSIDE a turn: a post with no claim behind
      // it is answering nothing and belongs to no session here.
      ...(turn !== undefined
        ? {
            answersEntryId: turn.entryId,
            ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
          }
        : {}),
    });
    this.triggers.noteDeliberatePost(roomId, input.authorId);
    return entry;
  }

  /**
   * Settle which files a post may carry, refusing before anything is written.
   *
   * Every refusal here is about the CALLER's relationship to the ids, which is
   * why it happens in the service and not in the row store: an id from another
   * room, an id somebody else uploaded, and an id already spoken for are three
   * different mistakes and get three different answers. Two of them collapse to
   * `ATTACHMENT_NOT_FOUND` on purpose — a 403 for "that is someone else's file"
   * would confirm the file exists.
   *
   * @param roomId - The room the post is being written in.
   * @param authorId - Who is posting. Only their own unbound files may be named.
   * @param attachmentIds - The ids the post named, in render order.
   * @returns The resolved attachments, in the order they were named.
   */
  resolveAttachments(
    roomId: string,
    authorId: string,
    attachmentIds: readonly string[] | undefined
  ): RoomAttachment[] {
    if (!attachmentIds || attachmentIds.length === 0) return [];

    // The CONFIGURED limit, read now — not `ROOM_ATTACHMENT_MAX_PER_ENTRY`,
    // which is only the ceiling that limit may be set to.
    const limit = this.maxAttachmentsPerEntry();
    if (attachmentIds.length > limit) {
      throw new RoomError(
        'TOO_MANY_ATTACHMENTS',
        `A message can carry at most ${limit} ${limit === 1 ? 'file' : 'files'}`
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new RoomError('TOO_MANY_ATTACHMENTS', 'The same file was attached twice');
    }

    const unbound = new Map(
      this.attachments.listUnboundFor(roomId, attachmentIds).map((row) => [row.id, row] as const)
    );
    return attachmentIds.map((id) => {
      const row = unbound.get(id);
      if (!row) {
        // Absent from the unbound set is either "not here" or "already posted",
        // and only the second is worth its own code — a person who attached the
        // same file to two messages can act on that answer.
        const existing = this.attachments.get(roomId, id);
        if (existing?.entryId) {
          throw new RoomError('ATTACHMENT_ALREADY_POSTED', 'That file is already on a message');
        }
        throw new RoomError('ATTACHMENT_NOT_FOUND', 'No such file in this room');
      }
      // Somebody else's staging area is not readable and not postable, and the
      // answer is the same one a missing id gets.
      if (row.authorId !== authorId) {
        throw new RoomError('ATTACHMENT_NOT_FOUND', 'No such file in this room');
      }
      return {
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        preview: row.preview,
        url: row.url,
      };
    });
  }
}
