/**
 * @vitest-environment node
 *
 * The protected profile survives a Codex config rebuild that drops the
 * request's profile selection, against the REAL vendored binary.
 *
 * With ChatGPT sign-in, Codex 0.163 resolves workspace routing by rebuilding
 * the thread's config from its session layers with no overrides
 * (`Config::rebuild_with_session_layers`, core/src/config/mod.rs). DorkOS's
 * profile selection travels only in the request's `permissions` field, so the
 * rebuild sees a `[permissions]` table and no `default_permissions`, and every
 * turn failed with "failed to load workspace requirements" (0.133.0).
 *
 * That path needs a real ChatGPT sign-in, which no test here may use. This
 * suite drives its equivalent: `thread/start` and `turn/start` carry the
 * config DorkOS builds as the session layer and NO `permissions` field, so
 * Codex selects the profile from that layer alone, as the rebuild does. Then
 * a shell command inside the sandbox checks the profile Codex really applied:
 * the hidden folders and Claude Code backups stay unreadable, and project
 * writes and network access match the mode.
 *
 * A second suite runs folders Codex reads as globs, and broken worktrees,
 * through the same peer (DOR-4542). It lives here because the Linux
 * `codex-sandbox` job runs this file by name.
 *
 * A throwaway `HOME` and `CODEX_HOME`, no auth, file credential stores, and
 * a loopback fake provider. Skipped by name where no vendored binary exists.
 */
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { minimalGitEnv } from '@dorkos/shared/safe-git';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import {
  codexPermissionProfile,
  codexProtectedConfig,
  type CodexFilePolicy,
} from '../../policy/protected-profile.js';
import { codexInitializeParams } from '../handshake.js';
import { completeHostFixture, FIXTURE_BACKUP_NAME } from './fixtures/complete-protected-home.js';
import { shellControlReturned } from './fixtures/protected-probe.js';
import {
  commandOutput,
  execCall,
  fakeProvider,
  fakeProviderConfig,
  killRawAppServers,
  rawAppServer,
  text,
} from './fixtures/raw-app-server.js';

const BINARY = resolveCodexVendoredBinary();
const MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;

let provider: Awaited<ReturnType<typeof fakeProvider>>;
let base = '';
/** Provider answers for the current row, consumed in order. */
const scripted: Array<(res: http.ServerResponse, body: string) => void> = [];
/** Requests the sandboxed command made to the loopback server. */
let networkHits = 0;
const roots: string[] = [];

