/**
 * @vitest-environment node
 *
 * DOR-3039 and DOR-3042 against the real bundled Claude Code binary: in a
 * folder Claude Code has not been told to trust, the folder's own
 * `permissions.allow` is dropped, so a Never ask (`dontAsk`) turn refuses a
 * command the folder allows. The same rule passed in the launch's own
 * `settings` (what `mergeFolderAllows` writes) is honoured, and a deny in the
 * folder still wins over it.
 *
 * Nothing here can spend or reach the internet. A fake HTTP server on
 * 127.0.0.1 plays the model: its first reply asks to run one `touch`, its
 * second ends the turn. The key is made up and the account folder is a
 * throwaway `CLAUDE_CONFIG_DIR`. Whether the probe file exists afterwards is
 * the CLI's own permission decision. `touch` is used because Claude Code runs
 * some read-only commands (`echo`) without asking at all.
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
import { mergeFolderAllows, selfGrantDenyRules } from '../apply-folder-allows.js';

const BINARY = resolveBundledClaudeBinary();
const PROBE = 'probe-file';
const COMMAND = `touch ${PROBE}`;

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The tool call the fake model makes: by default, the probe's `touch`. */
interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}
const PROBE_CALL: ToolCall = { name: 'Bash', input: { command: COMMAND } };

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

interface FakeModel {
  url: string;
  close: () => Promise<void>;
}

/**
 * The fake model. Any request carrying the probe's tool result ends the turn;
 * every other turn request asks for the probe. Non-message endpoints get 404.
 */
function fakeModel(call: ToolCall = PROBE_CALL): Promise<FakeModel> {
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
        res.end(reply(!body.includes('toolu_probe'), call));
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
let folder: string;
let model: FakeModel;

/** Run one Never ask turn in the folder, and say whether the probe ran. */
async function probeRan(settings?: Options['settings']): Promise<boolean> {
  await runTurn(settings);
  return fs.existsSync(path.join(folder, PROBE));
}

/** Run one Never ask turn in the folder against the current fake model. */
async function runTurn(
  settings?: Options['settings'],
  configDir = path.join(root, 'claude-config')
): Promise<void> {
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  fs.mkdirSync(configDir, { recursive: true });
  const stream = query({
    prompt: 'run the probe',
    options: {
      cwd: folder,
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
      permissionMode: 'dontAsk',
      settingSources: ['local', 'project', 'user'],
      ...(settings ? { settings } : {}),
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
  }
}

/** Write the folder's own `.claude/settings.json`. */
function folderSettings(body: unknown): void {
  fs.writeFileSync(path.join(folder, '.claude', 'settings.json'), JSON.stringify(body));
}

describe.skipIf(BINARY === null)('an agent folder allow list under Never ask', () => {
  beforeEach(async () => {
    model = await fakeModel();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-allows-binary-')));
    folder = path.join(root, 'agent');
    fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await model.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('refuses a command the folder allows, when only the folder says so (DOR-3042)', async () => {
    folderSettings({ permissions: { allow: [`Bash(${COMMAND})`] } });
    expect(await probeRan()).toBe(false);
  }, 60_000);

  it('runs it once the same rule rides the launch settings (DOR-3039)', async () => {
    folderSettings({ permissions: { allow: [`Bash(${COMMAND})`] } });
    const options: Options = {};
    mergeFolderAllows(options, [`Bash(${COMMAND})`], []);
    expect(await probeRan(options.settings)).toBe(true);
  }, 60_000);

  it('still refuses it when the folder denies it, whatever the launch allows', async () => {
    folderSettings({ permissions: { deny: [`Bash(${COMMAND})`] } });
    const options: Options = {};
    mergeFolderAllows(options, [`Bash(${COMMAND})`], []);
    expect(await probeRan(options.settings)).toBe(false);
  }, 60_000);
});

/**
 * Security's M1 on #3072: even the broadest rules there are, bare `Edit` and
 * `Write` (which the judge drops, along with `Edit(./**)` and `Edit(//**)`),
 * cannot reach the files that would grant more, because the launch denies them
 * whenever a list applies. The judge is bypassed on purpose: this is the layer
 * that holds if a broad rule ever got past it. Laid out the
 * way a real install is: the agent home inside the data folder, which sits in
 * the home folder beside the account folder.
 */
describe.skipIf(BINARY === null)('the self-grant files under an approved list', () => {
  const BROAD = ['Edit', 'Write', 'Edit(./**)', 'Edit(//**)'];
  const MARK = 'written-by-the-agent';
  let dorkHome: string;
  let account: string;

  /** Have the agent `Write` `target` under Never ask; say whether it landed. */
  async function wrote(target: string, deny: readonly string[]): Promise<boolean> {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await model.close();
    model = await fakeModel({ name: 'Write', input: { file_path: target, content: MARK } });
    const options: Options = {};
    mergeFolderAllows(options, BROAD, deny);
    await runTurn(options.settings, account);
    return fs.existsSync(target) && fs.readFileSync(target, 'utf8') === MARK;
  }

  /** The deny rules a real launch in this layout carries. */
  function launchDeny(): string[] {
    const rules = selfGrantDenyRules({ home: folder, dorkHome, accountRoot: account });
    if (!rules) throw new Error('the layout could not be named in rules');
    return rules;
  }

  beforeEach(async () => {
    model = await fakeModel();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'self-grant-binary-')));
    dorkHome = path.join(root, '.dork');
    folder = path.join(dorkHome, 'agents', 'marketing');
    account = path.join(root, 'claude-config');
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(dorkHome, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dorkHome, 'config.json'), '{}');
  });

  afterEach(async () => {
    await model.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // Each row runs twice: once with no deny (does the broad rule alone reach it,
  // or does Claude Code already protect it?) and once as a real launch would.
  // The first answer is pinned too, so a CLI that stops protecting a file
  // shows up here rather than being assumed.
  it.each([
    ['its own .dork/agent.json', 'agent.json', false],
    ['../../config.json (the approval record)', 'config', false],
    ['a data folder of DorkOS’s own', 'logs', false],
    ['its own .claude/settings.json', 'settings', true],
    ['its own .mcp.json', 'mcp', true],
    ['another agent’s .claude/', 'other', true],
    ['~/.claude.json', 'trust', true],
    ['the account folder', 'account', true],
  ] as const)(
    'refuses %s',
    async (_label, key, claudeCodeProtects) => {
      const target = {
        'agent.json': path.join(folder, '.dork', 'agent.json'),
        config: path.join(folder, '..', '..', 'config.json'),
        logs: path.join(dorkHome, 'logs', 'x.log'),
        settings: path.join(folder, '.claude', 'settings.json'),
        mcp: path.join(folder, '.mcp.json'),
        other: path.join(dorkHome, 'agents', 'bob', '.claude', 'x.json'),
        trust: path.join(root, '.claude.json'),
        account: path.join(account, 'settings.json'),
      }[key];
      expect(await wrote(target, [])).toBe(!claudeCodeProtects);
      fs.rmSync(target, { force: true });
      expect(await wrote(target, launchDeny())).toBe(false);
    },
    120_000
  );

  it('still writes in its own home, and in a workspace', async () => {
    expect(await wrote(path.join(folder, 'notes.md'), launchDeny())).toBe(true);
    expect(await wrote(path.join(dorkHome, 'workspaces', 'p', 'a.ts'), launchDeny())).toBe(true);
  }, 120_000);
});
