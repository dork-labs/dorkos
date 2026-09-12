/**
 * The writes a person makes to a room's table, and the edit lock that protects
 * their typing while they make them (spec `room-canvas` §9.5, §10).
 *
 * Every write here is one durable `canvas` frame with the person as its author,
 * and **nothing here writes local state**: the answer comes back on the room's
 * own stream, for this viewer and every other one at the same moment. That is
 * the whole difference between a shared table and a private canvas, so a hook
 * that optimistically patched the slice would be quietly reintroducing the thing
 * this feature exists to remove.
 *
 * Nothing is owner-only. Every member of the room can put something on the
 * table, change it, pin it and take it off: the room is the unit of trust.
 *
 * @module features/canvas/model/use-room-canvas
 */
import { useCallback, useEffect } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTransport } from '@/layers/shared/model';

/**
 * How often a person who is typing tells the server they are still there.
 *
 * The lock lapses on its own at 45 s, evaluated lazily with no timer anywhere,
 * so three missed beats is what it takes — a browser that crashed mid-edit stops
 * being a lock rather than wedging the document forever.
 */
export const CANVAS_EDIT_HEARTBEAT_MS = 15_000;

/** What a person can do to a room's table. Each REJECTS when the room refused. */
export interface RoomCanvasActions {
  /** Put something on the table as yourself. */
  open: (content: UiCanvasContent) => Promise<void>;
  /** Replace what one document shows. */
  update: (documentId: string, content: UiCanvasContent) => Promise<void>;
  /** Pin a document so it sorts first and is never dropped to make room, or unpin it. */
  pin: (documentId: string, pinned: boolean) => Promise<void>;
  /** Take a document off the table, for everybody. */
  close: (documentId: string) => Promise<void>;
}

/**
 * The sentence a person reads when the room refused a write.
 *
 * **The server's own words, wherever it has any.** Its refusals already say the
 * thing that matters and say it plainly — "This room is archived", "No such
 * document on this room's canvas" — so restating them here would mean
 * maintaining two vocabularies and shipping the vaguer one. That is also what
 * covers an archived room without a second check: the door is refused where it
 * is pressed, in the room's own words, rather than pre-greyed on a flag this
 * surface would have to fetch and keep current.
 *
 * Only a failure with nothing to quote — the network went away mid-click — gets
 * a sentence of its own.
 *
 * @param error - Whatever the write rejected with.
 * @returns One sentence, always.
 */
export function roomCanvasRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if (message.length > 0) return message;
  return 'DorkOS couldn’t reach the server. Check your connection and try again.';
}

/**
 * The four writes, bound to one room.
 *
 * **Each one rejects rather than swallowing.** They used to log to the console
 * and return, which made a refused close look exactly like a slow one: the tab
 * stayed, nothing was said, and the person pressed it again. Every caller now
 * has to decide what the person sees — a toast where they pressed a control, a
 * sentence under the field where they typed — and none of them may decide
 * "nothing".
 *
 * @param roomId - The room whose table these act on.
 * @returns The four writes.
 */
export function useRoomCanvasActions(roomId: string): RoomCanvasActions {
  const transport = useTransport();

  return {
    open: useCallback(
      async (content) => {
        await transport.openRoomCanvasDocument(roomId, content);
      },
      [transport, roomId]
    ),
    update: useCallback(
      async (documentId, content) => {
        await transport.updateRoomCanvasDocument(roomId, documentId, { content });
      },
      [transport, roomId]
    ),
    pin: useCallback(
      async (documentId, pinned) => {
        await transport.updateRoomCanvasDocument(roomId, documentId, { pinned });
      },
      [transport, roomId]
    ),
    close: useCallback(
      async (documentId) => {
        await transport.closeRoomCanvasDocument(roomId, documentId);
      },
      [transport, roomId]
    ),
  };
}

