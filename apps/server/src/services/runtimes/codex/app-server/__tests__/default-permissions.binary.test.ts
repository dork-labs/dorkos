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
 * A throwaway `HOME` and `CODEX_HOME`, no auth, file credential stores, and
 * a loopback fake provider. Skipped by name where no vendored binary exists.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { APP_SERVER_ARGS } from '../process-pool.js';
import { codexInitializeParams } from '../handshake.js';
import { completeHostFixture, FIXTURE_BACKUP_NAME } from './fixtures/complete-protected-home.js';
import { shellControlReturned } from './fixtures/protected-probe.js';

const BINARY = resolveCodexVendoredBinary();
const MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;

let server: http.Server;
let base = '';
/** Provider answers for the current row, consumed in order. */
const scripted: Array<(res: http.ServerResponse, body: string) => void> = [];
/** Requests the sandboxed command made to the loopback server. */
let networkHits = 0;
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function stream(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 12,
};

/** One streamed answer that runs `cmd` through `exec_command`, waiting up to `yieldMs` for it. */
function execCall(cmd: string, yieldMs?: number): string {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_default_permissions',
    name: 'exec_command',
    arguments: JSON.stringify({
      cmd,
      login: false,
      ...(yieldMs ? { yield_time_ms: yieldMs } : {}),
    }),
  };
  return stream([
    { type: 'response.created', response: { id: 'resp_call' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { id: 'resp_call', usage: USAGE } },
  ]);
}

/** One streamed plain-text answer. */
function text(value: string): string {
  const item = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }],
  };
  return stream([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_1', usage: USAGE } },
  ]);
}

/** Everything the sandboxed command printed, from the follow-up provider request. */
function commandOutput(body: string): string {
  const request = JSON.parse(body) as { input?: { type?: string; output?: unknown }[] };
  return (request.input ?? [])
    .filter((item) => item.type === 'function_call_output' && typeof item.output === 'string')
    .map((item) => item.output as string)
    .join('\n');
}

/** A raw JSON-RPC peer: the production client refuses a load without `permissions`. */
function appServer(cwd: string, env: Record<string, string>) {
  const child = spawn(BINARY!, [...APP_SERVER_ARGS], { cwd, env, stdio: 'pipe' });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const waiters: Array<() => void> = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id !== undefined && message.method !== undefined) {
      // A server request (an approval): decline; approval policy is `never`.
      child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: 'decline' } })}\n`);
      return;
    }
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
      return;
    }
    if (message.method)
      notifications.push({ method: message.method, params: message.params ?? {} });
    for (const wake of waiters.splice(0)) wake();
  });
  const request = <T>(method: string, params: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ method })}\n`);
  const until = async (method: string, deadlineMs = 60_000, nth = 1) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const found = notifications.filter((n) => n.method === method)[nth - 1];
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${method}; stderr: ${stderr.slice(-2000)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 500);
      });
    }
  };
  return { request, notify, until, stderr: () => stderr, pid: child.pid! };
}

/** Point Codex at the loopback fake provider, with file credential stores and no plugins. */
function writeFakeProviderConfig(codexHome: string): void {
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'model_provider = "fake"',
      'cli_auth_credentials_store = "file"',
      'mcp_oauth_credentials_store = "file"',
      'features.plugins = false',
      '[model_providers.fake]',
      'name = "fake"',
      `base_url = "${base}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'request_max_retries = 0',
      'stream_max_retries = 0',
    ].join('\n') + '\n'
  );
}

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

/** The first executable `name` on PATH outside `node_modules`, or `undefined`. */
function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir || dir.includes('node_modules')) continue;
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
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (req.url?.startsWith('/net-probe')) {
          networkHits += 1;
          res.writeHead(200).end('NET-REACHED');
        } else if (req.url?.startsWith('/v1/responses')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const next = scripted.shift();
          if (next) next(res, body);
          else res.end(text('done'));
        } else res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const dir of roots.splice(0))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    scripted.length = 0;
    networkHits = 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

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
    writeFakeProviderConfig(codexHome!);
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

    const codex = appServer(project!, {
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
  describe.skipIf(process.platform !== 'darwin')(
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
        writeFakeProviderConfig(codexHome);
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
        const codex = appServer(fx.project, fx.env);
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
              'unlink deep/parent/.env 2>/dev/null; [ -e deep/parent/.env ] && echo UNLINK-REFUSED || echo UNLINKED',
              // Row 3: folders with no secret file, beside one and far from one.
              `${del} deep/free; [ ! -e deep/free ] && echo SIBLING-REMOVED || echo SIBLING-KEPT`,
              `${del} deep; [ -e deep/parent/.env ] && echo TREE-KEPT || echo TREE-REMOVED`,
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
            'TREE-KEPT',
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
          expect(fs.readFileSync(secret, 'utf8')).toBe('CANARY-secret');
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
