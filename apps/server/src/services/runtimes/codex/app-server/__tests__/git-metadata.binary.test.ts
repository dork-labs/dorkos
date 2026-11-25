/**
 * @vitest-environment node
 *
 * Git files stay protected in folders Codex would once refuse (DOR-4542),
 * against the REAL vendored binary: a repository named `site [old]`, whose
 * path Codex reads as a glob, and a worktree whose git folder is gone. Each
 * starts at every level. Below Full a command can't change `.git`; at every
 * level the secret files inside it and in the folder stay unreadable.
 *
 * A throwaway `HOME` and `CODEX_HOME`, no auth, file credential stores, and a
 * loopback fake provider: no network, no spend. The profile comes from the
 * config layer, as in `default-permissions.binary.test.ts`. Skipped by name
 * where no vendored binary exists.
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
const scripted: Array<(res: http.ServerResponse, body: string) => void> = [];
const roots: string[] = [];

/** Run one shell command in `cwd` under the profile DorkOS renders at `mode`; its output. */
async function probe(
  root: string,
  cwd: string,
  mode: (typeof MODES)[number],
  cmd: string
): Promise<{ output: string; returned: string }> {
  const [home, data, codexHome] = ['home', 'data', 'codex-home'].map((name) =>
    path.join(root, name)
  );
  for (const folder of [home!, data!, codexHome!]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(codexHome!, 'config.toml'), fakeProviderConfig(provider.base));
  const policy: CodexFilePolicy = {
    roots: { cwd, data: data!, home: home!, accounts: [], agentFolders: [cwd], agentHomes: [] },
    writable: [],
  };
  const settings = { permissionMode: mode };
  const config = codexProtectedConfig(cwd, policy, settings);
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
  expect(started.activePermissionProfile?.id).toBe(codexPermissionProfile(settings));
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

const nativeSuite = describe.skipIf(BINARY === null || process.platform === 'win32');
nativeSuite('Codex Git files in folders it once refused', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    provider = await fakeProvider(scripted);
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
    'a repository named `site [old]` starts at %s with its Git files protected',
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
});
