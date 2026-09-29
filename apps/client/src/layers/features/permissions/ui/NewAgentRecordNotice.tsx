import { usePermissions } from '@/layers/entities/permissions';

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
    <p
      role="status"
      data-testid="permissions-record-unreadable"
      className="text-muted-foreground rounded-md border px-3 py-2 text-sm"
    >
      DorkOS couldn’t read its record of which new agents it has checked, so agents are using
      everyone’s settings wherever their own would let them do more. It will try again the next time
      an agent is added or removed.
    </p>
  );
}
