/**
 * The one writer for every canvas on this machine — a room's shared table and a
 * person's own session canvas (specs `room-canvas` §3, `canvas-agent-seat` §1.2).
 *
 * ## One writer, two scopes
 *
 * {@link CanvasService.apply} is the single place an agent's canvas command
 * becomes a row, whichever scope it lands in, and it is **synchronous** — not a
 * style choice. The `control_ui` handler returns to the model on the same call
 * stack, so a bound enforced anywhere later would be refusing an operation the
 * tool had already reported as successful, which is a silent drop rather than a
 * bound.
 *
 * ## What is shared, and what is a ROOM's
 *
 * Everything here is about the table: dedupe, the LRU, the edit lock, `rev`
 * ordering, and publishing. Everything a ROOM adds on top lives in
 * `RoomCanvasService` and reaches this class through two callbacks —
 * `chargeCeiling` (the per-turn ceiling) and `record` (the ledger that composes
 * one coalesced line per turn). A session scope passes neither, and that is a
 * decision rather than an omission:
 *
 * - **No per-turn ceiling.** A canvas change in a room costs every other
 *   member's attention. A session canvas has an audience of one, who asked for
 *   the turn, and whose window has never had a per-turn cap. The LRU is the only
 *   bound it needs, which is the bound it has always had.
 * - **No ledger.** A room composes one durable line per turn so its history
 *   records what happened. A session's history is its transcript, which already
 *   records every `control_ui` call as a tool call with its result. Inventing a
 *   session-side notice would put a second, weaker record beside it.
 *
 * ## It never triggers anything
 *
 * A canvas change wakes nobody (ADR `260911-200302`). Members learn about it in
 * their next turn's context and in one coalesced line; a session's other windows
 * learn about it from the `canvas` event on the session's own stream.
 *
 * @module server/services/canvas/canvas-service
 */
import type { DbTransaction } from '@dorkos/db';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { canvasViewForContent } from '@dorkos/shared/canvas-view';
import { canvasContentForFile } from '@dorkos/shared/viewer-registry';
import type { UiCanvasContent, UiCommand } from '@dorkos/shared/schemas';
import { logger } from '../../lib/logger.js';
// The typed refusals, imported from the rooms domain's LEAF error module rather
// than restated here. It imports nothing back, so there is no cycle — and one
// refusal vocabulary means a route maps a canvas failure onto a status code the
// same way whichever scope produced it.
import { RoomError, type RoomErrorCode } from '../rooms/room-errors.js';
import {
  toCanvasDocument,
  type CanvasDocumentRow,
  type CanvasDocumentStore,
} from './canvas-document-store.js';
import { canvasDocumentId, canvasSourceKey, canvasTitle } from './document-key.js';
import { roomIdForScope } from './scopes.js';

/**
 * How many unpinned documents one canvas holds before the least recently active
 * is dropped to make room.
 *
 * The same number for both scopes, because it is the same surface and a room
 * whose strip behaved differently from a session's would be two rules to learn.
 * Pinned documents are neither counted nor evicted.
 */
export const MAX_CANVAS_DOCUMENTS = 12;

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

/** The six `control_ui` verbs that change a canvas. Everything else is refused. */
export const CANVAS_VERBS = new Set<UiCommand['action']>([
  'open_canvas',
  'update_canvas',
  'close_canvas',
  'open_file',
  'open_diff',
  'browser_navigate',
]);

/** What an agent is told when it opens the canvas with nothing in it. */
export const OPEN_CANVAS_NEEDS_CONTENT_MESSAGE =
  'Opening the canvas by itself does nothing in a room. Pass the content you want the room to see.';

/** What an agent is told when a bare `update_canvas` has nothing to act on. */
export const NO_DEFAULT_DOCUMENT_MESSAGE =
  'You have not opened anything on this room’s canvas yet, so there is nothing to update. Open a ' +
  'document first, or pass the documentId of one that is already open.';

/** What an agent is told when a bare `update_canvas` in a SESSION has no target. */
export const NOTHING_ON_THE_CANVAS_MESSAGE =
  'There is nothing on the canvas to update. Open something first, or pass the documentId of a ' +
  'document that is already open.';

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
 * One frame announcing a change to a canvas.
 *
 * Deliberately the shape BOTH streams carry: a room's `canvas` event and a
 * session's are field-for-field identical (spec `canvas-agent-seat` §1.3), so
 * one frame travels to whichever channel the scope names and one client reducer
 * reads it either way.
 */
export interface CanvasFrame {
  /** Always `canvas`; both streams discriminate on it. */
  type: 'canvas';
  /** The document this frame is about. */
  documentId: string;
  /** The document's WHOLE current state. Absent when `closed`. */
  document?: CanvasDocument;
  /** True when the document was closed and every viewer should drop it. */
  closed?: boolean;
  /** Which write produced it. */
  change?: 'opened' | 'updated' | 'activated' | 'pinned';
}

