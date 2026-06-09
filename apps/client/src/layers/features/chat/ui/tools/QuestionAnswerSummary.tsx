import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { CompactResultRow } from '../primitives';
import type { QuestionItem } from '@dorkos/shared/types';

interface QuestionAnswerSummaryProps {
  questions: QuestionItem[];
  /** Persisted (history) answers, index-keyed. Takes precedence when present. */
  answers?: Record<string, string>;
  /** Live local selections for the submitting client before history reloads. */
  selections: Record<string, string | string[]>;
  /** Free-text ("Other") values, keyed by question index. */
  otherText: Record<string, string>;
}

/**
 * Resolve a question's answer to a display string, preferring persisted answers
 * and falling back to the submitting client's local selections.
 *
 * Legacy recordings stored multi-select answers as a JSON array; that encoding
 * is tolerated for multi-select questions only, so a single-select freeform
 * answer that merely looks like JSON is shown verbatim.
 */
function getDisplayValue(
  q: QuestionItem,
  idx: number,
  answers: Record<string, string> | undefined,
  selections: Record<string, string | string[]>,
  otherText: Record<string, string>
): string | null {
  const persisted = answers?.[String(idx)];
  if (persisted) {
    if (q.multiSelect && persisted.startsWith('[')) {
      try {
        return (JSON.parse(persisted) as string[]).join(', ');
      } catch {
        return persisted;
      }
    }
    return persisted;
  }
  const sel = selections[idx];
  if (!sel) return null;
  if (q.multiSelect) {
    return (sel as string[]).map((v) => (v === '__other__' ? otherText[idx] : v)).join(', ');
  }
  return sel === '__other__' ? otherText[idx] : (sel as string);
}

/**
 * Collapsed summary of submitted answers: a compact one-line row for a single
 * question, or a stacked header/value grid (one answer per line) for several.
 */
export function QuestionAnswerSummary({
  questions,
  answers,
  selections,
  otherText,
}: QuestionAnswerSummaryProps) {
  const checkIcon = <Check className="text-status-success size-(--size-icon-sm) shrink-0" />;

  // Collect each answered question's index, header, and resolved display value.
  const answered = questions
    .map((q, idx) => ({
      idx,
      header: q.header,
      value: getDisplayValue(q, idx, answers, selections, otherText),
    }))
    .filter(
      (entry): entry is { idx: number; header: string; value: string } => entry.value !== null
    );

  // No specific answers recovered (e.g. an observing client) — generic summary.
  if (answered.length === 0) {
    const generic =
      questions.length === 1 ? 'Question answered' : `${questions.length} questions answered`;
    return (
      <CompactResultRow
        data-testid="question-prompt-submitted"
        icon={checkIcon}
        label={<span className="truncate">{generic}</span>}
      />
    );
  }

  // Single question — keep it compact on one line.
  if (answered.length === 1) {
    return (
      <CompactResultRow
        data-testid="question-prompt-submitted"
        icon={checkIcon}
        label={<span className="truncate">{`${answered[0].header}: ${answered[0].value}`}</span>}
      />
    );
  }

  // Multiple questions — one answer per line so long values stay readable.
  return (
    <CompactResultRow
      data-testid="question-prompt-submitted"
      icon={checkIcon}
      label={<span className="text-muted-foreground">Questions answered</span>}
    >
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pl-6 text-xs">
        {answered.map(({ idx, header, value }) => (
          <Fragment key={idx}>
            <dt className="text-muted-foreground">{header}</dt>
            <dd className="text-foreground break-words">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </CompactResultRow>
  );
}
