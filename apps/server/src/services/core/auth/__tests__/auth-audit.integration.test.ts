/**
 * Sign-ins, accounts and API keys in the audit log (spec `audit-trail` PR2),
 * through the real Better Auth endpoints: Better Auth keeps state, not
 * history, so these rows are the only record that any of it happened.
 * Records that carry where a sign-in came from are admins-only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, auditEvents, session, eq, type Db } from '@dorkos/db';
import { createAuth, toNodeHandler } from '../index.js';
import { authSessionRemovals } from '../session-removals.js';
import { initConfigManager } from '../../config-manager.js';
import { env } from '../../../../env.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

describe('auth events in the audit log (integration)', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-auth-audit-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'auth-audit.db'));
    runMigrations(db);
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    const app = express();
    app.all('/api/auth/*splat', toNodeHandler(createAuth(db, tmpDir)));
    fixtureTarget.mount(app);
  });

  afterAll(() => {
    resetAuditTrail();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Rows written since `from`, as [action, visibility]. */
  const rowsSince = (from: number) =>
    db
      .select()
      .from(auditEvents)
      .all()
      .filter((row) => row.seq > from)
      .map((row) => [row.action, row.visibility]);
  const lastSeq = () => db.select().from(auditEvents).all().at(-1)?.seq ?? 0;

  let cookies: string[];

  it('records the owner account, linked to the install id it was known by', async () => {
    const res = await request(fixtureServer)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: EMAIL, password: PASSWORD, name: 'Dorian' });
    expect(res.status).toBe(200);

    const linked = db
      .select()
      .from(auditEvents)
      .all()
      .find((row) => row.action === 'account.linked');
    expect(linked).toBeDefined();
    expect(JSON.parse(linked!.change!)).toEqual([
      { field: 'accountId', before: 'install:inst-1', after: linked!.actorId },
    ]);
  });

  it('records a sign-in as an admins-only row, with where it came from', async () => {
    const from = lastSeq();
    const res = await request(fixtureServer)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .set('User-Agent', 'audit-test-agent')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    cookies = res.headers['set-cookie'] as unknown as string[];

    expect(rowsSince(from)).toEqual([['auth.signed_in', 'admins']]);
    const row = db.select().from(auditEvents).all().at(-1)!;
    expect(JSON.parse(row.source)).toMatchObject({ userAgent: 'audit-test-agent' });
  });

  it('records a failed sign-in, naming nobody', async () => {
    const from = lastSeq();
    const res = await request(fixtureServer)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: EMAIL, password: 'wrong-password-entirely' });
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(rowsSince(from)).toEqual([['auth.sign_in_failed', 'admins']]);
    expect(db.select().from(auditEvents).all().at(-1)).toMatchObject({
      actorId: 'unidentified',
      outcome: 'refused',
    });
  });

  it('records an API key created and revoked, without the key', async () => {
    let from = lastSeq();
    const created = await request(fixtureServer)
      .post('/api/auth/api-key/create')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .send({ name: 'cli' });
    expect(created.status).toBe(200);
    expect(rowsSince(from)).toEqual([['api_key.created', 'space']]);
    expect(JSON.stringify(db.select().from(auditEvents).all())).not.toContain(
      created.body.key as string
    );

    from = lastSeq();
    const deleted = await request(fixtureServer)
      .post('/api/auth/api-key/delete')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .send({ keyId: created.body.id });
    expect(deleted.status).toBe(200);
    expect(rowsSince(from)).toEqual([['api_key.revoked', 'space']]);
  });

  it('records revoking every other sign-in as a revocation, not a sign-out', async () => {
    // A second sign-in, so there is another session to revoke.
    await request(fixtureServer)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });
    const from = lastSeq();
    const res = await request(fixtureServer)
      .post('/api/auth/revoke-other-sessions')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .send({});
    expect(res.status).toBe(200);
    // Every other session goes (the sign-up's own and the one just made), and
    // each is a revocation.
    const rows = rowsSince(from);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(new Set(rows.map(([action, visibility]) => `${action}:${visibility}`))).toEqual(
      new Set(['auth.session_revoked:admins'])
    );
  });

  it('records a sign-out and revokes its original Browser session after deletion', async () => {
    const current = await request(fixtureServer)
      .get('/api/auth/get-session')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies);
    expect(current.status).toBe(200);
    const removed: Array<{ sessionId: string; userId: string }> = [];
    const rowsAtRemoval: unknown[] = [];
    const unsubscribe = authSessionRemovals.subscribe((value) => {
      removed.push(value);
      rowsAtRemoval.push(db.select().from(session).where(eq(session.id, value.sessionId)).get());
    });
    try {
      const from = lastSeq();
      const res = await request(fixtureServer)
        .post('/api/auth/sign-out')
        .set('Origin', ORIGIN)
        .set('Cookie', cookies)
        .send({});
      expect(res.status).toBe(200);
      expect(removed).toEqual([
        { sessionId: current.body.session.id, userId: current.body.user.id },
      ]);
      expect(rowsAtRemoval).toEqual([undefined]);
      expect(rowsSince(from)).toEqual([['auth.signed_out', 'admins']]);
    } finally {
      unsubscribe();
    }
  });

  it('names an expired session as expired, whatever removed it', async () => {
    const { sessionEndReason } = await import('../auth-audit.js');
    const past = new Date(Date.now() - 1000);
    expect(sessionEndReason({ userId: 'u', expiresAt: past }, '/get-session').action).toBe(
      'auth.session_expired'
    );
    expect(sessionEndReason({ userId: 'u' }, '/revoke-session').action).toBe(
      'auth.session_revoked'
    );
    expect(sessionEndReason({ userId: 'u' }, undefined).action).toBe('auth.session_ended');
  });
});
