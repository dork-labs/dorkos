/**
 * The browser's own notifications — the leg that reaches you when the tab is
 * hidden behind something else.
 *
 * No service worker and no push subscription: an in-page `new Notification()` is
 * enough for "this tab is open but not on screen", which is the case this
 * covers. Reaching a person whose laptop is shut is the escalation ladder's job
 * and lives elsewhere (spec `notification-system`, W3 T10).
 *
 * @module features/notifications/model/use-browser-notifications
 */
import { useCallback, useEffect, useRef } from 'react';
import { NotificationEventSchema, type NotificationDTO } from '@dorkos/shared/notification-schemas';
import { notificationLink } from '@/layers/entities/notifications';
import { useNotificationPrefs } from '@/layers/entities/config';
import { isDesktopShell } from '@/layers/shared/lib';
import {
  useBrowserNotificationPermission,
  useEventSubscription,
  useSafeNavigate,
} from '@/layers/shared/model';
import { useBlockingArrivals, type BlockingItem } from './use-blocking-arrivals';

/** What one shown notification needs to be closed and clicked later. */
interface OpenNotification {
  notification: Notification;
  /** Where clicking it goes. */
  href: string | null;
}

/**
 * Show OS notifications for things that arrive while the window is hidden.
 *
 * ## The three rules, in the order they are checked
 *
 * 1. **Not in the desktop app.** The Electron shell shows its own native
 *    notifications with Allow/Deny/Reply buttons on them (DOR-1386), and a web
 *    notification fired from inside that window would be a second, worse banner
 *    for the same event. This hook does nothing at all there.
 * 2. **Only while hidden.** `document.hidden` is read at the moment of arrival
 *    rather than tracked as state, because that is the exact question — a banner
 *    over the very screen the person is reading is the interruption everybody
 *    hates, and a stale `true` from a render two seconds ago would produce one.
 * 3. **Only with permission already granted.** This never asks; asking is the
 *    primer's job, and it only asks from a click.
 *
 * ## What the banner may say
 *
 * The title is who needs you and the body is a fixed sentence. Never a tool
 * input, never transcript content — an OS notification is drawn by the operating
 * system, is often visible on a locked screen, and is out of DorkOS's hands the
 * moment it is posted (spec, Security Considerations). The cockpit's own cards
 * are where the detail lives.
 *
 * ## Where blocking and notable come from
 *
 * Two different sources, and deliberately so. Blocking comes from the attention
 * store, which is the only thing that knows about a capability approval — those
 * raise no notification row. Notable comes off the `notification` stream, which
 * is where a finished turn or a message addressed to you lands. Reading blocking
 * off BOTH would show two banners for one Ask.
 */
export function useBrowserNotifications(): void {
  const { permission } = useBrowserNotificationPermission();
  const { prefs } = useNotificationPrefs();
  const navigate = useSafeNavigate();

  // Fixed for the life of the app (it feature-detects the preload bridge), so
  // reading it during render cannot change the hook order below.
  const inDesktopShell = isDesktopShell();

  /** Everything currently on screen, so it can be closed when it is answered. */
  const openRef = useRef(new Map<string, OpenNotification>());

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const canShow = useCallback((): boolean => {
    if (inDesktopShell) return false;
    if (permission !== 'granted') return false;
    if (typeof document === 'undefined' || !document.hidden) return false;
    return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
  }, [inDesktopShell, permission]);

  const show = useCallback((key: string, title: string, body: string, href: string | null) => {
    let notification: Notification;
    try {
      // `tag` makes the OS replace rather than stack when the same thing is
      // announced twice — a re-arrival after an answer, say.
      notification = new Notification(title, { body, tag: key });
    } catch {
      // Some browsers throw here rather than rejecting: Chrome on Android
      // refuses the constructor outright and insists on a service worker. There
      // is nothing to tell the person — they are not looking at this tab.
      return;
    }

    notification.onclick = () => {
      window.focus();
      notification.close();
      openRef.current.delete(key);
      if (href !== null) void navigateRef.current?.({ href });
    };
    notification.onclose = () => {
      openRef.current.delete(key);
    };

    openRef.current.set(key, { notification, href });
  }, []);

  const onArrive = useCallback(
    (items: readonly BlockingItem[]) => {
      if (!canShow()) return;
      for (const item of items) {
        show(item.id, `${item.who} needs you`, item.summary, item.deepLink);
      }
    },
    [canShow, show]
  );

  const onDepart = useCallback((ids: readonly string[]) => {
    // Answering in the cockpit takes the banner away too. A notification that
    // outlives the thing it is about is how a person ends up clicking through to
    // an empty screen.
    for (const id of ids) {
      const open = openRef.current.get(id);
      if (open === undefined) continue;
      open.notification.close();
      openRef.current.delete(id);
    }
  }, []);

  useBlockingArrivals({ onArrive, onDepart });

  const notifyWhileAway = prefs.notifyOnTurnCompleteWhileAway;

  useEventSubscription('notification', (raw) => {
    const parsed = NotificationEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const notification: NotificationDTO = parsed.data.notification;
    // Blocking rows are already covered by the attention store above, and quiet
    // ones are, by definition, not worth a banner.
    if (notification.tier !== 'notable') return;
    if (!notifyWhileAway) return;
    if (!canShow()) return;

    const link = notificationLink(notification);
    const href = link === null ? null : buildHref(link.to, link.search);
    show(notification.id, notification.title, notification.body ?? '', href);
  });

  // Nothing of ours should outlive the app: a banner still on screen after a
  // reload has a click handler pointing at a window that no longer exists.
  useEffect(() => {
    const open = openRef.current;
    return () => {
      for (const { notification } of open.values()) notification.close();
      open.clear();
    };
  }, []);
}

/**
 * Flatten a router link into an `href` the navigator can take.
 *
 * `notificationLink` answers in TanStack's `{ to, search }` shape because that is
 * what a click handler inside the router wants. A notification's click handler
 * fires outside React, through a ref, so it takes the string form — the same one
 * the sidebar and the attention rows navigate with.
 */
function buildHref(to: string, search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? to : `${to}?${query}`;
}
