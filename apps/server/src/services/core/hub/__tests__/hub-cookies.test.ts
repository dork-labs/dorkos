/**
 * A hub's sign-in cookies carry the `__Host-` prefix (`hub-cookies.ts`): out,
 * renamed with no `Domain`, `Path=/` and `Secure`; in, only the `__Host-` one
 * is believed, under the name the auth stack set.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const { adaptHubCookies, hostOnlySetCookie, restoreFromHostOnlyCookies } =
  await import('../hub-cookies.js');

beforeEach(() => {
  role.value = 'hub';
});

describe('a sign-in cookie on its way out', () => {
  it('becomes __Host-, with no Domain, Path=/ and Secure', () => {
    expect(
      hostOnlySetCookie(
        '__Secure-better-auth.session_token=abc; Max-Age=60; Domain=example.invalid; Path=/api; HttpOnly; SameSite=Lax'
      )
    ).toBe(
      '__Host-better-auth.session_token=abc; Max-Age=60; HttpOnly; SameSite=Lax; Path=/; Secure'
    );
  });

  it('leaves every other cookie alone', () => {
    for (const value of ['theme=dark; Path=/', 'better-auth-dev=1', '__Secure-other=1; Secure']) {
      expect(hostOnlySetCookie(value)).toBe(value);
    }
  });
});

describe('sign-in cookies on their way in', () => {
  it('believe only the __Host- one, under the name the auth stack set', () => {
    expect(
      restoreFromHostOnlyCookies(
        '__Secure-better-auth.session_token=planted; theme=dark; __Host-better-auth.session_token=real; better-auth.x=1'
      )
    ).toBe('theme=dark; __Secure-better-auth.session_token=real');
  });

  it('keeps a header with nothing to change as it was, minus spacing', () => {
    expect(restoreFromHostOnlyCookies('a=1;b=2')).toBe('a=1; b=2');
  });
});

describe('adaptHubCookies', () => {
  function fakeRes() {
    const sent: Record<string, unknown> = {};
    return {
      sent,
      res: {
        setHeader: (name: string, value: unknown) => void (sent[name.toLowerCase()] = value),
        appendHeader: (name: string, value: unknown) => void (sent[name.toLowerCase()] = value),
        writeHead: () => undefined,
      } as unknown as ServerResponse,
    };
  }

  it('rewrites both ways on a hub with Secure cookies', () => {
    const req = { headers: { cookie: '__Host-better-auth.session_token=real' } } as IncomingMessage;
    const { res, sent } = fakeRes();
    adaptHubCookies(req, res, true);
    expect(req.headers.cookie).toBe('__Secure-better-auth.session_token=real');
    res.setHeader('Set-Cookie', ['__Secure-better-auth.session_token=new; Path=/']);
    expect(sent['set-cookie']).toEqual(['__Host-better-auth.session_token=new; Path=/; Secure']);
  });

  it('drops the Cookie header when only a planted sign-in cookie was in it', () => {
    const req = {
      headers: { cookie: '__Secure-better-auth.session_token=planted' },
    } as IncomingMessage;
    adaptHubCookies(req, undefined, true);
    expect(req.headers.cookie).toBeUndefined();
  });

  it('does nothing on a person`s own computer, or without Secure cookies', () => {
    const cookie = '__Secure-better-auth.session_token=x';
    const onComputer = { headers: { cookie } } as IncomingMessage;
    role.value = 'computer';
    adaptHubCookies(onComputer, undefined, true);
    expect(onComputer.headers.cookie).toBe(cookie);
    role.value = 'hub';
    const devBuild = { headers: { cookie } } as IncomingMessage;
    adaptHubCookies(devBuild, undefined, false);
    expect(devBuild.headers.cookie).toBe(cookie);
  });
});
