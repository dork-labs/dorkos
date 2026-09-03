import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from 'electron';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { applyPermissionPolicy, GRANTED_PERMISSIONS } from '../index';
import { createWindow } from '../../window-manager';
import { resetWindowStateModule } from '../../window-state';
import { resetElectronMock, session } from '../../__tests__/electron-mock';

/**
 * The permission seam (DOR-560). Electron's default for an unhandled permission
 * request is permissive — camera, microphone, geolocation and clipboard reads
 * are all grantable with no prompt anyone can see — and until this policy
 * existed the shipped app registered no handler at all.
 *
 * Every test drives the REAL handler the policy registered, pulled out of the
 * session double, rather than asserting that a setter was called: "a handler
 * exists" and "a handler denies the camera" are different claims, and only the
 * second one is the security property.
 */

/** Every permission name Electron can put to the request handler (electron.d.ts, v41). */
const ALL_REQUESTABLE = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'idle-detection',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'pointerLock',
  'keyboardLock',
  'openExternal',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'window-management',
  'unknown',
  'fileSystem',
] as const;

const OWN_ORIGIN = 'http://localhost:4242';

/** Treats only {@link OWN_ORIGIN} as the app's own page, like the real `isOwnOrigin`. */
function ownOriginOnly(url: string): boolean {
  return url.startsWith(OWN_ORIGIN);
}

/** Ask the registered request handler about one permission; returns what it answered. */
function ask(permission: string, requestingUrl = `${OWN_ORIGIN}/session`): boolean {
  const handler = session.defaultSession.setPermissionRequestHandler.mock.calls.at(-1)?.[0] as (
    webContents: unknown,
    permission: string,
    callback: (granted: boolean) => void,
    details: { requestingUrl: string; isMainFrame: boolean }
  ) => void;
  let answer: boolean | undefined;
  handler(null, permission, (granted) => (answer = granted), { requestingUrl, isMainFrame: true });
  if (answer === undefined) throw new Error('the permission handler never answered');
  return answer;
}

/** Ask the registered check handler about one permission. */
function check(permission: string, requestingOrigin = OWN_ORIGIN): boolean {
  const handler = session.defaultSession.setPermissionCheckHandler.mock.calls.at(-1)?.[0] as (
    webContents: unknown,
    permission: string,
    requestingOrigin: string,
    details: { isMainFrame: boolean }
  ) => boolean;
  return handler(null, permission, requestingOrigin, { isMainFrame: true });
}

beforeEach(() => {
  resetElectronMock();
  resetWindowStateModule();
});

describe('applyPermissionPolicy', () => {
  beforeEach(() => {
    applyPermissionPolicy(session.defaultSession as unknown as Session, ownOriginOnly);
  });

  it('denies every permission except the two the product uses', () => {
    const granted = ALL_REQUESTABLE.filter((permission) => ask(permission));

    expect(granted).toEqual(['clipboard-sanitized-write', 'notifications']);
  });

  it('denies the capabilities this app has no business asking for', () => {
    // Named individually, because a list comparison passing for the wrong
    // reason (an empty list, a renamed permission) would hide exactly these.
    expect(ask('media')).toBe(false);
    expect(ask('display-capture')).toBe(false);
    expect(ask('geolocation')).toBe(false);
    expect(ask('clipboard-read')).toBe(false);
    expect(ask('openExternal')).toBe(false);
  });

  it('grants notifications and clipboard writes to the app itself', () => {
    expect(ask('notifications')).toBe(true);
    expect(ask('clipboard-sanitized-write')).toBe(true);
  });

  it('refuses even an allowed permission to a page that is not ours', () => {
    // The canvas frames third-party sites; an MCP App runs in an opaque-origin
    // sandbox. Neither may raise a system notification through the cockpit.
    expect(ask('notifications', 'https://evil.example/page')).toBe(false);
    expect(ask('clipboard-sanitized-write', 'https://evil.example/page')).toBe(false);
    expect(check('notifications', 'null')).toBe(false);
  });

  it('refuses when Chromium does not say who is asking', () => {
    expect(ask('notifications', '')).toBe(false);
    expect(check('notifications', '')).toBe(false);
  });

  it('answers the synchronous check exactly as it answers the request', () => {
    for (const permission of ALL_REQUESTABLE) {
      expect(check(permission)).toBe(ask(permission));
    }
  });

  it('denies permissions the check handler alone knows about (hid, serial, usb)', () => {
    expect(check('hid')).toBe(false);
    expect(check('serial')).toBe(false);
    expect(check('usb')).toBe(false);
    expect(check('deprecated-sync-clipboard-read')).toBe(false);
  });

  it('refuses screen capture by handing back no stream at all', () => {
    const handler = session.defaultSession.setDisplayMediaRequestHandler.mock.calls.at(-1)?.[0] as (
      request: unknown,
      callback: (streams: Record<string, unknown>) => void
    ) => void;
    let streams: Record<string, unknown> | undefined;

    handler({}, (value) => (streams = value));

    expect(streams).toEqual({});
  });
});

describe('createWindow — permission policy is installed', () => {
  it('installs all three handlers on the window session', () => {
    createWindow();

    expect(session.defaultSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(session.defaultSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(session.defaultSession.setDisplayMediaRequestHandler).toHaveBeenCalledTimes(1);
  });

  it('denies the camera to the window it just created', () => {
    createWindow({ getRendererUrl: () => OWN_ORIGIN });

    expect(ask('media')).toBe(false);
    expect(ask('geolocation')).toBe(false);
  });

  it('grants notifications to the served cockpit, and to nothing else', () => {
    createWindow({ getRendererUrl: () => OWN_ORIGIN });

    expect(ask('notifications')).toBe(true);
    expect(ask('notifications', 'https://evil.example/page')).toBe(false);
  });

  it('keeps judging by the app origin after a crash restart moves the port', () => {
    // The accessor is live for permissions for the same reason it is live for
    // links: a value captured at window creation would deny the app's own page
    // its notifications the moment the server came back on a new port.
    let port = 4242;
    createWindow({ getRendererUrl: () => `http://localhost:${port}` });

    expect(ask('notifications', 'http://localhost:4242/session')).toBe(true);
    port = 5555;
    expect(ask('notifications', 'http://localhost:5555/session')).toBe(true);
    expect(ask('notifications', 'http://localhost:4242/session')).toBe(false);
  });
});

describe('GRANTED_PERMISSIONS', () => {
  it('names only what the product actually uses', () => {
    expect([...GRANTED_PERMISSIONS].sort()).toEqual(['clipboard-sanitized-write', 'notifications']);
  });
});
