import { LogIn } from 'lucide-react';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';

import { Banner, Button } from '@/layers/shared/ui';
import { useSettingsDeepLink } from '@/layers/shared/model';

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
 * Not when you sign in — DorkOS cannot inspect a credential, only try it. The
 * server clears the condition on **the next turn that reaches the provider** on
 * that runtime (`services/observability/runtime-signin-watch.ts`), so the row
 * can outlive the fix by however long it takes for something to run: a message,
 * a room reply, a scheduled task. That is the honest bound, and the direction to
 * be wrong in — an all-clear DorkOS has not seen would silence a sign-in that is
 * still dead.
 *
 * The other exit is a restart. The episode store is in memory, so a server
 * killed mid-episode could never see its recovery edge; boot therefore closes
 * the row it can no longer answer (`emitters/runtime-signin.ts`), saying that a
 * restart is what cleared it rather than claiming an all-clear. Without that,
 * this banner would stand forever on the strength of a row nothing could
 * resolve.
 *
 * ## Why it cannot be dismissed
 *
 * The condition is standing, not an announcement: it is true until one of the
 * two exits above, and both are the server's to take. A dismiss button would let
 * the one signal a web-only operator has be hidden while their agents are still
 * stuck.
 *
 * @param runtimes - Runtime types whose sign-in is dead.
 */
export function RuntimeSigninBanner({ runtimes }: RuntimeSigninBannerProps) {
  const { open: openSettings } = useSettingsDeepLink();
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
        <Button variant="outline" size="sm" onClick={() => openSettings(RUNTIMES_SETTINGS_TAB)}>
          Sign in
        </Button>
      }
    >
      Your <span className="font-medium">{subject}</span> stopped working{rest}. Agents and
      scheduled tasks stay stuck until you sign in again.
    </Banner>
  );
}

/** Join names the way a person says them aloud: "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
