/**
 * @vitest-environment node
 *
 * DOR-4358: on macOS, a deep deny glob (base, `**`, name) makes Codex's
 * Seatbelt refuse removing or renaming every folder under the base. The
 * profile instead names the matching files exactly: the agent's working
 * folders on every render, every other base from a background scan. Every
 * failure keeps the old glob. Made-up files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKGROUND_RESULT_MAX_AGE_MS,
  BACKGROUND_SCAN_EVERY_MS,
  MAX_EXACT_RULE_BYTES,
  exactRuleBytes,
  MAX_FOLDER_WALK,
  expandDeepGlobs,
  explicitDenyKeys,
  resetBackgroundScans,
  settleBackgroundScans,
} from '../policy/expand-deep-globs.js';
import {
  ripgrepScanner,
  type DeepGlobScanner,
  type DeepGlobWatchListener,
} from '../policy/deep-glob-rg.js';
import { codexVendoredRg } from '../policy/hidden-folder-scans.js';

/** The profile keys that refuse exactly `file`, each refusal its own rule (a folder also its contents). */
const denied = Object.assign(
  (file: string, folder = false) =>
    Object.fromEntries(explicitDenyKeys(file, folder)!.map((key) => [key, 'deny' as const])),
  { key: (file: string) => explicitDenyKeys(file, false)![0]! }
);
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';

const SECRET = '.env';

let root: string;
let base: string;

beforeEach(() => {
  resetBackgroundScans();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-deep-globs-')));
  base = path.join(root, 'desk');
  fs.mkdirSync(base);
});
afterEach(async () => {
  await settleBackgroundScans();
  resetBackgroundScans();
  fs.rmSync(root, { recursive: true, force: true });
});

/** As many files from `name` as Codex's rules for them fit in `bytes`. */
function filesWithin(bytes: number, name: (i: number) => string): string[] {
  const files: string[] = [];
  let used = 0;
  for (let i = 0; ; i++) {
    const cost = exactRuleBytes(explicitDenyKeys(name(i), false)![0]!);
    if (used + cost > bytes) return files;
    used += cost;
    files.push(name(i));
  }
}

/** A scanner that answers from fixed results, counts what it was asked, and holds the watch. */
function fakeScanner(
  files: string[] | null,
  options: { later?: () => Promise<string[] | null>; tracked?: string[]; noWatch?: boolean } = {}
) {
  const asked: Array<{ base: string; globs: readonly string[] }> = [];
  let laterCalls = 0;
  let listener: DeepGlobWatchListener | undefined;
  const scanner: DeepGlobScanner = {
    files: (scanBase, globs) => {
      asked.push({ base: scanBase, globs });
      return files;
    },
    filesLater: () => {
      laterCalls += 1;
      return options.later ? options.later() : Promise.resolve(files);
    },
    trackedNpmrc: () => new Set(options.tracked ?? []),
    watch: (_base, next) => {
      if (options.noWatch) return null;
      listener = next;
      return { close: () => (listener = undefined) };
    },
  };
  return {
    scanner,
    asked,
    laterCalls: () => laterCalls,
    /** What the watch would say; `undefined` once it was closed. */
    watch: () => listener,
  };
}

