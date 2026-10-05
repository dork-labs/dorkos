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
 * - the throwaway home's trust list is not written by a writable-mode turn.
 *
 * Skipped by name where no vendored binary is installed for this platform.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import { CodexAppServerPool, type SpawnAppServer } from '../process-pool.js';
import { AppServerCodexTransport } from '../../transport/app-server-transport.js';
import { createCodexEventContext } from '../../event-mapper.js';
import { ConnectorThreadKeyRegistry } from '../../../../connectors/principal/thread-keys.js';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimeTools } from '../../../connector-tools.js';
import type { CodexTurnRequest } from '../../transport/codex-transport.js';
import { spawn as nodeSpawn } from 'node:child_process';

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

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
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

function makeTransport(): AppServerCodexTransport {
  const spawn: SpawnAppServer = (binary, args, options) => {
    spawned.push({ args, env: options.env });
    return nodeSpawn(binary, [...args], { env: options.env, cwd: options.cwd, stdio: 'pipe' });
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
  return new AppServerCodexTransport({
    pool,
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
  return {
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
    },
    signal: new AbortController().signal,
    events: createCodexEventContext(sessionId),
    onThreadBound: () => {},
    ...overrides,
  };
}

describe.skipIf(BINARY === null)('the app-server transport against the real Codex binary', () => {
  beforeAll(async () => {
    vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-')));
    codexHome = path.join(root, 'codex-home');
    project = path.join(root, 'project');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => handle(req, res, body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The throwaway home's provider is the local fake. No key anywhere.
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "fake"',
        '[model_providers.fake]',
        'name = "fake"',
        `base_url = "${base}/v1"`,
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'request_max_retries = 0',
        'stream_max_retries = 0',
      ].join('\n') + '\n'
    );
    await principals.initializeBoot();
  });

  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

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
});
