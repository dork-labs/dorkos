/**
 * The quiet line in a new channel's empty state that says it has a `ROOM.md`
 * (DOR-3477).
 *
 * @module widgets/room-view/ui/empty-state/RoomMdHint
 */
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { revealCanvas } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';

/** The file a channel's shared notes live in, at the root of its files. */
const ROOM_MD = 'ROOM.md';

/**
 * The room's pinned `ROOM.md` on its canvas, if it has one.
 *
 * Pinned AND named, because the server pins exactly this document when a room
 * gets its files, and a person could put some other `ROOM.md`-named file down
 * by hand without it being the room's notes.
 *
 * @param documents - The room's canvas table.
 */
export function pinnedRoomMd(
  documents: readonly CanvasDocument[] | undefined
): CanvasDocument | undefined {
  return documents?.find(
    (doc) => doc.pinned && doc.content.type === 'file' && doc.content.sourcePath === ROOM_MD
  );
}

/** What {@link RoomMdHint} needs to find the room's notes. */
export interface RoomMdHintProps {
  /** The room on screen. */
  roomId: string;
}

/**
 * Say a channel has a `ROOM.md`, with **Open** to show it on the canvas.
 *
 * **In place of the canvas opening by itself.** A new channel pins its
 * `ROOM.md`, but a fresh channel should land on its empty conversation: a
 * template beside it is noise before anyone has said a word. So the canvas
 * stays shut and this one line is the way to the notes. Opening it is a press,
 * so the Canvas tab is remembered the way any picked tab is.
 *
 * @param props - The room on screen.
 */
export function RoomMdHint({ roomId }: RoomMdHintProps) {
  const roomMd = useAppStore((s) => pinnedRoomMd(s.roomCanvasDocuments[roomId]));
  if (!roomMd) return null;

  const open = () => {
    const store = useAppStore.getState();
    store.activateRoomCanvasDocument(roomId, roomMd.id);
    revealCanvas(store, 'user');
  };

  return (
    <p className="max-w-sm text-xs" data-testid="room-md-hint">
      This channel has a ROOM.md for its goal and rules.{' '}
      <button
        type="button"
        onClick={open}
        className="text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        Open
      </button>
    </p>
  );
}
