/**
 * @vitest-environment node
 *
 * The app-server transport against the REAL vendored Codex binary, for free
 * (spec `codex-app-server-transport` §17, the spike technique): a throwaway
 * `CODEX_HOME` and `HOME`, no API key in sight, and one local HTTP server on
 * 127.0.0.1 playing both a Responses provider (configured in the throwaway
 * home's `config.toml`) and the DorkOS tool server. Nothing leaves the
 * machine; nothing of this machine's `~/.codex` is read or written.
 *
 * Proves, on the binary DorkOS pins:
 * - a turn streams text and ends with exactly one `done`;
 * - Stop is acknowledged (`acked`) when Codex winds the turn down;
 * - the `dorkos` MCP server receives the thread key, and the listener's
 *   resolution of that key works only while the turn is open;
 * - no secret is in the child's argv or environment;
 * - the throwaway home's trust list is not written by a writable-mode turn;
 * - a command Codex must ask about raises a card; approved, it runs; denied,
 *   it does not (spec §10);
 * - a thread started at Full and resumed cold after the person lowered it to
 *   Ask still asks: the lowered level wins over the thread's saved one;
 * - a steer mid-turn reaches the open turn, and no new turn starts (§11);
 * - a command left running in the background finishes after `turn/completed`
 *   and wakes the chat exactly once; one that never ends never wakes it, and
 *   Stop or the ceiling terminates it without waking the model (§12).
 *
 * Skipped by name where no vendored binary is installed for this platform.
 */
import http from 'node:http';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { createHash } from 'node:crypto';
import { assertProtectionStarts } from './fixtures/protection-starts.js';
import { completeHostFixture, FIXTURE_BACKUP_NAME } from './fixtures/complete-protected-home.js';
import { codexProtectedConfig } from '../../policy/protected-profile.js';
import { reconcileMountTargets } from '../../policy/reconcile-mount-targets.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import { CodexAppServerPool, type SpawnAppServer } from '../process-pool.js';
import type { AppServerCodexTransport } from '../../transport/app-server-transport.js';
import { createCodexTransport } from '../../transport/index.js';
import * as runtimeEnv from '../../../shared/runtime-environment-config.js';
import type { BackgroundWake } from '../background-work.js';
import { createCodexEventContext } from '../../event-mapper.js';
import { ConnectorThreadKeyRegistry } from '../../../../connectors/principal/thread-keys.js';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimeTools } from '../../../connector-tools.js';
import type { CodexTurnRequest } from '../../transport/codex-transport.js';
import type { AppServerTransportOptions } from '../../transport/app-server-transport.js';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  protectedProbe,
  shellControlReturned,
  probeParentKinds,
} from './fixtures/protected-probe.js';

const BINARY = resolveCodexVendoredBinary();
const IDENTITY_SECRET = 'identity-token-never-real';

interface Seen {
  responses: number;
  mcpAuthorizations: string[];
  /** Listener resolutions made while a provider request (a turn) was open. */
  resolvedDuringTurn: string[];
}

let root: string;
let codexHome: string;
/** The Claude account folder: never the Codex home, as in production. */
let claudeAccount: string;
let project: string;
let server: http.Server;
let base: string;
let stallNext = false;
/** Scripted provider answers, consumed in order before the default "pong". */
const scripted: Array<(res: http.ServerResponse, body: string) => void> = [];
/** Tool calls the third-party MCP server ran, by name. */
const mcpCalls: string[] = [];
/** `turn/started` notifications every spawned process sent, counted off its stdout. */
let turnStartedSeen = 0;
const seen: Seen = { responses: 0, mcpAuthorizations: [], resolvedDuringTurn: [] };
const pools: CodexAppServerPool[] = [];
const spawned: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
const protectedStarts = { default: 0, acceptEdits: 0, bypassPermissions: 0 };
/**
 * Rows that must start a turn at Full. Codex 0.163 on Linux refuses Full while
 * a Claude Code backup sits in a hidden folder (DOR-3965), so these opt out
 * of the planted backups; the pinned refusal rows below cover that home.
 */
const STARTS_AT_FULL = [
  'asks again after a person lowers Full to Ask and the thread resumes cold',
  'raises a card for a command that needs approval, and runs it once approved',
  'wakes the chat exactly once when a command finishes after its turn completed',
  'never wakes for a command that never ends, and Stop terminates it without a model turn',
  'stops a never-ending command once at the ceiling, and still wakes no model turn',
  // The refusal rows plant their one backup themselves.
  'refuses Full while a Claude Code backup sits in',
];

const keys = new ConnectorThreadKeyRegistry();
const db = createDb(':memory:');
runMigrations(db);
const principals = new ConnectorRuntimePrincipalService({
  db,
  threadKeys: keys,
  authority: {
    authorizeTurn: async () => ({
      owner: { kind: 'local_install', installationId: 'i' },
      agentId: 'a',
    }),
    revalidateTurn: async () => true,
  },
});

