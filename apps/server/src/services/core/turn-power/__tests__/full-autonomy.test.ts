/**
 * The permission gate reads what a chat is SET to (DOR-3394): a chat set to Full autonomy asks
 * nobody anything, whatever mark or hold its turn carries, and one Activity line records a send
 * or a standing change a marked turn in it ran unasked. Below Full a turn nobody is watching is
 * refused at once with a reason, and no card is raised.
 *
 * Every case uses the real seam that records turn levels and the real gate.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import { boundTurnOpts } from '../agent-level-bound.js';
import { chosenFullAutonomy } from '../../../runtimes/claude-code/turn-permission.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import {
  choseFullAutonomy,
  isFullLevel,
  ownLevelBounds,
  resetChosenTurns,
  setMarkedFullActivity,
  turnHasNobodyToAsk,
} from '../full-autonomy.js';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { gatedActionForMcpTool } from '../../mcp-tool-tiers.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type GatedAction,
} from '../../capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
  type PermissionGatedAction,
} from '../../capabilities/permission-enforcement.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/lifeos',
  displayName: 'LifeOS',
  createdAt: new Date().toISOString(),
};
const CARRIED = { permissionCeiling: CARRIED_OUTSIDER_LEVEL } as const;

let counter = 0;
const fresh = () => `full-autonomy-${(counter += 1)}`;
let approvals: ApprovalService;

/** Run one turn in a chat set to `stored`, through the seam the registry wraps every runtime in. */
async function ran(sessionId: string, stored: string, opts?: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => stored
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** An action as the gate receives it, from the registry or the hand-tool table. */
function actionFor(id: string): GatedAction & PermissionGatedAction {
  const registry = composeCapabilityRegistryForDocs().capabilities;
  return registry.find((capability) => capability.id === id) ?? gatedActionForMcpTool(id);
}

/** What the gate decides for one call by LifeOS from this chat. */
async function decide(id: string, sessionId: string) {
  const action = actionFor(id);
  const permission = await resolveCallPermission({ action, identity: AGENT, sessionId, input: {} });
  return enforceCapabilityTier({
    action,
    input: {},
    permission,
    identity: AGENT,
    retryChannel: 'mcp-argument',
    requestingSession: { sessionId } as never,
  });
}

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
  resetChosenTurns();
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  approvals = new ApprovalService(createTestDb());
  initCapabilityTierGate({ approvals });
  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
});
afterEach(() => {
  setMarkedFullActivity(undefined);
  resetCapabilityTierGate();
  resetPermissionGate();
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
  resetChosenTurns();
  vi.restoreAllMocks();
});

describe('what a chat is set to', () => {
  it('is recorded apart from the ceiling its turn carries', async () => {
    const held = fresh();
    const carried = fresh();
    const below = fresh();
    await ran(held, 'bypassPermissions', { permissionCeiling: 'runtime-default' });
    await ran(carried, 'bypassPermissions', CARRIED);
    await ran(below, 'acceptEdits', CARRIED);
    expect(choseFullAutonomy(held)).toBe(true);
    expect(choseFullAutonomy(carried)).toBe(true);
    expect(choseFullAutonomy(below)).toBe(false);
    expect(choseFullAutonomy(undefined)).toBe(false);
    expect(choseFullAutonomy('never-ran')).toBe(false);
  });

  it('counts the agent’s level a chat follows, and reads Full off any runtime’s declaration', async () => {
    const follows = fresh();
    await ran(follows, 'default', { levelPermissionMode: 'bypassPermissions' });
    expect(choseFullAutonomy(follows)).toBe(true);
    // Codex's danger-full-access declares this level; its workspace-write does not.
    expect(isFullLevel({ asks: 'never', reach: 'everything' })).toBe(true);
    expect(isFullLevel({ asks: 'never', reach: 'workspace' })).toBe(false);
  });

  it('records whether anybody can be asked, per turn', async () => {
    const chat = fresh();
    await ran(chat, 'acceptEdits', { unattended: true });
    expect(turnHasNobodyToAsk(chat)).toBe(true);
    await ran(chat, 'acceptEdits', { unattendedApprovals: true });
    expect(turnHasNobodyToAsk(chat)).toBe(true);
    await ran(chat, 'acceptEdits');
    expect(turnHasNobodyToAsk(chat)).toBe(false);
  });
});

