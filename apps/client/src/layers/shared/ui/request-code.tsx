/** Shared display for a request code and the server-derived answering context. */
import type { ApprovalAnswerContext } from '@dorkos/shared/step-up';
import { cn } from '@/layers/shared/lib/utils';

/** A server-derived request fingerprint, display only and never truncated. */
export function RequestCode({ code, id }: { code: string; id?: string }) {
  const spoken = code
    .split('-')
    .map((group) => group.split('').join(' '))
    .join(', ');
  return (
    <span
      id={id}
      role="group"
      aria-label={`Request ${spoken}`}
      className="inline-flex flex-wrap items-baseline gap-x-2 text-sm"
    >
      <span aria-hidden="true" className="text-muted-foreground">
        Request
      </span>
      <span
        aria-hidden="true"
        className="text-foreground font-mono tracking-wide whitespace-nowrap tabular-nums"
      >
        {code}
      </span>
    </span>
  );
}

/** What a yes asks for away from the desk, where every allow on the card confirms. */
const ALLOW_CONFIRMS = 'Allowing asks you to confirm it’s you.';

/**
 * Explain confirmation using the server's device label, never a browser-name guess.
 *
 * @param confirms - The line naming which answer asks to confirm, or `null`
 *   when no answer on the card does (a one-time tool Allow goes straight through).
 */
export function ApprovalAnswerNote({
  context,
  className,
  confirms = ALLOW_CONFIRMS,
}: {
  context?: ApprovalAnswerContext;
  className?: string;
  confirms?: string | null;
}) {
  if (!context?.answerNeedsStepUp) return null;
  const line = context.onWifi ? 'Answer at your computer or over Remote Access.' : confirms;
  return (
    <div
      data-slot="approval-step-up-note"
      className={cn('text-muted-foreground mt-2 text-xs', className)}
    >
      <p>
        {context.answeringFrom
          ? `You’re answering from ${context.answeringFrom}.`
          : 'You’re answering away from your computer.'}
      </p>
      {line && <p>{line}</p>}
    </div>
  );
}
