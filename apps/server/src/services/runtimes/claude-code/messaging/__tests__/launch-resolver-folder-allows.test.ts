/**
 * The launch hands an agent's own folder allow list to Claude Code only once a
 * person has approved it, and says why a Never ask chat refuses while it waits
 * (DOR-3039, DOR-3042).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAgentHomeRegistry } from '../../../../core/agent-identity/index.js';
import type { MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { resolveLaunch } from '../launch-resolver.js';
import { folderAllowsWaitingStatus } from '../../folder-settings/apply-folder-allows.js';
import { recordFolderAllowApproval } from '../../folder-settings/folder-allow-consent.js';
import {
  _internal,
  setFolderAllowApprovalGateway,
  type FolderAllowApprovalGateway,
} from '../../folder-settings/folder-allow-approval.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
// The sign-in check (DOR-3245) has its own tests; these are about folder allows.
vi.mock('../../accounts/account-login-metadata.js', () => ({
  requireConfirmedAccountLogin: () => undefined,
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
const store = vi.hoisted(() => ({
  permissions: { approvedFolderAllows: [] as string[], refusedFolderAllows: [] as string[] },
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? store.permissions : undefined),
    set: (key: string, value: typeof store.permissions) => {
      if (key === 'permissions') store.permissions = value;
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

const RULE = 'Bash(scripts/claim-check:*)';
const AGENT = { id: '01AGENT', name: 'dorkos-marketing', displayName: 'DorkOS Marketing' };
let root: string;
let home: string;
let asked: unknown[];

function makeSession(permissionMode: AgentSession['permissionMode'] = 'dontAsk'): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode,
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

function makeOpts(cwd: string): MessageSenderOpts {
  return {
    cwd,
    onSdkSessionRebind: async () => {},
    meshCore: {
      getByPath: (dir: string) => (dir === home ? AGENT : undefined),
      updateLastSeen: () => {},
    } as unknown as MessageSenderOpts['meshCore'],
  };
}

const launch = (
  cwd: string,
  extra: { teammate?: boolean; mode?: AgentSession['permissionMode'] } = {}
) =>
  resolveLaunch({
    sessionId: 's1',
    content: 'hello',
    session: makeSession(extra.mode),
    opts: makeOpts(cwd),
    ...(extra.teammate ? { messageOpts: { roomTurn: { teammate: true } } as never } : {}),
    effectiveCwd: cwd,
  });

const allowOf = (settings: unknown) =>
  (settings as { permissions?: { allow?: string[] } } | undefined)?.permissions?.allow;
const denyOf = (settings: unknown) =>
  (settings as { permissions?: { deny?: string[] } } | undefined)?.permissions?.deny ?? [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'launch-folder-allows-')));
  home = path.join(root, 'agent');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: [RULE], defaultMode: 'bypassPermissions' } })
  );
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === home,
    listRegisteredHomes: () => [home],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  store.permissions = { approvedFolderAllows: [], refusedFolderAllows: [] };
  asked = [];
  const gateway: FolderAllowApprovalGateway = {
    request: (input) => {
      asked.push(input);
      return {
        approvalId: 'a1',
        token: 't1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    consume: () => ({ outcome: 'expired' }) as never,
  };
  setFolderAllowApprovalGateway(gateway);
  _internal.forgetOpenCards();
});

afterEach(() => {
  setFolderAllowApprovalGateway(null);
  setAgentHomeRegistry(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('an agent folder allow list at launch', () => {
  it('passes nothing, raises a card, and says why in a Never ask chat, while unapproved', async () => {
    const resolved = await launch(home);
    expect(allowOf(resolved.sdkOptions.settings)).toBeUndefined();
    expect(resolved.sdkOptions.allowedTools).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(resolved.statusEvents).toContainEqual({
      type: 'system_status',
      data: { message: folderAllowsWaitingStatus('DorkOS Marketing') },
    });
  });

  it('says it once per chat, not on every turn', async () => {
    const session = makeSession();
    const again = () =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hi',
        session,
        opts: makeOpts(home),
        effectiveCwd: home,
      });
    const notice = {
      type: 'system_status',
      data: { message: folderAllowsWaitingStatus('DorkOS Marketing') },
    };
    expect((await again()).statusEvents).toContainEqual(notice);
    expect((await again()).statusEvents).not.toContainEqual(notice);
  });

  it('shows no notice in a chat that still asks', async () => {
    const resolved = await launch(home, { mode: 'default' });
    expect(resolved.statusEvents).not.toContainEqual(
      expect.objectContaining({ data: { message: folderAllowsWaitingStatus('DorkOS Marketing') } })
    );
  });

  it('passes the approved rules in settings, and nothing else from the file', async () => {
    recordFolderAllowApproval({ agentId: AGENT.id, home, rules: [RULE] });
    const resolved = await launch(home);
    expect(allowOf(resolved.sdkOptions.settings)).toEqual([RULE]);
    expect(resolved.sdkOptions.allowedTools).toBeUndefined();
    expect(resolved.sdkOptions.permissionMode).toBe('dontAsk');
    expect(asked).toHaveLength(0);
  });

  it('denies the self-grant files beside an applied list, and only then (M1)', async () => {
    // The home's own three are denied on every launch (DOR-3068); the rest of
    // the self-grant set rides only beside an applied list.
    const before = denyOf((await launch(home)).sdkOptions.settings);
    expect(before).toContain(`Edit(/${home}/.claude/**)`);
    // Where `.claude/skills/<x>` really points, so the skill itself.
    expect(before).toContain(`Edit(/${home}/.agents/**)`);
    // Write rules only: every launch now also carries read denies on the account files (DOR-3299).
    expect(before.some((rule) => rule.startsWith('Edit(') && rule.includes('~/.claude.json'))).toBe(
      false
    );

    recordFolderAllowApproval({ agentId: AGENT.id, home, rules: [RULE] });
    const deny = denyOf((await launch(home)).sdkOptions.settings);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(deny).toContain(`${tool}(/${home}/.claude/**)`);
      expect(deny).toContain(`${tool}(/${home}/.mcp.json)`);
      expect(deny).toContain(`${tool}(/${home}/.dork/agent.json)`);
      // Every other agent home's skills too, not only this one's.
      expect(
        deny.some((rule) => rule.startsWith(`${tool}(`) && rule.endsWith('/agents/*/.agents/**)'))
      ).toBe(true);
      expect(deny).toContain(`${tool}(~/.claude.json)`);
      expect(deny).toContain(`${tool}(~/.dork/config.json)`);
    }
  });

  it('passes nothing on a teammate turn, even when approved', async () => {
    recordFolderAllowApproval({ agentId: AGENT.id, home, rules: [RULE] });
    const resolved = await launch(home, { teammate: true });
    expect(allowOf(resolved.sdkOptions.settings)).toBeUndefined();
  });

  it('passes nothing for a folder no agent is registered at', async () => {
    const plain = path.join(root, 'plain');
    mkdirSync(path.join(plain, '.claude'), { recursive: true });
    writeFileSync(
      path.join(plain, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: [RULE] } })
    );
    const resolved = await launch(plain);
    expect(allowOf(resolved.sdkOptions.settings)).toBeUndefined();
    expect(asked).toHaveLength(0);
  });
});
