import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatStatus } from './chat-types';

/** A single item in the message queue. */
export interface QueueItem {
  id: string;
  content: string;
  createdAt: number;
}

interface UseMessageQueueOptions {
  status: ChatStatus;
  sessionBusy: boolean;
  sessionId: string | null;
  selectedCwd: string | null;
  /** Called when the queue auto-flushes a message on idle transition. */
  onFlush: (content: string) => void;
}

interface UseMessageQueueReturn {
  queue: QueueItem[];
  editingIndex: number | null;
  addToQueue: (content: string) => void;
  updateQueueItem: (index: number, content: string) => void;
  removeFromQueue: (index: number) => void;
  startEditing: (index: number) => string;
  cancelEditing: () => void;
  saveEditing: (content: string) => void;
  clearQueue: () => void;
}

/**
 * Manages a FIFO message queue with auto-flush on streaming-to-idle transition.
 *
 * Auto-flush fires when the agent transitions from `streaming` to `idle`. It takes
 * the first non-editing item, prepends a timing annotation, and calls `onFlush`.
 * The queue clears on session or cwd change.
 */
export function useMessageQueue({
  status,
  sessionBusy,
  sessionId,
  selectedCwd,
  onFlush,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Stable ref for onFlush to avoid stale closures in the auto-flush effect
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;

  // Track previous status to detect streaming→idle transition
  const prevStatusRef = useRef<ChatStatus>('idle');

  // Auto-flush: fires when status transitions from 'streaming' to 'idle'
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && status === 'idle') {
      if (queue.length > 0 && !sessionBusy) {
        // Skip the item being edited; flush the first non-editing item
        const firstNonEditing = editingIndex === 0
          ? queue.length > 1 ? 1 : null
          : 0;

        if (firstNonEditing !== null) {
          const item = queue[firstNonEditing];
          const annotated = `[Note: This message was composed while the agent was responding to the previous message]\n\n${item.content}`;

          setQueue((prev) => prev.filter((_, i) => i !== firstNonEditing));

          if (editingIndex !== null && editingIndex > firstNonEditing) {
            setEditingIndex((prev) => (prev !== null ? prev - 1 : null));
          }

          onFlushRef.current(annotated);
        }
      }
    }
    prevStatusRef.current = status;
  }, [status, sessionBusy, queue, editingIndex]);

  // Clear queue on session or working directory change
  useEffect(() => {
    setQueue([]);
    setEditingIndex(null);
  }, [sessionId, selectedCwd]);

  const addToQueue = useCallback((content: string) => {
    if (!content.trim()) return;
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), content, createdAt: Date.now() },
    ]);
  }, []);

  const updateQueueItem = useCallback((index: number, content: string) => {
    setQueue((prev) =>
      prev.map((item, i) => (i === index ? { ...item, content } : item))
    );
  }, []);

  const removeFromQueue = useCallback(
    (index: number) => {
      setQueue((prev) => prev.filter((_, i) => i !== index));
      setEditingIndex((prev) => {
        if (prev === index) return null;
        if (prev !== null && prev > index) return prev - 1;
        return prev;
      });
    },
    []
  );

  const startEditing = useCallback(
    (index: number): string => {
      setEditingIndex(index);
      return queue[index]?.content ?? '';
    },
    [queue]
  );

  const cancelEditing = useCallback(() => {
    setEditingIndex(null);
  }, []);

  const saveEditing = useCallback(
    (content: string) => {
      if (editingIndex === null) return;
      updateQueueItem(editingIndex, content);
      setEditingIndex(null);
    },
    [editingIndex, updateQueueItem]
  );

  const clearQueue = useCallback(() => {
    setQueue([]);
    setEditingIndex(null);
  }, []);

  return {
    queue,
    editingIndex,
    addToQueue,
    updateQueueItem,
    removeFromQueue,
    startEditing,
    cancelEditing,
    saveEditing,
    clearQueue,
  };
}
