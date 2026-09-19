import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StorageState } from '@dorkos/shared/agent-browser';
import {
  WELCOME_PAGE,
  agentBrowserPaths,
  loginStartUrl,
  parseBrowserForgetArgs,
  parseBrowserLoginArgs,
  runBrowserForget,
  runBrowserLogin,
  runBrowserStatus,
} from '../browser-commands.js';
import type { BrowserDeps, OperatorAction } from '../../lib/agent-browser/browser-deps.js';
import { ChromeNotFoundError } from '../../lib/agent-browser/chrome-locator.js';
import { createFakeCdp, type FakeCdp } from '../../lib/agent-browser/__tests__/fake-cdp.js';

const NOW = new Date('2026-09-19T12:00:00Z');
const NOW_S = NOW.getTime() / 1000;
const SECRET = 'do-not-print-me';

let dorkHome: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(tmpdir(), 'dorkos-browser-cmd-'));
  out = [];
  err = [];
});
afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A saved session with values that must never reach the terminal. */
function savedState(): StorageState {
  return {
    cookies: [
      {
        name: 'user_session',
        value: SECRET,
        domain: 'github.com',
        path: '/',
        expires: NOW_S + 86_400 * 30,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'sid',
        value: SECRET,
        domain: '.linear.app',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [{ origin: 'https://linear.app', localStorage: [{ name: 'token', value: SECRET }] }],
  };
}

function writeSaved(state: StorageState = savedState()): string {
  const { stateFile } = agentBrowserPaths(dorkHome);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  return stateFile;
}

function deps(overrides: Partial<BrowserDeps> = {}): BrowserDeps {
  return {
    dorkHome,
    findChrome: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    launchPipe: () => {
      throw new Error('launchPipe not expected in this test');
    },
    spawnPlain: () => {
      throw new Error('spawnPlain not expected in this test');
    },
    waitForOperator: async () => 'enter',
    interactive: true,
    profileLock: () => ({ inUse: false }),
    confirm: async () => true,
    now: () => NOW,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    ...overrides,
  };
}

/** A fake agent browser holding one signed-in cookie. */
function signedInBrowser(): FakeCdp {
  return createFakeCdp({
    'Storage.getCookies': () => ({
      cookies: [
        {
          name: 'user_session',
          value: SECRET,
          domain: 'github.com',
          path: '/',
          expires: NOW_S + 3600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
    }),
    'Target.getTargets': () => ({ targetInfos: [] }),
  });
}

describe('argument parsing', () => {
  it('reads login flags and a start site', () => {
    expect(parseBrowserLoginArgs(['github.com', '--plain'])).toEqual({
      url: 'github.com',
      plain: true,
    });
    expect(() => parseBrowserLoginArgs(['--nope'])).toThrow(/Unknown option for 'browser login'/);
  });

  it('turns a URL into a site name for forget, and wants exactly one target', () => {
    expect(parseBrowserForgetArgs(['https://github.com/login'])).toMatchObject({
      site: 'github.com',
      all: false,
    });
    expect(parseBrowserForgetArgs(['--all', '-y'])).toEqual({ all: true, yes: true });
    expect(() => parseBrowserForgetArgs([])).toThrow(/Name the site/);
    expect(() => parseBrowserForgetArgs(['a.test', '--all'])).toThrow(/not both/);
  });

  it('opens a bare host over https, and the welcome page when nothing is named', () => {
    expect(loginStartUrl('github.com')).toBe('https://github.com');
    expect(loginStartUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(loginStartUrl(undefined)).toBe(WELCOME_PAGE);
  });
});

describe('dorkos browser status', () => {
  it('lists sites and dates, and never a value', async () => {
    writeSaved();
    expect(await runBrowserStatus({ json: false }, deps())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('github.com');
    expect(text).toContain('until 2026-10-19');
    expect(text).toContain('linear.app');
    expect(text).toContain('no end date set');
    expect(text).not.toContain(SECRET);
  });

  it('keeps values out of --json too', async () => {
    writeSaved();
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    expect(await runBrowserStatus({ json: true }, deps())).toBe(0);
    const payload = JSON.parse(written.join(''));
    expect(payload.saved).toBe(true);
    expect(payload.sites.map((s: { site: string }) => s.site)).toEqual([
      'github.com',
      'linear.app',
    ]);
    expect(written.join('')).not.toContain(SECRET);
  });

  it('says how to start when nothing is saved', async () => {
    expect(await runBrowserStatus({ json: false }, deps())).toBe(0);
    expect(out.join('\n')).toContain('dorkos browser login');
  });
});

describe('dorkos browser forget', () => {
  it('takes one site out of the file at once, then out of the profile', async () => {
    const stateFile = writeSaved();
    fs.mkdirSync(agentBrowserPaths(dorkHome).profileDir, { recursive: true });
    const cdp = createFakeCdp({
      'Storage.getCookies': () => ({
        cookies: [
          {
            name: 'user_session',
            value: SECRET,
            domain: 'github.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
          },
        ],
      }),
      'Target.createTarget': () => ({ targetId: 't' }),
      'Target.attachToTarget': () => ({ sessionId: 's' }),
    });
    let launchedWith: string[] = [];
    const code = await runBrowserForget(
      { site: 'github.com', all: false, yes: false },
      deps({
        launchPipe: (_exe, args) => {
          launchedWith = args;
          return cdp;
        },
      })
    );
    expect(code).toBe(0);
    const remaining = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as StorageState;
    expect(remaining.cookies.map((c) => c.domain)).toEqual(['.linear.app']);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(launchedWith).toContain('--headless');
    expect(cdp.calls.some((c) => c.method === 'Network.deleteCookies')).toBe(true);
    expect(out.join('\n')).toContain('Forgot github.com');
  });

  it('warns that an open agent browser would bring the site back', async () => {
    writeSaved();
    fs.mkdirSync(agentBrowserPaths(dorkHome).profileDir, { recursive: true });
    const code = await runBrowserForget(
      { site: 'github.com', all: false, yes: false },
      deps({ profileLock: () => ({ inUse: true, pid: 1 }) })
    );
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('The agent browser is open');
  });

  it('needs a yes before forgetting everything when nobody is at the keyboard', async () => {
    const stateFile = writeSaved();
    expect(await runBrowserForget({ all: true, yes: false }, deps({ interactive: false }))).toBe(1);
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(await runBrowserForget({ all: true, yes: true }, deps({ interactive: false }))).toBe(0);
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

describe('dorkos browser login', () => {
  it('refuses to run without a person at the keyboard', async () => {
    expect(await runBrowserLogin({ plain: false }, deps({ interactive: false }))).toBe(1);
    expect(err.join('\n')).toContain('needs you at the keyboard');
  });

  it('gives the honest missing-Chrome error', async () => {
    const code = await runBrowserLogin(
      { plain: false },
      deps({
        findChrome: () => {
          throw new ChromeNotFoundError(['/Applications/Google Chrome.app']);
        },
      })
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Could not find Google Chrome');
  });

  it('will not open a second copy of an agent browser that is already open', async () => {
    const code = await runBrowserLogin(
      { plain: false },
      deps({ profileLock: () => ({ inUse: true, pid: 77 }) })
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('already open (process 77)');
  });

  it('themes the profile, saves on Enter, lists the sites, and closes Chrome', async () => {
    const cdp = signedInBrowser();
    let launchedWith: string[] = [];
    const code = await runBrowserLogin(
      { url: 'github.com', plain: false },
      deps({
        launchPipe: (_exe, args) => {
          launchedWith = args;
          return cdp;
        },
      })
    );
    expect(code).toBe(0);
    const { profileDir, stateFile } = agentBrowserPaths(dorkHome);
    expect(launchedWith).toEqual([
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://github.com',
    ]);
    expect(fs.existsSync(path.join(profileDir, 'Default', 'Preferences'))).toBe(true);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    const text = out.join('\n');
    expect(text).toContain('Saved sign-ins for 1 site:');
    expect(text).toContain('  github.com');
    expect(text).not.toContain(SECRET);
    expect(cdp.calls.at(-1)!.method).toBe('Browser.close');
  });

  it.each<[OperatorAction, number]>([
    ['closed', 1],
    ['cancelled', 130],
  ])('saves nothing when the operator %s instead of pressing Enter', async (action, expected) => {
    const stateFile = writeSaved();
    const before = fs.readFileSync(stateFile, 'utf8');
    const code = await runBrowserLogin(
      { plain: false },
      deps({ launchPipe: () => signedInBrowser(), waitForOperator: async () => action })
    );
    expect(code).toBe(expected);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
  });

  it('with --plain, runs Chrome with no debugging channel and saves from the profile after it quits', async () => {
    let quit = false;
    let resolveExit!: () => void;
    const exited = new Promise<{ code: number; signal: null }>((resolve) => {
      resolveExit = () => resolve({ code: 0, signal: null });
    });
    let plainArgs: string[] = [];
    let backgroundArgs: string[] = [];
    const code = await runBrowserLogin(
      { plain: true },
      deps({
        spawnPlain: (_exe, args) => {
          plainArgs = args;
          return {
            exited,
            quit: () => {
              quit = true;
              resolveExit();
            },
            kill: () => resolveExit(),
          };
        },
        launchPipe: (_exe, args) => {
          backgroundArgs = args;
          return signedInBrowser();
        },
      })
    );
    expect(code).toBe(0);
    expect(quit).toBe(true);
    expect(plainArgs.some((a) => a.includes('remote-debugging'))).toBe(false);
    expect(backgroundArgs).toContain('--headless');
    expect(out.join('\n')).toContain('Saved with --plain');
  });
});
