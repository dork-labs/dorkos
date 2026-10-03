/**
 * DorkOS credits, offered first where nothing works yet.
 *
 * @module widgets/credits-offer/ui/CreditsOfferCard
 */
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { CloudLinkInline, useCloudLink, useCloudStatus } from '@/layers/features/cloud-link';
import {
  BillingNoticeView,
  creditsVerb,
  useCloudPlan,
  useOpenBillingPage,
} from '@/layers/features/cloud-plan';
import { creditsWiredFor, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { cn } from '@/layers/shared/lib';
import {
  useCloudCredits,
  useSetCreditsDefault,
  type CreditsOfferProps,
  type CreditsOfferSlot,
} from '@/layers/shared/model';
import { Button, Spinner } from '@/layers/shared/ui';

/** The runtimes credits reach, by name, the way a person says them aloud. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What a failed choice says when the request brought back no words of its own. */
const CHOOSE_FAILED = 'Couldn’t switch to DorkOS credits. Try again in a moment.';

/** What the card says when the plan could not be read before spending. */
const PLAN_UNREAD = 'Couldn’t check your DorkOS credits. Try again in a moment.';

/** The reason a request came back with, when it is a sentence; the fallback otherwise. */
function reasonOf(err: unknown, fallback: string): string {
  return err instanceof Error && /[.!?]$/.test(err.message.trim()) ? err.message : fallback;
}

/**
 * The default card of the default-first pattern (spec
 * `dorkos-account-by-default` §3): one button that runs a runtime on DorkOS
 * credits, the line saying what one account covers, and — when this computer
 * is not linked yet — the link flow drawn right here, so choosing credits never
 * sends anybody to Settings.
 *
 * - **Signed out**: the button starts the ONE link flow (`features/cloud-link`)
 *   with this surface as its origin, and remembers the code it started. While
 *   any code waits — started here, in Settings, or in another tab — every
 *   surface shows that one code (the server names it), not a button for a
 *   second one. When the server says THAT code was approved (its
 *   `approvedCode`) and this card is still on screen, the card makes the
 *   choice, or for a choice that spends at once (`confirmAfterLink`) asks
 *   first. A card that has gone away, a code another surface or tab started,
 *   a code replaced by a newer one, and a relink carry nothing on.
 * - **Signed in**: the button makes the choice now. Before it does, the plan
 *   is read again; an account with nothing left to spend is offered the page
 *   to add credits instead, and never moved onto them.
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
  confirmAfterLink,
  note,
  chosen,
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
  const [confirming, setConfirming] = useState(false);
  const [nothingLeft, setNothingLeft] = useState(false);
  const [done, setDone] = useState(false);
  // The code THIS card started, held only while it is mounted: the link that
  // lands is carried on from here only when it is this one.
  const startedCode = useRef<string | null>(null);

  const verb = creditsVerb(linked, plan.data);
  const label =
    verb === null
      ? 'Checking your DorkOS credits…'
      : verb === 'Buy'
        ? 'Buy DorkOS credits'
        : intent === 'keep-going'
          ? 'Keep going on DorkOS credits'
          : `${verb} DorkOS credits`;
  const wired = credits
    ? Object.keys(credits.runtimes).filter((type) => creditsWiredFor(credits, type))
    : [];
  const covers =
    wired.length > 0 ? joinNames(wired.map((type) => getRuntimeDescriptor(type).label)) : null;

  const choose = async () => {
    setFailure(null);
    setConfirming(false);
    setChoosing(true);
    try {
      // Read again right before choosing: what the button said may be stale,
      // and nothing is ever moved onto credits the account does not have.
      const fresh = await plan.refetch();
      if (fresh.isError || fresh.data === undefined) {
        setFailure(PLAN_UNREAD);
        return;
      }
      if (creditsVerb(true, fresh.data) === 'Buy') {
        setNothingLeft(true);
        return;
      }
      if (onChoose) await onChoose();
      else await setDefault.mutateAsync({ runtime, useCredits: true });
      setDone(true);
    } catch (err) {
      setFailure(reasonOf(err, CHOOSE_FAILED));
    } finally {
      setChoosing(false);
    }
  };

  const onLanded = useEffectEvent((userCode: string) => {
    if (startedCode.current === null || startedCode.current !== userCode) return;
    startedCode.current = null;
    if (confirmAfterLink) setConfirming(true);
    else void choose();
  });
  const landedCode = link.landed?.userCode ?? null;
  useEffect(() => {
    if (landedCode !== null) onLanded(landedCode);
  }, [landedCode]);

  const press = async () => {
    if (!linked) {
      startedCode.current = await link.start({ origin });
      return;
    }
    if (verb === 'Buy') {
      billing.open({ page: 'topup' });
      return;
    }
    void choose();
  };

  const waiting = link.view.kind === 'pending';
  // Held until the link summary answers (pressed before then, a linked computer
  // would be sent through the link flow again), and while a signed-in plan
  // loads (the answer may be "Buy").
  const busy =
    summary === undefined || verb === null || choosing || link.starting || billing.pending !== null;

  if (done && chosen) {
    return (
      <p className="text-sm" role="status" data-testid={`credits-offer-${runtime}`}>
        {chosen}
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid={`credits-offer-${runtime}`}>
      {nothingLeft ? (
        <div className="space-y-2" role="status">
          <p className="text-sm">Your DorkOS account has no credits left to spend.</p>
          <Button
            size="sm"
            className={cn(fullWidth && 'w-full')}
            onClick={() => billing.open({ page: 'topup' })}
            disabled={billing.pending !== null}
          >
            Buy DorkOS credits
          </Button>
        </div>
      ) : confirming && confirmAfterLink ? (
        <div className="space-y-2" role="status">
          <p className="text-sm">{confirmAfterLink.prompt}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void choose()} disabled={choosing}>
              {choosing && <Spinner size="xs" />}
              {confirmAfterLink.action}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Not now
            </Button>
          </div>
        </div>
      ) : (
        !waiting && (
          <Button
            size="sm"
            className={cn('h-auto min-h-8 gap-1.5 whitespace-normal', fullWidth && 'w-full')}
            onClick={() => void press()}
            disabled={busy}
            data-testid="credits-offer-button"
          >
            {busy ? <Spinner size="xs" /> : <Sparkles className="size-3.5" aria-hidden />}
            {label}
          </Button>
        )
      )}
      {!waiting && !confirming && !nothingLeft && note && (
        <p className="text-muted-foreground text-xs">{note}</p>
      )}
      {intent === 'start' && covers && !waiting && !confirming && !nothingLeft && (
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
