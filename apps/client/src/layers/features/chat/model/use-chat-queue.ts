import { useRef, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { useMessageQueue } from './use-message-queue';
import type { QueueItem } from './use-message-queue';
import type { NativeCommandResult } from './native-commands';
import type { ChatStatus } from './chat-types';
import type { ChatInputHandle } from '../ui/input/ChatInput';

interface UseChatQueueOptions {
  input: string;
  setInput: (value: string) => void;
  status: ChatStatus;
  sessionBusy: boolean;
  sessionId: string;
  selectedCwd: string | null;
  /**
   * Auto-flush callback. Receives the pristine message, its origin session id
   * (so the submit path can refuse a cross-session flush — DOR-81), and
   * `{ queued }` carrying the queue origin out-of-band. Wired to `submitContent`.
   */
  onFlush: (content: string, originSessionId: string, opts: { queued: boolean }) => void;
  /**
   * Native (client-side) command interceptor. Checked at the queue decision so a
   * native command (e.g. `/rename`) typed while a turn streams runs instantly and
   * never enters the queue — a queued native command flushes without starting a
   * turn, so it would break the streaming→idle flush pump and silently stall
   * every message queued behind it.
   */
  tryNativeCommand: (content: string) => NativeCommandResult;
  chatInputRef: RefObject<ChatInputHandle | null>;
}

interface UseChatQueueReturn {
  queue: QueueItem[];
  editingIndex: number | null;
  handleQueue: () => void;
  handleQueueEdit: (id: string) => void;
  handleQueueSaveEdit: () => void;
  handleQueueCancelEdit: () => void;
  handleQueueRemove: (id: string) => void;
  handleQueueNavigateUp: () => void;
  handleQueueNavigateDown: () => void;
}

/**
 * Facade hook that wraps useMessageQueue with draft-aware queue editing callbacks.
 *
 * Owns the draft ref that preserves the user's in-progress composition when they
 * navigate into the queue. Provides fully-wired callbacks for QueuePanel and ChatInput.
 *
 * Card callbacks (`handleQueueEdit` / `handleQueueRemove`) address a queue item
 * by its stable id, never its position: the auto-flush dequeues the head while
 * the panel is on screen, so an index captured at render time can point at a
 * different message by the time the click lands. Keyboard navigation is
 * positional by nature and resolves the position to an id at the call site.
 */
export function useChatQueue({
  input,
  setInput,
  status,
  sessionBusy,
  sessionId,
  selectedCwd,
  onFlush,
  tryNativeCommand,
  chatInputRef,
}: UseChatQueueOptions): UseChatQueueReturn {
  // Draft ref preserves the user's in-progress composition when they navigate into the queue
  const draftRef = useRef('');

  // The draft is session-scoped: clear it on a session switch so a composition
  // parked while editing session A's queue can never be restored into session B's
  // input (DOR-81 cross-session-leak class; the queue itself is already store-keyed).
  useEffect(() => {
    draftRef.current = '';
  }, [sessionId]);

  const messageQueue = useMessageQueue({
    status,
    sessionBusy,
    sessionId,
    selectedCwd,
    onFlush,
  });

  const handleQueue = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // A native command must run instantly (even mid-stream) and must never enter
    // the queue: a queued native command flushes without starting a turn, which
    // breaks the streaming→idle flush pump and stalls everything behind it. Clear
    // the composer only when it actually ran — a rejected command keeps its text.
    const native = tryNativeCommand(trimmed);
    if (native.handled) {
      if (native.ran) setInput('');
      return;
    }
    messageQueue.addToQueue(trimmed);
    setInput('');
  }, [input, messageQueue, setInput, tryNativeCommand]);

  const handleQueueEdit = useCallback(
    (id: string) => {
      const wasEditing = messageQueue.editingId !== null;
      // `null` means the item was flushed or removed between render and click —
      // leave the composer exactly as the user left it.
      const content = messageQueue.startEditing(id);
      if (content === null) return;
      if (!wasEditing) draftRef.current = input;
      setInput(content);
      chatInputRef.current?.focus();
    },
    [input, messageQueue, setInput, chatInputRef]
  );

  const handleQueueSaveEdit = useCallback(() => {
    if (messageQueue.editingId !== null && input.trim()) {
      messageQueue.saveEditing(input.trim());
      setInput(draftRef.current);
    }
  }, [input, messageQueue, setInput]);

  const handleQueueCancelEdit = useCallback(() => {
    messageQueue.cancelEditing();
    setInput(draftRef.current);
  }, [messageQueue, setInput]);

  const handleQueueRemove = useCallback(
    (id: string) => {
      if (messageQueue.editingId === id) {
        setInput(draftRef.current);
      }
      messageQueue.removeFromQueue(id);
    },
    [messageQueue, setInput]
  );

  /** Moves the editing cursor to a position, restoring the draft if it falls off the queue. */
  const editAtPosition = useCallback(
    (index: number) => {
      const id = messageQueue.queue[index]?.id;
      const content = id === undefined ? null : messageQueue.startEditing(id);
      if (content === null) {
        messageQueue.cancelEditing();
        setInput(draftRef.current);
        return;
      }
      setInput(content);
    },
    [messageQueue, setInput]
  );

  const handleQueueNavigateUp = useCallback(() => {
    const { editingIndex, queue } = messageQueue;
    if (editingIndex === null) {
      if (queue.length === 0) return;
      draftRef.current = input;
      editAtPosition(queue.length - 1);
    } else if (editingIndex > 0) {
      editAtPosition(editingIndex - 1);
    } else {
      messageQueue.cancelEditing();
      setInput(draftRef.current);
    }
  }, [editAtPosition, input, messageQueue, setInput]);

  const handleQueueNavigateDown = useCallback(() => {
    const { editingIndex, queue } = messageQueue;
    if (editingIndex === null) return;
    if (editingIndex < queue.length - 1) {
      editAtPosition(editingIndex + 1);
    } else {
      messageQueue.cancelEditing();
      setInput(draftRef.current);
    }
  }, [editAtPosition, messageQueue, setInput]);

  return {
    queue: messageQueue.queue,
    editingIndex: messageQueue.editingIndex,
    handleQueue,
    handleQueueEdit,
    handleQueueSaveEdit,
    handleQueueCancelEdit,
    handleQueueRemove,
    handleQueueNavigateUp,
    handleQueueNavigateDown,
  };
}
