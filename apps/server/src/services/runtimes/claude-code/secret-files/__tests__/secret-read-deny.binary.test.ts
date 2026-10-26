/**
 * @vitest-environment node
 *
 * DOR-3299 against the real bundled Claude Code binary: with the rules every
 * launch carries (`applySecretReadDeny`), the model's `Read` never brings a
 * secret back, at Ask first and Act (where DorkOS's gate
 * auto-allows read-only tools, played here by a `canUseTool` that allows
 * everything) and at Full (`bypassPermissions`). A plain file in the agent's
 * own folder still reads.
 *
 * Stand-in files only, in a throwaway home: each holds a canary, and the
 * check is whether that canary reaches the model in the next request. Nothing
 * here can spend or reach the internet: a fake HTTP server on 127.0.0.1 plays
 * the model, and the key is made up. Every refused row has a control that
 * shows the canary DOES reach the model without the rules.
 *
 * `Grep` and `Glob` are not tested: the bundled CLI has neither tool ("No such
 * tool available: Grep … search file contents with `grep` via the Bash tool").
 * Searching goes through the shell, which is part 2 (DOR-3300). The rules still
 * name both, for a Claude Code that has them.
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
import { query, type Options, type PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { applySecretReadDeny } from '../secret-read-deny.js';

const BINARY = resolveBundledClaudeBinary();

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** A streamed reply: `call` when `toolUse`, plain text otherwise. */
function reply(toolUse: boolean, call: ToolCall): string {
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
    ? { type: 'tool_use', id: 'toolu_probe', name: call.name, input: {} }
    : { type: 'text', text: '' };
  const delta = toolUse
    ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
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
let dorkHome: string;
let account: string;
let folder: string;

/**
 * Run one turn that makes `call`, and return every request body after the
 * first: the tool's result travels back to the model in those.
 */
async function resultsOf(call: ToolCall, mode: PermissionMode, deny: boolean): Promise<string> {
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
      res.end(reply(toolUse, call));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  const options: Options = {};
  if (deny) applySecretReadDeny(options, { dorkHome, accountRoots: [account] });
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const stream = query({
    prompt: 'look it up',
    options: {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        CLAUDE_CONFIG_DIR: account,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'fake-key-never-real',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      permissionMode: mode,
      ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      // DorkOS's gate at Ask first and Act: read-only tools are auto-allowed.
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
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
    await new Promise<void>((done) => server.close(() => done()));
  }
  return bodies.join('\n');
}

/** Write a stand-in secret holding `canary`. */
function plant(file: string, canary: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `secret=${canary}\n`);
  return file;
}

const LEVELS: [string, PermissionMode][] = [
  ['Ask first', 'default'],
  ['Act', 'acceptEdits'],
  ['Full', 'bypassPermissions'],
];

describe.skipIf(BINARY === null)('the model’s read tools and secret files (DOR-3299)', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-read-binary-')));
    dorkHome = path.join(root, '.dork');
    account = path.join(root, 'claude-account');
    folder = path.join(dorkHome, 'agents', 'scout');
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(account, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const SECRETS: [string, () => string][] = [
    ['host.key', () => path.join(dorkHome, 'host.key')],
    ['an extension secret', () => path.join(dorkHome, 'extension-secrets', 'x.json')],
    ['the account sign-in', () => path.join(account, '.credentials.json')],
    ['~/.claude.json', () => path.join(root, '.claude.json')],
    ['an SSH key', () => path.join(root, '.ssh', 'id_ed25519')],
    ['the gh token', () => path.join(root, '.config', 'gh', 'hosts.yml')],
    ['~/.npmrc', () => path.join(root, '.npmrc')],
  ];

  it('reads a secret without the rules (the Read control)', async () => {
    const file = plant(path.join(dorkHome, 'host.key'), 'CANARY-control');
    const read = await resultsOf({ name: 'Read', input: { file_path: file } }, 'default', false);
    expect(read).toContain('CANARY-control');
  }, 60_000);

  for (const [level, mode] of LEVELS) {
    it.each(SECRETS)(
      `never reads %s at ${level}`,
      async (label, where) => {
        const canary = `CANARY-${label.replace(/\W/g, '')}`;
        const file = plant(where(), canary);
        const out = await resultsOf({ name: 'Read', input: { file_path: file } }, mode, true);
        expect(out).not.toContain(canary);
      },
      60_000
    );

    it(`still reads a plain file in the agent's own folder at ${level}`, async () => {
      const file = plant(path.join(folder, 'notes.md'), 'CANARY-notes');
      const out = await resultsOf({ name: 'Read', input: { file_path: file } }, mode, true);
      expect(out).toContain('CANARY-notes');
    }, 60_000);
  }
});
