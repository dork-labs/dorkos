/**
 * @vitest-environment node
 *
 * DOR-3068 against the real bundled Claude Code binary: with the deny every
 * launch carries for an agent home ({@link homeWriteDenyRules}), the model's
 * Edit can't change the home's skills, at Ask first, Act and Full. Harness
 * Sync links `.claude/skills/<x>` to `.agents/skills/<x>`, where the skill
 * really lives, so both spellings are tried, and so is a link under `.claude/`
 * that points out of the home altogether. Each refusal leaves the file byte
 * for byte as it was; the control shows the same Edit DOES change it without
 * the rules.
 *
 * Stand-in files only, in a throwaway folder; a fake HTTP server on 127.0.0.1
 * plays the model, so nothing spends or reaches the internet. The model reads
 * the file first, as the CLI requires before an Edit.
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
import { homeWriteDenyRules } from '../launch-folder-config.js';

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
let userHome: string;
let account: string;
let home: string;

/** Run one turn in the agent home that reads then edits `file`, with or without the home's deny. */
async function editIn(file: string, mode: PermissionMode, deny: boolean): Promise<void> {
  const calls: ToolCall[] = [
    { name: 'Read', input: { file_path: file } },
    {
      name: 'Edit',
      input: {
        file_path: file,
        old_string: 'allowed-tools: Read',
        new_string: 'allowed-tools: Bash',
      },
    },
  ];
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
  const rules = deny ? homeWriteDenyRules(home) : [];
  if (rules === undefined) throw new Error('the test home has to be nameable in a rule');
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const stream = query({
    prompt: 'change it',
    options: {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: userHome,
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
      ...(rules.length ? { settings: { permissions: { deny: rules } } } : {}),
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

const ORIGINAL = '---\nname: x\nallowed-tools: Read\n---\nDo the thing.\n';

/** Plant a skill holding {@link ORIGINAL} in `dir`, and link `.claude/skills/<name>` to it. */
function plantLinkedSkill(dir: string, name: string): { real: string; linked: string } {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), ORIGINAL);
  const link = path.join(home, '.claude', 'skills', name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), dir), link);
  return { real: path.join(dir, 'SKILL.md'), linked: path.join(link, 'SKILL.md') };
}

const LEVELS: [string, PermissionMode][] = [
  ['Ask first', 'default'],
  ['Act', 'acceptEdits'],
  ['Full', 'bypassPermissions'],
];

describe.skipIf(BINARY === null)('an agent editing its own skills, on the real CLI', () => {
  let skill: { real: string; linked: string };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-skills-binary-')));
    userHome = path.join(root, 'user');
    account = path.join(root, 'accounts', 'work');
    home = path.join(root, 'dork', 'agents', 'scout');
    for (const dir of [userHome, account, home]) fs.mkdirSync(dir, { recursive: true });
    skill = plantLinkedSkill(path.join(home, '.agents', 'skills', 'x'), 'x');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('edits the skill in .agents without the rules (the control)', async () => {
    await editIn(skill.real, 'bypassPermissions', false);
    expect(fs.readFileSync(skill.real, 'utf8')).not.toBe(ORIGINAL);
  }, 60_000);

  for (const [level, mode] of LEVELS) {
    it(`leaves the skill byte for byte when edited in .agents, at ${level}`, async () => {
      await editIn(skill.real, mode, true);
      expect(fs.readFileSync(skill.real, 'utf8')).toBe(ORIGINAL);
    }, 60_000);

    it(`leaves the skill byte for byte when edited through the .claude link, at ${level}`, async () => {
      await editIn(skill.linked, mode, true);
      expect(fs.readFileSync(skill.real, 'utf8')).toBe(ORIGINAL);
    }, 60_000);
  }

  it('refuses an edit through a .claude link that points out of the home, at Full', async () => {
    const outside = plantLinkedSkill(path.join(root, 'elsewhere', 'y'), 'y');
    await editIn(outside.linked, 'bypassPermissions', true);
    expect(fs.readFileSync(outside.real, 'utf8')).toBe(ORIGINAL);
  }, 60_000);
});
