/**
 * Claims become edges with history (DOR-4972): every claim and every end of
 * one writes a `claims` or `released` edge in the claim's own transaction, at
 * the transition's own time, through the recorder the composition root sets
 * (`wireClaimLinks`). Real stores throughout: the claim service, the edge
 * store and the audit trail over one SQLite database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { workClaims, workLinks, type Db } from '@dorkos/db';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { CLAIM_IDLE_LIMIT_MS, WorkClaimService } from '../../session/claims/work-claim-service.js';
import { wireClaimLinks } from '../../../startup/steps/work-graph.js';
import { setWorkClaims } from '../../session/claims/work-claim-current.js';
import { claimForStart } from '../../session/claims/work-claim-start.js';
import { OWNER_READER } from '../../audit/visibility.js';
import {
  getWorkLinkStore,
  installWorkLinkStore,
  recordChatClaim,
  recordChatRekey,
  uninstallWorkLinkStore,
} from '../index.js';
import { readWorkItemChats } from '../reads/work-item-chats.js';

const AGENT = 'agent-1';
const TICKET = { kind: 'ticket', id: 'DOR-1234' } as const;

let db: Db;
let now: number;
let claims: WorkClaimService;
let unwire: () => void;

/** The edges recorded to the ticket, oldest first, as their columns read. */
function edges(to: string = 'DOR-1234') {
  return db
    .select()
    .from(workLinks)
    .all()
    .filter((row) => row.toRef === to)
    .map((row) => ({
      from: row.fromRef,
      relation: row.relation,
      at: row.recordedAt,
      source: row.source,
      by: row.recordingChatId,
    }));
}

/** The ticket's spans, read as the owner. */
function spans() {
  return readWorkItemChats(
    { ref: TICKET, reader: OWNER_READER, limit: 50 },
    (ids) => new Set(ids),
    getWorkLinkStore()!
  ).spans;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

beforeEach(() => {
  db = createTestDb();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
  installWorkLinkStore(db);
  unwire = wireClaimLinks();
  now = Date.parse('2026-11-26T12:00:00.000Z');
  claims = new WorkClaimService({ db, now: () => now });
});

afterEach(() => {
  setWorkClaims(undefined);
  unwire();
  uninstallWorkLinkStore();
  resetAuditTrail();
});

describe('a claim and its release', () => {
  it('records the claim at the lock’s own claimedAt, and the release at its time', () => {
    const claimed = claims.claim(AGENT, 'chat-a', 'DOR-1234');
    expect(claimed.ok).toBe(true);
    now += 60_000;
    claims.claim(AGENT, 'chat-a', 'DOR-1234'); // a renewal changes no span
    now += 60_000;
    expect(claims.release(AGENT, 'chat-a', 'DOR-1234').ok).toBe(true);
    expect(edges()).toEqual([
      {
        from: 'dork:chat:chat-a',
        relation: 'claims',
        at: claimed.ok ? claimed.claim.claimedAt : '',
        source: 'claim-tool',
        by: 'chat-a',
      },
      {
        from: 'dork:chat:chat-a',
        relation: 'released',
        at: iso(now),
        source: 'release-tool',
        by: 'chat-a',
      },
    ]);
    expect(spans()).toEqual([
      {
        relation: 'claims',
        chatId: 'chat-a',
        claimedAt: '2026-11-26T12:00:00.000Z',
        endedAt: '2026-11-26T12:02:00.000Z',
        endedBy: 'released',
      },
    ]);
  });

  it('records a second claim by the same chat as a span of its own', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1234');
    now += 60_000;
    claims.release(AGENT, 'chat-a', 'DOR-1234');
    now += 60_000;
    claims.claim(AGENT, 'chat-a', 'DOR-1234');
    expect(spans().map((span) => 'endedBy' in span && span.endedBy)).toEqual(['released', null]);
  });

  it('records nothing for a key that is not a ticket or a pull request', () => {
    claims.claim(AGENT, 'chat-a', 'CHECKOUT-FF CLEANUP');
    claims.release(AGENT, 'chat-a', 'CHECKOUT-FF CLEANUP');
    expect(db.select().from(workLinks).all()).toEqual([]);
  });

  it('records nothing for a free key shaped like owner/repo#12', () => {
    expect(claims.claim(AGENT, 'chat-a', 'FIX/BUG#12').ok).toBe(true);
    claims.release(AGENT, 'chat-a', 'FIX/BUG#12');
    expect(db.select().from(workLinks).all()).toEqual([]);
  });

  it('records the same free key from session_start, named or read off the brief, as nothing', async () => {
    setWorkClaims(claims);
    const start = (sessionId: string, args: { claim?: string; title?: string }) =>
      claimForStart({
        args,
        agentId: AGENT,
        agentPath: '/agents/a',
        callerSessionId: 'caller',
        sessionId,
      });
    expect(await start('lane-1', { claim: 'fix/bug#12' })).toBeNull();
    claims.release(AGENT, 'lane-1', 'FIX/BUG#12');
    expect(await start('lane-2', { title: 'Look at fix/bug#12 again' })).toBeNull();
    expect(
      db
        .select()
        .from(workClaims)
        .all()
        .map((row) => row.claimKey)
    ).toEqual(['FIX/BUG#12']);
    expect(db.select().from(workLinks).all()).toEqual([]);
    // A ticket the brief names is recorded, as the new chat's claim, by the chat that called.
    expect(await start('lane-3', { title: 'Build DOR-77' })).toBeNull();
    expect(edges('DOR-77')).toEqual([
      expect.objectContaining({ from: 'dork:chat:lane-3', source: 'session-start', by: 'caller' }),
    ]);
  });

  it('records a pull request key as the pull request', () => {
    claims.claim(AGENT, 'chat-a', 'PR #42');
    expect(edges('PR #42')).toEqual([expect.objectContaining({ relation: 'claims' })]);
  });
});

