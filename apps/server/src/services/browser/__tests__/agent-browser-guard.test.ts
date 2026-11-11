import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentBrowserConnection } from '@dorkos/shared/agent-browser';
import {
  chromeHostResolverRules,
  cloudOriginEntries,
  playwrightBlockedOrigins,
} from '@dorkos/shared/cloud-origin';
import {
  guardAgentBrowsers,
  scrubAgentBrowserState,
  scrubAgentBrowserStateAtStartup,
} from '../agent-browser-guard.js';

const entries = cloudOriginEntries();
let dorkHome: string;
let stateFile: string;

function cookie(domain: string, value = 'secret') {
  return {
    name: 'session',
    value,
    domain,
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };
}

/** A session saved before DOR-3196: a Cloud sign-in beside another site's. */
function seedOldState(file = stateFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      cookies: [
        cookie('cloud.dorkos.ai', 'cloud-secret'),
        cookie('.dorkos.ai'),
        cookie('github.com'),
      ],
      origins: [
        { origin: 'https://cloud.dorkos.ai', localStorage: [{ name: 't', value: 'cloud-secret' }] },
        { origin: 'https://github.com', localStorage: [{ name: 't', value: 'kept' }] },
      ],
    })
  );
}

function readState(file = stateFile) {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as {
    cookies: Array<{ domain: string }>;
    origins: Array<{ origin: string }>;
  };
}

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(tmpdir(), 'dorkos-browser-guard-'));
  stateFile = path.join(dorkHome, 'browser', 'storage-state.json');
});
afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('scrubAgentBrowserState', () => {
  it('loads an older saved session with no Cloud cookie or page storage', () => {
    seedOldState();
    expect(scrubAgentBrowserState(stateFile, { entries, owned: true })).toBe('scrubbed');
    const state = readState();
    expect(state.cookies.map((c) => c.domain)).toEqual(['github.com']);
    expect(state.origins.map((o) => o.origin)).toEqual(['https://github.com']);
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain('cloud-secret');
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it('leaves a clean session untouched', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const raw = JSON.stringify({ cookies: [cookie('github.com')], origins: [] });
    fs.writeFileSync(stateFile, raw);
    expect(scrubAgentBrowserState(stateFile, { entries, owned: true })).toBe('clean');
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(raw);
  });

  it('scrubs a file DorkOS’s schema would reject, since Playwright would still load it', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ cookies: [{ domain: 'cloud.dorkos.ai' }] }));
    expect(scrubAgentBrowserState(stateFile, { entries, owned: true })).toBe('scrubbed');
    expect(readState().cookies).toEqual([]);
  });

  it('refuses, and never edits, a Cloud sign-in in a file that is not DorkOS’s own', () => {
    const elsewhere = path.join(dorkHome, 'elsewhere.json');
    seedOldState(elsewhere);
    const before = fs.readFileSync(elsewhere, 'utf8');
    expect(scrubAgentBrowserState(elsewhere, { entries, owned: false })).toBe('refused');
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe(before);
  });

  it('cleans the saved session at startup', () => {
    seedOldState();
    expect(scrubAgentBrowserStateAtStartup(dorkHome)).toBe('scrubbed');
    expect(readState().cookies.map((c) => c.domain)).toEqual(['github.com']);
  });
});

