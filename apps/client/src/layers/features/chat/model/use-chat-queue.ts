import { useRef, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { useMessageQueue } from './use-message-queue';
import type { QueueItem } from './use-message-queue';
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
   * Auto-flush callback. Receives the message and its origin session id so the
   * submit path can refuse a cross-session flush (DOR-81). Wired to `submitContent`.
   */
  onFlush: (content: string, originSessionId: string) => void;
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
    if (input.trim()) {
      messageQueue.addToQueue(input.trim());
      setInput('');
    }
  }, [input, messageQueue, setInput]);

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
