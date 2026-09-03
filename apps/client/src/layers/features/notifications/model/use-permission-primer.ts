/**
 * Whether asking for notification permission is fair right now, and the two
 * answers.
 *
 * Split out of the card itself so the surface hosting it can ask BEFORE it
 * draws anything. The chat zone arbitrates its promotional cards through
 * `BottomSlot` (ADR 260819-210153), and an arbiter that has to render a
 * candidate to find out whether it had anything to say is not an arbiter — it
 * would hand the slot to a card that draws nothing and starve the next one.
 *
 * Keeping the arming timer here rather than in the card is the other half: a
 * card that only mounts once it has won cannot be the thing that decides it has
 * won. The host calls this on every render of the session; the card is drawn
 * only when it wins.
 *
 * @module features/notifications/model/use-permission-primer
 */
import { useCallback, useEffect, useState } from 'react';
import { useNotificationPrefs } from '@/layers/entities/config';
import { getPlatform, isDesktopShell } from '@/layers/shared/lib';
import { useBrowserNotificationPermission } from '@/layers/shared/model';
import { armPermissionPrimer, usePermissionPrimerArmed, LONG_TURN_MS } from './primer-trigger';

/** What a host needs to offer the permission card, and to answer it. */
export interface PermissionPrimerOffer {
  /**
   * Whether the card should be offered right now — something has happened that
   * earns the question, the browser can still be asked, and nobody has answered
   * it yet.
   */
  eligible: boolean;
  /** Ask the browser, and record that it was asked either way. */
  allow: () => void;
  /** Record "not now". The card never comes back. */
  notNow: () => void;
}

/**
 * The permission card's whole decision, without its appearance.
 *
 * ## Why it is asked here and not at launch
 *
 * A permission prompt on arrival is the pattern everyone has learned to dismiss
 * without reading, and in Chrome a reflexive "block" is permanent and buried. So
 * DorkOS asks exactly once, and only after something has happened that makes the
 * answer worth having: a turn long enough to walk away from, or an agent that
 * has genuinely stopped and is waiting.
 *
 * ## Why "Not now" is a real answer
 *
 * It records the answer in config — on the server, not in this browser — and the
 * card never returns. A card that came back tomorrow would be a nag, and the
 * promise it makes ("asked once") is the only reason asking in-context is better
 * than asking at launch.
 *
 * Denying at the OS level counts as answered too: the browser will not ask
 * again, so a card offering to ask would be a button that does nothing.
 *
 * ## Where it is never eligible
 *
 * The desktop app (its own native notifications are better and already
 * permitted) and the Obsidian embed (one pane inside someone else's app has no
 * business raising OS banners). Both are checked before the question is armed.
 *
 * @param streaming - Whether a turn is running right now. A turn that runs for
 *   {@link LONG_TURN_MS} arms the question; see `primer-trigger` for the other
 *   trigger, which the app-wide notification center owns.
 * @returns Whether to offer the card, and the two answers.
 */
export function usePermissionPrimer(streaming: boolean): PermissionPrimerOffer {
  const armed = usePermissionPrimerArmed();
  const { permission, request } = useBrowserNotificationPermission();
  const { prefs, setPrefs } = useNotificationPrefs();

  // Held for this session as well as written to config, the same union
  // `usePromoDismissals` uses: `updateConfig` is a no-op on the Obsidian
  // transport and any transport can answer 200 without the value coming back, and
  // a card that reappeared the moment it was answered reads as a broken button.
  const [answered, setAnswered] = useState(false);

  const unavailable = isDesktopShell() || getPlatform().isEmbedded || permission === 'unsupported';

  // A turn that runs long enough is the trigger this hook owns. The other —
  // something arriving that is blocked on a person — is watched app-wide by
  // `NotificationCenter`, and both arm the same latch.
  useEffect(() => {
    if (unavailable || !streaming) return;
    const timer = setTimeout(armPermissionPrimer, LONG_TURN_MS);
    return () => clearTimeout(timer);
  }, [unavailable, streaming]);

  const allow = useCallback(() => {
    setAnswered(true);
    void request().then(() => {
      // Answered either way: granted needs no further asking, and denied cannot
      // be re-asked by us at all.
      setPrefs({ browserPermissionPrimerDismissed: true });
    });
  }, [request, setPrefs]);

  const notNow = useCallback(() => {
    setAnswered(true);
    setPrefs({ browserPermissionPrimerDismissed: true });
  }, [setPrefs]);

  const eligible =
    !unavailable &&
    armed &&
    !answered &&
    permission === 'default' &&
    !prefs.browserPermissionPrimerDismissed;

  return { eligible, allow, notNow };
}
