/**
 * An agent's sign-in tokens in the audit log (spec `audit-trail` PR2): each
 * token DorkOS mints for a session, and the revocation when an agent is
 * removed. The token itself never appears, only a short one-way reference.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import {
  AgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../agent-identity-service.js';
import { resolveAgentTokenEnv, AGENT_TOKEN_ENV_VAR } from '../agent-token-env.js';
import { createAgentIdentityUnregisterCascade } from '../unregister-cascade.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { clearTestHomes, registerEveryFolderAsHome } from './agent-home-fixture.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT_PATH = '/projects/researcher';

describe('agent tokens in the audit log', () => {
  let auditDb: Db;

  beforeEach(() => {
    registerEveryFolderAsHome();
    resetAgentIdentityService();
    auditDb = createTestDb();
    initAuditTrail({
      log: new AuditLog(auditDb),
      accounts: new AccountIds({ db: auditDb, installId: 'inst-1', readOwnerAccount: () => null }),
    });
  });

  afterEach(() => {
    clearTestHomes();
    resetAgentIdentityService();
    resetAuditTrail();
  });

  it('records each minted token for the agent, by reference only', async () => {
    initAgentIdentityService(createTestDb());
    const env = await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');
    const token = env[AGENT_TOKEN_ENV_VAR]!;

    const rows = auditDb.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'agent_token.minted',
      actorId: 'system',
      targetType: 'agent',
      targetName: 'Researcher',
    });
    expect(JSON.parse(rows[0]!.credential!)).toMatchObject({ kind: 'agent-token' });
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('records the revocation when an agent is removed', async () => {
    const service = new AgentIdentityService(createTestDb());
    await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const logger = { info: vi.fn(), warn: vi.fn() };

    createAgentIdentityUnregisterCascade(() => service, logger)('agent-1', AGENT_PATH);
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());

    const rows = auditDb.select().from(auditEvents).all();
    expect(rows).toMatchObject([
      { action: 'agent_token.revoked', targetId: 'agent-1', operation: 'remove' },
    ]);
    expect(JSON.parse(rows[0]!.change!)).toEqual([{ field: 'activeTokens', before: 2, after: 0 }]);
  });
});
