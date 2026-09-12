/**
 * A room's shared canvas: the table, and every rule about who may change it
 * (spec `room-canvas` §3).
 *
 * ## The one writer
 *
 * {@link RoomCanvasService.apply} is **the single writer and the single
 * enforcement point** for everything an agent does here. Archived room, verb not
 * on the allow-list, no usable referent, over the per-turn ceiling, held by
 * somebody else's edit lock — all five refusals live in it, and nothing else in
 * the system writes a canvas row for an agent.
 *
 * It is **synchronous**, and that is not a style choice. The claude-code
 * `control_ui` handler returns to the model on the same call stack, so a ceiling
 * enforced anywhere later would be refusing an operation the tool had already
 * reported as successful — a bound that answers after the fact is not a bound,
 * it is a silent drop. `rooms.maxPostsPerTurn` only works for the same reason:
 * `postFromTool` is the same synchronous call that answers the model.
 *
 * ## Two callers, one ledger
 *
 * `apply` is reached from two places (ADR `260911-200303`): the claude-code
 * handler calls it directly and stamps the event it then pushes, and the room
 * turn's collector calls it for every `ui_command` that carries NO stamp — which
 * is how codex and the scripted test-mode runtime reach the same writer. The
 * stamp is the whole of the dedupe.
 *
 * Whichever caller it was, every applied operation is appended to a per-`turnId`
 * **ledger**, and {@link RoomCanvasService.finishTurn} composes the turn's one
 * coalesced room entry from that ledger. Composing it from what the collector
 * happened to observe would lose any operation whose stamped event reached the
 * projector after the collector settled: a row with nothing naming it. The
 * ledger keeps "has a row" and "is named in the entry" the same set.
 *
 * ## What this class does not do
 *
 * It does not decide what a runtime does with a refusal — the handler returns it
 * to the model, the tap discards it — and it does not trigger anything. A canvas
 * change wakes nobody (ADR `260911-200302`): members learn about it in their next
 * turn's context, in one coalesced line in the room's log, and in an ordinary
 * `@mention` when an agent actually wants eyes.
 *
 * @module server/services/rooms/canvas/room-canvas-service
 */
import type { CanvasDocument, RoomCanvasChange, RoomEvent } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent, UiCommand } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';
import { RoomError, type RoomErrorCode } from '../room-errors.js';
import type { RoomBroadcaster } from '../room-stream.js';
import type { RoomVisibility } from '../service/room-visibility.js';
import {
  toCanvasDocument,
  type CanvasDocumentRow,
  type CanvasDocumentStore,
} from './canvas-document-store.js';
import {
  canvasDocumentId,
  canvasSourceKey,
  canvasSourcePath,
  canvasTitle,
} from './document-key.js';

/**
 * How many unpinned documents one room's canvas holds before the least recently
 * active is dropped to make room.
 *
 * The same number the session canvas uses (`MAX_CANVAS_DOCUMENTS`), because it
 * is the same surface and a room whose strip behaved differently from a
 * session's would be two rules to learn. Pinned documents are neither counted
 * nor evicted.
 */
export const MAX_ROOM_CANVAS_DOCUMENTS = 12;

/** How often a focused editor refreshes its claim on a document. */
export const CANVAS_EDIT_HEARTBEAT_MS = 15_000;

/**
 * How long a heartbeat keeps an edit lock live — three times the interval, so
 * one dropped request never drops a lock while somebody is mid-sentence.
 *
 * Evaluated LAZILY at read and write time, with no sweeper. A timer that expired
 * locks would have to be cancelled on every close, restart and room deletion,
 * and the failure mode of getting that wrong is a document nobody can ever edit
 * again. Evaluated lazily, a crashed browser simply stops holding a lock 45
 * seconds later and no code had to notice.
 */
export const CANVAS_EDIT_TTL_MS = 45_000;

/**
 * How long a finished turn is remembered, so an operation that lands after its
 * line was posted is recognised as late rather than filed as new.
 *
 * Two hours: comfortably past `rooms.lateReplyCeilingMinutes` at its shipped
 * default, which is the longest the room itself will wait on a turn. Past it, an
 * operation from that turn is treated as the opening of a fresh one — it still
 * gets a row and still gets a line, so nothing is lost either way.
 */
const CLOSED_TURN_MEMORY_MS = 2 * 60 * 60_000;

/**
 * The hard ceiling on how many finished turns are remembered at once.
 *
 * The age bound above is the honest one; this is the one that holds on a machine
 * busy enough that ages alone would not prune fast enough. Dropping the oldest
 * memory hands a turn that finished long ago a fresh per-turn budget — which is
 * why both bounds are set where they are: a turn 500 turns old, or two hours
 * old, is not a turn any more.
 */
const MAX_REMEMBERED_CLOSED_TURNS = 500;

/**
 * The hard ceiling on how many OPEN ledgers are held at once.
 *
 * The sibling of {@link MAX_REMEMBERED_CLOSED_TURNS}, and deliberately its own
 * constant rather than a shared one: two bounds that move together cannot be
 * told apart by a test, and each of these is worth being able to break on its
 * own. Dropping the oldest open ledger loses that turn's LINE and never a row —
 * the same thing the age bound below loses, and the same thing a failed post
 * loses.
 */
const MAX_OPEN_LEDGERS = 500;

/**
 * How long an OPEN ledger is kept for a turn nothing ever closed.
 *
 * `finishTurn` runs in the collector's `finally`, so every dispatched turn
 * reaches it — but a process that died between the write and the close leaves an
 * entry behind, and a map that only ever grows is a leak however rare the case.
 * Dropping one loses the LINE and never a row, which is exactly what a failed
 * post already loses.
 */
const LEDGER_TTL_MS = 2 * 60 * 60_000;

/** The six `control_ui` verbs a room's canvas accepts. Everything else is refused. */
const CANVAS_VERBS = new Set<UiCommand['action']>([
  'open_canvas',
  'update_canvas',
  'close_canvas',
  'open_file',
  'open_diff',
  'browser_navigate',
]);