const nativeSuite = describe.skipIf(BINARY === null);
nativeSuite('the protected profile without the request’s selection', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    provider = await fakeProvider(scripted, (req, res) => {
      if (!req.url?.startsWith('/net-probe')) return res.writeHead(404).end();
      networkHits += 1;
      res.writeHead(200).end('NET-REACHED');
    });
    base = provider.base;
  });

  afterEach(() => {
    killRawAppServers();
    for (const dir of roots.splice(0))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    scripted.length = 0;
    networkHits = 0;
  });

  afterAll(() => provider.close());

  it.each(MODES)('Codex applies the DorkOS profile at %s from the config alone', async (mode) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-default-perms-')));
    roots.push(root);
    const [home, data, codexHome, account, project] = [
      'home',
      'data',
      'codex-home',
      'claude-account',
      'project',
    ].map((name) => path.join(root, name));
    for (const folder of [home, data, codexHome, account, project])
      fs.mkdirSync(folder!, { recursive: true });
    fs.writeFileSync(path.join(codexHome!, 'config.toml'), fakeProviderConfig(base));
    const policy: CodexFilePolicy = {
      roots: {
        cwd: project!,
        data: data!,
        home: home!,
        accounts: [account!],
        agentFolders: [project!],
        agentHomes: [],
      },
      writable: [project!],
    };
    // Codex 0.163 on Linux refuses Full beside a Claude Code backup (DOR-3965).
    const withBackups = !(mode === 'bypassPermissions' && process.platform === 'linux');
    completeHostFixture(policy, [home!, data!, codexHome!, account!], {
      withoutClaudeBackups: !withBackups,
    });
    const sshKey = path.join(home!, '.ssh', 'authorized_keys');
    fs.writeFileSync(sshKey, 'CANARY-ssh-key');
    // Well-known credential files, denied home-wide, not only in agent folders (DOR-4388).
    const homeSecrets = [
      '.git-credentials',
      '.kube/config',
      '.pypirc',
      '.gnupg/private.key',
      '.vault-token',
    ].map((rel) => path.join(home!, rel));
    for (const file of homeSecrets) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `CANARY-home-secret:${path.basename(file)}`);
    }
    const backups = path.join(home!, '.claude', 'backups');
    const backup = path.join(backups, FIXTURE_BACKUP_NAME);
    if (withBackups) fs.writeFileSync(backup, 'CANARY-claude-backup');
    const written = path.join(project!, 'written-by-sandbox.txt');

    const settings = { permissionMode: mode };
    let missing: string[] = [];
    const config = codexProtectedConfig(project!, policy, settings, (targets) => {
      missing = targets;
    });
    expect(missing).toEqual([]);
    const profile = codexPermissionProfile(settings);
    const files = (config.permissions as Record<string, { filesystem: Record<string, string> }>)[
      profile
    ]!.filesystem;
    expect(files[path.join(home!, '.ssh')]).toBe('deny');
    expect(files[backups]).toBe('deny');

    const codex = rawAppServer(BINARY!, project!, {
      PATH: '/usr/bin:/bin',
      HOME: home!,
      CODEX_HOME: codexHome!,
    });
    await codex.request('initialize', codexInitializeParams(true));
    codex.notify('initialized');
    // No `permissions` field: the profile can only come from the config layer.
    const started = await codex.request<{
      thread: { id: string };
      activePermissionProfile?: { id: string } | null;
    }>('thread/start', {
      cwd: project,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      config,
    });
    expect(started.activePermissionProfile?.id).toBe(profile);

    const quote = (value: string) => JSON.stringify(value);
    let returned = '';
    scripted.push(
      (res) =>
        res.end(
          execCall(
            [
              'printf PROBE-START',
              `cat ${quote(sshKey)}`,
              `cat ${quote(backup)}`,
              ...homeSecrets.map((file) => `cat ${quote(file)} 2>/dev/null`),
              `ls -A ${quote(path.join(home!, '.kube'))} 2>/dev/null | sed 's/^/KUBE:/'`,
              `ls -A ${quote(backups)} 2>/dev/null | sed 's/^/LISTED:/'`,
              `printf sandbox > ${quote(written)}`,
              `curl -s -m 5 ${base}/net-probe`,
              'printf PROBE-END',
            ].join('; ')
          )
        ),
      (res, body) => {
        returned = body;
        res.end(text('probe finished'));
      }
    );
    await codex.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'probe', text_elements: [] }],
      cwd: project,
    });
    const completed = await codex.until('turn/completed');
    expect(completed.params, codex.stderr().slice(-2000)).toMatchObject({
      turn: { status: 'completed' },
    });

    expect(shellControlReturned(returned, 'PROBE-START')).toBe(true);
    expect(shellControlReturned(returned, 'PROBE-END')).toBe(true);
    // Only what the command printed: the request also echoes the command text.
    const output = commandOutput(returned);
    console.info('Codex default-permissions probe', { mode, output });
    expect(returned).not.toContain('CANARY-ssh-key');
    expect(returned).not.toContain('CANARY-claude-backup');
    expect(output).not.toContain('CANARY-home-secret');
    // The file is denied exactly: its folder still lists.
    expect(output).toContain('KUBE:config');
    expect(output).not.toContain('LISTED:');
    expect(fs.existsSync(written)).toBe(mode !== 'default');
    expect(networkHits > 0).toBe(mode === 'bypassPermissions');
    expect(output.includes('NET-REACHED')).toBe(mode === 'bypassPermissions');
    expect(fs.readFileSync(sshKey, 'utf8')).toBe('CANARY-ssh-key');
  });
});

