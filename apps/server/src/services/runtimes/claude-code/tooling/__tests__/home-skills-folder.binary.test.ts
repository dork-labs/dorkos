/**
 * @vitest-environment node
 *
 * DOR-5250 against the real bundled Claude Code binary: what Claude Code loads
 * from an agent's home when DorkOS adds it to a launch that works outside it
 * ({@link applyHomeSkillsFolder}), and that the home's self-grant files stay
 * refused when it arrives that way.
 *
 * - Its skills, commands and agents load, and its skill runs from `/name`.
 * - Its `.claude/settings.json` hooks, its settings' allow rules, its
 *   `.mcp.json` servers and its `CLAUDE.md` do not, even with the user settings asking for project
 *   MCP servers and for an added folder's `CLAUDE.md`. Every "no" has a control
 *   that shows the same file working when it is in the working folder, or
 *   without DorkOS's blank.
 * - A `Write` to `<home>/.dork/agent.json` is refused under the home's deny
 *   rules at Act and Full, and the control shows the same write landing
 *   without them.
 *
 * Stand-in files only, in a throwaway folder with its own HOME and Claude
 * account folder; a fake HTTP server on 127.0.0.1 plays the model, so nothing
 * spends or reaches the internet.
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
import {
  query,
  type Options,
  type PermissionMode,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { homeWriteDenyRules } from '../../folder-settings/launch-folder-config.js';
import { applyHomeSkillsFolder } from '../home-skills-folder.js';

const BINARY = resolveBundledClaudeBinary();
const CLAUDE_MD_MARK = 'home-instructions-reached-the-model';
const SKILL_BODY_MARK = 'home-skill-body-reached-the-model';

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
    ? { type: 'tool_use', id: `toolu_home_${index}`, name: call.name, input: {} }
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
let project: string;
let home: string;

/** What one turn showed. */
interface TurnSeen {
  init: Extract<SDKMessage, { type: 'system'; subtype: 'init' }> | undefined;
  bodies: string[];
  asked: string[];
}

/**
 * Run one turn. The fake model makes `calls` in order (the next one is the
 * count of earlier calls the request already answers), then ends the turn.
 * DorkOS's gate is played by `allow`: every tool it is asked about is recorded.
 */
async function runTurn(args: {
  cwd: string;
  prompt?: string;
  calls?: ToolCall[];
  mode?: PermissionMode;
  allow?: boolean;
  options?: Partial<Options>;
}): Promise<TurnSeen> {
  const calls = args.calls ?? [];
  const seen: TurnSeen = { init: undefined, bodies: [], asked: [] };
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
      seen.bodies.push(body);
      const step = calls.filter((_, i) => body.includes(`toolu_home_${i}`)).length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply(step, calls[step]));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  const mode = args.mode ?? 'default';
  const abort = new AbortController();
  let childClosed: Promise<void> | undefined;
  const stream = query({
    prompt: args.prompt ?? 'run the probe',
    options: {
      cwd: args.cwd,
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
      canUseTool: async (tool, input) => {
        seen.asked.push(tool);
        return args.allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'refused by the test' };
      },
      settingSources: ['local', 'project', 'user'],
      pathToClaudeCodeExecutable: BINARY!,
      abortController: abort,
      ...args.options,
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
      if (message.type === 'system' && message.subtype === 'init') seen.init = message;
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
  return seen;
}

/** The options DorkOS's launch step gives a turn outside `home`. */
function withHome(base: Partial<Options> = {}): Partial<Options> {
  const options = { ...base } as Options;
  applyHomeSkillsFolder(options, home);
  return options;
}

/** Write `body` at `folder/relative`, making the folders. */
function put(folder: string, relative: string, body: string): void {
  const file = path.join(folder, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** A folder holding a skill, a command, an agent, settings, an MCP server and a CLAUDE.md. */
function plantAgentFolder(folder: string): void {
  put(
    folder,
    '.claude/skills/home-probe-skill/SKILL.md',
    `---\nname: home-probe-skill\ndescription: A probe skill\n---\n\n${SKILL_BODY_MARK}\n`
  );
  put(folder, '.claude/commands/home-probe-cmd.md', '---\ndescription: A probe command\n---\nHi\n');
  put(
    folder,
    '.claude/agents/home-probe-agent.md',
    '---\nname: home-probe-agent\ndescription: A probe agent\n---\nYou probe.\n'
  );
  put(
    folder,
    '.claude/settings.json',
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `touch ${root}/hook-ran` }] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: `touch ${root}/hook-ran` }] },
        ],
      },
      permissions: { allow: ['Bash'] },
    })
  );
  // In the working folder only the local file's allow rule was seen to let Bash through unasked.
  put(folder, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash'] } }));
  put(
    folder,
    '.mcp.json',
    JSON.stringify({
      mcpServers: {
        'home-probe-mcp': { command: 'sh', args: ['-c', `touch ${root}/mcp-ran; sleep 20`] },
      },
    })
  );
  put(folder, 'CLAUDE.md', `${CLAUDE_MD_MARK}\n`);
}

