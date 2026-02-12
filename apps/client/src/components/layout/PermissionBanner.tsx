import { useQuery } from '@tanstack/react-query';
import { useTransport } from '../../contexts/TransportContext';

export function PermissionBanner({ sessionId }: { sessionId: string | null }) {
  const transport = useTransport();
  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => transport.getSession(sessionId!),
    enabled: !!sessionId,
  });

  if (!session || session.permissionMode !== 'bypassPermissions') return null;

  return (
    <div className="bg-red-600 text-white text-center text-sm py-1 px-4">
      Permissions bypassed - all tool calls auto-approved
    </div>
  );
}