/**
 * Run one shell command in `cwd` under the profile DorkOS renders at `mode`, or
 * under a hand-built `filesystem` table; what it printed.
 */
async function probe(
  root: string,
  cwd: string,
  mode: (typeof MODES)[number] | { filesystem: Record<string, unknown> },
  cmd: string
): Promise<{ output: string; returned: string }> {
  const [home, data, codexHome] = ['home', 'data', 'codex-home'].map((name) =>
    path.join(root, name)
  );
  for (const folder of [home!, data!, codexHome!]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(codexHome!, 'config.toml'), fakeProviderConfig(base));
  const policy: CodexFilePolicy = {
    roots: { cwd, data: data!, home: home!, accounts: [], agentFolders: [cwd], agentHomes: [] },
    writable: [],
  };
  const settings = { permissionMode: typeof mode === 'string' ? mode : 'acceptEdits' };
  const profile = codexPermissionProfile(settings);
  const config =
    typeof mode === 'string'
      ? codexProtectedConfig(cwd, policy, settings)
      : {
          default_permissions: profile,
          permissions: {
            [profile]: {
              extends: ':workspace',
              filesystem: { ':root': 'read', ...mode.filesystem },
              network: { enabled: false },
            },
          },
        };
  const codex = rawAppServer(BINARY!, cwd, {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home!,
    CODEX_HOME: codexHome!,
  });
  await codex.request('initialize', codexInitializeParams(true));
  codex.notify('initialized');
  const started = await codex.request<{
    thread: { id: string };
    activePermissionProfile?: { id: string } | null;
  }>('thread/start', { cwd, approvalPolicy: 'never', approvalsReviewer: 'user', config });
  expect(started.activePermissionProfile?.id).toBe(profile);
  let returned = '';
  scripted.push(
    (res) => res.end(execCall(`printf PROBE-START; ${cmd}; printf PROBE-END`)),
    (res, body) => {
      returned = body;
      res.end(text('probe finished'));
    }
  );
  await codex.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'probe', text_elements: [] }],
    cwd,
  });
  const completed = await codex.until('turn/completed');
  expect(completed.params, codex.stderr().slice(-2000)).toMatchObject({
    turn: { status: 'completed' },
  });
  expect(shellControlReturned(returned, 'PROBE-START')).toBe(true);
  expect(shellControlReturned(returned, 'PROBE-END')).toBe(true);
  return { output: commandOutput(returned), returned };
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * Git files stay protected in folders Codex would once refuse (DOR-4542): a
 * repository named `site [old]`, whose path Codex reads as a glob, and a
 * worktree whose git folder is gone, each at every level. A folder with a
 * backslash is refused, since no glob spelling holds on every platform.
 */
