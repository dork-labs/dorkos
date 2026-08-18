/**
 * What a card says once it has been answered — the sentence, not the silence.
 *
 * @module features/ask/ui/AskReceiptLine
 */
import type { AskReceipt } from '@/layers/entities/attention';
import { AskCard, type AskCardReceiptTone } from './AskCard';

/** Clock time for the receipt, in the reader's locale (e.g. `2:41 PM`). */
function clockTime(isoTime: string): string {
  const at = new Date(isoTime);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The receipt line for one answered prompt.
 *
 * Five endings, five sentences, and none of them is a disappearance:
 *
 * | Ending                                 | Line                            |
 * | -------------------------------------- | ------------------------------- |
 * | you answered it here                   | `You allowed this` / `You said no` |
 * | somebody else did, and we know who     | `Already allowed by Dorian at 2:01` |
 * | somebody else did, and we do not       | `Already answered at 2:01`      |
 * | the session went away                  | `No longer needed`              |
 * | the clock answered                     | `Nobody answered in time`       |
 *
 * @param receipt - How the prompt ended.
 */
export function AskReceiptLine({ receipt }: { receipt: AskReceipt }) {
  const at = clockTime(receipt.resolvedAt);
  let tone: AskCardReceiptTone = 'neutral';
  let line: string;

  if (receipt.outcome === 'expired') {
    line = 'Nobody answered in time';
  } else if (receipt.outcome === 'cancelled') {
    line = 'No longer needed';
  } else if (receipt.byThisWindow) {
    tone = receipt.decision === 'denied' ? 'denied' : 'allowed';
    line =
      receipt.decision === 'denied'
        ? 'You said no'
        : receipt.decision === 'answered'
          ? 'You answered this'
          : 'You allowed this';
  } else if (receipt.resolvedBy) {
    tone = 'allowed';
    line = `Already allowed by ${receipt.resolvedBy}${at ? ` at ${at}` : ''}`;
  } else {
    line = `Already answered${at ? ` at ${at}` : ''}`;
  }

  return <AskCard.Receipt tone={tone}>{line}</AskCard.Receipt>;
}
