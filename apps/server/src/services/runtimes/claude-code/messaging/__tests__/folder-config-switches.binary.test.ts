/**
 * @vitest-environment node
 *
 * DOR-3068 (c) against the real bundled Claude Code binary: what the two
 * launch switches DorkOS uses when an agent folder's hooks or MCP servers
 * changed since a person approved them actually do.
 *
 * - `settings.disableAllHooks` (flag layer) stops a project `PreToolUse` hook,
 *   and a project `disableAllHooks: false` cannot turn it back on;
 * - DorkOS's own SDK callback hooks still fire under it;
 * - the folder's `CLAUDE.md` still reaches the model;
 * - `strictMcpConfig` stops a project `.mcp.json` server from starting.
 *
 * Nothing here can spend or reach the internet. A fake HTTP server on
 * 127.0.0.1 plays the model: its first reply runs one `touch`, its second ends
 * the turn. Every case has a control that shows the hook or server running
 * without the switch.
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
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: () => undefined, set: vi.fn() },
}));

import { applyFolderConfigToLaunch } from '../../folder-settings/launch-folder-config.js';

const BINARY = resolveBundledClaudeBinary();
const CLAUDE_MD_MARK = 'folder-instructions-reached-the-model';

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streamed reply: one `touch probe` when `toolUse`, plain text otherwise. */
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
    ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'touch probe' }) }
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
/** Every request body the fake model saw, for the CLAUDE.md check. */
let bodies: string[];

/** The fake model. Records each request body. */
function fakeModel(): Promise<{ url: string; close: () => Promise<void> }> {
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
        bodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(reply(!body.includes('toolu_probe')));
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

/** Run one Bypass turn in the folder with `extra` launch options. */
async function runTurn(extra: Partial<Options> = {}): Promise<void> {
  const model = await fakeModel();
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const configDir = path.join(root, 'claude-config');
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

/** Write the folder's `.claude/settings.json`. */
function folderSettings(body: unknown): void {
  fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.claude', 'settings.json'), JSON.stringify(body));
}

/** A project PreToolUse hook that leaves a mark when it runs. */
const MARKING_HOOK = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'touch hook-ran' }] }],
  },
};

const hookRan = () => fs.existsSync(path.join(folder, 'hook-ran'));
const probeRan = () => fs.existsSync(path.join(folder, 'probe'));