/** The SSE body of one streamed Responses answer. */
function sse(text: string): string {
  const events = [
    { type: 'response.created', response: { id: 'resp_1' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text.slice(0, 2),
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: text.slice(2),
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function resolveAll(): Promise<void> {
  for (const authorization of new Set(seen.mcpAuthorizations)) {
    const result = await principals.resolve({
      bearer: authorization.replace(/^Bearer /, ''),
      expectedRuntime: 'codex',
      expectedCanonicalCwd: project,
    });
    if (result.status === 'resolved') seen.resolvedDuringTurn.push(result.principal.claims.kind);
  }
}

/** One streamed Responses answer that calls `exec_command`. */
function sseCall(
  args: Record<string, unknown>,
  tool: { name: string; namespace?: string } = { name: 'exec_command' }
): string {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: `call_${Math.random().toString(36).slice(2, 8)}`,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(args),
  };
  return [
    { type: 'response.created', response: { id: 'resp_call' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    {
      type: 'response.completed',
      response: {
        id: 'resp_call',
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  if (req.url?.startsWith('/v1/responses') && scripted.length > 0) {
    seen.responses += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    scripted.shift()!(res, body);
    return;
  }
  if (req.url?.startsWith('/v1/responses')) {
    seen.responses += 1;
    // The turn is open while Codex waits on this answer: resolve the key now.
    void resolveAll().then(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (stallNext) {
        stallNext = false;
        res.write(': stalled\n\n');
        return; // never completes: Stop has to end this turn
      }
      res.end(sse('pong'));
    });
    return;
  }
  if (req.url?.startsWith('/repo-mcp')) {
    // A third-party MCP server: one tool that changes things, one its server
    // marks read-only.
    const message = JSON.parse(body || '{}') as { id?: number; method?: string; params?: unknown };
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'repo', version: '0' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'delete_repo',
                  description: 'Delete a repository',
                  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
                },
                {
                  name: 'read_file',
                  description: 'Read a file',
                  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : message.method === 'tools/call'
            ? (mcpCalls.push((message.params as { name: string }).name),
              { content: [{ type: 'text', text: 'ok' }] })
            : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    return;
  }
  if (req.url?.startsWith('/mcp')) {
    if (req.headers.authorization) seen.mcpAuthorizations.push(req.headers.authorization);
    let message: { id?: number; method?: string } = {};
    try {
      message = JSON.parse(body) as typeof message;
    } catch {
      // Not JSON.
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-dorkos', version: '0' },
          }
        : message.method === 'tools/list'
          ? { tools: [] }
          : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    return;
  }
  res.writeHead(404).end();
}

function makeTransport(
  backgroundWork?: AppServerTransportOptions['backgroundWork'],
  setting: 'exec' | 'app-server' = 'app-server',
  onSpawn?: (child: ReturnType<typeof nodeSpawn>) => void
): AppServerCodexTransport {
  const spawn: SpawnAppServer = (binary, args, options) => {
    spawned.push({ args, env: options.env });
    const child = nodeSpawn(binary, [...args], {
      env: options.env,
      cwd: options.cwd,
      stdio: 'pipe',
    });
    onSpawn?.(child);
    child.stdout.on('data', (chunk: Buffer) => {
      turnStartedSeen += chunk.toString().split('"method":"turn/started"').length - 1;
    });
    return child;
  };
  const pool = new CodexAppServerPool({ spawn });
  pools.push(pool);
  const tools = {
    principals,
    threadKeys: keys,
    listenerUrl: `${base}/mcp`,
    agentToolsUrl: `${base}/mcp`,
    isConnectorCapabilityId: () => false,
  } satisfies ConnectorRuntimeTools;
  const config = UserConfigSchema.parse({
    version: 1,
    runtimes: { codex: { transport: setting } },
  });
  expect(config.runtimes.codex).not.toHaveProperty('transport');
  return createCodexTransport({
    pool,
    ...(backgroundWork ? { backgroundWork } : {}),
    connectorTools: () => tools,
    environment: {
      person: () => ({
        PATH: '/usr/bin:/bin',
        HOME: path.join(root, 'home'),
        CODEX_HOME: codexHome,
      }),
      credits: () => ({
        PATH: '/usr/bin:/bin',
        HOME: path.join(root, 'home'),
        CODEX_HOME: codexHome,
      }),
    },
  });
}

function request(
  sessionId: string,
  bindingId: string | undefined,
  overrides: Partial<CodexTurnRequest> = {}
): CodexTurnRequest {
  const baseRequest: CodexTurnRequest = {
    binary: BINARY!,
    sessionId,
    boundThreadId: undefined,
    cwd: project,
    settings: { permissionMode: 'acceptEdits', model: 'fake-model' },
    writableDirectories: [],
    prompt: 'say pong',
    launch: { home: 'person' },
    tools: {
      agentTokenEnv: { DORKOS_AGENT_TOKEN: IDENTITY_SECRET },
      managed: { servers: {}, env: {} },
      dorkosTools: { url: `${base}/mcp`, headers: {} },
      connectorTools: null,
      ...(bindingId ? { connectorBindingId: bindingId } : {}),
      filePolicy: {
        roots: {
          cwd: project,
          data: path.join(root, 'data'),
          home: path.join(root, 'home'),
          accounts: [claudeAccount],
          agentFolders: [project],
          agentHomes: [],
        },
        writable: [project],
      },
    },
    signal: new AbortController().signal,
    events: createCodexEventContext(sessionId),
    onThreadBound: () => {},
  };
  // Replacing a managed tool must not replace the throwaway file policy
  // with the parent runner's real HOME/data defaults.
  const merged = {
    ...baseRequest,
    ...overrides,
    tools: { ...baseRequest.tools, ...overrides.tools },
  };
  expect(merged.tools.filePolicy).toBeDefined();
  expect(merged.tools.filePolicy!.roots.home).toBe(path.join(root, 'home'));
  expect(merged.tools.filePolicy!.roots.data).toBe(path.join(root, 'data'));
  return merged;
}

/** Snapshot every host entry without following links or retaining large file trees. */
function hostTreeDigest(dir: string, newFolders = new Set<string>()): string {
  const hash = createHash('sha256');
  const visit = (file: string): void => {
    const stat = fs.lstatSync(file);
    if (!newFolders.has(file))
      hash.update(
        JSON.stringify([
          file,
          stat.ino,
          stat.mode,
          stat.uid,
          ...(stat.isDirectory() ? [] : [stat.size, stat.mtimeMs, stat.ctimeMs]),
        ])
      );
    if (stat.isDirectory())
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isFile()) hash.update(fs.readFileSync(file));
  };
  visit(dir);
  return hash.digest('hex');
}

function expectedNewFolders(turn: CodexTurnRequest): Set<string> {
  const roots = turn.tools.filePolicy!.roots;
  return new Set(
    [roots.cwd, ...roots.agentFolders]
      .filter((dir) => dir !== roots.home)
      .flatMap((dir) => ['.claude', '.dork'].map((name) => path.join(dir, name)))
      .filter((file) => !fs.existsSync(file))
  );
}

/** A specific refusal, never a successful unprotected turn or a generic failure. */
async function nativeRefusal(
  turn: CodexTurnRequest,
  code: string,
  details: readonly string[],
  beforeAcquire = false
) {
  const count = spawned.length;
  const starts = turnStartedSeen;
  const responses = seen.responses;
  const bound = vi.fn();
  const events: StreamEvent[] = [];
  const transport = makeTransport();
  try {
    for await (const event of transport.runTurn({ ...turn, onThreadBound: bound }))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(events[0]).toMatchObject({ data: { code } });
    const error = events[0]!;
    const reason = 'details' in error.data ? String(error.data.details) : '';
    for (const detail of details) expect(reason).toContain(detail);
    expect(bound).not.toHaveBeenCalled();
    expect(turnStartedSeen).toBe(starts);
    expect(seen.responses).toBe(responses);
    if (beforeAcquire) expect(spawned).toHaveLength(count);
    return JSON.stringify(events);
  } finally {
    await transport.shutdown();
  }
}

/**
 * Run one turn and keep everything it printed: its events, this process's
 * stdout and stderr (the DorkOS logs), and every Codex child's output.
 */
async function capturedTurn(turn: CodexTurnRequest) {
  const printed: string[] = [];
  const keep = (chunk: unknown) => printed.push(String(chunk));
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (keep(chunk), true)),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (keep(chunk), true)),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        keep(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      })
    ),
  ];
  const bound = vi.fn();
  const events: StreamEvent[] = [];
  const transport = makeTransport(undefined, 'app-server', (child) => {
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
  });
  try {
    for await (const event of transport.runTurn({ ...turn, onThreadBound: bound }))
      events.push(event);
  } finally {
    await transport.shutdown();
    for (const spy of spies) spy.mockRestore();
  }
  return { events, bound, printed: printed.join('') };
}

function checkHostParents(homes: string[]) {
  expect(
    probeParentKinds(homes).filter(({ kind }) => kind !== 'absent' && kind !== 'directory')
  ).toEqual([]);
}

// Apply the intended limit during collection; beforeAll is too late.
const NATIVE_LIMITS = { timeout: 90_000 };
const nativeSuite = describe.skipIf(BINARY === null);
nativeSuite('the app-server transport against the real Codex binary', NATIVE_LIMITS, () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => handle(req, res, body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await principals.initializeBoot();
  });

  it.skipIf(process.platform !== 'linux')(
    'refuses a writable symlink inside the agent home without creating through it',
    async () => {
      const turn = request('own-home-writable-link', undefined);
      const policy = turn.tools.filePolicy!;
      policy.roots.agentHomes = [project];
      completeHostFixture(policy, [
        policy.roots.home,
        policy.roots.data,
        project,
        codexHome,
        claudeAccount,
      ]);
      const target = path.join(root, 'empty-skill-target');
      fs.mkdirSync(target);
      // The leaf inside .claude is writable; the existing linked-folder row
      // separately covers a link replacing .claude itself before acquisition.
      const link = path.join(project, '.claude', 'skills');
      fs.rmdirSync(link);
      fs.symlinkSync(target, link, 'dir');
      const before = { ino: fs.lstatSync(link).ino, target: fs.readlinkSync(link) };
      const parents = [policy.roots.home, policy.roots.data, project];
      try {
        await nativeRefusal(turn, 'codex_unavailable', ['crosses writable symlink', link]);
        expect({ ino: fs.lstatSync(link).ino, target: fs.readlinkSync(link) }).toEqual(before);
        expect(fs.readdirSync(target)).toEqual([]);
      } finally {
        checkHostParents(parents);
      }
    }
  );

  it.skipIf(process.platform !== 'linux').each(['acceptEdits', 'bypassPermissions'] as const)(
    'refuses writes into another agent home inside writable cwd at %s',
    async (mode) => {
      const other = path.join(project, 'other-agent');
      fs.mkdirSync(other);
      const turn = request('other-home-in-cwd', undefined, {
        settings: { permissionMode: mode, model: 'fake-model' },
      });
      turn.tools.filePolicy!.roots.agentHomes = [other];
      const folders = expectedNewFolders(turn);
      const before = hostTreeDigest(root, folders);
      const writes = ['settings.json', 'skills'].map((name) => path.join(other, '.claude', name));
      try {
        await nativeRefusal(
          turn,
          mode === 'acceptEdits'
            ? 'codex_writable_missing_protected_targets'
            : 'codex_full_missing_protected_targets',
          [path.join(other, '.claude')],
          true
        );
        expect(fs.readdirSync(other)).toEqual([]);
        for (const file of writes)
          expect(() => fs.lstatSync(file)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
        expect(hostTreeDigest(root, folders)).toBe(before);
        expect(turn.settings.permissionMode).toBe(mode);
      } finally {
        checkHostParents([path.join(root, 'home'), path.join(root, 'data'), project, other]);
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'refuses Edit plainly when cwd is the person home with a missing protected file',
    async () => {
      const home = path.join(root, 'home');
      fs.unlinkSync(path.join(home, '.netrc'));
      const turn = request('person-home-edit', undefined, { cwd: home });
      const policy = turn.tools.filePolicy!;
      policy.roots.cwd = home;
      policy.roots.agentFolders = [home];
      policy.writable = [home];
      const before = hostTreeDigest(root);
      try {
        const events = await nativeRefusal(
          turn,
          'codex_writable_missing_protected_targets',
          [path.join(home, '.netrc')],
          true
        );
        expect(events).toContain('Choose Ask, then retry.');
        expect(hostTreeDigest(root)).toBe(before);
      } finally {
        checkHostParents([home, policy.roots.data, project]);
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'refuses rg-unreadable rather than skipping protected content at Ask',
    async () => {
      const home = path.join(root, 'home');
      const probe = protectedProbe(root, project);
      const unreadable = path.join(home, 'rg-unreadable');
      expect(process.getuid?.()).not.toBe(0);
      fs.mkdirSync(unreadable);
      fs.writeFileSync(path.join(unreadable, '.env'), 'FAKE-unreadable-canary');
      fs.chmodSync(unreadable, 0o000);
      try {
        const events = await nativeRefusal(
          request('rg-unreadable', undefined, {
            settings: { permissionMode: 'default', model: 'fake-model' },
          }),
          'codex_unavailable',
          [
            'error building bubblewrap command',
            'ripgrep unreadable glob scan failed',
            unreadable,
            'Permission denied (os error 13)',
          ]
        );
        for (const canary of [...probe.canaries, 'FAKE-unreadable-canary'])
          expect(events).not.toContain(canary);
      } finally {
        fs.chmodSync(unreadable, 0o700);
        expect(fs.readFileSync(path.join(unreadable, '.env'), 'utf8')).toBe(
          'FAKE-unreadable-canary'
        );
        expect(await reconcileMountTargets(path.join(root, 'data'))).toEqual([]);
        checkHostParents([home, path.join(root, 'data'), project]);
        probe.cleanup();
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'preserves host files after SIGKILL mid-turn and protects the next launch',
    async () => {
      const turn = request('kill-native', undefined);
      const policy = turn.tools.filePolicy!;
      policy.roots.agentHomes = [project];
      const files = completeHostFixture(policy, [
        policy.roots.home,
        policy.roots.data,
        project,
        codexHome,
        claudeAccount,
      ]);
      const snapshot = () =>
        [...files].sort().map((file) => [file, fs.readFileSync(file, 'base64')]);
      const before = snapshot();
      let child: ReturnType<typeof nodeSpawn> | undefined;
      let exited: Promise<string | null> | undefined;
      let ready = false;
      let killed = false;
      scripted.push(
        (res) =>
          res.end(
            sseCall({
              cmd: 'printf PUBLIC-kill-ready; sleep 30',
              login: false,
              yield_time_ms: 1000,
            })
          ),
        (res, body) => {
          ready = shellControlReturned(body, 'PUBLIC-kill-ready');
          if (ready) killed = child?.kill('SIGKILL') ?? false;
          res.end(sse('victim stopped'));
        }
      );
      const victim = makeTransport(undefined, 'app-server', (spawnedChild) => {
        child = spawnedChild;
        exited = new Promise((resolve) =>
          spawnedChild.once('exit', (_code, signal) => resolve(signal))
        );
      });
      try {
        try {
          for await (const event of victim.runTurn(turn)) void event;
        } catch (error) {
          expect(killed, String(error)).toBe(true);
        }
        expect(ready).toBe(true);
        expect(killed).toBe(true);
        expect(await exited).toBe('SIGKILL');
        checkHostParents([policy.roots.home, policy.roots.data, project]);
        expect(snapshot()).toEqual(before);
      } finally {
        await victim.shutdown();
      }
      scripted.length = 0;
      expect(await reconcileMountTargets(policy.roots.data)).toEqual([]);
      const secret = path.join(policy.roots.home, '.ssh', 'authorized_keys');
      fs.writeFileSync(secret, 'CANARY-after-kill');
      let returned = '';
      scripted.push(
        (res) =>
          res.end(
            sseCall({
              cmd: `cat ${JSON.stringify(secret)}; printf changed >> ${JSON.stringify(secret)}; printf PUBLIC-after-kill`,
              login: false,
            })
          ),
        (res, body) => {
          returned = body;
          res.end(sse('recovered'));
        }
      );
      const bound = vi.fn();
      const events: StreamEvent[] = [];
      for await (const event of makeTransport().runTurn({
        ...turn,
        sessionId: 'after-kill',
        onThreadBound: bound,
      }))
        events.push(event);
      expect(bound).toHaveBeenCalledTimes(1);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(shellControlReturned(returned, 'PUBLIC-after-kill')).toBe(true);
      expect(returned).not.toContain('CANARY-after-kill');
      expect(fs.readFileSync(secret, 'utf8')).toBe('CANARY-after-kill');
      checkHostParents([policy.roots.home, policy.roots.data, project]);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'refuses a linked active folder without changing its target or starting Codex',
    async () => {
      const target = path.join(root, 'link-target');
      fs.mkdirSync(target);
      const link = path.join(project, '.claude');
      fs.symlinkSync(target, link, 'dir');
      const ino = fs.lstatSync(link).ino;
      const turn = request('linked-folder-native', undefined);
      const newFolders = expectedNewFolders(turn);
      const before = hostTreeDigest(root, newFolders);
      const count = spawned.length;
      const bound = vi.fn();
      const events: StreamEvent[] = [];
      for await (const event of makeTransport().runTurn({ ...turn, onThreadBound: bound }))
        events.push(event);
      expect(events.map((event) => event.type)).toEqual(['error', 'done']);
      expect(events[0]).toMatchObject({
        data: {
          code: 'codex_unavailable',
          details: 'Codex cannot protect a linked folder. Choose another folder, then retry.',
        },
      });
      expect(bound).not.toHaveBeenCalled();
      expect(spawned).toHaveLength(count);
      expect(fs.readlinkSync(link)).toBe(target);
      expect(fs.lstatSync(link).ino).toBe(ino);
      expect(fs.readdirSync(target)).toEqual([]);
      expect(hostTreeDigest(root, newFolders)).toBe(before);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'refuses Full with missing protected targets before any Codex or bwrap launch',
    async () => {
      const spawnCount = spawned.length;
      const bound = vi.fn();
      const transport = makeTransport();
      const full = request('full-missing-native', undefined, {
        settings: { permissionMode: 'bypassPermissions', model: 'fake-model' },
        onThreadBound: bound,
      });
      const newFolders = expectedNewFolders(full);
      const before = hostTreeDigest(root, newFolders);
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(full)) events.push(event);
      expect(events.map((event) => event.type)).toEqual(['error', 'done']);
      expect(events[0]).toMatchObject({
        data: {
          code: 'codex_full_missing_protected_targets',
          message:
            'Codex can’t use Full access while protected files are missing. Choose Ask, then retry.',
          details: expect.stringContaining(path.join(root, 'home', '.claude.json')),
        },
      });
      expect(bound).not.toHaveBeenCalled();
      expect(spawned).toHaveLength(spawnCount);
      expect(hostTreeDigest(root, newFolders)).toBe(before);
      for (const folder of newFolders) expect(fs.lstatSync(folder).isDirectory()).toBe(true);
      expect(full.settings.permissionMode).toBe('bypassPermissions');
      console.info('Codex Full missing-target refusal proved before native launch', {
        newProcesses: spawned.length - spawnCount,
        hostUnchanged: true,
      });
    }
  );

  it
    .skipIf(process.platform !== 'linux')
    .each(
      (['acceptEdits', 'bypassPermissions'] as const).flatMap((mode) =>
        [false, true].map((freshProject) => ({ mode, freshProject }))
      )
    )(
    'starts protected mode from a complete home ($mode, fresh project: $freshProject)',
    async ({ mode, freshProject }) => {
      const turn = request('full-complete-home', undefined, {
        settings: { permissionMode: mode, model: 'fake-model' },
      });
      const policy = turn.tools.filePolicy!;
      policy.roots.agentHomes = freshProject ? [] : [project];
      const allBases = [
        policy.roots.home,
        policy.roots.data,
        ...(freshProject ? [] : [project]),
        codexHome,
        claudeAccount,
      ];
      // Full cannot start beside a Claude Code backup on Linux (DOR-3965);
      // the pinned refusal rows cover that home.
      const protectedFiles = completeHostFixture(policy, allBases, {
        withoutClaudeBackups: mode === 'bypassPermissions',
      });
      const secret = path.join(policy.roots.home, '.ssh', 'authorized_keys');
      const grant = freshProject
        ? path.join(policy.roots.home, '.claude.json')
        : path.join(project, '.dork', 'agent.json');
      fs.writeFileSync(secret, 'CANARY-complete-home-secret');
      protectedFiles.add(secret);
      const snapshot = () =>
        [...protectedFiles].sort().map((file) => {
          const stat = fs.lstatSync(file);
          return {
            file,
            ino: stat.ino,
            mode: stat.mode,
            contents: fs.readFileSync(file, 'base64'),
          };
        });
      const before = snapshot();
      const homes = [policy.roots.home, policy.roots.data, project];
      const newFolders = expectedNewFolders(turn);
      const parents = probeParentKinds(homes);
      expect(parents.filter(({ kind }) => kind !== 'absent' && kind !== 'directory')).toEqual([]);
      let missing: string[] = [];
      codexProtectedConfig(turn.cwd, policy, turn.settings, (targets) => {
        missing = targets;
      });
      expect(missing).toEqual([]);
      const quote = (value: string) => JSON.stringify(value);
      let returned = '';
      scripted.push(
        (res) =>
          res.end(
            sseCall({
              cmd: `printf PUBLIC-complete-full; cat ${quote(secret)}; printf unsafe >> ${quote(secret)}; printf unsafe > ${quote(grant)}; printf PUBLIC-complete-attempts`,
              login: false,
            })
          ),
        (res, body) => {
          returned = body;
          res.end(sse('complete Full finished'));
        }
      );
      const bound = vi.fn();
      const events: StreamEvent[] = [];
      for await (const event of makeTransport().runTurn({ ...turn, onThreadBound: bound }))
        events.push(event);
      expect(bound).toHaveBeenCalledTimes(1);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(shellControlReturned(returned, 'PUBLIC-complete-full')).toBe(true);
      expect(shellControlReturned(returned, 'PUBLIC-complete-attempts')).toBe(true);
      expect(returned).not.toContain('CANARY-complete-home-secret');
      await Promise.all(pools.map((pool) => pool.shutdown()));
      expect(snapshot()).toEqual(before);
      for (const folder of newFolders) expect(fs.lstatSync(folder).isDirectory()).toBe(true);
      expect(probeParentKinds(homes)).toEqual(
        parents.map((entry) =>
          newFolders.has(entry.file) ? { ...entry, kind: 'directory' } : entry
        )
      );
      expect(
        probeParentKinds(homes).filter(({ kind }) => kind !== 'absent' && kind !== 'directory')
      ).toEqual([]);
      expect(turn.settings.permissionMode).toBe(mode);
      protectedStarts[mode]++;
      console.info('Codex complete-home protected row started', { mode, freshProject });
    }
  );

  // DOR-3949: the fixture plants a Claude Code sign-in backup in the person's
  // `.claude/backups` and in the account folder's `backups`, both hidden whole.
  it.skipIf(process.platform !== 'linux')(
    'starts at Ask with Claude Code sign-in backups on disk',
    async () => {
      const bound = vi.fn();
      const events: StreamEvent[] = [];
      for await (const event of makeTransport().runTurn({
        ...request('backup-ask', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
        }),
        onThreadBound: bound,
      }))
        events.push(event);
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(bound).toHaveBeenCalledTimes(1);
      protectedStarts.default++;
    }
  );

  // Codex reads AGENTS.md through a helper that runs from `/`, so the skip
  // holds even when the chat's folder sits above the hidden backups folder.
  it.skipIf(process.platform !== 'linux')(
    'starts at Ask in the person home with Claude Code sign-in backups on disk',
    async () => {
      const home = path.join(root, 'home');
      const turn = request('backup-ask-home', undefined, {
        cwd: home,
        settings: { permissionMode: 'default', model: 'fake-model' },
      });
      const policy = turn.tools.filePolicy!;
      policy.roots.cwd = home;
      policy.roots.agentFolders = [home];
      policy.writable = [];
      const bound = vi.fn();
      const events: StreamEvent[] = [];
      for await (const event of makeTransport().runTurn({ ...turn, onThreadBound: bound }))
        events.push(event);
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(bound).toHaveBeenCalledTimes(1);
    }
  );

  // Full is the pinned refusal below (DOR-3965), so this starts at Edit only.
  it.skipIf(process.platform !== 'linux').each(['acceptEdits'] as const)(
    'hides Claude Code sign-in backups and every other sign-in copy at %s',
    async (mode) => {
      const home = path.join(root, 'home');
      const homeBackups = path.join(home, '.claude', 'backups');
      const accountBackups = path.join(claudeAccount, 'backups');
      // Not a protected folder: its backup is masked by the glob scan alone,
      // so an unanchored skip (`**/.claude/backups`) would leave it readable.
      const projectBackups = path.join(home, 'projects', 'p', '.claude', 'backups');
      fs.mkdirSync(projectBackups, { recursive: true });
      const canaries = {
        [path.join(homeBackups, FIXTURE_BACKUP_NAME)]: 'CANARY-home-backup',
        [path.join(accountBackups, FIXTURE_BACKUP_NAME)]: 'CANARY-account-backup',
        [path.join(projectBackups, '.claude.json.backup.2')]: 'CANARY-project-backup',
        [path.join(home, '.claude.json')]: 'CANARY-claude-json',
      };
      for (const [file, canary] of Object.entries(canaries)) fs.writeFileSync(file, canary);
      const quote = (value: string) => JSON.stringify(value);
      const list = (label: string, dir: string) =>
        `printf ${label}[; ls -A ${quote(dir)} 2>/dev/null; printf ]`;
      let returned = '';
      scripted.push(
        (res) =>
          res.end(
            sseCall({
              cmd: [
                'printf PUBLIC-backup-start',
                ...Object.keys(canaries).map((file) => `cat ${quote(file)} 2>/dev/null`),
                list('LIST-HOME', homeBackups),
                list('LIST-ACCOUNT', accountBackups),
                'printf PUBLIC-backup-done',
              ].join('; '),
              login: false,
            })
          ),
        (res, body) => {
          returned = body;
          res.end(sse('backups checked'));
        }
      );
      const bound = vi.fn();
      const events: StreamEvent[] = [];
      for await (const event of makeTransport().runTurn({
        ...request('backup-scope', undefined, {
          settings: { permissionMode: mode, model: 'fake-model' },
        }),
        onThreadBound: bound,
      }))
        events.push(event);
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(bound).toHaveBeenCalledTimes(1);
      expect(shellControlReturned(returned, 'PUBLIC-backup-done')).toBe(true);
      for (const canary of Object.values(canaries)) expect(returned).not.toContain(canary);
      // Hidden whole: the folders list empty, not just their files unreadable.
      expect(shellControlReturned(returned, 'LIST-HOME[]')).toBe(true);
      expect(shellControlReturned(returned, 'LIST-ACCOUNT[]')).toBe(true);
      for (const [file, canary] of Object.entries(canaries))
        expect(fs.readFileSync(file, 'utf8')).toBe(canary);
      protectedStarts[mode]++;
    }
  );

  // The residual Security pinned on #3541: Codex scans from the app-server's
  // own folder (the Codex home) at Full, so a hidden folder under it is not
  // skipped. That must stay a refused start with the sandbox copy, and the
  // hidden file must never surface.
  it.skipIf(process.platform !== 'linux')(
    'refuses Full with the sandbox copy when a hidden folder sits in the Codex home',
    async () => {
      const turn = request('codex-home-hidden', undefined, {
        settings: { permissionMode: 'bypassPermissions', model: 'fake-model' },
      });
      const policy = turn.tools.filePolicy!;
      policy.roots.accounts = [claudeAccount, codexHome];
      completeHostFixture(policy, [
        policy.roots.home,
        policy.roots.data,
        project,
        codexHome,
        claudeAccount,
      ]);
      const hidden = path.join(codexHome, 'backups', FIXTURE_BACKUP_NAME);
      fs.writeFileSync(hidden, 'CANARY-codex-home-backup');
      const starts = turnStartedSeen;
      const responses = seen.responses;
      const { events, bound, printed } = await capturedTurn(turn);
      expect(events.map((event) => event.type)).toEqual(['error', 'done']);
      expect(events[0]).toMatchObject({
        data: {
          code: 'codex_sandbox_unavailable',
          message: expect.stringContaining('This computer blocks Codex’s sandbox.'),
        },
      });
      expect(bound).not.toHaveBeenCalled();
      expect(turnStartedSeen).toBe(starts);
      expect(seen.responses).toBe(responses);
      expect(JSON.stringify(events)).not.toContain('CANARY-codex-home-backup');
      expect(printed).not.toContain('CANARY-codex-home-backup');
      expect(fs.readFileSync(hidden, 'utf8')).toBe('CANARY-codex-home-backup');
    }
  );

  // DOR-3965, pinned: at Full, Codex 0.163 refuses any rg the user can change,
  // so its fallback walker ignores the hidden-folder skips and bwrap cannot
  // build the backup's mask. The start must stay refused, with the sandbox
  // copy, and each place's backup must never surface.
  it.skipIf(process.platform !== 'linux').each([
    { place: 'the home .claude/backups', canary: 'CANARY-full-home-claude' },
    { place: 'the Claude account backups', canary: 'CANARY-full-claude-account' },
    { place: 'the data folder backups', canary: 'CANARY-full-data' },
    { place: 'the home .dork/backups', canary: 'CANARY-full-home-dork' },
  ])('refuses Full while a Claude Code backup sits in $place', async ({ place, canary }) => {
    const home = path.join(root, 'home');
    const folder = {
      'the home .claude/backups': path.join(home, '.claude', 'backups'),
      'the Claude account backups': path.join(claudeAccount, 'backups'),
      'the data folder backups': path.join(root, 'data', 'backups'),
      'the home .dork/backups': path.join(home, '.dork', 'backups'),
    }[place]!;
    const backup = path.join(folder, FIXTURE_BACKUP_NAME);
    fs.writeFileSync(backup, canary);
    // A missing file would make this pass for the wrong reason.
    expect(fs.readFileSync(backup, 'utf8')).toBe(canary);
    const starts = turnStartedSeen;
    const responses = seen.responses;
    const { events, bound, printed } = await capturedTurn(
      request('full-backup', undefined, {
        settings: { permissionMode: 'bypassPermissions', model: 'fake-model' },
      })
    );
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(events[0]).toMatchObject({
      data: {
        code: 'codex_sandbox_unavailable',
        message: expect.stringContaining('This computer blocks Codex’s sandbox.'),
        details: expect.stringContaining(backup),
      },
    });
    expect(JSON.stringify(events)).not.toContain('Send your message again');
    expect(bound).not.toHaveBeenCalled();
    expect(turnStartedSeen).toBe(starts);
    expect(seen.responses).toBe(responses);
    expect(JSON.stringify(events)).not.toContain(canary);
    expect(printed).not.toContain(canary);
    expect(fs.readFileSync(backup, 'utf8')).toBe(canary);
  });

  it.skipIf(process.platform !== 'linux')(
    'keeps a linked backups folder’s target unreadable',
    async () => {
      const home = path.join(root, 'home');
      const link = path.join(home, '.claude', 'backups');
      const target = path.join(root, 'linked-backups');
      fs.rmSync(link, { recursive: true });
      fs.mkdirSync(target);
      const backup = path.join(target, FIXTURE_BACKUP_NAME);
      fs.writeFileSync(backup, 'CANARY-linked-backup');
      fs.symlinkSync(target, link, 'dir');
      const quote = (value: string) => JSON.stringify(value);
      let returned = '';
      scripted.push(
        (res) =>
          res.end(
            sseCall({
              cmd: `cat ${quote(backup)} 2>/dev/null; cat ${quote(path.join(link, FIXTURE_BACKUP_NAME))} 2>/dev/null; printf PUBLIC-linked-done`,
              login: false,
            })
          ),
        (res, body) => {
          returned = body;
          res.end(sse('linked checked'));
        }
      );
      const responses = seen.responses;
      const { events, bound, printed } = await capturedTurn(
        request('backup-linked', undefined, {
          settings: { permissionMode: 'acceptEdits', model: 'fake-model' },
        })
      );
      // Codex refuses a deny path that crosses a link (its own copy, kept as
      // is). No turn starts, and the target is never read or echoed anywhere.
      expect(events.map((event) => event.type)).toEqual(['error', 'done']);
      expect(bound).not.toHaveBeenCalled();
      expect(seen.responses).toBe(responses);
      expect(returned).toBe('');
      expect(JSON.stringify(events)).not.toContain('CANARY-linked-backup');
      expect(printed).not.toContain('CANARY-linked-backup');
      expect(fs.readFileSync(backup, 'utf8')).toBe('CANARY-linked-backup');
    }
  );

  beforeEach(() => {
    scripted.length = 0;
    stallNext = false;
    seen.responses = 0;
    seen.mcpAuthorizations.length = 0;
    seen.resolvedDuringTurn.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-')));
    codexHome = path.join(root, 'codex-home');
    claudeAccount = path.join(root, 'claude-account');
    project = path.join(root, 'project');
    for (const folder of [
      codexHome,
      claudeAccount,
      project,
      path.join(root, 'home'),
      path.join(root, 'data'),
    ])
      fs.mkdirSync(folder, { recursive: true });
    // The throwaway home's provider is the local fake. No key anywhere.
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "fake"',
        'cli_auth_credentials_store = "file"',
        'mcp_oauth_credentials_store = "file"',
        // Keep the fake-server fixture local: Codex's optional remote plugin
        // sync mutates its own clone during our intentionally unbounded scan.
        // File-policy plugin canaries, MCP and .agents skill controls stay on.
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
    const name = expect.getState().currentTestName ?? '';
    if (
      !/protects fake secrets|refuses Full with missing|starts protected mode from a complete home/.test(
        name
      )
    ) {
      const policy = request('complete-fixture', undefined).tools.filePolicy!;
      completeHostFixture(
        policy,
        [policy.roots.home, policy.roots.data, codexHome, claudeAccount],
        {
          withoutClaudeBackups: STARTS_AT_FULL.some((title) => name.includes(title)),
        }
      );
    }
  });

  afterEach(async () => {
    try {
      await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
      scripted.length = 0;
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 120_000);

  afterAll(async () => {
    console.info('Codex native suite teardown requested', {
      senderPid: process.pid,
      atMs: Date.now(),
      poolCount: pools.length,
    });
    await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.info('Codex started protection rows by mode', protectedStarts);
    assertProtectionStarts(protectedStarts);
  }, 60_000);

  it('streams a turn, binds the thread key to it only while it is open, and leaks nothing', async () => {
    const transport = makeTransport();
    const configBefore = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const opened = await principals.openTurn(
      {
        runtime: 'codex',
        canonicalSessionId: 's1',
        agentPath: project,
        canonicalCwd: project,
        signal: new AbortController().signal,
      },
      { isCurrent: () => true }
    );
    const events: StreamEvent[] = [];
    for await (const event of transport.runTurn(request('s1', opened.bindingId)))
      events.push(event);

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(text, JSON.stringify(events)).toBe('pong');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');

    // The dorkos server got the thread key, never the turn bearer.
    expect(seen.mcpAuthorizations.length).toBeGreaterThan(0);
    expect(seen.mcpAuthorizations.every((a) => a.startsWith('Bearer dtk_'))).toBe(true);
    expect(seen.mcpAuthorizations.some((a) => a.includes(opened.bearer))).toBe(false);
    // While the turn was open, the listener resolved it; now it does not.
    expect(seen.resolvedDuringTurn).toContain('runtime');
    const after = await principals.resolve({
      bearer: seen.mcpAuthorizations[0]!.replace(/^Bearer /, ''),
      expectedRuntime: 'codex',
      expectedCanonicalCwd: project,
    });
    expect(after).toEqual({ status: 'refused', reason: 'expired' });

    // Nothing secret in argv or the process environment.
    expect(spawned[0]!.args).toEqual(['app-server', '--listen', 'stdio://']);
    const visible = JSON.stringify(spawned);
    expect(visible).not.toContain(IDENTITY_SECRET);
    expect(visible).not.toContain('dtk_');
    expect(visible).not.toContain(opened.bearer);

    // A writable-mode thread did not write the trust list.
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe(configBefore);
  });

  // Spec §9 asks P1 to RECORD whether a stdio MCP server Codex launches sees
  // the identity token (on exec it inherits the process environment; here the
  // token rides shell_environment_policy.set instead). Either answer is
  // acceptable under spec `agent-trust` §3.1; this pins which one it is.
  it('records whether a stdio MCP server Codex launches sees the identity token', async () => {
    const report = path.join(root, 'stdio-env.json');
    const script = path.join(root, 'stdio-mcp.cjs');
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ sawToken: 'DORKOS_AGENT_TOKEN' in process.env }));`,
        "let buf = '';",
        "process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);",
        '  let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue;',
        "  const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '0' } } : m.method === 'tools/list' ? { tools: [] } : {};",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });",
      ].join('\n')
    );
    const transport = makeTransport();
    const turn = request('s3', undefined, {
      tools: {
        agentTokenEnv: { DORKOS_AGENT_TOKEN: IDENTITY_SECRET },
        managed: { servers: { probe: { command: process.execPath, args: [script] } }, env: {} },
        dorkosTools: null,
        connectorTools: null,
      },
    });
    for await (const _event of transport.runTurn(turn)) {
      // drained
    }
    expect(fs.existsSync(report), 'the stdio MCP server never started').toBe(true);
    // Recorded: the token does NOT reach a stdio MCP server's environment on
    // app-server (it is set for the agent's own shell commands only).
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual({ sawToken: false });
  });

  // A refreshed OAuth header on a managed server reaches a loaded thread by
  // reloading just that thread as a fork (a loaded resume ignores config).
  it('reloads a thread whose managed header value changed, and its MCP server sees the new one', async () => {
    const transport = makeTransport();
    const managed = (value: string) => ({
      servers: { refreshed: { url: `${base}/mcp`, env_http_headers: { Authorization: 'H' } } },
      env: { H: value },
    });
    const bound: string[] = [];
    const turn = (value: string, boundThreadId?: string) =>
      request('s4', undefined, {
        boundThreadId,
        tools: {
          agentTokenEnv: {},
          managed: managed(value),
          dorkosTools: null,
          connectorTools: null,
        },
        onThreadBound: (threadId) => bound.push(threadId),
      });
    for await (const _event of transport.runTurn(turn('Bearer first-oauth'))) {
      // drained
    }
    expect(seen.mcpAuthorizations).toContain('Bearer first-oauth');
    const events: StreamEvent[] = [];
    for await (const event of transport.runTurn(turn('Bearer refreshed-oauth', bound[0])))
      events.push(event);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(seen.mcpAuthorizations).toContain('Bearer refreshed-oauth');
    expect(bound).toHaveLength(2);
    expect(bound[1]).not.toBe(bound[0]);
  });

  it('acknowledges a stop: Codex winds the turn down and the turn ends with one done', async () => {
    const transport = makeTransport();
    stallNext = true;
    const turn = transport.runTurn(request('s2', undefined));
    const events: StreamEvent[] = [];
    // Wait until the provider has the request (the turn is open and waiting).
    const before = seen.responses;
    const reader = (async () => {
      for await (const event of turn) events.push(event);
    })();
    for (let i = 0; i < 300 && seen.responses === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen.responses).toBeGreaterThan(before);
    await expect(transport.interrupt('s2')).resolves.toEqual({
      outcome: 'acked',
      runtime: 'codex',
    });
    await reader;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  describe('Ask first and MCP tools (spec §10)', () => {
    const repoTools = () => ({
      agentTokenEnv: {},
      managed: { servers: { repo: { url: `${base}/repo-mcp` } }, env: {} },
      dorkosTools: null,
      connectorTools: null,
    });
    const callTool = (name: string) =>
      scripted.push(
        (res) => res.end(sseCall({ name: 'prod' }, { name, namespace: 'mcp__repo' })),
        (res) => res.end(sse('done'))
      );

    it('stops before an MCP tool that can change things, on that call’s own card', async () => {
      mcpCalls.length = 0;
      callTool('delete_repo');
      const transport = makeTransport();
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(
        request('mcp-ask', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
          tools: repoTools(),
        })
      )) {
        events.push(event);
        if (event.type === 'approval_required') {
          const card = event.data as { toolCallId: string; toolName: string; input: string };
          expect(card.toolName).toBe('mcp__repo__delete_repo');
          expect(JSON.parse(card.input)).toEqual({ name: 'prod' });
          const start = events.find(
            (e) =>
              e.type === 'tool_call_start' &&
              (e.data as { toolCallId: string }).toolCallId === card.toolCallId
          );
          expect(start, 'the card is the running call’s own').toBeDefined();
          expect(mcpCalls, 'nothing runs before a person answers').toEqual([]);
          expect(transport.answerApproval('mcp-ask', card.toolCallId, true)).toBe(true);
        }
      }
      expect(
        events.some((e) => e.type === 'approval_required'),
        JSON.stringify(events)
      ).toBe(true);
      expect(mcpCalls).toEqual(['delete_repo']);
    });

    it('runs an MCP tool its own server marks read-only without asking', async () => {
      mcpCalls.length = 0;
      callTool('read_file');
      const transport = makeTransport();
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(
        request('mcp-read', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
          tools: repoTools(),
        })
      ))
        events.push(event);
      expect(events.some((e) => e.type === 'approval_required')).toBe(false);
      expect(mcpCalls).toEqual(['read_file']);
    });
  });

  it.for(['app-server', 'exec'] as const)(
    'protects fake secrets through %s despite a loaded legacy Full setting',
    { timeout: 180_000 },
    async (kind) => {
      const control = 'PUBLIC-control-dor3595';
      const skillControl = 'PUBLIC-skill-control-dor3595';
      const agentHome = path.join(root, 'data', 'agents', 'probe');
      fs.mkdirSync(agentHome, { recursive: true });
      const policy = request('complete-protected-probe', undefined).tools.filePolicy!;
      policy.roots.agentHomes = [project, agentHome];
      policy.roots.agentFolders = [project, agentHome];
      // This row walks every level up to Full, which cannot start beside a
      // Claude Code backup on Linux (DOR-3965); the pinned refusal rows cover it.
      const protectedFiles = completeHostFixture(
        policy,
        [policy.roots.home, policy.roots.data, project, agentHome, codexHome, claudeAccount],
        { withoutClaudeBackups: true }
      );
      const skills = path.join(agentHome, '.agents', 'skills', 'probe');
      fs.mkdirSync(skills, { recursive: true });
      fs.writeFileSync(path.join(skills, 'SKILL.md'), skillControl);
      const readable = path.join(project, 'readable.txt');
      fs.writeFileSync(readable, control);
      const probe = protectedProbe(root, project);
      const ownAgentsWrite = path.join(agentHome, '.agents', 'write-probe');
      const configFile = path.join(codexHome, 'config.toml');
      const previous = fs.readFileSync(configFile, 'utf8');
      fs.writeFileSync(configFile, `sandbox_mode = "danger-full-access"\n${previous}`);
      const env = vi.spyOn(runtimeEnv, 'runtimeEnvironment').mockImplementation(() => ({
        PATH: process.env.PATH ?? '',
        HOME: policy.roots.home,
        CODEX_HOME: codexHome,
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
      }));
      try {
        for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
          probe.resetLate();
          const snapshot = () =>
            [...protectedFiles].sort().map((file) => ({
              file,
              contents: fs.readFileSync(file, 'base64'),
              mode: fs.lstatSync(file).mode,
            }));
          const before = snapshot();
          let result = '';
          scripted.push(
            (res) => {
              probe.createLate();
              res.end(
                sseCall({
                  cmd: `${probe.command}; printf PUBLIC-own-agents-write-attempt; printf changed > ${JSON.stringify(ownAgentsWrite)}`,
                  login: false,
                })
              );
            },
            (res, body) => {
              result = body;
              res.end(sse('done'));
            }
          );
          const transport = makeTransport(undefined, kind);
          const bound = vi.fn();
          const events: StreamEvent[] = [];
          try {
            for await (const event of transport.runTurn(
              request(`protected-${kind}-${mode}`, undefined, {
                settings: { permissionMode: mode, model: 'fake-model' },
                onThreadBound: bound,
                tools: {
                  agentTokenEnv: {},
                  managed: { servers: {}, env: {} },
                  dorkosTools: null,
                  connectorTools: null,
                  filePolicy: policy,
                },
              })
            ))
              events.push(event);
            expect(bound).toHaveBeenCalledTimes(1);
            expect(events.some((event) => event.type === 'error')).toBe(false);
            expect(result).toContain(control);
            expect(result).toContain(skillControl);
            for (const marker of probe.attemptMarkers) expect(result).toContain(marker);
            for (const canary of probe.canaries) expect(result).not.toContain(canary);
            expect(fs.readFileSync(probe.plugin, 'utf8')).toBe('original-plugin');
            expect(fs.readFileSync(probe.latePlugin, 'utf8')).toBe('original-late-plugin');
            expect(snapshot()).toEqual(before);
            expect(result).toMatch(/denied|not permitted/i);
            expect(fs.existsSync(ownAgentsWrite)).toBe(false);
            expect(shellControlReturned(result, 'PUBLIC-own-agents-write-attempt')).toBe(true);
            expect(fs.readFileSync(probe.gitWrite, 'utf8')).toBe(
              mode === 'bypassPermissions' ? 'changed-by-full-probe' : 'original-git-control'
            );
            protectedStarts[mode]++;
            console.info('Codex protected thread bound', { kind, mode });
          } finally {
            await transport.shutdown();
            expect(await reconcileMountTargets(policy.roots.data)).toEqual([]);
            expect(
              probeParentKinds([policy.roots.home, policy.roots.data, agentHome, project]).filter(
                ({ kind }) => kind !== 'absent' && kind !== 'directory'
              )
            ).toEqual([]);
          }
        }
      } finally {
        scripted.length = 0;
        env.mockRestore();
        fs.writeFileSync(configFile, previous);
        fs.rmSync(readable, { force: true });
        probe.cleanup();
      }
    }
  );

  describe('approvals and steer (spec §10, §11)', () => {
    const made = () => path.join(project, 'approved.txt');
    const askToWrite = () => {
      scripted.push(
        (res) =>
          res.end(
            sseCall({
              cmd: 'echo approved > approved.txt',
              sandbox_permissions: 'require_escalated',
              justification: 'Create approved.txt?',
              login: false,
            })
          ),
        (res) => res.end(sse('done'))
      );
    };

    it('raises a card for a command that needs approval, and runs it once approved', async () => {
      fs.rmSync(made(), { force: true });
      askToWrite();
      const transport = makeTransport();
      const gen = transport.runTurn(
        request('approve-1', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
        })
      );
      const events: StreamEvent[] = [];
      let answered = false;
      for await (const event of gen) {
        events.push(event);
        if (event.type === 'approval_required' && !answered) {
          answered = true;
          const card = event.data as { toolCallId: string; toolName: string; input: string };
          expect(card.toolName).toBe('Shell');
          expect(card.input).toContain('approved.txt');
          expect(fs.existsSync(made()), 'nothing runs before a person answers').toBe(false);
          expect(transport.answerApproval('approve-1', card.toolCallId, true)).toBe(true);
        }
      }
      expect(answered, JSON.stringify(events)).toBe(true);
      expect(fs.readFileSync(made(), 'utf8').trim()).toBe('approved');
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    });

    it('declines the command when a person denies it, and it never runs', async () => {
      fs.rmSync(made(), { force: true });
      askToWrite();
      const transport = makeTransport();
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(
        request('deny-1', undefined, {
          settings: { permissionMode: 'default', model: 'fake-model' },
        })
      )) {
        events.push(event);
        if (event.type === 'approval_required') {
          const id = (event.data as { toolCallId: string }).toolCallId;
          expect(transport.answerApproval('deny-1', id, false)).toBe(true);
        }
      }
      expect(
        events.some((e) => e.type === 'approval_required'),
        JSON.stringify(events)
      ).toBe(true);
      expect(fs.existsSync(made())).toBe(false);
      const ends = events.filter((e) => e.type === 'tool_call_end');
      expect(ends.at(-1)).toMatchObject({ data: { status: 'error' } });
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    });

    // Codex now restores a thread's saved permissions on a cold resume
    // (openai/codex#53150, #53419). A level a person lowered in DorkOS must
    // still win over the higher one the thread was started at.
    it('asks again after a person lowers Full to Ask and the thread resumes cold', async () => {
      fs.rmSync(made(), { force: true });
      scripted.push((res) => res.end(sse('started at full')));
      const bound: string[] = [];
      const first = makeTransport();
      for await (const event of first.runTurn(
        request('lowered-1', undefined, {
          settings: { permissionMode: 'bypassPermissions', model: 'fake-model' },
          onThreadBound: (threadId) => bound.push(threadId),
        })
      )) {
        void event;
      }
      expect(bound).toHaveLength(1);
      // Cold: the process that knew the thread is gone.
      await pools.at(-1)!.shutdown();

      askToWrite();
      const second = makeTransport();
      const events: StreamEvent[] = [];
      for await (const event of second.runTurn(
        request('lowered-1', undefined, {
          boundThreadId: bound[0],
          settings: { permissionMode: 'default', model: 'fake-model' },
        })
      )) {
        events.push(event);
        if (event.type === 'approval_required') {
          expect(fs.existsSync(made()), 'nothing runs before a person answers').toBe(false);
          const id = (event.data as { toolCallId: string }).toolCallId;
          expect(second.answerApproval('lowered-1', id, false)).toBe(true);
        }
      }
      expect(
        events.some((e) => e.type === 'approval_required'),
        JSON.stringify(events)
      ).toBe(true);
      expect(fs.existsSync(made())).toBe(false);
    });

    it('steers a running turn: the words reach that turn, and no new turn starts', async () => {
      let secondBody = '';
      scripted.push(
        // A long first answer: half now, the rest a while later.
        (res) => {
          const whole = sse('first');
          const cut = whole.indexOf('event: response.output_item.done');
          res.write(whole.slice(0, cut));
          setTimeout(() => res.end(whole.slice(cut)), 1_500);
        },
        (res, body) => {
          secondBody = body;
          res.end(sse('after steer'));
        }
      );
      const transport = makeTransport();
      const startedBefore = turnStartedSeen;
      const gen = transport.runTurn(request('steer-1', undefined));
      const events: StreamEvent[] = [];
      for (;;) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value);
        if (next.value.type === 'text_delta') break;
      }
      await expect(
        transport.deliverIntoTurn('steer-1', 'STEERED-WORDS', {
          mode: 'steer',
          messageId: 'steer-msg-1',
        })
      ).resolves.toEqual({ delivered: true });
      for await (const event of gen) events.push(event);
      const text = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e.data as { text: string }).text)
        .join('');
      expect(text).toContain('after steer');
      expect(secondBody).toContain('STEERED-WORDS');
      expect(turnStartedSeen - startedBefore, 'one turn, steered').toBe(1);
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    });
  });
  describe('background work (spec §12)', () => {
    /** The turn starts `cmd` with a short yield, so it outlives the turn. */
    const startInBackground = (cmd: string) => {
      scripted.push(
        (res) => res.end(sseCall({ cmd, yield_time_ms: 500 })),
        (res) => res.end(sse('started it'))
      );
    };
    const fullAccess = { permissionMode: 'bypassPermissions' as const, model: 'fake-model' };
    const collect = (transport: AppServerCodexTransport): BackgroundWake[] => {
      const wakes: BackgroundWake[] = [];
      transport.onWake((wake) => {
        wakes.push(wake);
        return true;
      });
      return wakes;
    };
    const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return check();
    };
    const run = async (transport: AppServerCodexTransport, sessionId: string) => {
      const events: StreamEvent[] = [];
      for await (const event of transport.runTurn(
        request(sessionId, undefined, { settings: fullAccess })
      )) {
        events.push(event);
      }
      return events;
    };

    it('wakes the chat exactly once when a command finishes after its turn completed', async () => {
      startInBackground('sleep 2; echo done-in-background');
      const transport = makeTransport();
      const wakes = collect(transport);
      const events = await run(transport, 'bg-1');
      const started = events.find((e) => e.type === 'background_task_started');
      expect(started, JSON.stringify(events)).toBeDefined();
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(transport.holdsBackgroundWork('bg-1')).toBe(true);
      expect(wakes).toHaveLength(0);
      const responsesAtTurnEnd = seen.responses;

      expect(await waitFor(() => wakes.length > 0, 15_000)).toBe(true);
      expect(wakes[0]).toMatchObject({ sessionId: 'bg-1', startTurn: true, notices: [] });
      expect(wakes[0]!.completions).toHaveLength(1);
      expect(wakes[0]!.completions[0]).toMatchObject({
        taskId: (started!.data as { taskId: string }).taskId,
        status: 'completed',
        wakes: true,
      });
      expect(wakes[0]!.completions[0]!.summary).toContain('done-in-background');
      // Nothing more comes, and Codex starts no turn of its own.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(wakes).toHaveLength(1);
      expect(seen.responses).toBe(responsesAtTurnEnd);
      expect(transport.holdsBackgroundWork('bg-1')).toBe(false);
    }, 60_000);

    it('never wakes for a command that never ends, and Stop terminates it without a model turn', async () => {
      startInBackground('sleep 600');
      const transport = makeTransport();
      const wakes = collect(transport);
      const events = await run(transport, 'bg-2');
      const taskId = (
        events.find((e) => e.type === 'background_task_started')!.data as { taskId: string }
      ).taskId;
      await new Promise((r) => setTimeout(r, 3_000));
      expect(wakes).toHaveLength(0);
      expect(transport.holdsBackgroundWork('bg-2')).toBe(true);

      expect(await transport.stopTask('bg-2', taskId)).toEqual({
        outcome: 'acked',
        runtime: 'codex',
      });
      expect(await waitFor(() => wakes.length > 0, 10_000)).toBe(true);
      expect(wakes[0]).toMatchObject({ startTurn: false });
      expect(wakes[0]!.completions[0]).toMatchObject({ taskId, status: 'stopped', wakes: false });
      await new Promise((r) => setTimeout(r, 2_000));
      expect(wakes).toHaveLength(1);
      expect(transport.holdsBackgroundWork('bg-2')).toBe(false);
    }, 60_000);

    it('stops a never-ending command once at the ceiling, and still wakes no model turn', async () => {
      startInBackground('sleep 600');
      const transport = makeTransport({ ceilingMs: 2_000 });
      const wakes = collect(transport);
      await run(transport, 'bg-3');
      expect(await waitFor(() => wakes.length > 0, 10_000)).toBe(true);
      expect(wakes[0]).toMatchObject({ startTurn: false });
      expect(wakes[0]!.completions[0]).toMatchObject({ status: 'stopped', wakes: false });
      await new Promise((r) => setTimeout(r, 4_500));
      expect(wakes).toHaveLength(1);
    }, 60_000);
  });
});
