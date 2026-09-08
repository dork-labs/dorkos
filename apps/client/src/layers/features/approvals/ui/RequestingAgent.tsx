import type { ApprovalOrigin } from '@dorkos/shared/approval-schemas';
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
  /**
   * Which surface the request arrived over, when nothing named the caller.
   *
   * Only ever present alongside an absent `requestedBy` — the server withholds
   * it once a caller is named, so the two can never contradict each other here.
   */
  origin?: ApprovalOrigin;
  className?: string;
}

/**
 * What an unattributed request can honestly be said to be.
 *
 * In-session identity is STRUCTURAL: it resolves only when the session's
 * working directory is a registered agent's home with a live token. An ordinary
 * session in an ordinary project folder therefore has no identity, and that is
 * correct rather than broken — but "Requested without an agent identity"
 * describes it as if the request came from nowhere, when the surface it arrived
 * over is known exactly. These say the known thing instead.
 */
const ORIGIN_LABEL: Record<ApprovalOrigin, string> = {
  session: 'Asked from a session on this computer',
  'external-mcp': 'Asked by an app connected to DorkOS',
};

/**
 * The fallback when even the surface is unknown.
 *
 * Plain on purpose. The sentence this replaced — "Requested without an agent
 * identity" — is internal vocabulary: "agent identity" is a thing in the code,
 * not a thing a person has a picture of. This says the same fact in words
 * somebody reads once. It is also the line the schedule-approval card falls back
 * to, so it has to be true of a proposal as well as of a tool call.
 */
const UNKNOWN_ORIGIN_LABEL = 'DorkOS doesn’t know who asked';

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
 * Plainly, but not vaguely: when the request's SURFACE is known it says that,
 * because "we do not know who" and "we do not know anything" are different
 * sentences and only the first one is true (DOR-1929).
 */
export function RequestingAgent({
  requestedBy,
  hasAgentPath,
  origin,
  className,
}: RequestingAgentProps) {
  if (!requestedBy) {
    return (
      <span className={cn('text-muted-foreground text-xs', className)}>
        {origin ? ORIGIN_LABEL[origin] : UNKNOWN_ORIGIN_LABEL}
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
