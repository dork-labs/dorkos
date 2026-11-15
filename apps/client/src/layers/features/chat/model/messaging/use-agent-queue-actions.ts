/**
 * The two things a person can do with a message another agent left in this
 * chat's queue (DOR-3060): send it now, or not deliver it. Neither edits it;
 * those words are the other agent's.
 *
 * @module features/chat/model/messaging/use-agent-queue-actions
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { SteerQueuedChatMessageResponse } from '@dorkos/shared/schemas';
import { useTransport } from '@/layers/shared/model';

/** What a row says after Send now could only move it to the front. */
export function sendNowNotice(result: SteerQueuedChatMessageResponse): string | null {
  if (result.outcome === 'steered') return null;
  return result.reason === 'no-running-turn'
    ? 'Sends next.'
    : 'Sends next. This agent can’t take it mid-turn.';
}

/** What the person is told once a message is taken off the queue. */
export function notDeliveredLine(senderName: string): string {
  return `Not delivered. ${senderName}’s chat shows it.`;
}

/** Send now and Don't deliver, for a queued message from another agent. */
export interface AgentQueueActions {
  /** Send it into the running turn, or put it first when it may not join. */
  sendNow: (id: string) => void;
  /** Take it off the queue; its sender is told who removed it. */
  dontDeliver: (id: string, senderName: string) => void;
  /** A row's note after Send now moved it to the front instead, by row id. */
  notices: Readonly<Record<string, string>>;
}

/** A queue call that failed only because the message already left the queue. */
function isGone(err: unknown): boolean {
  return (err as { code?: string })?.code === 'QUEUED_MESSAGE_NOT_FOUND';
}

/**
 * Send now and Don't deliver for one chat's queue.
 *
 * @param sessionId - The chat whose queue holds the messages.
 */
export function useAgentQueueActions(sessionId: string | null): AgentQueueActions {
  const transport = useTransport();
  const [notices, setNotices] = useState<Record<string, string>>({});

  const sendNow = useCallback(
    (id: string) => {
      if (!sessionId) return;
      void transport.steerQueuedChatMessage(sessionId, id).then(
        (result) => {
          const notice = sendNowNotice(result);
          if (notice !== null) setNotices((prev) => ({ ...prev, [id]: notice }));
        },
        (err: unknown) => {
          if (!isGone(err)) toast.error('Couldn’t send that message now');
        }
      );
    },
    [sessionId, transport]
  );

  const dontDeliver = useCallback(
    (id: string, senderName: string) => {
      if (!sessionId) return;
      void transport.removeQueuedMessage(sessionId, id).then(
        () => toast(notDeliveredLine(senderName)),
        (err: unknown) => {
          if (isGone(err)) return;
          // Send now was already carrying it into the running turn.
          if ((err as { code?: string })?.code === 'QUEUED_MESSAGE_LAUNCHING') {
            toast('It’s already on its way.');
            return;
          }
          toast.error('Couldn’t take that message off the queue');
        }
      );
    },
    [sessionId, transport]
  );

  return { sendNow, dontDeliver, notices };
}
