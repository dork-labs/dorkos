import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  useSessionStreamStore,
  useSessionQueue,
  type QueuedMessage,
} from '@/layers/entities/session';
import type { ChatStatus } from './chat-types';

/** A single item in the message queue (re-exported from the session entity). */
export type QueueItem = QueuedMessage;

interface UseMessageQueueOptions {
  status: ChatStatus;
  sessionBusy: boolean;
  sessionId: string | null;
  selectedCwd: string | null;
  /**
   * Called when the queue auto-flushes a message on the streaming→idle edge.
   * Receives the PRISTINE message, its origin session id (so the submit path can
   * refuse to misdeliver it after a session switch — DOR-81 defense-in-depth),
   * and `{ queued }` carrying the queue origin out-of-band. The submit path
   * turns `queued: true` into `context: { queued: true }` so the model sees a
   * server-rendered `<queue_note>` — the content itself is never annotated.
   */
  onFlush: (content: string, originSessionId: string, opts: { queued: boolean }) => void;
}

interface UseMessageQueueReturn {
  queue: QueueItem[];
  /**
   * Id of the item currently being edited, or `null`. This is the editing
   * cursor's source of truth: it survives queue mutations (a flush dequeuing the
   * head, a removal above it) that would silently reseat a positional cursor.
   */
  editingId: string | null;
  /**
   * Position of the edited item, derived from {@link UseMessageQueueReturn.editingId}
   * — for rendering the selected card and for up/down navigation. `null` when
   * nothing is being edited.
   */
  editingIndex: number | null;
  addToQueue: (content: string) => void;
  removeFromQueue: (id: string) => void;
  /** Starts editing `id`; returns its content, or `null` if the item is gone. */
  startEditing: (id: string) => string | null;
  cancelEditing: () => void;
  saveEditing: (content: string) => void;
  clearQueue: () => void;
}

/**
 * Manages a FIFO message queue with auto-flush on the streaming→idle transition.
 *
 * The queue is stored PER SESSION in the session-stream store (keyed by
 * sessionId), NOT in component-local state. This is the DOR-81 fix: a message
 * composed-and-queued in session A can only ever flush into session A, because
 * the auto-flush reads A's slice and the flush is pinned to A's id. A session
 * switch (or a "phantom" streaming→idle right after a switch) can never deliver
 * A's message into the switched-to session B.
 *
 * Every mutation targets a stable `item.id`, never an array position — the
 * auto-flush dequeues the head concurrently with whatever the operator is
 * clicking, so an index captured at render time can address a different item by
 * the time the handler runs.
 *
 * **Flush is owed, not edge-triggered.** The streaming→idle edge *arms* the
 * flush; the flush itself fires as soon as the session can take it (idle, not
 * busy, and at least one item is not under edit). A one-shot edge stranded the
 * queue whenever the only item was being edited when the turn ended: the edge
 * was consumed, `onFlush` never fired, and — with no manual "send now" — the
 * message sat there until the operator happened to send something else. The
 * owed flag makes the same effect re-evaluate when editing ends or the session
 * stops being busy, so a queued message cannot strand.
 *
 * The owed flag is scoped to the tracked session exactly like the status
 * tracker: a session/cwd change drops it along with the streaming→idle history,
 * so an owed flush belonging to A can never fire into B (DOR-81). Both are reset
 * BEFORE the edge is evaluated, so a phantom edge right after a switch is inert.
 */
