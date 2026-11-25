/**
 * @vitest-environment node
 *
 * DOR-3039 and DOR-3042 against the real bundled Claude Code binary: a rule
 * passed in the launch's own `settings` (what `mergeFolderAllows` writes) is
 * honoured under Never ask (`dontAsk`), and a deny in the folder still wins
 * over it. DOR-5237: below Full, the launch's hooks put to a person what only
 * a folder setting nobody approved would allow.
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
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { mergeFolderAllows, selfGrantDenyRules } from '../apply-folder-allows.js';
import { createHeldTurnHook } from '../../tool-gate/held-turn-hook.js';
import {
  watchFolderAllows,
  type FolderAllowRecords,
  type FolderAllowWatch,
} from '../../tool-gate/folder-file-allows.js';
import {
  readLocalSettings,
  readLocalSettingsWithAllows,
} from '../../repo-settings/repo-local-settings.js';
import {
  readFolderSettingsEntries,
  settingsFolders,
} from '../../tool-gate/folder-settings-files.js';

const BINARY = resolveBundledClaudeBinary();
/** Throwaway HOME roots on the evidence drive when mounted, never the real account. */
const TEST_HOMES = fs.existsSync('/Volumes/ext-ssd-1/dork-os')
  ? '/Volumes/ext-ssd-1/dork-os/test-homes/2026-11-02-dor-3651'
  : os.tmpdir();
fs.mkdirSync(TEST_HOMES, { recursive: true });
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
/** Every request body the fake model was sent, so a test can see what a tool result carried. */
const MODEL_BODIES: string[] = [];

/** A streamed reply: `call` when `toolUse`, plain text otherwise. */
function reply(toolUse: boolean, call: ToolCall, id = 'toolu_probe'): string {
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
    ? { type: 'tool_use', id, name: call.name, input: {} }
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
 * The fake model. It makes `calls` in order, one per reply, then ends the turn
 * once every call's result is back. Non-message endpoints get 404.
 */
function fakeModel(call: ToolCall | ToolCall[] = PROBE_CALL): Promise<FakeModel> {
  const calls = Array.isArray(call) ? call : [call];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        MODEL_BODIES.push(body);
        if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no' } })
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const next = calls.findIndex((_, i) => !body.includes(callId(i)));
        res.end(next === -1 ? reply(false, calls[0]) : reply(true, calls[next], callId(next)));
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

/** The tool-use id of the fake model's `index`th call; the first is the probe's. */
function callId(index: number): string {
  return index === 0 ? 'toolu_probe' : `toolu_probe_${index}`;
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
  configDir = path.join(root, 'claude-config'),
  extra: Partial<Options> = {}
): Promise<SDKResultMessage | undefined> {
  let result: SDKResultMessage | undefined;
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
      ...extra,
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
      if (message.type === 'result') {
        result = message;
        break;
      }
    }
  } catch {
    // Aborted, or the CLI gave up on the fake server.
  } finally {
    clearTimeout(deadline);
    abort.abort();
    stream.close();
    await childClosed;
  }
  return result;
}

/** Write the folder's own `.claude/settings.json`. */
function folderSettings(body: unknown): void {
  fs.writeFileSync(path.join(folder, '.claude', 'settings.json'), JSON.stringify(body));
}

