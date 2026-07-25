import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  useSessionStreamStore,
  useSessionQueue,
  useSessionAwaitingDecision,
  type QueuedMessage,
} from '@/layers/entities/session';
import { sessionContextKey } from '../lib/session-context-key';
import type { ChatStatus } from './chat-types';

/** A single item in the message queue (re-exported from the session entity). */
export type QueueItem = QueuedMessage;

/** Out-of-band metadata carried by a queue flush. */
export interface QueueFlushOptions {
  /** Always `true` for a queue flush — becomes `context: { queued: true }` on the wire. */
  queued: boolean;
  /**
   * Undo for this flush: puts the message back in the queue at the position it
   * was dequeued from, keeping its id.
   *
   * The queue has to dequeue BEFORE the trigger POST resolves (the flush is
   * fire-and-forget, and leaving the item in place would let the next render
   * flush it twice). So the submit path owns the failure case: a refused
   * trigger — `SESSION_LOCKED` from a turn lock the server still holds, a dead
   * network — calls this instead of dropping the message. Without it, a person's
   * typed words were destroyed by a race they could not see (DOR-480).
   * Idempotent, so calling it twice cannot duplicate the message.
   */
  restore: () => void;
}

interface UseMessageQueueOptions {
  status: ChatStatus;
  sessionBusy: boolean;
  sessionId: string | null;
  selectedCwd: string | null;
  /**
   * Called when the queue flushes a message — automatically on the
   * streaming→idle edge, or on demand via
   * {@link UseMessageQueueReturn.sendNow}. Receives the PRISTINE message, its
   * origin session id (so the submit path can refuse to misdeliver it after a
   * session switch — DOR-81 defense-in-depth), and {@link QueueFlushOptions}
   * carrying the queue origin plus the restore handle out-of-band. The submit
   * path turns `queued: true` into `context: { queued: true }` so the model sees
   * a server-rendered `<queue_note>` — the content itself is never annotated.
   */
  onFlush: (content: string, originSessionId: string, opts: QueueFlushOptions) => void;
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
  /**
   * Why a manual send cannot happen right now, in words fit for a tooltip, or
   * `null` when {@link UseMessageQueueReturn.sendNow} will work. Drives the
   * disabled state of the queue rows' Send-now control so it never fails
   * silently.
   */
  sendBlockedReason: string | null;
  addToQueue: (content: string) => void;
  removeFromQueue: (id: string) => void;
  /**
   * Send a queued message immediately, ahead of the auto-flush pump.
   *
   * The escape hatch for every state the pump cannot drain: a turn that ended in
   * `error` (the pump only arms on streaming→idle), a lock race that put a
   * message back, or simply a message the operator wants out first. A no-op when
   * {@link UseMessageQueueReturn.sendBlockedReason} is set or the id has already
   * left the queue.
   *
   * @returns `true` only when the message was actually handed to the submit
   *   path. Callers must gate any composer mutation on this: swapping the
   *   composer for a send that did not happen leaves the editing cursor pointing
   *   at a row whose rewrite is no longer on screen, and the next Enter saves the
   *   parked draft over it.
   */
  sendNow: (id: string) => boolean;
  /** Starts editing `id`; returns its content, or `null` if the item is gone. */
  startEditing: (id: string) => string | null;
  cancelEditing: () => void;
  saveEditing: (content: string) => void;
  /**
   * Rewrite a queued item's content WITHOUT moving the editing cursor — the
   * commit half of edit-in-place, used when the operator leaves an edit by
   * navigating rather than by saving.
   */
  updateQueued: (id: string, content: string) => void;
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
 * busy, not awaiting a decision, and at least one item is not under edit). A
 * one-shot edge stranded the queue whenever the only item was being edited when
 * the turn ended: the edge was consumed, `onFlush` never fired, and the message
 * sat there until the operator happened to send something else. The owed flag
 * makes the same effect re-evaluate when editing ends or the session stops being
 * busy, so a queued message cannot strand.
 *
 * The owed flag is scoped to the tracked session exactly like the status
 * tracker: a session/cwd change drops it along with the streaming→idle history,
 * so an owed flush belonging to A can never fire into B (DOR-81). Both are reset
 * BEFORE the edge is evaluated, so a phantom edge right after a switch is inert.
 *
 * **Drainability is read from the authoritative lifecycle, not from the rendered
 * status** (DOR-480). `selectRenderedStatus` collapses `blocked` → `idle` on
 * purpose — the renderer shows blocking through the interaction cards — but the
 * server keeps the turn's session lock for the entire time a turn sits blocked
 * on an approval. Draining against the rendered `idle` therefore dequeued the
 * message and handed it to a trigger the lock would refuse, and it was gone.
 * {@link useSessionAwaitingDecision} is the truth the drain gates on.
 *
 * Delivery is still not guaranteed by the gate alone (a second client can hold
 * the lock), so every flush carries a {@link QueueFlushOptions.restore} handle
 * and every row offers {@link UseMessageQueueReturn.sendNow}: a refused trigger
 * puts the message back, and the operator can always send it by hand.
 */
