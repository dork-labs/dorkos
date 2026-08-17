import type { ReactNode } from 'react';
import type { MessagePart } from '@dorkos/shared/types';
import { getToolLabel } from '@/layers/shared/lib';
import { ApprovalReceipt } from './ApprovalReceipt';
import { TruncatedOutput } from '../primitives';
import type { ApprovalReceiptGroup } from '../../lib/group-approval-receipts';

/** The `tool_call` member of {@link MessagePart}. */
type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

interface ApprovalReceiptRowProps {
  /** The grouped decision — its outcome, and whether a reason was carried. */
  group: ApprovalReceiptGroup;
  /** Every answered ask the receipt speaks for, in transcript order. */
  members: ToolCallPart[];
  /** The group's lead part, which carries the timestamps and the result text. */
  lead: ToolCallPart;
  /**
   * The members' own tool cards, rendered by the caller (they need the message
   * renderer's MCP-App wrapper) and shown ONLY when the decision allowed them.
   * Passed in rather than gated by the caller so one place decides.
   */
  children?: ReactNode;
}

/**
 * One answered permission decision, at the place in the transcript where it was
 * asked — the receipt line, whatever the agent was told, and (only for an
 * allowed tool) the tool cards themselves.
 *
 * What renders under the line is the point of the split:
 *
 * - **Allowed** — the tool ran, so it keeps everything an ungated tool would
 *   show, inline MCP App included.
 * - **Denied or expired** — the tool never ran, so there is no output and no
 *   card. But `result` is not output: when the receipt was read out of a
 *   runtime's own transcript rather than out of a DorkOS answer, it is the
 *   sentence the model was actually handed — the person's words after "the user
 *   said:", or the command a permission rule blocked — and it is often the only
 *   record of WHY. Suppressing it along with the card threw that away
 *   (DOR-1293). A receipt may summarise the transcript; it may not delete it.
 *
 * ## What that text can contain, and why it is shown anyway
 *
 * A rule refusal echoes the WHOLE blocked command, absolute paths and all — and
 * a command can carry a secret inline (`curl -H "Authorization: Bearer …"`).
 * Showing it is a deliberate choice, not an oversight. This is the operator's
 * own transcript of their own machine, rendered to the person the agent was
 * acting for; the tool card one row up already prints the command for every
 * call that was ALLOWED, so suppressing it only for refusals would hide the
 * command in exactly the case somebody is most likely to be auditing. Nothing
 * here is transmitted anywhere. A surface that leaves the machine — a shared
 * artifact, a bridged room — would owe this a different answer.
 */
export function ApprovalReceiptRow({ group, members, lead, children }: ApprovalReceiptRowProps) {
  return (
    <div className="flex flex-col">
      <ApprovalReceipt
        outcome={group.outcome}
        items={members.map((member) => ({
          toolCallId: member.toolCallId,
          label: member.approvalDisplayName || getToolLabel(member.toolName, member.input ?? ''),
        }))}
        resolvedAt={lead.approvalResolvedAt}
        startedAt={lead.approvalStartedAt}
        reasonGiven={group.reasonGiven}
      />
      {group.outcome !== 'allowed' && lead.result && (
        <TruncatedOutput
          data-testid="approval-receipt-result"
          content={lead.result}
          className="text-muted-foreground mt-0.5 ml-6"
        />
      )}
      {group.outcome === 'allowed' && children}
    </div>
  );
}
