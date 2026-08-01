/**
 * Groups answered approval requests into the receipts the transcript shows.
 *
 * Answering "Approve all" resolves each request on its own — the event stream
 * carries no batch identity — so three receipt lines in a row would be the
 * literal reading of the data. Three lines saying the same thing at the same
 * second is noise, though, so adjacent requests answered the same way at the
 * same moment collapse into one line with the individual asks behind an
 * expander. Anything that breaks the run (a text part, a different answer, a
 * later decision) starts a new receipt, so the transcript never claims two
 * separate decisions were one.
 *
 * Pure and index-based so the renderer can look up "which receipt owns this
 * part" without re-deriving anything.
 *
 * @module features/chat/lib/group-approval-receipts
 */
import type { MessagePart } from '@dorkos/shared/types';

/**
 * How far apart two answers can land and still read as one action, in ms.
 * A batch answer resolves its requests within the same request handler; a
 * person clicking two cards in a row takes far longer than this.
 */
const SAME_ANSWER_WINDOW_MS = 2_000;

/** The tool-call member of {@link MessagePart}. */
type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

/** How the grouped requests were answered. */
type ApprovalOutcome = NonNullable<ToolCallPart['approvalOutcome']>;

/** One receipt: the answered approval parts it speaks for, in transcript order. */
export interface ApprovalReceiptGroup {
  /** Index of the first part in the group — where the receipt renders. */
  leadIndex: number;
  /** Every part index the receipt speaks for, including the lead. */
  indices: number[];
  /** The answer every part in the group shares. */
  outcome: ApprovalOutcome;
}

/** An approval part that carries its answer. */
type AnsweredApprovalPart = ToolCallPart & { approvalOutcome: ApprovalOutcome };

/** Whether a part is an approval that has been answered (so it has a receipt). */
function isAnsweredApproval(part: MessagePart): part is AnsweredApprovalPart {
  return (
    part.type === 'tool_call' &&
    part.interactiveType === 'approval' &&
    part.approvalOutcome !== undefined
  );
}

/** Whether two answered approvals read as one decision. */
function sameDecision(a: AnsweredApprovalPart, b: AnsweredApprovalPart): boolean {
  if (a.approvalOutcome !== b.approvalOutcome) return false;
  // Neither side timestamped: nothing says they were separate decisions, and
  // they already share an outcome and adjacency.
  if (a.approvalResolvedAt === undefined && b.approvalResolvedAt === undefined) return true;
  if (a.approvalResolvedAt === undefined || b.approvalResolvedAt === undefined) return false;
  return Math.abs(a.approvalResolvedAt - b.approvalResolvedAt) <= SAME_ANSWER_WINDOW_MS;
}

/**
 * Map every answered-approval part index to the receipt that speaks for it.
 *
 * A part index absent from the map is not an answered approval. A part whose
 * group's `leadIndex` is not itself renders nothing — its lead already counted
 * it.
 *
 * @param parts - The assistant bubble's projected parts, in transcript order.
 * @returns Index → the receipt group covering it.
 */
export function groupApprovalReceipts(parts: MessagePart[]): Map<number, ApprovalReceiptGroup> {
  const groups = new Map<number, ApprovalReceiptGroup>();
  let open: { group: ApprovalReceiptGroup; part: AnsweredApprovalPart } | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!isAnsweredApproval(part)) {
      open = null;
      continue;
    }
    if (open && sameDecision(open.part, part)) {
      open.group.indices.push(i);
      groups.set(i, open.group);
      continue;
    }
    const group: ApprovalReceiptGroup = {
      leadIndex: i,
      indices: [i],
      outcome: part.approvalOutcome,
    };
    groups.set(i, group);
    open = { group, part };
  }

  return groups;
}
