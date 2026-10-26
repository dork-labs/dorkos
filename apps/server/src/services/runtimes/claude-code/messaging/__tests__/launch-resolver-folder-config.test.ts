/**
 * Every launch for an agent home denies the file tools its self-grant files,
 * a teammate's turn too, and a launch after the agent changed its own hooks,
 * MCP servers file or agent file runs without the change (DOR-3068).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAgentHomeRegistry } from '../../../../core/agent-identity/index.js';
import type { MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { resolveLaunch } from '../launch-resolver.js';
import { resolveLaunchAccountRoot } from '../../claude-config-dir.js';
import {
  _internal,
  setFolderAllowApprovalGateway,
  type FolderAllowApprovalGateway,
} from '../../folder-settings/folder-allow-approval.js';
import { _internal as configCards } from '../../folder-settings/folder-config-approval.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue({ id: '01AGENT', account: 'work' }),
}));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
const store = vi.hoisted(() => ({
  sections: {} as Record<string, unknown>,
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => store.sections[key],
    set: (key: string, value: unknown) => {
      store.sections[key] = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../../core/agent-identity/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/agent-identity/index.js')>()),
  resolveAgentTokenEnv: vi.fn().mockResolvedValue({}),
}));
const accountRoot = vi.hoisted(() => `/tmp/folder-config-account-${process.pid}`);
vi.mock('../../claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../claude-config-dir.js')>()),
  resolveLaunchAccountRoot: vi.fn(() => ({ ok: true, root: accountRoot })),
}));

const AGENT = { id: '01AGENT', name: 'ops', displayName: 'Ops' };
const HOOK = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] };
let root: string;
let home: string;
let cards: { capabilityId: string }[];
let factory: ReturnType<typeof vi.fn>;

function write(rel: string, body: unknown): void {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}

function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'bypassPermissions',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

const launch = (extra: { teammate?: boolean } = {}) =>
  resolveLaunch({
    sessionId: 's1',
    content: 'hello',
    session: makeSession(),
    opts: {
      cwd: home,
      onSdkSessionRebind: async () => {},
      meshCore: {
        getByPath: (dir: string) => (dir === home ? AGENT : undefined),
        updateLastSeen: () => {},
      } as unknown as MessageSenderOpts['meshCore'],
      mcpServerFactory: factory as unknown as MessageSenderOpts['mcpServerFactory'],
    },
    ...(extra.teammate ? { messageOpts: { roomTurn: { teammate: true } } as never } : {}),
    effectiveCwd: home,
  });

type Settings = { disableAllHooks?: boolean; permissions?: { deny?: string[] } } | undefined;
const settingsOf = (resolved: Awaited<ReturnType<typeof launch>>) =>
  resolved.sdkOptions.settings as Settings;
const accountAsked = () =>
  vi.mocked(resolveLaunchAccountRoot).mock.calls.at(-1)?.[0].agentAccountId;
const factoryLaunch = () => factory.mock.calls.at(-1)?.[2] as { withholdAgentServers?: boolean };

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'launch-folder-config-')));
  home = path.join(root, 'agent');
  write('.claude/settings.json', { hooks: {} });
  write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'work' });
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === home,
    listRegisteredHomes: () => [home],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  store.sections = { harness: {}, permissions: {} };
  cards = [];
  factory = vi.fn(() => ({}));
  vi.mocked(resolveLaunchAccountRoot).mockClear();
  const gateway: FolderAllowApprovalGateway = {
    request: (input) => {
      cards.push(input);
      return { approvalId: 'a', token: 't', expiresAt: new Date(Date.now() + 20).toISOString() };
    },
    // Left open, so a second launch sees the card already on screen.
    consume: () => ({ outcome: 'pending' }) as never,
  };
  setFolderAllowApprovalGateway(gateway);
  _internal.forgetOpenCards();
  configCards.forgetOpenCards();
  configCards.sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
});

afterEach(() => {
  setFolderAllowApprovalGateway(null);
  setAgentHomeRegistry(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('an agent home at launch', () => {
  it.each([
    ['the agent’s own turn', {}],
    ['a teammate’s turn', { teammate: true }],
  ])('denies the file tools its self-grant files on %s', async (_label, extra) => {
    const deny = settingsOf(await launch(extra))?.permissions?.deny ?? [];
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(deny).toContain(`${tool}(/${home}/.claude/**)`);
      expect(deny).toContain(`${tool}(/${home}/.mcp.json)`);
      expect(deny).toContain(`${tool}(/${home}/.dork/agent.json)`);
    }
  });

  it('pins on first use and runs everything as it was', async () => {
    const resolved = await launch();
    expect(settingsOf(resolved)?.disableAllHooks).toBeUndefined();
    expect(resolved.sdkOptions.strictMcpConfig).toBeUndefined();
    expect(accountAsked()).toBe('work');
    expect(factoryLaunch().withholdAgentServers).toBeUndefined();
    expect(cards).toEqual([]);
  });

  it('turns the folder hooks off and keeps to DorkOS’s MCP servers after a hook appears', async () => {
    await launch();
    write('.claude/settings.json', { hooks: HOOK });
    const resolved = await launch();
    expect(settingsOf(resolved)?.disableAllHooks).toBe(true);
    expect(resolved.sdkOptions.strictMcpConfig).toBe(true);
    // DorkOS's own SDK hooks still ride the launch.
    expect(resolved.sdkOptions.hooks?.PreToolUse?.length).toBeGreaterThan(0);
    // The agent file did not change, so its account and servers still apply.
    expect(accountAsked()).toBe('work');
    expect(factoryLaunch().withholdAgentServers).toBeUndefined();
    expect(cards).toContainEqual(
      expect.objectContaining({ capabilityId: 'runtime.apply_folder_config' })
    );
  });

  it('ignores the account and the agent’s own MCP servers after its agent file changes', async () => {
    await launch();
    write('.dork/agent.json', { id: AGENT.id, mcpServers: [], account: 'someone-elses' });
    const resolved = await launch();
    expect(accountAsked()).toBeUndefined();
    expect(factoryLaunch().withholdAgentServers).toBe(true);
    expect(settingsOf(resolved)?.disableAllHooks).toBeUndefined();
  });

  it('asks once for one changed state', async () => {
    await launch();
    write('.mcp.json', { mcpServers: { x: { command: 'evil' } } });
    await launch();
    await launch();
    expect(
      cards.filter((card) => card.capabilityId === 'runtime.apply_folder_config')
    ).toHaveLength(1);
  });
});
