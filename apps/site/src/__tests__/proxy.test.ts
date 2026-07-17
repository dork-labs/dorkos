import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '../proxy';

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://dorkos.ai${path}`, { headers });
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