/**
 * How a canvas change reaches the people watching a scope.
 *
 * The one thing that genuinely differs between the two scopes: a room frame goes
 * to the room's broadcaster, a session frame is ingested by that session's
 * projector. Injected rather than branched on inside the service, so this file
 * imports neither domain.
 */
export interface CanvasChannels {
  /** Fan one frame out to everybody watching this scope. */
  publish(scope: string, frame: CanvasFrame): void;
  /** How many windows are reading this scope right now. */
  viewers(scope: string): number;
}

/**
 * Where a file document's path was resolved, and how that is described.
 *
 * Resolved by the CALLER, because the answer is a room's question: which of the
 * room's trees this is, and whose copy. A session has one directory and no
 * labels, so it passes its own `resolvedCwd` and nulls for the rest.
 */
export interface CanvasTreePlacement {
  /** The absolute directory the path was resolved against, or `null`. */
  resolvedCwd: string | null;
  /** How that directory is described to a reader, or `null`. */
  sourceLabel: string | null;
  /** WHICH tree it is, for the label a reader is shown. */
  treeKind: CanvasDocumentRow['treeKind'];
  /** Open-time ahead count for a working copy; `null` means not measured. */
  aheadOfMain: number | null;
}

/** A placement for content that names no file, and for a scope with no trees. */
const NO_TREE: CanvasTreePlacement = {
  resolvedCwd: null,
  sourceLabel: null,
  treeKind: null,
  aheadOfMain: null,
};

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

/** One operation a turn applied, as a room's coalesced entry reports it. */
export interface CanvasLedgerEntry {
  change: 'opened' | 'updated' | 'closed';
  documentId: string;
  type: string;
  title: string;
}

/**
 * Which document a verb that names none acts on.
 *
 * - `author-last` — the author's OWN most recently touched document. A room's
 *   rule (spec `room-canvas` §5.6): the only default that cannot act on somebody
 *   else's work by accident.
 * - `active-in-view` — the most recently active document of the view the content
 *   belongs to. A session's rule, and today's behaviour unchanged: a session has
 *   one front document per view, and that is what an agent's bare
 *   `update_canvas` has always landed on.
 */
export type CanvasDefaultTarget = 'author-last' | 'active-in-view';

/** How a canvas reaches the rest of the server. */
export interface CanvasDeps {
  /** The rows. */
  documents: CanvasDocumentStore;
  /** Where a frame goes, and who is watching. */
  channels: CanvasChannels;
  /** How the holder of an edit lock is named in the sentence an agent reads. */
  displayNameFor?: (authorId: string) => string;
  /**
   * Extension → viewer overrides, read PER CALL so a change in Settings binds
   * the next open (`workbench.defaultViewers`).
   *
   * The client is handed the same map, and both sides resolve through
   * `canvasContentForFile` — which is what keeps an agent's `open_file` and a
   * person's landing on one document rather than two.
   */
  viewerOverrides?: () => Record<string, string> | undefined;
  /** The clock, so a lock's TTL is testable without waiting 45 seconds. */
  now?: () => number;
}

/** What `open` was given beyond the content itself. */
export interface CanvasOpenOptions {
  /** Pin it on creation. */
  pinned?: boolean;
  /** Where a file document's path resolved, and how it is labelled. */
  tree?: CanvasTreePlacement;
}

/** Every canvas on this machine — the table, the shared rules, the one writer. */
export class CanvasService {
  private readonly documents: CanvasDocumentStore;
  private readonly channels: CanvasChannels;
  private readonly displayNameFor: (authorId: string) => string;
  private readonly viewerOverrides: () => Record<string, string> | undefined;
  private readonly now: () => number;

  /**
   * Sessions a runtime has reported gone, waiting for the sweep to confirm it.
   *
   * A mark, never a verdict (spec `canvas-agent-seat` §Data model 6). The report
   * is a signal: a session that comes back between the mark and the sweep is not
   * purged, and the sweep asks a second time before deleting anything.
   */
  private readonly orphanedSessions = new Set<string>();

