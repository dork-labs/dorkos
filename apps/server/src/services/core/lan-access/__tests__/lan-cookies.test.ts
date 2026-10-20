import { afterEach, describe, expect, it } from 'vitest';
import {
  createServer,
  request,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  adaptCookiesForPlainHttp,
  adaptLanCookies,
  relaxSetCookie,
  restoreSecureCookieNames,
} from '../lan-cookies.js';
import { setLanTrust } from '../lan-trust.js';

const SESSION =
  '__Secure-better-auth.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax';

describe('relaxSetCookie', () => {
  it('drops the __Secure- prefix and the Secure attribute, and keeps the rest', () => {
    expect(relaxSetCookie(SESSION)).toBe(
      'better-auth.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax'
    );
  });

  it('leaves a cookie that was never Secure as it was', () => {
    const plain = 'theme=dark; Path=/';
    expect(relaxSetCookie(plain)).toBe(plain);
  });
});

describe('restoreSecureCookieNames', () => {
  it('prefixes Better Auth cookies and nothing else', () => {
    expect(restoreSecureCookieNames('better-auth.session_token=abc; theme=dark')).toBe(
      '__Secure-better-auth.session_token=abc; theme=dark'
    );
  });

  it('does not double a prefix already there', () => {
    expect(restoreSecureCookieNames('__Secure-better-auth.session_token=abc')).toBe(
      '__Secure-better-auth.session_token=abc'
    );
  });
});

describe('adaptCookiesForPlainHttp on a real server', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
  });

  /** Serve one route through the adapter, as the Wi-Fi listener does. */
  async function serve(secure: boolean, handler: RequestListener): Promise<number> {
    server = createServer((req, res) => {
      adaptCookiesForPlainHttp(req, res, secure);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  /** One request; resolves its Set-Cookie headers and body. */
  function call(port: number, cookie?: string) {
    return new Promise<{ setCookie: string[]; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/', headers: cookie ? { cookie } : {} },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ setCookie: res.headers['set-cookie'] ?? [], body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('relaxes cookies set through writeHead, and hands routes the names they set', async () => {
    const port = await serve(true, (req, res) => {
      res.writeHead(200, { 'Set-Cookie': [SESSION] });
      res.end(req.headers.cookie ?? '');
    });
    const { setCookie, body } = await call(port, 'better-auth.session_token=abc.def');
    expect(setCookie).toEqual([
      'better-auth.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect(body).toBe('__Secure-better-auth.session_token=abc.def');
  });

  it('relaxes cookies set through setHeader too', async () => {
    const port = await serve(true, (_req, res) => {
      res.setHeader('set-cookie', SESSION);
      res.end();
    });
    const { setCookie } = await call(port);
    expect(setCookie[0]).not.toMatch(/Secure/);
  });

  it('changes nothing in a build whose cookies are not Secure', async () => {
    const port = await serve(false, (req, res) => {
      res.writeHead(200, { 'Set-Cookie': [SESSION] });
      res.end(req.headers.cookie ?? '');
    });
    const { setCookie, body } = await call(port, 'better-auth.session_token=x');
    expect(setCookie).toEqual([SESSION]);
    expect(body).toBe('better-auth.session_token=x');
  });
});

describe('adaptLanCookies', () => {
  afterEach(() => setLanTrust(null));

  /** A bare request carrying a Host and a cookie. */
  const incoming = (host: string) =>
    ({ headers: { host, cookie: 'better-auth.session_token=x' } }) as unknown as IncomingMessage;

  it('adapts a request that names this computer on the network, and only that', () => {
    setLanTrust({ port: 4242, names: ['studio.local'], secureCookies: true });
    const lan = incoming('studio.local:4242');
    adaptLanCookies(lan);
    expect(lan.headers.cookie).toBe('__Secure-better-auth.session_token=x');

    // localhost, and any other name, are left exactly as they came.
    for (const host of ['localhost:4242', 'box.ngrok.app', 'printer.local:4242']) {
      const other = incoming(host);
      adaptLanCookies(other);
      expect(other.headers.cookie).toBe('better-auth.session_token=x');
    }
  });

  it('does nothing while Wi-Fi access is closed', () => {
    const req = incoming('studio.local:4242');
    adaptLanCookies(req);
    expect(req.headers.cookie).toBe('better-auth.session_token=x');
  });
});
