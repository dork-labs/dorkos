/**
 * An agent's own hooks, MCP servers file and agent-file servers/account run
 * only as a person last allowed them: pinned once on first use, held back on a
 * change, asked about once, and moved only by a person (DOR-3068).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** A config store holding just the `harness` section. */
const store = vi.hoisted(() => ({ harness: {} as Record<string, unknown>, failWrites: false }));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'harness' ? store.harness : undefined),
    set: (key: string, value: Record<string, unknown>) => {
      if (store.failWrites) throw new Error('disk full');
      if (key === 'harness') store.harness = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));

import { logger } from '../../../../../lib/logger.js';
import {
  applyFolderConfigToLaunch,
  homeWriteDenyRules,
  resolveFolderConfigForLaunch,
} from '../launch-folder-config.js';
import {
  isFolderConfigRefused,
  lastApprovedParts,
  runtimeUnlessHeld,
  withPersonRepin,
  withPersonRepinAtHome,
} from '../folder-config-consent.js';
import { _internal, askForFolderConfig, summariseFolderConfig } from '../folder-config-approval.js';
import {
  setFolderAllowApprovalGateway,
  type FolderAllowApprovalGateway,
} from '../folder-allow-approval.js';
import { readFolderConfigParts } from '../folder-config-pin.js';
import { pinRegisteredFolderConfigsOnce } from '../pin-folder-configs.js';

const AGENT = { id: '01AGENT', name: 'Marketing' };
const HOOK = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] };
let root: string;
let home: string;
let requests: { summary: string; capabilityId: string }[];
/** This test's answer to its cards. Per test, so a card still waiting from an earlier test never writes into this one. */
let answer: { outcome: 'pending' | 'granted' | 'denied' };

function write(rel: string, body: unknown): void {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

const ownTurn = (cwd = home) => resolveFolderConfigForLaunch({ agent: AGENT, home, cwd });

/** Let a fire-and-forget card settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-config-launch-')));
  home = path.join(root, 'agent');
  write('.claude/settings.json', { hooks: {} });
  write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'work' });
  store.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
  store.failWrites = false;
  vi.mocked(logger.warn).mockClear();
  requests = [];
  const current: typeof answer = { outcome: 'pending' };
  answer = current;
  _internal.forgetOpenCards();
  _internal.sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
  const gateway: FolderAllowApprovalGateway = {
    request: (input) => {
      requests.push(input);
      // Short-lived, so a card nobody answers stops waiting soon after its test.
      return {
        approvalId: `a${requests.length}`,
        token: 't',
        expiresAt: new Date(Date.now() + 50).toISOString(),
      };
    },
    consume: () => ({ outcome: current.outcome }) as never,
  };
  setFolderAllowApprovalGateway(gateway);
  // Most cases are about an agent DorkOS already had: the upgrade pinned it.
  await pinnedAtUpgrade();
  store.harness = { ...store.harness, folderConfigPinned: false };
});

/** The agent existed at the upgrade, so the one-time step pinned it as it stood. */
function pinnedAtUpgrade(): Promise<number> {
  return pinRegisteredFolderConfigsOnce(async () => [{ id: AGENT.id, projectPath: home }]);
}

afterEach(() => {
  setFolderAllowApprovalGateway(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pinned once: at the upgrade, or on first use when nothing runs (M4)', () => {
  it('keeps an agent the upgrade pinned as it stood, and holds nothing back', async () => {
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
    expect(await pinnedAtUpgrade()).toBe(1);
    expect(await ownTurn()).toEqual({ held: [], inHome: false });
    expect(lastApprovedParts(AGENT.id, home)).toEqual(readFolderConfigParts(home).digests);
    expect(requests).toEqual([]);
  });

  it('pins a new agent on first use only when nothing in its home runs', async () => {
    await pinnedAtUpgrade();
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [] });
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
    expect(await ownTurn()).toEqual({ held: [], inHome: false });
    expect(requests).toEqual([]);
  });

  it('holds a new agent whose home runs anything, and asks a person', async () => {
    await pinnedAtUpgrade();
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
    write('.claude/settings.json', { hooks: HOOK });
    expect((await ownTurn()).held).toEqual(['hooks', 'mcpJson', 'manifest']);
    await settle();
    expect(requests).toHaveLength(1);
    expect(lastApprovedParts(AGENT.id, home)).toBeUndefined();
  });

  it('pins at the upgrade once ever, never an agent registered after', async () => {
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
    expect(await pinnedAtUpgrade()).toBe(1);
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
    expect(await pinnedAtUpgrade()).toBe(0);
    expect(lastApprovedParts(AGENT.id, home)).toBeUndefined();
  });

  it('never pins on first use again once a record exists', async () => {
    await pinnedAtUpgrade();
    write('.claude/settings.json', { hooks: HOOK });
    expect((await ownTurn()).held).toEqual(['hooks']);
    // Still held on the next launch: a change never approves itself.
    expect((await ownTurn()).held).toEqual(['hooks']);
  });
});

