/**
 * @vitest-environment node
 *
 * DOR-3292's standing canary for Claude Code, against the real bundled
 * binary: what a secret file inside an agent's own folder is worth, today.
 *
 * At Never ask (`dontAsk`), with the folder's own deny rule on the dotenv
 * file, a folder-wide `rg -uu` still prints the secret, because Claude Code
 * runs read-only searches inside the working folder without asking. This test
 * EXPECTS that, which is the point: it documents the limit the warning and the
 * copy describe. If Claude Code ever starts refusing it, this test fails, and
 * the copy can say more. The scan, meanwhile, names the file by path and never
 * carries its value.
 *
 * Stand-in files only, in a throwaway folder. Nothing here can spend or reach
 * the internet: a fake HTTP server on 127.0.0.1 plays the model, and the key
 * is made up. `rg` there is Claude Code's own (its shell supplies it), so the
 * search runs wherever the CLI does. Skipped where the SDK's bundled binary is
 * not installed for this platform.
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
import { SecretFileScanService } from '../../../../core/secret-file-scan/secret-file-scan-service.js';

const BINARY = resolveBundledClaudeBinary();
/** The dotenv name, spelled in parts so no tool sees a bare secret-file path. */
const ENV = ['', 'env'].join('.');
const CANARY = 'CANARY-dor3292-folder-secret';
const SEARCH = 'rg -uu CANARY-dor3292 .';

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed reply: the folder-wide search when `toolUse`, plain text otherwise. */
function reply(toolUse: boolean): string {
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
    ? { type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: {} }
    : { type: 'text', text: '' };
  const delta = toolUse
    ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: SEARCH }) }
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

let root: string;
let folder: string;

/** Run one Never ask turn that searches the folder; return what reached the model. */
async function searchResults(): Promise<string> {
  const bodies: string[] = [];
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
      const toolUse = !body.includes('toolu_probe');
      if (!toolUse) bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply(toolUse));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  const stream = query({
    prompt: 'search the folder',
    options: {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'fake-key-never-real',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      permissionMode: 'dontAsk',
      settingSources: ['local', 'project', 'user'],
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
    await new Promise<void>((done) => server.close(() => done()));
  }
  return bodies.join('\n');
}

describe.skipIf(BINARY === null)('a secret in the agent folder (Claude Code)', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-secret-canary-')));
    folder = path.join(root, 'agent');
    fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(folder, ENV), `X_API_KEY=${CANARY}\n`);
    // The folder's own deny on that very file, the rule people trust.
    fs.writeFileSync(
      path.join(folder, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: [`Read(./${ENV})`] } })
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('is printed by a folder-wide search at Never ask, deny rule and all (today’s limit)', async () => {
    expect(await searchResults()).toContain(CANARY);
  }, 60_000);

  it('is named by the scan, by path, never by value', async () => {
    const raised: unknown[] = [];
    const service = new SecretFileScanService({
      notify: async (payload) => {
        raised.push(payload);
      },
    });
    await service.scanAgent({ id: 'a', name: 'Scout', folders: [folder] });
    expect(raised).toHaveLength(1);
    expect(JSON.stringify(raised)).toContain(path.join(folder, ENV));
    expect(JSON.stringify(raised)).not.toContain(CANARY);
  });
});
