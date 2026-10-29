/**
 * @vitest-environment node
 *
 * DOR-3068 against the real bundled Claude Code binary: with the deny rules
 * every launch carries (`applyPersonOnlyDataDeny`), an agent's `Write` cannot
 * change an installed plugin — in its own project, in another project, or in
 * the shared plugins folder — even under `bypassPermissions`. Its own
 * project's extensions stay writable, because that is how an agent builds a
 * mini app.
 *
 * Nothing here can spend or reach the internet. A fake HTTP server on
 * 127.0.0.1 plays the model: its first reply asks for one `Write`, its second
 * ends the turn. The key is made up and the account folder is a throwaway
 * `CLAUDE_CONFIG_DIR`. Whether the file exists afterwards is the CLI's own
 * permission decision, and every refused case has a control that writes.
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
import { applyPersonOnlyDataDeny } from '../directory-grants.js';

const BINARY = resolveBundledClaudeBinary();

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed reply: a `Write` to `target` when `toolUse`, plain text otherwise. */
function reply(toolUse: boolean, target: string): string {
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
    ? { type: 'tool_use', id: 'toolu_probe', name: 'Write', input: {} }
    : { type: 'text', text: '' };
  const delta = toolUse
    ? {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ file_path: target, content: 'allowed-tools: Bash\n' }),
      }
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

/** The fake model: asks for one `Write` to `target`, then ends the turn. */
function fakeModel(target: string): Promise<FakeModel> {
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
        res.end(reply(!body.includes('toolu_probe'), target));
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
let project: string;
let dorkHome: string;

/** Run one Bypass turn in `project` that writes `target`; say whether it was written. */
async function wrote(target: string, withDeny: boolean): Promise<boolean> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const model = await fakeModel(target);
  const options: Options = {};
  if (withDeny) applyPersonOnlyDataDeny(options, dorkHome);
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  const stream = query({
    prompt: 'write the file',
    options: {
      cwd: project,
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
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['local', 'project', 'user'],
      ...(options.settings ? { settings: options.settings } : {}),
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
  return fs.existsSync(target);
}

describe.skipIf(BINARY === null)('installed plugins under Bypass (DOR-3068)', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-deny-binary-')));
    project = path.join(root, 'project');
    dorkHome = path.join(root, 'data');
    fs.mkdirSync(project, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const ownPlugin = () => path.join(project, '.dork', 'plugins', 'p', 'commands', 'run.md');
  const otherPlugin = () =>
    path.join(root, 'elsewhere', 'deep', '.dork', 'plugins', 'p', 'commands', 'run.md');
  const sharedPlugin = () => path.join(dorkHome, 'plugins', 'p', 'commands', 'run.md');
  const ownExtension = () => path.join(project, '.dork', 'extensions', 'e', 'index.ts');

  it('writes a plugin file when no deny rides the launch (the control)', async () => {
    expect(await wrote(ownPlugin(), false)).toBe(true);
  }, 60_000);

  it('refuses its own project’s installed plugin', async () => {
    expect(await wrote(ownPlugin(), true)).toBe(false);
  }, 60_000);

  it('refuses another project’s installed plugin, at any depth', async () => {
    expect(await wrote(otherPlugin(), true)).toBe(false);
  }, 60_000);

  it('refuses the shared plugins in the data folder', async () => {
    expect(await wrote(sharedPlugin(), true)).toBe(false);
  }, 60_000);

  it('still writes its own project’s extension, so mini apps can be built', async () => {
    expect(await wrote(ownExtension(), true)).toBe(true);
  }, 60_000);
});
