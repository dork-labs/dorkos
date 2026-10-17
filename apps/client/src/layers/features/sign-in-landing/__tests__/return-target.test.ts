import { describe, expect, it } from 'vitest';
import {
  DESKTOP_FOREGROUND_LINK,
  isAppPath,
  opensDesktopOnLoad,
  returnTarget,
} from '../lib/return-target';

describe('returnTarget', () => {
  it('opens the asking conversation in the desktop app', () => {
    expect(
      returnTarget({ returnSurface: 'desktop', returnPath: '/session?session=abc-123' })
    ).toEqual({ surface: 'desktop', href: 'dorkos://session?session=abc-123' });
  });

  it('only brings the desktop app forward when no conversation asked', () => {
    expect(returnTarget({ returnSurface: 'desktop' })).toEqual({
      surface: 'desktop',
      href: DESKTOP_FOREGROUND_LINK,
    });
  });

  it('goes back to the conversation in the browser, on this origin', () => {
    expect(returnTarget({ returnSurface: 'browser', returnPath: '/session?session=abc' })).toEqual({
      surface: 'browser',
      href: '/session?session=abc',
    });
  });

  it('goes to the app’s home in the browser when no conversation asked', () => {
    expect(returnTarget({ returnSurface: 'browser' })).toEqual({ surface: 'browser', href: '/' });
  });

  it.each([
    ['another host', '//evil.example/x'],
    ['a backslash host', '/\\evil.example'],
    ['an absolute URL', 'https://evil.example'],
    ['a script URL', 'javascript:alert(1)'],
    ['whitespace', '/session?x= y'],
  ])('drops a path that leaves this origin (%s)', (_label, returnPath) => {
    expect(isAppPath(returnPath)).toBe(false);
    expect(returnTarget({ returnSurface: 'browser', returnPath }).href).toBe('/');
    expect(returnTarget({ returnSurface: 'desktop', returnPath }).href).toBe(
      DESKTOP_FOREGROUND_LINK
    );
  });
});

describe('opensDesktopOnLoad', () => {
  it('hands a finished desktop sign-in straight back to the app', () => {
    expect(opensDesktopOnLoad({ returnSurface: 'desktop', status: 'connected' })).toBe(true);
  });

  it('stays on the page for a failed one, where Try again is', () => {
    expect(opensDesktopOnLoad({ returnSurface: 'desktop', status: 'failed' })).toBe(false);
  });

  it('never opens anything on its own in the browser', () => {
    expect(opensDesktopOnLoad({ returnSurface: 'browser', status: 'connected' })).toBe(false);
  });
});