  /**
   * Build the service over its collaborators.
   *
   * @param deps - The rows and the channels. See {@link CanvasDeps}.
   */
  constructor(deps: CanvasDeps) {
    this.documents = deps.documents;
    this.channels = deps.channels;
    this.displayNameFor = deps.displayNameFor ?? (() => 'Somebody');
    this.viewerOverrides = deps.viewerOverrides ?? (() => undefined);
    this.now = deps.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // The agent path
  // -------------------------------------------------------------------------

  /**
   * Apply one `control_ui` command to a canvas — the single writer, whichever
   * scope it lands in.
   *
   * The refusals run in this order and the order matters: the caller's own
   * policy has already run (an archived room, a verb a room refuses), and the
   * ceiling is charged only for an operation that would otherwise have gone
   * through, so a caller about to be refused for some other reason does not
   * spend an allowance on the way out.
   *
   * It NEVER throws for a refusal a model should read.
   *
   * @param input.scope - Whose canvas this is — `room:<id>` or `session:<id>`.
   * @param input.authorId - The acting member, resolved server-side.
   * @param input.command - The validated `control_ui` command.
   * @param input.tree - Where a file path resolved, when the caller knows.
   * @param input.defaultTarget - Which document a verb naming none acts on.
   * @param input.chargeCeiling - A room's per-turn ceiling. Returns a refusal
   *   when this operation would exceed it, and `null` when it may proceed. A
   *   session passes none, because it has no audience to protect.
   * @param input.record - A room's ledger. Called once per applied operation. A
   *   session passes none: its transcript already records the call.
   * @returns What was written, or the sentence explaining why nothing was.
   */
  apply(input: {
    scope: string;
    authorId: string;
    command: UiCommand;
    tree?: CanvasTreePlacement;
    defaultTarget?: CanvasDefaultTarget;
    chargeCeiling?: () => { code: RoomErrorCode; reason: string } | null;
    record?: (entry: CanvasLedgerEntry) => void;
  }): CanvasApplyResult {
    const { scope, authorId, command } = input;
    if (!CANVAS_VERBS.has(command.action)) {
      // Defensive: both callers filter first, and a verb that reached here
      // anyway must not become a row nobody asked for.
      return {
        applied: false,
        code: 'CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM',
        reason: 'That is not something that can be put on a canvas.',
      };
    }

    const plan = this.planFrom(
      scope,
      authorId,
      command,
      input.tree ?? NO_TREE,
      input.defaultTarget ?? 'author-last'
    );
    if ('reason' in plan) {
      return { applied: false, code: 'CANVAS_NO_DEFAULT_DOCUMENT', reason: plan.reason };
    }

    const overCeiling = input.chargeCeiling?.() ?? null;
    if (overCeiling !== null) {
      return { applied: false, code: overCeiling.code, reason: overCeiling.reason };
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
      this.documents.remove(scope, closed.id);
      this.publish(scope, { type: 'canvas', documentId: closed.id, closed: true });
      input.record?.({
        change: 'closed',
        documentId: closed.id,
        type: closed.contentType,
        title: closed.title,
      });
      return {
        applied: true,
        documentId: closed.id,
        rev: closed.rev,
        viewers: this.viewers(scope),
      };
    }

    const document = this.write(scope, authorId, plan);
    input.record?.({
      change: plan.existing ? 'updated' : 'opened',
      documentId: document.id,
      type: document.contentType,
      title: document.title,
    });
    return {
      applied: true,
      documentId: document.id,
      rev: document.rev,
      viewers: this.viewers(scope),
    };
  }

  /**
   * The content one canvas verb implies, with this install's viewer overrides
   * applied — the same answer `apply` will reach.
   *
   * Exposed so a CALLER that has to look at the content before delegating (the
   * room flavour resolves which tree a file came out of; the claude-code handler
   * decides whether to record a directory at all) asks the same question the
   * writer will, rather than calling the pure helper without the overrides and
   * getting a different shape for the same file.
   *
   * @param command - The validated command.
   * @returns The content, or `null` for a verb that names a document instead.
   */
  contentForCommand(command: UiCommand): UiCanvasContent | null {
    return contentFor(command, this.viewerOverrides());
  }

  // -------------------------------------------------------------------------
  // The human path
  // -------------------------------------------------------------------------

  /**
   * Put a document on a canvas, or refresh the one that is already there.
   *
   * @param scope - Whose canvas.
   * @param authorId - Who is doing it; the caller resolves this server-side.
   * @param content - What to show.
   * @param opts - Pinning, and where a file path resolved.
   * @returns The document as every reader now has it.
   * @throws {RoomError} `CANVAS_BEING_EDITED` when somebody else is typing in it.
   */
  open(
    scope: string,
    authorId: string,
    content: UiCanvasContent,
    opts: CanvasOpenOptions = {}
  ): CanvasDocument {
    const sourceKey = canvasSourceKey(content);
    const existing = this.documents.findBySourceKey(scope, sourceKey);
    const held = this.lockHeldByAnother(existing, authorId);
    if (held !== null) {
      throw new RoomError(
        'CANVAS_BEING_EDITED',
        documentBeingEditedMessage(this.displayNameFor(held))
      );
    }
    const tree = opts.tree ?? NO_TREE;
    return this.write(scope, authorId, {
      kind: 'write',
      content,
      sourceKey,
      existing,
      pinned: opts.pinned ?? false,
      ...tree,
    });
  }

  /**
   * Replace one document's content.
   *
   * @param scope - Whose canvas.
   * @param authorId - Who is doing it.
   * @param documentId - The document to replace.
   * @param content - What to put there instead.
   * @returns The document as every reader now has it.
   * @throws {RoomError} When the document is gone or somebody else holds its lock.
   */
  update(
    scope: string,
    authorId: string,
    documentId: string,
    content: UiCanvasContent
  ): CanvasDocument {
    const existing = this.requireDocument(scope, documentId);
    const held = this.lockHeldByAnother(existing, authorId);
    if (held !== null) {
      throw new RoomError(
        'CANVAS_BEING_EDITED',
        documentBeingEditedMessage(this.displayNameFor(held))
      );
    }
    return this.write(scope, authorId, {
      kind: 'write',
      content,
      // **The row keeps its own dedupe key.** An update names a document and
      // replaces what is in it; re-keying it on the new content would let one
      // update collide with another document's key, and would quietly move a tab
      // everybody is looking at onto a different identity.
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
   * @param scope - Whose canvas.
   * @param documentId - The document to close.
   * @throws {RoomError} `CANVAS_DOCUMENT_NOT_FOUND` when this scope does not hold it.
   */
  close(scope: string, documentId: string): void {
    this.requireDocument(scope, documentId);
    this.documents.remove(scope, documentId);
    this.publish(scope, { type: 'canvas', documentId, closed: true });
  }

  /**
   * Bump a document's recency so it sorts to the front.
   *
   * **It changes nobody else's tab.** Ordering on the server is not a
   * remote-control verb: a shared table that yanked everybody's view would be
   * over-participation one layer down.
   *
   * @param scope - Whose canvas.
   * @param documentId - The document.
   * @returns The document as every reader now has it.
   * @throws {RoomError} `CANVAS_DOCUMENT_NOT_FOUND` when this scope does not hold it.
   */
  activate(scope: string, documentId: string): CanvasDocument {
    const existing = this.requireDocument(scope, documentId);
    const at = new Date(this.now()).toISOString();
    const rev = this.documents.maxRev(scope) + 1;
    this.documents.update(scope, documentId, { rev, lastActiveAt: at });
    return this.publishDocument(scope, { ...existing, rev, lastActiveAt: at }, 'activated');
  }

  /**
   * Pin a document so it sorts first and is never evicted, or unpin it.
   *
   * @param scope - Whose canvas.
   * @param documentId - The document.
   * @param pinned - The state to land in.
   * @returns The document as every reader now has it.
   * @throws {RoomError} `CANVAS_DOCUMENT_NOT_FOUND` when this scope does not hold it.
   */
  pin(scope: string, documentId: string, pinned: boolean): CanvasDocument {
    const existing = this.requireDocument(scope, documentId);
    const rev = this.documents.maxRev(scope) + 1;
    this.documents.update(scope, documentId, { rev, pinned });
    return this.publishDocument(scope, { ...existing, rev, pinned }, 'pinned');
  }

  /**
   * Take, refresh or release the edit lock on one document.
   *
   * The lock is what holds an agent's `update_canvas` back while a person is
   * typing — ADR `0292`'s rule, server-side so it binds every viewer rather than
   * one browser. It is cleared explicitly on save, on close and on
   * blur-with-no-changes, and lapses on its own 45 seconds after the last
   * heartbeat.
   *
   * @param scope - Whose canvas.
   * @param authorId - Who is editing.
   * @param documentId - The document.
   * @param editing - `true` to take or refresh the lock, `false` to release it.
   * @returns Who holds the lock now, and when it lapses.
   * @throws {RoomError} When the document is gone or somebody else holds its lock.
   */
  heartbeat(
    scope: string,
    authorId: string,
    documentId: string,
    editing: boolean
  ): { editingBy: string | null; expiresAt: string | null } {
    const existing = this.requireDocument(scope, documentId);
    if (!editing) {
      // Only the holder may release it. A member who never held it releasing
      // somebody else's lock would be a way to walk over their edit.
      if (existing.editingBy === authorId) {
        this.documents.update(scope, documentId, { editingBy: null, editingHeartbeatAt: null });
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
    this.documents.update(scope, documentId, {
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
   * Everything on one canvas, pinned first then most recently active.
   *
   * A READ, so it answers for an archived room exactly as it does for a live
   * one. That asymmetry is the whole point of archiving: the record survives,
   * the activity stops.
   *
   * @param scope - Whose canvas.
   * @returns The scope's documents.
   */
  list(scope: string): CanvasDocument[] {
    const now = this.now();
    return this.documents.list(scope).map((row) => toCanvasDocument(row, now, CANVAS_EDIT_TTL_MS));
  }

  /**
   * One document, content included.
   *
   * @param scope - Whose canvas.
   * @param documentId - The document.
   * @returns The document, or `null` when this scope does not hold it.
   */
  get(scope: string, documentId: string): CanvasDocument | null {
    const row = this.documents.get(scope, documentId);
    return row ? toCanvasDocument(row, this.now(), CANVAS_EDIT_TTL_MS) : null;
  }

  /**
   * Record which room entry heads this document's discussion, inside the
   * transaction that is writing the entry (spec `canvas-agent-seat` §7).
   *
   * **Takes the transaction, so the column and the entry land together.** A
   * thread root in the log with no column beside it means the next "Discuss"
   * starts a second thread on the same document; a column pointing at an entry
   * that was never written opens an empty panel. Neither half is allowed to
   * exist alone, and one transaction is what makes that structural rather than
   * a thing two code paths have to remember.
   *
   * **No frame, and no `rev` bump.** Nothing on anybody's screen is drawn from
   * this column: whether a second Discuss opens the existing thread is decided
   * by the SERVER reading the row, so a viewer holding a copy that predates the
   * thread still lands in the right place. Publishing here would be a frame
   * that changes no pixel, at the cost of a revision every stale reader has to
   * catch up to.
   *
   * @param tx - The transaction the root entry is being appended in.
   * @param scope - Whose canvas.
   * @param documentId - The document being discussed.
   * @param entryId - The entry heading the thread.
   */
  attachThreadRoot(tx: DbTransaction, scope: string, documentId: string, entryId: string): void {
    this.documents.setThreadRoot(tx, scope, documentId, entryId);
  }

  /**
   * This author's own most recently opened-or-updated document here.
   *
   * @param scope - Whose canvas.
   * @param authorId - The member asking.
   * @returns The document, or `null` when they have opened nothing here.
   */
  lastDocumentFor(scope: string, authorId: string): CanvasDocument | null {
    const row = this.documents.lastTouchedBy(scope, authorId);
    return row ? toCanvasDocument(row, this.now(), CANVAS_EDIT_TTL_MS) : null;
  }

  /**
   * How many windows are reading this canvas right now.
   *
   * Windows, not people: one person with two tabs counts twice and an agent
   * counts zero, because agents do not subscribe. Every surface that prints the
   * number says exactly that, because a number that looks like a headcount and
   * is not would be worse than no number.
   *
   * @param scope - Whose canvas.
   * @returns The live reader count.
   */
  viewers(scope: string): number {
    return this.channels.viewers(scope);
  }

  /**
   * Every live document as its own frame — the canvas resync a room's stream
   * resume sends (spec `room-canvas` §2).
   *
   * Authoritative as a SET: a client REPLACES its table from it rather than
   * merging, which is what makes a close it missed while disconnected
   * self-correct. A SESSION stream needs none of this — every one of its events
   * carries a `seq` and is replayed from the ring — which is why the method is
   * called by the room stream alone.
   *
   * @param scope - Whose canvas.
   * @returns One frame per live document.
   */
  resync(scope: string): CanvasFrame[] {
    return this.list(scope).map((document) => ({
      type: 'canvas' as const,
      documentId: document.id,
      document,
    }));
  }

  /**
   * The directory a file document's path was resolved against, as the row
   * recorded it — `null` when the row records none.
   *
   * The same directory the boundary check ran against at OPEN time is the one it
   * must run against now, so a document opened in one tree can never later be
   * read against another.
   *
   * @param scope - Whose canvas.
   * @param documentId - The document.
   * @returns The absolute directory, or `null`.
   */
  resolvedTreeOf(scope: string, documentId: string): string | null {
    return this.documents.get(scope, documentId)?.resolvedCwd ?? null;
  }

  /**
   * Whether this reader may be handed a document's CONTENT, or only its
   * metadata (spec `room-canvas` §8.1).
   *
   * **The property, stated once:** a canvas document never lets a reader read a
   * tree they could not already read. Otherwise "open a document" would be a
   * cross-tree read primitive with a friendlier name.
   *
   * It is evaluated on the READER, at read time, against the directory the row
   * recorded — never on the writer at open time — which is what makes it hold
   * for a room member who joined after the document was opened.
   *
   * @param scope - Whose canvas.
   * @param documentId - The document.
   * @param readerCwd - Where the reader is working, or `undefined` when the
   *   surface does not carry one — which reads as "nowhere", never as "anywhere".
   * @param sharedTreePath - A tree every reader of this scope can already read
   *   (a room's own checkout), or `null` when there is none.
   * @returns Whether content may be returned.
   */
  mayReadContent(
    scope: string,
    documentId: string,
    readerCwd: string | undefined,
    sharedTreePath: string | null
  ): boolean {
    const row = this.documents.get(scope, documentId);
    if (!row || row.resolvedCwd === null) return true;
    if (sharedTreePath !== null && isWithin(row.resolvedCwd, sharedTreePath)) return true;
    if (readerCwd === undefined) return false;
    return isWithin(row.resolvedCwd, readerCwd);
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Move every row of one scope to another, in one transaction.
   *
   * The trap the session canvas turns on: a brand-new session's documents are
   * written under the request UUID the client minted, and the SDK renames the
   * session mid-first-turn. Wired at module scope in this domain's `index.ts`,
   * so the embedded shell — which never runs `index.ts` — gets it too.
   *
   * It does NOT republish. A rekeying session is mid-first-turn and its reader
   * re-hydrates from the snapshot under the new id.
   *
   * @param from - The scope to move out of.
   * @param to - The scope to move into.
   * @returns How many rows moved. `0` is the common case.
   */
  rekeyScope(from: string, to: string): number {
    if (from === to) return 0;
    const moved = this.documents.rekeyScope(from, to);
    if (moved > 0) {
      logger.info('[canvas] carried a canvas across a session rekey', { from, to, moved });
    }
    return moved;
  }

  /**
   * Record that a runtime has reported a session gone, so the sweep can reclaim
   * its canvas.
   *
   * Keyed on ORPHANING — no runtime has this conversation any more — and
   * deliberately NOT on in-memory eviction. An evicted session is still real: it
   * comes back the moment somebody opens it, and its canvas must come back too.
   *
   * @param sessionId - The session a runtime reported removed.
   */
  noteSessionOrphaned(sessionId: string): void {
    this.orphanedSessions.add(sessionId);
  }

  /**
   * Delete the canvas of every session that really has gone away.
   *
   * Two-phase on purpose (spec `canvas-agent-seat` §Data model 6). The mark is a
   * signal; this is the verdict, and it asks a second time before deleting
   * anything, so a session that came back between the two is spared.
   *
   * **It skips any runtime that degraded in the listing.** `GET /api/sessions`
   * degrades per runtime (ADR-0310), and a runtime that failed to list is a
   * runtime whose sessions ALL look absent — so one flaky sidecar would
   * otherwise delete every canvas it owns. A listing that failed outright sweeps
   * nothing at all.
   *
   * @param listing - What the session listing says: the live sessions with the
   *   runtime each belongs to, and the runtimes that degraded. `null` means the
   *   listing itself failed.
   * @returns How many documents were deleted.
   */
  sweepOrphanedCanvasDocuments(
    listing: {
      sessions: readonly { id: string; runtime?: string | undefined }[];
      degradedRuntimes: readonly string[];
    } | null
  ): number {
    if (this.orphanedSessions.size === 0) return 0;
    if (listing === null) {
      logger.warn('[canvas] skipped the orphan sweep: the session listing failed', {
        marked: this.orphanedSessions.size,
      });
      return 0;
    }
    const degraded = new Set(listing.degradedRuntimes);
    const live = new Map(listing.sessions.map((s) => [s.id, s.runtime]));
    let deleted = 0;
    for (const sessionId of [...this.orphanedSessions]) {
      const runtime = live.get(sessionId);
      if (runtime !== undefined) {
        // It came back. The mark was a signal, not a verdict.
        this.orphanedSessions.delete(sessionId);
        continue;
      }
      // Absent — but absent from a listing a degraded runtime did not contribute
      // to says nothing. The mark stays for a healthier pass.
      if (degraded.size > 0) continue;
      this.orphanedSessions.delete(sessionId);
      deleted += this.documents.removeScope(`session:${sessionId}`);
    }
    return deleted;
  }

  /**
   * How many sessions are marked as gone but not yet swept.
   *
   * @internal Exported for testing only. The two-phase rule is the claim, and a
   * test that could not read the mark set could only assert whatever behaviour
   * happens to follow from it.
   */
  orphanMarkCount(): number {
    return this.orphanedSessions.size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Fetch a document or refuse, scoped so ids never cross tables. */
  private requireDocument(scope: string, documentId: string): CanvasDocumentRow {
    const row = this.documents.get(scope, documentId);
    if (!row) {
      throw new RoomError('CANVAS_DOCUMENT_NOT_FOUND', 'No such document on this canvas');
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
   * Turn a validated canvas command into the write it implies, or the sentence
   * saying why there is nothing to write.
   */
  private planFrom(
    scope: string,
    authorId: string,
    command: UiCommand,
    tree: CanvasTreePlacement,
    defaultTarget: CanvasDefaultTarget
  ): CanvasWritePlan | CanvasClosePlan | { reason: string } {
    // The four OPENING verbs resolve by dedupe key: two agents opening one file
    // land on one row, which is what makes the table a table.
    if (command.action !== 'update_canvas' && command.action !== 'close_canvas') {
      const content = contentFor(command, this.viewerOverrides());
      if (content === null) return { reason: OPEN_CANVAS_NEEDS_CONTENT_MESSAGE };
      const sourceKey = canvasSourceKey(content);
      const existing = this.documents.findBySourceKey(scope, sourceKey);
      return {
        kind: 'write',
        content,
        sourceKey,
        existing,
        pinned: existing?.pinned ?? false,
        resolvedCwd: tree.resolvedCwd ?? existing?.resolvedCwd ?? null,
        sourceLabel: tree.sourceLabel ?? existing?.sourceLabel ?? null,
        treeKind: tree.treeKind ?? existing?.treeKind ?? null,
        aheadOfMain: tree.treeKind !== null ? tree.aheadOfMain : (existing?.aheadOfMain ?? null),
      };
    }

    const target =
      command.documentId !== undefined
        ? this.documents.get(scope, command.documentId)
        : this.defaultTargetFor(scope, authorId, command, defaultTarget);
    if (!target) {
      return {
        reason:
          defaultTarget === 'active-in-view'
            ? NOTHING_ON_THE_CANVAS_MESSAGE
            : NO_DEFAULT_DOCUMENT_MESSAGE,
      };
    }
    if (command.action === 'close_canvas') return { kind: 'close', existing: target };
    return {
      kind: 'write',
      content: command.content,
      sourceKey: target.sourceKey,
      existing: target,
      pinned: target.pinned,
      resolvedCwd: target.resolvedCwd,
      sourceLabel: target.sourceLabel,
      treeKind: target.treeKind,
      aheadOfMain: target.aheadOfMain,
    };
  }

  /**
   * The document a verb that names none acts on — a room's rule, or a session's.
   *
   * A room has no shared active document by design, so the only default that
   * cannot edit somebody else's work is the author's own last one. A session has
   * exactly one front document per view, which is what an agent's bare
   * `update_canvas` has always landed on — so the session default reads the
   * table the same way its window does, rather than inventing a second answer.
   */
  private defaultTargetFor(
    scope: string,
    authorId: string,
    command: Extract<UiCommand, { action: 'update_canvas' | 'close_canvas' }>,
    defaultTarget: CanvasDefaultTarget
  ): CanvasDocumentRow | null {
    if (defaultTarget === 'author-last') return this.documents.lastTouchedBy(scope, authorId);
    const view =
      command.action === 'update_canvas' ? canvasViewForContent(command.content) : undefined;
    // `list` is already pinned-first then most-recently-active, and pinning does
    // not make a document the front one — so recency alone decides here.
    const rows = this.documents
      .list(scope)
      .filter((row) => view === undefined || canvasViewForContent(row.content) === view)
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
    return rows[0] ?? null;
  }

  /** Insert or refresh one row, evict down to capacity, and publish the frame. */
  private write(scope: string, authorId: string, plan: CanvasWritePlan): CanvasDocument {
    const at = new Date(this.now()).toISOString();
    const rev = this.documents.maxRev(scope) + 1;
    const title = canvasTitle(plan.content);
    if (plan.existing) {
      this.documents.update(scope, plan.existing.id, {
        content: plan.content,
        title,
        contentType: plan.content.type,
        rev,
        lastTouchedBy: authorId,
        lastTouchedAt: at,
        lastActiveAt: at,
        // `pinned` is deliberately NOT rewritten on a refresh: a document
        // somebody pinned stays pinned when an agent updates it, and an `open`
        // that re-finds it does not silently unpin it either.
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
      return this.publishDocument(scope, row, 'updated');
    }
    const row: CanvasDocumentRow = {
      id: canvasDocumentId(scope, plan.sourceKey),
      scope,
      // The invariant, applied in the one place a row is born.
      roomId: roomIdForScope(scope),
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
      // A document is born without a discussion; the first Discuss writes this.
      threadRootEntryId: null,
    };
    this.documents.insert(row);
    this.evict(scope, row.id);
    return this.publishDocument(scope, row, 'opened');
  }

  /**
   * Drop the least recently active unpinned documents until the scope is back
   * under its ceiling, publishing a `closed` frame for each.
   *
   * Three carve-outs, and each one is a document somebody is relying on: the row
   * that was just written, anything pinned, and anything under a live edit lock.
   * Publishing the close is what keeps a viewer from holding a row the server
   * has dropped.
   */
  private evict(scope: string, protectedId: string): void {
    const over = this.documents.unpinnedCount(scope) - MAX_CANVAS_DOCUMENTS;
    if (over <= 0) return;
    // The front document of each view is never evictable (DOR-2006 review,
    // finding 10a). `lastActiveAt` moves when a document is opened or activated
    // and NOT when the reader switches tabs, so the page somebody is sitting on
    // in Browser goes stale the moment twelve documents open in Canvas — and a
    // plain LRU takes the one document on screen. The window's own optimistic
    // bound has protected those two ids since the canvas was client-side; the
    // rule belongs HERE now, over the table, so the two sides drop the same row
    // rather than each dropping a different one.
    const onScreen = frontOfViewIds(this.documents.list(scope));
    const candidates = this.documents
      .evictionCandidates(scope)
      .filter(
        (row) => row.id !== protectedId && !onScreen.has(row.id) && this.lockHolder(row) === null
      );
    for (const row of candidates.slice(0, over)) {
      this.documents.remove(scope, row.id);
      this.publish(scope, { type: 'canvas', documentId: row.id, closed: true });
    }
  }

  /** Publish one document's whole current state and hand it back. */
  private publishDocument(
    scope: string,
    row: CanvasDocumentRow,
    change: 'opened' | 'updated' | 'activated' | 'pinned'
  ): CanvasDocument {
    const document = toCanvasDocument(row, this.now(), CANVAS_EDIT_TTL_MS);
    this.publish(scope, { type: 'canvas', documentId: document.id, document, change });
    return document;
  }

  /** Fan one frame out to this scope's live readers. */
  private publish(scope: string, frame: CanvasFrame): void {
    this.channels.publish(scope, frame);
  }
}

/** A write this command implies: fresh row, or a refresh of one that exists. */
interface CanvasWritePlan extends CanvasTreePlacement {
  kind: 'write';
  content: UiCanvasContent;
  sourceKey: string | null;
  existing: CanvasDocumentRow | null;
  pinned: boolean;
}

/**
 * The id of the front document of each view — at most one per view.
 *
 * **One rule, read by both the LRU and the report.** `get_ui_state`'s `active`
 * flag and the eviction's "never take the tab somebody is looking at" are the
 * same question, and they used to be two copies of it: the window protected the
 * two on-screen ids and the server protected none, so a thirteenth open had
 * each side drop a different row and left the window missing one until the next
 * hydrate.
 *
 * "Front" is the most recently ACTIVE document of that view, which is the rule
 * the window draws by. Pinning sorts a document first; it does not make it the
 * one on screen.
 *
 * @param rows - Every document in one scope.
 * @returns The front id of each view that has one.
 */
export function frontOfViewIds(
  rows: readonly { id: string; content: UiCanvasContent; lastActiveAt: string }[]
): Set<string> {
  const ids = new Set<string>();
  for (const view of ['canvas', 'browser'] as const) {
    const front = rows
      .filter((row) => canvasViewForContent(row.content) === view)
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))[0];
    if (front) ids.add(front.id);
  }
  return ids;
}

/** A close this command implies, with the row it resolved to. */
interface CanvasClosePlan {
  kind: 'close';
  existing: CanvasDocumentRow;
}

/**
 * The content a canvas verb carries, or `null` for one that names a document
 * instead.
 *
 * `open_file`, `open_diff` and `browser_navigate` are content in disguise: each
 * is one shape of `UiCanvasContent` with the fields spelled differently, and
 * turning them into it here is what lets one writer serve all six verbs.
 *
 * **`open_file` resolves its VIEWER here**, through the same shared function the
 * client's dispatcher calls. It used to resolve on the client alone, so once the
 * server started writing an agent's `open_file` the two disagreed: the agent's
 * `chart.png` became a bare `file` document that loads a PNG into a text editor,
 * and a person opening the same file wrote `{type:'image'}` — a different
 * `sourceKey`, so one file grew two tabs.
 *
 * @param command - The validated command.
 * @param viewerOverrides - Extension → viewer overrides from
 *   `workbench.defaultViewers`, so a person who told DorkOS to open CSVs
 *   differently gets that answer from the agent's opens too.
 * @returns The content to write, or `null`.
 */
export function contentFor(
  command: UiCommand,
  viewerOverrides?: Record<string, string>
): UiCanvasContent | null {
  switch (command.action) {
    case 'open_canvas':
      return command.content ?? null;
    case 'update_canvas':
      return command.content;
    case 'open_file':
      return canvasContentForFile(command.sourcePath, viewerOverrides);
    case 'open_diff':
      return { type: 'diff', sourcePath: command.sourcePath };
    case 'browser_navigate':
      return { type: 'browser', url: command.url };
    default:
      return null;
  }
}

/**
 * Whether one absolute directory sits inside another, or is it.
 *
 * A path comparison rather than a filesystem one, deliberately: it runs on every
 * canvas read and must not touch the disk. The separator check is what stops
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
