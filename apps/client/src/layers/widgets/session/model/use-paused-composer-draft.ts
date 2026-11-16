import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { QueuedMessage } from '@dorkos/shared/schemas';

interface PausedComposerDraftOptions {
  sessionId: string;
  paused: boolean;
  queue: QueuedMessage[];
  input: string;
  setInput: (text: string) => void;
  send: (text: string) => Promise<void>;
  remove: (sessionId: string, messageId: string) => Promise<unknown>;
}

/**
 * Show a person's held row in the input without releasing it on resume.
 * Keep the durable row until Send. A removal failure keeps both copies; after
 * removal, the normal send owns the draft and preserves it on a refused send.
 */
export function usePausedComposerDraft({
  sessionId,
  paused,
  queue,
  input,
  setInput,
  send,
  remove,
}: PausedComposerDraftOptions) {
  const held = useRef<{ sessionId: string; messageId: string } | null>(null);
  const sending = useRef(false);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const currentInput = useRef(input);
  currentInput.current = input;
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (held.current?.sessionId !== sessionId) held.current = null;
    if (held.current && !queue.some((row) => row.id === held.current?.messageId)) {
      held.current = null;
    }
    if (!paused || input !== '' || held.current) return;
    const own = queue.find(
      (row) => row.fromChats === undefined && !row.enqueuedBy.startsWith('chat:')
    );
    if (!own) return;
    held.current = { sessionId, messageId: own.id };
    setInput(own.content);
  }, [sessionId, paused, queue, input, setInput]);

  async function submit(
    deliver: (text: string) => Promise<void> = send,
    clearOnConfirmed = false
  ): Promise<void> {
    if (paused || sending.current || !input.trim()) return;
    sending.current = true;
    setPending(true);
    try {
      const row = held.current;
      if (row?.sessionId === sessionId) {
        await remove(sessionId, row.messageId);
        if (held.current === row) held.current = null;
      }
      if (currentSession.current !== sessionId) return;
      await deliver(input);
      if (
        clearOnConfirmed &&
        currentSession.current === sessionId &&
        currentInput.current === input
      ) {
        setInput('');
      }
    } catch {
      toast.error('Couldn’t send that message. Try again.');
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return { submit, pending, restored: held.current?.sessionId === sessionId };
}
