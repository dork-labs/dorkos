import type { Session } from 'electron';
import log from 'electron-log';

/**
 * What the renderer is allowed to ask the operating system for.
 *
 * Chromium asks the embedder before it grants camera, microphone, screen
 * capture, geolocation, notifications, clipboard reads and the rest. **An
 * Electron app that registers no handler answers yes to nearly all of it** —
 * there is no prompt, because in a browser the prompt IS the embedder, and here
 * the embedder is us. That default is why this file exists.
 *
 * It matters more here than in most apps: the cockpit renders agent-authored
 * markdown, gen-UI widgets and marketplace card content on the app's own
 * privileged origin, and the canvas frames third-party sites outright. Neither
 * `sandbox: true` nor `contextIsolation` touches this seam — they isolate code
 * from Node, not the page from the machine's camera.
 *
 * Two rules, both narrow:
 * 1. Only the permissions the product actually uses are grantable (see
 *    {@link GRANTED_PERMISSIONS}); everything else is denied, always.
 * 2. Only the app's own pages may ask at all. A framed third-party site, and
 *    an MCP App in its opaque-origin sandbox, are refused before the
 *    permission name is even considered.
 *
 * @module main/permissions
 */

/**
 * The permissions a cockpit page may be granted.
 *
 * - `notifications` — the renderer raises a system notification when an agent
 *   finishes a turn while the window is in the background
 *   (`features/notifications/model/use-browser-notifications.ts`), and asks for
 *   the permission first (`shared/model/use-notification-permission.ts`).
 * - `clipboard-sanitized-write` — every copy affordance in the app goes through
 *   `navigator.clipboard.writeText` (`shared/lib/use-copy-feedback.ts`, the file
 *   explorer's copy-path action, and the boot panel's "Copy details").
 *
 * Everything else is denied, and the two worth naming are denied on purpose:
 * `media` (camera and microphone) because nothing in the product captures
 * either — `electron-builder.yml` strips the camera and microphone usage
 * strings from `Info.plist`, so on macOS a grant could not be honoured anyway —
 * and `openExternal` because leaving the app is the shell's decision, taken in
 * `window-manager.ts`, not the page's.
 */
export const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  'notifications',
  'clipboard-sanitized-write',
]);

/**
 * Decide one permission, for logging and for both handlers below.
 *
 * @param permission - Chromium's name for what was asked for.
 * @param requestingUrl - The URL of the frame that asked, or `undefined` when
 *   Chromium did not say (a cross-origin subframe's permission *check*). Not
 *   knowing who is asking is itself a reason to say no.
 * @param isTrustedOrigin - Whether a URL belongs to the app's own renderer; see
 *   {@link applyPermissionPolicy}.
 */
function decide(
  permission: string,
  requestingUrl: string | undefined,
  isTrustedOrigin: (url: string) => boolean
): boolean {
  if (!requestingUrl || !isTrustedOrigin(requestingUrl)) return false;
  return GRANTED_PERMISSIONS.has(permission);
}

/**
 * Install the deny-by-default permission policy on `target`.
 *
 * Three handlers, because Chromium reaches the embedder by three different
 * doors and leaving any of them unhandled restores the permissive default for
 * whatever comes through it:
 * - `setPermissionRequestHandler` — an explicit ask (`Notification.requestPermission()`,
 *   `getUserMedia`, …).
 * - `setPermissionCheckHandler` — the synchronous question Chromium asks before
 *   it even offers a capability (`navigator.permissions.query`, device
 *   enumeration). Without it a denied permission can still be reported as
 *   granted, and the two answers disagree.
 * - `setDisplayMediaRequestHandler` — screen and window capture, which does not
 *   go through the other two.
 *
 * Called per window against that window's own session, so it holds for whatever
 * session a window is given rather than assuming every window shares the
 * default one. Registering twice is harmless: each setter replaces the previous
 * handler.
 *
 * @param target - The session to police (a window's `webContents.session`).
 * @param isTrustedOrigin - Whether a URL is the app's own renderer entry — in
 *   production `window-manager.ts` passes its `isOwnOrigin` check, bound to the
 *   live server origin, so this keeps answering correctly after a crash
 *   restart moves the app to a new port.
 */
export function applyPermissionPolicy(
  target: Session,
  isTrustedOrigin: (url: string) => boolean
): void {
  target.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const granted = decide(permission, details.requestingUrl, isTrustedOrigin);
    if (!granted) {
      log.info(
        `[permissions] Denied "${permission}" to ${details.requestingUrl || 'an unnamed frame'}.`
      );
    }
    callback(granted);
  });

  target.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    decide(permission, requestingOrigin, isTrustedOrigin)
  );

  // Screen capture, denied outright — nothing in the product records a screen.
  // A `streams` object naming neither a video nor an audio source is how the
  // request is refused; the page's `getDisplayMedia` promise rejects.
  target.setDisplayMediaRequestHandler((_request, callback) => {
    log.info('[permissions] Denied a screen-capture request.');
    callback({});
  });
}