export function useMessageQueue({
  status,
  sessionBusy,
  sessionId,
  selectedCwd,
  onFlush,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const queue = useSessionQueue(sessionId ?? '');
  const awaitingDecision = useSessionAwaitingDecision(sessionId ?? '');
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

  /**
   * Dequeue `item` and hand it to the submit path with an undo bound to the
   * position it came from. The single delivery seam — the auto-flush and the
   * manual send must not diverge on the restore contract.
   */
  const deliver = useCallback((targetSessionId: string, item: QueueItem, index: number) => {
    useSessionStreamStore.getState().removeQueuedMessage(targetSessionId, item.id);
    // Flush PRISTINE content; the queued origin rides out-of-band as
    // `{ queued: true }` → `context.queued` → server `<queue_note>`.
    onFlushRef.current(item.content, targetSessionId, {
      queued: true,
      restore: () => useSessionStreamStore.getState().requeueMessage(targetSessionId, item, index),
    });
  }, []);

  const sendBlockedReason = useMemo(() => {
    if (!sessionId) return 'No session to send to yet';
    if (status === 'streaming') return 'Waiting for the reply to finish';
    if (awaitingDecision) return 'Waiting for your answer above';
    if (sessionBusy) return 'This session is busy right now';
    return null;
  }, [sessionId, status, awaitingDecision, sessionBusy]);

  // Auto-flush: armed by the streaming→idle transition, drained as soon as the
  // session can take a message. Pinned to `sessionId` — the queue read, dequeue,
  // and flush all target the ACTIVE session only, so a queued message can never
  // land in another session.
  useEffect(() => {
    // Shared with `useChatQueue`'s draft + handoff scoping: everything that must
    // move in lockstep with this cursor keys off the SAME function, because a
    // coarser key on either side reopens the duplicate send (DOR-480).
    const key = sessionContextKey(sessionId, selectedCwd);
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
    // Drain. Re-runs when editing ends, the session stops being busy, or a
    // pending approval resolves, so a flush blocked at the edge is delivered the
    // moment it becomes possible.
    //
    // `status === 'idle'` keeps the pump off a failed turn on purpose: a person
    // whose turn just errored should decide what happens next, so the queue waits
    // for their Send-now (BUG 4's strand fix) rather than auto-firing into a
    // broken session. `sendBlockedReason` adds the authoritative half — a
    // `blocked` session reads `idle` to the renderer but still holds the turn's
    // server-side lock, and draining into it destroyed the message (DOR-480).
    if (status !== 'idle' || sendBlockedReason !== null || !sessionId) return;

    // Skip the item being edited; flush the first item that is not under edit.
    const index = queueRef.current.findIndex((queued) => queued.id !== editingId);
    // Only the edited item is left — stay owed and flush when editing ends.
    if (index === -1) return;

    flushOwedRef.current = false;
    deliver(sessionId, queueRef.current[index]!, index);
  }, [status, sessionBusy, sessionId, selectedCwd, editingId, sendBlockedReason, deliver]);

  const addToQueue = useCallback(
    (content: string) => {
      if (!content.trim() || !sessionId) return;
      useSessionStreamStore.getState().enqueueMessage(sessionId, content);
    },
    [sessionId]
  );

  const updateQueued = useCallback(
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

  const sendNow = useCallback(
    (id: string): boolean => {
      if (!sessionId || sendBlockedReason !== null) return false;
      // Read the LIVE store, not the render-time snapshot: the caller may have
      // just committed an in-progress edit into this very item, and `queueRef`
      // still holds the pre-commit array (it is assigned during render).
      const items = useSessionStreamStore.getState().getSession(sessionId).queuedMessages;
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return false;
      // A hand-sent message satisfies whatever flush was owed: the send starts a
      // turn, and re-arming would drain a SECOND message the operator did not
      // ask for. The next streaming→idle edge arms the pump again.
      flushOwedRef.current = false;
      setEditingId((prev) => (prev === id ? null : prev));
      deliver(sessionId, items[index]!, index);
      return true;
    },
    [sessionId, sendBlockedReason, deliver]
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
      updateQueued(editingId, content);
      setEditingId(null);
    },
    [editingId, updateQueued]
  );

  const clearQueue = useCallback(() => {
    if (sessionId) useSessionStreamStore.getState().clearQueue(sessionId);
    setEditingId(null);
  }, [sessionId]);

  return {
    queue,
    editingId,
    editingIndex,
    sendBlockedReason,
    addToQueue,
    removeFromQueue,
    sendNow,
    startEditing,
    cancelEditing,
    saveEditing,
    updateQueued,
    clearQueue,
  };
}
