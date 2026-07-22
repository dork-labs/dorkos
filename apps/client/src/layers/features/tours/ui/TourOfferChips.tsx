import { motion } from 'motion/react';
import { DorkLogo } from '@dorkos/icons/logos';

import { Button } from '@/layers/shared/ui';

import { useTours } from '../model/use-tours';

/**
 * DorkBot's in-session offer to give a tour, rendered as a suggestion chip under
 * the latest assistant message (the `chat.suggestion-chips` slot). Client-drawn,
 * never LLM text. Renders nothing until an occasion stands, so it is free to keep
 * mounted. "Show me" runs the tour; "Later" declines it for good.
 */
export function TourOfferChips() {
  const { pendingOffer, pendingOfferId, acceptOffer, declineOffer } = useTours();

  if (!pendingOffer || pendingOfferId === null || !pendingOffer.offerLine) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="group"
      aria-label="DorkBot suggestion"
      className="bg-secondary/60 mt-1.5 flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <DorkLogo size={18} className="dark:hidden" />
          <DorkLogo variant="white" size={18} className="hidden dark:block" />
        </span>
        <p className="text-sm leading-relaxed">{pendingOffer.offerLine}</p>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <Button size="sm" onClick={() => acceptOffer(pendingOfferId)}>
          Show me
        </Button>
        <Button size="sm" variant="ghost" onClick={() => declineOffer(pendingOfferId)}>
          Later
        </Button>
      </div>
    </motion.div>
  );
}
