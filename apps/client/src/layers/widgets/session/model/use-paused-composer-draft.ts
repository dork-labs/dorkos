import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { isPausedComposerRow, isRestoredDraftRow } from '../lib/paused-composer-row';
import { useSessionChatStore } from '@/layers/entities/session';

interface PausedComposerDraftOptions {
  sessionId: string;
  paused: boolean;
  queue: QueuedMessage[];
  /** The chat's restored drafts (spec `turns-survive-restarts` §7.3); none when absent. */
  restored?: QueuedMessage[];
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
 * A restored draft takes the same path on every window, paused or not: shown
 * in an empty input, used up by Send through the normal send, or discarded.
 *
 * @param options - The current window's draft, queue, and confirmed delivery paths
 */
export function usePausedComposerDraft({
  sessionId,
  paused,
  queue,
  restored = NO_RESTORED,
  personClientIds,
  input,
  setInput,
  send,
  remove,
}: PausedComposerDraftOptions) {
  const rows = queue.concat(restored);
  const held = useRef<{ sessionId: string; messageId: string; content?: string } | null>(null);
  const rememberedId = useSessionChatStore(
    (state) => state.sessions[sessionId]?.pausedComposerMessageId ?? null
  );
  if (held.current?.sessionId !== sessionId) held.current = null;
  if (!held.current && rememberedId) {
    held.current = {
      sessionId,
      messageId: rememberedId,
      content: rows.find((row) => row.id === rememberedId)?.content,
    };
  }
  const removing = useRef<typeof held.current>(null);
  // Rows this window used up or discarded: never filled again while the
  // server's next queue update is still on its way.
  const spent = useRef(new Set<string>());
  const sending = useRef(false);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const queued = queue.concat(restored).find((row) => row.id === held.current?.messageId);
    if (held.current && queued) held.current.content = queued.content;
    if (
      held.current &&
      !(
        removing.current?.sessionId === sessionId &&
        removing.current.messageId === held.current.messageId
      ) &&
      (!queued || !(isPausedComposerRow(queued, personClientIds) || isRestoredDraftRow(queued)))
    ) {
      const unchanged = input === held.current.content;
      held.current = null;
      useSessionChatStore.getState().updateSession(sessionId, { pausedComposerMessageId: null });
      // Clear an unchanged copy; the person's edits remain an unsent draft.
      if (unchanged) setInput('');
      return;
    }
    if (input !== '' || held.current) return;
    const own =
      (paused ? queue.find((row) => isPausedComposerRow(row, personClientIds)) : undefined) ??
      restored.find((row) => isRestoredDraftRow(row) && !spent.current.has(row.id));
    if (!own) return;
    held.current = { sessionId, messageId: own.id, content: own.content };
    useSessionChatStore.getState().updateSession(sessionId, { pausedComposerMessageId: own.id });
    setInput(own.content);
  }, [sessionId, paused, queue, restored, personClientIds, input, setInput]);

  /** Forget the held row on this window, once it is gone from the server. */
  function release(messageId: string): void {
    spent.current.add(messageId);
    if (held.current?.sessionId === sessionId && held.current.messageId === messageId) {
      held.current = null;
    }
    const store = useSessionChatStore.getState();
    if (store.getSession(sessionId).pausedComposerMessageId === messageId) {
      store.updateSession(sessionId, { pausedComposerMessageId: null });
    }
  }

  /** Discard a restored draft: its row goes, on every window, and so do its words here. */
  async function discard(): Promise<void> {
    const row = held.current;
    if (row?.sessionId !== sessionId || sending.current) return;
    sending.current = true;
    removing.current = row;
    try {
      await remove(sessionId, row.messageId);
      release(row.messageId);
      setInput('');
    } catch {
      toast.error('Couldn’t discard that draft. Try again.');
    } finally {
      removing.current = null;
      sending.current = false;
    }
  }

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
        release(row.messageId);
      }
      if (currentSession.current !== sessionId) return;
      await deliver(input);
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  const holding = held.current?.sessionId === sessionId;
  const heldId = holding ? held.current?.messageId : undefined;
  return {
    submit,
    discard,
    pending,
    restored: holding,
    restoredMessageId: heldId,
    /** The composer holds a restored draft (§7.3), so it shows the draft's line. */
    restoredDraft: heldId !== undefined && restored.some((row) => row.id === heldId),
    visibleQueue: queue.filter((row) => !holding || row.id !== held.current?.messageId),
  };
}

/** A stable empty list, so an absent option keeps the effect's dependencies still. */
const NO_RESTORED: QueuedMessage[] = [];
