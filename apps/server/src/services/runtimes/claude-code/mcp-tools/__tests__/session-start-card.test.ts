/**
 * `session_start` passes on Full autonomy unnamed only when no approval card
 * shows (ADR `261018-030117`): the rule that it be named exists for the person
 * approving the card, so with no card it only sent agents back at a lower mode.
 * Where a card does show, the rule holds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentPermissions } from '@dorkos/shared/permissions';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../../core/capabilities/permission-enforcement.js';
import type { AgentIdentity } from '../../../../core/agent-identity/agent-identity-service.js';

vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    has: (type: string) => type === 'claude-code',
    get: () => ({ getCapabilities: () => CLAUDE_CODE_CAPABILITIES }),
    getSessionSettings: async () => null,
  },
}));

const { resolveStartPermission } = await import('../session-start-permission.js');
const { startRaisesNoCard } = await import('../session-start-card.js');

const AGENT = '/agents/scout';
const LIVE: AgentIdentity = { agentPath: AGENT, displayName: 'Scout', createdAt: '2026-10-18' };
const describeAs = (identity: AgentIdentity | undefined) => async () => identity;

/** A start with no mode named, from a Claude Code chat at Bypass permissions. */
const inherit = (noApprovalCard: boolean) =>
  resolveStartPermission(
    undefined,
    { sessionId: 'caller', permissionMode: 'bypassPermissions', runtime: 'claude-code' },
    'claude-code',
    null,
    noApprovalCard
  );

function onPreset(preset: 'trusted' | 'careful', agent?: AgentPermissions): void {
  initPermissionGate({
    readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }) as never,
    readAgentPermissions: async () => agent,
  });
}

afterEach(() => resetPermissionGate());

describe('inheriting Full autonomy', () => {
  it('passes Bypass permissions on unnamed when no card shows', async () => {
    expect(await inherit(true)).toMatchObject({
      ok: true,
      permission: {
        mode: 'bypassPermissions',
        callerMode: 'bypassPermissions',
        sameAsCaller: true,
      },
    });
  });

  it('still has it named when a card shows', async () => {
    expect(await inherit(false)).toMatchObject({ ok: false, code: 'NAME_FULL_AUTONOMY' });
  });

  it('never lifts a start above the calling chat, card or not', async () => {
    const result = await resolveStartPermission(
      'bypassPermissions',
      { sessionId: 'caller', permissionMode: 'acceptEdits', runtime: 'claude-code' },
      'claude-code',
      null,
      true
    );
    expect(result).toMatchObject({ ok: false, code: 'ABOVE_YOUR_LEVEL' });
  });
});

describe('whether session_start raises a card', () => {
  it('raises none on Trusted for a live agent with the default settings', async () => {
    onPreset('trusted');
    expect(await startRaisesNoCard(AGENT, 'caller', describeAs(LIVE))).toBe(true);
  });

  it('may raise one on Careful', async () => {
    onPreset('careful');
    expect(await startRaisesNoCard(AGENT, 'caller', describeAs(LIVE))).toBe(false);
  });

  it('raises one when the agent’s Agents area is set to Ask', async () => {
    onPreset('trusted', { areas: { agents: 'ask' } } as AgentPermissions);
    expect(await startRaisesNoCard(AGENT, 'caller', describeAs(LIVE))).toBe(false);
  });

  it('answers "may" for an agent it cannot name, or one switched off', async () => {
    onPreset('trusted');
    expect(await startRaisesNoCard(AGENT, 'caller', describeAs(undefined))).toBe(false);
    expect(
      await startRaisesNoCard(AGENT, 'caller', describeAs({ ...LIVE, inactive: 'revoked' }))
    ).toBe(false);
  });

  it('answers "may" when the agent’s settings cannot be read', async () => {
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }) as never,
      readAgentPermissions: async () => {
        throw new Error('unreadable manifest');
      },
    });
    expect(await startRaisesNoCard(AGENT, 'caller', describeAs(LIVE))).toBe(false);
  });
});
