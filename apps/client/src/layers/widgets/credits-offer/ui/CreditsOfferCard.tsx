/**
 * DorkOS credits, offered first where nothing works yet.
 *
 * @module widgets/credits-offer/ui/CreditsOfferCard
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { CloudLinkInline, useCloudLink, useCloudStatus } from '@/layers/features/cloud-link';
import { BillingNoticeView, useCloudPlan, useOpenBillingPage } from '@/layers/features/cloud-plan';
import { creditsWiredFor, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { cn } from '@/layers/shared/lib';
import {
  useCloudCredits,
  useSetCreditsDefault,
  type CreditsOfferProps,
  type CreditsOfferSlot,
} from '@/layers/shared/model';
import { Button, Spinner } from '@/layers/shared/ui';
import { creditsVerb } from '../lib/credits-verb';

/** The runtimes credits reach, by name, the way a person says them aloud. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What a failed choice says when the request brought back no words of its own. */
const CHOOSE_FAILED = 'Couldn’t switch to DorkOS credits. Try again in a moment.';

/**
 * The default card of the default-first pattern (spec
 * `dorkos-account-by-default` §3): one button that runs a runtime on DorkOS
 * credits, the line saying what one account covers, and — when this computer
 * is not linked yet — the link flow drawn right here, so choosing credits never
 * sends anybody to Settings.
 *
 * - **Signed out**: the button starts the ONE link flow (`features/cloud-link`)
 *   with this surface as its origin, and hands it the choice as what to do once
 *   the link lands. The code shows in place; approving it — here, or in
 *   Settings › DorkOS account, which shows the same code — makes the choice.
 * - **Signed in**: the button makes the choice now. "Buy…" opens the page to
 *   add credits on the web instead, since nothing can be spent yet.
 *
 * The choice is the surface's (`onChoose`), or by default the runtime's new
 * work going on credits, recorded as the person's choice. Nothing here ever
 * moves work by itself.
 *
 * Supplied to features through `CreditsOfferProvider` (`shared/model`); a
 * surface decides whether to draw it with `useRuntimeCreditsOffer`.
 */
export function CreditsOfferCard({
  runtime,
  origin,
  intent = 'start',
  onChoose,
  fullWidth = false,
}: CreditsOfferProps) {
  const link = useCloudLink();
  const summary = useCloudStatus().data;
  const linked = summary?.linked === true;
  const plan = useCloudPlan({ enabled: linked });
  const billing = useOpenBillingPage();
  const { data: credits } = useCloudCredits();
  const setDefault = useSetCreditsDefault();
  const [choosing, setChoosing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const verb = creditsVerb(linked, plan.data);
  const label = intent === 'keep-going' ? 'Keep going on DorkOS credits' : `${verb} DorkOS credits`;
  const wired = credits
    ? Object.keys(credits.runtimes).filter((type) => creditsWiredFor(credits, type))
    : [];
  const covers =
    wired.length > 0 ? joinNames(wired.map((type) => getRuntimeDescriptor(type).label)) : null;

  const choose = async () => {
    setFailure(null);
    setChoosing(true);
    try {
      if (onChoose) await onChoose();
      else await setDefault.mutateAsync({ runtime, useCredits: true });
    } catch (err) {
      setFailure(
        err instanceof Error && /[.!?]$/.test(err.message.trim()) ? err.message : CHOOSE_FAILED
      );
    } finally {
      setChoosing(false);
    }
  };

  const press = () => {
    if (!linked) {
      void link.start({ origin, afterLink: choose });
      return;
    }
    if (verb === 'Buy' && intent === 'start') {
      billing.open({ page: 'topup' });
      return;
    }
    void choose();
  };

  const waiting = link.view.kind === 'pending';
  // Held until the link summary answers: pressed before then, a linked
  // computer would be sent through the link flow again.
  const busy = summary === undefined || choosing || link.starting || billing.pending !== null;

  return (
    <div className="space-y-2" data-testid={`credits-offer-${runtime}`}>
      {!waiting && (
        <Button
          size="sm"
          className={cn('gap-1.5', fullWidth && 'w-full')}
          onClick={press}
          disabled={busy}
          data-testid="credits-offer-button"
        >
          {busy ? <Spinner size="xs" /> : <Sparkles className="size-3.5" aria-hidden />}
          {label}
        </Button>
      )}
      {intent === 'start' && covers && !waiting && (
        <p className="text-muted-foreground text-xs">One account for {covers}.</p>
      )}
      <CloudLinkInline origin={origin} />
      <BillingNoticeView notice={billing.notice} />
      {failure && (
        <p className="text-destructive text-xs" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/** The {@link CreditsOfferSlot} the app shell hands to `CreditsOfferProvider`. */
export const renderCreditsOffer: CreditsOfferSlot = (props) => <CreditsOfferCard {...props} />;
