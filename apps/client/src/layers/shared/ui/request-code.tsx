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

/** Explain confirmation using the server's device label, never a browser-name guess. */
export function ApprovalAnswerNote({
  context,
  className,
}: {
  context?: ApprovalAnswerContext;
  className?: string;
}) {
  if (!context?.answerNeedsStepUp) return null;
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
      <p>
        {context.onWifi
          ? 'On Wi-Fi, answer on the computer running DorkOS.'
          : 'Allowing asks you to confirm it’s you.'}
      </p>
    </div>
  );
}
