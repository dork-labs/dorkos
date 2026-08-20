/**
 * The app-wide half of getting your attention. Draws nothing.
 *
 * Two things happen here and nowhere else: a soft knock when something starts
 * waiting on you, and a browser notification when it does so while this tab is
 * hidden. Both are about ARRIVALS rather than about state, so they need a mount
 * that outlives every route — which is what the app shell gives them.
 *
 * A component rather than a hook called from `AppShell` because it is one mount
 * point with one comment explaining what it is, and because it keeps the shell's
 * body free of effects it does not own.
 *
 * @module features/notifications/ui/NotificationCenter
 */
import { useCallback } from 'react';
import { useBlockingArrivals } from '../model/use-blocking-arrivals';
import { useBrowserNotifications } from '../model/use-browser-notifications';
import { useNotificationCues } from '../model/use-notification-cues';
import { armPermissionPrimer } from '../model/primer-trigger';

/**
 * Knock, notify, and arm the permission card. Renders nothing.
 *
 * Mounted by `AppShell` only, which is the standalone web and desktop cockpit.
 * The Obsidian embed renders `App` directly and never mounts this — correctly:
 * one pane inside somebody else's app should not be making noises or raising OS
 * banners.
 */
export function NotificationCenter() {
  const { play } = useNotificationCues();

  const onArrive = useCallback(() => {
    // One knock per batch, not one per item. Three agents that all stop inside
    // the same tick are one interruption, and three overlapping knocks is a
    // sound nobody can count anyway.
    play('knock');
    // Something is genuinely waiting now, which is the other moment that makes
    // asking about notifications fair (the first is a long-running turn, armed
    // by the card itself).
    armPermissionPrimer();
  }, [play]);

  useBlockingArrivals({ onArrive });
  useBrowserNotifications();

  return null;
}
