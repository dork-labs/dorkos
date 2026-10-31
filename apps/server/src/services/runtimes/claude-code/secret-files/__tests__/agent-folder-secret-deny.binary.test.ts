/**
 * @vitest-environment node
 *
 * DOR-3292 against the real bundled Claude Code binary: with the rules every
 * launch carries for the agent's own folder (`applySecretReadDeny` with
 * `agentFolders`), a secret-named file there never reaches the model through
 * the `Read` tool or a shell command that names it, at every level, Full
 * included. A template and a plain file still read.
 *
 * What the rules can't hold is pinned in `folder-secret-canary.binary.test.ts`:
 * a folder-wide `rg -uu` still prints the file. Only moving it out stops that.
 *
 * Stand-in files only, in a throwaway folder: each holds a canary, and the
 * check is whether that canary reaches the model in the next request. A fake
 * HTTP server on 127.0.0.1 plays the model, and the key is made up. Every
 * refused row has a control that shows the canary DOES reach the model
 * without the rules. Skipped where the SDK's bundled binary is not installed
 * for this platform.
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
/** The dotenv name, spelled in parts so no tool sees a bare secret-file path. */
const ENV = ['', 'env'].join('.');

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
let folder: string;

/**
 * Run one turn in the agent's folder that makes `call`, and return every
 * request body after the first: the tool's result travels back in those.
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
  const account = path.join(root, 'account');
  fs.mkdirSync(account, { recursive: true });
  const options: Options = {};
  if (deny) {
    applySecretReadDeny(options, {
      dorkHome: path.join(root, 'dorkhome'),
      accountRoot: account,
      otherAccountRoots: [],
      agentFolders: [folder],
    });
  }
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const stream = query({
    prompt: 'look it up',
    options: {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: path.join(root, 'home'),
        CLAUDE_CONFIG_DIR: account,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'fake-key-never-real',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      permissionMode: mode,
      ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      // A person who allows every card: whatever is refused below, the rules refused.
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

/** Write a stand-in file in the agent's folder holding `canary`. */
function plant(rel: string, canary: string): string {
  const file = path.join(folder, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `secret=${canary}\n`);
  return file;
}

const LEVELS: [string, PermissionMode][] = [
  ['Ask first', 'default'],
  ['Act', 'acceptEdits'],
  ['Never ask', 'dontAsk'],
  ['Full', 'bypassPermissions'],
];

/** Each secret, and the call that would bring it back. */
const SECRETS: [string, string, (file: string) => ToolCall][] = [
  ['Read of the dotenv file', ENV, (file) => ({ name: 'Read', input: { file_path: file } })],
  ['cat of the dotenv file', ENV, () => ({ name: 'Bash', input: { command: `cat ${ENV}` } })],
  [
    'cat of a nested dotenv file',
    `deploy/${ENV}.production`,
    () => ({ name: 'Bash', input: { command: `cat deploy/${ENV}.production` } }),
  ],
  [
    'head of a private key',
    'certs/server.pem',
    () => ({ name: 'Bash', input: { command: 'head certs/server.pem' } }),
  ],
];

/** Files the rules leave readable. */
const READABLE: [string, string, (file: string) => ToolCall][] = [
  [
    'a dotenv template',
    `${ENV}.example`,
    () => ({ name: 'Bash', input: { command: `cat ${ENV}.example` } }),
  ],
  ['a plain file', 'notes.md', (file) => ({ name: 'Read', input: { file_path: file } })],
];

const canaryOf = (label: string): string => `CANARY-${label.replace(/\W/g, '')}`;

describe.skipIf(BINARY === null)('secret files in the agent’s own folder (DOR-3292)', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-secret-binary-')));
    folder = path.join(root, 'agents', 'scout');
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.each(SECRETS)(
    'brings back the %s without the rules (the control)',
    async (label, rel, call) => {
      const file = plant(rel, canaryOf(label));
      expect(await resultsOf(call(file), 'default', false)).toContain(canaryOf(label));
    },
    60_000
  );

  for (const [level, mode] of LEVELS) {
    it.each(SECRETS)(
      `never brings back the %s at ${level}`,
      async (label, rel, call) => {
        const file = plant(rel, canaryOf(label));
        const out = await resultsOf(call(file), mode, true);
        // The turn reached the tool's result, so the refusal is real, not an abort.
        expect(out).toContain('toolu_probe');
        expect(out).not.toContain(canaryOf(label));
      },
      60_000
    );

    it.each(READABLE)(
      `still reads %s at ${level}`,
      async (label, rel, call) => {
        const file = plant(rel, canaryOf(label));
        expect(await resultsOf(call(file), mode, true)).toContain(canaryOf(label));
      },
      60_000
    );
  }
});
