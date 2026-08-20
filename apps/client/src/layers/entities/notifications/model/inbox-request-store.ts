/**
 * "Open the Inbox, and show me this slice of it" — the one request any surface
 * can make of the bell.
 *
 * A store rather than a call, for the reason `ask-tray-store` is one: the
 * surfaces that want to open the Inbox are features (a session's menu), the
 * thing that opens is a widget's popover, and a feature may not reach up a
 * layer. It lives in `entities` rather than in `features/inbox` so that a
 * feature asking for it is not a feature importing a sibling feature's model.
 *
 * @module entities/notifications/model/inbox-request-store
 */
import { create } from 'zustand';
import type { NotificationLens } from './notification-cache';

/** A standing request to open the Inbox. */
interface InboxRequestState {
  /**
   * Bumped every time somebody asks for the Inbox.
   *
   * A counter rather than a boolean: asking twice is two requests, and a
   * boolean already `true` would swallow the second.
   */
  openRequest: number;
  /** The slice to show, or `undefined` for all of it. */
  lens: NotificationLens | undefined;
}

const useInboxRequestStore = create<InboxRequestState>(() => ({
  openRequest: 0,
  lens: undefined,
}));

/**
 * Ask the bell to open, optionally filtered.
 *
 * @param lens - The slice to show. Omit for the whole Inbox.
 */
export function requestInbox(lens?: NotificationLens): void {
  useInboxRequestStore.setState((state) => ({ openRequest: state.openRequest + 1, lens }));
}

/**
 * The current request — subscribe to it to open the Inbox when it changes.
 *
 * @returns A counter that increases on each {@link requestInbox}, and the lens
 * asked for with it.
 */
export function useInboxRequest(): { openRequest: number; lens: NotificationLens | undefined } {
  return useInboxRequestStore((state) => state);
}

/**
 * Put the request counter back to zero.
 *
 * @internal Exported for testing only.
 */
export function clearInboxRequest(): void {
  useInboxRequestStore.setState({ openRequest: 0, lens: undefined });
}
