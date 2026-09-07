import { useNavigate } from '@tanstack/react-router';
import { SessionConnectionAccessList } from '@/layers/entities/connectors';
import { getPlatform, requestComposerInsert } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

const CONNECTION_REQUEST_PROMPT =
  'I need access to another service. Ask me which service and actions you need, then request only that access.';

/**
 * Read-only connector access summary for one session. Access changes happen in
 * Connections, where an owner reviews exact immutable operations for an agent.
 *
 * @param props - The session whose durable connector access state is rendered.
 * @param props.sessionId - The active session id.
 */
export function SessionConnectorsGroup({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const embedded = getPlatform().isEmbedded;
  const askAgent = (
    <Button
      variant="secondary"
      size="sm"
      data-testid={`ask-agent-for-connection-${sessionId}`}
      onClick={() => requestComposerInsert(CONNECTION_REQUEST_PROMPT)}
    >
      Ask your agent
    </Button>
  );
  return (
    <SessionConnectionAccessList
      sessionId={sessionId}
      onManage={embedded ? undefined : () => void navigate({ to: '/connections' })}
      emptyAction={askAgent}
      footer={<div className="pt-1">{askAgent}</div>}
    />
  );
}
