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
export function OfficialSpaceOfferCard({ className, onDone }: OfficialSpaceOfferCardProps) {
  const offer = useOfficialSpaceOffer();
  if (!offer.offered) return null;
  return (
    <section
      aria-labelledby="official-space-offer-title"
      data-testid="official-space-offer"
      className={cn('flex items-start gap-3 rounded-md border p-3', className)}
    >
      <UsersRound className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <h3 id="official-space-offer-title" className="text-sm font-medium">
          Join the DorkOS community
        </h3>
        <p className="text-muted-foreground text-sm">
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
