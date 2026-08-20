/**
 * The app-wide half of getting your attention. Draws nothing.
 *
 * Three things happen here and nowhere else: a soft knock when something starts
 * waiting on you, a gentle chime when the last thing waiting is answered, and a
 * browser notification when either happens while this tab is hidden. All three
 * are about TRANSITIONS rather than about state, so they need a mount that
 * outlives every route — which is what the app shell gives them.
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
 * Knock, chime, notify, and arm the permission card. Renders nothing.
 *
 * Mounted by `AppShell` only, which is the standalone web and desktop cockpit.
 * The Obsidian embed renders `App` directly and never mounts this — correctly:
 * one pane inside somebody else's app should not be making noises or raising OS
 * banners.
 *
 * ## Why the all-clear chime lives HERE and not in the bell
 *
 * The Inbox popover has its own drain beat, and it fires only while the popover
 * is open — right, for a check mark nobody would otherwise see. It is wrong for
 * a SOUND. The whole reason to make a noise is that the person is not looking:
 * answering the last thing from a keyboard shortcut, from a phone banner, or
 * from the home surface with the popover shut are exactly the moments the
 * chime is FOR. So the audio hangs off the queue draining, app-wide, and the
 * bell keeps the visual beat it always had.
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

  const onDepart = useCallback(
    (_ids: readonly string[], remaining: number) => {
      // Only the LAST one. A chime every time one of five is answered would be
      // the every-turn chime all over again, which is the sound this release
      // turned off.
      if (remaining === 0) play('settle');
    },
    [play]
  );

  useBlockingArrivals({ onArrive, onDepart });
  useBrowserNotifications();

  return null;
}
