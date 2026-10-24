/**
 * The pure rules of route binding (`sessions/session-route.ts`, DOR-2969).
 */
import { describe, expect, it } from 'vitest';

import {
  mayCarrySessionCookie,
  OTHER_DEVICE_SESSION_MAX_SECONDS,
  sessionMaxSeconds,
  sessionRouteOf,
  sessionWorksOn,
  WIFI_SESSION_MAX_SECONDS,
  withoutSessionCookies,
} from '../sessions/session-route.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const WEEK = WIFI_SESSION_MAX_SECONDS * 1000;

describe('sessionWorksOn', () => {
  it('holds a session to its own route', () => {
    expect(sessionWorksOn({ route: 'tunnel', createdAt: new Date(NOW) }, 'tunnel', NOW)).toBe(true);
    expect(sessionWorksOn({ route: 'tunnel', createdAt: new Date(NOW) }, 'wifi', NOW)).toBe(false);
    expect(sessionWorksOn({ route: 'hub', createdAt: new Date(NOW) }, 'hub', NOW)).toBe(true);
  });

  it('keeps a session with no route to this computer', () => {
    expect(sessionWorksOn({ route: null }, 'local', NOW)).toBe(true);
    expect(sessionWorksOn({}, 'local', NOW)).toBe(true);
    expect(sessionWorksOn({ route: null }, 'wifi', NOW)).toBe(false);
    expect(sessionWorksOn({ route: null }, 'hub', NOW)).toBe(false);
  });

  it('never admits a session on the relay', () => {
    expect(sessionRouteOf('relay')).toBeNull();
    expect(sessionWorksOn({ route: 'local' }, null, NOW)).toBe(false);
  });

  it('holds a Wi-Fi session to 7 days, and refuses one with no sign-in time', () => {
    expect(sessionWorksOn({ route: 'wifi', createdAt: new Date(NOW - WEEK) }, 'wifi', NOW)).toBe(
      true
    );
    expect(
      sessionWorksOn({ route: 'wifi', createdAt: new Date(NOW - WEEK - 1) }, 'wifi', NOW)
    ).toBe(false);
    expect(sessionWorksOn({ route: 'wifi' }, 'wifi', NOW)).toBe(false);
  });

  it('holds every other device to 90 days however often it is used (DOR-3172)', () => {
    const limit = OTHER_DEVICE_SESSION_MAX_SECONDS * 1000;
    for (const route of ['tunnel', 'managed', 'network', 'hub'] as const) {
      expect(sessionMaxSeconds(route)).toBe(90 * 24 * 60 * 60);
      expect(sessionWorksOn({ route, createdAt: new Date(NOW - limit) }, route, NOW)).toBe(true);
      expect(sessionWorksOn({ route, createdAt: new Date(NOW - limit - 1) }, route, NOW)).toBe(
        false
      );
      expect(sessionWorksOn({ route }, route, NOW)).toBe(false);
    }
  });

  it('puts no age limit on a sign-in made at this computer', () => {
    expect(sessionMaxSeconds('local')).toBeNull();
    const old = new Date(NOW - 10 * OTHER_DEVICE_SESSION_MAX_SECONDS * 1000);
    expect(sessionWorksOn({ route: 'local', createdAt: old }, 'local', NOW)).toBe(true);
    expect(sessionWorksOn({ route: null }, 'local', NOW)).toBe(true);
  });
});

describe('session cookies', () => {
  const jar = [
    '__Secure-better-auth.session_token=a',
    '__Secure-better-auth.session_data=b',
    'better-auth-abc.session_data.0=c',
    '__Host-better-auth.dont_remember=d',
    '__Secure-better-auth.state=keep',
    'theme=dark',
  ].join('; ');

  it('takes out every session cookie, under any prefix, and nothing else', () => {
    expect(mayCarrySessionCookie(jar)).toBe(true);
    const left = withoutSessionCookies(jar);
    expect(left).toBe('__Secure-better-auth.state=keep; theme=dark');
    expect(mayCarrySessionCookie(left)).toBe(false);
  });

  it('reads a name the way the cookie parser does, spaces, tabs and repeats included', () => {
    for (const header of [
      '__Secure-better-auth.session_token =stolen; theme=dark',
      '__Secure-better-auth.session_token\t=stolen; theme=dark',
      ' __Secure-better-auth.session_token = stolen ;theme=dark',
      '__Secure-better-auth.session_token=a; theme=dark; __Secure-better-auth.session_token=b',
    ]) {
      expect(mayCarrySessionCookie(header)).toBe(true);
      expect(withoutSessionCookies(header)).toBe('theme=dark');
    }
  });
});