describe('expandDeepGlobs in a working folder (DOR-4358)', () => {
  const darwin = (scanner: DeepGlobScanner) => ({
    platform: 'darwin' as const,
    working: [base],
    scanner,
  });

  it('leaves every other platform as it is', () => {
    const entries = { [`${base}/**/${SECRET}`]: 'deny' } as const;
    for (const platform of ['linux', 'win32'] as const)
      expect(
        expandDeepGlobs(entries, { platform, working: [base], scanner: fakeScanner([]).scanner })
      ).toEqual(entries);
  });

  it('names each matching file exactly and drops the deep glob', () => {
    const { scanner } = fakeScanner([`${base}/${SECRET}`, `${base}/a/b/${SECRET}`]);
    const out = expandDeepGlobs(
      { [`${base}/**/${SECRET}`]: 'deny', [`${root}/other`]: 'read' },
      darwin(scanner)
    );
    expect(out).toEqual({
      ...denied(`${base}/${SECRET}`),
      ...denied(`${base}/a/b/${SECRET}`),
      [`${root}/other`]: 'read',
    });
  });

  it('matches a wildcard within one name only', () => {
    const { scanner } = fakeScanner([
      `${base}/a/site.pem`,
      `${base}/a/site.pem.txt`,
      `${base}/a/b.pemx`,
      `${base}/app/.env.staging.local`,
    ]);
    const out = expandDeepGlobs(
      { [`${base}/**/*.pem`]: 'deny', [`${base}/**/.env.*.local`]: 'deny' },
      darwin(scanner)
    );
    expect(out).toEqual({
      ...denied(`${base}/a/site.pem`),
      ...denied(`${base}/app/.env.staging.local`),
    });
  });

  it('denies a matching folder whole, from its contents rule', () => {
    const { scanner } = fakeScanner([`${base}/x/.dork/plugins/p/plugin.json`]);
    const out = expandDeepGlobs(
      { [`${base}/**/.dork/plugins`]: 'deny', [`${base}/**/.dork/plugins/**`]: 'deny' },
      darwin(scanner)
    );
    expect(out).toEqual(denied(`${base}/x/.dork/plugins`, true));
  });

  it('keeps the glob when the scan cannot finish, so the secret stays protected', () => {
    const entries = { [`${base}/**/${SECRET}`]: 'deny' } as const;
    expect(expandDeepGlobs(entries, darwin(fakeScanner(null).scanner))).toEqual(entries);
  });

  it('keeps the glob for a base that is not a folder, without scanning it', () => {
    const entries = { [`${root}/missing/**/${SECRET}`]: 'deny' } as const;
    const { scanner, asked } = fakeScanner([]);
    expect(
      expandDeepGlobs(entries, { platform: 'darwin', working: [`${root}/missing`], scanner })
    ).toEqual(entries);
    expect(asked).toEqual([]);
  });

  it('keeps the globs when the exact rules would pass what Codex accepts', () => {
    const entries = { [`${base}/**/${SECRET}`]: 'deny' } as const;
    const fits = filesWithin(MAX_EXACT_RULE_BYTES, (i) => `${base}/d${i}/${SECRET}`);
    const fitting = expandDeepGlobs(entries, darwin(fakeScanner(fits).scanner));
    expect(Object.keys(fitting)).toHaveLength(fits.length);
    const over = [...fits, `${base}/one-more/${SECRET}`];
    expect(expandDeepGlobs(entries, darwin(fakeScanner(over).scanner))).toEqual(entries);
  });

  it('never scans node_modules, git objects or a folder already denied whole', () => {
    const { scanner, asked } = fakeScanner([]);
    expandDeepGlobs(
      { [`${base}/**/${SECRET}`]: 'deny', [`${base}/vault`]: 'deny' },
      darwin(scanner)
    );
    expect(asked[0]!.globs).toEqual([
      `**/${SECRET}`,
      '!**/node_modules/**',
      '!**/.git/objects/**',
      '!vault/**',
    ]);
  });

  it('leaves a git-tracked .npmrc readable and denies an untracked one', () => {
    const { scanner } = fakeScanner([`${base}/.npmrc`, `${base}/pkg/.npmrc`], {
      tracked: [`${base}/.npmrc`],
    });
    const out = expandDeepGlobs({ [`${base}/**/.npmrc`]: 'deny' }, darwin(scanner));
    expect(out).toEqual(denied(`${base}/pkg/.npmrc`));
  });

  it('writes each match as a glob for that path alone, so every refusal is its own rule', () => {
    // Codex states a glob key's refusals outright; a plain path is only a gap
    // in what the profile allows.
    expect(explicitDenyKeys('/w/key.pem', false)).toEqual(['/w/[k]ey.pem']);
    expect(explicitDenyKeys('/w/x/.dork/plugins', true)).toEqual([
      '/w/x/.dork/[p]lugins',
      '/w/x/.dork/[p]lugins/**',
    ]);
    expect(explicitDenyKeys('/w/--', false)).toBeUndefined();
  });

  it('spells a match under a folder with glob characters as written, and refuses a backslash', () => {
    const entries = { [`${base}/**/${SECRET}`]: 'deny' } as const;
    const bracketed = fakeScanner([`${base}/site [old]/{a}/${SECRET}`]).scanner;
    expect(expandDeepGlobs(entries, darwin(bracketed))).toEqual({
      [`${base}/site [[]old]/[{]a[}]/[.]env`]: 'deny',
    });
    const slashed = fakeScanner([`${base}/a\\b/${SECRET}`]).scanner;
    expect(expandDeepGlobs(entries, darwin(slashed))).toEqual(entries);
  });
});