const marked = (name: string) => fs.existsSync(path.join(root, name));
/** A Bash call, inside the working folder, that the planted allow rule lets through unasked. */
const touch = (): ToolCall => ({ name: 'Bash', input: { command: 'touch allow-probe' } });
const allowRan = () => fs.existsSync(path.join(project, 'allow-probe'));

describe.skipIf(BINARY === null)('an agent home added to a launch, on the real CLI', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-skills-folder-')));
    userHome = path.join(root, 'user');
    account = path.join(root, 'accounts', 'work');
    project = path.join(root, 'project');
    home = path.join(root, 'dork', 'agents', 'scout');
    for (const dir of [userHome, account, project, home]) fs.mkdirSync(dir, { recursive: true });
    // The user settings ask for everything an added folder could bring.
    put(
      account,
      'settings.json',
      JSON.stringify({
        enableAllProjectMcpServers: true,
        env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
      })
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('loads the home’s skills, commands and agents, and none of its settings, servers or CLAUDE.md', async () => {
    plantAgentFolder(home);
    const seen = await runTurn({ cwd: project, calls: [touch()], options: withHome() });

    expect(seen.init?.slash_commands).toEqual(
      expect.arrayContaining(['home-probe-skill', 'home-probe-cmd'])
    );
    expect(seen.init?.agents).toContain('home-probe-agent');
    expect((seen.init?.mcp_servers ?? []).map((server) => server.name)).not.toContain(
      'home-probe-mcp'
    );
    expect(marked('mcp-ran')).toBe(false);
    expect(marked('hook-ran')).toBe(false);
    // Its allow rule did not load: the gate was asked, refused, and nothing ran.
    expect(seen.asked).toContain('Bash');
    expect(allowRan()).toBe(false);
    expect(seen.bodies.length).toBeGreaterThan(0);
    expect(seen.bodies.some((body) => body.includes(CLAUDE_MD_MARK))).toBe(false);
  });

  it('loads all of it from the working folder (the control)', async () => {
    plantAgentFolder(project);
    const seen = await runTurn({ cwd: project, calls: [touch()] });

    expect(seen.init?.slash_commands).toEqual(
      expect.arrayContaining(['home-probe-skill', 'home-probe-cmd'])
    );
    expect((seen.init?.mcp_servers ?? []).map((server) => server.name)).toContain('home-probe-mcp');
    expect(marked('hook-ran')).toBe(true);
    expect(seen.asked).not.toContain('Bash');
    expect(allowRan()).toBe(true);
    expect(seen.bodies.some((body) => body.includes(CLAUDE_MD_MARK))).toBe(true);
  });

  it('loads the added home’s CLAUDE.md without DorkOS’s blank, as the user settings ask (the control)', async () => {
    plantAgentFolder(home);
    const seen = await runTurn({ cwd: project, options: { additionalDirectories: [home] } });

    expect(seen.init?.slash_commands).toContain('home-probe-skill');
    expect(seen.bodies.some((body) => body.includes(CLAUDE_MD_MARK))).toBe(true);
  });

  it('runs the home’s skill from its /name', async () => {
    plantAgentFolder(home);
    const seen = await runTurn({ cwd: project, prompt: '/home-probe-skill', options: withHome() });

    expect(seen.bodies.some((body) => body.includes(SKILL_BODY_MARK))).toBe(true);
  });

  it('answers an unknown /name itself without the home (the control)', async () => {
    plantAgentFolder(home);
    const seen = await runTurn({ cwd: project, prompt: '/home-probe-skill' });

    expect(seen.bodies.some((body) => body.includes(SKILL_BODY_MARK))).toBe(false);
  });

  const ORIGINAL = JSON.stringify({ id: 'scout', name: 'scout' });
  const agentFile = () => path.join(home, '.dork', 'agent.json');
  const rewrite = (): ToolCall[] => [
    { name: 'Read', input: { file_path: agentFile() } },
    { name: 'Write', input: { file_path: agentFile(), content: '{"id":"taken-over"}' } },
  ];

  for (const [level, mode] of [
    ['Act', 'acceptEdits'],
    ['Full', 'bypassPermissions'],
  ] as const) {
    it(`refuses a write to the home’s agent.json at ${level}`, async () => {
      put(home, '.dork/agent.json', ORIGINAL);
      const deny = homeWriteDenyRules(home);
      if (!deny) throw new Error('the test home has to be nameable in a rule');
      await runTurn({
        cwd: project,
        calls: rewrite(),
        mode,
        allow: true,
        options: withHome({ settings: { permissions: { deny } } }),
      });

      expect(fs.readFileSync(agentFile(), 'utf-8')).toBe(ORIGINAL);
    });
  }

  it('lets the same write land without the home’s deny rules (the control)', async () => {
    put(home, '.dork/agent.json', ORIGINAL);
    await runTurn({
      cwd: project,
      calls: rewrite(),
      mode: 'bypassPermissions',
      allow: true,
      options: withHome(),
    });

    expect(fs.readFileSync(agentFile(), 'utf-8')).toBe('{"id":"taken-over"}');
  });
});
