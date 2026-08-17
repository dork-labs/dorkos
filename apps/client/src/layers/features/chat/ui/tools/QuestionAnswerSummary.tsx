import { Fragment } from 'react';
import { Check, Clock, HelpCircle, MinusCircle, X } from 'lucide-react';
import { CompactResultRow, TruncatedOutput } from '../primitives';
import type { QuestionItem, QuestionOutcome } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';

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

/** How each unanswered ending reads, and what it looks like. */
const UNANSWERED: Record<
  Exclude<QuestionOutcome, 'answered'>,
  { label: string; Icon: typeof Clock; iconClass: string }
> = {
  expired: { label: 'Nobody answered in time', Icon: Clock, iconClass: 'text-muted-foreground' },
  denied: { label: 'Question dismissed', Icon: MinusCircle, iconClass: 'text-muted-foreground' },
  cancelled: {
    label: 'Question withdrawn',
    Icon: MinusCircle,
    iconClass: 'text-muted-foreground',
  },
  errored: { label: "The question didn't go through", Icon: X, iconClass: 'text-status-error' },
  // The turn ended without recording an ending at all — interrupted, crashed,
  // or trimmed out of the log. Says only what is known, which is nothing.
  unresolved: {
    label: 'No answer was recorded',
    Icon: HelpCircle,
    iconClass: 'text-muted-foreground',
  },
};

/**
 * The row a question gets when it ended with no answer.
 *
 * Every one of these used to render as a green "Question answered" — the
 * renderer had only "no answers" to go on, which is what an unanswered question
 * and an answered one somebody else submitted look equally like (DOR-1293).
 *
 * The transcript's own words ride along whenever there are any, under the label
 * rather than instead of it: the label is the honest summary and the result is
 * the evidence for it, and a reader chasing down what an agent actually saw
 * should never have to take the summary's word for it.
 */
export function QuestionUnansweredRow({
  outcome,
  result,
}: {
  /** How it ended. Never `answered` — that has its own summary. */
  outcome: Exclude<QuestionOutcome, 'answered'>;
  /** What the transcript recorded, when it recorded anything. */
  result?: string;
}) {
  const { label, Icon, iconClass } = UNANSWERED[outcome];
  return (
    <CompactResultRow
      data-testid="question-prompt-unanswered"
      data-outcome={outcome}
      icon={<Icon className={cn('size-(--size-icon-sm) shrink-0', iconClass)} />}
      label={<span className="truncate">{label}</span>}
    >
      {result && (
        <TruncatedOutput
          data-testid="question-prompt-result"
          content={result}
          className="text-muted-foreground mt-1 pl-6"
        />
      )}
    </CompactResultRow>
  );
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