describe.skipIf(BINARY === null)('an agent folder allow list under Never ask', () => {
  beforeEach(async () => {
    model = await fakeModel();
    root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_HOMES, 'folder-allows-binary-')));
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

  it('runs only the command named by the approved rule at a scheduled task’s Don’t ask mode (DOR-3651)', async () => {
    const options: Options = {};
    mergeFolderAllows(options, [`Bash(${COMMAND})`], []);
    expect(await probeRan(options.settings)).toBe(true);
    fs.rmSync(path.join(folder, PROBE));
    await model.close();
    const otherProbe = 'another-probe';
    model = await fakeModel({ name: 'Bash', input: { command: `touch ${otherProbe}` } });
    const refused = await runTurn(options.settings);
    expect(refused?.permission_denials).toEqual([
      expect.objectContaining({
        tool_name: 'Bash',
        tool_input: { command: `touch ${otherProbe}` },
      }),
    ]);
    expect(fs.existsSync(path.join(folder, otherProbe))).toBe(false);
    expect((options.settings as { permissions: { allow: string[] } }).permissions.allow).toEqual([
      `Bash(${COMMAND})`,
    ]);
    expect(options.allowedTools).toBeUndefined();
  }, 120_000);

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
    root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_HOMES, 'self-grant-binary-')));
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

  it('refuses a write through a symlink in the home that points into the data folder', async () => {
    // QA's gate row: `docs` -> the data folder, with `Edit(docs/**)` approved.
    // That rule alone the CLI already refuses here (the real path is outside
    // the folder), so `Write` and `Edit(//**)` ride too: the control proves the
    // write lands, and the deny then has to match the RESOLVED path to stop it.
    fs.symlinkSync(dorkHome, path.join(folder, 'docs'));
    const target = path.join(folder, 'docs', 'config.json');
    const options: Options = {};
    const run = async (deny: readonly string[]) => {
      fs.writeFileSync(path.join(dorkHome, 'config.json'), '{}');
      await model.close();
      model = await fakeModel({ name: 'Write', input: { file_path: target, content: MARK } });
      mergeFolderAllows(options, ['Edit(docs/**)', 'Write', 'Edit(//**)'], deny);
      await runTurn(options.settings, account);
      options.settings = undefined;
      return fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf8') === MARK;
    };
    expect(await run([])).toBe(true);
    expect(await run(launchDeny())).toBe(false);
  }, 120_000);

  it('still writes in its own home, and in a workspace', async () => {
    expect(await wrote(path.join(folder, 'notes.md'), launchDeny())).toBe(true);
    expect(await wrote(path.join(dorkHome, 'workspaces', 'p', 'a.ts'), launchDeny())).toBe(true);
  }, 120_000);
});

/**
 * DOR-5237. The launch's hooks as they ride a turn below Full, with the records handed in, so
 * nothing here touches DorkOS's config. Each case has a control without the hooks. What each case
 * covers is recorded on DOR-5237.
 */
