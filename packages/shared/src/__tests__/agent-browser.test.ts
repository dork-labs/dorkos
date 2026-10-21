import { describe, expect, it } from 'vitest';
import {
  AGENT_BROWSER_SERVER_NAME,
  StorageStateSchema,
  agentBrowserConnection,
  isPlaywrightBrowser,
  unguardableBrowserReason,
  withCloudOriginBlocked,
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

describe('withCloudOriginBlocked', () => {
  const guard = { blockedOrigins: 'cloud.example;*.cloud.example', configFile: '/guard/c.json' };

  it('adds the Cloud block and the guarded config', () => {
    expect(withCloudOriginBlocked(agentBrowserConnection('/s.json'), guard).args).toEqual([
      '-y',
      '@playwright/mcp@0.0.82',
      '--isolated',
      '--headless',
      '--storage-state',
      '/s.json',
      '--blocked-origins',
      'cloud.example;*.cloud.example',
      '--config',
      '/guard/c.json',
    ]);
  });

  it('keeps an operator block beside the Cloud one', () => {
    const connection = {
      transport: 'stdio',
      args: ['@playwright/mcp@0.0.82', '--blocked-origins=ads.example;cloud.example', '--isolated'],
    };
    expect(withCloudOriginBlocked(connection, guard).args).toEqual([
      '@playwright/mcp@0.0.82',
      '--isolated',
      '--blocked-origins',
      'cloud.example;*.cloud.example;ads.example',
      '--config',
      '/guard/c.json',
    ]);
  });

  it('is the same however many times it is applied', () => {
    const once = withCloudOriginBlocked(agentBrowserConnection('/s.json'), guard);
    expect(withCloudOriginBlocked(once, guard)).toEqual(once);
  });

  it('leaves every other server alone', () => {
    const other = { transport: 'stdio', args: ['some-other-mcp', '--config', '/x.json'] };
    expect(withCloudOriginBlocked(other, guard)).toBe(other);
    const remote = { transport: 'http' };
    expect(withCloudOriginBlocked(remote, guard)).toBe(remote);
  });
});

describe('isPlaywrightBrowser', () => {
  it.each([
    { command: 'npx', args: ['-y', '@playwright/mcp@0.0.82'] },
    { command: 'npx', args: ['--package=@playwright/mcp@0.0.82', 'playwright-mcp'] },
    { command: 'node', args: ['/x/node_modules/@playwright/mcp/cli.js'] },
    { command: 'playwright-mcp', args: [] },
    { command: '/usr/local/bin/mcp-server-playwright', args: [] },
  ])('recognises $command $args', (shape) => {
    expect(isPlaywrightBrowser({ transport: 'stdio', ...shape })).toBe(true);
  });

  it('ignores anything else', () => {
    expect(isPlaywrightBrowser({ transport: 'stdio', command: 'npx', args: ['other-mcp'] })).toBe(
      false
    );
    expect(isPlaywrightBrowser({ transport: 'http', args: ['@playwright/mcp'] })).toBe(false);
  });
});

describe('unguardableBrowserReason', () => {
  const base = ['-y', '@playwright/mcp@0.0.82', '--isolated', '--storage-state', '/s.json'];

  it('accepts the browser DorkOS adds', () => {
    expect(unguardableBrowserReason(agentBrowserConnection('/s.json'))).toBeUndefined();
    expect(
      unguardableBrowserReason({ transport: 'stdio', args: [...base, '--browser', 'msedge'] })
    ).toBeUndefined();
  });

  it.each([
    ['--extension'],
    ['--executable-path', '/opt/browser'],
    ['--no-isolated'],
    ['--cdp-endpoint', 'http://127.0.0.1:9222'],
    ['--endpoint=ws://x'],
    ['--user-data-dir', '/p'],
    ['--proxy-server', 'http://proxy:8080'],
    ['--config', '/mine.json'],
    ['--browser', 'firefox'],
    ['--browser=webkit'],
    ['--storage-state=/other.json'],
  ])('refuses %s', (...extra) => {
    expect(
      unguardableBrowserReason({ transport: 'stdio', args: [...base, ...extra] })
    ).toBeTruthy();
  });

  it('refuses a profile on disk and a PLAYWRIGHT_MCP_ variable', () => {
    expect(
      unguardableBrowserReason({ transport: 'stdio', args: base.filter((a) => a !== '--isolated') })
    ).toMatch(/--isolated/);
    expect(
      unguardableBrowserReason({
        transport: 'stdio',
        args: base,
        env: { PLAYWRIGHT_MCP_STORAGE_STATE: '/x.json' },
      })
    ).toMatch(/PLAYWRIGHT_MCP_STORAGE_STATE/);
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

  it('returns the last one when the flag repeats, the one Playwright loads', () => {
    expect(
      agentBrowserStateFileOf({
        transport: 'stdio',
        args: [
          '@playwright/mcp@0.0.82',
          '--storage-state',
          '/first.json',
          '--storage-state=/last.json',
        ],
      })
    ).toBe('/last.json');
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

  it('ignores trailing dots, and stays linear on a long run of dots mid-host', () => {
    expect(hostBelongsToSite('github.com...', 'github.com')).toBe(true);
    // `/\.+$/` backtracked quadratically on a run of dots that is not at the
    // end (CodeQL js/polynomial-redos); a cookie domain comes from a file.
    const host = `a${'.'.repeat(100_000)}b`;
    const started = performance.now();
    expect(hostBelongsToSite(host, 'github.com')).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
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
