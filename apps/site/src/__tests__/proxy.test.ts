import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

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
