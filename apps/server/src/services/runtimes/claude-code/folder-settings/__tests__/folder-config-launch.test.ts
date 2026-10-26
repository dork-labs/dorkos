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

import { logger } from '../../../../../lib/logger.js';
import {
  applyFolderConfigToLaunch,
  homeWriteDenyRules,
  resolveFolderConfigForLaunch,
} from '../launch-folder-config.js';
import {
  isFolderConfigRefused,
  lastApprovedParts,
  withPersonRepin,
  withPersonRepinAtHome,
} from '../folder-config-consent.js';
import { _internal, askForFolderConfig, summariseFolderConfig } from '../folder-config-approval.js';
import {
  setFolderAllowApprovalGateway,
  type FolderAllowApprovalGateway,
} from '../folder-allow-approval.js';
import { readFolderConfigParts } from '../folder-config-pin.js';

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

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-config-launch-')));
  home = path.join(root, 'agent');
  write('.claude/settings.json', { hooks: {} });
  write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'work' });
  store.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
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
});

afterEach(() => {
  setFolderAllowApprovalGateway(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pinned on first use, once', () => {
  it('pins an agent with no record to what its folder holds, and holds nothing back', async () => {
    expect(await ownTurn()).toEqual({ held: [], inHome: false });
    expect(lastApprovedParts(AGENT.id, home)).toEqual(readFolderConfigParts(home).digests);
    expect(requests).toEqual([]);
  });

  it('never pins on first use again once a record exists', async () => {
    await ownTurn();
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

  it('needs no switches outside the home, where the folder files do not load', async () => {
    write('.claude/settings.json', { hooks: HOOK });
    fs.mkdirSync(path.join(home, 'sub'));
    expect(await ownTurn(path.join(home, 'sub'))).toEqual({ held: ['hooks'], inHome: false });
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

  it('refuses to launch for a home no rule can name', () => {
    expect(() => applyFolderConfigToLaunch({}, '/tmp/what?', { held: [], inHome: false })).toThrow(
      /can't keep this agent's own settings/
    );
  });

  it('does nothing without a home', () => {
    const options: Options = {};
    applyFolderConfigToLaunch(options, undefined, { held: [], inHome: false });
    expect(options.settings).toBeUndefined();
  });
});
