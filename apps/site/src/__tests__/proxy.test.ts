import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { env } from '@/env';
import {
  CLOUD_ACCOUNT_API_EXACT,
  CLOUD_ACCOUNT_API_PREFIXES,
  CLOUD_MANAGED_API_PREFIXES,
  CLOUD_MANAGED_PAGE_PREFIXES,
  CLOUD_ACCOUNT_PAGE_PREFIXES,
} from '@/lib/cloud-accounts/forward';
import { config, proxy } from '../proxy';

function request(path: string, headers: Record<string, string> = {}, method = 'GET'): NextRequest {
  return new NextRequest(`https://dorkos.ai${path}`, { headers, method });
}

/** The rewrite destination Next.js records on the response, if any. */
function rewriteTarget(response: Response): string | null {
  return response.headers.get('x-middleware-rewrite');
}

describe('proxy /install content negotiation', () => {
  it('serves the script to curl', () => {
    const response = proxy(request('/install', { 'user-agent': 'curl/8.7.1' }));
    expect(rewriteTarget(response)).toContain('/install.sh');
  });

  it('serves the script to wget', () => {
    const response = proxy(request('/install', { 'user-agent': 'Wget/1.21.4' }));
    expect(rewriteTarget(response)).toContain('/install.sh');
  });

  it('serves the page to browsers', () => {
    const response = proxy(
      request('/install', {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      })
    );
    expect(rewriteTarget(response)).toBeNull();
  });

  it('serves the page to link-unfurl bots so OpenGraph tags render', () => {
    for (const bot of ['Slackbot-LinkExpanding 1.0', 'Discordbot/2.0', 'facebookexternalhit/1.1']) {
      const response = proxy(request('/install', { 'user-agent': bot, accept: '*/*' }));
      expect(rewriteTarget(response)).toBeNull();
    }
  });

  it('serves the page to RSC/prefetch navigations', () => {
    const response = proxy(
      request('/install', { 'user-agent': 'Mozilla/5.0', accept: '*/*', rsc: '1' })
    );
    expect(rewriteTarget(response)).toBeNull();
  });

  it('sets the region cookie on page responses but not script rewrites', () => {
    const pageResponse = proxy(request('/install', { 'user-agent': 'Mozilla/5.0' }));
    expect(pageResponse.headers.get('set-cookie')).toContain('dorkos_region');

    const scriptResponse = proxy(request('/install', { 'user-agent': 'curl/8.7.1' }));
    expect(scriptResponse.headers.get('set-cookie')).toBeNull();
  });

  it('leaves other paths alone for CLI user agents', () => {
    const response = proxy(request('/blog', { 'user-agent': 'curl/8.7.1' }));
    expect(rewriteTarget(response)).toBeNull();
  });
});

