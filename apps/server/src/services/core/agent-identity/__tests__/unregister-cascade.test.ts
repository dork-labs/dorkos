import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Logger } from '@dorkos/shared/logger';
import { AgentIdentityService } from '../agent-identity-service.js';
import { createAgentIdentityUnregisterCascade } from '../unregister-cascade.js';

const AGENT_PATH = '/projects/researcher';

function buildLogger(): Pick<Logger, 'info' | 'warn'> {
  return { info: vi.fn(), warn: vi.fn() };
}

/**
 * Before DOR-490, `AgentIdentityService.revoke` had zero production callers:
 * deleting or unregistering an agent had no effect on its identity tokens,
 * which kept resolving past the operator's own removal, bounded only by their
 * idle/absolute expiry clocks. This proves the `MeshCore.onUnregister`
 * cascade actually calls it.
 */
describe('createAgentIdentityUnregisterCascade', () => {
  let db: Db;
  let service: AgentIdentityService;
  let logger: Pick<Logger, 'info' | 'warn'>;

  beforeEach(() => {
    db = createTestDb();
    service = new AgentIdentityService(db);
    logger = buildLogger();
  });

  it('revokes every live token for the unregistered agent', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    expect(await service.resolve(token)).toBeDefined();

    const cascade = createAgentIdentityUnregisterCascade(() => service, logger);
    cascade('agent-1', AGENT_PATH);
    // The cascade fires the revoke and reports async — give the microtask a turn.
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());

    expect(await service.resolve(token)).toBeUndefined();
    expect(await service.describeAgent(AGENT_PATH)).toBeUndefined();
  });

  it('leaves other agents untouched', async () => {
    const mine = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const theirs = await service.mint({ agentPath: '/projects/other', displayName: 'Other' });

    const cascade = createAgentIdentityUnregisterCascade(() => service, logger);
    cascade('agent-1', AGENT_PATH);
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());

    expect(await service.resolve(mine)).toBeUndefined();
    expect(await service.resolve(theirs)).toBeDefined();
  });

  it('is a silent no-op when no identity service is configured', () => {
    const cascade = createAgentIdentityUnregisterCascade(() => undefined, logger);
    expect(() => cascade('agent-1', AGENT_PATH)).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never says nothing was there when an agent held no tokens', async () => {
    const cascade = createAgentIdentityUnregisterCascade(() => service, logger);
    cascade('agent-1', '/projects/never-minted');
    // revoke() resolves 0; the info line is conditional on count > 0, so
    // nothing should be logged for an agent that never minted a token. Give
    // its promise chain a turn before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports a revoke failure as a warning rather than throwing', async () => {
    const failingService = { revoke: vi.fn().mockRejectedValue(new Error('db is gone')) };
    const cascade = createAgentIdentityUnregisterCascade(
      () => failingService as unknown as AgentIdentityService,
      logger
    );

    expect(() => cascade('agent-1', AGENT_PATH)).not.toThrow();
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    expect(logger.warn).toHaveBeenCalledWith(
      '[AgentIdentity] Could not revoke tokens for an unregistered agent',
      expect.objectContaining({ agentId: 'agent-1', reason: 'db is gone' })
    );
  });
});
