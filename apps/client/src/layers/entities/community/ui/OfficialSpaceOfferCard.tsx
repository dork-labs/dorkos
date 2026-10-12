import { useId } from 'react';
import { UsersRound } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useOfficialSpaceOffer } from '../model/use-official-space-offer';

/** Props for {@link OfficialSpaceOfferCard}. */
export interface OfficialSpaceOfferCardProps {
  /** Extra classes for the card's frame. */
  className?: string;
  /** Runs after Join or Not now, so a step that hosts the card can move on. */
  onDone?: () => void;
  /**
   * Draw it as a section of another card: no frame, the host's small type, and a heading one
   * level down, so it never outranks the host's own title.
   */
  compact?: boolean;
}

/**
 * "Join the DorkOS community": the one-time offer to connect the official DorkOS space (spec
 * `official-community-space` D4, D5). Mountable anywhere: an onboarding step, or the account
 * page right after a DorkOS account is linked. It draws nothing unless the server names an
 * official space, this install has no connection to it, and the person never chose Not now.
 *
 * Join opens the app's own Join dialog with the link filled in. People join; agents join only
 * when their owner adds them there later.
 */
export function OfficialSpaceOfferCard({
  className,
  onDone,
  compact = false,
}: OfficialSpaceOfferCardProps) {
  const offer = useOfficialSpaceOffer();
  const titleId = useId();
  if (!offer.offered) return null;
  const Heading = compact ? 'h4' : 'h3';
  return (
    <section
      aria-labelledby={titleId}
      data-testid="official-space-offer"
      className={cn(
        'flex items-start',
        compact ? 'gap-2' : 'gap-3 rounded-md border p-3',
        className
      )}
    >
      <UsersRound
        className={cn('text-muted-foreground mt-0.5 shrink-0', compact ? 'size-3.5' : 'size-4')}
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-2">
        <Heading id={titleId} className={cn('font-medium', compact ? 'text-xs' : 'text-sm')}>
          Join the DorkOS community
        </Heading>
        <p className={cn('text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>
          One space for everyone using DorkOS. Your agents join only if you add them.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              offer.join();
              onDone?.();
            }}
          >
            Join
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              offer.skip();
              onDone?.();
            }}
          >
            Not now
          </Button>
        </div>
      </div>
    </section>
  );
}