describe('scrubAgentBrowserState and DorkOS’s own sign-in (DOR-3957)', () => {
  const appHosts = ['localhost', 'mac.lan', '192.168.1.20', '[2001:db8::1]', 'tunnel.example'];

  /** A made-up DorkOS session on every name DorkOS answers to, beside another site's. */
  function seedDorkosSession(file = stateFile): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        cookies: [
          ...[
            'localhost',
            '127.0.0.1',
            '[::1]',
            'mac.lan',
            '.lan',
            '192.168.1.20',
            '[2001:db8::1]',
            'tunnel.example',
          ].map((domain) => cookie(domain, 'fake-dorkos-session')),
          cookie('github.com'),
        ],
        origins: [
          { origin: 'http://localhost:4242', localStorage: [{ name: 't', value: 'fake-dorkos' }] },
          { origin: 'https://tunnel.example', localStorage: [{ name: 't', value: 'fake-dorkos' }] },
          { origin: 'https://github.com', localStorage: [{ name: 't', value: 'kept' }] },
        ],
      })
    );
  }

  it('drops every DorkOS cookie and page storage, on any port, and keeps other sites', () => {
    seedDorkosSession();
    expect(scrubAgentBrowserState(stateFile, { entries, appHosts, owned: true })).toBe('scrubbed');
    const state = readState();
    expect(state.cookies.map((c) => c.domain)).toEqual(['github.com']);
    expect(state.origins.map((o) => o.origin)).toEqual(['https://github.com']);
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain('fake-dorkos');
  });

  it('purges a DorkOS session an older version saved, at startup, with this server’s own list', () => {
    seedDorkosSession();
    expect(scrubAgentBrowserStateAtStartup(dorkHome)).toBe('scrubbed');
    const state = readState();
    expect(state.cookies.map((c) => c.domain)).not.toContain('localhost');
    expect(state.cookies.map((c) => c.domain)).not.toContain('127.0.0.1');
    expect(state.cookies.map((c) => c.domain)).toContain('github.com');
  });

  it('leaves out a browser whose own session file holds a DorkOS sign-in, and never edits it', () => {
    const elsewhere = path.join(dorkHome, 'elsewhere.json');
    seedDorkosSession(elsewhere);
    const before = fs.readFileSync(elsewhere, 'utf8');
    const warn = vi.fn();
    const guarded = guardAgentBrowsers(
      { browser: agentBrowserConnection(elsewhere) },
      { dorkHome, entries, appHosts, logger: { warn } }
    );
    expect(guarded).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DorkOS or DorkOS Cloud sign-ins'));
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe(before);
  });

  it('strips a DorkOS cookie on its own, with no page storage beside it', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        cookies: [cookie('localhost', 'fake-dorkos-session'), cookie('github.com')],
        origins: [],
      })
    );
    expect(scrubAgentBrowserState(stateFile, { entries, appHosts, owned: true })).toBe('scrubbed');
    expect(readState().cookies.map((c) => c.domain)).toEqual(['github.com']);
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain('fake-dorkos-session');

    // A file that is not DorkOS's own, with only the cookie, is refused for it.
    const elsewhere = path.join(dorkHome, 'cookie-only.json');
    fs.writeFileSync(
      elsewhere,
      JSON.stringify({ cookies: [cookie('127.0.0.1', 'fake-dorkos-session')], origins: [] })
    );
    expect(scrubAgentBrowserState(elsewhere, { entries, appHosts, owned: false })).toBe('refused');
  });

  it('cleans the session on every load before the browser starts', () => {
    seedDorkosSession();
    guardAgentBrowsers(
      { browser: agentBrowserConnection(stateFile) },
      { dorkHome, entries, appHosts }
    );
    expect(readState().cookies.map((c) => c.domain)).toEqual(['github.com']);
  });
});