describe('a change since the yes', () => {
  beforeEach(async () => {
    await ownTurn();
  });

  it('holds hooks back and turns them off when the turn stands in the home', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    const decision = await ownTurn();
    expect(decision).toEqual({ held: ['hooks'], inHome: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Holding back'),
      expect.objectContaining({ agentId: AGENT.id, changed: ['hooks'] })
    );
  });

  it('holds a changed .mcp.json back the same way', async () => {
    write('.mcp.json', { mcpServers: { x: { command: 'evil' } } });
    expect(await ownTurn()).toEqual({ held: ['mcpJson'], inHome: true });
  });

  it('turns them off in a folder inside the home too, where Claude Code still reads them', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    fs.mkdirSync(path.join(home, 'sub', 'deeper'), { recursive: true });
    expect(await ownTurn(path.join(home, 'sub', 'deeper'))).toEqual({
      held: ['hooks'],
      inHome: true,
    });
  });

  it('needs no switches outside the home, where the folder files do not load', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    fs.mkdirSync(path.join(root, 'agent-sibling'));
    expect(await ownTurn(path.join(root, 'agent-sibling'))).toEqual({
      held: ['hooks'],
      inHome: false,
    });
  });

  it('holds and asks when the agent switches its own runtime', async () => {
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'work', runtime: 'codex' });
    expect((await ownTurn()).held).toEqual(['manifest']);
    expect(requests).toHaveLength(1);
  });

  it('holds the agent file back without the switches', async () => {
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'personal' });
    expect(await ownTurn()).toEqual({ held: ['manifest'], inHome: false });
  });

  it('asks once per changed state, naming the parts and never their contents', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'personal' });
    await ownTurn();
    await ownTurn();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ capabilityId: 'runtime.apply_folder_config' });
    expect(requests[0]!.summary).toBe(
      '"Marketing" changed its hooks and its agent file\'s MCP servers or account. ' +
        'Its turns run without the change until you allow it.'
    );
    expect(requests[0]!.summary).not.toContain('personal');
    // A further change is a new state, and a new card.
    write('.mcp.json', {});
    await ownTurn();
    expect(requests).toHaveLength(2);
  });

  it('runs the change once a person allows it', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    answer.outcome = 'granted';
    await ownTurn();
    await settle();
    expect((await ownTurn()).held).toEqual([]);
  });

  it('records a no, keeps the old yes, and does not ask again until it changes', async () => {
    const before = lastApprovedParts(AGENT.id, home);
    write('.claude/settings.json', { hooks: HOOK });
    answer.outcome = 'denied';
    await ownTurn();
    await settle();
    const state = { agentId: AGENT.id, home, digests: readFolderConfigParts(home).digests };
    expect(isFolderConfigRefused(state)).toBe(true);
    expect(lastApprovedParts(AGENT.id, home)).toEqual(before);
    expect((await ownTurn()).held).toEqual(['hooks']);
    expect(requests).toHaveLength(1);
    write('.claude/settings.json', { hooks: { Stop: [] } });
    await ownTurn();
    expect(requests).toHaveLength(2);
  });

  it('records nothing for a card that expired, so a later turn asks again', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    const request = {
      agentId: AGENT.id,
      agentName: AGENT.name,
      home,
      digests: readFolderConfigParts(home).digests,
      changed: ['hooks' as const],
    };
    const gateway: FolderAllowApprovalGateway = {
      request: () => ({ approvalId: 'x', token: 't', expiresAt: new Date(0).toISOString() }),
      consume: () => ({ outcome: 'expired' }) as never,
    };
    expect(await askForFolderConfig(gateway, request)).toBe(false);
    expect(isFolderConfigRefused(request)).toBe(false);
  });

  it('never asks about a part it cannot read, and holds it back', async () => {
    fs.rmSync(path.join(home, '.claude', 'settings.json'));
    fs.mkdirSync(path.join(home, '.claude', 'settings.json'));
    expect((await ownTurn()).held).toEqual(['hooks']);
    expect(requests).toEqual([]);
  });
});

