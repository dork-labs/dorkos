/**
 * At Full, a `config_patch` reaching a setting only a person may change is refused in every turn,
 * marked or not (DOR-3426): the Full preset, or a chat set to Full, asks nobody, and the setting is
 * a person's. One Activity line, no card, the turn never waits, and the refusal names the setting.
 * A patch that only turns those settings down runs instead, with one line (Security's direction
 * rule). Below Full it still cards, either way.
 *
 * The preset is set through the real `PUT /api/permissions/preset` route, as QA's gate does: the
 * earlier rows set only the agent's level, and missed this.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { resetChosenTurns, setMarkedFullActivity } from '../../turn-power/full-autonomy.js';
import { resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import {
  TWO_AGENTS,
  createPermissionWorld,
} from '../../permissions/__tests__/permission-fixtures.js';
import { createPermissionsRoutes } from '../../../../routes/permissions.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type GatedAction,
} from '../tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
  type PermissionGatedAction,
} from '../permission-enforcement.js';

// The routes are served through the `/api` chain, which reads the login setting: off.
vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const AGENT: AgentIdentity = {
  agentPath: '/agents/writer',
  displayName: 'Writer',
  createdAt: new Date().toISOString(),
};

let counter = 0;
const fresh = () => `full-preset-${(counter += 1)}`;

/** Run one turn in a chat set to `stored`. */
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

/** What the gate decides for one `config_patch` by the writer in this session. */
async function patch(sessionId: string, body: Record<string, unknown>) {
  const action = composeCapabilityRegistryForDocs().capabilities.find(
    (c) => c.id === 'operator.config_patch'
  ) as unknown as GatedAction & PermissionGatedAction;
  const input = { patch: body };
  const permission = await resolveCallPermission({ action, identity: AGENT, sessionId, input });
  return enforceCapabilityTier({
    action,
    input,
    permission,
    identity: AGENT,
    retryChannel: 'mcp-argument',
  });
}

const HOOKS = { harness: { approvedHooks: ['evil'] } };
const TUNNEL = { tunnel: { domain: 'evil.example' } };
const PREFERENCE = { ui: { theme: 'dark' } };
const MARKED: MessageOpts = { permissionCeiling: 'runtime-default' };

const target = swappableServer();
const emit = vi.fn(async () => undefined);
let world: ReturnType<typeof createPermissionWorld>;

/** Set the preset the way a person does, through the route. */
async function setPreset(preset: string) {
  const app = target.mount(
    honoGroupListener({
      path: '/api',
      routes: createPermissionsRoutes({
        permissions: world.service,
        activity: world.activity,
        isLoginEnabled: () => false,
      }),
    })
  );
  const res = await request(app)
    .put('/api/permissions/preset')
    .send({ preset, surface: 'settings' });
  expect(res.status).toBe(200);
  expect(world.config.preset).toBe(preset);
}

/** The refused lines written. */
const refusedLines = () =>
  emit.mock.calls
    .map((c) => (c as unknown as [{ metadata?: Record<string, unknown> }])[0])
    .filter((line) => line.metadata?.refused === true);

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
  emit.mockClear();
  setMarkedFullActivity({ emit } as never);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  world = createPermissionWorld({ preset: 'trusted', agents: TWO_AGENTS });
  initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
  initPermissionGate({
    readConfig: () => ({ preset: world.config.preset, defaults: world.config.defaults }),
    readAgentPermissions: async () => undefined,
  });
});
afterEach(() => {
  resetCapabilityTierGate();
  resetPermissionGate();
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
  resetChosenTurns();
  setMarkedFullActivity(undefined);
  vi.restoreAllMocks();
});

