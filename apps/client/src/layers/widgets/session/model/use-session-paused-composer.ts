import type { QueuedMessage } from '@dorkos/shared/schemas';
import { useSessionQueue } from '@/layers/entities/session';
import { useConversation } from '@/layers/features/conversation';
import { useTransport } from '@/layers/shared/model';
import { usePausedComposerDraft } from './use-paused-composer-draft';

interface SessionPausedComposerOptions {
  sessionId: string;
  paused: boolean;
  input: string;
  setInput: (text: string) => void;
  waiting: QueuedMessage[];
  dismissPalettes: () => void;
}

/**
 * Keep a restored pause draft on the session's ordinary delivery paths.
 *
 * @param options - The session draft and its visible queue selection
 */
export function useSessionPausedComposer({
  sessionId,
  paused,
  input,
  setInput,
  waiting,
  dismissPalettes,
}: SessionPausedComposerOptions) {
  const transport = useTransport();
  const { target } = useConversation();
  const queue = useSessionQueue(sessionId);
  const draft = usePausedComposerDraft({
    sessionId,
    paused,
    queue,
    personClientIds: transport.clientId ? [transport.clientId] : [],
    input,
    setInput,
    send: async (text) => {
      if (target?.canSend) await target.send({ text });
    },
    remove: (id, messageId) => transport.removeQueuedMessage(id, messageId),
  });

  return {
    waiting: waiting.filter((row) => row.id !== draft.restoredMessageId),
    blocked: draft.pending || (paused && draft.restored),
    submit: () => {
      dismissPalettes();
      if (target?.canSend) void draft.submit();
    },
    // Queue, Steer and Add context retain their native-command and confirmed-clear
    // behaviour. The pause hook only removes the original held row first.
    delivery: (deliver: () => void) => () => {
      dismissPalettes();
      if (draft.restored) void draft.submit({ deliver: async () => deliver() });
      else deliver();
    },
  };
}
