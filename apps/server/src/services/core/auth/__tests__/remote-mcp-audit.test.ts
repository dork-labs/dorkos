import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents } from '@dorkos/db';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds, credentialRef } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { runWithAuditActor } from '../../../audit/audit-context.js';
import type { RequestFacts } from '../../../../http/request-facts.js';
import {
  annotateRemoteMcpKeyList,
  recordApiKeyCreationRoute,
  recordRemoteMcpSession,
} from '../remote-mcp-audit.js';

afterEach(() => resetAuditTrail());

function fixture() {
  const db = createTestDb();
  const log = new AuditLog(db);
  initAuditTrail({
    log,
    accounts: new AccountIds({ db, installId: 'test-install', readOwnerAccount: () => null }),
  });
  const request: RequestFacts = {
    headers: { host: 'localhost:4242', authorization: 'Bearer secret-test-value' },
    peerAddress: '198.51.100.4',
    forwardedAddress: '198.51.100.4',
    connectionEncrypted: false,
    ingress: 'direct',
    agentIdentity: undefined,
    user: { userId: 'person-test', credential: 'api-key', credentialId: 'key-test' },
  };
  const actor = { accountId: 'person-test', kind: 'person' as const, name: 'Test person' };
  return {
    db,
    request,
    record: (facts = request) =>
      runWithAuditActor({ actor, surface: 'mcp' }, () => recordRemoteMcpSession(facts)),
  };
}

describe('remote MCP audit and key-list projection', () => {
  it('writes each remote stateless session, naming the caller and hashing the key reference', () => {
    const { db, record } = fixture();
    record();
    record();
    const rows = db.select().from(auditEvents).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'mcp.remote_session',
      actorId: 'person-test',
      visibility: 'admins',
      targetId: credentialRef('api-key', 'key-test').idHash,
    });
    expect(JSON.stringify(rows)).not.toContain('secret-test-value');
    expect(JSON.parse(rows[0]!.source)).toMatchObject({ surface: 'mcp', ip: '198.51.100.4' });
  });

  it('never writes a credential header into the row (DOR-4206)', () => {
    const { db, record, request } = fixture();
    record({
      ...request,
      headers: {
        ...request.headers,
        cookie: 'better-auth.session_token=cookie-test-value',
        'x-api-key': 'header-key-test-value',
        'x-dorkos-agent-token': 'agent-token-test-value',
        'proxy-authorization': 'Basic proxy-test-value',
      },
    });
    const raw = JSON.stringify(db.select().from(auditEvents).all());
    for (const secret of [
      'secret-test-value',
      'cookie-test-value',
      'header-key-test-value',
      'agent-token-test-value',
      'proxy-test-value',
    ])
      expect(raw, secret).not.toContain(secret);
  });

  it('does not count a local session as remote use', async () => {
    const { db, record, request } = fixture();
    record({ ...request, peerAddress: '127.0.0.1', forwardedAddress: '127.0.0.1' });
    expect(db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it('recognizes remote ingress even when the peer is loopback', () => {
    const { db, record, request } = fixture();
    record({ ...request, peerAddress: '127.0.0.1', ingress: 'own-tunnel' });
    expect(db.select().from(auditEvents).all()).toHaveLength(1);
  });

  it('returns last remote use only for the returned keys, without changing list pagination', async () => {
    const { db, record } = fixture();
    record();
    const at = db.select().from(auditEvents).get()!.at;
    // A new trail reads the timestamp from storage, not a process-local cache.
    resetAuditTrail();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'test-install', readOwnerAccount: () => null }),
    });
    const response = await annotateRemoteMcpKeyList(
      Response.json({
        apiKeys: [
          { id: 'key-test', name: 'Test' },
          { id: 'unused-test', name: 'Unused' },
        ],
        total: 2,
      })
    );
    expect(await response.json()).toEqual({
      apiKeys: [
        { id: 'key-test', name: 'Test', lastUsedRemotelyAt: at, createdFrom: null },
        { id: 'unused-test', name: 'Unused', lastUsedRemotelyAt: null, createdFrom: null },
      ],
      total: 2,
    });
  });

  it('records remote cookie sessions without attributing their use to any key', async () => {
    const { db, record, request } = fixture();
    record({ ...request, user: { userId: 'person-test', credential: 'cookie' } });
    expect(db.select().from(auditEvents).get()!.targetId).toBeNull();
    const response = await annotateRemoteMcpKeyList(
      Response.json({ apiKeys: [{ id: 'key-test' }] })
    );
    expect(await response.json()).toEqual({
      apiKeys: [{ id: 'key-test', lastUsedRemotelyAt: null, createdFrom: null }],
    });
  });

  it('preserves refusals and responses that are not key lists', async () => {
    fixture();
    const refused = Response.json({ error: 'Unauthorized' }, { status: 401 });
    expect(await annotateRemoteMcpKeyList(refused)).toBe(refused);
    const other = Response.json({ ok: true });
    expect(await annotateRemoteMcpKeyList(other)).toBe(other);
  });

  it('records a remote key’s creation device without retaining its secret', async () => {
    const { db, request } = fixture();
    const secret = 'made-up-created-key-secret';
    const response = Response.json({ id: 'key-created', key: secret });
    const facts = {
      ...request,
      ingress: 'own-tunnel' as const,
      headers: {
        host: 'localhost:4242',
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      },
    };
    const same = await runWithAuditActor(
      {
        actor: { accountId: 'person-test', kind: 'person', name: 'Test person' },
        surface: 'app',
      },
      () => recordApiKeyCreationRoute(facts, response)
    );
    expect(same).toBe(response);
    expect((await same.json()).key).toBe(secret);
    const rows = db.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'api_key.created_remotely',
      targetId: credentialRef('api-key', 'key-created').idHash,
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
    resetAuditTrail();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({
        db,
        installId: 'test-install',
        readOwnerAccount: () => null,
      }),
    });
    const listed = await annotateRemoteMcpKeyList(
      Response.json({ apiKeys: [{ id: 'key-created' }] })
    );
    const madeFrom = (await listed.json()).apiKeys[0].createdFrom;
    expect(madeFrom).toContain('iPhone');
    expect(madeFrom).toContain('over Remote Access');
  });

  it('does not label local or refused key creation as remote', async () => {
    const { db, request } = fixture();
    await recordApiKeyCreationRoute(
      { ...request, peerAddress: '127.0.0.1', forwardedAddress: '127.0.0.1' },
      Response.json({ id: 'key-local' })
    );
    await recordApiKeyCreationRoute(
      { ...request, ingress: 'managed' },
      Response.json({ error: 'Not created' }, { status: 403 })
    );
    expect(db.select().from(auditEvents).all()).toHaveLength(0);
  });
});
