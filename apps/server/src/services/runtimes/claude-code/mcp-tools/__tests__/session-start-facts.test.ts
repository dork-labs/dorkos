/**
 * What `session_start` reads before it passes Full on unnamed (DOR-3147): a call
 * that raises an approval card, a held agent, or an unreadable answer all keep
 * Full named, and what a person set falls back to the configured default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  identity: { agentPath: '/agents/builder', displayName: 'Builder', createdAt: '' } as
    { agentPath: string; displayName: string; createdAt: string; inactive?: 'revoked' } | undefined,
  permission: { state: 'allowed' } as { state: string } | null | 'throw',
  personSet: undefined as ((agentPath: string) => string | null) | undefined,
  defaultStop: 'autonomy' as string | null,
}));

vi.mock('../../../../core/agent-identity/index.js', () => ({
  getAgentIdentityService: () => ({ describeAgent: async () => state.identity }),
}));
vi.mock('../../../../core/capabilities/permission-enforcement.js', () => ({
  permissionGateSources: () => ({ personSetFilesAndCommands: state.personSet }),
  resolveCallPermission: async () => {
    if (state.permission === 'throw') throw new Error('unreadable');
    return state.permission;
  },
}));
vi.mock('../../../../session/resolution/resolve-session-defaults.js', () => ({
  resolveUnattendedDefaultStop: () => state.defaultStop,
}));

const { startLevelFacts } = await import('../session-start-facts.js');

const runtime = { getCapabilities: () => ({ settings: { configSection: 'claudeCode' } }) };
const facts = (over: { agentPath?: string; name?: string } = {}) =>
  startLevelFacts(
    {
      agentPath: over.agentPath ?? '/agents/builder',
      name: over.name ?? 'builder',
      chat: { sessionId: 'caller' },
    },
    runtime as never,
    { prompt: 'go', cwd: '/work' }
  );

beforeEach(() => {
  state.identity = { agentPath: '/agents/builder', displayName: 'Builder', createdAt: '' };
  state.permission = { state: 'allowed' };
  state.personSet = () => null;
  state.defaultStop = 'autonomy';
});

describe('startLevelFacts', () => {
  it('lets Full pass on unnamed when the call raises no card', async () => {
    expect(await facts()).toEqual({ personSetStop: 'autonomy', fullUnnamedAllowed: true });
    state.permission = null;
    expect((await facts()).fullUnnamedAllowed).toBe(true);
  });

  it('keeps Full named when the call raises a card, or is blocked', async () => {
    state.permission = { state: 'ask' };
    expect((await facts()).fullUnnamedAllowed).toBe(false);
    state.permission = { state: 'blocked' };
    expect((await facts()).fullUnnamedAllowed).toBe(false);
  });

  it('fails closed when the permission or the caller cannot be read', async () => {
    state.permission = 'throw';
    expect((await facts()).fullUnnamedAllowed).toBe(false);
    state.permission = { state: 'allowed' };
    state.identity = undefined;
    expect((await facts()).fullUnnamedAllowed).toBe(false);
    state.identity = {
      agentPath: '/agents/builder',
      displayName: 'Builder',
      createdAt: '',
      inactive: 'revoked',
    };
    expect((await facts()).fullUnnamedAllowed).toBe(false);
  });

  it('keeps Full named for the agents held as they are (Cloud, marketing)', async () => {
    expect(
      (await facts({ agentPath: '/work/dorkos-cloud', name: 'cloud' })).fullUnnamedAllowed
    ).toBe(false);
    expect((await facts({ name: 'dorkos-marketing' })).fullUnnamedAllowed).toBe(false);
  });

  it('reads what a person set, else the configured default, else unknown', async () => {
    state.personSet = () => 'act';
    expect((await facts()).personSetStop).toBe('act');
    state.personSet = () => null;
    state.defaultStop = 'ask';
    expect((await facts()).personSetStop).toBe('ask');
    state.personSet = () => 'unknown';
    expect((await facts()).personSetStop).toBe('unknown');
    state.personSet = undefined;
    expect((await facts()).personSetStop).toBe('unknown');
  });
});
