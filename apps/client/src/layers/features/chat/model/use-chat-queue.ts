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
  handleQueueEdit: (index: number) => void;
  handleQueueSaveEdit: () => void;
  handleQueueCancelEdit: () => void;
  handleQueueRemove: (index: number) => void;
  handleQueueNavigateUp: () => void;
  handleQueueNavigateDown: () => void;
}

/**
 * Facade hook that wraps useMessageQueue with draft-aware queue editing callbacks.
 *
 * Owns the draft ref that preserves the user's in-progress composition when they
 * navigate into the queue. Provides fully-wired callbacks for QueuePanel and ChatInput.
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
    (index: number) => {
      if (messageQueue.editingIndex === null) {
        draftRef.current = input;
      }
      const content = messageQueue.startEditing(index);
      setInput(content);
      chatInputRef.current?.focus();
    },
    [input, messageQueue, setInput, chatInputRef]
  );

  const handleQueueSaveEdit = useCallback(() => {
    if (messageQueue.editingIndex !== null && input.trim()) {
      messageQueue.saveEditing(input.trim());
      setInput(draftRef.current);
    }
  }, [input, messageQueue, setInput]);

  const handleQueueCancelEdit = useCallback(() => {
    messageQueue.cancelEditing();
    setInput(draftRef.current);
  }, [messageQueue, setInput]);

  const handleQueueRemove = useCallback(
    (index: number) => {
      if (messageQueue.editingIndex === index) {
        setInput(draftRef.current);
      }
      messageQueue.removeFromQueue(index);
    },
    [messageQueue, setInput]
  );

  const handleQueueNavigateUp = useCallback(() => {
    if (messageQueue.editingIndex === null) {
      draftRef.current = input;
      const content = messageQueue.startEditing(messageQueue.queue.length - 1);
      setInput(content);
    } else if (messageQueue.editingIndex > 0) {
      const content = messageQueue.startEditing(messageQueue.editingIndex - 1);
      setInput(content);
    } else {
      messageQueue.cancelEditing();
      setInput(draftRef.current);
    }
  }, [input, messageQueue, setInput]);

  const handleQueueNavigateDown = useCallback(() => {
    if (messageQueue.editingIndex !== null) {
      if (messageQueue.editingIndex < messageQueue.queue.length - 1) {
        const content = messageQueue.startEditing(messageQueue.editingIndex + 1);
        setInput(content);
      } else {
        messageQueue.cancelEditing();
        setInput(draftRef.current);
      }
    }
  }, [messageQueue, setInput]);

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