describe('expandDeepGlobs outside the working folders: the background scan (DOR-4358)', () => {
  const home = () => path.join(root, 'home');
  const entries = () => ({ [`${home()}/**/.credentials*`]: 'deny' }) as const;
  beforeEach(() => fs.mkdirSync(home()));

  /** Render with a fixed clock. */
  function render(scanner: DeepGlobScanner, at: number) {
    return expandDeepGlobs(entries(), {
      platform: 'darwin',
      working: [base],
      scanner,
      now: () => at,
    });
  }

  it('keeps the glob while the first scan runs, then uses its result', async () => {
    const fake = fakeScanner([`${home()}/acct/.credentials.json`]);
    expect(render(fake.scanner, 0)).toEqual(entries());
    await settleBackgroundScans();
    expect(render(fake.scanner, 1)).toEqual(denied(`${home()}/acct/.credentials.json`));
    expect(fake.laterCalls()).toBe(1);
  });

  it('scans again only after the interval', async () => {
    const fake = fakeScanner([]);
    render(fake.scanner, 0);
    await settleBackgroundScans();
    render(fake.scanner, BACKGROUND_SCAN_EVERY_MS - 1);
    await settleBackgroundScans();
    expect(fake.laterCalls()).toBe(1);
    render(fake.scanner, BACKGROUND_SCAN_EVERY_MS);
    await settleBackgroundScans();
    expect(fake.laterCalls()).toBe(2);
  });

  it('keeps the glob when the scan throws', async () => {
    const fake = fakeScanner(null, { later: () => Promise.reject(new Error('rg crashed')) });
    render(fake.scanner, 0);
    await settleBackgroundScans();
    expect(render(fake.scanner, 1)).toEqual(entries());
  });

  it('keeps the glob when the scan returns more rules than Codex accepts', async () => {
    const many = [
      ...filesWithin(MAX_EXACT_RULE_BYTES, (i) => `${home()}/a${i}/.credentials.json`),
      `${home()}/one-more/.credentials.json`,
    ];
    const fake = fakeScanner(many);
    render(fake.scanner, 0);
    await settleBackgroundScans();
    expect(render(fake.scanner, 1)).toEqual(entries());
  });

  it('never reuses a result that skipped a folder this render no longer denies whole', async () => {
    // Scanned while `vault` was denied whole, so the scan never looked inside it.
    const withVault = { ...entries(), [`${home()}/vault`]: 'deny' } as const;
    const fake = fakeScanner([]);
    const renderWith = (at: number, current: Readonly<Record<string, 'deny'>>) =>
      expandDeepGlobs(current, {
        platform: 'darwin',
        working: [base],
        scanner: fake.scanner,
        now: () => at,
      });
    renderWith(0, withVault);
    await settleBackgroundScans();
    expect(renderWith(1, withVault)).toEqual({ [`${home()}/vault`]: 'deny' });
    // `vault` is no longer denied whole: the old result can't vouch for it.
    expect(renderWith(2, entries())).toEqual(entries());
    await settleBackgroundScans();
    expect(fake.laterCalls(), 'a new scan started at once').toBe(2);
    expect(renderWith(3, entries())).toEqual({});
  });

  it('stops using a result once it is too old and no newer scan has finished', async () => {
    let answer: string[] | null = [];
    const fake = fakeScanner(null, { later: () => Promise.resolve(answer) });
    render(fake.scanner, 0);
    await settleBackgroundScans();
    expect(render(fake.scanner, 1)).toEqual({});
    answer = null;
    render(fake.scanner, BACKGROUND_SCAN_EVERY_MS);
    await settleBackgroundScans();
    expect(render(fake.scanner, BACKGROUND_RESULT_MAX_AGE_MS + 1)).toEqual(entries());
  });

  /** Plant a made-up file under the home and return its path. */
  function plant(relative: string): string {
    const file = path.join(home(), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'made-up');
    return file;
  }

  it('names a file that appears between two scans at the next render, with no new scan', async () => {
    const fake = fakeScanner([]);
    render(fake.scanner, 0);
    await settleBackgroundScans();
    expect(render(fake.scanner, 1)).toEqual({});
    const file = plant('acct/.credentials.json');
    fake.watch()!.change('acct/.credentials.json');
    expect(render(fake.scanner, 2)).toEqual(denied(file));
    expect(fake.laterCalls()).toBe(1);
    // Gone again: no rule is left for it.
    fs.rmSync(file);
    fake.watch()!.change('acct/.credentials.json');
    expect(render(fake.scanner, 3)).toEqual({});
  });

  it('looks through a folder moved in with its contents, and forgets one moved away', async () => {
    const fake = fakeScanner([]);
    render(fake.scanner, 0);
    await settleBackgroundScans();
    const file = plant('moved/in/deep/.credentials.json');
    fake.watch()!.change('moved');
    expect(render(fake.scanner, 1)).toEqual(denied(file));
    fs.rmSync(path.join(home(), 'moved'), { recursive: true });
    fake.watch()!.change('moved');
    expect(render(fake.scanner, 2)).toEqual({});
  });

  it('keeps the glob and scans again when a changed folder is too big to look through', async () => {
    const fake = fakeScanner([]);
    render(fake.scanner, 0);
    await settleBackgroundScans();
    const big = path.join(home(), 'big');
    fs.mkdirSync(big);
    for (let i = 0; i <= MAX_FOLDER_WALK; i++) fs.writeFileSync(path.join(big, `${i}.txt`), '');
    fake.watch()!.change('big');
    expect(render(fake.scanner, 1)).toEqual(entries());
    await settleBackgroundScans();
    expect(render(fake.scanner, 2)).toEqual({});
    expect(fake.laterCalls()).toBe(2);
  });

  it.each([
    ['fails', (listener: DeepGlobWatchListener) => listener.fail()],
    ["can't name a change", (listener: DeepGlobWatchListener) => listener.change(null)],
  ])('keeps the glob and scans again when the watch %s', async (_, lose) => {
    const fake = fakeScanner([]);
    render(fake.scanner, 0);
    await settleBackgroundScans();
    lose(fake.watch()!);
    expect(fake.watch(), 'the lost watch is closed').toBeUndefined();
    expect(render(fake.scanner, 1)).toEqual(entries());
    await settleBackgroundScans();
    expect(render(fake.scanner, 2)).toEqual({});
    expect(fake.laterCalls()).toBe(2);
  });

  it('replays a change seen while a scan runs once that scan lands', async () => {
    let land: (files: string[]) => void = () => undefined;
    const fake = fakeScanner(null, {
      later: () => new Promise<string[]>((resolve) => (land = resolve)),
    });
    render(fake.scanner, 0);
    const file = plant('late/.credentials.json');
    fake.watch()!.change('late/.credentials.json');
    land([]);
    await settleBackgroundScans();
    expect(render(fake.scanner, 1)).toEqual(denied(file));
  });

  it('keeps the glob and never scans when no watch can start', async () => {
    const fake = fakeScanner([], { noWatch: true });
    expect(render(fake.scanner, 0)).toEqual(entries());
    await settleBackgroundScans();
    expect(render(fake.scanner, 1)).toEqual(entries());
    expect(fake.laterCalls()).toBe(0);
  });
});

