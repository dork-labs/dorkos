import { ShieldOff } from 'lucide-react';

import { Banner } from '@/layers/shared/ui';
import { usePermissionBypassed } from '../model/use-permission-bypassed';

/**
 * Standing warning shown while a session runs with every permission bypassed —
 * the agent can execute any tool without asking. Amber (warning) and
 * non-dismissible: it clears itself only when the session leaves bypass mode.
 * The embedded shell mounts it directly; the web app renders it through the
 * global banner slot.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function PermissionBanner({ sessionId }: { sessionId: string | null }) {
  const bypassed = usePermissionBypassed(sessionId);
  if (!bypassed) return null;

  return (
    <Banner variant="warning" icon={ShieldOff}>
      <span className="font-medium">
        All permissions bypassed — the agent can execute any tool without approval
      </span>
    </Banner>
  );
}
