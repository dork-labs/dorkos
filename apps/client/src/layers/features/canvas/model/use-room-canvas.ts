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

/** What a person can do to a room's table. */
export interface RoomCanvasActions {
  /** Put something on the table as yourself. */
  open: (content: UiCanvasContent) => void;
  /** Replace what one document shows. */
  update: (documentId: string, content: UiCanvasContent) => void;
  /** Pin a document so it sorts first and is never dropped to make room, or unpin it. */
  pin: (documentId: string, pinned: boolean) => void;
  /** Take a document off the table, for everybody. */
  close: (documentId: string) => void;
}

/**
 * The four writes, bound to one room.
 *
 * Failures are reported to the console rather than raised: none of these is a
 * form submission, every one of them is answered by a frame that either arrives
 * or does not, and a thrown promise inside a click handler would take the panel
 * down with it. A refusal the person needs to act on — an archived room — is
 * already said by the room's own banner.
 *
 * @param roomId - The room whose table these act on.
 * @returns The four writes.
 */
export function useRoomCanvasActions(roomId: string): RoomCanvasActions {
  const transport = useTransport();

  const report = useCallback(
    (what: string, err: unknown) => {
      console.warn(`[room-canvas] ${what} failed`, { roomId, err });
    },
    [roomId]
  );

  return {
    open: useCallback(
      (content) => {
        void transport.openRoomCanvasDocument(roomId, content).catch((err) => report('open', err));
      },
      [transport, roomId, report]
    ),
    update: useCallback(
      (documentId, content) => {
        void transport
          .updateRoomCanvasDocument(roomId, documentId, { content })
          .catch((err) => report('update', err));
      },
      [transport, roomId, report]
    ),
    pin: useCallback(
      (documentId, pinned) => {
        void transport
          .updateRoomCanvasDocument(roomId, documentId, { pinned })
          .catch((err) => report('pin', err));
      },
      [transport, roomId, report]
    ),
    close: useCallback(
      (documentId) => {
        void transport
          .closeRoomCanvasDocument(roomId, documentId)
          .catch((err) => report('close', err));
      },
      [transport, roomId, report]
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
