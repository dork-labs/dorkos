/**
 * The composer's view of the SERVER's message queue (spec
 * `persistent-session-runtime`, task 2.6 — supersedes ADR-0104).
 *
 * The queue used to live in this hook: a per-session FIFO in the stream store,
 * flushed one message at a time on the streaming→idle edge. It was ephemeral —
 * lost on refresh, invisible to a second window, stranded by a failed turn — and
 * every one of those was a promise the client could not keep on its own. The
 * server keeps them now, so this hook holds nothing: it reads the queue out of
 * the session projection (hydrated by the snapshot, advanced by `queue_update`)
 * and turns every affordance into a call on the queue routes.
 *
 * What it still owns, because none of it is queue state:
 *
 * - The **editing cursor**, keyed by a stable message id rather than a position.
 *   The queue mutates under the cursor — a dispatch takes the head, another
 *   window removes a row — and an id lookup is always right where a stored index
 *   needs hand-maintained shifting at every mutation site.
 * - The **words a person typed are never lost** (DOR-480). The old queue dequeued
 *   before its trigger resolved and needed an undo handle to survive a refusal;
 *   the server-backed enqueue keeps the text in the composer until the server
 *   says it has it, so a failed enqueue leaves the message exactly where it was
 *   typed. Nothing to put back means nothing that can fail to be put back.
 *
 * @module features/chat/model/use-message-queue
 */
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { useSessionQueueOutcomes, useSessionStreamStore } from '@/layers/entities/session';
import { useTransport } from '@/layers/shared/model';
import { queueDowngradeNotice } from '../lib/queue-chips';

/**
 * One row of the queue as the panel draws it — the server's message plus the
 * two things only this window can know about it.
 */
export interface QueueItem {
  /** Server-minted id. Stable across edits, moves, and other windows. */
  id: string;
  /** The person's words, exactly as the server holds them. */
  content: string;
  /**
   * False when another window put this message on the queue. It stays fully
   * editable — the queue belongs to the session, not to a window — it just does
   * not pretend to be yours.
   */
  mine: boolean;
  /**
   * What happened to this message, when that is worth saying: "queued instead of
   * steered, because this runtime cannot steer". `null` for the overwhelming
   * majority, which got exactly what they asked for.
   */
  notice: string | null;
}

interface UseMessageQueueOptions {
  sessionId: string | null;
  /**
   * The messages waiting on this session, head first — already narrowed to the
   * ones genuinely WAITING (see `selectWaitingQueue`), because the caller is the
   * one holding the session's lifecycle.
   */
  waiting: QueuedMessage[];
  /**
   * Put `content` on the server's queue. Resolves `true` only once the server
   * has it, which is what lets the composer hold the text until then.
   */
  onEnqueue: (content: string) => Promise<boolean>;
}

interface UseMessageQueueReturn {
  queue: QueueItem[];
  /**
   * Id of the item currently being edited, or `null`. This is the editing
   * cursor's source of truth: it survives queue mutations (a dispatch taking the
   * head, a removal above it, a reorder from another window) that would silently
   * reseat a positional cursor.
   */
  editingId: string | null;
  /**
   * Position of the edited item, derived from {@link UseMessageQueueReturn.editingId}
   * — for rendering the selected card and for up/down navigation. `null` when
   * nothing is being edited.
   */
  editingIndex: number | null;
  /** Put `content` on the queue; resolves `true` once the server has it. */
  addToQueue: (content: string) => Promise<boolean>;
  removeFromQueue: (id: string) => void;
  /**
   * Send a queued message next, ahead of everything else waiting.
   *
   * Moving it to the head is the whole of it: the server dispatches the head the
   * moment the session frees up, so "next" is the earliest any message can go.
   *
   * @returns `true` only when a move was actually issued — `false` for a message
   *   that is already at the head, or one that has left the queue. Callers must
   *   gate any composer mutation on this: swapping the composer for a send that
   *   did not happen leaves the editing cursor pointing at a row whose rewrite is
   *   no longer on screen, and the next Enter saves the parked draft over it.
   */
  sendNow: (id: string) => boolean;
  /**
   * Move a queued message one place earlier. Every order is reachable from this
   * alone, which is why there is no matching "move down" cluttering each row.
   */
  moveUp: (id: string) => void;
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
}

/**
 * A queue mutation that failed because the message is no longer waiting.
 *
 * Not an error anybody needs told about: the message started running, or another
 * window took it off, and the `queue_update` that goes with either has already
 * corrected what is on screen.
 */
function isGone(err: unknown): boolean {
  return (err as { code?: string })?.code === 'QUEUED_MESSAGE_NOT_FOUND';
}

