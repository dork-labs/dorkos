import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { isPausedComposerRow } from '../lib/paused-composer-row';
import { useSessionChatStore } from '@/layers/entities/session';

interface PausedComposerDraftOptions {
  sessionId: string;
  paused: boolean;
  queue: QueuedMessage[];
  personClientIds: readonly string[];
  input: string;
  setInput: (text: string) => void;
  send: (text: string) => Promise<void>;
  remove: (sessionId: string, messageId: string) => Promise<unknown>;
}

/**
 * Show a person's held row in the input without releasing it on resume.
 * Keep the durable row until Send. A removal failure keeps both copies; after
 * removal, the normal send owns the draft and preserves it on a refused send.
 *
 * @param options - The current window's draft, queue, and confirmed delivery paths
 */
export function usePausedComposerDraft({
  sessionId,
  paused,
  queue,
  personClientIds,
  input,
  setInput,
  send,
  remove,
}: PausedComposerDraftOptions) {
  const held = useRef<{ sessionId: string; messageId: string; content?: string } | null>(null);
  const rememberedId = useSessionChatStore(
    (state) => state.sessions[sessionId]?.pausedComposerMessageId ?? null
  );
  if (held.current?.sessionId !== sessionId) held.current = null;
  if (!held.current && rememberedId) {
    held.current = {
      sessionId,
      messageId: rememberedId,
      content: queue.find((row) => row.id === rememberedId)?.content,
    };
  }
  const removing = useRef<typeof held.current>(null);
  const sending = useRef(false);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const queued = queue.find((row) => row.id === held.current?.messageId);
    if (held.current && queued) held.current.content = queued.content;
    if (
      held.current &&
      !(
        removing.current?.sessionId === sessionId &&
        removing.current.messageId === held.current.messageId
      ) &&
      (!queued || !isPausedComposerRow(queued, personClientIds))
    ) {
      const unchanged = input === held.current.content;
      held.current = null;
      useSessionChatStore.getState().updateSession(sessionId, { pausedComposerMessageId: null });
      // Clear an unchanged copy; the person's edits remain an unsent draft.
      if (unchanged) setInput('');
      return;
    }
    if (!paused || input !== '' || held.current) return;
    const own = queue.find((row) => isPausedComposerRow(row, personClientIds));
    if (!own) return;
    held.current = { sessionId, messageId: own.id, content: own.content };
    useSessionChatStore.getState().updateSession(sessionId, { pausedComposerMessageId: own.id });
    setInput(own.content);
  }, [sessionId, paused, queue, personClientIds, input, setInput]);

  async function submit({
    deliver = send,
  }: { deliver?: (text: string) => Promise<void> } = {}): Promise<void> {
    if ((paused && held.current?.sessionId === sessionId) || sending.current || !input.trim())
      return;
    sending.current = true;
    setPending(true);
    try {
      const row = held.current;
      if (row?.sessionId === sessionId) {
        removing.current = row;
        try {
          await remove(sessionId, row.messageId);
        } catch {
          // Only this new boundary needs a toast. Ordinary delivery keeps its own errors.
          toast.error('Couldn’t send that message. Try again.');
          return;
        } finally {
          removing.current = null;
        }
        if (held.current?.sessionId === sessionId && held.current.messageId === row.messageId) {
          held.current = null;
        }
        const store = useSessionChatStore.getState();
        if (store.getSession(sessionId).pausedComposerMessageId === row.messageId) {
          store.updateSession(sessionId, { pausedComposerMessageId: null });
        }
      }
      if (currentSession.current !== sessionId) return;
      await deliver(input);
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  const restored = held.current?.sessionId === sessionId;
  return {
    submit,
    pending,
    restored,
    restoredMessageId: restored ? held.current?.messageId : undefined,
    visibleQueue: queue.filter((row) => !restored || row.id !== held.current?.messageId),
  };
}
