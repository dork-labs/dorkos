/**
 * The green line under an approval's history row: "Next time, trust
 * everything from dork-labs/marketplace? Yes" (spec `flow-multiproject` §9.3,
 * V9).
 *
 * @module features/inbox/ui/TrustSourceOfferLine
 */
import { X } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import {
  useTrustedSourceActions,
  useTrustOfferStore,
  type TrustOffer,
} from '@/layers/entities/extension';

/** Props for {@link TrustSourceOfferLine}. */
export interface TrustSourceOfferLineProps {
  /** The live offer this row carries. */
  offer: TrustOffer;
}

/**
 * Offer, once, to trust everything from the source the person just turned an
 * extension on from. "Yes" trusts that exact `owner/repo` as the person; the
 * quiet ✕ drops the offer and changes nothing. Either way it does not come
 * back.
 *
 * @param props - The offer.
 */
export function TrustSourceOfferLine({ offer }: TrustSourceOfferLineProps) {
  const withdraw = useTrustOfferStore((state) => state.withdraw);
  const { trust, pendingSource } = useTrustedSourceActions();
  const busy = pendingSource === offer.source;

  return (
    <div
      data-slot="trust-source-offer"
      className="text-status-success-fg mx-2 mb-1 flex min-w-0 items-center gap-2 pl-[26px] text-xs"
    >
      <p className="min-w-0 flex-1">
        Next time, trust everything from <span className="font-mono">{offer.source}</span>?
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        responsive={false}
        disabled={busy}
        onClick={() => {
          void trust(offer.source)
            .then(() => withdraw(offer.extensionId))
            .catch(() => undefined);
        }}
      >
        Yes
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        responsive={false}
        aria-label="No thanks"
        disabled={busy}
        onClick={() => withdraw(offer.extensionId)}
      >
        <X aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}
