/**
 * Subscribing this browser to push — the leg that reaches you once DorkOS is
 * closed (spec `notification-system` task 4.3, ADR 260819-234829).
 *
 * The browser-notification hook next door covers "this tab is open but hidden".
 * This covers the case that actually needed solving: the laptop is shut, the
 * phone is in a pocket, and an agent has stopped and is waiting on an answer.
 *
 * ## Where this does nothing, and why
 *
 * - **In the desktop shell.** Electron shows its own native banners with
 *   Allow/Deny/Reply on them, and it is running, so a push about the same event
 *   would be a second, worse notification.
 * - **Outside a secure context.** Service workers and the Push API are
 *   HTTPS-only. `localhost` counts as secure, which is exactly where the cockpit
 *   normally runs, so this is really about DorkOS reached over plain HTTP on a
 *   LAN address — where the browser refuses, and there is nothing to be done
 *   about it from here.
 * - **On a browser with no `PushManager`.** Reported as its own state rather
 *   than folded into a failure, so the Settings tab can say which it is.
 *
 * @module features/notifications/model/use-push-subscription
 */
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PushSubscriptionDTO } from '@dorkos/shared/notification-schemas';
import { isDesktopShell } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';

/** Where the service worker lives. Root-scoped, so it covers every route. */
const SERVICE_WORKER_URL = '/sw.js';

/** Cache key for this install's subscribed browsers. */
export const PUSH_DEVICES_QUERY_KEY = ['push', 'subscriptions'] as const;

/** Cache key for the VAPID public key. */
const PUSH_VAPID_QUERY_KEY = ['push', 'vapid-public-key'] as const;

/**
 * Remembers which row is THIS browser.
 *
 * The server never returns an endpoint, so a device list cannot tell which entry
 * is the machine reading it. The id comes back from the subscribe call and is
 * kept here — per browser, which is exactly the right scope for a fact about
 * this browser.
 */
const LOCAL_DEVICE_ID_KEY = 'dorkos.push.device-id';

/** Why push is not available, when it is not. */
export type PushAvailability =
  /** This browser can do it. */
  | 'available'
  /** The desktop app shows its own notifications. */
  | 'desktop-shell'
  /** No service worker or no Push API here. */
  | 'unsupported'
  /** Not HTTPS (and not localhost), so the browser refuses. */
  | 'insecure-context'
  /** The server has no VAPID keypair, so nothing can be signed. */
  | 'server-unavailable';

/** What {@link usePushSubscription} hands the Settings tab. */
export interface PushSubscriptionState {
  /** Whether this browser can be subscribed, and why not when it cannot. */
  availability: PushAvailability;
  /** Every browser this install may push to. */
  devices: PushSubscriptionDTO[];
  /**
   * Whether {@link PushSubscriptionState.devices} is an ANSWER rather than a
   * default.
   *
   * An empty array means "none subscribed" and "not loaded yet" alike, and a
   * surface that warns about the first while looking at the second alarms
   * somebody whose phone is in fact subscribed.
   */
  devicesLoaded: boolean;
  /** The id of the row that is THIS browser, when it is subscribed. */
  localDeviceId: string | null;
  /** Subscribe this browser. Only ever call from a real click. */
  subscribe: () => Promise<void>;
  /** Stop pushing to one browser. */
  remove: (id: string) => Promise<void>;
  /** True while a subscribe or a remove is in flight. */
  isPending: boolean;
  /** What went wrong on the last attempt, already written for a person. */
  error: string | null;
}

/**
 * Read and change which browsers DorkOS may push to.
 *
 * Nothing here registers a service worker or asks for permission on its own: a
 * browser blocks a permission request that did not come from a click, and some
 * of them hold that against the origin permanently. {@link
 * PushSubscriptionState.subscribe} is the only path, and it is a button.
 */