describe.skipIf(BINARY === null)('the folder-config switches on the real CLI', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-config-binary-')));
    folder = path.join(root, 'agent');
    fs.mkdirSync(folder, { recursive: true });
    bodies = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('runs a project hook when nothing turns hooks off (the control)', async () => {
    folderSettings(MARKING_HOOK);
    await runTurn();
    expect(probeRan()).toBe(true);
    expect(hookRan()).toBe(true);
  }, 60_000);

  it('runs no project hook under a launch-layer disableAllHooks, and the turn still runs', async () => {
    folderSettings(MARKING_HOOK);
    await runTurn({ settings: { disableAllHooks: true } });
    expect(probeRan()).toBe(true);
    expect(hookRan()).toBe(false);
  }, 60_000);

  it('lets no project disableAllHooks: false turn hooks back on', async () => {
    folderSettings({ ...MARKING_HOOK, disableAllHooks: false });
    await runTurn({ settings: { disableAllHooks: true } });
    expect(hookRan()).toBe(false);
  }, 60_000);

  it('still fires DorkOS’s own SDK callback hooks under it', async () => {
    folderSettings(MARKING_HOOK);
    let called = 0;
    await runTurn({
      settings: { disableAllHooks: true },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async () => {
                called += 1;
                return {};
              },
            ],
          },
        ],
      },
    });
    expect(hookRan()).toBe(false);
    expect(called).toBeGreaterThan(0);
  }, 60_000);

  it('still hands the model the folder’s CLAUDE.md under it', async () => {
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), `Remember: ${CLAUDE_MD_MARK}.`);
    folderSettings(MARKING_HOOK);
    await runTurn({ settings: { disableAllHooks: true } });
    expect(bodies.some((body) => body.includes(CLAUDE_MD_MARK))).toBe(true);
  }, 60_000);

  describe('a project .mcp.json server', () => {
    /** A stdio "server" that only leaves a mark when Claude Code starts it. */
    function projectMcpServer(): void {
      const script = path.join(root, 'mark-server.cjs');
      fs.writeFileSync(
        script,
        `require('fs').writeFileSync(${JSON.stringify(path.join(folder, 'mcp-started'))}, '1');` +
          `setTimeout(() => process.exit(0), 2000);`
      );
      fs.writeFileSync(
        path.join(folder, '.mcp.json'),
        JSON.stringify({ mcpServers: { marker: { command: process.execPath, args: [script] } } })
      );
      folderSettings({ enableAllProjectMcpServers: true });
    }
    const mcpStarted = () => fs.existsSync(path.join(folder, 'mcp-started'));

    it('starts when nothing restricts MCP config (the control)', async () => {
      projectMcpServer();
      await runTurn();
      expect(mcpStarted()).toBe(true);
    }, 60_000);

    it('never starts under strictMcpConfig', async () => {
      projectMcpServer();
      await runTurn({ strictMcpConfig: true, mcpServers: {} });
      expect(mcpStarted()).toBe(false);
    }, 60_000);
  });

  // DOR-3068 M1: held hooks leave out the folder's own settings sources, so a
  // changed `env` or helper command has no effect, while CLAUDE.md still
  // reaches the model through the system prompt.
  describe('held hooks, launched the way DorkOS launches them', () => {
    /** The options a held launch carries, built by the real apply step. */
    function heldOptions(): Partial<Options> {
      const options: Options = {
        cwd: folder,
        settingSources: ['local', 'project', 'user'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      };
      applyFolderConfigToLaunch(options, folder, { held: ['hooks'], inHome: true });
      return options;
    }

    /** A folder `env` whose PATH puts a `touch` first that leaves its own mark. */
    function envOverride(): void {
      const bin = path.join(root, 'evil-bin');
      fs.mkdirSync(bin, { recursive: true });
      const fake = path.join(bin, 'touch');
      fs.writeFileSync(fake, `#!/bin/sh\n: > ${JSON.stringify(path.join(folder, 'env-ran'))}\n`);
      fs.chmodSync(fake, 0o755);
      folderSettings({ env: { PATH: `${bin}:${process.env.PATH ?? ''}` } });
    }
    const envRan = () => fs.existsSync(path.join(folder, 'env-ran'));

    /** A folder `apiKeyHelper` that leaves a mark when the CLI runs it. */
    function keyHelper(): void {
      const mark = path.join(folder, 'helper-ran');
      folderSettings({ apiKeyHelper: `: > ${JSON.stringify(mark)}; echo fake-key-never-real` });
    }
    const helperRan = () => fs.existsSync(path.join(folder, 'helper-ran'));

    it('applies a folder env when every source loads (the control)', async () => {
      envOverride();
      await runTurn();
      expect(envRan()).toBe(true);
    }, 60_000);

    it('applies no folder env under the hold, and the turn still runs', async () => {
      envOverride();
      await runTurn(heldOptions());
      expect(envRan()).toBe(false);
      expect(probeRan()).toBe(true);
    }, 60_000);

    it('runs a folder apiKeyHelper when every source loads (the control)', async () => {
      keyHelper();
      await runTurn();
      expect(helperRan()).toBe(true);
    }, 60_000);

    it('runs no folder apiKeyHelper under the hold', async () => {
      keyHelper();
      await runTurn(heldOptions());
      expect(helperRan()).toBe(false);
    }, 60_000);

    it('still hands the model the folder’s CLAUDE.md under the hold', async () => {
      fs.writeFileSync(path.join(folder, 'CLAUDE.md'), `Remember: ${CLAUDE_MD_MARK}.`);
      folderSettings(MARKING_HOOK);
      await runTurn(heldOptions());
      expect(hookRan()).toBe(false);
      expect(bodies.some((body) => body.includes(CLAUDE_MD_MARK))).toBe(true);
    }, 60_000);
  });
});
