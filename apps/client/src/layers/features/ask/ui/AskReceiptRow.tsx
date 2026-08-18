import type { ReactNode } from 'react';
import type { MessagePart, ToolApprovalOutcome } from '@dorkos/shared/types';
import { getToolLabel } from '@/layers/shared/lib';
import { AskReceipt } from './AskReceipt';
import { TruncatedOutput } from '@/layers/shared/ui';

/** The `tool_call` member of {@link MessagePart}. */
type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

interface AskReceiptRowProps {
  /** How the grouped decision was answered. */
  outcome: ToolApprovalOutcome;
  /** Whether every ask in the group carried the person's words to the agent. */
  reasonGiven: boolean;
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
export function AskReceiptRow({
  outcome,
  reasonGiven,
  members,
  lead,
  children,
}: AskReceiptRowProps) {
  return (
    <div className="flex flex-col">
      <AskReceipt
        outcome={outcome}
        items={members.map((member) => ({
          toolCallId: member.toolCallId,
          label: member.approvalDisplayName || getToolLabel(member.toolName, member.input ?? ''),
        }))}
        resolvedAt={lead.approvalResolvedAt}
        startedAt={lead.approvalStartedAt}
        reasonGiven={reasonGiven}
      />
      {outcome !== 'allowed' && lead.result && (
        <TruncatedOutput
          data-testid="approval-receipt-result"
          content={lead.result}
          className="text-muted-foreground mt-0.5 ml-6"
        />
      )}
      {outcome === 'allowed' && children}
    </div>
  );
}