describe.skipIf(!codexVendoredRg())('the real rg and git (DOR-4358)', () => {
  /** Write a made-up file under `dir`. */
  function plant(dir: string, file: string, text = 'made-up'): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  /** Run git in `base` with a throwaway identity. */
  function git(...args: string[]): void {
    execFileSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=A', ...args], {
      cwd: base,
      stdio: 'ignore',
    });
  }

  it('finds nested secrets, skips node_modules, and spares only an unchanged tracked .npmrc', async () => {
    plant(base, SECRET);
    plant(base, `apps/client/${SECRET}`);
    plant(base, 'node_modules/pkg/test/fixture.pem');
    plant(base, 'node_modules/pkg/.npmrc');
    plant(base, '.npmrc', 'auto-install-peers=true\n');
    plant(base, 'packages/a/.npmrc', 'auto-install-peers=true\n');
    plant(base, 'packages/b/.npmrc', 'untracked\n');
    git('init', '-q');
    git('add', '.npmrc', 'packages/a/.npmrc');
    git('commit', '-q', '-m', 'made-up');
    fs.appendFileSync(path.join(base, 'packages/a/.npmrc'), 'changed-after-commit\n');

    const entries = {
      [`${base}/**/${SECRET}`]: 'deny',
      [`${base}/**/*.pem`]: 'deny',
      [`${base}/**/.npmrc`]: 'deny',
    } as const;
    const render = () => expandDeepGlobs(entries, { platform: 'darwin', working: [base] });
    // Before git's answer (looked up off the turn's path), every .npmrc stays denied.
    expect(render()[denied.key(`${base}/.npmrc`)]).toBe('deny');
    await settleBackgroundScans(base);
    const out = render();
    expect(out).toEqual({
      ...denied(`${base}/${SECRET}`),
      ...denied(`${base}/apps/client/${SECRET}`),
      // Tracked but changed since: a token could have been added, so it stays denied.
      ...denied(`${base}/packages/a/.npmrc`),
      ...denied(`${base}/packages/b/.npmrc`),
    });
  });

  it('never follows a symlink out of the folder it scans', async () => {
    const outside = path.join(root, 'outside');
    plant(outside, SECRET);
    fs.symlinkSync(outside, path.join(base, 'link'));
    fs.symlinkSync(path.join(outside, SECRET), path.join(base, 'linked.env'));
    expect(ripgrepScanner.files(base, [`**/${SECRET}`, '**/linked.env'])).toEqual([]);
    expect(await ripgrepScanner.filesLater(base, [`**/${SECRET}`, '**/linked.env'])).toEqual([]);
  });

  it('keeps the glob over a folder the person owns but has shut by its mode bits (Must 2)', async () => {
    // The agent runs as this person and could `chmod` it open, so "the server
    // can't read it" says nothing about what the agent can.
    plant(base, `locked/${SECRET}`);
    const locked = path.join(base, 'locked');
    fs.chmodSync(locked, 0o000);
    try {
      const entries = { [`${base}/**/${SECRET}`]: 'deny' } as const;
      expect(expandDeepGlobs(entries, { platform: 'darwin', working: [base] })).toEqual(entries);
      expect(ripgrepScanner.files(base, [`**/${SECRET}`])).toBeNull();
      expect(await ripgrepScanner.filesLater(base, [`**/${SECRET}`])).toBeNull();
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('names a secret whose folder has a newline in its name', () => {
    plant(base, `odd\nname/${SECRET}`);
    const out = expandDeepGlobs(
      { [`${base}/**/${SECRET}`]: 'deny' },
      { platform: 'darwin', working: [base] }
    );
    expect(out).toEqual(denied(`${base}/odd\nname/${SECRET}`));
  });
});

describe.skipIf(!codexVendoredRg())('the macOS profile (DOR-4358)', () => {
  const realPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

  /** Render the profile as macOS would, over a real throwaway tree. */
  function renderOnMac(permissionMode: string): Record<string, string> {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const home = path.join(root, 'home');
    const data = path.join(home, '.dork');
    // Every base exists: a missing one keeps its glob on purpose (nothing to lock yet).
    for (const dir of [
      data,
      path.join(home, '.ssh'),
      path.join(home, '.claude'),
      path.join(base, 'apps/client/src'),
    ])
      fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(base, 'apps', SECRET), 'made-up');
    const roots = {
      cwd: base,
      data,
      home,
      accounts: [path.join(home, '.claude')],
      agentFolders: [base],
      agentHomes: [],
    };
    const config = codexProtectedConfig(base, { roots, writable: [] }, { permissionMode });
    const profiles = config.permissions as Record<string, { filesystem: Record<string, string> }>;
    return profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
  }

  it.each(['acceptEdits', 'bypassPermissions'])(
    'at %s, the agent folder is free at once, and the rest once the background scan lands',
    async (permissionMode) => {
      const first = renderOnMac(permissionMode);
      const deep = (files: Record<string, string>) =>
        Object.keys(files).filter((key) => key.includes('/**/'));
      // The working folder is scanned now: no deep rule under it, its secret named exactly.
      expect(deep(first).filter((key) => key.startsWith(`${base}/`))).toEqual([]);
      expect(first[denied.key(`${base}/apps/${SECRET}`)]).toBe('deny');
      // The home folder keeps its globs until its scan has finished...
      expect(deep(first).some((key) => key.startsWith(`${root}/home/`))).toBe(true);
      await settleBackgroundScans();
      // ...then no rule left locks every folder below it.
      expect(deep(renderOnMac(permissionMode))).toEqual([]);
    }
  );

  it.each(['acceptEdits', 'bypassPermissions'])(
    'at %s, the known sign-ins are denied without a scan, and known_hosts can be read',
    (permissionMode) => {
      const files = renderOnMac(permissionMode);
      const home = path.join(root, 'home');
      expect(files[`${home}/.codex/auth.json`]).toBe('deny');
      expect(files[`${home}/.local/share/opencode/auth.json`]).toBe('deny');
      expect(files[`${home}/.dork/runtimes/codex/credits/auth.json`]).toBe('deny');
      expect(files[`${home}/.ssh`]).toBe('deny');
      expect(files[`${home}/.ssh/known_hosts`]).toBe('read');
    }
  );
});
