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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import {
  codexPermissionProfile,
  codexProtectedConfig,
  type CodexFilePolicy,
} from '../../policy/protected-profile.js';
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

/** One streamed answer that runs `cmd` through `exec_command`. */
function execCall(cmd: string): string {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_default_permissions',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd, login: false }),
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
  const until = async (method: string, deadlineMs = 60_000) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const found = notifications.find((n) => n.method === method);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${method}; stderr: ${stderr.slice(-2000)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 500);
      });
    }
  };
  return { request, notify, until, stderr: () => stderr };
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
    fs.writeFileSync(
      path.join(codexHome!, 'config.toml'),
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
    expect(output).not.toContain('LISTED:');
    expect(fs.existsSync(written)).toBe(mode !== 'default');
    expect(networkHits > 0).toBe(mode === 'bypassPermissions');
    expect(output.includes('NET-REACHED')).toBe(mode === 'bypassPermissions');
    expect(fs.readFileSync(sshKey, 'utf8')).toBe('CANARY-ssh-key');
  });
});
