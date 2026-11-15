import { AgentPausedNotice, useAgentPause } from '@/layers/entities/mesh';
import { useSessionQueue } from '@/layers/entities/session';

interface SessionPausedQueueNoticeProps {
  sessionId: string;
  agentId: string | null;
  agentName?: string;
}

/** Explain why a person's queued message is kept after pausing ends the turn. */
export function SessionPausedQueueNotice({
  sessionId,
  agentId,
  agentName,
}: SessionPausedQueueNoticeProps) {
  const pause = useAgentPause(agentId);
  // The visible queue omits an idle head as "about to start". A pause holds
  // exactly that head, so the notice must read the raw server queue instead.
  const queue = useSessionQueue(sessionId);
  const hasOwnMessage = queue.some(
    (message) => message.fromChats === undefined && !message.enqueuedBy.startsWith('chat:')
  );
  if (!pause || !hasOwnMessage || agentId === null) return null;

  return <AgentPausedNotice agentId={agentId} agentName={agentName} held />;
}