/**
 * What an agent is told when it reaches for a window action inside a room.
 *
 * Expressed against an ALLOW-list, so a twenty-third `control_ui` action is
 * refused by default rather than leaking onto somebody's private stream.
 */
export const NOT_IN_A_ROOM_MESSAGE =
  'That only works in a one-on-one session, not in a room. Rooms share a canvas, not a whole ' +
  'window — put a document on the canvas instead.';

/** What an agent is told when it opens the canvas in a room with nothing in it. */
export const OPEN_CANVAS_NEEDS_CONTENT_MESSAGE =
  'Opening the canvas by itself does nothing in a room. Pass the content you want the room to see.';

/** What an agent is told when a bare `update_canvas` has nothing to act on. */
export const NO_DEFAULT_DOCUMENT_MESSAGE =
  'You have not opened anything on this room’s canvas yet, so there is nothing to update. Open a ' +
  'document first, or pass the documentId of one that is already open.';

/**
 * What an agent is told when it has spent its canvas changes for this turn.
 *
 * @param limit - The ceiling in force right now, read live from settings.
 * @returns The sentence the model reads.
 */
export function tooManyCanvasOpsMessage(limit: number): string {
  return (
    `You have already changed the canvas ${limit} times in this conversation during this turn, ` +
    `which is the limit. Put the rest in one update next turn.`
  );
}

/**
 * What an agent is told when somebody is editing the document it aimed at.
 *
 * @param holder - How the person holding the lock is named.
 * @returns The sentence the model reads.
 */
export function documentBeingEditedMessage(holder: string): string {
  return `${holder} is editing that document right now, so your change was held. Try again in a moment, or say what you wanted to change.`;
}

/**
 * What `apply` answers with — never a fabricated success.
 *
 * A refusal carries both halves on purpose: `reason` is the sentence the model
 * reads, and `code` is the same refusal as a machine value, so a surface that
 * has to turn it into an HTTP status or a typed tool error does not have to
 * match on prose.
 */
export type CanvasApplyResult =
  | { applied: true; documentId: string; rev: number; viewers: number }
  | { applied: false; code: RoomErrorCode; reason: string };

/** One operation a turn applied, as the turn's coalesced entry reports it. */
export interface CanvasLedgerEntry {
  change: 'opened' | 'updated' | 'closed';
  documentId: string;
  type: string;
  title: string;
}

/** How a room's canvas reaches the rest of the server. */
export interface RoomCanvasDeps {
  /** The rows. */
  documents: CanvasDocumentStore;
  /** Who may see a room, and who is in it. */
  visibility: RoomVisibility;
  /** The room's live stream — where a `canvas` frame goes, and who is watching. */
  broadcaster: RoomBroadcaster;
  /** The per-turn ceiling, read PER CALL so a change in Settings binds the next operation. */
  maxOpsPerTurn: () => number;
  /**
   * Write one turn's coalesced entry into the room's log.
   *
   * Handed in rather than reached for, so the single write path into a room
   * stays {@link RoomService}'s — the same shape the merge service is given.
   */
  postCanvasEvent: (
    roomId: string,
    input: { text: string; canvas: RoomCanvasChange; subjectAuthorId: string }
  ) => void;
  /** How a member is named in the sentence that entry carries. */
  displayNameFor: (authorId: string) => string;
  /** The room's shared checkout, or `null` when the room has no files of its own. */
  roomRepoPath: (roomId: string) => string | null;
  /** The clock, so a lock's TTL is testable without waiting 45 seconds. */
  now?: () => number;
}

/** What `open` was given beyond the content itself. */
export interface CanvasOpenOptions {
  /** Pin it on creation. */
  pinned?: boolean;
  /** Where a file document's path was resolved, absolute. */
  resolvedCwd?: string | null;
  /** How that directory is described to a reader: `Ana's copy · 3 ahead of main`. */
  sourceLabel?: string | null;
}

/** A room's shared canvas — the table, the rules, and the one writer. */
export class RoomCanvasService {
  private readonly documents: CanvasDocumentStore;
  private readonly visibility: RoomVisibility;
  private readonly broadcaster: RoomBroadcaster;
  private readonly maxOpsPerTurn: () => number;
  private readonly postCanvasEvent: RoomCanvasDeps['postCanvasEvent'];
  private readonly displayNameFor: (authorId: string) => string;
  private readonly roomRepoPath: (roomId: string) => string | null;
  private readonly now: () => number;

  /**
   * What each turn has put on the table, keyed by the room turn's dispatch id.
   *
   * In-process and per turn, on purpose. A turn whose process dies never posts
   * its entry, which is correct: its rows are still there and the room's next
   * context reads them, so nothing is lost but one line in the log.
   */
  private readonly ledger = new Map<
    string,
    { roomId: string; authorId: string; ops: CanvasLedgerEntry[]; openedAt: number }
  >();

  /**
   * Turns whose line has already been posted, and when.
   *
   * A turn does not stop the moment its collector settles: the ceiling can give
   * up on a turn the agent is still running, and the spec allows that agent to
   * keep working. An operation that lands afterwards would otherwise open a
   * FRESH ledger entry nothing will ever close — a row with no line naming it,
   * and a map that grows for the life of the process. This set is how such an
   * operation is recognised, and {@link RoomCanvasService.record} posts its own
   * one-line entry on the spot instead of filing it.
   *
   * **It carries the turn's spend, not just its clock.** The ceiling is a
   * per-TURN budget, and a turn does not get a fresh one by ending: an agent
   * that spent all three operations in-turn and then keeps working must be
   * refused on its fourth exactly as it would have been on its fourth in-turn.
   * Remembering only the instant would reset the count to zero the moment the
   * line was posted, which is the ceiling deleting itself.
   *
   * Bounded twice: by age and by count. Neither bound loses a row.
   */
  private readonly closedTurns = new Map<string, { at: number; spent: number }>();

