import { ShieldOff } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionMode } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';

interface SessionData {
  permissionMode?: PermissionMode;
}

/** Persistent warning banner when dangerous permission modes are active. */
export function PermissionBanner({ sessionId }: { sessionId: string | null }) {
  const queryClient = useQueryClient();

  if (!sessionId) return null;

  const session = queryClient.getQueryData<SessionData>(['session', sessionId]);
  if (!session || session.permissionMode !== 'bypassPermissions') return null;

  return (
    <div
      role="alert"
      className={cn(
        'flex items-center gap-2 border-b px-4 py-1.5',
        'border-red-200 bg-red-50 text-red-700',
        'dark:border-red-900 dark:bg-red-950/50 dark:text-red-400'
      )}
    >
      <ShieldOff className="size-3.5 shrink-0" />
      <span className="text-xs font-medium">
        All permissions bypassed — the agent can execute any tool without approval
      </span>
    </div>
  );
}
