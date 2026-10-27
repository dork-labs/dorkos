/**
 * @vitest-environment node
 *
 * DOR-3068 S1 against the real bundled Claude Code binary: with the rules
 * every launch carries (`applyPersonOnlyDataDeny`), the model's Write and Edit
 * can't change DorkOS's `config.json` (where every pin, approval and the
 * upgrade marker live) or another agent's authority files, at Ask first, Act
 * and Full. Each refusal leaves the file byte for byte as it was, and each
 * has a control showing the same call DOES change the file without the rules.
 *
 * Stand-in files only, in a throwaway data folder; a fake HTTP server on
 * 127.0.0.1 plays the model, so nothing spends or reaches the internet. The
 * model reads the file first, as the CLI requires before an Edit.
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
import { applyPersonOnlyDataDeny } from '../directory-grants.js';

const BINARY = resolveBundledClaudeBinary();

/** One tool call the fake model makes. */
interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed reply: tool call `index` when there is one, else the end of the turn. */
function reply(index: number, call: ToolCall | undefined): string {
  const message = {
    id: `msg_${index}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const block = call
    ? { type: 'tool_use', id: `toolu_${index}`, name: call.name, input: {} }
    : { type: 'text', text: '' };
  const delta = call
    ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
    : { type: 'text_delta', text: 'done' };
  return [
    sse('message_start', { type: 'message_start', message }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('');
}

let root: string;
let home: string;
let dorkHome: string;
let account: string;
let folder: string;

/** Run one turn that makes `calls` in order, with or without the every-launch rules. */
async function runCalls(calls: ToolCall[], mode: PermissionMode, deny: boolean): Promise<void> {
  let served = 0;
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
      res.end(reply(served, calls[served]));
      served += 1;
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  const options: Options = {};
  if (deny) applyPersonOnlyDataDeny(options, dorkHome);
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const stream = query({
    prompt: 'change it',
    options: {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CLAUDE_CONFIG_DIR: account,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'fake-key-never-real',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      permissionMode: mode,
      ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      // DorkOS's gate, played as allowing everything: only the rules can refuse.
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
}

const ORIGINAL = '{"harness":{"folderConfigPinned":true}}\n';

/** The two ways a file tool changes a file: replace it, or edit a part of it. */
const CHANGES: [string, (file: string) => ToolCall[]][] = [
  [
    'Write',
    (file) => [
      { name: 'Read', input: { file_path: file } },
      { name: 'Write', input: { file_path: file, content: '{}\n' } },
    ],
  ],
  [
    'Edit',
    (file) => [
      { name: 'Read', input: { file_path: file } },
      {
        name: 'Edit',
        input: { file_path: file, old_string: '"folderConfigPinned":true', new_string: '"x":1' },
      },
    ],
  ],
];

/** Another agent's home in the data folder. */
const other = () => path.join(dorkHome, 'agents', 'other');

/**
 * The files only a person may change, from an agent's own folder. Each is
 * planted holding {@link ORIGINAL}; the one through a link plants the real
 * skill in `.agents/skills/x` and links `.claude/skills/x` to it, as Harness
 * Sync does, and edits through the link.
 */
const TARGETS: [string, () => string][] = [
  ['config.json', () => plant(path.join(dorkHome, 'config.json'))],
  ["another agent's settings", () => plant(path.join(other(), '.claude', 'settings.json'))],
  [
    "another agent's skill, where it really lives",
    () => plant(path.join(other(), '.agents', 'skills', 'x', 'SKILL.md')),
  ],
  ["another agent's skill, through its .claude/skills link", () => plantLinked(other(), 'x')],
  ["another agent's command", () => plant(path.join(other(), '.claude', 'commands', 'x.md'))],
  ["another agent's subagent", () => plant(path.join(other(), '.claude', 'agents', 'x.md'))],
];

/** Plant a target holding {@link ORIGINAL}. */
function plant(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ORIGINAL);
  return file;
}

/** Plant a skill in `<home>/.agents/skills/<name>`, and return it through its `.claude/skills` link. */
function plantLinked(home: string, name: string): string {
  plant(path.join(home, '.agents', 'skills', name, 'SKILL.md'));
  const link = path.join(home, '.claude', 'skills', name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join('..', '..', '.agents', 'skills', name), link);
  return path.join(link, 'SKILL.md');
}

const LEVELS: [string, PermissionMode][] = [
  ['Ask first', 'default'],
  ['Act', 'acceptEdits'],
  ['Full', 'bypassPermissions'],
];

describe.skipIf(BINARY === null)('person-only data files on the real CLI (DOR-3068 S1)', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'person-only-binary-')));
    home = path.join(root, 'home');
    dorkHome = path.join(root, 'data', 'dorkhome');
    account = path.join(root, 'accounts', 'work');
    folder = path.join(dorkHome, 'agents', 'scout');
    for (const dir of [home, account, folder]) fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  for (const [tool, calls] of CHANGES) {
    it.each(TARGETS)(
      `${tool} changes %s without the rules (the control)`,
      async (_label, where) => {
        const file = where();
        await runCalls(calls(file), 'bypassPermissions', false);
        expect(fs.readFileSync(file, 'utf8')).not.toBe(ORIGINAL);
      },
      60_000
    );

    for (const [level, mode] of LEVELS) {
      it.each(TARGETS)(
        `${tool} leaves %s byte for byte at ${level}`,
        async (_label, where) => {
          const file = where();
          await runCalls(calls(file), mode, true);
          expect(fs.readFileSync(file, 'utf8')).toBe(ORIGINAL);
        },
        60_000
      );
    }
  }

  it("refuses the agent's own skill too: the rule names every home, and frontmatter widens tools (DOR-3349 frees the body)", async () => {
    const file = plantLinked(folder, 'mine');
    await runCalls(CHANGES[1][1](file), 'bypassPermissions', true);
    expect(fs.readFileSync(file, 'utf8')).toBe(ORIGINAL);
  }, 60_000);

  it("still edits the agent's own CLAUDE.md under the rules (instructions, not a grant)", async () => {
    const file = plant(path.join(folder, 'CLAUDE.md'));
    await runCalls(CHANGES[1][1](file), 'bypassPermissions', true);
    expect(fs.readFileSync(file, 'utf8')).not.toBe(ORIGINAL);
  }, 60_000);

  it("still edits a skill in a repo worktree's .claude/skills, outside every agent home", async () => {
    const file = plant(path.join(root, 'repos', 'app-wt', '.claude', 'skills', 'x', 'SKILL.md'));
    await runCalls(CHANGES[1][1](file), 'bypassPermissions', true);
    expect(fs.readFileSync(file, 'utf8')).not.toBe(ORIGINAL);
  }, 60_000);

  it("still writes a plain file in the agent's own folder under the rules", async () => {
    const file = plant(path.join(folder, 'notes.md'));
    await runCalls(CHANGES[0][1](file), 'bypassPermissions', true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
  }, 60_000);
});