describe.skipIf(BINARY === null)('folder settings below Full (DOR-5237), part 1', () => {
  /** Write the folder's own `.claude/settings.local.json`. */
  function localSettings(body: unknown): void {
    fs.writeFileSync(path.join(folder, '.claude', 'settings.local.json'), JSON.stringify(body));
  }

  /** Nothing approved, unless a test says so. */
  function records(approved?: string[]): FolderAllowRecords {
    return {
      approvedRules: () => approved,
      approvedLocalSettings: () => undefined,
      rememberPersonAlwaysAllow: () => {},
    };
  }

  /** The check for a turn standing in the agent's home. */
  function watch(approved?: string[]): FolderAllowWatch {
    return watchFolderAllows(
      {
        agentId: 'agent-ana',
        home: folder,
        cwd: folder,
        dorkHome: root,
        launchAllows: [],
        launchDirs: [],
        userHome: root,
      },
      records(approved)
    );
  }

  /** The launch's options for one turn at `mode`, with the hook, or the CLI alone. */
  function launch(
    mode: Options['permissionMode'],
    check: FolderAllowWatch | undefined,
    canUseTool?: Options['canUseTool']
  ): Partial<Options> {
    const session = { permissionMode: mode as 'default' };
    const folders = { cwd: folder, roots: [folder] };
    return {
      permissionMode: mode,
      ...(canUseTool ? { canUseTool } : {}),
      ...(check
        ? {
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    createHeldTurnHook(
                      session,
                      async () => ({}),
                      { debug() {}, info() {} },
                      folders,
                      check
                    ),
                  ],
                },
              ],
            },
          }
        : {}),
    };
  }

  /** A person who says no to every card, and remembers being asked. */
  function denying(): { asked: string[]; canUseTool: NonNullable<Options['canUseTool']> } {
    const asked: string[] = [];
    return {
      asked,
      canUseTool: async (toolName) => {
        asked.push(toolName);
        return { behavior: 'deny', message: 'no' };
      },
    };
  }

  const ran = () => fs.existsSync(path.join(folder, PROBE));

  beforeEach(async () => {
    model = await fakeModel();
    root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_HOMES, 'folder-local-allows-binary-')));
    folder = path.join(root, 'agent');
    fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await model.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('case 1.1: asks under a rule nobody approved', async () => {
    localSettings({ permissions: { allow: [`Bash(${COMMAND})`] } });
    // The control, without the hooks.
    await runTurn(undefined, undefined, launch('dontAsk', undefined));
    expect(ran()).toBe(true);
    fs.rmSync(path.join(folder, PROBE));
    await runTurn(undefined, undefined, launch('dontAsk', watch()));
    expect(ran()).toBe(false);
  }, 120_000);

  it('case 1.2: puts the call to a person under Default', async () => {
    localSettings({ permissions: { allow: ['Bash'] } });
    const alone = denying();
    await runTurn(undefined, undefined, launch('default', undefined, alone.canUseTool));
    expect({ ran: ran(), asked: alone.asked }).toEqual({ ran: true, asked: [] });
    fs.rmSync(path.join(folder, PROBE));
    const person = denying();
    await runTurn(undefined, undefined, launch('default', watch(), person.canUseTool));
    expect({ ran: ran(), asked: person.asked }).toEqual({ ran: false, asked: ['Bash'] });
  }, 120_000);

  it('case 1.3: runs a rule a person approved', async () => {
    localSettings({ permissions: { allow: [`Bash(${COMMAND})`] } });
    await runTurn(undefined, undefined, launch('dontAsk', watch([`Bash(${COMMAND})`])));
    expect(ran()).toBe(true);
  }, 60_000);

  it('case 1.4: asks under a rule added during the turn', async () => {
    // The first call writes the rule with a script the launch allows by name, the second runs
    // the probe. The control runs without the hooks.
    const rule = JSON.stringify({ permissions: { allow: ['Bash'] } });
    fs.writeFileSync(
      path.join(folder, 'write-rule.py'),
      // The script waits a moment before the next call.
      `import time\nopen('.claude/settings.local.json', 'w').write(${JSON.stringify(rule)})\ntime.sleep(3)\n`
    );
    const write = 'python3 write-rule.py';
    const calls: ToolCall[] = [{ name: 'Bash', input: { command: write } }, PROBE_CALL];
    const allowWrite: Options = {};
    mergeFolderAllows(allowWrite, [`Bash(${write})`], []);
    await model.close();
    model = await fakeModel(calls);
    const control = await runTurn(allowWrite.settings, undefined, launch('dontAsk', undefined));
    expect(control?.permission_denials).toEqual([]);
    expect(ran()).toBe(true);
    fs.rmSync(path.join(folder, PROBE));
    fs.rmSync(path.join(folder, '.claude', 'settings.local.json'));
    await model.close();
    model = await fakeModel(calls);
    const check = watchFolderAllows(
      {
        agentId: 'agent-ana',
        home: folder,
        cwd: folder,
        dorkHome: root,
        launchAllows: [`Bash(${write})`],
        launchDirs: [],
        userHome: root,
      },
      records()
    );
    await runTurn(allowWrite.settings, undefined, launch('dontAsk', check));
    expect(fs.existsSync(path.join(folder, '.claude', 'settings.local.json'))).toBe(true);
    expect(ran()).toBe(false);
  }, 120_000);

  it('case 1.5: records a person’s Always allow as it is kept', async () => {
    localSettings({
      env: { A: '1' },
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
    });
    let predicted: string | undefined;
    await runTurn(undefined, undefined, {
      permissionMode: 'default',
      canUseTool: async (_tool, input, context) => {
        const rules = (context.suggestions ?? []).flatMap((update) =>
          update.type === 'addRules' && update.destination === 'localSettings'
            ? update.rules.map((r) =>
                r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName
              )
            : []
        );
        predicted = readLocalSettingsWithAllows(folder, root, rules)?.digest;
        return { behavior: 'allow', updatedInput: input, updatedPermissions: context.suggestions };
      },
    });
    expect(ran()).toBe(true);
    expect(predicted).toBeDefined();
    expect(readLocalSettings(folder, root)?.digest).toBe(predicted);
  }, 60_000);
});

/**
 * DOR-5237, continued: each case runs once without the hooks (the control) and once with them, and
 * a person who says no. What each case covers is recorded on DOR-5237.
 */