/**
 * The composer's queue, backed by the server.
 *
 * @param options - The session, its waiting messages, and the enqueue seam.
 */
export function useMessageQueue({
  sessionId,
  waiting,
  onEnqueue,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const transport = useTransport();
  const outcomes = useSessionQueueOutcomes(sessionId ?? '');
  const [editingId, setEditingId] = useState<string | null>(null);

  const queue = useMemo(
    () =>
      waiting.map<QueueItem>((message) => ({
        id: message.id,
        content: message.content,
        // No client id at all (a transport that does not track one) means every
        // chip reads as this window's, which is the honest answer for a surface
        // where there is only one window.
        mine: transport.clientId === undefined || message.enqueuedBy === transport.clientId,
        notice: queueDowngradeNotice(outcomes[message.id]),
      })),
    [waiting, outcomes, transport.clientId]
  );

  // Position is derived, never stored: the queue mutates under the cursor and
  // an id lookup is always right, where a stored index needs hand-maintained
  // shifting at every mutation site.
  const editingIndex = useMemo(() => {
    if (editingId === null) return null;
    const index = queue.findIndex((item) => item.id === editingId);
    return index === -1 ? null : index;
  }, [editingId, queue]);

  /**
   * The id at the front of the server's queue right now, read from the store
   * rather than from this render — a retry happens after a round trip, by which
   * time `queue` is a description of the past.
   */
  const latestHeadId = useCallback((): string | undefined => {
    if (!sessionId) return undefined;
    return useSessionStreamStore.getState().getSession(sessionId).queuedMessages[0]?.id;
  }, [sessionId]);

  /**
   * Run a queue mutation and say something only when there is something to say.
   * A message that has left the queue is not a failure; a dead network is.
   */
  const mutate = useCallback((run: () => Promise<unknown>, failure: string) => {
    void run().catch((err: unknown) => {
      if (isGone(err)) return;
      toast.error(failure);
    });
  }, []);

  const addToQueue = useCallback(
    async (content: string): Promise<boolean> => {
      const trimmed = content.trim();
      if (!trimmed || !sessionId) return false;
      return onEnqueue(trimmed);
    },
    [sessionId, onEnqueue]
  );

  const updateQueued = useCallback(
    (id: string, content: string) => {
      if (!sessionId) return;
      mutate(
        () => transport.updateQueuedMessage(sessionId, id, { content }),
        'Could not save that change'
      );
    },
    [sessionId, transport, mutate]
  );

  const removeFromQueue = useCallback(
    (id: string) => {
      setEditingId((prev) => (prev === id ? null : prev));
      if (!sessionId) return;
      mutate(
        () => transport.removeQueuedMessage(sessionId, id),
        'Could not take that message off the queue'
      );
    },
    [sessionId, transport, mutate]
  );

  /**
   * Move `id` to sit immediately before `anchorId`, retrying once against a
   * fresh anchor.
   *
   * The retry is the launching-head case: the message the move named can start
   * running between the render that drew the row and the click that moved it,
   * and the server answers a move onto a departed anchor with the same "not
   * found" it answers a departed message with. One retry against whatever is now
   * at the front turns that race into the move the person asked for; a second
   * failure means the queue has moved on far enough that doing nothing is right.
   */
  const moveBefore = useCallback(
    (id: string, anchorId: string) => {
      if (!sessionId) return;
      const move = (anchor: string): Promise<unknown> =>
        transport.updateQueuedMessage(sessionId, id, { move: { before: anchor } });
      mutate(async () => {
        try {
          await move(anchorId);
        } catch (err) {
          if (!isGone(err)) throw err;
          const head = latestHeadId();
          if (head === undefined || head === id) return;
          await move(head);
        }
      }, 'Could not move that message');
    },
    [sessionId, transport, mutate, latestHeadId]
  );

  const sendNow = useCallback(
    (id: string): boolean => {
      const index = queue.findIndex((item) => item.id === id);
      // Already next, or gone: nothing to move, and saying otherwise would let
      // the caller swap a composer for a send that never happened.
      if (index <= 0) return false;
      setEditingId((prev) => (prev === id ? null : prev));
      moveBefore(id, queue[0]!.id);
      return true;
    },
    [queue, moveBefore]
  );

  const moveUp = useCallback(
    (id: string) => {
      const index = queue.findIndex((item) => item.id === id);
      if (index <= 0) return;
      moveBefore(id, queue[index - 1]!.id);
    },
    [queue, moveBefore]
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

  return {
    queue,
    editingId,
    editingIndex,
    addToQueue,
    removeFromQueue,
    sendNow,
    moveUp,
    startEditing,
    cancelEditing,
    saveEditing,
    updateQueued,
  };
}