export function usePushSubscription(): PushSubscriptionState {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [storedDeviceId, setStoredDeviceId] = useState<string | null>(readLocalDeviceId);

  const platform = platformAvailability();

  const vapid = useQuery({
    queryKey: [...PUSH_VAPID_QUERY_KEY],
    queryFn: () => transport.getPushVapidPublicKey(),
    // Only asked where a browser could actually use the answer — reading it
    // GENERATES the install's keypair on first call, and an install nobody can
    // push from has no business creating one.
    enabled: platform === 'available',
    staleTime: Infinity,
  });

  const devices = useQuery({
    queryKey: [...PUSH_DEVICES_QUERY_KEY],
    queryFn: () => transport.listPushSubscriptions(),
  });

  const subscribeMutation = useMutation({
    mutationFn: async (applicationServerKey: string) => {
      const subscription = await subscribeThisBrowser(applicationServerKey);
      return transport.registerPushSubscription(subscription);
    },
    onSuccess: (result) => {
      writeLocalDeviceId(result.subscription.id);
      setStoredDeviceId(result.subscription.id);
      void queryClient.invalidateQueries({ queryKey: [...PUSH_DEVICES_QUERY_KEY] });
    },
    meta: { suppressErrorToast: true },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => transport.deletePushSubscription(id),
    onSuccess: (_result, id) => {
      if (readLocalDeviceId() === id) {
        clearLocalDeviceId();
        setStoredDeviceId(null);
        void unsubscribeThisBrowser();
      }
      void queryClient.invalidateQueries({ queryKey: [...PUSH_DEVICES_QUERY_KEY] });
    },
    meta: { suppressErrorToast: true },
  });

  // A row this browser thinks is its own but the server no longer lists was
  // removed from somewhere else — another window, another device's list. Keeping
  // the stale id would draw "This device" against a row that is not there, so the
  // id READ below is the reconciled one, and the effect only forgets the copy on
  // disk. Derived rather than corrected from an effect: the row must never paint
  // as this device, not even for the frame before the effect runs.
  const listed = devices.data?.subscriptions;
  const orphaned =
    listed !== undefined &&
    storedDeviceId !== null &&
    !listed.some((device) => device.id === storedDeviceId);
  const localDeviceId = orphaned ? null : storedDeviceId;
  useEffect(() => {
    if (orphaned) clearLocalDeviceId();
  }, [orphaned]);

  const vapidKey = vapid.data?.key ?? null;

  const subscribe = useCallback(async () => {
    setError(null);
    if (vapidKey === null) {
      setError('DorkOS could not set up push notifications on this computer.');
      return;
    }
    try {
      await subscribeMutation.mutateAsync(vapidKey);
    } catch (err) {
      setError(describeSubscribeFailure(err));
    }
  }, [subscribeMutation, vapidKey]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await removeMutation.mutateAsync(id);
      } catch {
        setError('That device could not be removed. Try again in a moment.');
      }
    },
    [removeMutation]
  );

  const availability: PushAvailability =
    platform !== 'available'
      ? platform
      : vapid.isSuccess && vapidKey === null
        ? 'server-unavailable'
        : 'available';

  return {
    availability,
    devices: listed ?? [],
    devicesLoaded: devices.isSuccess,
    localDeviceId,
    subscribe,
    remove,
    isPending: subscribeMutation.isPending || removeMutation.isPending,
    error,
  };
}

/** What this browser and this shell can do, before the server is asked anything. */
function platformAvailability(): PushAvailability {
  if (isDesktopShell()) return 'desktop-shell';
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  // `isSecureContext` is true on localhost, which is where the cockpit normally
  // runs — so this only bites for DorkOS reached over plain HTTP on a LAN
  // address, where the browser itself would refuse.
  if (window.isSecureContext === false) return 'insecure-context';
  return 'available';
}

/**
 * Register the service worker, ask permission, and subscribe.
 *
 * In that order, and it matters: the registration has to be ready before
 * `pushManager` exists, and asking for permission after a person clicked is the
 * only time a browser will honour the request without holding it against the
 * origin.
 */
async function subscribeThisBrowser(
  applicationServerKey: string
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushPermissionError(permission);

  // An existing subscription is reused rather than replaced: it is already
  // valid, and re-subscribing would hand the server a second endpoint for one
  // browser.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Non-negotiable on Chrome, and correct everywhere: a push this browser
      // cannot show is a push nobody asked for.
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(applicationServerKey),
    }));

  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (typeof json.endpoint !== 'string' || !p256dh || !auth) {
    throw new Error('This browser produced a subscription DorkOS cannot use.');
  }
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** Drop this browser's own subscription, after its row has gone. */
async function unsubscribeThisBrowser(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // The row is already gone, which is what stops the pushes. A browser that
    // will not let go of its own subscription is not worth telling anybody about.
  }
}

/** Thrown when the browser refused, so the copy can say which refusal it was. */
class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(`Notification permission was ${permission}`);
    this.name = 'PushPermissionError';
  }
}

/** What to tell a person whose subscribe attempt did not work. */
function describeSubscribeFailure(err: unknown): string {
  if (err instanceof PushPermissionError) {
    return err.permission === 'denied'
      ? 'Your browser is set to refuse notifications from DorkOS, and it will not ask again. You can change that in your browser’s settings for this site.'
      : 'DorkOS needs permission to show notifications before it can reach this device.';
  }
  return 'This device could not be set up for notifications. Try again in a moment.';
}

/**
 * Turn the server's URL-safe base64 VAPID key into the bytes `subscribe()` wants.
 *
 * Browsers accept a base64 string here too, but not consistently — Firefox has
 * historically wanted the array — so the conversion is done once, here, rather
 * than depending on which browser is reading.
 */
function decodeVapidKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The id of the row that is this browser, as far as this browser knows. */
function readLocalDeviceId(): string | null {
  try {
    return window.localStorage.getItem(LOCAL_DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

/** Remember which row is this browser. */
function writeLocalDeviceId(id: string): void {
  try {
    window.localStorage.setItem(LOCAL_DEVICE_ID_KEY, id);
  } catch {
    // Private-browsing storage refusals cost nothing here: the list simply does
    // not mark a row as "this device".
  }
}

/** Forget which row is this browser. */
function clearLocalDeviceId(): void {
  try {
    window.localStorage.removeItem(LOCAL_DEVICE_ID_KEY);
  } catch {
    // Same as above.
  }
}
