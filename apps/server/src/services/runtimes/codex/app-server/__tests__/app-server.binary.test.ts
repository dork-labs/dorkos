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
import { codexProtectedConfig } from '../../policy/protected-profile.js';
import { killFixtureWithRealLeak } from './fixtures/mount-recovery-probe.js';
import { reconcileMountTargets } from '../../policy/reconcile-mount-targets.js';
import { readMountTargets, recordMountTargets } from '../../policy/mount-target-ledger.js';
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
import { createCodexTransport, type CodexTransportKind } from '../../transport/index.js';
import * as runtimeEnv from '../../../shared/runtime-environment-config.js';
import type { BackgroundWake } from '../background-work.js';
import { createCodexEventContext } from '../../event-mapper.js';
import { ConnectorThreadKeyRegistry } from '../../../../connectors/principal/thread-keys.js';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimeTools } from '../../../connector-tools.js';
import type { CodexTurnRequest } from '../../transport/codex-transport.js';
import type { AppServerTransportOptions } from '../../transport/app-server-transport.js';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  protectedProbe,
  shellControlReturned,
  probeParentKinds,
  startProbeScanRace,
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
  setting: CodexTransportKind = 'app-server',
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
  return createCodexTransport(setting, {
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
          accounts: [codexHome],
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

  beforeEach(() => {
    scripted.length = 0;
    stallNext = false;
    seen.responses = 0;
    seen.mcpAuthorizations.length = 0;
    seen.resolvedDuringTurn.length = 0;
    const scenario = process.env.DORKOS_CODEX_PROBE_SCENARIO;
    if (scenario) {
      expect(process.env.CI).toBe('true');
      expect(process.platform).toBe('linux');
    }
    // Every native test gets its own root; recovery rows still retain raw host checks.
    let baseFolder = os.tmpdir();
    if (scenario === 'outside-tmp-10k') {
      baseFolder = path.resolve('.temp');
      fs.mkdirSync(baseFolder, { recursive: true });
      expect(fs.realpathSync(baseFolder).startsWith(fs.realpathSync(os.tmpdir()) + '/')).toBe(
        false
      );
    }
    root = fs.realpathSync(fs.mkdtempSync(path.join(baseFolder, 'codex-app-server-')));
    codexHome = path.join(root, 'codex-home');
    project = path.join(root, 'project');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    if (scenario === 'person-symlink-10k') {
      fs.mkdirSync(path.join(root, 'real-person-home'));
      fs.symlinkSync(path.join(root, 'real-person-home'), path.join(root, 'home'), 'dir');
    } else fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    if (scenario === 'person-root-link-10k') {
      fs.rmdirSync(path.join(root, 'home'));
      fs.mkdirSync(path.join(root, 'real-person-home'));
      fs.symlinkSync(path.join(root, 'real-person-home'), path.join(root, 'home'), 'dir');
      fs.chmodSync(root, 0o755);
      for (const args of [
        ['-h', '0:0', path.join(root, 'home')],
        ['0:0', root],
      ]) {
        const result = nodeSpawnSync('sudo', ['-n', 'chown', ...args], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
      }
      console.info('Codex root-owned home alias', {
        HOME: path.join(root, 'home'),
        realHome: fs.realpathSync(path.join(root, 'home')),
        parentUid: fs.lstatSync(root).uid,
        linkUid: fs.lstatSync(path.join(root, 'home')).uid,
      });
    }
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
  });

  afterEach(async () => {
    try {
      await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
      scripted.length = 0;
    } finally {
      if (process.env.DORKOS_CODEX_PROBE_SCENARIO === 'person-root-link-10k') {
        const restored = nodeSpawnSync(
          'sudo',
          ['-n', 'chown', `${process.getuid?.()}:${process.getgid?.()}`, root],
          { encoding: 'utf8' }
        );
        expect(restored.status, restored.stderr).toBe(0);
      }
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
      const scenario = process.env.DORKOS_CODEX_PROBE_SCENARIO;
      const ownSymlink = scenario === 'agent-symlink-10k';
      const defaultStub = scenario === 'default-stub-10k';
      const defaultRecovery = scenario === 'reconcile-default-10k';
      const recoveryTargets = [
        path.join(root, 'home', '.claude'),
        path.join(root, 'home', '.config'),
      ];
      const nonemptyLedger = scenario === 'nonempty-ledger-10k';
      const skillDiscovery = scenario === 'skill-discovery-10k';
      const ownHomeCwd = scenario === 'agent-home-10k' || ownSymlink;
      const otherHomeProbe = scenario === 'other-home-10k';
      const control = 'PUBLIC-control-dor3595';
      const skillControl = 'PUBLIC-skill-control-dor3595';
      const agentHome = path.join(root, 'data', 'agents', 'probe');
      const personHome = path.join(root, 'home');
      const probeCwd = ownHomeCwd
        ? agentHome
        : scenario === 'person-cwd-10k'
          ? personHome
          : project;
      const otherHome = path.join(root, 'data', 'agents', 'unregistered-other');
      const otherSkill = path.join(otherHome, '.agents', 'skills', 'other', 'SKILL.md');
      const otherSkillMarker = 'PUBLIC-other-agent-skill-dor3595';
      const otherWrite = path.join(otherHome, '.agents', 'write-probe');
      if (otherHomeProbe) {
        fs.mkdirSync(path.dirname(otherSkill), { recursive: true });
        fs.writeFileSync(otherSkill, otherSkillMarker);
      }
      const readable = path.join(probeCwd, 'readable.txt');
      const ownAgentsWrite = path.join(agentHome, '.agents', 'write-probe');
      const skills = path.join(agentHome, '.agents', 'skills', 'probe');
      fs.mkdirSync(skills, { recursive: true });
      fs.writeFileSync(
        path.join(skills, 'SKILL.md'),
        `---\nname: dor3595-public-probe\ndescription: PUBLIC-auto-skill-desc-dor3595\n---\n${skillControl}\n`
      );
      fs.writeFileSync(readable, control);
      // Diagnostic sizes are armed only by the CI step; normal proof stays 10k.
      const selectedMode = process.env.DORKOS_CODEX_PROBE_MODE;
      if (scenario || selectedMode) {
        expect(process.env.CI).toBe('true');
        expect(process.platform).toBe('linux');
        expect([
          'home-10k',
          'home-500k',
          'cwd-500k',
          'agent-home-10k',
          'agent-symlink-10k',
          'other-home-10k',
          'person-cwd-10k',
          'person-symlink-10k',
          'outside-tmp-10k',
          'kill-midturn-10k',
          'default-stub-10k',
          'nonempty-ledger-10k',
          'reconcile-leak-10k',
          'reconcile-default-10k',
          'concurrent-ledger-10k',
          'person-root-link-10k',
          'skill-discovery-10k',
          'new-agent-fork-10k',
          'rg-unreadable-10k',
          'rg-vanishing-10k',
        ]).toContain(scenario);
        expect(['default', 'acceptEdits', 'bypassPermissions']).toContain(selectedMode);
        if (ownHomeCwd) expect(['acceptEdits', 'bypassPermissions']).toContain(selectedMode);
        if (ownSymlink || scenario === 'person-cwd-10k' || scenario === 'kill-midturn-10k')
          expect(selectedMode).toBe('acceptEdits');
        if (otherHomeProbe) expect(['acceptEdits', 'bypassPermissions']).toContain(selectedMode);
        if (skillDiscovery || scenario === 'person-root-link-10k' || nonemptyLedger)
          expect(['acceptEdits', 'bypassPermissions']).toContain(selectedMode);
        if (scenario === 'reconcile-leak-10k' || scenario === 'concurrent-ledger-10k')
          expect(selectedMode).toBe('acceptEdits');
        if (scenario === 'new-agent-fork-10k') expect(selectedMode).toBe('bypassPermissions');
        if (defaultStub || scenario?.startsWith('rg-')) expect(selectedMode).toBe('default');
        if (defaultRecovery) expect(selectedMode).toBe('default');
      }
      const size = {
        homeFiles: scenario === 'home-500k' ? 500_000 : 10_000,
        cwdFiles: scenario === 'cwd-500k' ? 500_000 : 0,
      };
      const fixtureStarted = performance.now();
      if (ownHomeCwd) expect(fs.existsSync(path.join(agentHome, '.claude'))).toBe(false);
      if (otherHomeProbe) expect(fs.existsSync(path.join(otherHome, '.claude'))).toBe(false);
      for (const name of ['.config', '.docker'])
        expect(fs.existsSync(path.join(root, 'home', name))).toBe(false);
      const probe = protectedProbe(
        root,
        probeCwd,
        size,
        ownHomeCwd,
        otherHomeProbe ? otherHome : undefined
      );
      // Model leaked mount targets as files, not missing directories. Only
      // these two planted paths may be files in this diagnostic's host check.
      const stubFiles = defaultStub
        ? ['.claude', '.config'].map((name) => path.join(personHome, name))
        : nonemptyLedger
          ? [path.join(personHome, '.claude')]
          : [];
      const stubSnapshot = (file: string) => {
        const stat = fs.lstatSync(file);
        return {
          regular: stat.isFile(),
          size: stat.size,
          uid: stat.uid,
          mode: stat.mode,
          ino: stat.ino,
          dev: stat.dev,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          contents: fs.readFileSync(file, 'utf8'),
        };
      };
      const preservedAfterCrash = new Map<string, ReturnType<typeof stubSnapshot>>();
      if (nonemptyLedger) {
        const capture = request('capture-nonempty', undefined);
        codexProtectedConfig(capture.cwd, capture.tools.filePolicy, capture.settings, (targets) =>
          recordMountTargets(path.join(root, 'data'), targets)
        );
      }
      for (const file of stubFiles)
        fs.writeFileSync(file, nonemptyLedger ? 'PERSON-nonempty-synthetic' : '', { flag: 'wx' });
      const stubsBefore = stubFiles.map(stubSnapshot);
      const grantLink = path.join(agentHome, '.claude');
      const grantInitial = path.join(agentHome, 'self-grant-initial');
      const grantSwap = path.join(agentHome, 'self-grant-swap');
      if (ownSymlink) {
        fs.mkdirSync(grantInitial);
        fs.mkdirSync(grantSwap);
        fs.symlinkSync(grantInitial, grantLink, 'dir');
      }
      const fixtureMs = performance.now() - fixtureStarted;
      const unreadable = path.join(root, 'home', 'rg-unreadable');
      if (scenario === 'rg-unreadable-10k') {
        expect(process.getuid?.()).not.toBe(0);
        fs.mkdirSync(unreadable);
        fs.writeFileSync(path.join(unreadable, '.env'), 'FAKE-unreadable-canary');
        fs.chmodSync(unreadable, 0o000);
      }
      console.info('Codex protected fixture ready', { kind, selectedMode, ...size, fixtureMs });
      const configFile = path.join(codexHome, 'config.toml');
      const previous = fs.readFileSync(configFile, 'utf8');
      fs.writeFileSync(configFile, `sandbox_mode = "danger-full-access"\n${previous}`);
      const env = vi.spyOn(runtimeEnv, 'runtimeEnvironment').mockImplementation(() => ({
        PATH: process.env.PATH ?? '',
        HOME: path.join(root, 'home'),
        CODEX_HOME: codexHome,
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
      }));
      try {
        for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
          if (selectedMode && mode !== selectedMode) continue;
          let result = '';
          let startMs: number | undefined;
          const shellRoundTripMs: number[] = [];
          const shellControls: boolean[] = [];
          let shellStarted = 0;
          const started = performance.now();
          probe.resetLate();
          const race =
            scenario === 'rg-vanishing-10k'
              ? await startProbeScanRace(path.join(root, 'home'))
              : undefined;
          try {
            if (
              scenario === 'reconcile-leak-10k' ||
              defaultRecovery ||
              scenario === 'concurrent-ledger-10k'
            ) {
              const target = path.join(personHome, '.claude');
              expect(fs.existsSync(target)).toBe(false);
              if (defaultRecovery)
                for (const file of recoveryTargets) expect(fs.existsSync(file)).toBe(false);
              let victimChild: ReturnType<typeof nodeSpawn> | undefined;
              let work: Promise<void> | undefined;
              let ready = false;
              const victim = makeTransport(undefined, kind, (child) => {
                victimChild = child;
              });
              scripted.push(
                (res) =>
                  res.end(
                    sseCall({
                      cmd: `printf PUBLIC-recovery-ready; sleep ${defaultRecovery || scenario === 'concurrent-ledger-10k' ? 60 : 5}`,
                      login: false,
                      yield_time_ms: 1000,
                    })
                  ),
                (res, body) => {
                  ready = shellControlReturned(body, 'PUBLIC-recovery-ready');
                  work = (async () => {
                    expect(ready).toBe(true);
                    if (scenario === 'reconcile-leak-10k' || defaultRecovery) {
                      expect(victimChild?.pid).toBeDefined();
                      const targets = defaultRecovery ? recoveryTargets : [target];
                      const recorded = readMountTargets(path.join(root, 'data'));
                      for (const file of targets) expect(recorded).toContain(file);
                      await killFixtureWithRealLeak(victimChild!.pid!, targets);
                    } else {
                      const before = fs.lstatSync(target);
                      expect(before.isFile()).toBe(true);
                      await expect(reconcileMountTargets(path.join(root, 'data'))).resolves.toEqual(
                        []
                      );
                      expect(fs.lstatSync(target).ino).toBe(before.ino);
                      console.info('Codex live sandbox blocked target removal', { target });
                      // Use another real production transport while the first
                      // command still owns this host placeholder. A direct
                      // reconcile call alone cannot prove turn availability.
                      const peer = makeTransport(undefined, kind);
                      let peerControl = false;
                      scripted.push(
                        (response) =>
                          response.end(
                            sseCall({
                              cmd: 'printf PUBLIC-concurrent-peer',
                              login: false,
                            })
                          ),
                        (response, body) => {
                          peerControl = shellControlReturned(body, 'PUBLIC-concurrent-peer');
                          response.end(sse('concurrent peer finished'));
                        }
                      );
                      try {
                        const peerEvents = [];
                        for await (const event of peer.runTurn(
                          request('concurrent-peer', undefined, {
                            settings: { permissionMode: mode, model: 'fake-model' },
                          })
                        ))
                          peerEvents.push(event);
                        expect(peerControl).toBe(true);
                        expect(peerEvents.some((event) => event.type === 'error')).toBe(false);
                        expect(fs.lstatSync(target).ino).toBe(before.ino);
                      } finally {
                        await peer.shutdown();
                      }
                    }
                  })();
                  void work.then(
                    () => res.end(sse('recovery victim finished')),
                    () => res.end(sse('recovery fixture failed'))
                  );
                }
              );
              try {
                try {
                  for await (const event of victim.runTurn(
                    request('recovery-victim', undefined, {
                      settings: {
                        // Produce the host placeholders under Full, then
                        // prove that default can run with ambiguous files preserved.
                        permissionMode: defaultRecovery ? 'bypassPermissions' : mode,
                        model: 'fake-model',
                      },
                    })
                  ))
                    void event;
                } catch (error) {
                  if ((!defaultRecovery && scenario !== 'reconcile-leak-10k') || !ready || !work)
                    throw error;
                  console.info('Codex recovery victim exited during its turn', String(error));
                }
                await work;
                expect(ready).toBe(true);
              } finally {
                if (scenario === 'concurrent-ledger-10k')
                  await Promise.all(pools.map((pool) => pool.closeWhere(() => true)));
                await victim.shutdown();
              }
              scripted.length = 0;
              if (defaultRecovery) {
                // Leave real recorded crash leftovers for the NEXT production
                // runTurn/default to reconcile, without test-side removal.
                for (const file of recoveryTargets) {
                  const leftover = fs.lstatSync(file);
                  expect(leftover.isFile()).toBe(true);
                  expect(leftover.size).toBe(0);
                }
                console.info(
                  'Codex listed crash targets awaiting default preservation',
                  recoveryTargets
                );
              }
              if (scenario === 'reconcile-leak-10k') {
                expect(fs.lstatSync(target).isFile()).toBe(true);
                const removed = await reconcileMountTargets(path.join(root, 'data'));
                expect(removed).toEqual([]);
                expect(fs.lstatSync(target).isFile()).toBe(true);
                console.info('Codex real crash leftover preserved without creation identity', {
                  target,
                  removed,
                });
              }
            }
            if (defaultRecovery || scenario === 'reconcile-leak-10k') {
              const listed = new Set(readMountTargets(path.join(root, 'data')));
              for (const { file, kind } of probeParentKinds([
                personHome,
                path.join(root, 'data'),
                agentHome,
                probeCwd,
              ])) {
                if (kind !== 'file') continue;
                expect(listed.has(file)).toBe(true);
                const snapshot = stubSnapshot(file);
                expect(snapshot.regular).toBe(true);
                expect(snapshot.size).toBe(0);
                expect(snapshot.uid).toBe(process.getuid?.());
                preservedAfterCrash.set(file, snapshot);
              }
              expect(preservedAfterCrash.size).toBeGreaterThan(0);
            }
            if (scenario === 'new-agent-fork-10k') {
              const historyTransport = makeTransport(undefined, kind);
              const bindings: Array<{ id: string; replaces?: string }> = [];
              const onThreadBound = (id: string, replaces?: string) =>
                bindings.push({ id, replaces });
              scripted.push((res) => res.end(sse('PUBLIC-history-before-new-home')));
              for await (const event of historyTransport.runTurn(
                request('home-fork', undefined, {
                  settings: { permissionMode: mode, model: 'fake-model' },
                  onThreadBound,
                })
              ))
                void event;
              expect(bindings).toHaveLength(1);
              fs.mkdirSync(path.join(root, 'data', 'agents', 'new-after-turn'), {
                recursive: true,
              });
              let retained = false;
              scripted.push((res, body) => {
                retained = body.includes('PUBLIC-history-before-new-home');
                res.end(sse('new-home fork complete'));
              });
              for await (const event of historyTransport.runTurn(
                request('home-fork', undefined, {
                  boundThreadId: bindings[0]!.id,
                  settings: { permissionMode: mode, model: 'fake-model' },
                  onThreadBound,
                })
              ))
                void event;
              expect(retained).toBe(true);
              expect(bindings).toHaveLength(2);
              expect(bindings[1]!.id).not.toBe(bindings[0]!.id);
              expect(bindings[1]!.replaces).toBe(bindings[0]!.id);
              console.info('Codex new agent folder fork retained history', {
                bindings,
                retained,
              });
              await historyTransport.shutdown();
              scripted.length = 0;
            }
            if (scenario === 'kill-midturn-10k') {
              // Kill only this fixture's exact child, after a real shell output
              // proves it reached a running command. Never kill by process name.
              expect(fs.existsSync(path.join(personHome, '.claude'))).toBe(false);
              let victimChild: ReturnType<typeof nodeSpawn> | undefined;
              let exit: Promise<string | null> | undefined;
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
                  if (ready) {
                    const signal = {
                      source: 'kill-midturn-10k',
                      senderPid: process.pid,
                      targetPid: victimChild?.pid,
                      signal: 'SIGKILL',
                      atMs: Date.now(),
                    };
                    console.info('Codex native probe signal requested', signal);
                    killed = victimChild?.kill('SIGKILL') ?? false;
                    console.info('Codex native probe signal sent', { ...signal, sent: killed });
                  }
                  res.end(sse('victim stopped'));
                }
              );
              const victim = makeTransport(undefined, kind, (child) => {
                victimChild = child;
                exit = new Promise((resolve) =>
                  child.once('exit', (_code, signal) => resolve(signal))
                );
              });
              try {
                const victimEvents: StreamEvent[] = [];
                try {
                  for await (const event of victim.runTurn(
                    request(`kill-${kind}`, undefined, {
                      settings: { permissionMode: mode, model: 'fake-model' },
                    })
                  ))
                    victimEvents.push(event);
                } catch (error) {
                  console.info('Codex killed victim turn error', String(error));
                }
                expect(ready, JSON.stringify(victimEvents)).toBe(true);
                expect(killed).toBe(true);
                const signal = await exit;
                const parents = probeParentKinds([personHome, path.join(root, 'data'), agentHome]);
                console.info('Codex host parent kinds after SIGKILL before shutdown', {
                  kind,
                  scenario,
                  signal,
                  parents,
                });
                expect(signal).toBe('SIGKILL');
                expect(
                  parents.filter(({ kind }) => kind !== 'absent' && kind !== 'directory')
                ).toEqual([]);
              } finally {
                await victim.shutdown();
              }
              // The victim is dead; the next launch must consume a fresh turn.
              scripted.length = 0;
            }
            scripted.push(
              (res, body) => {
                if (skillDiscovery) {
                  expect(body).toContain('PUBLIC-auto-skill-desc-dor3595');
                  console.info('Codex automatic skill discovery reached the model at mode', mode);
                }
                // The provider is called only after the thread has started.
                probe.createLate();
                const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
                let command = ownSymlink
                  ? `ln -sfn ${quote(grantSwap)} ${quote(grantLink)}; ${probe.command}`
                  : probe.command;
                command += `; printf PUBLIC-own-agents-write-attempt; printf changed > ${quote(ownAgentsWrite)}`;
                if (otherHomeProbe)
                  command += `; printf PUBLIC-other-agents-write-attempt; printf changed > ${quote(otherWrite)}; cat ${quote(otherSkill)}`;
                res.end(sseCall({ cmd: command, login: false }));
              },
              (res, body) => {
                result = body;
                if (scenario) {
                  shellStarted = performance.now();
                  res.end(sseCall({ cmd: 'printf PUBLIC-shell-control-0', login: false }));
                } else res.end(sse('done'));
              }
            );
            if (scenario) {
              for (let index = 0; index < 3; index++) {
                scripted.push((res, body) => {
                  shellRoundTripMs.push(performance.now() - shellStarted);
                  shellControls.push(shellControlReturned(body, `PUBLIC-shell-control-${index}`));
                  console.info('Codex protected shell completed', {
                    kind,
                    mode,
                    ...size,
                    index,
                    shellRoundTripMs: shellRoundTripMs[index],
                    shellControlReturned: shellControls[index],
                  });
                  if (index === 2) res.end(sse('done'));
                  else {
                    shellStarted = performance.now();
                    res.end(
                      sseCall({ cmd: `printf PUBLIC-shell-control-${index + 1}`, login: false })
                    );
                  }
                });
              }
            }
            const transport = makeTransport(undefined, kind);
            if (skillDiscovery) {
              // Pinned 0.163 protocol; do not preload skills/list before the turn.
              const proc = await pools.at(-1)!.acquire({
                binary: BINARY!,
                codexHome,
                env: {
                  PATH: '/usr/bin:/bin',
                  HOME: personHome,
                  CODEX_HOME: codexHome,
                },
              });
              const rpc = proc.client as unknown as {
                request(method: string, params: unknown): Promise<unknown>;
              };
              await rpc.request('skills/extraRoots/set', {
                extraRoots: [path.join(agentHome, '.agents', 'skills')],
              });
            }
            expect(transport.kind).toBe('app-server');
            const events: StreamEvent[] = [];
            for await (const event of transport.runTurn(
              request(`protected-${kind}-${mode}`, undefined, {
                cwd: probeCwd,
                settings: { permissionMode: mode, model: 'fake-model' },
                onThreadBound: () => {
                  if (defaultRecovery)
                    for (const file of recoveryTargets)
                      expect(fs.lstatSync(file).isFile()).toBe(true);
                  startMs = performance.now() - started;
                  console.info('Codex protected thread bound', { kind, mode, ...size, startMs });
                },
                writableDirectories: [probeCwd],
                tools: {
                  agentTokenEnv: {},
                  managed: { servers: {}, env: {} },
                  dorkosTools: null,
                  connectorTools: null,
                  filePolicy: {
                    writable: [probeCwd],
                    roots: {
                      cwd: probeCwd,
                      data: path.join(root, 'data'),
                      home: path.join(root, 'home'),
                      accounts: [codexHome],
                      agentFolders: [probeCwd, agentHome],
                      agentHomes: [...new Set([probeCwd, agentHome])],
                    },
                  },
                },
              })
            ))
              events.push(event);
            console.info('Codex protected probe', {
              kind,
              mode,
              scenario,
              launchOutcome: startMs === undefined ? 'refused' : 'started',
              refusalEvents: startMs === undefined ? events : [],
              ...size,
              fixtureMs,
              startMs,
              shellRoundTripMs,
              shellControls,
              projectGitWritable:
                fs.readFileSync(probe.gitWrite, 'utf8') === 'changed-by-full-probe',
              ownHomeCwd,
              otherHomeProbe,
              otherHomeClaudePresent:
                otherHomeProbe && fs.existsSync(path.join(otherHome, '.claude')),
              selfGrantTargetsPresent: ownHomeCwd
                ? probe.selfGrantTargets.map((file) => fs.existsSync(file))
                : [],
              lateSecretReadable: result.includes(probe.lateCanary),
              latePluginChanged:
                fs.existsSync(probe.latePlugin) &&
                fs.readFileSync(probe.latePlugin, 'utf8') !== 'original-late-plugin',
            });
            if (nonemptyLedger || defaultStub) {
              expect(startMs).toBeUndefined();
              const refusal = events.find((event) => event.type === 'error');
              expect(refusal).toMatchObject({
                data: { code: 'codex_protected_path_not_directory' },
              });
              const message =
                refusal && 'message' in refusal.data ? refusal.data.message : undefined;
              expect(
                stubFiles.some(
                  (file) =>
                    message === `Codex needs ${file} to be a folder. Rename the file, then retry.`
                )
              ).toBe(true);
              expect(shellControls).toEqual([]);
              expect(stubFiles.map(stubSnapshot)).toEqual(stubsBefore);
              console.info('Codex unproven target preserved and launch refused', {
                mode,
                file: stubFiles[0],
              });
              await transport.shutdown();
              continue;
            }
            if (
              (scenario === 'person-cwd-10k' || scenario === 'person-root-link-10k') &&
              startMs === undefined
            ) {
              const refusal = JSON.stringify(events);
              if (scenario === 'person-cwd-10k') {
                expect(refusal).toContain('.aws');
                expect(refusal).toMatch(/invalid argument|not a directory|mount|bwrap/i);
              } else expect(refusal).toContain('crosses writable symlink');
              for (const canary of probe.canaries) expect(refusal).not.toContain(canary);
              console.info('Codex known Linux layout refusal', { scenario, mode, refusal });
              await transport.shutdown();
              continue;
            }
            if (ownSymlink && startMs === undefined) {
              const refusal = JSON.stringify(events);
              console.info('Codex writable self-grant link refused; person sees', refusal);
              // Only the specific writable-symlink safeguard satisfies this row.
              // An unrelated startup error or missing report is not protection proof.
              expect(refusal).toContain('crosses writable symlink');
              expect(refusal).toContain(grantLink);
              expect(fs.readlinkSync(grantLink)).toBe(grantInitial);
              expect(fs.readdirSync(grantInitial)).toEqual([]);
              expect(fs.readdirSync(grantSwap)).toEqual([]);
              for (const target of probe.grantTargets)
                expect(() => fs.lstatSync(target)).toThrow(
                  expect.objectContaining({ code: 'ENOENT' })
                );
              console.info('Codex protected row shutdown requested', {
                kind,
                mode,
                scenario,
                senderPid: process.pid,
                atMs: Date.now(),
                refused: true,
              });
              await transport.shutdown();
              continue;
            }
            expect(startMs, JSON.stringify(events)).toBeDefined();
            if (defaultRecovery) {
              for (const file of recoveryTargets)
                expect(stubSnapshot(file)).toEqual(preservedAfterCrash.get(file));
              console.info(
                'Codex default turn ran with real listed targets preserved through before-load reconciliation',
                recoveryTargets
              );
            }
            if (scenario) expect(shellControls).toEqual([true, true, true]);
            expect(result, JSON.stringify(events)).toContain(control);
            expect(result, JSON.stringify(events)).toContain(skillControl);
            for (const marker of probe.attemptMarkers) expect(result).toContain(marker);
            for (const target of probe.grantTargets)
              expect(() => fs.lstatSync(target)).toThrow(
                expect.objectContaining({ code: 'ENOENT' })
              );
            for (const canary of probe.canaries) expect(result).not.toContain(canary);
            expect(fs.readFileSync(probe.plugin, 'utf8')).toBe('original-plugin');
            expect(fs.readFileSync(probe.latePlugin, 'utf8')).toBe('original-late-plugin');
            expect(result).toMatch(/denied|not permitted/i);
            if (ownHomeCwd) {
              if (!ownSymlink)
                expect(() => fs.lstatSync(path.join(agentHome, '.claude'))).toThrow(
                  expect.objectContaining({ code: 'ENOENT' })
                );
              for (const target of probe.selfGrantTargets)
                expect(() => fs.lstatSync(target)).toThrow(
                  expect.objectContaining({ code: 'ENOENT' })
                );
            }
            // Pin Full's project Git authority separately from the exact root
            // metadata overrides. CI must prove this, not infer it from :root.
            if (mode === 'bypassPermissions')
              expect(fs.readFileSync(probe.gitWrite, 'utf8')).toBe('changed-by-full-probe');
            else expect(fs.readFileSync(probe.gitWrite, 'utf8')).toBe('original-git-control');
            expect(fs.existsSync(ownAgentsWrite)).toBe(false);
            expect(shellControlReturned(result, 'PUBLIC-own-agents-write-attempt')).toBe(true);
            if (otherHomeProbe) {
              expect(fs.readdirSync(otherHome)).toEqual(['.agents']);
              expect(fs.readFileSync(otherSkill, 'utf8')).toBe(otherSkillMarker);
              expect(fs.existsSync(otherWrite)).toBe(false);
              expect(shellControlReturned(result, 'PUBLIC-other-agents-write-attempt')).toBe(true);
              expect(shellControlReturned(result, otherSkillMarker)).toBe(true);
              const blocked = ['.claude', '.dork'].map((name) => path.join(otherHome, name));
              for (const file of blocked)
                fs.writeFileSync(file, 'PERSON-file-must-survive', { flag: 'wx', mode: 0o600 });
              const snapshots = blocked.map(stubSnapshot);
              const own = makeTransport(undefined, kind);
              const peer = makeTransport(undefined, kind);
              try {
                const ownBound = vi.fn();
                const ownEvents: StreamEvent[] = [];
                const policy = request('isolation-base', undefined).tools.filePolicy!;
                for await (const event of own.runTurn(
                  request('isolation-owner-a', undefined, {
                    settings: { permissionMode: mode, model: 'fake-model' },
                    onThreadBound: ownBound,
                    tools: {
                      ...request('isolation-tools', undefined).tools,
                      filePolicy: {
                        ...policy,
                        roots: {
                          ...policy.roots,
                          agentFolders: [project, otherHome],
                          agentHomes: [otherHome],
                        },
                      },
                    },
                  })
                ))
                  ownEvents.push(event);
                expect(ownBound).not.toHaveBeenCalled();
                expect(ownEvents.find((event) => event.type === 'error')).toMatchObject({
                  data: {
                    code: 'codex_protected_path_not_directory',
                    message: `Codex needs ${blocked[0]} to be a folder. Rename the file, then retry.`,
                  },
                });
                const attempts = ['write', 'unlink', 'rename', 'replace', 'chmod', 'hardlink'];
                const markers = blocked.flatMap((_, index) =>
                  attempts.map((op) => `PUBLIC-isolation-${index}-${op}-refused`)
                );
                const replacement = path.join(project, 'isolation-replacement');
                const alias = path.join(otherHome, 'isolation-alias');
                const script = `python3 - <<'PYISOLATION'\nimport os\nfiles = ${JSON.stringify(blocked)}\nreplacement = ${JSON.stringify(replacement)}\nalias = ${JSON.stringify(alias)}\nopen(replacement, 'w').write('PUBLIC-replacement')\ncontrol = os.path.join(os.path.dirname(files[0]), 'isolation-public-control')\nopen(control, 'w').write('PUBLIC-control')\nos.rename(control, control + '-moved')\nos.replace(control + '-moved', control)\nos.chmod(control, 0o600)\nos.link(control, alias)\nos.unlink(alias)\nos.unlink(control)\nfor index, file in enumerate(files):\n    for op in ${JSON.stringify(attempts)}:\n        try:\n            if op == 'write': open(file, 'w').write('UNSAFE-write')\n            elif op == 'unlink': os.unlink(file)\n            elif op == 'rename': os.rename(file, file + '-moved')\n            elif op == 'replace': os.replace(replacement, file)\n            elif op == 'chmod': os.chmod(file, 0o777)\n            elif op == 'hardlink': os.link(file, alias)\n        except OSError:\n            print('PUBLIC-isolation-%s-%s-refused' % (index, op))\n        else:\n            raise AssertionError('protected file changed: ' + op)\nos.unlink(replacement)\nprint('PUBLIC-isolation-control')\nPYISOLATION`;
                let controls = false;
                scripted.push(
                  (res) => res.end(sseCall({ cmd: script, login: false })),
                  (res, body) => {
                    controls = ['PUBLIC-isolation-control', ...markers].every((marker) =>
                      shellControlReturned(body, marker)
                    );
                    res.end(sse('isolation peer finished'));
                  }
                );
                const peerEvents: StreamEvent[] = [];
                for await (const event of peer.runTurn(
                  request('isolation-peer-b', undefined, {
                    settings: { permissionMode: mode, model: 'fake-model' },
                    writableDirectories: [project, otherHome],
                    tools: {
                      ...request('isolation-peer-tools', undefined).tools,
                      filePolicy: { ...policy, writable: [project, otherHome] },
                    },
                  })
                ))
                  peerEvents.push(event);
                expect(controls, JSON.stringify(peerEvents)).toBe(true);
                expect(peerEvents.some((event) => event.type === 'error')).toBe(false);
                expect(blocked.map(stubSnapshot)).toEqual(snapshots);
                console.info('Codex foreign-file isolation proved', {
                  mode,
                  blocked,
                  markers,
                  controls,
                });
              } finally {
                await own.shutdown();
                await peer.shutdown();
                // Only fixture-owned planted files; never production cleanup.
                for (const file of blocked) fs.rmSync(file, { force: true });
              }
            }
            if (skillDiscovery || otherHomeProbe)
              expect(shellControlReturned(result, skillControl)).toBe(true);
            if (ownSymlink) {
              expect(fs.readdirSync(grantInitial)).toEqual([]);
              expect(fs.readdirSync(grantSwap)).toEqual([]);
            }
            console.info('Codex protected row shutdown requested', {
              kind,
              mode,
              scenario,
              senderPid: process.pid,
              atMs: Date.now(),
              refused: false,
            });
            await transport.shutdown();
          } finally {
            if (race)
              console.info('Codex scan race cycles', { kind, mode, cycles: await race.stop() });
            const checkedHomes = [
              personHome,
              path.join(root, 'data'),
              agentHome,
              probeCwd,
              ...(otherHomeProbe ? [otherHome] : []),
            ];
            console.info('Codex raw host parent kinds before shutdown/reconcile', {
              kind,
              mode,
              scenario,
              parents: probeParentKinds(checkedHomes),
            });
            await Promise.all(pools.map((pool) => pool.shutdown()));
            const removed = await reconcileMountTargets(path.join(root, 'data'));
            expect(removed).toEqual([]);
            console.info('Codex host preservation did not remove recorded targets', {
              kind,
              mode,
              scenario,
              removed,
            });
            for (const [file, snapshot] of preservedAfterCrash)
              expect(stubSnapshot(file)).toEqual(snapshot);
            const parents = probeParentKinds(checkedHomes);
            console.info('Codex host parent kinds after row', { kind, mode, scenario, parents });
            if (defaultStub || nonemptyLedger) {
              const stubsAfter = stubFiles.map(stubSnapshot);
              console.info('Codex default-mode planted-stub result', {
                kind,
                mode,
                launchOutcome: startMs === undefined ? 'refused' : 'started',
                shellControls,
                canariesAbsentFromResult: probe.canaries.every(
                  (canary) => !result.includes(canary)
                ),
                stubFiles,
                stubsBefore,
                stubsAfter,
              });
              expect(stubsAfter).toEqual(stubsBefore);
            }
            expect(
              parents.filter(
                ({ file, kind }) =>
                  kind !== 'absent' &&
                  kind !== 'directory' &&
                  !(ownSymlink && file === grantLink && kind === 'symlink') &&
                  !(preservedAfterCrash.has(file) && kind === 'file') &&
                  !((defaultStub || nonemptyLedger) && stubFiles.includes(file) && kind === 'file')
              )
            ).toEqual([]);
          }
        }
      } finally {
        // A refused thread never consumes its provider script. Isolate the next
        // transport's measurement even when the first native test stays red.
        scripted.length = 0;
        env.mockRestore();
        fs.writeFileSync(configFile, previous);
        if (scenario === 'rg-unreadable-10k') {
          fs.chmodSync(unreadable, 0o700);
          fs.rmSync(unreadable, { recursive: true, force: true });
        }
        fs.rmSync(readable, { force: true });
        probe.cleanup();
        for (const file of stubFiles) fs.rmSync(file, { force: true });
        fs.rmSync(agentHome, { recursive: true, force: true });
        if (otherHomeProbe) fs.rmSync(otherHome, { recursive: true, force: true });
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