describe('the permission gate in a chat set to Full', () => {
  it('raises no card for a marked turn’s send or standing change, and writes one line each', async () => {
    const emit = vi.fn(async (_event: unknown) => {});
    setMarkedFullActivity({ emit });
    const chat = fresh();
    await ran(chat, 'bypassPermissions', CARRIED);
    expect((await decide('connectors.execute_write', chat)).outcome).toBe('allowed');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: AGENT.agentPath,
        eventType: 'agent.marked_full_action',
        resourceId: 'connectors.execute_write',
      })
    );
    expect((await decide('binding_create', chat)).outcome).toBe('allowed');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(approvals.listPending()).toEqual([]);
  });

  it('writes no line for an unmarked Full turn, nor for a marked turn below Full', async () => {
    const emit = vi.fn(async (_event: unknown) => {});
    setMarkedFullActivity({ emit });
    const plain = fresh();
    const below = fresh();
    await ran(plain, 'bypassPermissions');
    await ran(below, 'acceptEdits', CARRIED);
    expect((await decide('connectors.execute_write', plain)).outcome).toBe('allowed');
    expect((await decide('connectors.execute_write', below)).outcome).toBe('approval_required');
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('the agent’s own level still holds (DOR-3175)', () => {
  const RUNTIME = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
  } as unknown as AgentRuntime;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'dorkos-full-autonomy-'));
    registerTestHomes([home]);
  });
  afterEach(async () => {
    clearTestHomes();
    await rm(home, { recursive: true, force: true });
  });

  /** What the agent-level seam sends a scheduled run with, for an agent at `level`. */
  function scheduled(level: string, stored: string, extra: MessageOpts = {}) {
    return boundTurnOpts(
      RUNTIME,
      fresh(),
      { cwd: home, permissionMode: stored as never, unattended: true, ...extra },
      { storedModeOf: () => stored, levelOf: async () => ({ mode: level }) as never }
    );
  }

  it('keeps a plain level bound and drops only marks and a stranger’s hold', () => {
    const agentCap = { asks: 'always', reach: 'edit' } as const;
    expect(ownLevelBounds(['runtime-default', CARRIED_OUTSIDER_LEVEL, agentCap])).toEqual(agentCap);
    expect(ownLevelBounds(['runtime-default', CARRIED_OUTSIDER_LEVEL])).toBeUndefined();
    expect(
      ownLevelBounds([{ asks: 'always', reach: 'read', teammate: [] }, 'runtime-default'] as never)
    ).toBeUndefined();
    expect(ownLevelBounds(undefined)).toBeUndefined();
  });

  it('an agent at Ask with a schedule stored at Full, marked and unattended: not Full, refused with no card', async () => {
    const sent = await scheduled('default', 'bypassPermissions', CARRIED);
    // The agent's level rides in the ceiling beside the mark.
    expect(JSON.stringify(sent?.permissionCeiling)).toContain('"asks":"always"');
    const chat = fresh();
    await ran(chat, 'bypassPermissions', sent);
    expect(choseFullAutonomy(chat)).toBe(false);
    expect(turnHasNobodyToAsk(chat)).toBe(true);
    // The Claude Code gate reads the same ceiling the same way.
    expect(
      chosenFullAutonomy({
        permissionMode: 'bypassPermissions',
        turnPermissionCeiling: sent!.permissionCeiling!,
      })
    ).toBe(false);
    const decision = await decide('binding_create', chat);
    expect(decision).toMatchObject({
      outcome: 'denied',
      payload: { reason: 'enforcement_unavailable', approvable: false },
    });
    expect(approvals.listPending()).toEqual([]);
  });

  it('an agent at Full with a schedule stored at Ask: not Full', async () => {
    const sent = await scheduled('bypassPermissions', 'default');
    const chat = fresh();
    await ran(chat, 'default', sent);
    expect(choseFullAutonomy(chat)).toBe(false);
    expect(
      chosenFullAutonomy({
        permissionMode: 'default',
        ...(sent?.permissionCeiling ? { turnPermissionCeiling: sent.permissionCeiling } : {}),
      })
    ).toBe(false);
  });

  it('an agent at Full with a schedule stored at Full, marked: Full, and the mark asks nothing', async () => {
    const sent = await scheduled('bypassPermissions', 'bypassPermissions', CARRIED);
    const chat = fresh();
    await ran(chat, 'bypassPermissions', sent);
    expect(choseFullAutonomy(chat)).toBe(true);
    expect((await decide('binding_create', chat)).outcome).toBe('allowed');
  });
});

describe('a turn nobody is watching, below Full', () => {
  it('is refused at once with a reason, and no card is raised', async () => {
    const chat = fresh();
    await ran(chat, 'acceptEdits', { ...CARRIED, unattended: true });
    const decision = await decide('binding_create', chat);
    expect(decision).toMatchObject({
      outcome: 'denied',
      payload: { reason: 'enforcement_unavailable', approvable: false },
    });
    expect(decision.outcome === 'denied' && decision.payload.message).toContain(
      'nobody is watching this run'
    );
    expect(approvals.listPending()).toEqual([]);
  });

  it('still raises the card when a person is there', async () => {
    const chat = fresh();
    await ran(chat, 'acceptEdits', CARRIED);
    expect((await decide('binding_create', chat)).outcome).toBe('approval_required');
    expect(approvals.listPending()).toHaveLength(1);
  });

  it('runs unasked in a chat set to Full', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions', { ...CARRIED, unattended: true });
    expect((await decide('binding_create', chat)).outcome).toBe('allowed');
    expect(approvals.listPending()).toEqual([]);
  });
});