describe('summariseFolderConfig', () => {
  it('names all three parts in plain words', () => {
    expect(
      summariseFolderConfig({
        agentId: AGENT.id,
        agentName: 'Ops',
        home: '/h',
        digests: { hooks: 'a', mcpJson: 'b', manifest: 'c' },
        changed: ['hooks', 'mcpJson', 'manifest'],
      })
    ).toBe(
      '"Ops" changed its hooks, its MCP servers file and its agent file\'s MCP servers or account. ' +
        'Its turns run without the change until you allow it.'
    );
  });
});

describe('a person moves the pin', () => {
  beforeEach(async () => {
    await ownTurn();
  });

  it('moves the part a person changed through DorkOS', async () => {
    await withPersonRepin({ agentId: AGENT.id, home }, 'manifest', 'test', async () => {
      write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'personal' });
    });
    expect((await ownTurn()).held).toEqual([]);
  });

  it('never approves a change the agent made first, nor its other parts', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'agent-picked' });
    await withPersonRepin({ agentId: AGENT.id, home }, 'manifest', 'test', async () => {
      write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'personal' });
    });
    expect((await ownTurn()).held).toEqual(['hooks', 'manifest']);
  });

  it('moves the hooks of every agent pinned at a folder a projection wrote', async () => {
    withPersonRepinAtHome(home, 'hooks', 'test', () =>
      write('.claude/settings.local.json', { hooks: HOOK })
    );
    expect((await ownTurn()).held).toEqual([]);
  });
});

