import { cn, hashToHslColor, initialOf } from '@/layers/shared/lib';
import { IdentityAvatar } from '@/layers/shared/ui';
import { agentLabelFrom } from '../lib/agent-label';

export interface RequestingAgentProps {
  /**
   * Who asked — an agent path, a display name, or whatever label the request
   * carried. Absent when the requester presented no identity.
   */
  requestedBy?: string;
  className?: string;
}

/**
 * The mark and name of whoever asked for approval.
 *
 * Same visual language as an author in the message list: a letter avatar tinted
 * with a color hashed from the requester's own identity, so one agent always
 * reads as the same color everywhere in the cockpit. An unattributed request —
 * a person on the CLI, an external MCP client with no agent token — says so
 * plainly rather than inventing an agent.
 */
export function RequestingAgent({ requestedBy, className }: RequestingAgentProps) {
  if (!requestedBy) {
    return (
      <span className={cn('text-muted-foreground text-xs', className)}>
        Requested without an agent identity
      </span>
    );
  }

  const label = agentLabelFrom(requestedBy);

  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <IdentityAvatar
        data-slot="requesting-agent-avatar"
        aria-hidden
        size="xs"
        color={hashToHslColor(requestedBy)}
        fallback={initialOf(label)}
      />
      <span className="text-muted-foreground min-w-0 truncate text-xs">{label}</span>
    </span>
  );
}
