/**
 * @vitest-environment node
 *
 * Against the real bundled Claude Code binary: an agent browser's tool that runs code outside the
 * page (`browser_run_code_unsafe`) is refused, by the deny rule alone and by the hook alone, under
 * `bypassPermissions` and under `default` with a saved `mcp__browser__*` allow. Its other tools
 * still run, and with neither in place the same call runs, so every refusal has a control.
 *
 * Nothing here can spend or reach the internet. A fake HTTP server on 127.0.0.1 plays the model:
 * its first reply calls one tool, its second ends the turn. A fake stdio MCP server plays the
 * browser and writes a marker file for each tool it is asked to run, so whether the marker exists
 * afterwards is the CLI's own decision. The key is made up and the account folder is a throwaway
 * `CLAUDE_CONFIG_DIR`.
 *
 * Skipped where the SDK's bundled binary is not installed for this platform.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { applyBrowserToolDeny, browserToolHookMatcher } from '../browser-tool-deny.js';

const BINARY = resolveBundledClaudeBinary();

/**
 * The fake browser: newline-delimited JSON-RPC on stdio, two tools, and a marker file per call.
 * Plain Node with no imports beyond `node:`, so it runs from a temporary folder.
 */
const FAKE_BROWSER = `
const fs = require('node:fs');
const path = require('node:path');
const markers = process.argv[2];
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-browser', version: '1.0.0' },
      } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'browser_snapshot', description: 'Snapshot the page', inputSchema: { type: 'object', properties: {} } },
        { name: 'browser_run_code_unsafe', description: 'Run code', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (message.method === 'tools/call') {
      fs.writeFileSync(path.join(markers, message.params.name), 'ran');
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    } else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } });
    }
  }
});
`;

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed reply: a call to `tool` when `toolUse`, plain text otherwise. */
function reply(toolUse: boolean, tool: string): string {
  const message = {
    id: `msg_${toolUse ? 1 : 2}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const block = toolUse
    ? { type: 'tool_use', id: 'toolu_probe', name: tool, input: {} }
    : { type: 'text', text: '' };
  const delta = toolUse
    ? { type: 'input_json_delta', partial_json: '{}' }
    : { type: 'text_delta', text: 'done' };
  return [
    sse('message_start', { type: 'message_start', message }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('');
}

interface FakeModel {
  url: string;
  close: () => Promise<void>;
}

/** The fake model: calls `tool` once, then ends the turn. */
function fakeModel(tool: string): Promise<FakeModel> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no' } })
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(reply(!body.includes('toolu_probe'), tool));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

let root: string;
let markers: string;

interface Turn {
  /** The browser tool the model calls. */
  tool: 'browser_snapshot' | 'browser_run_code_unsafe';
  mode: 'bypassPermissions' | 'default';
  /** The deny rules `applyBrowserToolDeny` adds. */
  denyRule: boolean;
  /** The `PreToolUse` hook. */
  hook: boolean;
}

/** Run one turn whose model calls `tool` on the server named `browser`; say whether it ran. */
async function ran(turn: Turn): Promise<boolean> {
  const model = await fakeModel(`mcp__browser__${turn.tool}`);
  const script = path.join(root, 'fake-browser.cjs');
  fs.writeFileSync(script, FAKE_BROWSER);
  const options: Options = {
    mcpServers: { browser: { type: 'stdio', command: process.execPath, args: [script, markers] } },
    // The saved "Always allow" a deny has to beat.
    settings: { permissions: { allow: ['mcp__browser__*'] } },
  };
  if (turn.denyRule) applyBrowserToolDeny(options);
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  const stream = query({
    prompt: 'use the browser',
    options: {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: model.url,
        ANTHROPIC_API_KEY: 'fake-key-never-real',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      permissionMode: turn.mode,
      ...(turn.mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      settingSources: ['local', 'project', 'user'],
      mcpServers: options.mcpServers!,
      settings: options.settings!,
      ...(turn.hook ? { hooks: { PreToolUse: [browserToolHookMatcher()] } } : {}),
      pathToClaudeCodeExecutable: BINARY!,
      abortController: abort,
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: spawnOptions.signal,
        });
        childClosed = new Promise<void>((done) => child.once('close', () => done()));
        return child as unknown as ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>>;
      },
    },
  });
  const deadline = setTimeout(() => abort.abort(), 45_000);
  try {
    for await (const message of stream) {
      if (message.type === 'result') break;
    }
  } catch {
    // Aborted, or the CLI gave up on the fake server.
  } finally {
    clearTimeout(deadline);
    abort.abort();
    stream.close();
    await childClosed;
    await model.close();
  }
  return fs.existsSync(path.join(markers, turn.tool));
}

describe.skipIf(BINARY === null)('a browser tool that runs code outside the page', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-tool-deny-binary-')));
    markers = path.join(root, 'markers');
    fs.mkdirSync(markers, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const unsafe = 'browser_run_code_unsafe' as const;

  it('runs when neither the deny rule nor the hook rides the launch (the control)', async () => {
    expect(await ran({ tool: unsafe, mode: 'default', denyRule: false, hook: false })).toBe(true);
  }, 60_000);

  it('is refused by the deny rule alone, beside a saved mcp__browser__* allow', async () => {
    expect(await ran({ tool: unsafe, mode: 'default', denyRule: true, hook: false })).toBe(false);
  }, 60_000);

  it('is refused by the deny rule alone under bypassPermissions', async () => {
    expect(
      await ran({ tool: unsafe, mode: 'bypassPermissions', denyRule: true, hook: false })
    ).toBe(false);
  }, 60_000);

  it('is refused by the hook alone under bypassPermissions', async () => {
    expect(
      await ran({ tool: unsafe, mode: 'bypassPermissions', denyRule: false, hook: true })
    ).toBe(false);
  }, 60_000);

  it('leaves the browser’s other tools running with both in place', async () => {
    expect(
      await ran({ tool: 'browser_snapshot', mode: 'default', denyRule: true, hook: true })
    ).toBe(true);
  }, 60_000);
});