describe('applyFolderConfigToLaunch', () => {
  const settingsOf = (options: Options) =>
    options.settings as { disableAllHooks?: boolean; permissions: { deny: string[] } };

  it('denies the file tools the home self-grant files on every launch', () => {
    const options: Options = { settings: { fastMode: true, permissions: { deny: ['Edit(x)'] } } };
    applyFolderConfigToLaunch(options, home, { held: [], inHome: false });
    const deny = settingsOf(options).permissions.deny;
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(deny).toContain(`${tool}(/${home}/.claude/**)`);
      expect(deny).toContain(`${tool}(/${home}/.mcp.json)`);
      expect(deny).toContain(`${tool}(/${home}/.dork/agent.json)`);
    }
    expect(deny[0]).toBe('Edit(x)');
    expect((options.settings as { fastMode?: boolean }).fastMode).toBe(true);
    expect(settingsOf(options).disableAllHooks).toBeUndefined();
    expect(options.strictMcpConfig).toBeUndefined();
  });

  it('turns folder hooks off and keeps to DorkOS’s own MCP servers when held in the home', () => {
    const options: Options = {};
    applyFolderConfigToLaunch(options, home, { held: ['hooks'], inHome: true });
    expect(settingsOf(options).disableAllHooks).toBe(true);
    expect(options.strictMcpConfig).toBe(true);
  });

  it('names a symlinked home under both spellings', () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(home, link);
    expect(homeWriteDenyRules(link)).toEqual(
      expect.arrayContaining([`Edit(/${link}/.claude/**)`, `Edit(/${home}/.claude/**)`])
    );
  });

  it('launches without home deny rules, and still applies the switches, for a home no rule can name', () => {
    const options: Options = {};
    expect(() =>
      applyFolderConfigToLaunch(options, '/tmp/what?', { held: ['hooks'], inHome: true })
    ).not.toThrow();
    expect(settingsOf(options).permissions.deny).toEqual([]);
    expect(settingsOf(options).disableAllHooks).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Can't name the agent home"),
      expect.anything()
    );
  });

  it('does nothing without a home', () => {
    const options: Options = {};
    applyFolderConfigToLaunch(options, undefined, { held: [], inHome: false });
    expect(options.settings).toBeUndefined();
  });
  it('denies only agent.json when the agent’s own folder is open (DOR-3483)', () => {
    const options: Options = {};
    applyFolderConfigToLaunch(options, home, { held: [], inHome: false }, true);
    const deny = settingsOf(options).permissions.deny;
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(deny).toContain(`${tool}(/${home}/.dork/agent.json)`);
      expect(deny).not.toContain(`${tool}(/${home}/.claude/**)`);
      expect(deny).not.toContain(`${tool}(/${home}/.agents/**)`);
      expect(deny).not.toContain(`${tool}(/${home}/.mcp.json)`);
    }
  });
});

describe('a drop below Full after the agent wrote its own setup (DOR-3483)', () => {
  it('holds the hooks when only the script they run changed at Full', async () => {
    const guard = {
      PreToolUse: [{ hooks: [{ type: 'command', command: '.claude/hooks/guard.py' }] }],
    };
    write('.claude/settings.json', { hooks: guard });
    write('.claude/hooks/guard.py', 'print(1)');
    answer.outcome = 'granted';
    await ownTurn();
    await settle();
    expect((await ownTurn()).held).toEqual([]);
    answer.outcome = 'pending';
    write('.claude/hooks/guard.py', 'print(2)');
    expect(
      (await resolveFolderConfigForLaunch({ agent: AGENT, home, cwd: home, full: true })).held
    ).toEqual([]);
    expect((await ownTurn()).held).toEqual(['hooks']);
  });

  it('loads at Full without a card, then holds and asks once, for the content at the drop', async () => {
    await ownTurn();
    write('.claude/settings.json', { hooks: HOOK });
    const atDrop = readFolderConfigParts(home).digests;
    expect(
      await resolveFolderConfigForLaunch({ agent: AGENT, home, cwd: home, full: true })
    ).toEqual({ held: [], inHome: false });
    await settle();
    expect(requests).toEqual([]);
    expect(lastApprovedParts(AGENT.id, home)).not.toEqual(atDrop);
    expect((await ownTurn()).held).toEqual(['hooks']);
    expect((await ownTurn()).held).toEqual(['hooks']);
    await settle();
    expect(requests).toHaveLength(1);
    answer.outcome = 'granted';
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lastApprovedParts(AGENT.id, home)).toEqual(atDrop);
    expect(await ownTurn()).toEqual({ held: [], inHome: false });
  });
});

describe('an agent that renames itself', () => {
  it('is not new: its home already holds a yes, so the change asks', async () => {
    await ownTurn();
    write('.dork/agent.json', { id: '01RENAMED', mcpServers: [], account: 'personal' });
    const renamed = await resolveFolderConfigForLaunch({
      agent: { id: '01RENAMED', name: AGENT.name },
      home,
      cwd: home,
    });
    expect(renamed.held).toEqual(['manifest']);
    expect(lastApprovedParts('01RENAMED', home)).toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});

describe('a first-use pin that cannot be written', () => {
  it('holds everything back and asks nobody', async () => {
    // A new agent whose home runs nothing, so its first launch tries to pin it.
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [] });
    store.failWrites = true;
    expect(await ownTurn()).toEqual({ held: ['hooks', 'mcpJson', 'manifest'], inHome: true });
    expect(requests).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not pin'),
      expect.objectContaining({ agentId: AGENT.id })
    );
  });
});

