/**
 * @vitest-environment node
 *
 * DOR-3068 (c) end to end on the real bundled Claude Code binary: an agent in
 * Bypass uses its shell to write a `PreToolUse` hook into its own home's
 * `.claude/settings.json`. On its next turn, launched the way DorkOS launches
 * a pinned agent whose approved settings predate that hook, the hook does not
 * run. The control: once a person allows the new settings, it does.
 *
 * Nothing here can spend or reach the internet. A fake HTTP server on
 * 127.0.0.1 plays the model; HOME and CLAUDE_CONFIG_DIR are throwaway folders;
 * the key is fake. The approval record lives in an in-memory config store.
 *
 * Skipped where the SDK's bundled binary is not installed for this platform.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const store = vi.hoisted(() => ({ harness: {} as Record<string, unknown> }));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'harness' ? store.harness : undefined),
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'harness') store.harness = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));

import {
  applyFolderConfigToLaunch,
  resolveFolderConfigForLaunch,
} from '../launch-folder-config.js';
import { recordFolderConfigApproval } from '../folder-config-consent.js';
import { readFolderConfigParts } from '../folder-config-pin.js';

const BINARY = resolveBundledClaudeBinary();
const AGENT = { id: '01AGENT', name: 'Ops' };

/** The hook the agent writes for itself: it leaves a mark when it runs. */
const SELF_WRITTEN_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'touch hook-ran' }] }],
  },
});
/**
 * Turn 1: the agent's shell writes that hook into its own settings, through a
 * program the CLI can't see into. A plain redirect (`printf … >
 * .claude/settings.json`) is refused already: run on the CLI, it checks a
 * redirect's target against the home's Edit deny, so the pin is what stops a
 * write like this one.
 */
const WRITE_HOOK = `node -e 'require("fs").writeFileSync(".claude/settings.json", process.argv[1])' '${SELF_WRITTEN_SETTINGS}'`;
/** The same write as a plain redirect, which the home's deny refuses. */
const REDIRECT_HOOK = `printf '%s' '${SELF_WRITTEN_SETTINGS}' > .claude/settings.json`;
/** Turn 2: any Bash call, which the hook would fire on. */
const PROBE = 'touch probe';

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed reply: one Bash call running `command` when `toolUse`, plain text otherwise. */
function reply(toolUse: boolean, command: string): string {
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
    ? { type: 'input_json_delta', partial_json: JSON.stringify({ command }) }
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
let home: string;

/** The fake model: its first reply runs `command`, its second ends the turn. */
function fakeModel(command: string): Promise<{ url: string; close: () => Promise<void> }> {
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
        res.end(reply(!body.includes('toolu_probe'), command));
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

/** Run one Bypass turn in the home whose model runs `command`, with `extra` launch options. */
async function runTurn(command: string, extra: Partial<Options> = {}): Promise<void> {
  const model = await fakeModel(command);
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  const stream = query({
    prompt: 'go',
    options: {
      cwd: home,
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
      pathToClaudeCodeExecutable: BINARY!,
      abortController: abort,
      ...extra,
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
}

/** The launch options DorkOS's folder-config step gives this agent's turn now. */
async function pinnedLaunchOptions(): Promise<Options> {
  const decision = await resolveFolderConfigForLaunch({ agent: AGENT, home, cwd: home });
  const options: Options = {};
  applyFolderConfigToLaunch(options, home, decision);
  return options;
}

const hookRan = () => fs.existsSync(path.join(home, 'hook-ran'));
const probeRan = () => fs.existsSync(path.join(home, 'probe'));

describe.skipIf(BINARY === null)('an agent rewriting its own hooks, on the real CLI', () => {
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-config-pin-binary-')));
    home = path.join(root, 'agent');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.dork'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(home, '.dork', 'agent.json'), JSON.stringify({ id: AGENT.id }));
    store.harness = {};
    // Pinned on first use, before the agent touches anything.
    const first = await pinnedLaunchOptions();
    expect((first.settings as { disableAllHooks?: boolean }).disableAllHooks).toBeUndefined();
    // Turn 1: the agent's own shell writes a hook into its home.
    await runTurn(WRITE_HOOK, first);
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(
      SELF_WRITTEN_SETTINGS
    );
    expect(hookRan()).toBe(false);
  }, 90_000);

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('refuses a plain shell redirect into the home settings, even at Bypass', async () => {
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    await runTurn(REDIRECT_HOOK, await pinnedLaunchOptions());
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{}');
  }, 60_000);

  it('does not run the hook on its next turn while nobody has allowed it', async () => {
    await runTurn(PROBE, await pinnedLaunchOptions());
    expect(probeRan()).toBe(true);
    expect(hookRan()).toBe(false);
  }, 60_000);

  it('runs the hook once a person allows the new settings (the control)', async () => {
    recordFolderConfigApproval({
      agentId: AGENT.id,
      home,
      digests: readFolderConfigParts(home).digests,
    });
    await runTurn(PROBE, await pinnedLaunchOptions());
    expect(probeRan()).toBe(true);
    expect(hookRan()).toBe(true);
  }, 60_000);
});