describe.skipIf(BINARY === null)('folder settings below Full (DOR-5237), part 2', () => {
  const SECRET = 'MADE-UP-SECRET-7731';
  let outside: string;

  /** Write `<dir>/.claude/<file>`. */
  function settingsAt(dir: string, body: unknown, file = 'settings.local.json'): void {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', file), JSON.stringify(body));
  }

  /** A turn's options at `mode` in `cwd`, with the launch's hook unless `alone`. */
  function turnOptions(
    mode: Options['permissionMode'],
    where: { cwd: string; home: string; approved?: string[] },
    asked: string[],
    alone: boolean
  ): Partial<Options> {
    const check = watchFolderAllows(
      {
        agentId: 'agent-ana',
        home: where.home,
        cwd: where.cwd,
        dorkHome: path.join(root, 'dork'),
        launchAllows: [],
        launchDirs: [],
        userHome: root,
        // What the launch's repo check reports when it compared the working folder's settings.
        compared: {
          folder: fs.realpathSync(where.cwd),
          ...(({ rules, dirs }) => ({ rules, dirs }))(
            readFolderSettingsEntries(where.cwd, ['settings.json'])
          ),
        },
      },
      {
        approvedRules: () => where.approved,
        approvedLocalSettings: () => undefined,
        rememberPersonAlwaysAllow: () => {},
      }
    );
    const hook = createHeldTurnHook(
      { permissionMode: mode as 'default' },
      async () => ({}),
      { debug() {}, info() {} },
      { cwd: where.cwd, roots: [where.cwd] },
      check
    );
    return {
      cwd: where.cwd,
      permissionMode: mode,
      canUseTool: async (toolName) => {
        asked.push(toolName);
        return { behavior: 'deny', message: 'no' };
      },
      ...(alone ? {} : { hooks: { PreToolUse: [{ hooks: [hook] }] } }),
    };
  }

  /** Run one call both ways; say what each run did. */
  async function bothWays(
    call: ToolCall,
    mode: Options['permissionMode'],
    where: { cwd: string; home: string; approved?: string[] },
    effect: () => boolean,
    configDir?: string
  ): Promise<{ alone: boolean; hooked: boolean; asked: string[] }> {
    const results: boolean[] = [];
    const asked: string[] = [];
    for (const alone of [true, false]) {
      MODEL_BODIES.length = 0;
      await model.close();
      model = await fakeModel(call);
      const mine: string[] = [];
      await runTurn(undefined, configDir, turnOptions(mode, where, mine, alone));
      results.push(effect());
      if (!alone) asked.push(...mine);
      for (const made of ['t.txt', 'w.txt']) fs.rmSync(path.join(outside, made), { force: true });
      fs.rmSync(path.join(where.cwd, PROBE), { force: true });
    }
    return { alone: results[0]!, hooked: results[1]!, asked };
  }

  const leaked = () => MODEL_BODIES.some((body) => body.includes(SECRET));
  const secret = () => path.join(outside, 'secret.txt');
  const atHome = () => ({ cwd: folder, home: folder });

  beforeEach(async () => {
    model = await fakeModel();
    root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_HOMES, 'folder-opens-binary-')));
    folder = path.join(root, 'agent');
    outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET);
  });

  afterEach(async () => {
    await model.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.each(['default', 'dontAsk'] as const)(
    'case 2.1: asks, at %s',
    async (mode) => {
      settingsAt(folder, { permissions: { allow: ['Read(//**)'] } });
      const call = { name: 'Bash', input: { command: `cat ${secret()}` } };
      const run = await bothWays(call, mode, atHome(), leaked);
      expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: true, hooked: false });
      if (mode === 'default') expect(run.asked).toEqual(['Bash']);
    },
    120_000
  );

  it('case 2.2: asks under Accept edits', async () => {
    settingsAt(folder, { permissions: { allow: ['Edit(//**)'] } });
    const target = path.join(outside, 't.txt');
    const call = { name: 'Bash', input: { command: `touch ${target}` } };
    const run = await bothWays(call, 'acceptEdits', atHome(), () => fs.existsSync(target));
    expect(run).toEqual({ alone: true, hooked: false, asked: ['Bash'] });
  }, 120_000);

  it.each(['default', 'dontAsk'] as const)(
    'case 2.3: asks, at %s',
    async (mode) => {
      settingsAt(folder, { permissions: { additionalDirectories: [outside] } });
      const call = { name: 'Read', input: { file_path: secret() } };
      const run = await bothWays(call, mode, atHome(), leaked);
      expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: true, hooked: false });
    },
    120_000
  );

  it('case 2.4: asks under Accept edits', async () => {
    settingsAt(folder, { permissions: { additionalDirectories: [outside] } });
    const target = path.join(outside, 'w.txt');
    const call = { name: 'Write', input: { file_path: target, content: 'x' } };
    const run = await bothWays(call, 'acceptEdits', atHome(), () => fs.existsSync(target));
    expect(run).toEqual({ alone: true, hooked: false, asked: ['Write'] });
  }, 120_000);

  it('case 2.5: asks from below the home', async () => {
    execFileSync('git', ['init', '-q'], { cwd: folder });
    settingsAt(folder, { permissions: { allow: ['Bash'] } });
    const sub = path.join(folder, 'sub');
    fs.mkdirSync(sub);
    const run = await bothWays(PROBE_CALL, 'dontAsk', { cwd: sub, home: folder }, () =>
      fs.existsSync(path.join(sub, PROBE))
    );
    expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: true, hooked: false });
  }, 120_000);

  it('case 2.6: asks in a home inside a repo', async () => {
    const repo = path.join(root, 'repo');
    const agent = path.join(repo, 'agent');
    fs.mkdirSync(path.join(agent, '.claude'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    settingsAt(repo, { permissions: { allow: ['Bash'] } });
    const run = await bothWays(
      PROBE_CALL,
      'dontAsk',
      { cwd: agent, home: agent, approved: ['Bash'] },
      () => fs.existsSync(path.join(agent, PROBE))
    );
    expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: true, hooked: false });
  }, 120_000);

  it('case 2.7: pins the person’s home folder', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    settingsAt(root, { permissions: { allow: ['Bash'] } });
    const atTop = await bothWays(PROBE_CALL, 'dontAsk', atHome(), () =>
      fs.existsSync(path.join(folder, PROBE))
    );
    expect({ alone: atTop.alone, hooked: atTop.hooked }).toEqual({ alone: false, hooked: false });
    fs.rmSync(path.join(root, '.claude', 'settings.local.json'));
    settingsAt(folder, { permissions: { allow: ['Bash'] } });
    const atCwd = await bothWays(PROBE_CALL, 'dontAsk', atHome(), () =>
      fs.existsSync(path.join(folder, PROBE))
    );
    expect({ alone: atCwd.alone, hooked: atCwd.hooked }).toEqual({ alone: true, hooked: false });
  }, 120_000);

  it('case 2.8: runs a workspace’s settings as launched, and asks under a rule added after', async () => {
    const configDir = path.join(root, 'claude-config');
    fs.mkdirSync(configDir, { recursive: true });
    const projects = { [folder]: { hasTrustDialogAccepted: true, allowedTools: [] } };
    for (const file of [path.join(configDir, '.claude.json'), path.join(root, '.claude.json')]) {
      fs.writeFileSync(file, JSON.stringify({ projects, hasCompletedOnboarding: true }));
    }
    const workspace = { cwd: folder, home: path.join(root, 'some-agent') };
    settingsAt(folder, { permissions: { allow: [`Bash(${COMMAND})`] } }, 'settings.json');
    const launched = await bothWays(PROBE_CALL, 'dontAsk', workspace, () =>
      fs.existsSync(path.join(folder, PROBE))
    );
    expect({ alone: launched.alone, hooked: launched.hooked }).toEqual({
      alone: true,
      hooked: true,
    });
    // Written after the launch read the folder: the hook's check is built first, then the file.
    // The launched rule still covers its own command; only the new one is refused.
    const asked: string[] = [];
    const options = turnOptions('dontAsk', workspace, asked, false);
    settingsAt(folder, { permissions: { allow: [`Bash(${COMMAND})`, 'Bash'] } }, 'settings.json');
    await model.close();
    model = await fakeModel({ name: 'Bash', input: { command: 'touch another-probe' } });
    const refused = await runTurn(undefined, configDir, options);
    expect(refused?.permission_denials).toEqual([
      expect.objectContaining({ tool_input: { command: 'touch another-probe' } }),
    ]);
    expect(fs.existsSync(path.join(folder, 'another-probe'))).toBe(false);
    // The control, without the hooks.
    await model.close();
    model = await fakeModel({ name: 'Bash', input: { command: 'touch another-probe' } });
    await runTurn(undefined, configDir, turnOptions('dontAsk', workspace, asked, true));
    expect(fs.existsSync(path.join(folder, 'another-probe'))).toBe(true);
  }, 120_000);

  /** A repo with one commit and a linked worktree `wt` of it, made with real git. */
  function repoWithWorktree(): { repo: string; wt: string } {
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(repo, 'init', '-q');
    git(
      repo,
      '-c',
      'user.email=ana@example.com',
      '-c',
      'user.name=Ana',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'start'
    );
    git(repo, 'worktree', 'add', '-q', wt);
    fs.mkdirSync(path.join(wt, 'sub'));
    return { repo, wt };
  }

  /** Where Claude Code writes a person's Always allow, from `cwd`. */
  async function alwaysAllowLandsIn(cwd: string): Promise<string[]> {
    await model.close();
    model = await fakeModel();
    await runTurn(undefined, undefined, {
      cwd,
      permissionMode: 'default',
      canUseTool: async (_tool, input, context) => ({
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: context.suggestions,
      }),
    });
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'claude-config' && entry.name !== '.git')
          walk(full);
        else if (entry.name === 'settings.local.json') found.push(path.dirname(path.dirname(full)));
      }
    };
    walk(root);
    return found;
  }

  it.each(['wt', 'wt/sub'])(
    'case 2.9: asks from a worktree at %s',
    async (at) => {
      const { repo } = repoWithWorktree();
      settingsAt(repo, { permissions: { allow: ['Bash'] } });
      const cwd = path.join(root, at);
      const run = await bothWays(PROBE_CALL, 'dontAsk', { cwd, home: folder }, () =>
        fs.existsSync(path.join(cwd, PROBE))
      );
      expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: true, hooked: false });
    },
    120_000
  );

  it('case 2.10: pins a worktree’s own folder', async () => {
    const { wt } = repoWithWorktree();
    settingsAt(wt, { permissions: { allow: ['Bash'] } });
    const cwd = path.join(wt, 'sub');
    const run = await bothWays(PROBE_CALL, 'dontAsk', { cwd, home: folder }, () =>
      fs.existsSync(path.join(cwd, PROBE))
    );
    expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: false, hooked: false });
  }, 120_000);

  it.each(['wt', 'wt/sub'])(
    'case 2.11: records an answer from a worktree at %s where it is kept',
    async (at) => {
      const { repo } = repoWithWorktree();
      const cwd = path.join(root, at);
      expect(await alwaysAllowLandsIn(cwd)).toEqual([repo]);
      expect(settingsFolders(cwd, root).alwaysAllowFolder).toBe(repo);
    },
    120_000
  );

  it('case 2.12: records an answer from a bare repo’s worktree where it is kept', async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed);
    git(seed, 'init', '-q');
    git(
      seed,
      '-c',
      'user.email=ana@example.com',
      '-c',
      'user.name=Ana',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'start'
    );
    git(root, 'clone', '-q', '--bare', seed, 'bare.git');
    git(path.join(root, 'bare.git'), 'worktree', 'add', '-q', path.join(root, 'wt'));
    const cwd = path.join(root, 'wt', 'sub');
    fs.mkdirSync(cwd);
    expect(await alwaysAllowLandsIn(cwd)).toEqual([cwd]);
    expect(settingsFolders(cwd, root).alwaysAllowFolder).toBe(cwd);
  }, 120_000);

  it('case 2.13: asks from a linked folder, and records where the answer is kept', async () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    settingsAt(repo, { permissions: { allow: ['Bash'] } });
    fs.mkdirSync(path.join(root, 'links'));
    const cwd = path.join(root, 'links', 'l');
    fs.symlinkSync(path.join(repo, 'sub'), cwd);
    const run = await bothWays(PROBE_CALL, 'dontAsk', { cwd, home: folder }, () =>
      fs.existsSync(path.join(cwd, PROBE))
    );
    expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: true, hooked: false });
    fs.rmSync(path.join(repo, '.claude'), { recursive: true });
    expect(await alwaysAllowLandsIn(cwd)).toEqual([repo]);
    expect(settingsFolders(cwd, root).alwaysAllowFolder).toBe(repo);
  }, 120_000);

  /** Mark `folders` trusted in the throwaway account, as a person who accepted them would. */
  function trusted(folders: string[]): string {
    const configDir = path.join(root, 'claude-config');
    fs.mkdirSync(configDir, { recursive: true });
    const projects = Object.fromEntries(
      folders.map((dir) => [dir, { hasTrustDialogAccepted: true, allowedTools: [] }])
    );
    for (const file of [path.join(configDir, '.claude.json'), path.join(root, '.claude.json')]) {
      fs.writeFileSync(file, JSON.stringify({ projects, hasCompletedOnboarding: true }));
    }
    return configDir;
  }

  it('case 2.14: a worktree, committed settings elsewhere', async () => {
    const { repo, wt } = repoWithWorktree();
    const configDir = trusted([repo, wt, root]);
    settingsAt(repo, { permissions: { allow: ['Bash'] } }, 'settings.json');
    const run = await bothWays(
      PROBE_CALL,
      'dontAsk',
      { cwd: wt, home: folder },
      () => fs.existsSync(path.join(wt, PROBE)),
      configDir
    );
    // This build does not load it; the check would ask either way (unit tests).
    expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: false, hooked: false });
  }, 120_000);

  it('case 2.15: a subfolder, committed settings above it', async () => {
    const repo = path.join(root, 'repo');
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const configDir = trusted([repo, sub, root]);
    settingsAt(repo, { permissions: { allow: ['Bash'] } }, 'settings.json');
    const run = await bothWays(
      PROBE_CALL,
      'dontAsk',
      { cwd: sub, home: folder },
      () => fs.existsSync(path.join(sub, PROBE)),
      configDir
    );
    // This build does not load it; the check would ask either way (unit tests).
    expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: false, hooked: false });
  }, 120_000);

  it('case 2.16: pins the monitor tool', async () => {
    settingsAt(folder, { permissions: { allow: ['Bash'] } });
    const call = {
      name: 'Monitor',
      input: { description: 'probe', timeout_ms: 5000, command: COMMAND },
    };
    const run = await bothWays(call, 'dontAsk', atHome(), () =>
      fs.existsSync(path.join(folder, PROBE))
    );
    expect({ alone: run.alone, hooked: run.hooked }).toEqual({ alone: false, hooked: false });
    // When a build offers the tool, this fails: replace it with a case that it asks.
    expect(MODEL_BODIES.some((body) => body.includes('No such tool available: Monitor'))).toBe(
      true
    );
  }, 120_000);

  it('case 2.17: asks for a helper agent’s call', async () => {
    settingsAt(folder, { permissions: { allow: ['Bash'] } });
    const calls: ToolCall[] = [
      {
        name: 'Agent',
        input: { description: 'probe', prompt: 'run it', subagent_type: 'general-purpose' },
      },
      PROBE_CALL,
    ];
    const results: boolean[] = [];
    const asked: string[] = [];
    for (const alone of [true, false]) {
      await model.close();
      model = await fakeModel(calls);
      await runTurn(undefined, undefined, turnOptions('default', atHome(), asked, alone));
      results.push(fs.existsSync(path.join(folder, PROBE)));
      fs.rmSync(path.join(folder, PROBE), { force: true });
    }
    expect(results).toEqual([true, false]);
    expect(asked.filter((tool) => tool === 'Bash').length).toBeGreaterThan(0);
  }, 180_000);

  it('case 2.18: runs an edit Accept edits runs anyway', async () => {
    settingsAt(folder, { permissions: { allow: ['Edit(//**)'] } });
    const target = path.join(folder, 'notes.md');
    const call = { name: 'Write', input: { file_path: target, content: 'x' } };
    const run = await bothWays(call, 'acceptEdits', atHome(), () => {
      const wrote = fs.existsSync(target);
      fs.rmSync(target, { force: true });
      return wrote;
    });
    expect(run).toEqual({ alone: true, hooked: true, asked: [] });
  }, 120_000);
});
