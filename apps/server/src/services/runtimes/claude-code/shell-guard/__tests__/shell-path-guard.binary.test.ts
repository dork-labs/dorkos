/**
 * @vitest-environment node
 *
 * QA's gate for DOR-3300 against the real bundled Claude Code binary. Each row is one turn: a fake
 * model calls a tool, and the row reports what happened to it:
 *
 * - `ran`: the canary came back to the model.
 * - `asked`: DorkOS's own gate raised the ask (the session here has nobody to answer, so it ends).
 * - `refused`: the call reached a result with no canary and nobody was asked.
 *
 * The launch carries what a real one does: the deny rules (`applySecretReadDeny`), the real
 * `createCanUseTool`, and the real hook. Stand-in files only, in a throwaway home; `HOME` and
 * `CLAUDE_CONFIG_DIR` both point inside it. Nothing can spend or reach the internet: a fake HTTP
 * server on 127.0.0.1 plays the model, and the key is made up.
 *
 * Skipped where the SDK's bundled binary is not installed for this platform.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query, type Options, type PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { createCanUseTool } from '../../messaging/interactive-handlers.js';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { applySecretReadDeny } from '../../secret-files/secret-read-deny.js';
import { turnReadRoots } from '../../tool-gate/held-turn-reads.js';
import { resolveGuardChild } from '../guard-child-file.js';
import { GuardHost } from '../guard-host.js';
import { createShellPathGuardHook } from '../shell-path-guard.js';

const BINARY = resolveBundledClaudeBinary();
const CANARY = 'CANARY-dor3300';
/** The real child process, as a launch has it. */
const guardHost = new GuardHost({ childFile: resolveGuardChild, log: { warn: () => {} } });

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
let home: string;
let dorkHome: string;
let account: string;
let folder: string;
let agentHome: string;
let outside: string;
let plainFolder: string;
let refusals: string[];
let nextSession: string | undefined;

type Outcome = 'ran' | 'asked' | 'refused';