export function useMessageQueue({
  status,
  sessionBusy,
  sessionId,
  selectedCwd,
  onFlush,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const queue = useSessionQueue(sessionId ?? '');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Position is derived, never stored: the queue mutates under the cursor and
  // an id lookup is always right, where a stored index needs hand-maintained
  // shifting at every mutation site.
  const editingIndex = useMemo(() => {
    if (editingId === null) return null;
    const index = queue.findIndex((item) => item.id === editingId);
    return index === -1 ? null : index;
  }, [editingId, queue]);

  // Stable refs to avoid stale closures inside the auto-flush effect.
  const onFlushRef = useRef(onFlush);
  // eslint-disable-next-line react-hooks/refs -- latest-callback ref pattern to avoid stale closures
  onFlushRef.current = onFlush;
  const queueRef = useRef(queue);
  // eslint-disable-next-line react-hooks/refs -- latest-value ref pattern to avoid stale closures
  queueRef.current = queue;

  // Streaming→idle transition tracker, scoped to the session it observed. When
  // the active session (or cwd) changes, `trackedKey` no longer matches and both
  // the tracker and the owed-flush flag are reset BEFORE the edge is evaluated —
  // so neither a phantom streaming→idle nor a flush owed to the previous session
  // can fire into the switched-to session (DOR-81). Scoping by key here (rather
  // than a separate reset effect) avoids effect-ordering fragility on mount.
  const prevStatusRef = useRef<ChatStatus>('idle');
  const trackedKeyRef = useRef<string | null>(null);
  const flushOwedRef = useRef(false);

  // Auto-flush: armed by the streaming→idle transition, drained as soon as the
  // session can take a message. Pinned to `sessionId` — the queue read, dequeue,
  // and flush all target the ACTIVE session only, so a queued message can never
  // land in another session.
  useEffect(() => {
    // A space is a safe delimiter here even though a path may contain one: every
    // session id is a `crypto.randomUUID()`, so the prefix is always exactly 36
    // characters and the rest of the key is always the cwd. The split point is
    // therefore fixed, and two distinct (sessionId, cwd) pairs cannot produce the
    // same string however many spaces the path has.
    // Previously `\x00`, which is unrepresentable in either component — but a NUL
    // byte makes git treat this file as binary, so the whole queue rewrite showed
    // as zero diff lines and no reviewer could read the riskiest change in the
    // PR. A readable diff is worth more than a delimiter that cannot appear.
    const key = sessionId === null ? null : `${sessionId} ${selectedCwd ?? ''}`;
    if (trackedKeyRef.current !== key) {
      // Session/cwd changed — reset the tracker, the owed flush, and the editing
      // cursor so nothing carried over from the previous session can fire here.
      trackedKeyRef.current = key;
      prevStatusRef.current = 'idle';
      flushOwedRef.current = false;
      setEditingId(null);
    }

    // Arm on the streaming→idle edge: the turn the queue was waiting behind has
    // finished, so the head of the queue is owed a send.
    if (prevStatusRef.current === 'streaming' && status === 'idle' && queueRef.current.length > 0) {
      flushOwedRef.current = true;
    }
    prevStatusRef.current = status;

    if (!flushOwedRef.current) return;
    if (queueRef.current.length === 0) {
      flushOwedRef.current = false;
      return;
    }
    // Drain. Re-runs when editing ends or the session stops being busy, so a
    // flush blocked at the edge is delivered the moment it becomes possible.
    if (status !== 'idle' || sessionBusy || !sessionId) return;

    // Skip the item being edited; flush the first item that is not under edit.
    const item = queueRef.current.find((queued) => queued.id !== editingId);
    // Only the edited item is left — stay owed and flush when editing ends.
    if (!item) return;

    flushOwedRef.current = false;
    useSessionStreamStore.getState().removeQueuedMessage(sessionId, item.id);

    // Flush PRISTINE content; the queued origin rides out-of-band as
    // `{ queued: true }` → `context.queued` → server `<queue_note>`.
    onFlushRef.current(item.content, sessionId, { queued: true });
  }, [status, sessionBusy, sessionId, selectedCwd, editingId]);

  const addToQueue = useCallback(
    (content: string) => {
      if (!content.trim() || !sessionId) return;
      useSessionStreamStore.getState().enqueueMessage(sessionId, content);
    },
    [sessionId]
  );

  const updateQueueItem = useCallback(
    (id: string, content: string) => {
      if (!sessionId) return;
      useSessionStreamStore.getState().updateQueuedMessage(sessionId, id, content);
    },
    [sessionId]
  );

  const removeFromQueue = useCallback(
    (id: string) => {
      if (sessionId) useSessionStreamStore.getState().removeQueuedMessage(sessionId, id);
      setEditingId((prev) => (prev === id ? null : prev));
    },
    [sessionId]
  );

  const startEditing = useCallback(
    (id: string): string | null => {
      const item = queue.find((queued) => queued.id === id);
      if (!item) return null;
      setEditingId(id);
      return item.content;
    },
    [queue]
  );

  const cancelEditing = useCallback(() => {
    setEditingId(null);
  }, []);

  const saveEditing = useCallback(
    (content: string) => {
      if (editingId === null) return;
      updateQueueItem(editingId, content);
      setEditingId(null);
    },
    [editingId, updateQueueItem]
  );

  const clearQueue = useCallback(() => {
    if (sessionId) useSessionStreamStore.getState().clearQueue(sessionId);
    setEditingId(null);
  }, [sessionId]);

  return {
    queue,
    editingId,
    editingIndex,
    addToQueue,
    removeFromQueue,
    startEditing,
    cancelEditing,
    saveEditing,
    clearQueue,
  };
}
