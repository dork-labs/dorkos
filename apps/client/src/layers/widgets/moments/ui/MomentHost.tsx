import { useEffect, useRef, useState } from 'react';

import { useConfig } from '@/layers/entities/config';
import { LAUNCH_STARTED_AT } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { Dialog, DialogContent } from '@/layers/shared/ui';

import { useMoments } from '../model/use-moments';
import type { MomentDescriptor } from '../model/moment-descriptor';

// `LAUNCH_STARTED_AT` — the reference for "did the server confirm this answer
// during THIS launch" — used to be sampled here. It moved to `shared/lib` when
// the shell needed the same distinction to tell a restored config apart from a
// reachable server (DOR-1475): two module-level `Date.now()` samples are two
// different instants by construction, and this question has one answer.

/** Props for {@link MomentHost}. */
interface MomentHostProps {
  /**
   * True while the first-run onboarding overlay is mounted. Passed in rather
   * than re-derived, because the shell owns that overlay — including the latch
   * that keeps it up after `completedAt` is written mid-conversation, which is
   * exactly the window a second opinion would get wrong.
   */
  onboardingOverlayVisible?: boolean;
}

/** Highest priority wins; ties break on collector order. */
function pickWinner(descriptors: MomentDescriptor[]): MomentDescriptor | null {
  return descriptors.reduce<MomentDescriptor | null>(
    (best, d) => (best === null || d.priority > best.priority ? d : best),
    null
  );
}

/**
 * The moments rail — the single host for one-time modals, the way
 * `AppBannerSlot` is the single slot for standing banners. Ranks the eligible
 * {@link MomentDescriptor}s and opens only the highest, never a stack.
 *
 * ## At most one moment per app launch
 *
 * Two one-time modals in a single sitting is an interrogation, and the second
 * one gets dismissed unread. So the first moment to open spends the launch, and
 * the store flag it sets — not any local state here — is what keeps the rail
 * shut afterwards. That flag is deliberately NOT persisted: a reload is a new
 * launch, and whatever is still outstanding gets asked then. Nothing is lost by
 * waiting, because each moment's eligibility is a real state field it owns, not
 * a mark in a ledger the rail keeps.
 *
 * ## When the rail stays quiet
 *
 * Never over the onboarding overlay, and never before onboarding is finished or
 * deliberately dismissed — a first-run install is being asked plenty already.
 * Staying quiet does not spend the launch, so the moment simply waits its turn.
 *
 * ## The config in hand must be this launch's, confirmed by the server
 *
 * `['config','current']` is on the warm-boot persister's allow-list, so a reload
 * paints from `localStorage` and — inside the 30s `staleTime` — may serve that
 * copy without asking the server. Opening a moment off it re-asks a question
 * answered in another window, at the CLI or by hand, then overwrites the real
 * answer with the reply. So a moment opens only once the answer in hand is one
 * the server produced THIS launch.
 *
 * **Why a timestamp and not `isFetchedAfterMount`.** The obvious signal —
 * "config was fetched after this component mounted" — is per-observer, and this
 * rail mounts late: `AppShell` withholds it behind a config-loaded gate, so on a
 * cold load the config request has already resolved by the time the rail's own
 * observer attaches, and `isFetchedAfterMount` stays false for the rest of the
 * launch. The moment then never opens on that load — and a cold load is not an
 * edge case: every DorkOS update changes the persister's build-version buster,
 * which discards the cache and makes the very next launch cold, which is exactly
 * the launch a one-time upgrade door is shipped for (measured; see
 * `fetch-gate.test.tsx`). Comparing the query's `dataUpdatedAt` to when this
 * launch began sidesteps mount timing entirely: a persisted answer carries the
 * `dataUpdatedAt` of its ORIGINAL fetch (always before this launch), a fetch
 * this session carries a newer one, and hydration preserves the old stamp rather
 * than restamping to now — so the same check that opens for a cold undecided user
 * still refuses to open off a stale restored cache until the server confirms.
 *
 * @param onboardingOverlayVisible - True while the onboarding overlay is mounted.
 */
export function MomentHost({ onboardingOverlayVisible = false }: MomentHostProps) {
  const moments = useMoments();
  const { data: config, dataUpdatedAt } = useConfig();
  const momentShownThisLaunch = useAppStore((s) => s.momentShownThisLaunch);
  const markMomentShown = useAppStore((s) => s.markMomentShown);

  // Which moment is open — cleared the moment it closes, so the store flag
  // above is the only thing standing between a closed rail and a second modal.
  const [openId, setOpenId] = useState<string | null>(null);
  // The body, kept after its moment closes so the modal can animate out. Never
  // consulted when deciding whether to open anything.
  const [body, setBody] = useState<MomentDescriptor | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // An unloaded config reads as "onboarding still running", which is the safe
  // way round: it delays a moment rather than opening one over the first-run
  // flow. Same for a server too old to send `completedAt`.
  const onboardingSettled =
    config?.onboarding != null &&
    (config.onboarding.completedAt != null || config.onboarding.dismissedAt != null);
  // The config in hand must be an answer the server confirmed THIS launch, not a
  // copy restored from a previous session's persisted cache — see the class
  // docblock for why this is a timestamp and not `isFetchedAfterMount`. A
  // never-fetched query reports `dataUpdatedAt: 0`, safely before the launch.
  const confirmedThisLaunch = dataUpdatedAt > LAUNCH_STARTED_AT;
  const quiet = onboardingOverlayVisible || !confirmedThisLaunch || !onboardingSettled;
  const winner = quiet ? null : pickWinner(moments);

  // Open the winner by adjusting state during render (React's recommended
  // alternative to an effect, and the same shape `useOnboardingOverlayVisible`
  // uses). Guarded on `openId`, so it runs once and cannot loop.
  if (openId === null && winner !== null && !momentShownThisLaunch) {
    setOpenId(winner.id);
    setBody(winner);
  }

  // Telling the store is the one thing that has to wait for the commit — it is
  // an external system, and a render must not write to it.
  useEffect(() => {
    if (openId !== null) markMomentShown();
  }, [openId, markMomentShown]);

  // Answering a moment's question is what makes it ineligible, so the usual way
  // a modal closes is its descriptor leaving the collector. `quiet` is re-read
  // here and not only at open time, so an onboarding overlay coming back up
  // ("Replay setup") takes an open moment down with it rather than leaving a
  // modal painted over the flow that outranks it.
  const open = !quiet && openId !== null && moments.some((m) => m.id === openId);
  const close = () => setOpenId(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {body !== null && (
        <DialogContent
          key={body.id}
          ref={contentRef}
          // Radix would otherwise autofocus the first tabbable thing in the
          // body, which on the telemetry moment is the "See what's sent"
          // chevron — a control nobody asked for, focused ahead of the question
          // itself. Focus the dialog instead: screen readers announce the title
          // and description first, and no keystroke can land on a consent
          // button the reader has not got to yet. Never pre-focus the
          // affirmative one; a modal that opens with "yes" under the cursor is
          // a dark pattern however innocently it got there.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
        >
          {body.render({ onClose: close })}
        </DialogContent>
      )}
    </Dialog>
  );
}
