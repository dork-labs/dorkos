import type { ReactNode } from 'react';
import { useSessionConnectorAgentRequests } from '@/layers/entities/connectors';
import { findCallRequest } from '../../lib/agent-request-call';
import { AgentRequestCard } from './AgentRequestCard';

/** Props for {@link ChatAgentRequest}. */
export interface ChatAgentRequestProps {
  /** The conversation the call belongs to. */
  sessionId: string;
  /** The `request_connection` call's arguments, as recorded. */
  input: string | undefined;
  /** The call's result, once it returned. */
  result: string | undefined;
  /** What to draw when no request of this owner's belongs to the call. */
  fallback: ReactNode;
}

/**
 * The owner's card for an agent's `request_connection` call, drawn in place of
 * the call itself in the transcript.
 *
 * The call is the anchor, so the card sits exactly where the agent asked and
 * comes back after a reload. Which request it is comes from the owner's own
 * read of this conversation's requests. When there is none (the call was
 * refused before a request existed, or this reader is not the owner, who is
 * the only one who can read requests) the ordinary tool card shows instead,
 * so nobody else sees a card they cannot answer.
 */
export function ChatAgentRequest({ sessionId, input, result, fallback }: ChatAgentRequestProps) {
  const requests = useSessionConnectorAgentRequests(sessionId);
  const request = requests.data ? findCallRequest(requests.data, { input, result }) : undefined;
  if (!request) return <>{fallback}</>;
  return (
    <div className="my-3" data-testid="chat-agent-request">
      <AgentRequestCard request={request} />
    </div>
  );
}
