/**
 * Who a request is recorded as in the audit log (spec `audit-trail` PR2): the
 * agent its token names, the account its key or cookie proves, or the owner
 * when login is off. The agent question comes first, because an agent may hold
 * one of the person's API keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { auditActorForRequest } from '../audit-actor.js';

const AGENT = { agentPath: '/projects/scout', displayName: 'Scout', createdAt: '2026-10-07' };

function request(path: string, headers: Record<string, string> = {}) {
  return { path, headers };
}

describe('auditActorForRequest', () => {
  let owner: { id: string; name: string } | null;

  beforeEach(() => {
    owner = null;
    const db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => owner }),
    });
  });
  afterEach(() => resetAuditTrail());

  it('names the agent a resolved token names', () => {
    const scope = auditActorForRequest(request('/api/config', { 'x-dorkos-agent': 't' }), {
      locals: { agentIdentity: AGENT, user: { userId: 'u1', credential: 'api-key' } },
    });
    expect(scope).toMatchObject({ actor: { kind: 'agent', name: 'Scout' }, surface: 'http' });
    expect(scope!.actor.accountId).toMatch(/^unregistered:/);
  });

  it('names an unresolved token as unidentified, never as the person', () => {
    const scope = auditActorForRequest(request('/mcp', { 'x-dorkos-agent': 'bogus' }), {
      locals: {},
    });
    expect(scope).toMatchObject({
      actor: { accountId: 'unidentified', kind: 'external' },
      surface: 'mcp',
    });
  });

  it('names the account an API key proves, with a hashed reference to the key', () => {
    owner = { id: 'u1', name: 'Dorian' };
    const scope = auditActorForRequest(request('/api/config'), {
      locals: { user: { userId: 'u1', credential: 'api-key', credentialId: 'key-123' } },
    });
    expect(scope).toMatchObject({
      actor: { accountId: 'u1', kind: 'person', name: 'Dorian' },
      surface: 'http',
      credential: { kind: 'api-key' },
    });
    expect(JSON.stringify(scope)).not.toContain('key-123');
  });

  it('names a signed-in person in the app', () => {
    owner = { id: 'u1', name: 'Dorian' };
    expect(
      auditActorForRequest(request('/api/config'), {
        locals: { user: { userId: 'u1', credential: 'cookie' } },
      })
    ).toMatchObject({ actor: { accountId: 'u1', kind: 'person' }, surface: 'app' });
  });

  it('names the owner, by install id, when login is off and nothing is presented', () => {
    expect(auditActorForRequest(request('/api/config'), { locals: {} })).toMatchObject({
      actor: { accountId: 'install:inst-1', kind: 'person', name: 'Owner' },
      surface: 'app',
    });
  });

  it('enters no scope when no audit trail is set up', () => {
    resetAuditTrail();
    expect(auditActorForRequest(request('/api/config'), { locals: {} })).toBeUndefined();
  });
});