const gitSuite = describe.skipIf(BINARY === null || process.platform === 'win32');
gitSuite('Codex Git files in folders it once refused', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    provider = await fakeProvider(scripted);
    base = provider.base;
  });

  afterEach(() => {
    killRawAppServers();
    for (const dir of roots.splice(0))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    scripted.length = 0;
  });

  afterAll(() => provider.close());

  function tempRoot(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-git-meta-')));
    roots.push(root);
    return root;
  }

  it.each(MODES)(
    'a repository named `site [old]` starts at %s with its Git files protected (Linux: Full only)',
    async (mode) => {
      const root = tempRoot();
      const project = path.join(root, 'site [old]');
      fs.mkdirSync(project);
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
          cwd: project,
          env: minimalGitEnv(),
          stdio: 'pipe',
        });
      git('init', '-q', '--initial-branch=main');
      const control = path.join(project, '.git', 'dor4542-write-control');
      fs.writeFileSync(control, 'original-metadata');
      // Covered only by globs built from this folder's own path.
      fs.writeFileSync(path.join(project, '.git', '.credentials-dor4542'), 'CANARY-git-secret');
      fs.mkdirSync(path.join(project, 'sub'));
      fs.writeFileSync(path.join(project, 'sub', '.env'), 'CANARY-folder-secret');
      const ordinary = path.join(project, 'ordinary.txt');
      fs.writeFileSync(ordinary, 'original-ordinary');
      if (process.platform === 'linux' && mode !== 'bypassPermissions') {
        // Bubblewrap below Full read these secrets through every spelling; see
        // the measuring row below. Refused before any Codex process starts.
        await expect(probe(root, project, mode, 'true')).rejects.toThrow(
          'On Linux, Codex needs Full for a folder with * ? [ ] { } in its path.'
        );
        return;
      }
      const { output, returned } = await probe(
        root,
        project,
        mode,
        [
          `cat ${quote(path.join(project, '.git', '.credentials-dor4542'))}`,
          `cat ${quote(path.join(project, 'sub', '.env'))}`,
          'git status --porcelain >/dev/null && printf PUBLIC-git-status',
          `printf changed > ${quote(control)}`,
          `printf edited > ${quote(ordinary)}`,
        ].join('; ')
      );
      console.info('Codex bracketed-folder probe', { mode, output });
      expect(returned).not.toContain('CANARY-git-secret');
      expect(returned).not.toContain('CANARY-folder-secret');
      expect(output).toContain('PUBLIC-git-status');
      expect(fs.readFileSync(control, 'utf8')).toBe(
        mode === 'bypassPermissions' ? 'changed' : 'original-metadata'
      );
      expect(fs.readFileSync(ordinary, 'utf8')).toBe(
        mode === 'default' ? 'original-ordinary' : 'edited'
      );
    }
  );

  it.each(MODES)('a worktree whose git folder is gone starts at %s', async (mode) => {
    const root = tempRoot();
    const tree = path.join(root, 'tree');
    // From a subfolder: Codex guards a writable root's own `.git`, not one above it.
    const cwd = path.join(tree, 'subfolder');
    fs.mkdirSync(cwd, { recursive: true });
    const pointer = path.join(tree, '.git');
    // Outside every folder a command may write, as a moved main checkout is.
    const before = `gitdir: /dor-4542-gone-${path.basename(root)}/worktrees/tree\n`;
    fs.writeFileSync(pointer, before);
    const ordinary = path.join(cwd, 'ordinary.txt');
    fs.writeFileSync(ordinary, 'original-ordinary');
    const { output } = await probe(
      root,
      cwd,
      mode,
      [
        `printf 'gitdir: /elsewhere' > ${quote(pointer)}`,
        `printf edited > ${quote(ordinary)}`,
      ].join('; ')
    );
    console.info('Codex dangling-worktree probe', { mode, output });
    expect(fs.readFileSync(pointer, 'utf8')).toBe(
      mode === 'bypassPermissions' ? 'gitdir: /elsewhere' : before
    );
    expect(fs.readFileSync(ordinary, 'utf8')).toBe(
      mode === 'default' ? 'original-ordinary' : 'edited'
    );
  });
  it.each(MODES)(
    'refuses a folder with a backslash at %s; its `ab` look-alike starts protected',
    async (mode) => {
      const root = tempRoot();
      const named = { slashed: path.join(root, 'a\\b'), lookalike: path.join(root, 'ab') };
      for (const [name, dir] of Object.entries(named)) {
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'sub', '.env'), `CANARY-${name}`);
        fs.writeFileSync(path.join(dir, 'sub', 'plain.txt'), `PUBLIC-${name}`);
      }
      const policy = (cwd: string): CodexFilePolicy => ({
        roots: {
          cwd,
          data: path.join(root, 'data'),
          home: path.join(root, 'home'),
          accounts: [],
          agentFolders: [cwd],
          agentHomes: [],
        },
        writable: [],
      });
      // Refused before any Codex process starts, so nothing in it can be read.
      expect(() =>
        codexProtectedConfig(named.slashed, policy(named.slashed), { permissionMode: mode })
      ).toThrow(
        'Codex can’t protect a folder with a backslash in its path. Choose another folder.'
      );
      const sub = path.join(named.lookalike, 'sub');
      const { output, returned } = await probe(
        root,
        named.lookalike,
        mode,
        `cat ${quote(path.join(sub, '.env'))}; cat ${quote(path.join(sub, 'plain.txt'))}`
      );
      expect(returned).not.toContain('CANARY-lookalike');
      expect(output).toContain('PUBLIC-lookalike');
    }
  );

  // Why DorkOS refuses: each spelling, measured on this platform's binary.
  it('measures how Codex reads a backslash in a glob key', async () => {
    const root = tempRoot();
    const slashed = path.join(root, 'a\\b');
    const lookalike = path.join(root, 'ab');
    for (const dir of [slashed, lookalike]) {
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sub', '.env'), `CANARY-${path.basename(dir)}`);
    }
    const read = [slashed, lookalike]
      .map((dir) => `cat ${quote(path.join(dir, 'sub', '.env'))}`)
      .join('; ');
    const denied: Record<string, { slashed: boolean; lookalike: boolean }> = {};
    for (const [spelling, key] of [
      ['raw', `${root}/a\\b/**/.env`],
      ['doubled', `${root}/a\\\\b/**/.env`],
    ] as const) {
      // Parsed output: the raw request body JSON-escapes the backslash.
      const { output } = await probe(root, root, { filesystem: { [key]: 'deny' } }, read);
      denied[spelling] = {
        slashed: !output.includes('CANARY-a\\b'),
        lookalike: !output.includes('CANARY-ab'),
      };
    }
    console.info('Codex backslash glob spellings', { platform: process.platform, denied });
    // Measured on macOS (Seatbelt): a raw backslash escapes the next
    // character, so the glob lands on `ab`; doubled, it matches `a\b`. Linux
    // is logged above; its scanner starts from the text before the first
    // glob character as a real folder, so the two platforms disagree.
    if (process.platform === 'darwin')
      expect(denied).toEqual({
        raw: { slashed: false, lookalike: true },
        doubled: { slashed: true, lookalike: false },
      });
  });
  // Why Linux refuses below Full: an escaped glob, and a scoped exact key
  // beside a glob, each measured at Edit on this platform's binary.
  it('measures escaped and scoped keys below Full', async () => {
    const root = tempRoot();
    const bracketed = path.join(root, 'site [old]');
    const plain = path.join(root, 'plain');
    for (const dir of [bracketed, plain]) {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', '.env'), `CANARY-${path.basename(dir)}`);
    }
    const slash = (dir: string) => dir.split(path.sep).join('/');
    const cases = {
      escaped: { [`${slash(root)}/site [[]old]/**/.env`]: 'deny' },
      scoped: {
        [`${slash(plain)}/.git`]: { '.': 'read' },
        [`${slash(plain)}/**/.env`]: 'deny',
      },
    } as const;
    const denied: Record<string, boolean> = {};
    for (const [name, filesystem] of Object.entries(cases)) {
      const dir = name === 'escaped' ? bracketed : plain;
      const { output } = await probe(
        root,
        dir,
        { filesystem },
        `cat ${quote(path.join(dir, 'sub', '.env'))}`
      );
      denied[name] = !output.includes(`CANARY-${path.basename(dir)}`);
    }
    console.info('Codex glob-character keys below Full', { platform: process.platform, denied });
    if (process.platform === 'darwin') expect(denied).toEqual({ escaped: true, scoped: true });
  });
});
