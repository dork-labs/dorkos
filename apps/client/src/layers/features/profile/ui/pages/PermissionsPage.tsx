/**
 * Permissions — what this agent may do, where it differs from everyone else
 * (spec `agent-permissions`). The same rows Settings → Permissions shows, at
 * this agent's layer, plus the history of changes that touched it.
 *
 * @module features/profile/ui/pages/PermissionsPage
 */
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { PermissionHistory, PermissionList } from '@/layers/features/permissions';
import type { ProfilePageContentProps } from './types';

/** One agent's permissions, and the changes that touched it. */
export function PermissionsPage({ member }: ProfilePageContentProps) {
  const capabilities = useCapabilitiesForRuntime(member.agent?.runtime);
  // Default to supported while capabilities load, so a Claude agent never
  // flashes the note below.
  const supportsDorkTools = capabilities?.supportsMcp ?? true;

  return (
    <div className="space-y-6">
      {supportsDorkTools ? null : (
        <p className="text-muted-foreground text-sm">
          This agent’s runtime can’t use DorkOS tools, so these settings don’t change anything for
          it.
        </p>
      )}
      <PermissionList scope={{ kind: 'agent', agentId: member.id }} />
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">History</h3>
        <PermissionHistory agentId={member.id} />
      </section>
    </div>
  );
}
