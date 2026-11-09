/**
 * The name an approval card shows for one agent approving another's request
 * (Security S6 on #3572): the agent that asked and the app, never the id, and
 * only while the request is still waiting.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectorAgentRequests,
  connectorReviewRequests,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { agentRequestSubjectName } from '../access/approval-requests.js';

const NOW = '2026-11-09T00:00:00.000Z';

function seedRequest(db: Db, id: string, answered: boolean) {
  db.insert(connectorReviewRequests)
    .values({
      id: `review-${id}`,
      actionKind: 'agent_connection_request',
      actionVersion: 1,
      requesterKind: 'agent',
      requesterId: 'agent-newbie',
      agentId: 'agent-newbie',
      sessionId: 'session-1',
      authorityBindingDigest: 'digest',
      targetKind: 'service',
      targetId: 'linear',
      actionPayloadJson: '{}',
      state: answered ? 'approved' : 'pending',
      expiresAt: '2099-01-01T00:00:00.000Z',
      idempotencyKey: `request-${id}`,
      createdAt: NOW,
    })
    .run();
  db.insert(connectorAgentRequests)
    .values({
      id,
      reviewRequestId: `review-${id}`,
      agentId: 'agent-newbie',
      sessionId: 'session-1',
      serviceSlug: 'linear',
      requestedAccess: 'read',
      requestedEventsJson: '[]',
      reason: 'Read the board',
      resumeState: 'pending',
      sourceGeneration: 'generation-1',
      resumeToken: `token-${id}`,
      originRuntime: 'claude-code',
      originAgentPath: '/agents/newbie',
      originAuthorityDigest: 'digest',
      createdAt: NOW,
      ...(answered && {
        outcome: 'granted' as const,
        resolvedConnectionId: 'connection',
        resolvedOperationRevisionIdsJson: '[]',
        resolvedEventsJson: '[]',
        resolvedAt: NOW,
      }),
    })
    .run();
}

describe('agentRequestSubjectName', () => {
  let db: Db;
  const names: Record<string, string> = { 'agent-newbie': 'Flow Snapshot' };
  let name: (requestId: string) => string | undefined;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    name = agentRequestSubjectName(db, (agentId) => names[agentId]);
  });

  it('names the agent that asked and the app, from the request row and the registry', () => {
    seedRequest(db, 'waiting', false);
    expect(name('waiting')).toBe('Flow Snapshot · Linear');
  });

  it('names nothing for an answered request, an unknown one, or an agent the registry lost', () => {
    seedRequest(db, 'answered', true);
    expect(name('answered')).toBeUndefined();
    expect(name('missing')).toBeUndefined();

    delete names['agent-newbie'];
    seedRequest(db, 'orphan', false);
    expect(name('orphan')).toBeUndefined();
  });
});