describe('guardAgentBrowsers', () => {
  it('blocks the Cloud origin and cleans the session on every load', () => {
    seedOldState();
    const guarded = guardAgentBrowsers(
      { browser: agentBrowserConnection(stateFile) },
      { dorkHome, entries }
    );
    const args = guarded.browser!.args;
    expect(args[args.indexOf('--blocked-origins') + 1]).toBe(playwrightBlockedOrigins(entries));
    const configFile = args[args.indexOf('--config') + 1]!;
    expect(configFile).toBe(path.join(dorkHome, 'browser', 'agent-browser-guard.json'));
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({
      browser: {
        launchOptions: { args: [`--host-resolver-rules=${chromeHostResolverRules(entries)}`] },
      },
    });
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    expect(readState().cookies.map((c) => c.domain)).toEqual(['github.com']);
  });

  it.each([
    ['its own config', ['--config', '/mine.json']],
    ['a browser it attaches to', ['--cdp-endpoint', 'http://127.0.0.1:9222']],
    ['the operator’s own Chrome', ['--extension']],
    ['a second saved session', ['--storage-state=/other.json']],
  ])('leaves out a browser with %s, and never touches its session', (_label, extra) => {
    seedOldState();
    const before = fs.readFileSync(stateFile, 'utf8');
    const connection = agentBrowserConnection(stateFile);
    connection.args.push(...extra);
    const warn = vi.fn();
    const guarded = guardAgentBrowsers(
      { browser: connection },
      { dorkHome, entries, logger: { warn } }
    );
    expect(guarded).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
  });

  it('leaves out a browser whose session holds a Cloud sign-in it may not edit', () => {
    const elsewhere = path.join(dorkHome, 'elsewhere.json');
    seedOldState(elsewhere);
    const warn = vi.fn();
    const guarded = guardAgentBrowsers(
      { browser: agentBrowserConnection(elsewhere), other: { transport: 'http' } },
      { dorkHome, entries, logger: { warn } }
    );
    expect(Object.keys(guarded)).toEqual(['other']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes other servers through, and the same object when there is no browser', () => {
    const servers = { other: { transport: 'stdio', args: ['some-mcp'] } };
    expect(guardAgentBrowsers(servers, { dorkHome, entries })).toBe(servers);
  });

  it('starts an empty session when none is saved yet', () => {
    const guarded = guardAgentBrowsers(
      { browser: agentBrowserConnection(stateFile) },
      { dorkHome, entries }
    );
    expect(guarded.browser).toBeDefined();
    expect(readState()).toEqual({ cookies: [], origins: [] });
  });
});

// DOR-4136: nothing an agent does in a browser is saved back to the session
// every later agent browser starts from. The agent's browser runs isolated, in
// memory, loading the saved session once; the server's only writes to that
// file remove sign-ins or create an empty one, never add a cookie.
describe('an agent browser session is never saved back (DOR-4136)', () => {
  it('starts every agent browser isolated, from one saved session, with no profile on disk', () => {
    const guarded = guardAgentBrowsers(
      { browser: agentBrowserConnection(stateFile) },
      { dorkHome, entries }
    );
    const args = guarded.browser!.args;
    expect(args).toContain('--isolated');
    expect(args.filter((arg) => arg.startsWith('--storage-state'))).toHaveLength(1);
    for (const flag of ['--user-data-dir', '--no-isolated', '--cdp-endpoint', '--extension'])
      expect(
        args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
        flag
      ).toBe(false);
  });

  it.each([
    ['a profile on disk', ['--user-data-dir', '/tmp/made-up-profile']],
    ['no isolation', ['--no-isolated']],
  ])('leaves out a browser that would keep its session: %s', (_label, extra) => {
    const connection = agentBrowserConnection(stateFile);
    connection.args.push(...extra);
    const guarded = guardAgentBrowsers(
      { browser: connection },
      { dorkHome, entries, logger: { warn: vi.fn() } }
    );
    expect(guarded).toEqual({});
  });

  it('a cookie set during one agent session is not in the next session’s saved state', () => {
    seedOldState();
    guardAgentBrowsers({ browser: agentBrowserConnection(stateFile) }, { dorkHome, entries });
    const firstStart = fs.readFileSync(stateFile, 'utf8');
    // The agent's browser sets a cookie in its in-memory context. Isolated, it
    // writes nothing back, so the next start reads the same file.
    const inMemory = [...readState().cookies, cookie('made-up-attacker.example', 'planted')];
    expect(inMemory).toHaveLength(2);
    guardAgentBrowsers({ browser: agentBrowserConnection(stateFile) }, { dorkHome, entries });
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(firstStart);
    expect(readState().cookies.map((c) => c.domain)).toEqual(['github.com']);
  });

  it('the server’s own pass over the saved session only ever takes cookies away', () => {
    seedOldState();
    const before = readState().cookies.map((c) => c.domain);
    scrubAgentBrowserState(stateFile, { entries, appHosts: ['localhost'], owned: true });
    const after = readState().cookies.map((c) => c.domain);
    expect(after.every((domain) => before.includes(domain))).toBe(true);
    expect(after.length).toBeLessThan(before.length);
  });
});
