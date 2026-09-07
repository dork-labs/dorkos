import { useNavigate } from '@tanstack/react-router';
import { SessionConnectionAccessList } from '@/layers/entities/connectors';
import { getPlatform } from '@/layers/shared/lib';

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
  return (
    <SessionConnectionAccessList
      sessionId={sessionId}
      onManage={embedded ? undefined : () => void navigate({ to: '/connections' })}
    />
  );
}
