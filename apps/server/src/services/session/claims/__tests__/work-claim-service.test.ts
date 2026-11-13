/**
 * Work claims (DOR-4019): two chats of one agent can never both hold one job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { CLAIM_IDLE_LIMIT_MS, WorkClaimService, normaliseClaimKey } from '../work-claim-service.js';

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';

let db: Db;
let now: number;
let claims: WorkClaimService;

/** What the real audit log holds, oldest first. */
function audits() {
  return db
    .select()
    .from(auditEvents)
    .all()
    .map((row) => ({ action: row.action, outcome: row.outcome, reason: row.reason }));
}

beforeEach(() => {
  db = createTestDb();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
  now = Date.parse('2026-11-13T12:00:00Z');
  claims = new WorkClaimService({ db, now: () => now });
});

afterEach(() => resetAuditTrail());

describe('normaliseClaimKey', () => {
  it('writes one key one way', () => {
    expect(normaliseClaimKey('  dor-1234 ')).toBe('DOR-1234');
    expect(normaliseClaimKey('pr   #42')).toBe('PR #42');
  });

  it('refuses an empty or overlong key', () => {
    expect(normaliseClaimKey('   ')).toBeNull();
    expect(normaliseClaimKey('x'.repeat(121))).toBeNull();
  });
});

describe('WorkClaimService', () => {
  it('lets one chat claim a key, and its sibling see the claim', () => {
    const first = claims.claim(AGENT, 'chat-a', 'DOR-1', 'building the fix');
    expect(first).toMatchObject({ ok: true, renewed: false });
    expect(claims.check(AGENT, ['DOR-1'])).toEqual([
      expect.objectContaining({ key: 'DOR-1', sessionId: 'chat-a', note: 'building the fix' }),
    ]);
  });

  it('refuses a second chat, naming the one that holds it', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    const second = claims.claim(AGENT, 'chat-b', 'DOR-1');
    expect(second).toMatchObject({
      ok: false,
      code: 'CLAIMED',
      holder: { sessionId: 'chat-a', claimedAt: '2026-11-13T12:00:00.000Z' },
    });
    expect(audits().map((a) => [a.action, a.outcome])).toEqual([
      ['work_claim.claimed', 'ok'],
      ['work_claim.claimed', 'refused'],
    ]);
    // The audit trail is widely readable: a refusal never names the holding chat.
    expect(JSON.stringify(audits())).not.toContain('chat-a');
  });

  it('lets only one of several chats hold a key, by its primary key', () => {
    const results = ['chat-a', 'chat-b', 'chat-c'].map((chat) =>
      claims.claim(AGENT, chat, 'DOR-9')
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  it('renews, not refuses, a claim the same chat already holds', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    now += 60_000;
    expect(claims.claim(AGENT, 'chat-a', 'DOR-1')).toMatchObject({
      ok: true,
      renewed: true,
      claim: { lastSeenAt: '2026-11-13T12:01:00.000Z' },
    });
  });

  it('keeps one agent’s claims out of another’s', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    expect(claims.claim(OTHER_AGENT, 'chat-x', 'DOR-1')).toMatchObject({ ok: true });
    expect(claims.check(OTHER_AGENT)).toEqual([expect.objectContaining({ sessionId: 'chat-x' })]);
    expect(claims.release(OTHER_AGENT, 'chat-x', 'DOR-1')).toEqual({ ok: true });
    expect(claims.check(AGENT)).toHaveLength(1);
  });

  it('releases only for the chat that holds it', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    expect(claims.release(AGENT, 'chat-b', 'DOR-1')).toMatchObject({
      ok: false,
      code: 'NOT_YOURS',
    });
    expect(claims.release(AGENT, 'chat-a', 'DOR-1')).toEqual({ ok: true });
    expect(claims.check(AGENT)).toEqual([]);
    expect(claims.claim(AGENT, 'chat-b', 'DOR-1')).toMatchObject({ ok: true });
  });

  it('lapses a claim whose chat went idle past the limit, with an audit row', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    now += CLAIM_IDLE_LIMIT_MS + 1;
    expect(claims.check(AGENT)).toEqual([]);
    expect(claims.claim(AGENT, 'chat-b', 'DOR-1')).toMatchObject({ ok: true });
    expect(audits().map((a) => a.action)).toContain('work_claim.expired');
  });

  it('keeps a claim alive while its chat keeps working', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    now += CLAIM_IDLE_LIMIT_MS - 1_000;
    claims.touch('chat-a');
    now += CLAIM_IDLE_LIMIT_MS - 1_000;
    expect(claims.claim(AGENT, 'chat-b', 'DOR-1')).toMatchObject({ ok: false, code: 'CLAIMED' });
  });

  it('frees every claim of a chat that never started', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    claims.claim(AGENT, 'chat-a', 'DOR-2');
    claims.releaseSession('chat-a', 'the chat never started');
    expect(claims.check(AGENT)).toEqual([]);
  });

  it('hands a claim on only from the chat that holds it', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1');
    expect(claims.handOver(AGENT, 'DOR-1', 'chat-b', 'chat-c')).toBe(false);
    expect(claims.handOver(AGENT, 'DOR-1', 'chat-a', 'lane')).toBe(true);
    expect(claims.check(AGENT)).toEqual([expect.objectContaining({ sessionId: 'lane' })]);
  });

  it('follows a chat to the id it settled on', () => {
    claims.claim(AGENT, 'minted', 'DOR-1');
    claims.rekey('minted', 'canonical');
    expect(claims.check(AGENT)).toEqual([expect.objectContaining({ sessionId: 'canonical' })]);
    expect(claims.release(AGENT, 'canonical', 'DOR-1')).toEqual({ ok: true });
  });
});
