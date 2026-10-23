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
