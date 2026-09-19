import { describe, expect, it } from 'vitest';
import {
  AGENT_BROWSER_SERVER_NAME,
  StorageStateSchema,
  agentBrowserConnection,
  agentBrowserStateFileOf,
  hostBelongsToSite,
  normalizeSiteInput,
  summarizeStorageState,
  withoutSite,
  type StorageState,
  type StorageStateCookie,
} from '../agent-browser.js';

const NOW = 1_800_000_000;

function cookie(domain: string, expires: number, name = 'sid'): StorageStateCookie {
  return {
    name,
    value: `secret-${name}-${domain}`,
    domain,
    path: '/',
    expires,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };
}

describe('agentBrowserConnection', () => {
  it('runs Playwright MCP isolated, seeded from the saved session', () => {
    expect(AGENT_BROWSER_SERVER_NAME).toBe('browser');
    expect(agentBrowserConnection('/home/me/.dork/browser/storage-state.json')).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@playwright/mcp@0.0.82',
        '--isolated',
        '--headless',
        '--storage-state',
        '/home/me/.dork/browser/storage-state.json',
      ],
      env: {},
    });
  });
});

describe('agentBrowserStateFileOf', () => {
  it('finds the session file of a Playwright MCP server, whatever it is named', () => {
    expect(agentBrowserStateFileOf(agentBrowserConnection('/s.json'))).toBe('/s.json');
    expect(
      agentBrowserStateFileOf({
        transport: 'stdio',
        args: ['@playwright/mcp@0.0.82', '--storage-state=/pinned.json'],
      })
    ).toBe('/pinned.json');
  });

  it('ignores servers that are not a seeded Playwright browser', () => {
    expect(agentBrowserStateFileOf({ transport: 'http' })).toBeUndefined();
    expect(
      agentBrowserStateFileOf({ transport: 'stdio', args: ['@playwright/mcp@latest'] })
    ).toBeUndefined();
    expect(
      agentBrowserStateFileOf({ transport: 'stdio', args: ['other', '--storage-state', '/x'] })
    ).toBeUndefined();
  });
});

describe('normalizeSiteInput', () => {
  it('takes the host from a URL or a bare name', () => {
    expect(normalizeSiteInput('https://GitHub.com/login')).toBe('github.com');
    expect(normalizeSiteInput('.github.com')).toBe('github.com');
    expect(normalizeSiteInput('linear.app/team')).toBe('linear.app');
    expect(normalizeSiteInput('localhost:3000')).toBe('localhost');
    expect(normalizeSiteInput('   ')).toBe('');
  });
});

describe('hostBelongsToSite', () => {
  it('matches the site and its subdomains, never a lookalike', () => {
    expect(hostBelongsToSite('.github.com', 'github.com')).toBe(true);
    expect(hostBelongsToSite('gist.github.com', 'github.com')).toBe(true);
    expect(hostBelongsToSite('notgithub.com', 'github.com')).toBe(false);
  });
});

describe('summarizeStorageState', () => {
  const state: StorageState = {
    cookies: [
      cookie('.github.com', NOW + 86_400, 'a'),
      cookie('gist.github.com', NOW + 10 * 86_400, 'b'),
      cookie('linear.app', -1),
      cookie('old.example', NOW - 10),
    ],
    origins: [
      { origin: 'https://app.linear.app', localStorage: [{ name: 't', value: 'secret-ls' }] },
      { origin: 'https://empty.example', localStorage: [] },
    ],
  };

  it('groups hosts into sites and gives each the longest live expiry', () => {
    expect(summarizeStorageState(state, NOW)).toEqual([
      {
        site: 'github.com',
        cookies: 2,
        expiresAt: NOW + 10 * 86_400,
        expired: false,
        pageStorage: false,
      },
      { site: 'linear.app', cookies: 1, expiresAt: null, expired: false, pageStorage: true },
      { site: 'old.example', cookies: 1, expiresAt: null, expired: true, pageStorage: false },
    ]);
  });

  it('never carries a value into the summary', () => {
    const text = JSON.stringify(summarizeStorageState(state, NOW));
    expect(text).not.toContain('secret');
  });
});

describe('withoutSite', () => {
  it('drops the site, its subdomains and its page storage, and nothing else', () => {
    const state = StorageStateSchema.parse({
      cookies: [cookie('.github.com', -1), cookie('api.github.com', -1), cookie('gitlab.com', -1)],
      origins: [
        { origin: 'https://github.com', localStorage: [{ name: 'a', value: 'b' }] },
        { origin: 'https://gitlab.com', localStorage: [{ name: 'a', value: 'b' }] },
      ],
    });
    const result = withoutSite(state, 'github.com');
    expect(result.removedCookies).toBe(2);
    expect(result.removedOrigins).toBe(1);
    expect(result.state.cookies.map((c) => c.domain)).toEqual(['gitlab.com']);
    expect(result.state.origins.map((o) => o.origin)).toEqual(['https://gitlab.com']);
  });
});

describe('StorageStateSchema', () => {
  it('keeps fields Playwright writes that DorkOS does not model', () => {
    const parsed = StorageStateSchema.parse({
      cookies: [{ ...cookie('a.test', -1), partitionKey: 'https://top.test' }],
    });
    expect(parsed.cookies[0]).toHaveProperty('partitionKey', 'https://top.test');
    expect(parsed.origins).toEqual([]);
  });
});
