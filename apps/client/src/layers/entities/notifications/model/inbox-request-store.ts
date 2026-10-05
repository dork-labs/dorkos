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
  /** The waiting item to bring into view and focus, or `undefined` for none. */
  focus: string | undefined;
  /**
   * True from a {@link requestInbox} until the bell says it opened for it
   * ({@link settleInboxRequest}). A request can be made before any bell is
   * mounted (a cold-load link, read while the shell is still loading); this is
   * what lets the bell that mounts later still answer it, while a remounted
   * bell does not reopen for a request an earlier one already answered.
   */
  pending: boolean;
  /** When the current request was made (`Date.now()`), so a stale one can expire. */
  requestedAt: number;
}

/**
 * How long a request may wait for a bell. A link read during a slow load
 * should still open the Inbox when the app appears; one from minutes ago,
 * after the person has started on something else, should not.
 */
export const INBOX_REQUEST_TTL_MS = 30_000;

/** What else a {@link requestInbox} can ask for besides a lens. */
export interface InboxRequestOptions {
  /**
   * The id of one waiting item to bring into view and focus: an extension
   * decision's id, the one `ExtensionDecisionView.id` carries. An id that
   * names nothing waiting opens the Inbox as usual, with nothing singled out.
   */
  focus?: string;
}

const useInboxRequestStore = create<InboxRequestState>(() => ({
  openRequest: 0,
  lens: undefined,
  focus: undefined,
  pending: false,
  requestedAt: 0,
}));

/**
 * Ask the bell to open, optionally filtered, optionally on one waiting item.
 *
 * @param lens - The slice to show. Omit for the whole Inbox.
 * @param options - The waiting item to focus, if any.
 */
export function requestInbox(lens?: NotificationLens, options?: InboxRequestOptions): void {
  useInboxRequestStore.setState((state) => ({
    openRequest: state.openRequest + 1,
    lens,
    focus: options?.focus,
    pending: true,
    requestedAt: Date.now(),
  }));
}

/**
 * No bell should open for the current request any more: one just did, or the
 * screen it would open over is gone (first-run onboarding took the window).
 */
export function settleInboxRequest(): void {
  if (useInboxRequestStore.getState().pending) useInboxRequestStore.setState({ pending: false });
}

/**
 * The current request — subscribe to it to open the Inbox when it changes.
 *
 * @returns A counter that increases on each {@link requestInbox}, the lens and
 * focus asked for with it, and whether no bell has answered it yet.
 */
export function useInboxRequest(): {
  openRequest: number;
  lens: NotificationLens | undefined;
  focus: string | undefined;
  pending: boolean;
  requestedAt: number;
} {
  return useInboxRequestStore((state) => state);
}

/**
 * Put the request counter back to zero.
 *
 * @internal Exported for testing only.
 */
export function clearInboxRequest(): void {
  useInboxRequestStore.setState({
    openRequest: 0,
    lens: undefined,
    focus: undefined,
    pending: false,
    requestedAt: 0,
  });
}
