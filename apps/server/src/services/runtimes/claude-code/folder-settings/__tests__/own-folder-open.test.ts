/**
 * An agent's own folder setup opens only for the level a PERSON set, on an
 * unmarked turn that runs at Full (DOR-3483).
 *
 * @vitest-environment node
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const level = vi.hoisted(() => ({ own: 'autonomy' as string | undefined, fail: false }));
vi.mock('../../../../session/resolution/resolve-session-defaults.js', () => ({
  readAgentExecutionDefaults: async () => {
    if (level.fail) throw new Error('unreadable');
    return level.own ? { filesAndCommands: level.own } : {};
  },
  resolveUnattendedPermissionMode: (opts: { agent?: { filesAndCommands?: string } }) =>
    opts.agent?.filesAndCommands === 'autonomy' ? 'bypassPermissions' : 'default',
}));
const dork = vi.hoisted(() => ({ home: '' }));
vi.mock('../../../../../lib/dork-home.js', () => ({ resolveDorkHome: () => dork.home }));
const marks = vi.hoisted(() => ({ marked: false }));
vi.mock('../agent-extensions-deny.js', () => ({
  ownExtensionsWritable: (_session: unknown, _id: string, home: string) =>
    marks.marked ? undefined : home,
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendOwnFolderBlock,
  OWN_FOLDER_BLOCK,
  prepareOwnFolder,
  resolveOwnFolderOpen,
  type OwnFolderTurn,
} from '../own-folder-open.js';

const turn = (over: Partial<OwnFolderTurn> = {}): OwnFolderTurn => ({
  home: '/agents/media',
  teammate: false,
  turnMode: 'bypassPermissions',
  session: {},
  sessionId: 'chat-1',
  capabilities: undefined,
  ...over,
});

beforeEach(() => {
  level.own = 'autonomy';
  level.fail = false;
  marks.marked = false;
});

describe('resolveOwnFolderOpen', () => {
  it('opens for an agent a person set to Full, on an unmarked Full turn', async () => {
    expect(await resolveOwnFolderOpen(turn())).toBe(true);
  });

  it('stays closed when the person set the agent below Full, whatever the session mode', async () => {
    level.own = 'act';
    expect(await resolveOwnFolderOpen(turn())).toBe(false);
  });

  it('stays closed for Full the agent only inherits from a preset or the default (PM, #3319)', async () => {
    level.own = undefined;
    expect(await resolveOwnFolderOpen(turn())).toBe(false);
  });

  it('stays closed when the turn runs below Full', async () => {
    expect(await resolveOwnFolderOpen(turn({ turnMode: 'acceptEdits' }))).toBe(false);
  });

  it('stays closed on a turn that read outside words', async () => {
    marks.marked = true;
    expect(await resolveOwnFolderOpen(turn())).toBe(false);
  });

  it("stays closed on a teammate's turn and with no agent home", async () => {
    expect(await resolveOwnFolderOpen(turn({ teammate: true }))).toBe(false);
    expect(await resolveOwnFolderOpen(turn({ home: undefined }))).toBe(false);
  });

  it('stays closed when the level cannot be read', async () => {
    level.fail = true;
    expect(await resolveOwnFolderOpen(turn())).toBe(false);
  });
});

describe('appendOwnFolderBlock', () => {
  it('tells the agent what it may edit and that the rest is guarded against file tools only', () => {
    const options: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'base' },
    };
    appendOwnFolderBlock(options);
    appendOwnFolderBlock(options);
    const append = (options.systemPrompt as { append: string }).append;
    expect(append).toBe(`base\n\n${OWN_FOLDER_BLOCK}`);
    expect(OWN_FOLDER_BLOCK).toContain('.claude/');
    expect(OWN_FOLDER_BLOCK).toContain('.mcp.json');
    expect(OWN_FOLDER_BLOCK).toContain('.dork/agent.json');
    expect(OWN_FOLDER_BLOCK).toContain('guarded against file tools only');
  });
});

describe('prepareOwnFolder (Security M1 and M2 on #3319)', () => {
  let root: string;
  let home: string;
  let account: string;
  let shared: string;
  const denyOf = (options: Options) =>
    (options.settings as { permissions?: { deny?: string[] } } | undefined)?.permissions?.deny ??
    [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-folder-launch-')));
    dork.home = path.join(root, 'dork');
    home = path.join(dork.home, 'agents', 'mailroom');
    account = path.join(root, 'claude-account');
    shared = path.join(root, 'vault', 'rules');
    fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', 'skills', 'x'), { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'quickbooks-safety.md'), 'never pay without a person');
    // A person's shared safety rule linked in, as mailroom has on this Mac.
    fs.symlinkSync(
      path.join(shared, 'quickbooks-safety.md'),
      path.join(home, '.claude', 'rules', 'quickbooks-safety.md')
    );
    // A link that stays inside the home, as Harness Sync makes.
    fs.mkdirSync(path.join(home, '.claude', 'skills'));
    fs.symlinkSync('../../.agents/skills/x', path.join(home, '.claude', 'skills', 'x'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const launch = async () => {
    const options: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'base' },
    };
    const result = await prepareOwnFolder(options, {
      ...turn({ home }),
      accountRoot: account,
      agentName: 'Mailroom',
    });
    return { options, result, deny: denyOf(options) };
  };

  it('keeps a linked-in file outside the home denied, by its link and by the file behind it', async () => {
    const { result, deny } = await launch();
    expect(result.open).toBe(true);
    const link = path.join(home, '.claude', 'rules', 'quickbooks-safety.md');
    expect(deny).toContain(`Edit(/${link})`);
    expect(deny).toContain(`Write(/${path.join(shared, 'quickbooks-safety.md')})`);
    expect(deny.some((rule) => rule.includes('/.claude/skills/x'))).toBe(false);
  });

  it('carries the account folder, its home spellings and host.key on an open launch', async () => {
    const { deny } = await launch();
    expect(deny).toContain(`Edit(/${account}/**)`);
    expect(deny).toContain('Edit(~/.claude/**)');
    expect(deny).toContain('Write(~/.claude.json)');
    expect(deny).toContain(`Edit(/${dork.home}/host.key)`);
    expect(deny).toContain(`Write(/${home}/.dork/agent.json)`);
    expect(deny).not.toContain(`Write(/${home}/.claude/**)`);
  });

  it('stays closed, adding nothing, when a link it must keep cannot be named in a rule', async () => {
    const odd = path.join(root, 'odd?dir');
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, 'r.md'), 'x');
    fs.symlinkSync(path.join(odd, 'r.md'), path.join(home, '.claude', 'rules', 'odd.md'));
    const { options, result } = await launch();
    expect(result.open).toBe(false);
    expect(result.chat.ownFolderOpen).toBe(false);
    expect(denyOf(options)).toEqual([]);
    expect((options.systemPrompt as { append: string }).append).toBe('base');
  });

  it('stays closed and adds nothing for an agent below Full', async () => {
    level.own = 'act';
    const { options, result } = await launch();
    expect(result.open).toBe(false);
    expect(denyOf(options)).toEqual([]);
  });
});
