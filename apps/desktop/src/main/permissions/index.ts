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
 * One more is granted only in part, by {@link isReadOfAHandedOverFile}: reading
 * a file the person dropped on the app (`fileSystem`, readable, not a folder).
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
 * What Chromium says about a `fileSystem` ask; absent for every other
 * permission. Both handlers receive these two fields under the same names.
 */
interface FileAccessDetails {
  fileAccessType?: 'writable' | 'readable';
  isDirectory?: boolean;
}

/**
 * Whether a `fileSystem` ask is only to read one file the person handed over.
 *
 * Dropping a file on the composer is that ask. The drop library the composer
 * uses (react-dropzone, through `file-selector`) reads a dropped file through
 * its File System Access handle whenever the page is a secure context, and the
 * app's localhost origin is one, so Chromium checks `fileSystem` before
 * handing over the bytes. Denying it made every drop fail with `NotAllowedError`
 * while the paperclip, which never touches a handle, kept working (DOR-2870).
 *
 * Granting it gives the page nothing new: a handle exists only for a file the
 * person dropped or picked themselves, and the page can read that file through
 * `DataTransfer.files` anyway. The one widening: a page that saved a handle
 * from an earlier drop can read that same file again later without asking,
 * where Chrome would ask again. Never a file the person did not hand over.
 * Writing and whole folders stay denied — nothing in the product asks for
 * either.
 *
 * @param permission - Chromium's name for what was asked for.
 * @param details - The file fields of the ask, when it is a `fileSystem` one.
 */
function isReadOfAHandedOverFile(permission: string, details: FileAccessDetails): boolean {
  return (
    permission === 'fileSystem' &&
    details.fileAccessType === 'readable' &&
    details.isDirectory === false
  );
}

/**
 * Decide one permission, for logging and for both handlers below.
 *
 * @param permission - Chromium's name for what was asked for.
 * @param requestingUrl - The URL of the frame that asked, or `undefined` when
 *   Chromium did not say (a cross-origin subframe's permission *check*). Not
 *   knowing who is asking is itself a reason to say no.
 * @param isTrustedOrigin - Whether a URL belongs to the app's own renderer; see
 *   {@link applyPermissionPolicy}.
 * @param details - The file fields of a `fileSystem` ask; see
 *   {@link isReadOfAHandedOverFile}.
 */
function decide(
  permission: string,
  requestingUrl: string | undefined,
  isTrustedOrigin: (url: string) => boolean,
  details: FileAccessDetails
): boolean {
  if (!requestingUrl || !isTrustedOrigin(requestingUrl)) return false;
  return GRANTED_PERMISSIONS.has(permission) || isReadOfAHandedOverFile(permission, details);
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
    // Only the `fileSystem` member of the union carries the file fields.
    const fileDetails = 'fileAccessType' in details ? details : {};
    const granted = decide(permission, details.requestingUrl, isTrustedOrigin, fileDetails);
    if (!granted) {
      log.info(
        `[permissions] Denied "${permission}" to ${details.requestingUrl || 'an unnamed frame'}.`
      );
    }
    callback(granted);
  });

  target.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    decide(permission, requestingOrigin, isTrustedOrigin, details)
  );

  // Screen capture, denied outright — nothing in the product records a screen.
  // A `streams` object naming neither a video nor an audio source is how the
  // request is refused; the page's `getDisplayMedia` promise rejects.
  target.setDisplayMediaRequestHandler((_request, callback) => {
    log.info('[permissions] Denied a screen-capture request.');
    callback({});
  });
}