describe('a claim that ends without a release', () => {
  it('records a lapse when it lapsed, not when the sweep noticed, by the server', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1234');
    const lastSeen = now;
    now += CLAIM_IDLE_LIMIT_MS + 5 * 60_000;
    expect(claims.check(AGENT)).toEqual([]);
    expect(edges().at(-1)).toEqual({
      from: 'dork:chat:chat-a',
      relation: 'released',
      at: iso(lastSeen + CLAIM_IDLE_LIMIT_MS),
      source: 'lapse-sweep',
      by: null,
    });
  });

  it('records a takeover after a lapse as the lapse, then the new chat’s claim', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1234');
    now += CLAIM_IDLE_LIMIT_MS + 1000;
    expect(claims.claim(AGENT, 'chat-b', 'DOR-1234').ok).toBe(true);
    expect(edges().map((e) => [e.from, e.relation, e.source])).toEqual([
      ['dork:chat:chat-a', 'claims', 'claim-tool'],
      ['dork:chat:chat-a', 'released', 'lapse-sweep'],
      ['dork:chat:chat-b', 'claims', 'claim-tool'],
    ]);
    expect(spans().map((span) => 'endedBy' in span && [span.chatId, span.endedBy])).toEqual([
      ['chat-a', 'lapsed'],
      ['chat-b', null],
    ]);
  });

  it('records a hand-over as the giver’s release and the taker’s claim, by the taker', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1234');
    now += 1000;
    expect(claims.handOver(AGENT, 'DOR-1234', 'chat-a', 'chat-b')).toBe(true);
    expect(edges().slice(1)).toEqual([
      {
        from: 'dork:chat:chat-a',
        relation: 'released',
        at: iso(now),
        source: 'hand-over',
        by: 'chat-b',
      },
      {
        from: 'dork:chat:chat-b',
        relation: 'claims',
        at: iso(now),
        source: 'hand-over',
        by: 'chat-b',
      },
    ]);
  });

  it('records the cleanup of a chat that never started, and the read leaves its span out', () => {
    claims.claim(AGENT, 'minted', 'DOR-1234', undefined, {
      writer: 'session-start',
      chatId: 'caller',
    });
    claims.releaseSession('minted', 'the chat never started');
    expect(edges().map((e) => [e.relation, e.source, e.by])).toEqual([
      ['claims', 'session-start', 'caller'],
      ['released', 'session-end', null],
    ]);
    expect(spans()).toEqual([]);
  });
});

