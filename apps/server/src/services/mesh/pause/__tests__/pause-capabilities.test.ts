/**
 * `agent.pause` / `agent.resume` through the real registry, tier gate and
 * permission resolver (spec `audit-trail` PR5): the emergency stop never waits
 * on an approval card, under the strictest preset, and a paused agent can never
 * lift its own pause on any surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import {
  NEVER_ASKS_ACTIONS,
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
} from '../../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../../core/approvals/index.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { permissionActions } from '../../../core/permissions/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { AgentPauseService } from '../agent-pause.js';
import { agentPauseDomain } from '../pause-capabilities.js';
import { createAgentPauseRouter } from '../../../../routes/agent-pause.js';

const SCOUT = { id: '01SCOUTAGENTULID0000000000', home: '/projects/scout' } as const;
const ANA = { id: '01ANAAGENTULID00000000000', home: '/projects/ana' } as const;

const AS_SCOUT: AgentIdentity = {
  agentPath: SCOUT.home,
  displayName: 'Scout',
  createdAt: new Date().toISOString(),
};
const AS_ANA: AgentIdentity = {
  agentPath: ANA.home,
  displayName: 'Ana',
  createdAt: new Date().toISOString(),
};

function seed(db: Db): void {
  const now = new Date().toISOString();
  for (const [agent, name] of [
    [SCOUT, 'scout'],
    [ANA, 'ana'],
  ] as const) {
    db.insert(agents)
      .values({
        id: agent.id,
        name,
        runtime: 'claude-code',
        projectPath: agent.home,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
  }
}

describe('agent.pause and agent.resume (spec audit-trail PR5)', () => {
  let db: Db;
  let pauses: AgentPauseService;
  let registry: CapabilityRegistry;
  let preset: PermissionPreset | null;
  let agentSettings: AgentPermissions | undefined;

  beforeEach(() => {
    db = createTestDb();
    seed(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    pauses = new AgentPauseService({ db });
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    registry = composeRegistry([agentPauseDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      agentPauseDeps: { pauses },
    });
    preset = 'careful';
    agentSettings = { areas: { agents: 'blocked', settings: 'blocked', safety: 'blocked' } };
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => agentSettings,
      listActions: () => permissionActions(registry),
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    resetAuditTrail();
    vi.restoreAllMocks();
  });

  it('is act with no area: the tier alone decides', () => {
    for (const id of ['agent.pause', 'agent.resume']) {
      const capability = registry.get(id);
      expect(capability?.tier).toBe('act');
      expect(capability?.area).toBeNull();
      expect(NEVER_ASKS_ACTIONS.has(id)).toBe(true);
    }
  });

  it('never asks for approval under the strictest preset, for an agent caller', async () => {
    const result = await registry.invoke(
      'agent.pause',
      { agentId: ANA.id, reason: 'loop' },
      { identity: AS_SCOUT, retryChannel: 'mcp-argument' }
    );
    expect(result).toMatchObject({ agentId: ANA.id, paused: true, changed: true });
    expect(pauses.isPaused(ANA.id)?.pausedBy).toMatchObject({ accountId: SCOUT.id, kind: 'agent' });
  });

  it('is decided outside every area even if one is declared, or an entry names it', async () => {
    // The carve-out, isolated from the definition: an `act` action in Agents
    // asks under Careful, and these two ids never do.
    preset = 'careful';
    const asked = await resolveCallPermission({
      action: { id: 'agent.other', tier: 'act', area: 'agents' },
      identity: AS_SCOUT,
    });
    expect(asked?.state).toBe('blocked');
    for (const id of NEVER_ASKS_ACTIONS) {
      expect(
        await resolveCallPermission({
          action: { id, tier: 'act', area: 'agents' },
          identity: AS_SCOUT,
        })
      ).toBeNull();
    }
  });

  it('lets another agent resume, and refuses the paused agent resuming itself', async () => {
    await pauses.pause(SCOUT.id, { accountId: 'install:inst-1', kind: 'person', name: 'Owner' });
    await expect(
      registry.invoke(
        'agent.resume',
        { agentId: SCOUT.id },
        { identity: AS_SCOUT, retryChannel: 'mcp-argument' }
      )
    ).rejects.toMatchObject({ payload: { code: 'CANNOT_RESUME_SELF' } });
    expect(pauses.isPaused(SCOUT.id)).toBeDefined();

    const resumed = await registry.invoke(
      'agent.resume',
      { agentId: SCOUT.id },
      { identity: AS_ANA, retryChannel: 'mcp-argument' }
    );
    expect(resumed).toMatchObject({ paused: false, changed: true });
  });

  it('refuses a resume from a caller that presented a token nobody could resolve', async () => {
    await pauses.pause(SCOUT.id, { accountId: 'install:inst-1', kind: 'person', name: 'Owner' });
    await expect(
      registry.invoke(
        'agent.resume',
        { agentId: SCOUT.id },
        { agentIdentityPresented: true, retryChannel: 'mcp-argument' }
      )
    ).rejects.toMatchObject({ payload: { code: 'CANNOT_RESUME_SELF' } });
  });

  describe('over HTTP', () => {
    // One listening server for the block; the router reads each test's registry.
    const http = express();
    http.use(express.json());
    http.use('/api', createAgentPauseRouter({ registry: () => registry }));
    const server = listeningServer(http);

    it('pauses, lists and resumes as the person at the app', async () => {
      await request(server)
        .post(`/api/agents/${SCOUT.id}/pause`)
        .send({ reason: 'stop' })
        .expect(200);
      const listed = await request(server).get('/api/agents/pauses').expect(200);
      expect(listed.body.pauses).toEqual([
        expect.objectContaining({ agentId: SCOUT.id, reason: 'stop' }),
      ]);
      const resumed = await request(server).post(`/api/agents/${SCOUT.id}/resume`).expect(200);
      expect(resumed.body).toMatchObject({ paused: false, changed: true });
    });

    it('answers 404 for an agent that does not exist', async () => {
      const res = await request(server).post('/api/agents/nobody/pause').expect(404);
      expect(res.body.code).toBe('AGENT_NOT_FOUND');
    });
  });
});
