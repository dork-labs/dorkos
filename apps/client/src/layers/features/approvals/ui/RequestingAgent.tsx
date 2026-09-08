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
  /**
   * Whether the CALLER knows an agent asked, even though nothing named which.
   *
   * A narrower fact than `hasAgentPath`, and the two are not the same question.
   * The schedule-approval card reaches this component only on the branch where
   * an agent proposed the schedule — DorkOS itself and a file on disk are both
   * handled before it — so there it knows the asker was an agent while holding
   * no path to say which one. An approvals card knows no such thing: a request
   * with no identity may equally be a person on the CLI.
   */
  attributedToAgent?: boolean;
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
 * The fallback when nothing at all is known about the asker.
 *
 * Plain on purpose. The sentence this replaced — "Requested without an agent
 * identity" — is internal vocabulary: "agent identity" is a thing in the code,
 * not a thing a person has a picture of. This says the same fact in words
 * somebody reads once.
 *
 * It is a stronger claim than the old wording, which is why it is not the only
 * fallback. On a card that DOES know an agent asked, saying DorkOS does not know
 * who asked would contradict the card's own next line — see
 * {@link AGENT_UNNAMED_LABEL}.
 */
const UNKNOWN_ORIGIN_LABEL = 'DorkOS doesn’t know who asked';

/**
 * The fallback when an agent asked and nothing recorded which one.
 *
 * The schedule-approval card's case: it reaches this component only on the
 * agent-proposed branch, so "we don't know who asked" would be false there and
 * would sit directly above that card's own "Proposed by an agent". Naming what
 * is known, and only that, is the same rule the origin labels follow.
 */
const AGENT_UNNAMED_LABEL = 'An agent asked — DorkOS can’t say which';

/**
 * What to say about an asker nothing named.
 *
 * Most specific true thing wins: that it WAS an agent beats which surface it
 * came over, and either beats admitting nothing. Every rung says only what is
 * known — the point of the whole ladder is that no rung overstates.
 *
 * @param attributedToAgent - Whether the caller knows an agent asked.
 * @param origin - Which surface the request arrived over, when known.
 * @returns The sentence to render.
 */
function unnamedAskerLabel(attributedToAgent: boolean, origin?: ApprovalOrigin): string {
  if (attributedToAgent) return AGENT_UNNAMED_LABEL;
  if (origin) return ORIGIN_LABEL[origin];
  return UNKNOWN_ORIGIN_LABEL;
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
 * Plainly, but not vaguely: when the request's SURFACE is known it says that,
 * because "we do not know who" and "we do not know anything" are different
 * sentences and only the first one is true (DOR-1929).
 */
export function RequestingAgent({
  requestedBy,
  hasAgentPath,
  origin,
  attributedToAgent,
  className,
}: RequestingAgentProps) {
  if (!requestedBy) {
    return (
      <span className={cn('text-muted-foreground text-xs', className)}>
        {unnamedAskerLabel(attributedToAgent === true, origin)}
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
