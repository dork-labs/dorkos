import type { DbTransaction } from '@dorkos/db';
import type { CanvasChannelDeclaration } from '@dorkos/shared/canvas-channel-schemas';
import type { RoomCanvasChange } from '@dorkos/shared/room-schemas';
import type { CanvasService } from '../../canvas/index.js';
import type { RoomVisibility } from '../service/room-visibility.js';
import type { RoomBroadcaster } from '../room-stream.js';

/** How a room's canvas reaches the rest of the server. */
export interface RoomCanvasDeps {
  /** The one writer, shared with every other scope. */
  canvas: CanvasService;
  /** Who may see a room, and who is in it. */
  visibility: RoomVisibility;
  /** The room's live stream — who is watching. */
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
    input: { text: string; canvas: RoomCanvasChange; subjectAuthorId: string },
    bind?: (tx: DbTransaction, entryId: string) => void
  ) => { id: string } | void;
  /** How a member is named in the sentence that entry carries. */
  displayNameFor: (authorId: string) => string;
  /** The room's shared checkout, or `null` when the room has no files of its own. */
  roomRepoPath: (roomId: string) => string | null;
  /** The clock, so a lock's TTL is testable without waiting 45 seconds. */
  now?: () => number;
}

/** What `open` was given beyond the content itself. */
export interface CanvasOpenOptions {
  channel?: CanvasChannelDeclaration;
  /** Pin it on creation. */
  pinned?: boolean;
  /** Where a file document's path was resolved, absolute. */
  resolvedCwd?: string | null;
  /** How that directory is described to a reader: `Ana's copy · 3 ahead of main`. */
  sourceLabel?: string | null;
}