describe('proxy /docs markdown content negotiation', () => {
  it('rewrites a canonical docs URL to the llms.mdx route when markdown is preferred', () => {
    const response = proxy(
      request('/docs/getting-started/quickstart', { accept: 'text/markdown' })
    );
    expect(rewriteTarget(response)).toContain('/llms.mdx/docs/getting-started/quickstart');
  });

  it('rewrites when the client sends Accept: text/plain', () => {
    // `text/plain` is one of fumadocs-core's default markdownMediaTypes (alongside
    // text/markdown and text/x-markdown). This test pins that default: if a future
    // fumadocs-core bump drops text/plain from the list, this breaks loudly instead
    // of silently serving HTML to plain-text agent fetches.
    const response = proxy(request('/docs/getting-started/quickstart', { accept: 'text/plain' }));
    expect(rewriteTarget(response)).toContain('/llms.mdx/docs/getting-started/quickstart');
  });

  it('rewrites the bare /docs index when markdown is preferred', () => {
    const response = proxy(request('/docs', { accept: 'text/markdown' }));
    const target = rewriteTarget(response);
    expect(target).toContain('/llms.mdx/docs');
    // Must be the index route, not a mangled child path.
    expect(new URL(target!).pathname).toBe('/llms.mdx/docs');
  });

  it('serves HTML (no rewrite) to browser navigations', () => {
    const response = proxy(
      request('/docs/getting-started/quickstart', {
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      })
    );
    expect(rewriteTarget(response)).toBeNull();
  });

  it('does not treat RSC/prefetch requests as markdown', () => {
    const response = proxy(
      request('/docs/getting-started/quickstart', { accept: 'text/x-component', rsc: '1' })
    );
    expect(rewriteTarget(response)).toBeNull();
  });

  it('does not treat a wildcard Accept as markdown', () => {
    const response = proxy(request('/docs/getting-started/quickstart', { accept: '*/*' }));
    expect(rewriteTarget(response)).toBeNull();
  });

  it('does not rewrite non-docs paths even when markdown is preferred', () => {
    const response = proxy(request('/blog', { accept: 'text/markdown' }));
    expect(rewriteTarget(response)).toBeNull();
  });

  it('advertises the markdown alternate on docs HTML responses', () => {
    const response = proxy(
      request('/docs/getting-started/quickstart', {
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html',
      })
    );
    expect(response.headers.get('Link')).toBe(
      '</docs/getting-started/quickstart.md>; rel="alternate"; type="text/markdown"'
    );
  });

  it('does not advertise a markdown alternate on non-docs pages', () => {
    const response = proxy(request('/blog', { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }));
    expect(response.headers.get('Link')).toBeNull();
  });

  it('sets no region cookie on markdown rewrites', () => {
    const response = proxy(
      request('/docs/getting-started/quickstart', { accept: 'text/markdown' })
    );
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('proxy config.matcher', () => {
  // Next.js compiles each matcher string into an anchored regex; mirror that here.
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it('runs the proxy on a canonical (extension-less) docs page', () => {
    expect(matcher.test('/docs/getting-started/quickstart')).toBe(true);
  });

  it('excludes dotted paths so the proxy never sees the .md/.mdx suffix aliases', () => {
    // The proxy assumes extension-less pathnames: docsMarkdownTarget and the Link
    // header both append `.md`, so if the proxy ran on a `/docs/....md` path it would
    // emit a broken double-suffix rewrite/alternate. The matcher's `.*\..*` negative
    // lookahead is what guarantees dotted paths (handled by next.config.ts rewrites)
    // bypass the proxy entirely.
    expect(matcher.test('/docs/getting-started/quickstart.md')).toBe(false);
    expect(matcher.test('/docs/getting-started/quickstart.mdx')).toBe(false);
  });
});

// DOR-2441: the accounts hand-over, in both positions of its variable.
describe('proxy accounts hand-over', () => {
  const SERVICE = 'https://accounts.example.test';

  afterEach(() => {
    env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = undefined;
    env.DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET = undefined;
    env.VERCEL_ENV = undefined;
    env.VERCEL = undefined;
  });

  /** The request headers Next.js will send on the rewrite, when the proxy overrode them. */
  function overriddenHeaders(response: Response): string[] | null {
    return response.headers.get('x-middleware-override-headers')?.split(',') ?? null;
  }

  describe('with the variable unset', () => {
    it('serves account pages locally, with the region cookie as before', () => {
      const response = proxy(request('/activate?user_code=ABCD-EFGH'));
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(rewriteTarget(response)).toBeNull();
      expect(response.headers.get('set-cookie')).toContain('dorkos_region');
    });

    it('serves the account API locally, with no region cookie', () => {
      const response = proxy(
        request('/api/instances/heartbeat', { authorization: 'Bearer t' }, 'POST')
      );
      expect(rewriteTarget(response)).toBeNull();
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('with the variable set', () => {
    it('redirects the activation link with its code, uncached and without a cookie', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      const response = proxy(request('/activate?user_code=ABCD-EFGH'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`${SERVICE}/activate?user_code=ABCD-EFGH`);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('proxies a heartbeat to the same path on the service', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      const response = proxy(
        request('/api/instances/heartbeat', { authorization: 'Bearer t' }, 'POST')
      );
      expect(rewriteTarget(response)).toBe(`${SERVICE}/api/instances/heartbeat`);
      expect(response.headers.get('location')).toBeNull();
    });

    it('proxies the device-code request a released CLI makes', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      const response = proxy(
        request('/api/auth/device/code', { 'content-type': 'application/json' }, 'POST')
      );
      expect(rewriteTarget(response)).toBe(`${SERVICE}/api/auth/device/code`);
    });

    it('tells the service who a proxied caller is, with the shared secret (DOR-2443)', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      env.DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET = 'k'.repeat(40);
      env.VERCEL_ENV = 'production';
      env.VERCEL = '1';
      const response = proxy(
        request('/api/auth/device/code', { 'x-real-ip': '198.51.100.7' }, 'POST')
      );
      expect(rewriteTarget(response)).toBe(`${SERVICE}/api/auth/device/code`);
      expect(response.headers.get('x-middleware-request-x-dorkos-client-address')).toBe(
        '198.51.100.7'
      );
      expect(response.headers.get('x-middleware-request-x-dorkos-proxy-secret')).toBe(
        'k'.repeat(40)
      );
    });

    it('proxies exactly as before when the secret is unset', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      env.VERCEL_ENV = 'production';
      const response = proxy(
        request('/api/auth/device/code', { 'x-real-ip': '198.51.100.7' }, 'POST')
      );
      expect(rewriteTarget(response)).toBe(`${SERVICE}/api/auth/device/code`);
      expect(overriddenHeaders(response)).toBeNull();
    });

    it('drops a caller’s own copy of either header before proxying', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      const response = proxy(
        request(
          '/api/auth/device/token',
          { 'x-dorkos-client-address': '203.0.113.9', 'x-dorkos-proxy-secret': 'guess' },
          'POST'
        )
      );
      expect(rewriteTarget(response)).toBe(`${SERVICE}/api/auth/device/token`);
      const kept = overriddenHeaders(response);
      expect(kept).not.toBeNull();
      expect(kept).not.toContain('x-dorkos-client-address');
      expect(kept).not.toContain('x-dorkos-proxy-secret');
    });

    it('vouches for nothing when only VERCEL_ENV says Vercel (a pulled .env.local)', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      env.DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET = 'k'.repeat(40);
      env.VERCEL_ENV = 'production';
      const response = proxy(
        request('/api/auth/device/code', { 'x-real-ip': '198.51.100.7' }, 'POST')
      );
      expect(overriddenHeaders(response)).toBeNull();
    });

    it('never puts the secret on a redirect of an account API path', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      env.DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET = 'k'.repeat(40);
      env.VERCEL_ENV = 'production';
      env.VERCEL = '1';
      // A navigation to an email link: an account API path, redirected, not proxied.
      const response = proxy(
        request('/api/auth/verify-email?token=t', { 'x-real-ip': '198.51.100.7' })
      );
      expect(response.status).toBe(307);
      for (const [name, value] of response.headers) {
        expect(value, name).not.toContain('k'.repeat(40));
      }
    });

    it('sends managed connections on only with their own switch as well (DOR-2485)', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      env.DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD = '1';
      try {
        const pull = proxy(
          request('/api/instances/connectors/events/pull', { authorization: 'Bearer t' }, 'POST')
        );
        expect(rewriteTarget(pull)).toBe(`${SERVICE}/api/instances/connectors/events/pull`);
        const page = proxy(request('/connectors/managed/authorize?flow=f&nonce=n'));
        expect(page.status).toBe(307);
        expect(page.headers.get('location')).toBe(
          `${SERVICE}/connectors/managed/authorize?flow=f&nonce=n`
        );
        // The rest of the site is untouched by it.
        expect(rewriteTarget(proxy(request('/blog')))).toBeNull();
      } finally {
        env.DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD = undefined;
      }
    });

    it('proxies the provider webhook with its signature headers, and vouches for the caller', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      env.DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD = '1';
      env.DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET = 'k'.repeat(40);
      env.VERCEL_ENV = 'production';
      env.VERCEL = '1';
      try {
        const response = proxy(
          request(
            '/api/connectors/managed/events',
            {
              'content-type': 'application/json',
              'webhook-id': 'msg_1',
              'webhook-timestamp': '1700000000',
              'webhook-signature': 'v1,sig',
              'x-real-ip': '198.51.100.7',
            },
            'POST'
          )
        );
        // Rewritten, never redirected: a redirect would drop the body.
        expect(response.headers.get('location')).toBeNull();
        expect(rewriteTarget(response)).toBe(`${SERVICE}/api/connectors/managed/events`);
        for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
          expect(response.headers.get(`x-middleware-request-${name}`), name).not.toBeNull();
        }
        expect(response.headers.get('x-middleware-request-x-dorkos-client-address')).toBe(
          '198.51.100.7'
        );
      } finally {
        env.DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD = undefined;
      }
    });

    it('redirects the provider callback navigation without the secret, and proxies it as a fetch', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      env.DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD = '1';
      env.DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET = 'k'.repeat(40);
      env.VERCEL_ENV = 'production';
      env.VERCEL = '1';
      try {
        const navigation = proxy(
          request('/api/connectors/managed/callback?session_uri=s', {
            'x-real-ip': '198.51.100.7',
            'sec-fetch-mode': 'navigate',
          })
        );
        expect(navigation.status).toBe(307);
        expect(navigation.headers.get('location')).toBe(
          `${SERVICE}/api/connectors/managed/callback?session_uri=s`
        );
        for (const [name, value] of navigation.headers) {
          expect(value, name).not.toContain('k'.repeat(40));
        }
        const fetched = proxy(
          request('/api/connectors/managed/callback?session_uri=s', { 'sec-fetch-mode': 'cors' })
        );
        expect(rewriteTarget(fetched)).toBe(
          `${SERVICE}/api/connectors/managed/callback?session_uri=s`
        );
      } finally {
        env.DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD = undefined;
      }
    });

    it('leaves managed connections and the rest of the site alone', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = SERVICE;
      for (const response of [
        proxy(request('/blog')),
        proxy(request('/connectors/managed/authorize')),
        proxy(request('/api/instances/connectors/events/pull', {}, 'POST')),
      ]) {
        expect(response.headers.get('location')).toBeNull();
        expect(rewriteTarget(response)).toBeNull();
      }
    });

    it('serves locally when the variable is not a usable origin', () => {
      env.DORKOS_CLOUD_ACCOUNTS_ORIGIN = 'accounts.example.test';
      const original = console.error;
      console.error = () => {};
      try {
        const response = proxy(request('/signin'));
        expect(response.headers.get('location')).toBeNull();
      } finally {
        console.error = original;
      }
    });
  });

  describe('config.matcher', () => {
    // Next's own matcher, not a model of it: a hand-compiled regex would only
    // repeat what this file assumes about `:path*`.
    const matched = (path: string) =>
      unstable_doesMiddlewareMatch({ config, url: `https://dorkos.ai${path}` });

    it('reaches every path the hand-over forwards, with or without a trailing slash', () => {
      const paths = [
        ...CLOUD_ACCOUNT_PAGE_PREFIXES.flatMap((p) => [p, `${p}/child`]),
        ...CLOUD_ACCOUNT_API_PREFIXES.flatMap((p) => [p, `${p}/`, `${p}/child`]),
        ...CLOUD_ACCOUNT_API_EXACT.flatMap((p) => [p, `${p}/`]),
        ...CLOUD_MANAGED_API_PREFIXES.flatMap((p) => [p, `${p}/`, `${p}/child`]),
        ...CLOUD_MANAGED_PAGE_PREFIXES.flatMap((p) => [p, `${p}/child`]),
      ];
      for (const path of paths) expect(matched(path), path).toBe(true);
    });

    it('still does not run on other API routes', () => {
      for (const path of [
        '/api/feedback',
        '/api/cron/instance-expiry',
        '/api/telemetry/heartbeat',
        '/api/accounts',
        '/api/authx',
      ]) {
        expect(matched(path), path).toBe(false);
      }
    });
  });
});