describe('the runtime an agent file names (M3)', () => {
  const manifest = () =>
    JSON.parse(fs.readFileSync(path.join(home, '.dork/agent.json'), 'utf8')) as {
      id: string;
      runtime?: string;
    };

  it('is honoured as a person last approved it, and held once the agent changes it', async () => {
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [], runtime: 'claude-code' });
    await ownTurn(); // a new agent whose home runs nothing: pinned on first use
    expect(runtimeUnlessHeld(manifest(), home)).toBe('claude-code');
    write('.dork/agent.json', {
      id: AGENT.id,
      runtime: 'codex',
      mcpServers: [{ name: 'evil', command: 'sh' }],
    });
    expect(runtimeUnlessHeld(manifest(), home)).toBeUndefined();
  });
});

describe('held hooks leave out the folder settings sources (M1)', () => {
  it('drops project and local, keeps user, and passes CLAUDE.md in the system prompt', () => {
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'Remember the folder rule.');
    const options: Options = {
      cwd: home,
      settingSources: ['local', 'project', 'user'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'base' },
    };
    applyFolderConfigToLaunch(options, home, { held: ['hooks'], inHome: true });
    expect(options.settingSources).toEqual(['user']);
    const prompt = options.systemPrompt as { append?: string };
    expect(prompt.append).toContain('base');
    expect(prompt.append).toContain('Remember the folder rule.');
  });

  it('leaves the sources alone when only the MCP file is held', () => {
    const options: Options = { cwd: home, settingSources: ['local', 'project', 'user'] };
    applyFolderConfigToLaunch(options, home, { held: ['mcpJson'], inHome: true });
    expect(options.settingSources).toEqual(['local', 'project', 'user']);
  });
});

describe("Security's conditions on the first-use pin (M4)", () => {
  const unpin = () => {
    store.harness = { ...store.harness, approvedFolderConfig: [], approvedFolderConfigParts: {} };
  };

  it('never treats a hooks-only agent as empty', async () => {
    unpin();
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [] });
    write('.claude/settings.json', { hooks: HOOK });
    expect(readFolderConfigParts(home).inert).toBe(false);
    expect((await ownTurn()).held).toEqual(['hooks', 'mcpJson', 'manifest']);
  });

  it('pins nothing when pins exist but the upgrade marker is gone', async () => {
    // beforeEach pinned this agent and cleared the marker: a lost marker, not a first start.
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    expect(
      await pinRegisteredFolderConfigsOnce(async () => [{ id: '01OTHER', projectPath: other }])
    ).toBe(0);
    expect(lastApprovedParts('01OTHER', other)).toBeUndefined();
    expect(store.harness.folderConfigPinned).toBe(true);
  });

  it('shows the card what would run, and withdraws it when the folder changes again', async () => {
    const denied: string[] = [];
    setFolderAllowApprovalGateway({
      request: (input: unknown) => {
        requests.push(input as never);
        return {
          approvalId: 'a1',
          token: 't',
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        };
      },
      consume: () => ({ outcome: 'pending' }) as never,
      deny: (approvalId: string) => {
        denied.push(approvalId);
      },
    } as never);
    write('.claude/settings.json', { hooks: HOOK });
    await ownTurn();
    await settle();
    expect((requests[0] as unknown as { detail?: string }).detail).toContain('"command": "x"');
    write('.claude/settings.json', { hooks: HOOK, statusLine: { type: 'command', command: 'y' } });
    await vi.waitFor(() => expect(denied).toEqual(['a1']));
  });
});
