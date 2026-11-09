import type { ConnectorAgentApproval } from '@dorkos/shared/connector-schemas';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { bucketElapsedMs, cn, formatCompactAge } from '@/layers/shared/lib';

/** How long ago, in words a screen reader says: "2 minutes ago". */
function spokenAge(iso: string): string {
  const { value, unit } = bucketElapsedMs(Date.now() - new Date(iso).getTime());
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/**
 * "Approved by DorkOS PM · Read only", with the approving agent's avatar and Bot badge and a muted
 * age: what a request another agent answered reads as, on its card and in Needs you alike,
 * matching the narrowing card (#3565) so agent actions read the same everywhere. Once the person
 * undid it, it reads "Undone by you" instead; "Approved by…" never stays after an Undo.
 *
 * The approver is the one kept on the approval when it was made (Security M1 on #3575), never
 * read live, so a later rename doesn't rewrite who approved. The badge is the point: the name
 * beside it is whatever the agent called itself, and could read as DorkOS; so the line's spoken
 * name says "an agent" in words. Nothing here is pressable; the person undoes it from Activity.
 */
export function AgentApprovalLine({
  approval,
  className,
}: {
  approval: ConnectorAgentApproval;
  className?: string;
}) {
  const name = approval.displayName ?? 'an agent';
  if (approval.undoneAt !== undefined) {
    return (
      <span
        data-slot="agent-approval"
        data-undone=""
        className={cn('text-muted-foreground flex min-w-0 items-center gap-1.5', className)}
      >
        <span className="sr-only">{`Undone by you, ${spokenAge(approval.undoneAt)}`}</span>
        <span aria-hidden>Undone by you</span>
        <time aria-hidden dateTime={approval.undoneAt} className="shrink-0 text-xs">
          {formatCompactAge(approval.undoneAt)}
        </time>
      </span>
    );
  }
  const visual = resolveAgentVisual({
    id: approval.agentId,
    ...(approval.color ? { color: approval.color } : {}),
    ...(approval.icon ? { icon: approval.icon } : {}),
  });
  return (
    <span data-slot="agent-approval" className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {/* The Bot badge says nothing to a screen reader, so the spoken line says "an agent". */}
      <span className="sr-only">
        {`Approved by ${name}, an agent, read only, ${spokenAge(approval.approvedAt)}`}
      </span>
      <span data-slot="agent-approval-approver" aria-hidden className="shrink-0">
        <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
      </span>
      {/* Wraps rather than cuts: on a phone the approver's name is the news. */}
      <span aria-hidden className="min-w-0 break-words">
        {`Approved by ${name} · Read only`}
      </span>
      <time
        aria-hidden
        dateTime={approval.approvedAt}
        className="text-muted-foreground shrink-0 text-xs"
      >
        {formatCompactAge(approval.approvedAt)}
      </time>
    </span>
  );
}
