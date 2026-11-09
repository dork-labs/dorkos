import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import type { AgentApproval } from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { cn, formatCompactAge } from '@/layers/shared/lib';

/**
 * "Approved by DorkOS PM · Read only", with the approving agent's avatar and
 * Bot badge and a muted age: what a request an agent answered reads as, on
 * its card and in Needs you alike, matching the narrowing card (#3565) so
 * agent actions read the same everywhere.
 *
 * The badge is the point: the name beside it is whatever the agent called
 * itself, and could read as DorkOS. Nothing here is pressable; the person
 * undoes it from Activity.
 */
export function AgentApprovalLine({
  approval,
  className,
}: {
  approval: AgentApproval;
  className?: string;
}) {
  const { data } = useRegisteredAgents();
  const approver = data?.agents.find((candidate) => candidate.id === approval.actorId);
  const name = approver ? (approver.displayName ?? approver.name) : 'an agent';
  const visual = approver ? resolveAgentVisual(approver) : null;
  return (
    <span data-slot="agent-approval" className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {visual && (
        <span data-slot="agent-approval-approver" className="shrink-0">
          <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
        </span>
      )}
      {/* Wraps rather than cuts: on a phone the approver's name is the news. */}
      <span className="text-foreground min-w-0 break-words">{`Approved by ${name} · Read only`}</span>
      <time dateTime={approval.createdAt} className="text-muted-foreground shrink-0 text-xs">
        {formatCompactAge(approval.createdAt)}
      </time>
    </span>
  );
}
