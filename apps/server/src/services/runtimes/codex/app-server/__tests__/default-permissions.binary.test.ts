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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { minimalGitEnv } from '@dorkos/shared/safe-git';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import {
  codexPermissionProfile,
  codexProtectedConfig,
  type CodexFilePolicy,
} from '../../policy/protected-profile.js';
import { resetBackgroundScans, settleBackgroundScans } from '../../policy/expand-deep-globs.js';
import { codexVendoredRg } from '../../policy/hidden-folder-scans.js';
import {
  forgetSecretFileRenders,
  setSecretFileActivity,
  type SecretFileActivityEntry,
} from '../../policy/secret-file-activity.js';
import { codexShellEnv } from '../../transport/shell-env.js';
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

/** Every process under `pid`, by PID only (no command lines are read). */
function descendants(pid: number): number[] {
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    let children: number[] = [];
    try {
      children = execFileSync('pgrep', ['-P', String(queue.pop())], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map(Number);
    } catch {
      // pgrep exits 1 when there are none.
    }
    found.push(...children);
    queue.push(...children);
  }
  return found;
}

/**
 * Count the processes the app-server starts from now on, and kill them all by
 * PID once `limitMs` passes or more than 40 are running at once.
 */
function watchChildren(rootPid: number, limitMs: number) {
  const before = new Set(descendants(rootPid));
  const started = Date.now();
  let peak = 0;
  let killed = false;
  const timer = setInterval(() => {
    const extra = descendants(rootPid).filter((pid) => !before.has(pid));
    peak = Math.max(peak, extra.length);
    if (Date.now() - started <= limitMs && extra.length <= 40) return;
    killed = true;
    for (const pid of extra)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
  }, 100);
  return {
    stop() {
      clearInterval(timer);
      return { peak, killed };
    },
  };
}

/**
 * The first executable `name` on PATH outside this checkout, or `undefined`.
 * CI's pnpm sits in its setup action's own `node_modules/.bin`, so only the
 * checkout's package bins are skipped.
 */
function findOnPath(name: string): string | undefined {
  const checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir || dir === checkout || dir.startsWith(`${checkout}/`)) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      continue;
    }
    // A Corepack shim fetches pnpm on first use: never run one here.
    return fs.realpathSync(file).includes('corepack') ? undefined : file;
  }
  return undefined;
}

