import { Notification } from 'electron';

/**
 * The thin seam between the notification pipeline (`notifications.ts`) and the
 * OS's own native notification, so a test can drive Allow/Deny/Reply and click
 * behaviour without a real Electron runtime (spec `notification-system`,
 * Desktop section).
 *
 * `notifications.ts` never imports `electron`'s `Notification` directly — it
 * only knows this interface, which is what lets a unit test assert exactly
 * what an action click POSTs to the answer routes.
 *
 * @module main/notifications/wrapper
 */

/** One macOS action button on a notification banner. Ignored on platforms that don't support `actions`. */
export interface NativeNotificationAction {
  /** Button label, already written for a person, e.g. `Allow`. */
  label: string;
}

/** What to show, and what to do when someone interacts with it. */
export interface NativeNotificationSpec {
  /** Agent identity first — see `notifications.ts`. */
  title: string;
  /** The second line. Never transcript content or tool input. */
  body?: string;
  /**
   * macOS action buttons, in the order they should appear. `onAction` names
   * the one clicked by its index into this array — Electron's own callback
   * shape, which has no per-button id.
   */
  actions?: NativeNotificationAction[];
  /** macOS-only inline reply field. */
  hasReply?: boolean;
  /** Placeholder text for the reply field, when {@link hasReply} is set. */
  replyPlaceholder?: string;
  /** An action button was clicked, by its index into {@link actions}. */
  onAction?: (index: number) => void;
  /** The reply field was submitted. */
  onReply?: (text: string) => void;
  /** The banner body was clicked — not an action, not a reply. */
  onClick?: () => void;
}

/** A shown native notification — the handle a caller closes later. */
export interface NativeNotificationHandle {
  /** Dismiss it, if the platform still shows it. A no-op if it is already gone. */
  close(): void;
}

/**
 * Where native notifications are shown. Swapped for a fake in tests; the real
 * implementation ({@link electronNotificationHost}) is the only place in this
 * module that touches Electron's `Notification`.
 */
export interface NotificationHost {
  /** Whether this platform can show a native notification at all. */
  isSupported(): boolean;
  /** Show one native notification and return a handle to it. */
  show(spec: NativeNotificationSpec): NativeNotificationHandle;
}

/**
 * Silent, always — sound is the escalation-tier's job (the `knock`/`settle`
 * sounds land client-side in W3, spec §"Sounds"), not the OS banner's. Without
 * this, a Blocking Ask would chime once for the OS banner and again for the
 * client's own knock the moment a window is focused — one interruption playing
 * as two sounds.
 */
const SILENT = true;

/** The real Electron-backed host. Used everywhere `notifications.ts` isn't under test. */
export const electronNotificationHost: NotificationHost = {
  isSupported: () => Notification.isSupported(),
  show(spec: NativeNotificationSpec): NativeNotificationHandle {
    const notification = new Notification({
      title: spec.title,
      body: spec.body,
      silent: SILENT,
      hasReply: spec.hasReply,
      replyPlaceholder: spec.replyPlaceholder,
      actions: spec.actions?.map((action) => ({ type: 'button' as const, text: action.label })),
    });
    if (spec.onAction) {
      const onAction = spec.onAction;
      notification.on('action', (_event, index) => onAction(index));
    }
    if (spec.onReply) {
      const onReply = spec.onReply;
      notification.on('reply', (_event, reply) => onReply(reply));
    }
    if (spec.onClick) notification.on('click', () => spec.onClick?.());
    notification.show();
    return { close: () => notification.close() };
  },
};
