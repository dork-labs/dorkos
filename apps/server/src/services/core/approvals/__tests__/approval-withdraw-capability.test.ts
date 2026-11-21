/**
 * `approvals.withdraw` through the real registry, tier gate and permission resolver (DOR-4586):
 * an agent takes back its own waiting request without a card of its own, under the strictest
 * preset, and a caller DorkOS can't name, or another agent, is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, eq, type Db } from '@dorkos/db';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { composeRegistry, type CapabilityRegistry } from '../../capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../capabilities/permission-enforcement.js';
import { ApprovalService } from '../approval-service.js';
import { hashApprovalInput } from '../approval-input-hash.js';
import { approvalsDomain } from '../approval-withdraw-capability.js';
import { eventFanOut } from '../../event-fan-out.js';
import { permissionActions } from '../../permissions/index.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: new Date().toISOString(),
};
const BEN: AgentIdentity = { ...ANA, agentPath: '/agents/ben', displayName: 'Ben' };

let db: Db;
let approvals: ApprovalService;
let registry: CapabilityRegistry;

beforeEach(() => {
  db = createTestDb();
  approvals = new ApprovalService(db);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
  initCapabilityTierGate({ approvals });
  registry = composeRegistry([approvalsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    approvalWithdrawDeps: { db },
  });
  initPermissionGate({
    readConfig: () => ({ preset: 'careful', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => ({ areas: { agents: 'blocked', settings: 'blocked' } }),
    listActions: () => permissionActions(registry),
  });
});

afterEach(() => {
  resetCapabilityTierGate();
  resetPermissionGate();
  resetAuditTrail();
  vi.restoreAllMocks();
});

/** A request Ana raised, waiting for a person. */
function anaAsks(): string {
  return approvals.request({
    capabilityId: 'tasks.set_mode',
    inputHash: hashApprovalInput({ id: 'nightly-sweep' }),
    summary: 'Set how a scheduled task runs',
    requestedBy: 'ana',
    requestedByPath: ANA.agentPath,
  }).approvalId;
}

describe('approvals.withdraw', () => {
  it('takes back the caller’s own request under the strictest preset, raising no card', async () => {
    const id = anaAsks();
    const result = await registry.invoke(
      'approvals.withdraw',
      { approvalId: id, reason: 'The task was deleted.' },
      { identity: ANA, retryChannel: 'mcp-argument' }
    );
    expect(result).toMatchObject({ status: 'withdrawn', approvalId: id });
    expect(approvals.listPending()).toHaveLength(0);
    // The audit row names the agent that took it back, not the server.
    const [row] = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'approval.withdraw'))
      .all();
    expect(row).toMatchObject({ actorKind: 'agent', targetId: id });
  });

  it('refuses another agent, and a caller DorkOS cannot name', async () => {
    const id = anaAsks();
    await expect(
      registry.invoke(
        'approvals.withdraw',
        { approvalId: id },
        { identity: BEN, retryChannel: 'mcp-argument' }
      )
    ).rejects.toMatchObject({ payload: { code: 'not_yours' } });
    await expect(
      registry.invoke(
        'approvals.withdraw',
        { approvalId: id },
        { agentIdentityPresented: true, retryChannel: 'mcp-argument' }
      )
    ).rejects.toMatchObject({ payload: { code: 'unidentified' } });
    expect(approvals.listPending().map((card) => card.approvalId)).toEqual([id]);
  });
});