/** The version a pnpm install says it is, from its own package.json, without running it. */
function ownVersion(pnpm: string): string | undefined {
  try {
    const manifest = path.join(path.dirname(path.dirname(fs.realpathSync(pnpm))), 'package.json');
    return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

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
  // DOR-4358, macOS only: the profile names each secret file exactly, so
  // folders without one can be removed and renamed, while the named files stay
  // shut. Made-up files, no network, no spend.
  // Registered only on macOS: the Linux job requires every row it runs to pass,
  // and counts a skipped one against that.
  (process.platform === 'darwin' ? describe : () => undefined)(
    'on macOS, secret files are named exactly (DOR-4358)',
    () => {
      const realPlatform = process.platform;
      const nodeBin = path.dirname(process.execPath);
      let lines: SecretFileActivityEntry[] = [];

      beforeAll(() => {
        // Find Codex's `rg` on the real platform first: the lookup is remembered,
        // and the Linux control below renders as another platform.
        codexVendoredRg();
      });
      beforeEach(() => {
        lines = [];
        resetBackgroundScans();
        forgetSecretFileRenders();
        setSecretFileActivity((entry) => lines.push(entry));
      });
      afterEach(async () => {
        Object.defineProperty(process, 'platform', { value: realPlatform });
        setSecretFileActivity(undefined);
        await settleBackgroundScans();
        resetBackgroundScans();
      });

      /** A throwaway home with the project under it, as a real checkout sits. */
      function macFixture(extraPath: string[] = []) {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mac-exact-')));
        roots.push(root);
        const home = path.join(root, 'home');
        const project = path.join(home, 'code', 'repo');
        const codexHome = path.join(root, 'codex-home');
        const data = path.join(root, 'data');
        const account = path.join(root, 'claude-account');
        for (const dir of [project, codexHome, data, account, path.join(home, '.ssh')])
          fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(codexHome, 'config.toml'), fakeProviderConfig(base));
        const policy: CodexFilePolicy = {
          roots: {
            cwd: project,
            data,
            home,
            accounts: [account],
            agentFolders: [project],
            agentHomes: [],
          },
          writable: [project],
        };
        const env = {
          PATH: [nodeBin, ...extraPath, '/usr/bin', '/bin'].join(':'),
          HOME: home,
          CODEX_HOME: codexHome,
        };
        return { root, home, project, codexHome, policy, env };
      }

      /**
       * The thread config a turn loads with: the profile rendered as production
       * renders it (the home's background scan landed), plus the shell env.
       */
      async function threadConfig(
        fx: ReturnType<typeof macFixture>,
        mode: string,
        sessionId = 'mac-chat',
        platform: NodeJS.Platform = 'darwin'
      ) {
        const settings = { permissionMode: mode };
        Object.defineProperty(process, 'platform', { value: platform });
        try {
          codexProtectedConfig(fx.project, fx.policy, settings, undefined, sessionId);
          await settleBackgroundScans();
          const config = codexProtectedConfig(
            fx.project,
            fx.policy,
            settings,
            undefined,
            sessionId
          );
          return {
            ...config,
            shell_environment_policy: { set: codexShellEnv({ agentTokenEnv: {} }, sessionId) },
          };
        } finally {
          Object.defineProperty(process, 'platform', { value: realPlatform });
        }
      }

      /** One Codex app-server whose turns each run one shell command in a new thread. */
      async function macCodex(fx: ReturnType<typeof macFixture>) {
        const codex = rawAppServer(BINARY!, fx.project, fx.env);
        await codex.request('initialize', codexInitializeParams(true));
        codex.notify('initialized');
        let turns = 0;
        return {
          pid: codex.pid,
          /** Run `cmd` in a new thread loaded with `config`; what the command printed. */
          async run(config: Record<string, unknown>, cmd: string): Promise<string> {
            const started = await codex.request<{ thread: { id: string } }>('thread/start', {
              cwd: fx.project,
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              config,
            });
            let returned = '';
            scripted.push(
              // The end marker is printed in two halves, so a refused command, whose
              // text the output echoes, can't pass for one that ran.
              (res) => res.end(execCall(`${cmd}; printf MAC-ROW-; printf DONE`, 30_000)),
              (res, body) => {
                returned = body;
                res.end(text('done'));
              }
            );
            await codex.request('turn/start', {
              threadId: started.thread.id,
              input: [{ type: 'text', text: 'probe', text_elements: [] }],
              cwd: fx.project,
            });
            turns += 1;
            const completed = await codex.until('turn/completed', 90_000, turns);
            expect(completed.params, codex.stderr().slice(-2000)).toMatchObject({
              turn: { status: 'completed' },
            });
            const output = commandOutput(returned);
            expect(output, codex.stderr().slice(-2000)).toContain('MAC-ROW-DONE');
            return output;
          },
        };
      }

      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      // A fixture teardown as the client tests do it (`fs.rmSync`). Codex refuses
      // an `rm -rf` command line before it runs, so `rm` can't show the sandbox.
      const del = `node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" 2>/dev/null`;

      it.each(['acceptEdits', 'bypassPermissions'])(
        'at %s, a .env made in one turn is shut in the next, with one Activity line',
        async (mode) => {
          const fx = macFixture();
          const codex = await macCodex(fx);
          const made = path.join(fx.project, 'app', '.env');
          fs.mkdirSync(path.dirname(made));
          // Turn 1 makes the file; the next render must cover it.
          await codex.run(await threadConfig(fx, mode), `printf CANARY-turn-one > ${quote(made)}`);
          expect(fs.readFileSync(made, 'utf8')).toBe('CANARY-turn-one');
          expect(lines).toEqual([]);
          // Turn 2 loads a re-rendered profile, as the thread loader does on every turn.
          const second = await codex.run(
            await threadConfig(fx, mode),
            `cat ${quote(made)} 2>/dev/null; printf ' READ-DONE'`
          );
          expect(second).toContain('READ-DONE');
          expect(second).not.toContain('CANARY-turn-one');
          expect(lines.map((line) => line.files)).toEqual([[made]]);
          expect(JSON.stringify(lines)).not.toContain('CANARY');
        }
      );

      it.each(['acceptEdits', 'bypassPermissions'])(
        'at %s, a named secret stays shut and in place, and folders without one move freely',
        async (mode) => {
          const fx = macFixture();
          const p = (rel: string) => path.join(fx.project, rel);
          const secret = p('deep/parent/.env');
          const bracketed = p('site [old]/.env');
          for (const file of [secret, bracketed, p('a/b/c/key.pem')]) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'CANARY-secret');
          }
          fs.mkdirSync(p('deep/free'), { recursive: true });
          const hosts = path.join(fx.home, '.ssh', 'known_hosts');
          fs.writeFileSync(hosts, 'example.com ssh-ed25519 PUBLIC-host-key\n');
          fs.writeFileSync(path.join(fx.home, '.ssh', 'id_made_up'), 'CANARY-ssh-key');
          fs.writeFileSync(
            path.join(fx.home, '.npmrc'),
            '//registry.example/:_authToken=CANARY-npm'
          );
          fs.writeFileSync(p('.npmrc'), 'PUBLIC-tracked-npmrc=true\n');
          fs.mkdirSync(p('packages/b'), { recursive: true });
          fs.writeFileSync(p('packages/b/.npmrc'), 'CANARY-untracked-npmrc=true\n');
          const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=A', ...args], {
              cwd: fx.project,
              stdio: 'ignore',
              env: {
                PATH: '/usr/bin:/bin',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
              },
            });
          git('init', '-q');
          git('add', '.npmrc');
          git('commit', '-q', '-m', 'made-up');
          const codex = await macCodex(fx);
          const out = await codex.run(
            await threadConfig(fx, mode),
            [
              // Row 2: the file present at render.
              `cat deep/parent/.env 2>/dev/null; cat ${quote('site [old]/.env')} 2>/dev/null; cat a/b/c/key.pem 2>/dev/null`,
              'mv deep/parent/.env deep/parent/x 2>/dev/null && echo FILE-MOVED || echo FILE-REFUSED',
              'mv deep/parent deep/moved 2>/dev/null && echo PARENT-MOVED || echo PARENT-REFUSED',
              'mv deep deep2 2>/dev/null && echo GRANDPARENT-MOVED || echo GRANDPARENT-REFUSED',
              'mv a a2 2>/dev/null && echo THIRD-MOVED || echo THIRD-REFUSED',
              'ln deep/parent/.env hard-link 2>/dev/null && echo LINK-MADE || echo LINK-REFUSED',
              'cat hard-link 2>/dev/null',
              'unlink deep/parent/.env 2>/dev/null && echo UNLINK-ALLOWED || echo UNLINK-REFUSED',
              // Row 3: folders with no secret file, beside one and far from one.
              `${del} deep/free; [ ! -e deep/free ] && echo SIBLING-REMOVED || echo SIBLING-KEPT`,
              `${del} deep; echo TREE-ATTEMPTED`,
              `mkdir -p fx/model && echo x > fx/model/x.ts && ${del} fx; [ ! -e fx ] && echo TEARDOWN-OK || echo TEARDOWN-FAIL`,
              'mkdir -p m1/m2 && mv m1 m3 2>/dev/null && echo RENAME-OK || echo RENAME-FAIL',
              // Row 4: known_hosts reads and never writes; the key beside it stays shut.
              'cat "$HOME/.ssh/known_hosts" 2>/dev/null',
              'echo x >> "$HOME/.ssh/known_hosts" 2>/dev/null && echo HOSTS-WRITTEN || echo HOSTS-NO-WRITE',
              'cat "$HOME/.ssh/id_made_up" "$HOME/.npmrc" 2>/dev/null',
              // The tracked project .npmrc reads; an untracked one stays shut.
              'cat .npmrc packages/b/.npmrc 2>/dev/null',
              'printf "USERCONFIG:%s\\n" "$NPM_CONFIG_USERCONFIG"',
            ].join('; ')
          );
          console.info('DOR-4358 macOS exact-deny probe', { mode, out });
          expect(out).not.toContain('CANARY');
          for (const marker of [
            'FILE-REFUSED',
            'PARENT-REFUSED',
            'GRANDPARENT-REFUSED',
            'THIRD-REFUSED',
            'UNLINK-REFUSED',
            'TREE-ATTEMPTED',
            'SIBLING-REMOVED',
            'TEARDOWN-OK',
            'RENAME-OK',
            'PUBLIC-host-key',
            'HOSTS-NO-WRITE',
            'PUBLIC-tracked-npmrc',
            'USERCONFIG:/dev/null',
          ])
            expect(out, marker).toContain(marker);
          expect(out).toContain('LINK-REFUSED');
          // Still there, as planted, seen from outside the sandbox: a refused
          // command alone doesn't prove that, and a check from inside it depends
          // on whether the sandbox lets the shell look.
          for (const file of [secret, bracketed, p('a/b/c/key.pem')])
            expect(fs.readFileSync(file, 'utf8'), file).toBe('CANARY-secret');
          expect(fs.statSync(p('deep/parent')).isDirectory()).toBe(true);
          expect(fs.readFileSync(hosts, 'utf8')).not.toContain('x\n');
        }
      );

      it('the globs Linux renders still lock a folder on macOS, so the control can fail', async () => {
        const fx = macFixture();
        const codex = await macCodex(fx);
        const cycle = `mkdir -p fx/model && echo x > fx/model/x.ts && ${del} fx; [ ! -e fx ] && echo TEARDOWN-OK || echo TEARDOWN-FAIL`;
        const linux = await codex.run(
          await threadConfig(fx, 'acceptEdits', 'mac-chat', 'linux'),
          cycle
        );
        expect(linux).toContain('TEARDOWN-FAIL');
        fs.rmSync(path.join(fx.project, 'fx'), { recursive: true, force: true });
        expect(await codex.run(await threadConfig(fx, 'acceptEdits'), cycle)).toContain(
          'TEARDOWN-OK'
        );
      });

      it.for(['acceptEdits', 'bypassPermissions'])(
        'at %s, the previous profile and this one both keep protected files in place, unchanged',
        async (mode, { annotate }) => {
          const fx = macFixture();
          const targets = {
            // Matched by a deep rule in the previous profile, named exactly in this one.
            deep: path.join(fx.project, 'deep', 'parent', '.env'),
            // An exact rule in both.
            homeFile: path.join(fx.home, '.netrc'),
            // Inside a folder ruled whole in both.
            inFolder: path.join(fx.home, '.aws', 'credentials'),
          };
          const plant = () => {
            for (const [name, file] of Object.entries(targets)) {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, `CANARY-matrix-${name}`);
            }
          };
          plant();
          const codex = await macCodex(fx);
          const probe = Object.entries(targets)
            .map(
              ([name, file]) =>
                // After the unlink, a write of new contents at the same path: a
                // file the shell can't see must not become one it can replace.
                `{ [ -e ${quote(file)} ] && v=seen || v=unseen; unlink ${quote(file)} 2>/dev/null && u=allowed || u=refused; printf replaced 2>/dev/null > ${quote(file)} && w=allowed || w=refused; echo ${name}:$v:$u:$w; }`
            )
            .join('; ');
          const matrix: Record<string, Record<string, string>> = {};
          for (const [profile, platform] of [
            ['previous', 'linux'],
            ['current', 'darwin'],
          ] as const) {
            const out = await codex.run(await threadConfig(fx, mode, 'mac-chat', platform), probe);
            matrix[profile] = Object.fromEntries(
              Object.entries(targets).map(([name, file]) => [
                name,
                `${
                  /:(seen|unseen):(allowed|refused):(allowed|refused)/
                    .exec(out.slice(out.indexOf(`${name}:`)))
                    ?.slice(1)
                    .join('/') ?? 'none'
                }/${
                  fs.existsSync(file) && fs.readFileSync(file, 'utf8') === `CANARY-matrix-${name}`
                    ? 'intact'
                    : 'changed'
                }`,
              ])
            );
            plant();
          }
          const macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
          const summary = `${mode} on macOS ${macos}: ${JSON.stringify(matrix)}`;
          await annotate(summary);
          console.info('DOR-4358 unlink matrix', summary);
          // Whether the shell can see the file is recorded, not judged: it is the
          // system's call. The unlink's and the write's own status, and the file
          // itself seen from outside, are judged.
          for (const profile of Object.values(matrix))
            for (const result of Object.values(profile))
              expect(result, summary).toMatch(/^(seen|unseen)\/refused\/refused\/intact$/);
        }
      );

      /** A repo-like folder whose one dependency is a local tarball: nothing reaches a registry. */
      function repoFixture(name: string, extraPath: string[] = []) {
        const fx = macFixture(extraPath);
        const dep = path.join(fx.root, 'dep', 'package');
        fs.mkdirSync(dep, { recursive: true });
        fs.writeFileSync(
          path.join(dep, 'package.json'),
          '{"name":"made-up-dep","version":"1.0.0"}\n'
        );
        fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = 1;\n');
        const repo = path.join(fx.project, name);
        fs.mkdirSync(path.join(repo, 'vendor'), { recursive: true });
        execFileSync('tar', [
          '-czf',
          path.join(repo, 'vendor', 'dep.tgz'),
          '-C',
          path.dirname(dep),
          'package',
        ]);
        // No `packageManager` field here or in any folder above it: nothing asks
        // pnpm to fetch another copy of itself.
        fs.writeFileSync(
          path.join(repo, 'package.json'),
          JSON.stringify({
            name: 'made-up-repo',
            version: '1.0.0',
            private: true,
            dependencies: { 'made-up-dep': 'file:vendor/dep.tgz' },
          })
        );
        for (let dir = repo; ; dir = path.dirname(dir)) {
          const manifest = path.join(dir, 'package.json');
          if (fs.existsSync(manifest))
            expect(
              (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { packageManager?: string })
                .packageManager,
              manifest
            ).toBeUndefined();
          if (path.dirname(dir) === dir) break;
        }
        return fx;
      }

      it('npm ci runs twice in a repo-like folder, reading its user config from the environment', async () => {
        const fx = repoFixture('npm-repo');
        const codex = await macCodex(fx);
        const npmFlags =
          '--offline --no-audit --no-fund --no-update-notifier --cache "$PWD/.npm-cache"';
        const out = await codex.run(
          await threadConfig(fx, 'acceptEdits'),
          [
            'cd npm-repo',
            `npm install ${npmFlags} >/dev/null 2>&1 && echo NPM-INSTALL-OK || echo NPM-INSTALL-FAIL`,
            `npm ci ${npmFlags} >/dev/null 2>&1 && echo NPM-CI-1-OK || echo NPM-CI-1-FAIL`,
            `npm ci ${npmFlags} >/dev/null 2>&1 && echo NPM-CI-2-OK || echo NPM-CI-2-FAIL`,
            'test -f node_modules/made-up-dep/package.json && echo NPM-DEP-OK',
            'printf "NPM-USERCONFIG:%s\\n" "$(npm config get userconfig)"',
          ].join('; ')
        );
        console.info('DOR-4358 npm row', { out });
        for (const marker of [
          'NPM-INSTALL-OK',
          'NPM-CI-1-OK',
          'NPM-CI-2-OK',
          'NPM-DEP-OK',
          'NPM-USERCONFIG:/dev/null',
        ])
          expect(out, marker).toContain(marker);
      });

      const pnpm = findOnPath('pnpm');
      it.skipIf(!pnpm)(
        'pnpm installs twice in a repo-like folder, with a bounded process count',
        async () => {
          const fx = repoFixture('pnpm-repo', [path.dirname(pnpm!)]);
          const codex = await macCodex(fx);
          const config = await threadConfig(fx, 'acceptEdits');
          // A soft cap on new processes, set from how many this user runs now: on
          // macOS `ulimit -u` counts every process the user has. Rows only.
          const running = execFileSync('ps', ['-U', String(process.getuid!()), '-o', 'pid='], {
            encoding: 'utf8',
          })
            .split('\n')
            .filter((line) => line.trim() !== '').length;
          const cap = `ulimit -u ${running + 80}`;
          const env = 'COREPACK_ENABLE_STRICT=0';
          // The probe first: one cheap run under a 10 s kill must print pnpm's own
          // version and start next to nothing, or the install never runs.
          const own = ownVersion(pnpm!);
          const probeWatch = watchChildren(codex.pid, 10_000);
          const probe = await codex.run(config, `cd pnpm-repo && ${cap} && ${env} pnpm --version`);
          const probed = probeWatch.stop();
          console.info('DOR-4358 pnpm probe', { probe, own, ...probed });
          expect(probed.killed, 'the probe was killed').toBe(false);
          expect(probed.peak, 'the probe started too many processes').toBeLessThanOrEqual(6);
          const version = /\b(\d+\.\d+\.\d+)\b/.exec(probe)?.[1];
          expect(version, 'the probe printed no version').toBeDefined();
          if (own) expect(version).toBe(own);

          const flags = [
            '--offline',
            '--store-dir "$PWD/.pnpm-store"',
            '--config.manage-package-manager-versions=false',
            '--config.update-notifier=false',
            '--config.confirm-modules-purge=false',
          ].join(' ');
          const rowWatch = watchChildren(codex.pid, 60_000);
          const out = await codex.run(
            config,
            [
              `cd pnpm-repo && ${cap}`,
              `${env} pnpm install ${flags} >/dev/null 2>&1 && echo PNPM-INSTALL-OK || echo PNPM-INSTALL-FAIL`,
              `${env} pnpm install --force ${flags} >/dev/null 2>&1 && echo PNPM-FORCE-OK || echo PNPM-FORCE-FAIL`,
              'test -f node_modules/made-up-dep/package.json && echo PNPM-DEP-OK',
            ].join('; ')
          );
          const row = rowWatch.stop();
          console.info('DOR-4358 pnpm row', { out, ...row });
          expect(row.killed, 'the pnpm row was killed').toBe(false);
          for (const marker of ['PNPM-INSTALL-OK', 'PNPM-FORCE-OK', 'PNPM-DEP-OK'])
            expect(out, marker).toContain(marker);
        }
      );
    }
  );
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
  // Every protected file in place, as production prepares them: a missing one
  // is a mount bubblewrap cannot make at Full. No backups, so Linux Full starts.
  completeHostFixture(policy, [home!, data!], { withoutClaudeBackups: true });
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
    // macOS (Seatbelt): a raw backslash escapes the next character, so the
    // glob lands on `ab`; doubled, it matches `a\b`. Linux searches from the
    // text before the first glob character as a real folder: raw finds `a\b`,
    // doubled finds no folder. No spelling holds on both, hence the refusal.
    expect(denied).toEqual(
      process.platform === 'linux'
        ? {
            raw: { slashed: true, lookalike: false },
            doubled: { slashed: false, lookalike: false },
          }
        : { raw: { slashed: false, lookalike: true }, doubled: { slashed: true, lookalike: false } }
    );
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
    // Linux below Full misses the escaped glob, hence its refusal there; the
    // scoped key holds on both.
    expect(denied).toEqual({ escaped: process.platform !== 'linux', scoped: true });
  });
});