/**
 * Hold the edit lock on one room canvas document for as long as somebody is
 * typing in it.
 *
 * Taken the moment editing begins and refreshed every
 * {@link CANVAS_EDIT_HEARTBEAT_MS}; released when the edit ends, when the
 * document changes under the editor, and when the editor unmounts — a save, a
 * close, a tab switch, or the panel going away are all the same event to this
 * hook, which is why it watches the flag rather than being called from each of
 * those places.
 *
 * While it stands, an agent's update to the same document is HELD and the agent
 * is told so rather than reporting success. It is per-document on purpose: other
 * documents on the table stay agent-writable while one person types.
 *
 * @param roomId - The room.
 * @param documentId - The document being edited, or null when nobody is.
 */
export function useRoomCanvasEditLock(roomId: string, documentId: string | null): void {
  const transport = useTransport();
  const setEditing = useAppStore((s) => s.setRoomCanvasEditing);

  // `documentId` is in the dependency list, so the cleanup that releases a lock
  // always closes over the document it was TAKEN on — switching documents runs
  // the old effect's cleanup before the new one's body.
  useEffect(() => {
    setEditing(roomId, documentId);
    if (documentId === null) return;

    const beat = (editing: boolean) => {
      void transport.setRoomCanvasEditing(roomId, documentId, editing).catch((err) => {
        console.warn('[room-canvas] edit lock failed', { roomId, documentId, err });
      });
    };

    beat(true);
    const timer = setInterval(() => beat(true), CANVAS_EDIT_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      beat(false);
      setEditing(roomId, null);
    };
  }, [transport, roomId, documentId, setEditing]);
}

/**
 * How long a reader has to settle on a tab before the room is told.
 *
 * Arrow-keying along a strip of eight tabs is one decision, not eight. Short
 * enough that a deliberate switch feels immediate.
 */
export const CANVAS_VIEWING_DEBOUNCE_MS = 400;

/**
 * Tell the room which of its canvas documents this viewer is looking at.
 *
 * **One statement per change, and nothing while nothing changes.** There is no
 * heartbeat: the server publishes only when the answer is different from the one
 * it already has, so an open canvas costs the room no traffic at all. What
 * replaces the heartbeat is the stream cycle — every reconnect wipes the room's
 * faces and re-states this viewer's own, which is what keeps a face from
 * outliving the person it belongs to after a crash.
 *
 * Looking away is expressed by the cleanup: switching documents, switching tabs,
 * closing the panel and leaving the room all unmount this, and each one sends
 * the `null`.
 *
 * @param roomId - The room.
 * @param documentId - The document on screen, or null when none is.
 */
export function useRoomCanvasViewing(roomId: string, documentId: string | null): void {
  const transport = useTransport();
  const epoch = useAppStore((s) => s.roomCanvasPresenceEpoch[roomId] ?? 0);

  useEffect(() => {
    const say = (id: string | null) => {
      void transport.setRoomCanvasViewing(roomId, id).catch((err) => {
        // Nothing a person can act on: a face that did not appear is invisible
        // by definition, and a retry loop over a surface this ephemeral would
        // spend traffic on a fact that is already going stale.
        console.warn('[room-canvas] could not say where we are looking', { roomId, err });
      });
    };
    let said = false;
    const timer = setTimeout(() => {
      said = true;
      say(documentId);
    }, CANVAS_VIEWING_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // **Nothing to take back if nothing was said.** The debounce is what makes
      // arrow-keying along eight tabs one statement rather than eight — and a
      // cleanup that cleared unconditionally would send the other eight anyway,
      // one per tab passed through, which is the fan-out the debounce exists to
      // stop. The server publishes no FRAME for a clear it has nothing to clear,
      // but the request still crosses the wire, and that is the half this
      // decides.
      if (said) say(null);
    };
    // `epoch` is a dependency on purpose: a stream cycle clears every face in
    // the room, and re-running this is how this viewer's own comes back.
  }, [transport, roomId, documentId, epoch]);
}
