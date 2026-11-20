import type { ApprovalAnswerContext } from '@dorkos/shared/step-up';
import { cn } from '@/layers/shared/lib';
import { ApprovalAnswerNote, Button, RequestCode } from '@/layers/shared/ui';

/** One-time offer below an answered row, held until a remote confirmation succeeds. */
export interface InboxDecisionOfferProps {
  text: string;
  requestCode?: string;
  answerContext?: ApprovalAnswerContext;
  pending?: boolean;
  onAccept(): void;
  onDismiss(): void;
}

/** Keep the offer and its matching code visible throughout confirmation. */
export function InboxDecisionOffer({ offer }: { offer: InboxDecisionOfferProps }) {
  const remote = offer.answerContext?.answerNeedsStepUp === true;
  return (
    <div
      data-slot="inbox-decision-follow-up"
      className={cn(
        'bg-status-success-bg text-status-success-fg border-status-success-border mx-2 mb-1.5 ml-9 flex justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs',
        remote ? 'flex-col items-stretch sm:flex-row sm:items-center' : 'items-center'
      )}
    >
      <div className="min-w-0 break-words">
        {offer.text}
        {offer.requestCode && <RequestCode code={offer.requestCode} />}
        <ApprovalAnswerNote context={offer.answerContext} />
      </div>
      <span className={cn('flex shrink-0 items-center gap-1', remote && 'w-full sm:w-auto')}>
        <Button
          type="button"
          variant="outline"
          size="xs"
          responsive={false}
          disabled={offer.pending}
          aria-busy={offer.pending || undefined}
          className={remote ? 'min-h-11 flex-1 sm:min-h-0 sm:flex-initial' : undefined}
          onClick={offer.onAccept}
        >
          Always do this
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          responsive={false}
          aria-label="No thanks"
          disabled={offer.pending}
          aria-busy={offer.pending || undefined}
          onClick={offer.onDismiss}
          className={cn(
            'text-muted-foreground',
            remote && 'min-h-11 flex-1 sm:min-h-0 sm:flex-initial'
          )}
        >
          No thanks
        </Button>
      </span>
    </div>
  );
}
