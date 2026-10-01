import { ExternalLinkAnchor } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/**
 * Who DorkOS Cloud is for, word for word as the pricing page says it. Kept here
 * once so the Settings plan section and the hosted-community dialogs cannot say
 * it two different ways.
 */
export const CLOUD_ELIGIBILITY_TEXT =
  'Paid plans, and spaces that run on DorkOS for you, are for people in the United States who are 18 or older.';

/**
 * Where the full answer lives: the pricing page's questions, which include
 * "Who can buy a plan?".
 */
export const CLOUD_ELIGIBILITY_URL = 'https://dorkos.ai/pricing#faq';

/** Props for {@link CloudEligibilityNote}. */
export interface CloudEligibilityNoteProps {
  /** Extra classes for the paragraph, such as spacing from its neighbours. */
  className?: string;
}

/**
 * One quiet line saying who can buy a plan or have DorkOS host a community,
 * with a link to the full answer.
 *
 * It sits where somebody decides, before the button that commits them, and it
 * is muted text rather than an alert: it is a fact to know, not a warning. It
 * names no plan and no price, because the app knows neither.
 */
export function CloudEligibilityNote({ className }: CloudEligibilityNoteProps) {
  return (
    <p className={cn('text-muted-foreground text-xs', className)}>
      {CLOUD_ELIGIBILITY_TEXT}{' '}
      <ExternalLinkAnchor
        href={CLOUD_ELIGIBILITY_URL}
        className="text-foreground underline underline-offset-2"
      >
        Who can buy a plan?
      </ExternalLinkAnchor>
    </p>
  );
}