  /**
   * Build the service over its collaborators.
   *
   * @param deps - The rows, the rules and the stream. See {@link RoomCanvasDeps}.
   */
  constructor(deps: RoomCanvasDeps) {
    this.documents = deps.documents;
    this.visibility = deps.visibility;
    this.broadcaster = deps.broadcaster;
    this.maxOpsPerTurn = deps.maxOpsPerTurn;
    this.postCanvasEvent = deps.postCanvasEvent;
    this.displayNameFor = deps.displayNameFor;
    this.roomRepoPath = deps.roomRepoPath;
    this.now = deps.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // The agent path
  // -------------------------------------------------------------------------

  /**
   * Apply one `control_ui` command to a room's canvas — the single writer and
   * the single enforcement point (§5.1).
   *
   * The refusals run in this order, and the order matters: an archived room is
   * refused before the table is touched at all, and the ceiling is charged only
   * for an operation that would otherwise have gone through, so a caller that is
   * going to be refused for some other reason does not spend an allowance on the
   * way out.
   *
   * It NEVER throws for a refusal a model should read. A `RoomError` from the
   * visibility check — a room that does not exist, a caller who is not in it —
   * still throws, because that is a wiring fault rather than something the model
   * did.
   *
   * @param input.roomId - The room whose canvas this turn is in.
   * @param input.authorId - The acting member, resolved server-side.
   * @param input.turnId - The room turn's dispatch id; the ceiling is counted on it.
   * @param input.command - The validated `control_ui` command.
   * @param input.cwd - Where this turn is standing, so a document that names a
   *   FILE records the directory it was resolved against. Every later read
   *   resolves against that stored directory rather than re-deriving one, which
   *   is what makes §8.1's reader rule hold for a member who joined afterwards.
   * @param input.aheadOfMain - Commits this member's copy has that the room's
   *   `main` does not, measured once per turn by the code that already measures
   *   it. `null` — or absent — means NOT MEASURED, which is a different claim
   *   from "level with the room" and is stored as such.
   * @returns What was written, or the sentence explaining why nothing was.
   */
  apply(input: {
    roomId: string;
    authorId: string;
    turnId: string;
    command: UiCommand;
    cwd?: string;
    aheadOfMain?: number | null;
  }): CanvasApplyResult {
    const { roomId, authorId, turnId, command } = input;

    // Before the table is touched, and before an allowance is spent: an archived
    // room accepts nothing, in anybody's voice (§3.7).
    const room = this.visibility.requireRoom(roomId);
    if (room.archived) {
      return {
        applied: false,
        code: 'ROOM_ARCHIVED',
        reason: 'This room is archived, so its canvas cannot change.',
      };
    }
    if (!CANVAS_VERBS.has(command.action)) {
      return {
        applied: false,
        code: 'CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM',
        reason: NOT_IN_A_ROOM_MESSAGE,
      };
    }
    if (command.action === 'open_canvas' && command.content === undefined) {
      return {
        applied: false,
        code: 'CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM',
        reason: OPEN_CANVAS_NEEDS_CONTENT_MESSAGE,
      };
    }

    const plan = this.planFrom(roomId, authorId, command, input.cwd, input.aheadOfMain ?? null);
    if ('reason' in plan) {
      return { applied: false, code: 'CANVAS_NO_DEFAULT_DOCUMENT', reason: plan.reason };
    }

    const limit = this.maxOpsPerTurn();
    if (this.spentThisTurn(turnId) >= limit) {
      return {
        applied: false,
        code: 'TOO_MANY_CANVAS_OPS_THIS_TURN',
        reason: tooManyCanvasOpsMessage(limit),
      };
    }

    const held = this.lockHeldByAnother(plan.existing, authorId);
    if (held !== null) {
      return {
        applied: false,
        code: 'CANVAS_BEING_EDITED',
        reason: documentBeingEditedMessage(this.displayNameFor(held)),
      };
    }

    if (plan.kind === 'close') {
      const closed = plan.existing;
      this.documents.remove(roomId, closed.id);
      this.publish(roomId, { type: 'canvas', documentId: closed.id, closed: true });
      this.record(turnId, roomId, authorId, {
        change: 'closed',
        documentId: closed.id,
        type: closed.contentType,
        title: closed.title,
      });
      return {
        applied: true,
        documentId: closed.id,
        rev: closed.rev,
        viewers: this.viewers(roomId),
      };
    }

    const document = this.write(roomId, authorId, plan);
    this.record(turnId, roomId, authorId, {
      change: plan.existing ? 'updated' : 'opened',
      documentId: document.id,
      type: document.contentType,
      title: document.title,
    });
    return {
      applied: true,
      documentId: document.id,
      rev: document.rev,
      viewers: this.viewers(roomId),
    };
  }

  /**
   * Compose, post and clear one turn's coalesced entry (§6.2).
   *
   * Called once per turn from the collector's `finally`, so a turn the ceiling or
   * the deadline killed still reports what it put on the table. A turn that
   * applied nothing has no ledger and writes no entry — that absence is the
   * feature, not an omission.
   *
   * **It never throws.** Posting can fail (a room archived mid-turn, a busy
   * database), and a rejection here would surface out of a collector whose
   * `closed` promise is documented never to reject. A failure clears the ledger,
   * writes one log line, and leaves the rows exactly where they are; only the
   * line is lost, and the log says so.
   *
   * @param turnId - The room turn's dispatch id.
   */
  finishTurn(turnId: string): void {
    const turn = this.ledger.get(turnId);
    this.ledger.delete(turnId);
    this.markClosed(turnId, turn?.ops.length ?? 0);
    if (!turn || turn.ops.length === 0) return;
    this.postLine(turn.roomId, turn.authorId, turn.ops, turnId);
  }

  /**
   * What one turn has applied so far, for a caller that has to report it.
   *
   * @param turnId - The room turn's dispatch id.
   * @returns The operations, oldest first. Empty for a turn that applied nothing.
   */
  ledgerFor(turnId: string): readonly CanvasLedgerEntry[] {
    return this.ledger.get(turnId)?.ops ?? [];
  }

  // -------------------------------------------------------------------------
  // The human path
  // -------------------------------------------------------------------------

  /**
   * Put a document on a room's canvas, or refresh the one that is already there.
   *
   * @param roomId - The room.
   * @param authorId - Who is doing it; the route resolves this, never the caller.
   * @param content - What to show.
   * @param opts - Pinning, and where a file path was resolved.
   * @returns The document as every reader now has it.
   */
  open(
    roomId: string,
    authorId: string,
    content: UiCanvasContent,
    opts: CanvasOpenOptions = {}
  ): CanvasDocument {
    this.requireWritableRoom(roomId, authorId);
    const scope = roomScope(roomId);
    const sourceKey = canvasSourceKey(content);
    const existing = this.documents.findBySourceKey(scope, sourceKey);
    const held = this.lockHeldByAnother(existing, authorId);
    if (held !== null) {
      throw new RoomError(
        'CANVAS_BEING_EDITED',
        documentBeingEditedMessage(this.displayNameFor(held))
      );
    }
    const where = this.resolveTree(roomId, authorId, content, opts.resolvedCwd ?? undefined, null);
    return this.write(roomId, authorId, {
      kind: 'write',
      content,
      sourceKey,
      existing,
      pinned: opts.pinned ?? false,
      resolvedCwd: opts.resolvedCwd ?? null,
      sourceLabel: opts.sourceLabel ?? where.sourceLabel,
      treeKind: where.treeKind,
      aheadOfMain: where.aheadOfMain,
    });
  }

  /**
   * Replace one document's content.
   *
   * @param roomId - The room.
   * @param authorId - Who is doing it.
   * @param documentId - The document to replace.
   * @param content - What to put there instead.
   * @returns The document as every reader now has it.
   */
  update(
    roomId: string,
    authorId: string,
    documentId: string,
    content: UiCanvasContent
  ): CanvasDocument {
    this.requireWritableRoom(roomId, authorId);
    const existing = this.requireDocument(roomId, documentId);
    const held = this.lockHeldByAnother(existing, authorId);
    if (held !== null) {
      throw new RoomError(
        'CANVAS_BEING_EDITED',
        documentBeingEditedMessage(this.displayNameFor(held))
      );
    }
    return this.write(roomId, authorId, {
      kind: 'write',
      content,
      sourceKey: existing.sourceKey,
      existing,
      pinned: existing.pinned,
      resolvedCwd: existing.resolvedCwd,
      sourceLabel: existing.sourceLabel,
      treeKind: existing.treeKind,
      aheadOfMain: existing.aheadOfMain,
    });
  }

  /**
   * Take a document off the table.
   *
   * @param roomId - The room.
   * @param authorId - Who is doing it.
   * @param documentId - The document to close.
   */
  close(roomId: string, authorId: string, documentId: string): void {
    this.requireWritableRoom(roomId, authorId);
    this.requireDocument(roomId, documentId);
    this.documents.remove(roomId, documentId);
    this.publish(roomId, { type: 'canvas', documentId, closed: true });
  }

  /**
   * Bump a document's recency so it sorts to the front.
   *
   * **It changes nobody's tab.** Ordering on the server is not a remote-control
   * verb: a shared table that yanked everybody's view would be over-participation
   * one layer down.
   *
   * @param roomId - The room.
   * @param authorId - Who is doing it.
   * @param documentId - The document.
   * @returns The document as every reader now has it.
   */
  activate(roomId: string, authorId: string, documentId: string): CanvasDocument {
    this.requireWritableRoom(roomId, authorId);
    const existing = this.requireDocument(roomId, documentId);
    const at = new Date(this.now()).toISOString();
    const rev = this.documents.maxRev(roomId) + 1;
    this.documents.update(roomId, documentId, { rev, lastActiveAt: at });
    return this.publishDocument(roomId, { ...existing, rev, lastActiveAt: at }, 'activated');
  }

  /**
   * Pin a document so it sorts first and is never evicted, or unpin it.
   *
   * @param roomId - The room.
   * @param authorId - Who is doing it.
   * @param documentId - The document.
   * @param pinned - The state to land in.
   * @returns The document as every reader now has it.
   */
  pin(roomId: string, authorId: string, documentId: string, pinned: boolean): CanvasDocument {
    this.requireWritableRoom(roomId, authorId);
    const existing = this.requireDocument(roomId, documentId);
    const rev = this.documents.maxRev(roomId) + 1;
    this.documents.update(roomId, documentId, { rev, pinned });
    return this.publishDocument(roomId, { ...existing, rev, pinned }, 'pinned');
  }

  /**
   * Take, refresh or release the edit lock on one document (§3.5).
   *
   * The lock is what holds an agent's `update_canvas` back while a person is
   * typing — ADR `0292`'s rule, moved server-side so it binds every viewer rather
   * than one browser. It is cleared explicitly on save, on close and on
   * blur-with-no-changes, and lapses on its own 45 seconds after the last
   * heartbeat.
   *
   * @param roomId - The room.
   * @param authorId - Who is editing.
   * @param documentId - The document.
   * @param editing - `true` to take or refresh the lock, `false` to release it.
   * @returns Who holds the lock now, and when it lapses.
   */
  heartbeat(
    roomId: string,
    authorId: string,
    documentId: string,
    editing: boolean
  ): { editingBy: string | null; expiresAt: string | null } {
    this.requireWritableRoom(roomId, authorId);
    const existing = this.requireDocument(roomId, documentId);
    if (!editing) {
      // Only the holder may release it. A member who never held it releasing
      // somebody else's lock would be a way to walk over their edit.
      if (existing.editingBy === authorId) {
        this.documents.update(roomId, documentId, { editingBy: null, editingHeartbeatAt: null });
      }
      return { editingBy: null, expiresAt: null };
    }
    const held = this.lockHeldByAnother(existing, authorId);
    if (held !== null) {
      throw new RoomError(
        'CANVAS_BEING_EDITED',
        documentBeingEditedMessage(this.displayNameFor(held))
      );
    }
    const at = this.now();
    this.documents.update(roomId, documentId, {
      editingBy: authorId,
      editingHeartbeatAt: new Date(at).toISOString(),
    });
    return {
      editingBy: authorId,
      expiresAt: new Date(at + CANVAS_EDIT_TTL_MS).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Everything on a room's canvas, pinned first then most recently active.
   *
   * A READ, so it answers for an archived room exactly as it does for a live
   * one. That asymmetry is the whole point of archiving: the record survives,
   * the activity stops.
   *
   * @param roomId - The room.
   * @returns The room's documents.
   */
  list(roomId: string): CanvasDocument[] {
    const now = this.now();
    return this.documents.list(roomId).map((row) => toCanvasDocument(row, now, CANVAS_EDIT_TTL_MS));
  }

  /**
   * One document, content included.
   *
   * @param roomId - The room.
   * @param documentId - The document.
   * @returns The document, or `null` when the room does not hold it.
   */
  get(roomId: string, documentId: string): CanvasDocument | null {
    const row = this.documents.get(roomId, documentId);
    return row ? toCanvasDocument(row, this.now(), CANVAS_EDIT_TTL_MS) : null;
  }

  /**
   * This author's own most recently opened-or-updated document here (§5.6).
   *
   * @param roomId - The room.
   * @param authorId - The member asking.
   * @returns The document, or `null` when they have opened nothing here.
   */
  lastDocumentFor(roomId: string, authorId: string): CanvasDocument | null {
    const row = this.documents.lastTouchedBy(roomId, authorId);
    return row ? toCanvasDocument(row, this.now(), CANVAS_EDIT_TTL_MS) : null;
  }

  /**
   * How many people are looking at this room right now (§3.6).
   *
   * It counts **live readers of this room's stream**, so one person with two tabs
   * open counts twice and an agent counts zero — agents do not subscribe. The
   * tool result and the teaching both say exactly that, because a number that
   * looks like a headcount and is not would be worse than no number.
   *
   * @param roomId - The room.
   * @returns The live subscriber count.
   */
  viewers(roomId: string): number {
    return this.broadcaster.subscriberCount(roomId);
  }

  /**
   * Every live document as its own `canvas` frame — the canvas resync a stream
   * resume sends (§2).
   *
   * The exact parallel of the reaction resync, and authoritative as a SET: a
   * client REPLACES its table from it rather than merging, which is what makes a
   * close it missed while disconnected self-correct. Because a close is a
   * deletion, nothing else could.
   *
   * @param roomId - The room.
   * @returns One frame per live document.
   */
  resync(roomId: string): RoomEvent[] {
    return this.list(roomId).map((document) => ({
      type: 'canvas' as const,
      documentId: document.id,
      document,
    }));
  }

  /**
   * The directory a file document's path was resolved against, as the row
   * recorded it — `null` when the row records none.
   *
   * The one thing a reader needs beyond {@link RoomCanvasService.mayReadContent}
   * to actually open the file: the same directory the boundary check ran against
   * at OPEN time is the one it must run against now, so a document opened in one
   * tree can never later be read against another.
   *
   * @param roomId - The room.
   * @param documentId - The document.
   * @returns The absolute directory, or `null`.
   */
  resolvedTreeOf(roomId: string, documentId: string): string | null {
    return this.documents.get(roomId, documentId)?.resolvedCwd ?? null;
  }

  /**
   * Whether this reader may be handed a document's CONTENT, or only its
   * metadata (§8.1).
   *
   * **The property, stated once:** a canvas document never lets a member read a
   * tree they could not already read. Otherwise "open a document" would be a
   * cross-tree read primitive with a friendlier name.
   *
   * It is evaluated on the READER, at read time, against the directory the row
   * recorded — never on the writer at open time — which is what makes it hold for
   * a member who joined after the document was opened.
   *
   * - A document that names no file has no tree to protect, so everybody who can
   *   see the room can read it.
   * - In a room with files of its own, a document under the room's SHARED
   *   checkout is readable by every member: they can already read it.
   * - Otherwise the reader gets content only when the document resolved against
   *   their own directory.
   *
   * @param document - The stored row.
   * @param readerCwd - Where the reader is working, or `undefined` when the
   *   surface does not carry one — which reads as "nowhere", never as "anywhere".
   * @returns Whether content may be returned.
   */
  mayReadContent(document: CanvasDocument, readerCwd: string | undefined): boolean {
    const row = this.documents.get(document.roomId, document.id);
    if (!row || row.resolvedCwd === null) return true;
    const repoPath = this.roomRepoPath(document.roomId);
    if (repoPath !== null && isWithin(row.resolvedCwd, repoPath)) return true;
    if (readerCwd === undefined) return false;
    return isWithin(row.resolvedCwd, readerCwd);
  }

  /**
   * How many turns this service is holding state for.
   *
   * @internal Exported for testing only. The four bounds — an age and a count on
   * each of the two maps — are the claim, and a test that could not read the
   * sizes could only assert whatever behaviour happens to follow from them.
   */
  bookkeepingSize(): { openLedgers: number; rememberedTurns: number } {
    return { openLedgers: this.ledger.size, rememberedTurns: this.closedTurns.size };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Refuse a caller who is not a member, and a room that accepts no writes. */
  private requireWritableRoom(roomId: string, authorId: string): void {
    const room = this.visibility.requireMembership(roomId, authorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
  }

  /** Fetch a document or refuse, scoped to its room so ids do not cross rooms. */
  private requireDocument(roomId: string, documentId: string): CanvasDocumentRow {
    const row = this.documents.get(roomId, documentId);
    if (!row) {
      throw new RoomError('CANVAS_DOCUMENT_NOT_FOUND', 'No such document on this room’s canvas');
    }
    return row;
  }

  /**
   * Who is holding a live edit lock on this document, when it is not the caller.
   *
   * `null` covers all three innocent cases: no document yet, nobody editing, and
   * the caller holding their own lock.
   */
  private lockHeldByAnother(row: CanvasDocumentRow | null, authorId: string): string | null {
    if (!row || row.editingBy === authorId) return null;
    return this.lockHolder(row);
  }

  /**
   * Who is holding a LIVE edit lock on this document, whoever they are.
   *
   * The TTL is what makes it live: a heartbeat older than the window is not a
   * lock, evaluated here and nowhere else so there is one answer to "is somebody
   * editing this".
   */
  private lockHolder(row: CanvasDocumentRow): string | null {
    if (row.editingBy === null) return null;
    const heldAt = row.editingHeartbeatAt ? Date.parse(row.editingHeartbeatAt) : NaN;
    if (!Number.isFinite(heldAt) || this.now() - heldAt >= CANVAS_EDIT_TTL_MS) return null;
    return row.editingBy;
  }

  /**
   * Which directory a file document was resolved against, and how that is
   * described to a reader (§8).
   *
   * A room has no working directory of its own, so a file document has to record
   * one. It records the directory the TURN was standing in, which is the agent's
   * own copy of the room's files in a project room and its own project
   * otherwise — the tree the agent actually read the file out of. Recording the
   * room's shared checkout instead would name a path the agent never looked at.
   *
   * The label says whose copy it is whenever that is not the room's own, because
   * the other members can see the tab and may not be able to open it.
   *
   * @param roomId - The room.
   * @param authorId - Who is opening it.
   * @param content - The content being opened.
   * @param cwd - Where the turn is standing, when the caller knows.
   * @returns The directory to record and the label to show, or nulls.
   */
  private resolveTree(
    roomId: string,
    authorId: string,
    content: UiCanvasContent,
    cwd: string | undefined,
    aheadOfMain: number | null
  ): {
    resolvedCwd: string | null;
    sourceLabel: string | null;
    treeKind: CanvasDocumentRow['treeKind'];
    aheadOfMain: number | null;
  } {
    if (canvasSourcePath(content) === null || cwd === undefined) {
      return { resolvedCwd: null, sourceLabel: null, treeKind: null, aheadOfMain: null };
    }
    const repoPath = this.roomRepoPath(roomId);
    if (repoPath !== null && isWithin(cwd, repoPath)) {
      // The room's own shared copy. Every member can already read it, so there
      // is nothing to warn anybody about and no count to carry — being ahead of
      // `main` is a thing a WORKING COPY is, and this is `main`.
      return { resolvedCwd: cwd, sourceLabel: null, treeKind: 'room-main', aheadOfMain: null };
    }
    const who = this.displayNameFor(authorId);
    if (repoPath === null) {
      // A room with no files of its own: this is somebody's own project, and
      // nothing here is measured against anything.
      return {
        resolvedCwd: cwd,
        sourceLabel: `in ${who}'s project`,
        treeKind: 'agent-cwd',
        aheadOfMain: null,
      };
    }
    // A member's own working copy of the room's files. The count is a SNAPSHOT
    // taken when the document was opened, and `null` says nobody measured —
    // which is why the label drops the count rather than printing a zero.
    return {
      resolvedCwd: cwd,
      sourceLabel:
        aheadOfMain !== null && aheadOfMain > 0
          ? `${who}'s copy · ${aheadOfMain} ahead of main`
          : `${who}'s copy`,
      treeKind: 'worktree',
      aheadOfMain,
    };
  }

  /**
   * Turn a validated canvas command into the write it implies, or the sentence
   * saying why there is nothing to write.
   *
   * This is where the §5.6 default lives: a verb that names no document acts on
   * the author's OWN last one, which is the only default that cannot act on
   * somebody else's work by accident.
   */
  private planFrom(
    roomId: string,
    authorId: string,
    command: UiCommand,
    cwd: string | undefined,
    aheadOfMain: number | null
  ): CanvasWritePlan | CanvasClosePlan | { reason: string } {
    // The four OPENING verbs resolve by dedupe key: two agents opening one file
    // land on one row, which is what makes the table a table.
    if (command.action !== 'update_canvas' && command.action !== 'close_canvas') {
      const content = contentFor(command);
      if (content === null) return { reason: OPEN_CANVAS_NEEDS_CONTENT_MESSAGE };
      const sourceKey = canvasSourceKey(content);
      const existing = this.documents.findBySourceKey(roomScope(roomId), sourceKey);
      const where = this.resolveTree(roomId, authorId, content, cwd, aheadOfMain);
      return {
        kind: 'write',
        content,
        sourceKey,
        existing,
        pinned: existing?.pinned ?? false,
        resolvedCwd: where.resolvedCwd ?? existing?.resolvedCwd ?? null,
        sourceLabel: where.sourceLabel ?? existing?.sourceLabel ?? null,
        treeKind: where.treeKind ?? existing?.treeKind ?? null,
        aheadOfMain: where.treeKind !== null ? where.aheadOfMain : (existing?.aheadOfMain ?? null),
      };
    }

    // The two verbs that name a document resolve the same way, and it is the
    // §5.6 rule: the id they were given, else this author's OWN last document,
    // else a plain refusal. Never the room's most recent document whoever opened
    // it — that default silently edits somebody else's work.
    const target =
      command.documentId !== undefined
        ? this.documents.get(roomId, command.documentId)
        : this.documents.lastTouchedBy(roomId, authorId);
    if (!target) return { reason: NO_DEFAULT_DOCUMENT_MESSAGE };
    if (command.action === 'close_canvas') return { kind: 'close', existing: target };
    return {
      kind: 'write',
      content: command.content,
      // **The row keeps its own dedupe key.** An update names a document and
      // replaces what is in it; re-keying the row on the new content would let
      // one update collide with another document's key, and would quietly move a
      // tab everybody is looking at onto a different identity.
      sourceKey: target.sourceKey,
      existing: target,
      pinned: target.pinned,
      resolvedCwd: target.resolvedCwd,
      sourceLabel: target.sourceLabel,
      treeKind: target.treeKind,
      aheadOfMain: target.aheadOfMain,
    };
  }

  /** Insert or refresh one row, evict down to capacity, and publish the frame. */
  private write(roomId: string, authorId: string, plan: CanvasWritePlan): CanvasDocument {
    const at = new Date(this.now()).toISOString();
    const rev = this.documents.maxRev(roomId) + 1;
    const title = canvasTitle(plan.content);
    if (plan.existing) {
      this.documents.update(roomId, plan.existing.id, {
        content: plan.content,
        title,
        contentType: plan.content.type,
        rev,
        lastTouchedBy: authorId,
        lastTouchedAt: at,
        lastActiveAt: at,
        ...(plan.resolvedCwd !== null ? { resolvedCwd: plan.resolvedCwd } : {}),
        ...(plan.sourceLabel !== null ? { sourceLabel: plan.sourceLabel } : {}),
        ...(plan.treeKind !== null
          ? { treeKind: plan.treeKind, aheadOfMain: plan.aheadOfMain }
          : {}),
      });
      const row: CanvasDocumentRow = {
        ...plan.existing,
        content: plan.content,
        title,
        contentType: plan.content.type,
        rev,
        lastTouchedBy: authorId,
        lastTouchedAt: at,
        lastActiveAt: at,
        resolvedCwd: plan.resolvedCwd ?? plan.existing.resolvedCwd,
        sourceLabel: plan.sourceLabel ?? plan.existing.sourceLabel,
        treeKind: plan.treeKind ?? plan.existing.treeKind,
        aheadOfMain: plan.treeKind !== null ? plan.aheadOfMain : plan.existing.aheadOfMain,
      };
      return this.publishDocument(roomId, row, 'updated');
    }
    const scope = roomScope(roomId);
    const row: CanvasDocumentRow = {
      id: canvasDocumentId(scope, plan.sourceKey),
      scope,
      roomId,
      content: plan.content,
      title,
      contentType: plan.content.type,
      authorId,
      sourceKey: plan.sourceKey,
      sourceLabel: plan.sourceLabel,
      resolvedCwd: plan.resolvedCwd,
      treeKind: plan.treeKind,
      aheadOfMain: plan.aheadOfMain,
      pinned: plan.pinned,
      rev,
      lastTouchedBy: authorId,
      lastTouchedAt: at,
      editingBy: null,
      editingHeartbeatAt: null,
      openedAt: at,
      lastActiveAt: at,
    };
    this.documents.insert(row);
    this.evict(roomId, row.id);
    return this.publishDocument(roomId, row, 'opened');
  }

  /**
   * Drop the least recently active unpinned documents until the room is back
   * under its ceiling, publishing a `closed` frame for each.
   *
   * Three carve-outs, and each one is a document somebody is relying on: the row
   * that was just written, anything pinned, and anything under a live edit lock.
   * Publishing the close is what keeps a viewer from holding a row the server
   * has dropped.
   */
  private evict(roomId: string, protectedId: string): void {
    const over = this.documents.unpinnedCount(roomId) - MAX_ROOM_CANVAS_DOCUMENTS;
    if (over <= 0) return;
    const candidates = this.documents
      .evictionCandidates(roomId)
      .filter((row) => row.id !== protectedId && this.lockHolder(row) === null);
    for (const row of candidates.slice(0, over)) {
      this.documents.remove(roomId, row.id);
      this.publish(roomId, { type: 'canvas', documentId: row.id, closed: true });
    }
  }

  /** Publish one document's whole current state and hand it back. */
  private publishDocument(
    roomId: string,
    row: CanvasDocumentRow,
    change: 'opened' | 'updated' | 'activated' | 'pinned'
  ): CanvasDocument {
    const document = toCanvasDocument(row, this.now(), CANVAS_EDIT_TTL_MS);
    this.publish(roomId, { type: 'canvas', documentId: document.id, document, change });
    return document;
  }

  /** Fan one frame out to this room's live readers. */
  private publish(roomId: string, event: RoomEvent): void {
    this.broadcaster.publish(roomId, event);
  }

  /** Append one applied operation to its turn's ledger. */
  private record(turnId: string, roomId: string, authorId: string, entry: CanvasLedgerEntry): void {
    // **An operation that arrives after its turn's line was already posted gets
    // its own line, now.** Filing it would open a ledger entry nothing will ever
    // close: the collector has settled, so nothing will call `finishTurn` again,
    // and the row would sit on the table with nothing in the log naming it.
    // Posting immediately keeps the invariant this whole design turns on — every
    // applied operation is named exactly once.
    const closed = this.closedTurns.get(turnId);
    if (closed !== undefined) {
      // Charged before it is announced, so the turn's budget keeps shrinking
      // while it keeps working. `apply` refused it already if there was nothing
      // left, so anything reaching here is inside the ceiling.
      closed.spent += 1;
      this.postLine(roomId, authorId, [entry], turnId);
      return;
    }
    const turn = this.ledger.get(turnId) ?? {
      roomId,
      authorId,
      ops: [],
      openedAt: this.now(),
    };
    turn.ops.push(entry);
    this.ledger.set(turnId, turn);
    // AFTER the write, and told which turn it must not drop. Pruning first would
    // leave the map one over its bound for as long as this turn is open, and a
    // bound that is only true between calls is not one.
    this.expireStaleLedgers(turnId);
  }

  /**
   * Write one canvas line into the room's log, or say in the log why it could
   * not be.
   *
   * Never throws. Posting can fail — a room archived mid-turn, a busy database —
   * and a rejection out of here would surface from a collector whose `closed`
   * promise is documented never to reject. The rows stay either way; only the
   * line is lost, and the log says so.
   */
  private postLine(
    roomId: string,
    authorId: string,
    ops: readonly CanvasLedgerEntry[],
    turnId: string
  ): void {
    try {
      this.postCanvasEvent(roomId, {
        text: canvasChangeSentence(this.displayNameFor(authorId), ops),
        canvas: { ops: [...ops] },
        subjectAuthorId: authorId,
      });
    } catch (err) {
      logger.warn('[rooms] could not post a turn’s canvas line; the documents are still there', {
        roomId,
        turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Remember that this turn's line has been posted, and forget the oldest such
   * memories so the set cannot grow for the life of the process.
   *
   * Two bounds rather than one. The age bound is the honest one — past it, a
   * turn that is still running is not a turn any more — and the count bound is
   * the one that holds when a machine is busy enough that ages alone would not
   * prune fast enough.
   */
  private markClosed(turnId: string, spent: number): void {
    const at = this.now();
    // ADDED to whatever is already there, never assigned over it. `finishTurn`
    // runs from a `finally` and a room turn can reach one more than once; an
    // assignment would let the second, empty call hand the turn a fresh budget.
    const already = this.closedTurns.get(turnId)?.spent ?? 0;
    this.closedTurns.set(turnId, { at, spent: already + spent });
    for (const [id, record] of this.closedTurns) {
      if (at - record.at >= CLOSED_TURN_MEMORY_MS) this.closedTurns.delete(id);
    }
    // Insertion order is close order, so the front of the map is the oldest.
    while (this.closedTurns.size > MAX_REMEMBERED_CLOSED_TURNS) {
      const oldest = this.closedTurns.keys().next().value;
      if (oldest === undefined) break;
      this.closedTurns.delete(oldest);
    }
  }

  /**
   * Drop any OPEN ledger nobody ever closed.
   *
   * The other half of the bound. `finishTurn` is called from the collector's
   * `finally`, so it runs for every turn the room dispatched — but a turn whose
   * process died, or one applied through a path that never had a collector, has
   * no such call coming. Its rows are already on the table and stay there; what
   * is dropped is the line, which is the same thing a failed post loses, and the
   * log says which turn it was.
   *
   * @param keep - The turn being written right now, which is never the one
   *   dropped. Without it a turn whose ledger is the oldest in the map would
   *   have the entry it just filed thrown away underneath it.
   */
  private expireStaleLedgers(keep?: string): void {
    const at = this.now();
    for (const [id, turn] of this.ledger) {
      if (at - turn.openedAt < LEDGER_TTL_MS) continue;
      this.ledger.delete(id);
      logger.warn('[rooms] gave up on a canvas line for a turn that never closed', {
        roomId: turn.roomId,
        turnId: id,
        ops: turn.ops.length,
      });
    }
    // Insertion order is open order, so the front of the map is the oldest.
    while (this.ledger.size > MAX_OPEN_LEDGERS) {
      const oldest = [...this.ledger.keys()].find((id) => id !== keep);
      if (oldest === undefined) break;
      const turn = this.ledger.get(oldest);
      this.ledger.delete(oldest);
      logger.warn('[rooms] dropped the oldest open canvas ledger to stay bounded', {
        roomId: turn?.roomId,
        turnId: oldest,
        ops: turn?.ops.length ?? 0,
      });
    }
  }

  /**
   * How much of its ceiling one turn has already spent — what it applied while
   * it was open, plus what it has applied since its line went out.
   *
   * The two halves have to be added rather than chosen between: the open ledger
   * is emptied at `finishTurn`, so reading it alone says zero for every turn
   * that has ended, and the ceiling would rearm itself the instant the line was
   * posted.
   *
   * @param turnId - The room turn's dispatch id.
   * @returns Operations charged to this turn so far.
   */
  private spentThisTurn(turnId: string): number {
    return (this.closedTurns.get(turnId)?.spent ?? 0) + (this.ledger.get(turnId)?.ops.length ?? 0);
  }
}

/** A write this command implies: fresh row, or a refresh of one that exists. */
interface CanvasWritePlan {
  kind: 'write';
  content: UiCanvasContent;
  sourceKey: string | null;
  existing: CanvasDocumentRow | null;
  pinned: boolean;
  resolvedCwd: string | null;
  sourceLabel: string | null;
  /** Which tree the path was resolved against, or `null` for a non-file document. */
  treeKind: CanvasDocumentRow['treeKind'];
  /** The open-time ahead count for a working copy; `null` means not measured. */
  aheadOfMain: number | null;
}

/** A close this command implies, with the row it resolved to. */
interface CanvasClosePlan {
  kind: 'close';
  existing: CanvasDocumentRow;
}

/** The scope string one room's documents live under. */
export function roomScope(roomId: string): string {
  return `room:${roomId}`;
}

/**
 * The content a canvas verb carries, or `null` for one that names a document
 * instead.
 *
 * `open_file`, `open_diff` and `browser_navigate` are content in disguise: each
 * is one shape of `UiCanvasContent` with the fields spelled differently, and
 * turning them into it here is what lets one writer serve all six verbs.
 *
 * @param command - The validated command.
 * @returns The content to write, or `null`.
 */
function contentFor(command: UiCommand): UiCanvasContent | null {
  switch (command.action) {
    case 'open_canvas':
      return command.content ?? null;
    case 'update_canvas':
      return command.content;
    case 'open_file':
      return { type: 'file', sourcePath: command.sourcePath };
    case 'open_diff':
      return { type: 'diff', sourcePath: command.sourcePath };
    case 'browser_navigate':
      return { type: 'browser', url: command.url };
    default:
      return null;
  }
}

/**
 * The one line a person reads in the room's log for a whole turn's canvas work.
 *
 * Written for a person, not for a machine: the machine-readable half rides
 * `body.canvas` beside it. It names at most two documents and then counts the
 * rest, because a turn that opened six things should read as a sentence rather
 * than as a list.
 *
 * @param author - How the acting member is named.
 * @param ops - What the turn applied, oldest first.
 * @returns The sentence.
 */
export function canvasChangeSentence(author: string, ops: readonly CanvasLedgerEntry[]): string {
  const verbs = { opened: 'opened', updated: 'updated', closed: 'closed' } as const;
  const named = ops.slice(0, 2).map((op) => `${verbs[op.change]} ${op.title}`);
  const rest = ops.length - named.length;
  const list = named.join(' and ');
  return rest > 0
    ? `${author} ${list}, and changed ${rest} more thing${rest === 1 ? '' : 's'} on the canvas.`
    : `${author} ${list} on the canvas.`;
}

/**
 * Whether one absolute directory sits inside another, or is it.
 *
 * A path comparison rather than a filesystem one, deliberately: it runs on every
 * `read_canvas` and must not touch the disk. The separator check is what stops
 * `/work/agent-two` reading as being inside `/work/agent`.
 *
 * @param child - The directory being tested.
 * @param parent - The directory it must be within.
 * @returns Whether `child` is `parent` or below it.
 */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}
