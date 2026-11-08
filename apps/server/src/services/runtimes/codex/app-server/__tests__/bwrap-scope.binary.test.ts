/** @vitest-environment node */
// Temporary CI evidence for DOR-3949 / DOR-3950. Never merge this draft.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import { CodexAppServerPool } from '../process-pool.js';
import { createAppServerTransport } from '../../transport/app-server-transport.js';
import type { CodexTurnRequest } from '../../transport/codex-transport.js';
import { createCodexEventContext } from '../../event-mapper.js';
import { codexProtectedConfig } from '../../policy/protected-profile.js';
import * as runtimeEnv from '../../../shared/runtime-environment-config.js';
import { completeHostFixture } from './fixtures/complete-protected-home.js';

const binary = resolveCodexVendoredBinary();
const traced = process.env.BWRAP_SCOPE_TRACE === '1';
const output = path.join(process.env.BWRAP_SCOPE_OUT!, traced ? 'traced' : 'native');
let server: http.Server;
let base: string;
let providerRequests = 0;

// Same local fake Responses protocol as app-server.binary.test.ts; no auth.
function answer(): string {
  return [
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
      delta: 'pong',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'pong', annotations: [] }],
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
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

describe('DOR-3949 native Linux backup scope', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    expect(process.platform).toBe('linux');
    expect(binary, 'Real pinned Codex binary required').not.toBeNull();
    expect(process.getuid?.()).not.toBe(0);
    fs.mkdirSync(output, { recursive: true });
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (!req.url?.startsWith('/v1/responses')) {
          res.writeHead(404).end();
          return;
        }
        providerRequests++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(answer());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(
    (['default', 'acceptEdits', 'bypassPermissions'] as const).flatMap((mode) =>
      (['A', 'B'] as const).map((variant) => ({ mode, variant }))
    )
  )('$variant $mode real thread/start and provider request', async ({ mode, variant }) => {
    providerRequests = 0;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-scope-')));
    const home = path.join(root, 'home');
    const data = path.join(root, 'data');
    const project = path.join(root, 'project');
    const codexHome = path.join(root, 'codex-home');
    for (const folder of [home, data, project, codexHome]) fs.mkdirSync(folder);
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
    const policy = {
      roots: {
        cwd: project,
        data,
        home,
        accounts: [codexHome],
        agentFolders: [project],
        agentHomes: [project],
      },
      writable: [project],
    };
    // The existing complete-home native fixture: all literal protected targets.
    completeHostFixture(policy, [home, data, project, codexHome]);
    const backup = path.join(home, '.claude/backups/.claude.json.backup.1794126006599');
    const claudeJson = path.join(home, '.claude.json');
    const baseline = {
      backupExists: fs.existsSync(backup),
      claudeJsonExists: fs.existsSync(claudeJson),
    };
    expect(baseline.backupExists).toBe(false);
    if (variant === 'B') {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, '{}');
      if (!fs.existsSync(claudeJson)) fs.writeFileSync(claudeJson, '{}');
    }
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CODEX_HOME: codexHome,
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    };
    const envSpy = vi.spyOn(runtimeEnv, 'runtimeEnvironment').mockImplementation(() => env);
    const label = `${variant}-${mode}`;
    const trace = path.join(output, `${label}.execve.log`);
    const stderr: string[] = [];
    const stdout: string[] = [];
    const launches: unknown[] = [];
    const pool = new CodexAppServerPool({
      spawn: (exe, args, options) => {
        launches.push({ binary: exe, args });
        const child = spawn(
          traced ? '/usr/bin/strace' : exe,
          traced
            ? ['-f', '-s', '1048576', '-e', 'trace=execve', '-o', trace, exe, ...args]
            : [...args],
          { env: options.env, cwd: options.cwd, stdio: 'pipe' }
        );
        child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
        child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
        return child;
      },
    });
    const transport = createAppServerTransport({
      pool,
      connectorTools: () => undefined,
      environment: { person: () => env, credits: () => env },
    });
    const bound = vi.fn();
    const events: StreamEvent[] = [];
    let thrown: string | undefined;
    const version = execFileSync(binary!, ['--version'], { env, encoding: 'utf8' }).trim();
    const turn: CodexTurnRequest = {
      binary: binary!,
      sessionId: label,
      boundThreadId: undefined,
      cwd: project,
      settings: { permissionMode: mode, model: 'fake-model' },
      writableDirectories: [],
      prompt: 'say pong',
      launch: { home: 'person' },
      signal: AbortSignal.timeout(90_000),
      events: createCodexEventContext(label),
      onThreadBound: bound,
      tools: {
        agentTokenEnv: {},
        managed: { servers: {}, env: {} },
        dorkosTools: null,
        connectorTools: null,
        filePolicy: policy,
      },
    };
    const config = codexProtectedConfig(project, policy, turn.settings);
    try {
      for await (const event of transport.runTurn(turn)) events.push(event);
    } catch (error) {
      thrown = String(error);
    } finally {
      await transport.shutdown();
      await pool.shutdown();
      envSpy.mockRestore();
      const receipt = {
        variant,
        mode,
        traced,
        version,
        baseline,
        plantedBackup: variant === 'B',
        backup,
        home,
        project,
        config,
        launches,
        providerRequests,
        bound: bound.mock.calls.length,
        thrown,
        events,
        stderr: stderr.join(''),
        stdout: stdout.join(''),
      };
      fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(receipt, null, 2));
      console.info(
        'BWRAP_SCOPE_RECEIPT',
        JSON.stringify({
          variant,
          mode,
          traced,
          providerRequests,
          bound: bound.mock.calls.length,
          errors: events.filter((event) => event.type === 'error'),
          thrown,
        })
      );
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    expect(thrown).toBeUndefined();
    // A must really reach the fake provider. B may expose the reported mount failure;
    // an unrelated refusal is never counted as a successful reproduction.
    if (providerRequests > 0) {
      expect(bound).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    } else {
      expect(variant).toBe('B');
      expect(JSON.stringify(events)).toContain('thread/start');
      expect(JSON.stringify(events)).toContain(
        `bwrap: Can't create file at ${backup}: Read-only file system`
      );
    }
  });
});
