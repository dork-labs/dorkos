/** @vitest-environment node */
// CI-only macOS companion; fake provider and transport helpers copied from app-server.binary.test.ts.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { completeHostFixture } from './fixtures/complete-protected-home.js';
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
import { createCodexTransport, type CodexTransportKind } from '../../transport/index.js';
import * as runtimeEnv from '../../../shared/runtime-environment-config.js';
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

function checkHostParents(homes: string[]) {
  expect(
    probeParentKinds(homes).filter(({ kind }) => kind !== 'absent' && kind !== 'directory')
  ).toEqual([]);
}

// Temporary CI-only evidence. This draft and its workflow must never merge.
describe('DOR-3853 macOS real-turn controls', { timeout: 180_000 }, () => {
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
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-')));
    codexHome = path.join(root, 'codex-home');
    project = path.join(root, 'project');
    for (const folder of [codexHome, project, path.join(root, 'home'), path.join(root, 'data')])
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
      completeHostFixture(policy, [policy.roots.home, policy.roots.data, codexHome]);
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
    await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(
    (['default', 'acceptEdits', 'bypassPermissions'] as const).flatMap((mode) =>
      [false, true].map((unreadable) => ({ mode, unreadable }))
    )
  )('real turn $mode, rg-unreadable-10k: $unreadable', async ({ mode, unreadable }) => {
    expect(process.platform).toBe('darwin');
    expect(BINARY, 'A missing real binary is a failure').not.toBeNull();
    expect(process.getuid?.()).not.toBe(0);
    const turn = request(`dor3853-${mode}-${unreadable}`, undefined, {
      settings: { permissionMode: mode, model: 'fake-model' },
    });
    const policy = turn.tools.filePolicy!;
    const agentHome = path.join(root, 'data', 'agents', 'probe');
    policy.roots.agentHomes = [project, agentHome];
    policy.roots.agentFolders = [project, agentHome];
    const protectedFiles = completeHostFixture(policy, [
      policy.roots.home,
      policy.roots.data,
      project,
      agentHome,
      codexHome,
    ]);
    const skillFile = path.join(agentHome, '.agents', 'skills', 'probe', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(
      skillFile,
      '---\nname: dor3853-own-skill\ndescription: Own agent skill discovery canary.\n---\nPUBLIC-own-skill-body\n'
    );
    // Positive discovery control inside cwd. Do not add the own home to cwd or
    // CODEX_HOME: the point is to observe automatic discovery from outside it.
    const cwdSkill = path.join(project, '.agents', 'skills', 'control', 'SKILL.md');
    fs.mkdirSync(path.dirname(cwdSkill), { recursive: true });
    fs.writeFileSync(
      cwdSkill,
      '---\nname: dor3853-cwd-skill\ndescription: Cwd discovery positive control.\n---\nPUBLIC-cwd-skill-body\n'
    );
    const readable = path.join(project, 'readable.txt');
    fs.writeFileSync(readable, 'PUBLIC-control-dor3595');
    const probe = protectedProbe(root, project);
    const ownWrite = path.join(agentHome, '.agents', 'write-probe');
    const blocked = path.join(policy.roots.home, 'rg-unreadable');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, '.env'), 'FAKE-unreadable-canary');
    if (unreadable) fs.chmodSync(blocked, 0o000);
    // Witness PATH-resolved rg only. No system tracing, sudo, credentials or Keychain.
    const realRg = execFileSync('/usr/bin/which', ['rg'], { encoding: 'utf8' }).trim();
    const bin = path.join(root, 'probe-bin');
    const rgLog = path.join(root, 'rg-witness');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'rg'),
      `#!/bin/sh\nprintf 'rg\\n' >> '${rgLog}'\nexec '${realRg}' "$@"\n`,
      { mode: 0o755 }
    );
    const childPath = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
    execFileSync(path.join(bin, 'rg'), ['--version']);
    expect(fs.readFileSync(rgLog, 'utf8')).toContain('rg');
    fs.writeFileSync(rgLog, '');
    const version = execFileSync(BINARY!, ['--version'], {
      encoding: 'utf8',
      env: { PATH: childPath, HOME: policy.roots.home, CODEX_HOME: codexHome },
    }).trim();
    const env = vi.spyOn(runtimeEnv, 'runtimeEnvironment').mockImplementation(() => ({
      PATH: childPath,
      HOME: policy.roots.home,
      CODEX_HOME: codexHome,
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    }));
    const snapshot = () =>
      [...protectedFiles].sort().map((file) => ({
        file,
        contents: fs.readFileSync(file, 'base64'),
        mode: fs.lstatSync(file).mode,
      }));
    const before = snapshot();
    let firstBody = '';
    let returned = '';
    const bound = vi.fn();
    const events: StreamEvent[] = [];
    scripted.push(
      (res, body) => {
        firstBody = body;
        probe.createLate();
        res.end(
          sseCall({
            cmd: `${probe.command}; printf PUBLIC-own-agents-write-attempt; printf changed > ${JSON.stringify(ownWrite)}`,
            login: false,
          })
        );
      },
      (res, body) => {
        returned = body;
        res.end(sse('done'));
      }
    );
    const transport = makeTransport();
    try {
      for await (const event of transport.runTurn({
        ...turn,
        onThreadBound: bound,
        tools: {
          agentTokenEnv: {},
          managed: { servers: {}, env: {} },
          dorkosTools: null,
          connectorTools: null,
          filePolicy: policy,
        },
      }))
        events.push(event);
      expect(bound).toHaveBeenCalledTimes(1);
      expect(
        events.some((event) => event.type === 'error'),
        JSON.stringify(events)
      ).toBe(false);
      expect(shellControlReturned(returned, 'PUBLIC-control-dor3595')).toBe(true);
      expect(shellControlReturned(returned, 'PUBLIC-own-agents-write-attempt')).toBe(true);
      // Skill access/discovery is a measured result, not assumed from thread bind.
      for (const marker of probe.attemptMarkers) expect(returned).toContain(marker);
      for (const canary of [...probe.canaries, 'FAKE-unreadable-canary'])
        expect(returned).not.toContain(canary);
      expect(fs.readFileSync(probe.plugin, 'utf8')).toBe('original-plugin');
      expect(fs.readFileSync(probe.latePlugin, 'utf8')).toBe('original-late-plugin');
      expect(snapshot()).toEqual(before);
      expect(returned).toMatch(/denied|not permitted/i);
      expect(fs.existsSync(ownWrite)).toBe(false);
      expect(fs.readFileSync(probe.gitWrite, 'utf8')).toBe(
        mode === 'bypassPermissions' ? 'changed-by-full-probe' : 'original-git-control'
      );
    } finally {
      await transport.shutdown();
      env.mockRestore();
      fs.chmodSync(blocked, 0o700);
      const receipt = {
        mode,
        unreadable,
        version,
        bound: bound.mock.calls.length,
        providerRequests: seen.responses,
        shellControl: shellControlReturned(returned || '{}', 'PUBLIC-control-dor3595'),
        ownSkillCat: shellControlReturned(returned || '{}', 'PUBLIC-own-skill-body'),
        ownSkillAutomaticDiscovery: firstBody.includes('dor3853-own-skill'),
        cwdSkillAutomaticDiscovery: firstBody.includes('dor3853-cwd-skill'),
        pathResolvedRgCalls: fs.readFileSync(rgLog, 'utf8').split('\n').filter(Boolean).length,
        rgWitnessScope: 'PATH-resolved rg; does not observe embedded/absolute rg',
        refusal: events.filter((event) => event.type === 'error'),
        shellReturned: returned,
        skillFile,
        cwd: project,
      };
      const out = process.env.DOR3853_OUT!;
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(
        path.join(out, `${mode}-${unreadable ? 'unreadable' : 'readable'}.json`),
        JSON.stringify(receipt, null, 2)
      );
      console.info('DOR-3853 receipt', JSON.stringify({ ...receipt, shellReturned: undefined }));
      expect(fs.readFileSync(path.join(blocked, '.env'), 'utf8')).toBe('FAKE-unreadable-canary');
      expect(await reconcileMountTargets(policy.roots.data)).toEqual([]);
      checkHostParents([policy.roots.home, policy.roots.data, agentHome, project]);
      probe.cleanup();
    }
  });
});
