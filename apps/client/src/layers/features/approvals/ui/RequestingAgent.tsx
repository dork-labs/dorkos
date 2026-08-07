import { cn, hashToHslColor, initialOf } from '@/layers/shared/lib';
import { IdentityAvatar } from '@/layers/shared/ui';
import { agentLabelFrom } from '../lib/agent-label';

export interface RequestingAgentProps {
  /**
   * Who asked — an agent path, a display name, or whatever label the request
   * carried. Absent when the requester presented no identity.
   */
  requestedBy?: string;
  /**
   * Whether DorkOS actually knows WHICH agent asked — the same bit
   * `ApprovalCard` reads to decide whether to offer a standing grant
   * (`PendingApproval.hasAgentPath`, `@dorkos/shared/approval-schemas`).
   *
   * `requestedBy` is only a display LABEL, and the trap the schema's own
   * TSDoc names is exactly this component's: the marketplace confirmation
   * flow sets `requestedBy` on approvals that carry no agent path at all, so
   * a card can show a label with nothing behind it. Required rather than
   * optional for the same reason the schema field is — an absent boolean
   * would default to "agent" by accident, which is the wrong side to fail on.
   */
  hasAgentPath: boolean;
  className?: string;
}

/**
 * The mark and name of whoever asked for approval.
 *
 * Same visual language as an author in the message list: a letter avatar
 * hashed from the requester's own identity, so one agent always reads as the
 * same color everywhere in the cockpit. `kind="agent"` draws the square,
 * filled, Bot-badged disc every other agent surface draws — but only when
 * `hasAgentPath` confirms there IS one (spec `identity-consistency` W1.3).
 * A `requestedBy` label with no agent path behind it (the marketplace
 * confirmation flow) draws the plain, undeclared circle instead: a label
 * without a path is not evidence of an agent, and drawing one anyway would
 * put a person's or the system's request under a Bot mark it never earned.
 * An unattributed request — a person on the CLI, an external MCP client with
 * no agent token — says so plainly rather than inventing an identity at all.
 */
export function RequestingAgent({ requestedBy, hasAgentPath, className }: RequestingAgentProps) {
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
        kind={hasAgentPath ? 'agent' : undefined}
      />
      <span className="text-muted-foreground min-w-0 truncate text-xs">{label}</span>
    </span>
  );
}
