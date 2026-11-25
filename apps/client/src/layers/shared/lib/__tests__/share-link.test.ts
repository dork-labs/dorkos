/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';
import { dorkShareUrl, shareableAppUrl } from '../share-link';

afterEach(leaveDesktopShell);

describe('shareableAppUrl', () => {
  it('in a browser, is this origin plus the location', () => {
    expect(shareableAppUrl('/session?session=abc')).toBe(
      `${window.location.origin}/session?session=abc`
    );
    expect(shareableAppUrl('/')).toBe(`${window.location.origin}/`);
  });

  it('in the desktop app, is a dorkos:// link that survives a restart', () => {
    enterDesktopShell();
    expect(shareableAppUrl('/session?session=abc&dir=%2Ftmp')).toBe(
      'dorkos://session?session=abc&dir=%2Ftmp'
    );
    expect(shareableAppUrl('/channels?id=room-1')).toBe('dorkos://channels?id=room-1');
  });

  it('in the desktop app, falls back to the origin for the dashboard, which a deep link cannot name', () => {
    enterDesktopShell();
    expect(shareableAppUrl('/')).toBe(`${window.location.origin}/`);
    expect(shareableAppUrl('/?settings=open')).toBe(`${window.location.origin}/?settings=open`);
  });
});

describe('dorkShareUrl (DOR-5046)', () => {
  const chat = '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';

  it('in a browser, is this origin plus the /r/ link', () => {
    expect(dorkShareUrl('chat', chat)).toBe(`${window.location.origin}/r/dork:chat:${chat}`);
    expect(dorkShareUrl('agent', '01KJXYKJYW4N8QGQ5W4GB6YM9J')).toBe(
      `${window.location.origin}/r/dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J`
    );
  });

  it('in the desktop app, is the dorkos://r/ link the app opens', () => {
    enterDesktopShell();
    expect(dorkShareUrl('entry', '01JD3G7Z7P1Q4R8S9T0U2V3W4X')).toBe(
      'dorkos://r/dork:entry:01JD3G7Z7P1Q4R8S9T0U2V3W4X'
    );
  });

  it('is null for an id that cannot be a reference', () => {
    expect(dorkShareUrl('room', 'has.dots')).toBeNull();
  });
});
