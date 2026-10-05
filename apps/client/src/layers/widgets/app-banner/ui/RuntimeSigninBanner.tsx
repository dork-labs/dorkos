import { LogIn } from 'lucide-react';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';

import { useLocalCaller } from '@/layers/entities/config';
import { useCloudStatus } from '@/layers/features/cloud-link';
import { creditsVerb, useCloudPlan } from '@/layers/features/cloud-plan';
import {
  creditsOfferFor,
  KeepItLocalNote,
  selectRuntimeSignIn,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import {
  Banner,
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import {
  useCloudCredits,
  useCreditsOfferSlot,
  useSettingsDeepLink,
  type CreditsOfferSlot,
} from '@/layers/shared/model';

/** The Settings tab where signing in again actually happens. */
const RUNTIMES_SETTINGS_TAB = 'runtimes';

/**
 * How many runtimes are named before the rest become a count.
 *
 * Three, which is every runtime DorkOS ships today — so in practice the row
 * always names them all, and the truncation is a guard against a fourth runtime
 * turning this line into a wall of text rather than a case anybody hits.
 */
const NAMED_LIMIT = 3;

export interface RuntimeSigninBannerProps {
  /** Runtime types whose sign-in is dead right now. Empty renders nothing. */
  runtimes: string[];
}

/**
 * The standing note for a runtime whose sign-in has stopped working.
 *
 * ## Why the web app needs this at all
 *
 * A dead sign-in already reaches a phone through the escalation ladder, writes
 * an Inbox row, and raises a banner in the desktop shell. The WEB app drew
 * nothing (DOR-1657 named the gap, DOR-1680 closed it): its browser-notification
 * hook drops `blocking` rows, so a person working in a tab found out only if
 * they happened to open the bell — while every scheduled task, room reply and
 * agent-to-agent delivery on that runtime quietly failed.
 *
 * ## Why it is not a second alarm beside the chat's sign-in card
 *
 * The transcript's `auth_error` card (`features/chat/ui/message/ErrorMessageBlock`)
 * explains why THIS turn died, in the conversation it died in. This row says the
 * runtime is still dead everywhere else — including for the schedules and agents
 * nobody is sitting in front of — and it is app chrome, not transcript content.
 * The two are deliberately worded differently ("Sign in to Claude again" there,
 * the standing sentence here) and the buttons are labelled differently, so
 * seeing both reads as one problem stated once per surface rather than as the
 * same sentence shouted twice.
 *
 * ## Why it names the runtimes
 *
 * "A sign-in stopped working" sends a person hunting. "Your Claude sign-in
 * stopped working" tells them which of the runtimes they run is down, which is
 * the whole action. Past {@link NAMED_LIMIT}, the remainder becomes a count
 * rather than a wall of names, the same way the unattended-autonomy row
 * truncates.
 *
 * ## What the button does NOT do, on a phone
 *
 * It navigates to Settings → Runtimes and stops there. Signing a runtime back in
 * is loopback-only on the server (`rejectNonLoopback`, `routes/runtimes.ts`), so
 * a remote client — the phone over the tunnel — cannot complete it. Making that
 * honest where the sign-in is actually attempted is DOR-1655's job, in the
 * Runtimes tab and the transcript's auth card; this row deliberately does not
 * try to say it a third time, and it stays useful on a phone regardless: knowing
 * your agents are stuck is worth having wherever you are.
 *
 * ## When it goes away, stated precisely
 *
 * There are three exits, and every one of them is the server's.
 *
 * **Finishing the sign-in this button leads to** is the fast one, and the one an
 * operator can reach on purpose (DOR-1910): the vendor CLI exits 0 having
 * written a credential for the account DorkOS pinned it to, and the server
 * stands the condition down for that account
 * (`services/runtimes/connect/delegated-login.ts` →
 * `runtime-signin-watch.ts`, `noteSigninRepaired`). Signing in to a DIFFERENT
 * Claude account does not, and must not: the notice is about a credential, and
 * that one is still dead.
 *
 * **The next turn that reaches the provider** on the failing account clears it
 * too, which covers a sign-in fixed outside DorkOS — in a terminal, say. It used
 * to be the only exit besides a restart, and that is exactly what made this row
 * outlive the fix: on a machine running more than one Claude account, the turn
 * that proves the dead one may never come.
 *
 * **A restart** is the last. The episode store is in memory, so a server killed
 * mid-episode could never see its recovery edge; boot therefore closes the row it
 * can no longer answer (`emitters/runtime-signin.ts`), saying that a restart is
 * what cleared it rather than claiming an all-clear. Without that, this banner
 * would stand forever on the strength of a row nothing could resolve.
 *
 * What none of them is: DorkOS deciding on its own that a credential looks fine.
 * It cannot inspect one, only write it or try it — and an all-clear nobody has
 * seen would silence a sign-in that is still dead.
 *
 * ## Why it cannot be dismissed
 *
 * The condition is standing, not an announcement: it is true until one of the
 * three exits above, and all of them are the server's to take. A dismiss button
 * would let the one signal a web-only operator has be hidden while their agents
 * are still stuck.
 *
 * ## When it leads with DorkOS credits
 *
 * Only for a runtime with no sign-in at all that the server reports credits
 * wired for (spec `dorkos-account-by-default` §3): "Use DorkOS credits" comes
 * first and opens the offer in place, with Sign in beside it. A sign-in that
 * expired or ran out — the usual reason this row is up — leads with signing in
 * again, and nothing ever switches to credits by itself.
 *
 * @param runtimes - Runtime types whose sign-in is dead.
 */
export function RuntimeSigninBanner({ runtimes }: RuntimeSigninBannerProps) {
  const { open: openSettings } = useSettingsDeepLink();
  const renderCreditsOffer = useCreditsOfferSlot();
  if (runtimes.length === 0) return null;

  const named = runtimes.slice(0, NAMED_LIMIT).map(runtimeDisplayName);
  const remaining = runtimes.length - named.length;

  // The remainder is a trailing clause, not another name in the list: "Claude,
  // Codex and 1 more sign-ins" is not a sentence anybody says.
  const subject = runtimes.length === 1 ? `${named[0]} sign-in` : `${joinNames(named)} sign-ins`;
  const rest = remaining > 0 ? `, and ${remaining} more` : '';

  return (
    <Banner
      variant="critical"
      icon={LogIn}
      actions={
        <>
          {renderCreditsOffer && (
            <CreditsLeadAction runtimes={runtimes} renderCreditsOffer={renderCreditsOffer} />
          )}
          <Button variant="outline" size="sm" onClick={() => openSettings(RUNTIMES_SETTINGS_TAB)}>
            Sign in
          </Button>
        </>
      }
    >
      Your <span className="font-medium">{subject}</span> stopped working{rest}. Agents and tasks
      wait until you sign in again.
    </Banner>
  );
}

/**
 * "Use DorkOS credits", first in the row, for the first named runtime with no
 * sign-in at all that credits reach — or nothing. Its own component so the
 * reads it needs run only where the app shell supplies the offer.
 */
function CreditsLeadAction({
  runtimes,
  renderCreditsOffer,
}: {
  runtimes: string[];
  renderCreditsOffer: CreditsOfferSlot;
}) {
  const requirements = useRuntimeRequirements();
  const { data: credits } = useCloudCredits();
  const remote = !useLocalCaller();
  // The trigger says what the offer inside it says ("Try…", "Buy…", "Use…").
  const linked = useCloudStatus().data?.linked === true;
  const verb = creditsVerb(linked, useCloudPlan({ enabled: linked }).data);
  const creditsFor = runtimes.find(
    (type) =>
      creditsOfferFor(selectRuntimeSignIn(requirements.data, type), credits, type) === 'lead'
  );
  if (!creditsFor) return null;
  return (
    <ResponsivePopover>
      <ResponsivePopoverTrigger asChild>
        <Button size="sm" data-testid="signin-banner-credits" disabled={verb === null}>
          {verb === null ? 'DorkOS credits' : `${verb} DorkOS credits`}
        </Button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent align="end" className="w-80 p-4">
        <ResponsivePopoverTitle>
          Run {runtimeDisplayName(creditsFor)} on DorkOS credits
        </ResponsivePopoverTitle>
        <div className="space-y-3">
          {renderCreditsOffer({
            runtime: creditsFor,
            origin: `signin-banner:${creditsFor}`,
            fullWidth: true,
          })}
          <KeepItLocalNote remote={remote} />
        </div>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}

/** Join names the way a person says them aloud: "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
