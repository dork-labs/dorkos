/**
 * "Want a nudge when this needs you?" — the one time DorkOS asks about browser
 * notifications.
 *
 * @module features/notifications/ui/PermissionPrimer
 */
import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { useNotificationPrefs } from '@/layers/entities/config';
import { getPlatform, isDesktopShell } from '@/layers/shared/lib';
import { useBrowserNotificationPermission } from '@/layers/shared/model';
import { Button, Card } from '@/layers/shared/ui';
import {
  armPermissionPrimer,
  usePermissionPrimerArmed,
  LONG_TURN_MS,
} from '../model/primer-trigger';

export interface PermissionPrimerProps {
  /**
   * Whether a turn is running right now.
   *
   * The card arms itself once one has been running for {@link LONG_TURN_MS} —
   * see the module docs for why that is the moment and launch is not.
   */
  streaming: boolean;
}

/**
 * The contextual permission card.
 *
 * ## Why it is here and not at launch
 *
 * A permission prompt on arrival is the pattern everyone has learned to dismiss
 * without reading, and in Chrome a reflexive "block" is permanent and buried.
 * So DorkOS asks exactly once, and only after something has happened that makes
 * the answer worth having: a turn long enough to walk away from, or an agent
 * that has genuinely stopped and is waiting.
 *
 * ## Why "Not now" is a real answer
 *
 * Pressing it records the answer in config — on the server, not in this browser
 * — and the card never returns. A card that came back tomorrow would be a nag,
 * and the promise it makes ("asked once") is the only reason asking in-context
 * is better than asking at launch.
 *
 * Denying at the OS level counts as answered too: the browser will not ask
 * again, so a card offering to ask would be a button that does nothing.
 *
 * ## Where it never appears
 *
 * The desktop app (its own native notifications are better and already
 * permitted) and the Obsidian embed (one pane inside someone else's app has no
 * business raising OS banners). Both check before the card is ever armed.
 *
 * @param props - Whether a turn is currently running.
 */
export function PermissionPrimer({ streaming }: PermissionPrimerProps) {
  const armed = usePermissionPrimerArmed();
  const { permission, request } = useBrowserNotificationPermission();
  const { prefs, setPrefs } = useNotificationPrefs();

  // Held for this session as well as written to config, the same union
  // `usePromoDismissals` uses: `updateConfig` is a no-op on the Obsidian
  // transport and any transport can answer 200 without the value coming back, and
  // a card that reappeared the moment it was answered reads as a broken button.
  const [answered, setAnswered] = useState(false);

  const unavailable = isDesktopShell() || getPlatform().isEmbedded || permission === 'unsupported';

  // A turn that runs long enough is the trigger this component owns. The other —
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

  if (unavailable) return null;
  if (!armed || answered) return null;
  if (permission !== 'default') return null;
  if (prefs.browserPermissionPrimerDismissed) return null;

  return (
    <Card
      data-slot="notification-permission-primer"
      gap="none"
      className="mx-4 mb-2 flex-row flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
    >
      <Bell className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">
        Want a nudge when this needs you? DorkOS can show a notification while you are looking at
        something else.
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          responsive={false}
          className="h-7 px-2 text-xs"
          onClick={notNow}
        >
          Not now
        </Button>
        <Button
          variant="outline"
          size="sm"
          responsive={false}
          className="h-7 px-2 text-xs"
          onClick={allow}
        >
          Turn on notifications
        </Button>
      </div>
    </Card>
  );
}
