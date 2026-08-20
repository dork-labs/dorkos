/**
 * Whether this browser will let DorkOS put a notification on screen, and the one
 * place that asks for it.
 *
 * In `shared/` rather than in the notifications feature because two unrelated
 * surfaces read it — the contextual primer near the composer and the
 * Notifications settings tab — and a feature may not import another feature's
 * model. It is a platform capability, like {@link useTabVisibility} beside it,
 * not domain logic.
 *
 * @module shared/model/use-notification-permission
 */
import { useCallback, useSyncExternalStore } from 'react';

/**
 * What the browser says, plus the answer for a browser that has no opinion.
 *
 * `unsupported` is its own state and not folded into `denied`: a person on a
 * browser without the API should be told that, not told they blocked something.
 */
export type BrowserNotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported';

/** Read the live value straight from the platform. */
function readPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return 'unsupported';
  }
  const value: string = window.Notification.permission;
  if (value === 'granted' || value === 'denied' || value === 'default') return value;
  return 'unsupported';
}

/**
 * The last value every reader agreed on.
 *
 * `Notification.permission` is a plain getter with no change event, so a
 * snapshot has to be cached: `useSyncExternalStore` compares snapshots by
 * identity and re-reading the getter each time would be stable only because the
 * values happen to be strings. The cache is what lets {@link notifyPermissionChanged}
 * wake every reader at once after a prompt is answered — the settings tab and the
 * primer must not disagree about whether permission was just granted.
 */
let snapshot: BrowserNotificationPermission = readPermission();

/** Everyone currently reading the permission. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): BrowserNotificationPermission {
  return snapshot;
}

/** The server has no `Notification`, so SSR reads the same answer a browser without it does. */
function getServerSnapshot(): BrowserNotificationPermission {
  return 'unsupported';
}

/** Re-read the platform and wake every reader if the answer moved. */
function notifyPermissionChanged(): void {
  const next = readPermission();
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** @internal Exported for testing only — re-reads the platform value. */
export function refreshNotificationPermissionForTests(): void {
  snapshot = readPermission();
  for (const listener of listeners) listener();
}

/** What {@link useBrowserNotificationPermission} hands its consumers. */
export interface BrowserNotificationPermissionState {
  /** What the browser says right now. */
  permission: BrowserNotificationPermission;
  /**
   * Ask the browser for permission, and report what it answered.
   *
   * **Only ever call this from a real click.** Browsers require a user gesture,
   * and Chrome permanently blocks the origin for a request made without one —
   * which is the whole reason DorkOS never asks at launch.
   */
  request: () => Promise<BrowserNotificationPermission>;
}

/**
 * Read whether notifications are allowed, and ask if they are not.
 *
 * The value is live across surfaces: answering the OS prompt from the primer
 * updates the Settings tab's status line without a reload.
 */
export function useBrowserNotificationPermission(): BrowserNotificationPermissionState {
  const permission = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const request = useCallback(async (): Promise<BrowserNotificationPermission> => {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      return 'unsupported';
    }
    try {
      await window.Notification.requestPermission();
    } catch {
      // Older Safari hands back a callback-style API that rejects the promise
      // form. Falling through to a re-read is right either way: the permission
      // is whatever the platform now says, not whatever this call returned.
    }
    notifyPermissionChanged();
    return readPermission();
  }, []);

  return { permission, request };
}
