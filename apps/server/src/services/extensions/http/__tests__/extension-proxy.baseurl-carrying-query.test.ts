import {
  mockSecretGet,
  limiter,
  role,
  fixtureTarget,
  DEFAULT_CONFIG,
  makeReq,
  makeRes,
  getProxyHandler,
  proxyApp,
} from './extension-proxy.fixtures.js';
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { proxySegments } from '../extension-proxy.js';
import { logger } from '../../../../lib/logger.js';

// --- Tests ---

describe('the extension data proxy', () => {
  describe('a baseUrl carrying a query or fragment', () => {
    it('drops it once at router creation instead of failing every request', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler({
        ...DEFAULT_CONFIG,
        baseUrl: 'https://api.example.com/v1?token=leftover#frag',
      });
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['issues'] } }), res);

      expect(res._status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/issues',
        expect.any(Object)
      );
      expect(vi.mocked(logger.warn).mock.calls.map(String).join('\n')).toContain('baseUrl');
    });
  });

  describe('redirects', () => {
    it('asks fetch not to follow them', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'manual' })
      );
    });

    it('hands the redirect back to the caller instead of chasing it', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler();
      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._status).toBe(302);
      expect(res._headers.Location).toBe('http://169.254.169.254/latest/meta-data/');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('drops the redirect target on a hub, so its address redirects nowhere', async () => {
      role.value = 'hub';
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'https://elsewhere.example/' }),
        text: () => Promise.resolve(''),
      });

      const res = makeRes();
      await getProxyHandler()(makeReq(), res);

      expect(res._status).toBe(302);
      expect(res._headers.Location).toBeUndefined();
    });
  });

  describe('an upstream page opened at DorkOS', () => {
    it('runs nothing: every answer is sandboxed and never sniffed', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<script>alert(1)</script>'),
      });

      const res = await request(fixtureTarget.mount(proxyApp())).get('/api/ext/test-ext/proxy/x');

      expect(res.headers['content-security-policy']).toBe(
        "sandbox; default-src 'none', frame-ancestors 'none'"
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // Driven against a REAL upstream with the REAL `fetch`. The mocked `fetch`
  // everywhere else accepts any headers object, so it cannot reproduce what
  // undici does with a `Content-Length` that disagrees with the body — which is
  // the whole failure this covers.
  describe('against a real upstream', () => {
    /** A server that records one request and answers 200. */
    async function upstream(): Promise<{
      url: string;
      received: Promise<{ body: string; headers: http.IncomingHttpHeaders }>;
      close: () => void;
    }> {
      let resolve!: (value: { body: string; headers: http.IncomingHttpHeaders }) => void;
      const received = new Promise<{ body: string; headers: http.IncomingHttpHeaders }>((r) => {
        resolve = r;
      });
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += String(chunk);
        });
        req.on('end', () => {
          resolve({ body, headers: req.headers });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      return {
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => server.close(),
      };
    }

    it('forwards an empty POST as {} without the caller Content-Length breaking it', async () => {
      mockSecretGet.mockResolvedValue('tok');
      const up = await upstream();
      try {
        const handler = getProxyHandler({ ...DEFAULT_CONFIG, baseUrl: up.url });
        const res = makeRes();
        await handler(
          makeReq({
            method: 'POST',
            params: { splat: ['things'] },
            // What a browser actually sends for `POST {}` — 2 bytes here, but a
            // caller that pretty-printed its JSON sends a bigger number, and
            // either way it describes the caller's bytes, not ours.
            headers: {
              'content-type': 'application/json',
              'content-length': '4096',
              host: 'localhost:6242',
            } as Record<string, string>,
          }),
          res
        );

        const got = await up.received;
        expect(got.body).toBe('{}');
        expect(got.headers['content-length']).toBe('2');
        expect(res._status).toBe(200);
        expect(res._body).toBe('{"ok":true}');
      } finally {
        up.close();
      }
    });

    it('forwards a real body and reaches the upstream with the injected credential', async () => {
      mockSecretGet.mockResolvedValue('tok');
      const up = await upstream();
      try {
        const handler = getProxyHandler({ ...DEFAULT_CONFIG, baseUrl: up.url });
        const res = makeRes();
        await handler(
          makeReq({
            method: 'POST',
            params: { splat: ['things'] },
            body: { query: 'x' },
            headers: {
              'content-type': 'application/json',
              'content-length': '9999',
              cookie: 'dorkos.session_token=secret-session',
            } as Record<string, string>,
          }),
          res
        );

        const got = await up.received;
        expect(got.body).toBe('{"query":"x"}');
        expect(got.headers.authorization).toBe('Bearer tok');
        expect(got.headers.cookie).toBeUndefined();
        expect(res._status).toBe(200);
      } finally {
        up.close();
      }
    });
  });

  describe('rate limiting', () => {
    it('costs no upstream request when the limiter refuses', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn();
      limiter.refuse = true;

      const res = await request(fixtureTarget.mount(proxyApp())).get(
        '/api/ext/test-ext/proxy/graphql'
      );

      expect(res.status).toBe(429);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(mockSecretGet).not.toHaveBeenCalled();
    });
  });
});

describe('proxySegments', () => {
  it('matches /proxy and anything below it, in any case, decoding each segment', () => {
    expect(proxySegments('/proxy')).toEqual([]);
    expect(proxySegments('/proxy/')).toEqual([]);
    expect(proxySegments('/PROXY/a/b')).toEqual(['a', 'b']);
    expect(proxySegments('/proxy/..%2f..%2fadmin')).toEqual(['../../admin']);
    expect(proxySegments('/proxy/%2e%2e/x')).toEqual(['..', 'x']);
  });

  it('passes on every other path', () => {
    expect(proxySegments('/')).toBeNull();
    expect(proxySegments('/proxyish/a')).toBeNull();
    expect(proxySegments('/other/proxy')).toBeNull();
  });
});