describe('config_patch to a person’s setting at the Full preset (DOR-3426)', () => {
  it.each([
    ['harness.approvedHooks', HOOKS, 'Reach & secrets'],
    ['tunnel.domain', TUNNEL, 'Reach & secrets'],
  ])('refuses %s in an unmarked turn: named, no card, one line', async (name, body, area) => {
    await setPreset('full');
    const session = fresh();
    await ran(session, 'acceptEdits');
    const decision = await patch(session, body);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.payload.message).toContain(`\`${name}\` (${area})`);
    expect(decision.payload.message).toContain('Settings');
    expect(decision.payload.approvable).toBe(false);
    expect(refusedLines()).toHaveLength(1);
    expect(refusedLines()[0]!.metadata).toMatchObject({
      actionId: 'operator.config_patch',
      refused: true,
      marked: false,
    });
  });

  it('refuses it in a marked turn too', async () => {
    await setPreset('full');
    const session = fresh();
    await ran(session, 'acceptEdits', MARKED);
    const decision = await patch(session, HOOKS);
    expect(decision.outcome).toBe('denied');
    expect(refusedLines()).toHaveLength(1);
    expect(refusedLines()[0]!.metadata).toMatchObject({ refused: true, marked: true });
  });

  it('lets a plain preference through, with no refused line', async () => {
    await setPreset('full');
    const session = fresh();
    await ran(session, 'acceptEdits');
    expect((await patch(session, PREFERENCE)).outcome).not.toBe('denied');
    expect(refusedLines()).toHaveLength(0);
  });
});

describe('a patch that only turns a person’s settings down, at the Full preset', () => {
  const TUNNEL_OFF = { tunnel: { enabled: false } };

  it.each([
    ['unmarked', undefined],
    ['marked', MARKED],
  ])('runs in a %s turn, with one tightened line and no refusal', async (_how, opts) => {
    await setPreset('full');
    const session = fresh();
    await ran(session, 'acceptEdits', opts);
    expect((await patch(session, TUNNEL_OFF)).outcome).toBe('allowed');
    expect(refusedLines()).toHaveLength(0);
    const lines = emit.mock.calls
      .map((c) => (c as unknown as [{ metadata?: Record<string, unknown> }])[0])
      .filter((line) => line.metadata?.tightened === true);
    expect(lines).toHaveLength(1);
  });

  it('turning a trust stop down to Ask runs too', async () => {
    await setPreset('full');
    const session = fresh();
    await ran(session, 'acceptEdits');
    const down = { runtimes: { defaultTrustStop: 'ask' } };
    expect((await patch(session, down)).outcome).toBe('allowed');
  });

  it('a patch that turns one down and raises another is refused, naming only the raise', async () => {
    await setPreset('full');
    const session = fresh();
    await ran(session, 'acceptEdits');
    const decision = await patch(session, { tunnel: { enabled: false, domain: 'evil.example' } });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.payload.message).toContain('`tunnel.domain`');
    expect(decision.payload.message).not.toContain('`tunnel.enabled`');
  });

  it('turning one up is a raise: tunnel on is refused', async () => {
    await setPreset('full');
    const session = fresh();
    await ran(session, 'acceptEdits');
    expect((await patch(session, { tunnel: { enabled: true } })).outcome).toBe('denied');
  });

  it('below Full, turning one down still raises its card', async () => {
    const session = fresh();
    await ran(session, 'acceptEdits');
    expect((await patch(session, TUNNEL_OFF)).outcome).toBe('approval_required');
  });
});

describe('config_patch to a person’s setting below Full', () => {
  it('still raises its card under Trusted, with no refused line', async () => {
    const session = fresh();
    await ran(session, 'acceptEdits');
    expect((await patch(session, HOOKS)).outcome).toBe('approval_required');
    expect(refusedLines()).toHaveLength(0);
  });

  it('a chat set to Full is refused under Trusted too, unmarked', async () => {
    const session = fresh();
    await ran(session, 'bypassPermissions');
    const decision = await patch(session, TUNNEL);
    expect(decision.outcome).toBe('denied');
    expect(refusedLines()).toHaveLength(1);
  });
});
