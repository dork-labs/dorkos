import { usePermissions } from '@/layers/entities/permissions';
import { MoreDetails } from '@/layers/shared/ui';

/**
 * Said out loud when DorkOS cannot read its record of which new agents it has
 * checked: until it can, every agent's own settings count only where they are
 * stricter than everyone's, so an agent may do less right now than its own
 * rows say. Renders nothing otherwise.
 */
export function NewAgentRecordNotice() {
  const { data } = usePermissions();
  if (!data?.newAgentRecordUnreadable) return null;
  return (
    <div
      role="status"
      data-testid="permissions-record-unreadable"
      className="text-muted-foreground rounded-md border px-3 py-2 text-sm"
    >
      <p>Some agents may do less than their own settings allow.</p>
      <MoreDetails className="mt-1">
        <p>DorkOS couldn’t read its list of checked agents.</p>
        <p>Each agent gets the stricter of its own and everyone’s settings.</p>
        <p>It tries again when you add or remove an agent.</p>
      </MoreDetails>
    </div>
  );
}