/** Run one turn that makes `call`, and say what happened to it. */
async function outcomeOf(
  call: ToolCall,
  mode: PermissionMode,
  cwd = folder,
  guard = true
): Promise<Outcome> {
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
  applySecretReadDeny(options, {
    dorkHome,
    accountRoot: account,
    otherAccountRoots: [],
    agentFolders: [cwd, agentHome],
  });
  const eventQueue: StreamEvent[] = [];
  const session = {
    permissionMode: mode,
    cwd,
    unattended: true,
    pendingInteractions: new Map(),
    eventQueue,
    eventQueueNotify: () => {},
  };
  const noopLog = { debug: () => {}, info: () => {}, warn: () => {} };
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CLAUDE_CONFIG_DIR: account,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'fake-key-never-real',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const stream = query({
    prompt: 'look it up',
    options: {
      cwd,
      env,
      permissionMode: mode,
      ...(nextSession ? { sessionId: nextSession } : {}),
      ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: createCanUseTool(
        session as never,
        noopLog,
        undefined,
        async () => ({ identity: { agentPath: agentHome } }),
        {
          cwd,
          roots: turnReadRoots({
            cwd,
            agentHome,
            grants: [],
            plugins: [],
            accountRoot: account,
          }),
        }
      ),
      hooks: {
        PreToolUse: guard
          ? [
              {
                matcher: 'Bash',
                hooks: [
                  createShellPathGuardHook(session as never, {
                    check: guardHost.check,
                    roots: () => ({
                      cwd,
                      dorkHome,
                      home,
                      accounts: [account],
                      env,
                      agentHomes: () => [agentHome],
                    }),
                    recordRefusal: ({ command }) => refusals.push(command),
                    log: noopLog,
                  }),
                ],
              },
            ]
          : [],
      },
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
  const results = bodies.join('\n');
  // The turn reached the tool's result, so the answer is real, not an abort.
  expect(results).toContain('toolu_probe');
  if (results.includes(CANARY)) return 'ran';
  return eventQueue.some((event) => event.type === 'permission_denied') ? 'asked' : 'refused';
}

/** Write a stand-in file holding the canary. */
function plant(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `secret=${CANARY}\n`);
  return file;
}

const BELOW_FULL: [string, PermissionMode][] = [
  ['Ask first', 'default'],
  ['Act', 'acceptEdits'],
];

describe.skipIf(BINARY === null)('shell and file reads on the real CLI (DOR-3300)', () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor3300-binary-')));
    home = path.join(root, 'home');
    dorkHome = path.join(root, 'data', 'dorkhome');
    account = path.join(root, 'accounts', 'work');
    folder = path.join(root, 'work', 'project');
    agentHome = path.join(dorkHome, 'agents', 'scout');
    outside = path.join(root, 'outside');
    plainFolder = path.join(root, 'work', 'plain');
    fs.mkdirSync(account, { recursive: true });
    plant(path.join(dorkHome, 'secrets', 'moved.txt'));
    plant(path.join(home, '.ssh', 'id_ed25519'));
    plant(path.join(folder, 'notes.md'));
    plant(path.join(folder, '.env'));
    plant(path.join(agentHome, 'memory.md'));
    plant(path.join(outside, 'plain.txt'));
    plant(path.join(plainFolder, 'notes.md'));
    fs.symlinkSync(path.join(outside, 'plain.txt'), path.join(folder, 'link-out.txt'));
    fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(folder, 'link-key.txt'));
    fs.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(agentHome, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(agentHome, '.mcp.json'), '{}\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Commands that reach a protected file, spelled every way QA's gate names. */
  const REACHING: [string, () => string][] = [
    ['cat the moved secret', () => `cat ${dorkHome}/secrets/moved.txt`],
    ['head an SSH key', () => `head -1 ~/.ssh/id_ed25519`],
    ['tail with $HOME', () => `tail -1 "$HOME/.ssh/id_ed25519"`],
    ['sed -n', () => `sed -n 1p ~/.ssh/id_ed25519`],
    ['awk', () => `awk '{print}' ~/.ssh/id_ed25519`],
    ['grep -r the secrets folder', () => `grep -r secret ${dorkHome}/secrets`],
    ['grep -r the home', () => `grep -r secret ~`],
    ['grep -r . over a .env', () => `grep -r secret .`],
    ['a glob', () => `cat ~/.s*/id_*`],
    ['chained after ls', () => `ls && cat ~/.ssh/id_ed25519`],
    ['chained grep -r', () => `ls && grep -r secret ${dorkHome}/secrets`],
    ['cd, then a relative path', () => `cd ~ && cat .ssh/id_ed25519`],
    ['a link to a key', () => `cat link-key.txt`],
  ];

  /**
   * What only this guard stops, measured on CLI 0.3.x: each ran silently before it. Everything in
   * {@link REACHING} but `grep -r .` the CLI's own rules already refuse or ask about.
   */
  const HAS_RG = spawnSync('rg', ['--version']).status === 0;
  const GUARD_ONLY: [string, string, () => string][] = [
    ['grep -r . over a .env', 'grep -r secret .', () => folder],
    ['the same, chained', 'ls && grep -r secret .', () => folder],
    ['the same, piped', 'grep -r secret . | head -5', () => folder],
    ['grep -r . from the home', 'grep -r secret .', () => home],
    ['grep -r . from the data folder', 'grep -r secret .', () => dorkHome],
    ['a glob over a .env', 'cat .e*', () => folder],
    ['a one-letter glob', 'head -1 .en?', () => folder],
    ['every file', 'cat * .*', () => folder],
    ...(HAS_RG
      ? ([
          ['rg -uu', 'rg -uu secret .', () => folder],
          ['rg --hidden', 'rg --hidden secret .', () => folder],
        ] as [string, string, () => string][])
      : []),
  ];

  // The CLI's own files: it reads these itself, so the gate's narrower rule raises no card for them.
  it.each([
    [
      'saved tool output',
      (sid: string, slug: string) => `projects/${slug}/${sid}/tool-results/x.txt`,
    ],
    ['a project memory note', (_sid: string, slug: string) => `projects/${slug}/memory/note.md`],
    ['a user skill file', () => 'skills/x/ref.md'],
  ] as [string, (sid: string, slug: string) => string][])(
    'at Ask first, %s stays silent',
    async (_label, where) => {
      const sid = randomUUID();
      nextSession = sid;
      try {
        // Never `MEMORY.md`: the CLI loads that into every request, so its canary would mark every
        // later row in this file as `ran`.
        const slug = folder.replace(/[^a-zA-Z0-9]/g, '-');
        const file = plant(path.join(account, where(sid, slug)));
        const call = { name: 'Read', input: { file_path: file } };
        expect(await outcomeOf(call, 'default')).toBe('ran');
      } finally {
        nextSession = undefined;
      }
    },
    60_000
  );

  for (const [level, mode] of BELOW_FULL) {
    it.each(REACHING)(
      `at ${level}, %s never runs silently`,
      async (_label, command) => {
        const outcome = await outcomeOf({ name: 'Bash', input: { command: command() } }, mode);
        expect(outcome).not.toBe('ran');
      },
      60_000
    );

    it.each(GUARD_ONLY)(
      `at ${level}, %s asks`,
      async (_label, command, cwd) => {
        const outcome = await outcomeOf({ name: 'Bash', input: { command } }, mode, cwd());
        expect(outcome).toBe('asked');
      },
      60_000
    );

    it.each([
      ['Read in the working folder', () => path.join(folder, 'notes.md')],
      ['Read in the agent home', () => path.join(agentHome, 'memory.md')],
    ])(
      `at ${level}, %s stays silent`,
      async (_label, file) => {
        const call = { name: 'Read', input: { file_path: file() } };
        expect(await outcomeOf(call, mode)).toBe('ran');
      },
      60_000
    );

    it.each([
      ['outside every folder', () => path.join(outside, 'plain.txt')],
      ['through a link in the working folder', () => path.join(folder, 'link-out.txt')],
    ])(
      `at ${level}, Read %s asks`,
      async (_label, file) => {
        const call = { name: 'Read', input: { file_path: file() } };
        expect(await outcomeOf(call, mode)).toBe('asked');
      },
      60_000
    );

    it(`at ${level}, a shell read in a clean folder stays silent`, async () => {
      const call = { name: 'Bash', input: { command: 'grep -r secret . && cat notes.md' } };
      expect(await outcomeOf(call, mode, plainFolder)).toBe('ran');
    }, 60_000);
  }

  it('at Never ask, a read-only shell command on a protected path is refused', async () => {
    const call = { name: 'Bash', input: { command: 'head -1 ~/.ssh/id_ed25519' } };
    expect(await outcomeOf(call, 'dontAsk')).not.toBe('ran');
  }, 60_000);

  it('at Full, the shell still reads a file that no rule names: the stated limit', async () => {
    const call = { name: 'Bash', input: { command: `cat ${outside}/plain.txt` } };
    expect(await outcomeOf(call, 'bypassPermissions')).toBe('ran');
  }, 60_000);

  it('at Full, a search that never names the secret still reads: the stated limit', async () => {
    const call = { name: 'Bash', input: { command: 'grep -r secret .' } };
    expect(await outcomeOf(call, 'bypassPermissions')).toBe('ran');
  }, 60_000);

  // The control: with the guard off these same commands run silently, so an `asked` above is the
  // guard's doing and not the CLI's own.
  it.each(GUARD_ONLY)(
    'without the guard, %s runs silently at Ask first (the control)',
    async (_label, command, cwd) => {
      const call = { name: 'Bash', input: { command } };
      expect(await outcomeOf(call, 'default', cwd(), false)).toBe('ran');
    },
    60_000
  );

  it.each([
    ['a redirect', () => `echo '{}' > ${agentHome}/.claude/settings.json`],
    [
      'a collating symbol in .claude',
      () => `/bin/bash -c 'echo x > ${agentHome}/.cl[[.a.]]ude/settings.json'`,
    ],
    [
      'a collating symbol in .mcp.json',
      () => `/bin/bash -c 'echo x > ${agentHome}/.m[[.c.]]p.json'`,
    ],
    [
      'an equivalence class in settings.json',
      () => `/bin/bash -c 'echo x > ${agentHome}/.claude/settings.js[[=o=]]n'`,
    ],
    [
      'Bash from zsh with an equivalence class',
      () => `/bin/zsh -c "/bin/bash -c 'echo x > ${agentHome}/.m[[=c=]]p.json'"`,
    ],
    [
      'a python heredoc',
      () => `python3 - <<'EOF'\nopen('${agentHome}/.claude/settings.json','w').write('{}')\nEOF`,
    ],
    ['a move', () => `mv ${agentHome}/.claude/settings.json /tmp/dor3300-moved.json`],
  ])(
    'at Full, %s into an agent’s setup is refused and recorded',
    async (_label, command) => {
      refusals = [];
      fs.writeFileSync(path.join(agentHome, '.claude', 'settings.json'), 'unchanged\n');
      fs.writeFileSync(path.join(agentHome, '.mcp.json'), 'unchanged\n');
      const call = { name: 'Bash', input: { command: command() } };
      expect(await outcomeOf(call, 'bypassPermissions')).toBe('refused');
      expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toBe(
        'unchanged\n'
      );
      expect(refusals).toEqual([command()]);
      expect(fs.readFileSync(path.join(agentHome, '.mcp.json'), 'utf8')).toBe('unchanged\n');
    },
    60_000
  );
});