describe('three transitions in one millisecond', () => {
  // Accepted: a claim's rows are unique by time, to the millisecond, so a repeat of one
  // transition lands nothing. A claim, its release and a second claim by one chat inside one
  // millisecond therefore keep the first claim and the release only. The lock still holds the
  // second claim; the history just shows the first span, ended. No tool does all three that fast.
  it('keeps the first claim and its release, and drops the second claim', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1234');
    claims.release(AGENT, 'chat-a', 'DOR-1234');
    expect(claims.claim(AGENT, 'chat-a', 'DOR-1234').ok).toBe(true);
    expect(edges().map((e) => [e.relation, e.at])).toEqual([
      ['claims', iso(now)],
      ['released', iso(now)],
    ]);
    expect(db.select().from(workClaims).all()).toHaveLength(1);
    expect(spans()).toEqual([
      expect.objectContaining({ chatId: 'chat-a', endedBy: 'released', endedAt: iso(now) }),
    ]);
  });
});

describe('a chat whose id was replaced', () => {
  it('writes no edge for the re-key, and the read pairs the two ids as one chat', () => {
    claims.claim(AGENT, 'first-id', 'DOR-1234');
    recordChatRekey('first-id', 'lasting-id');
    claims.rekey('first-id', 'lasting-id');
    now += 1000;
    claims.release(AGENT, 'lasting-id', 'DOR-1234');
    expect(edges().map((e) => e.from)).toEqual(['dork:chat:first-id', 'dork:chat:lasting-id']);
    expect(spans()).toEqual([
      expect.objectContaining({ chatId: 'lasting-id', endedBy: 'released' }),
    ]);
  });
});

describe('the history never decides the claim', () => {
  it('writes every change inside the claim’s own transaction', () => {
    const seen: [string, string, boolean][] = [];
    const inside = new WorkClaimService({
      db,
      now: () => now,
      recordChange: (tx, change) => {
        seen.push([change.transition, change.writer, db.$client.inTransaction]);
        recordChatClaim(tx, change);
      },
    });
    inside.claim(AGENT, 'chat-a', 'DOR-1234');
    inside.handOver(AGENT, 'DOR-1234', 'chat-a', 'chat-b');
    inside.release(AGENT, 'chat-b', 'DOR-1234');
    inside.claim(AGENT, 'chat-c', 'DOR-1234');
    now += CLAIM_IDLE_LIMIT_MS + 1000;
    inside.check(AGENT);
    inside.claim(AGENT, 'chat-d', 'DOR-1234');
    inside.releaseSession('chat-d', 'the chat never started');
    expect(seen).toEqual([
      ['claimed', 'claim-tool', true],
      ['released', 'hand-over', true],
      ['claimed', 'hand-over', true],
      ['released', 'release-tool', true],
      ['claimed', 'claim-tool', true],
      ['released', 'lapse-sweep', true],
      ['claimed', 'claim-tool', true],
      ['released', 'session-end', true],
    ]);
    expect(edges()).toHaveLength(8);
  });

  it('lands the edge with the lock change: a failed claim records nothing', () => {
    claims.claim(AGENT, 'chat-a', 'DOR-1234');
    expect(claims.claim(AGENT, 'chat-b', 'DOR-1234').ok).toBe(false);
    expect(edges()).toHaveLength(1);
  });

  it('keeps the claim when the recorder throws', () => {
    const failing = new WorkClaimService({
      db,
      now: () => now,
      recordChange: () => {
        throw new Error('edge store down');
      },
    });
    expect(failing.claim(AGENT, 'chat-a', 'DOR-1234').ok).toBe(true);
    expect(failing.release(AGENT, 'chat-a', 'DOR-1234').ok).toBe(true);
    expect(failing.claim(AGENT, 'chat-a', 'DOR-1234').ok).toBe(true);
    expect(db.select().from(workClaims).all()).toHaveLength(1);
    expect(edges()).toEqual([]);
  });

  it('keeps the claim when the edge store refuses the row', () => {
    // The real store, with the work graph's triggers: a row it cannot write is dropped.
    db.$client.exec(
      "CREATE TRIGGER refuse_claims BEFORE INSERT ON work_links BEGIN SELECT RAISE(ABORT, 'no'); END;"
    );
    expect(claims.claim(AGENT, 'chat-a', 'DOR-1234').ok).toBe(true);
    expect(db.select().from(workClaims).all()).toHaveLength(1);
    expect(edges()).toEqual([]);
  });
});
