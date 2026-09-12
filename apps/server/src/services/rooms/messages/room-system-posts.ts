/**
 * The room speaking in its own voice — a milestone, a merge, a notice.
 *
 * All three share one shape, and it is the shape that matters: they go
 * straight to the store and the stream, they address nobody, and their cascade
 * is spent at the ceiling — so a room where DorkOS says something never sets
 * agents talking. That is the over-participation `meta/agent-etiquette.md`
 * exists to damp, and it is held here structurally rather than promised in a
 * prompt.
 *
 * @module server/services/rooms/messages/room-system-posts
 */
import { ulid } from 'ulidx';
import type { DbTransaction } from '@dorkos/db';
import type {
  RoomCanvasChange,
  RoomEntry,
  RoomEntryBody,
  RoomMergeEvent,
  RoomMoment,
} from '@dorkos/shared/room-schemas';
import { RoomMomentSchema } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import { deriveCascade } from '../cascade-guard.js';
import type { RoomLimitsResolver } from '../limits/room-limits.js';
import type { RoomCore } from '../service/room-core.js';
import { threadPointers } from './room-entry-writer.js';
import { RoomError } from '../room-errors.js';
import type { RoomPosting } from './room-posting.js';
import type { RoomPublisher } from '../service/room-publisher.js';
import type { RoomStore } from '../room-store.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/** Everything a room writes into its own log without anybody having typed it. */
export class RoomSystemPosts {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  /** What bounds automatic replies in one room. Read per write. */
  private readonly limitsFor: RoomLimitsResolver;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly publisher: RoomPublisher,
    private readonly posting: RoomPosting
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.limitsFor = core.limitsFor;
  }

  /**
   * Mark a milestone in a room — a **moment** (team-room-home spec D5.1).
   *
   * **A moment is a post.** It is written into the same log, carries the same
   * fields, and reaches readers on the same stream; what makes it one is
   * `body.moment`, which says what it marks and — the rule the whole feature
   * stands on — what real record it was read from. The feed draws it
   * differently (`MomentRow`); nothing else has to know.
   *
   * **Two ways in, and they are not the same permission.**
   * - *DorkOS itself* (no `authorId`): written by the system author, and
   *   deliberately NOT dispatched. A room where the milestone "tangerines
   *   joined your team" set two agents talking would be the over-participation
   *   `meta/agent-etiquette.md` exists to damp. It is stamped the way an
   *   un-provenanced write is stamped — at the ceiling — so nothing that ever
   *   dispatches from it can open a fresh reply budget either.
   * - *An agent* (`authorId`): straight through {@link RoomService.post}, the
   *   guarded path, unchanged. The membership check, the cascade stamp, the
   *   ancestry rule and the turn budget all apply exactly as they do to
   *   anything else that agent says. There is no second write surface and no
   *   tool: minting a moment is not a way around any of it.
   *
   * **`subjectAuthorId` is refused on the agent path**, and that is the one
   * refusal here that is about safety rather than shape. The field decides
   * whose face the feed draws beside the words; letting an agent set it would
   * let one agent publish its own sentence under another identity. DorkOS
   * writing "tangerines joined your team" is the case the field exists for, and
   * an agent that has something to say about tangerines says it as itself.
   *
   * @param roomId - The room to mark it in.
   * @param input.text - What a person reads. Written by the caller, because the
   *   detector is the only thing that knows the real numbers.
   * @param input.moment - What it marks and what it was derived from. Validated
   *   here rather than trusted: detectors build this from live data, so a
   *   sourceless moment has to fail at the seam instead of landing in the log.
   * @param input.authorId - The agent minting it, when an agent is. Omit for a
   *   moment DorkOS itself observed.
   * @param input.subjectAuthorId - Who the moment is ABOUT, when the room is
   *   speaking about somebody other than itself. System path only.
   * @returns The committed entry.
   */
  postMoment(
    roomId: string,
    input: {
      text: string;
      moment: RoomMoment;
      authorId?: string;
      subjectAuthorId?: string;
    }
  ): RoomEntry {
    const moment = RoomMomentSchema.safeParse(input.moment);
    if (!moment.success) {
      throw new RoomError(
        'INVALID_MOMENT',
        'A moment has to say what it marks and what it was derived from'
      );
    }
    if (input.text.trim().length === 0) {
      throw new RoomError('INVALID_MOMENT', 'A moment has to say something a person can read');
    }
    if (input.authorId !== undefined) {
      if (input.subjectAuthorId !== undefined) {
        throw new RoomError(
          'INVALID_MOMENT',
          'A moment an agent mints is about its author, and may not name another'
        );
      }
      return this.posting.post(roomId, {
        authorId: input.authorId,
        text: input.text,
        moment: moment.data,
      });
    }

    const room = this.visibility.requireRoom(roomId);
    // Archived means archived for the room's own voice too — the same rule
    // `postNotice` holds, for the same reason: archiving promises a room stops
    // gaining entries.
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'post',
      body: {
        text: input.text,
        moment: moment.data,
        ...(input.subjectAuthorId && { subjectAuthorId: input.subjectAuthorId }),
      },
      // A milestone addresses nobody. Nothing is parsed out of its words,
      // because nothing wrote them to reach anyone.
      mentions: [],
      mentionSpans: [],
      sessionId: null,
      ...threadPointers(this.store, roomId, undefined),
      // The shipped rule rather than a hand-stamped number: a non-human write
      // with no trigger behind it starts a cascade that is already spent.
      ...deriveCascade(id, {
        authorKind: 'system',
        maxAgentDepth: this.limitsFor(roomId).maxAgentDepth,
      }),
      createdAt: new Date().toISOString(),
    });
    this.publisher.publishEntry(entry);
    return entry;
  }

  /**
   * Announce work an agent merged into the room's repo (spec `project-rooms`
   * §3.6).
   *
   * **The room's own voice, and it wakes nobody.** Every property that matters
   * here is the same one {@link RoomService.postMoment}'s system path has, and
   * for the same reasons — this is deliberately that shape rather than a new
   * one:
   *
   * - It is a **post**, so the history page, the stream, a thread and a bridge
   *   all carry it with no new branch. It is **not a notice**: notices are
   *   refusal-shaped and damped on `(room, agent, reason)`, and merges are
   *   per-event content that must never collapse into one line (spec §5 Q3).
   * - It **addresses nobody**. `mentions` is empty because nothing here was
   *   written to reach anyone; the agent's name is in the sentence as a fact,
   *   not as an address, and mentions resolve at write time so nothing will
   *   re-read the text later and decide otherwise.
   * - Its cascade is **spent at the ceiling** (`deriveCascade` with
   *   `authorKind: 'system'`), so even a future path that did dispatch from an
   *   entry like this one could not open a fresh reply budget with it.
   * - It is **never dispatched**: it goes straight to the store and the stream,
   *   the way a system moment does. A merge is news about files, and a room
   *   where landing a commit set three agents talking is the over-participation
   *   `meta/agent-etiquette.md` exists to damp.
   *
   * `subjectAuthorId` names the agent whose work landed, so the feed draws its
   * face beside a sentence the room wrote — the same job the field does for a
   * notice and for a moment.
   *
   * @param roomId - The room whose repo gained the work.
   * @param input.text - The sentence a person reads. Composed by the caller,
   *   which is the only thing that knows the real numbers.
   * @param input.merge - The machine-readable half, for the file explorer.
   * @param input.subjectAuthorId - The agent whose branch was merged.
   * @returns The committed entry.
   * @throws {RoomError} `ROOM_ARCHIVED` — an archived room gains no entries, in
   *   its own voice least of all.
   */
  postMergeEvent(
    roomId: string,
    input: { text: string; merge: RoomMergeEvent; subjectAuthorId: string }
  ): RoomEntry {
    const room = this.visibility.requireRoom(roomId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'post',
      body: {
        text: input.text,
        merge: input.merge,
        subjectAuthorId: input.subjectAuthorId,
      },
      // Addresses nobody. See the TSDoc — this is the whole no-cascade claim,
      // and the emptiness is the mechanism rather than a consequence of the
      // text happening not to contain an `@`.
      mentions: [],
      mentionSpans: [],
      sessionId: null,
      ...threadPointers(this.store, roomId, undefined),
      ...deriveCascade(id, {
        authorKind: 'system',
        maxAgentDepth: this.limitsFor(roomId).maxAgentDepth,
      }),
      createdAt: new Date().toISOString(),
    });
    this.publisher.publishEntry(entry);
    return entry;
  }

  /**
   * Announce what one turn put on, changed or took off the room's canvas (spec
   * `room-canvas` §6.2).
   *
   * **The merge shape, deliberately, and for the reasons {@link postMergeEvent}
   * spells out at length.** It is a POST rather than a notice — notices are
   * refusal-shaped and damped on `(room, agent, reason)`, and two canvas changes
   * a minute apart collapsing into one line would be the room hiding exactly the
   * content this feature exists to surface. It addresses NOBODY, its cascade is
   * spent at the ceiling, and it is never dispatched, so a room where somebody
   * put a document on the table does not start three agents talking. Agents
   * learn the table moved at their next turn, from the `canvas` section of the
   * room context they were going to be handed anyway.
   *
   * **One of these per TURN, not per operation** (etiquette E17). The caller —
   * `RoomCanvasService.finishTurn` — composes it from that turn's ledger, so a
   * turn that opened three documents writes one line naming all three, and a
   * turn that applied nothing writes nothing at all.
   *
   * `subjectAuthorId` names the member whose turn it was, so the feed draws their
   * face beside a sentence the room wrote — the same job the field does for a
   * notice, a moment and a merge.
   *
   * @param roomId - The room whose canvas changed.
   * @param input.text - The sentence a person reads.
   * @param input.canvas - The machine-readable half, for a client that draws it.
   * @param input.subjectAuthorId - The member whose turn changed the canvas.
   * @returns The committed entry.
   * @throws {RoomError} `ROOM_ARCHIVED` — an archived room gains no entries, in
   *   its own voice least of all.
   */
  postCanvasEvent(
    roomId: string,
    input: { text: string; canvas: RoomCanvasChange; subjectAuthorId: string }
  ): RoomEntry {
    const room = this.visibility.requireRoom(roomId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'post',
      body: {
        text: input.text,
        canvas: input.canvas,
        subjectAuthorId: input.subjectAuthorId,
      },
      // Addresses nobody — the emptiness is the mechanism, exactly as it is on a
      // merge entry, rather than a consequence of the text happening to carry no
      // `@`. This is what makes "a canvas change wakes nobody" structural.
      mentions: [],
      mentionSpans: [],
      sessionId: null,
      ...threadPointers(this.store, roomId, undefined),
      ...deriveCascade(id, {
        authorKind: 'system',
        maxAgentDepth: this.limitsFor(roomId).maxAgentDepth,
      }),
      createdAt: new Date().toISOString(),
    });
    this.publisher.publishEntry(entry);
    return entry;
  }

  /** Persist one privately authorized service notice and its source receipt atomically, without waking agents. */
  postServiceNotification(
    roomId: string,
    entryId: string,
    text: string,
    within: (tx: DbTransaction) => void,
    bind: (tx: DbTransaction, seq: number) => void
  ): RoomEntry {
    const room = this.visibility.requireRoom(roomId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const entry = this.store.appendEntry(
      {
        roomId,
        id: entryId,
        authorId: this.authors.system().id,
        kind: 'notice',
        body: { text },
        mentions: [],
        mentionSpans: [],
        sessionId: null,
        ...threadPointers(this.store, roomId, undefined),
        ...deriveCascade(entryId, {
          authorKind: 'system',
          maxAgentDepth: this.limitsFor(roomId).maxAgentDepth,
        }),
        createdAt: new Date().toISOString(),
      },
      within,
      bind
    );
    this.publisher.publishEntry(entry);
    return entry;
  }

  /**
   * Write a `notice` — the room speaking in its own voice, authored by the
   * system author. A refused trigger lands one of these; a silently dropped
   * trigger is indistinguishable from a broken agent.
   *
   * @param roomId - The room.
   * @param body - The notice body, e.g. from `buildCascadeNotice`.
   * @param cascade - The cascade this notice belongs to, so it stays traceable.
   * @param replyTo - The entry it belongs under, when the turn it is about
   *   happened inside a thread. A refusal reported at the channel's top level
   *   while the exchange it refused is three replies deep in a thread is a
   *   notice the reader cannot connect to anything (`I3` — a refusal is visible).
   * @returns The committed entry.
   */
  postNotice(
    roomId: string,
    body: RoomEntryBody,
    cascade?: { root: string; depth: number },
    replyTo?: string
  ): RoomEntry {
    const room = this.visibility.requireRoom(roomId);
    // Archived means archived for the room's own voice too. `post` has always
    // refused here; a notice that slipped past would let an archived room keep
    // gaining entries, which is the one thing archiving promises it will not do.
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'notice',
      body,
      mentions: [],
      mentionSpans: [],
      sessionId: null,
      ...threadPointers(this.store, roomId, replyTo),
      cascadeRoot: cascade?.root ?? id,
      cascadeDepth: cascade?.depth ?? 0,
      createdAt: new Date().toISOString(),
    });
    this.publisher.publishEntry(entry);
    return entry;
  }
}
