/**
 * The audit log writer (spec `audit-trail` §3.3): it chains, it notices an edit
 * made behind its back, it redacts what it must, and it never throws into the
 * action it records.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, eq, type Db } from '@dorkos/db';
import { AuditLog, GENESIS_HASH, computeAuditHash, type AuditInput } from '../audit-log.js';

const OWNER = { accountId: 'install:test', kind: 'person', name: 'Owner' } as const;

function input(over: Partial<AuditInput> = {}): AuditInput {
  return {
    actor: OWNER,
    source: { surface: 'app' },
    action: 'config.changed',
    operation: 'modify',
    outcome: 'ok',
    summary: 'Changed a setting',
    ...over,
  };
}

/** Take the triggers away, as somebody holding the database file could. */
function dropTriggers(db: Db): void {
  db.$client.exec(`
    DROP TRIGGER audit_events_append_only_update;
    DROP TRIGGER audit_events_append_only_delete;
    DROP TRIGGER audit_events_chain_link;
  `);
}

describe('AuditLog', () => {
  let db: Db;
  let log: AuditLog;

  beforeEach(() => {
    db = createTestDb();
    log = new AuditLog(db);
  });

  it('chains each row to the one before it, starting from the genesis hash', () => {
    const first = log.record(input())!;
    const second = log.record(input({ action: 'agent.registered', operation: 'create' }))!;
    const third = log.record(input())!;

    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(log.verify()).toEqual({ ok: true, checked: 3, lastSeq: 3, lastHash: third.hash });
  });

  it('stores a hash that its own columns reproduce', () => {
    log.record(input({ target: { type: 'agent', id: '01AGENT', name: 'Scout' } }));
    const [row] = db.select().from(auditEvents).all();
    const { hash, ...unhashed } = row!;
    expect(computeAuditHash(unhashed)).toBe(hash);
  });

  it('names the row whose contents were edited behind its back', () => {
    log.record(input());
    log.record(input());
    log.record(input());
    dropTriggers(db);
    db.update(auditEvents).set({ summary: 'Nothing happened' }).where(eq(auditEvents.seq, 2)).run();

    expect(log.verify()).toMatchObject({
      ok: false,
      checked: 1,
      firstBreak: { seq: 2, reason: 'its contents do not match its hash' },
    });
  });

  it('names a row that was deleted from the middle', () => {
    log.record(input());
    log.record(input());
    log.record(input());
    dropTriggers(db);
    db.delete(auditEvents).where(eq(auditEvents.seq, 2)).run();

    expect(log.verify()).toMatchObject({
      ok: false,
      firstBreak: { seq: 2, reason: 'this row is missing' },
    });
  });

  it('names a row that was rehashed but no longer links to its predecessor', () => {
    log.record(input());
    log.record(input());
    dropTriggers(db);
    // A careful forger rewrites row 1 AND fixes its hash. Row 2 still points at
    // the old one, which is exactly what the chain is for.
    const [row] = db.select().from(auditEvents).where(eq(auditEvents.seq, 1)).all();
    const { hash: _old, ...unhashed } = row!;
    const forged = { ...unhashed, summary: 'Nothing happened' };
    db.update(auditEvents)
      .set({ summary: forged.summary, hash: computeAuditHash(forged) })
      .where(eq(auditEvents.seq, 1))
      .run();

    expect(log.verify()).toMatchObject({
      ok: false,
      checked: 1,
      firstBreak: { seq: 2, reason: 'it does not link to the row before it' },
    });
  });

  it('checks a stretch from a starting point', () => {
    for (let i = 0; i < 5; i += 1) log.record(input());
    expect(log.verify({ fromSeq: 3 })).toMatchObject({ ok: true, checked: 3, lastSeq: 5 });
    expect(log.verify({ fromSeq: 2, limit: 2 })).toMatchObject({
      ok: true,
      checked: 2,
      lastSeq: 3,
    });
  });

  it('verifies the tail at startup and warns, without throwing, when it is broken', () => {
    log.record(input());
    log.record(input());
    dropTriggers(db);
    db.update(auditEvents).set({ actorName: 'Someone else' }).where(eq(auditEvents.seq, 2)).run();
    expect(log.verifyTail()).toMatchObject({ ok: false, firstBreak: { seq: 2 } });
  });

  it('keeps a secret setting’s name and drops both of its values', () => {
    const event = log.record(
      input({
        change: [
          { field: 'tunnel.authtoken', before: 'old-secret', after: 'new-secret' },
          { field: 'scheduler.maxConcurrentRuns', before: 4, after: 2 },
        ],
      })
    )!;
    expect(event.change).toEqual([
      { field: 'tunnel.authtoken', redacted: true },
      { field: 'scheduler.maxConcurrentRuns', before: 4, after: 2 },
    ]);
    expect(JSON.stringify(db.select().from(auditEvents).all())).not.toContain('secret');
  });

  it('sweeps credential shapes out of every free-text field', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    const hex = 'f'.repeat(40);
    const event = log.record(
      input({
        summary: `Pushed with ${token}`,
        error: `Bearer ${hex}`,
        reason: `key ${hex}`,
        target: { type: 'file', id: 'f1', name: `.env holding ${token}` },
        change: [{ field: 'notes.text', before: 'none', after: { nested: token } }],
      })
    )!;
    const stored = JSON.stringify(db.select().from(auditEvents).all());
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(hex);
    expect(event.summary).toBe('Pushed with [redacted]');
  });

  // Every shape a review found passing through unchanged (DOR-2738 PR1 review).
  it.each([
    ['a password assignment', 'login with password=hunter2 now', 'hunter2'],
    ['a JSON api key', '{"apiKey":"abcd1234efgh5678"}', 'abcd1234efgh5678'],
    ['a token assignment', 'token=abc123def456', 'abc123def456'],
    ['URL user info', 'cloned https://u:secretpass@host/x', 'secretpass'],
    ['an access_token query', 'GET /cb?access_token=zz99yy88xx77&state=1', 'zz99yy88xx77'],
    ['an env assignment', 'OPENAI_API_KEY=abcd1234 node run.js', 'abcd1234'],
    [
      'a JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ],
    ['a Google key', 'key AIzaSyA1234567890abcdefghijklmnopqrstu', 'AIzaSyA1234567890'],
    ['a Notion token', 'ntn_abcdefghij1234567890XYZ', 'ntn_abcdefghij'],
  ])('sweeps %s out of free text', (_shape, text, secret) => {
    log.record(input({ summary: text, error: text, reason: text }));
    expect(JSON.stringify(db.select().from(auditEvents).all())).not.toContain(secret);
  });

  it('empties a changed value whose member, or whose field, is named like a secret', () => {
    const event = log.record(
      input({
        change: [
          { field: 'profile.prefs', before: null, after: { password: 'hunter2', theme: 'dark' } },
          { field: 'connectors.composio.apiKey', before: 'old-key-1', after: 'new-key-2' },
        ],
      })
    )!;
    expect(event.change).toEqual([
      { field: 'profile.prefs', before: null, after: { password: '[redacted]', theme: 'dark' } },
      { field: 'connectors.composio.apiKey', redacted: true },
    ]);
    expect(JSON.stringify(db.select().from(auditEvents).all())).not.toMatch(
      /hunter2|old-key-1|new-key-2/
    );
  });

  it('leaves ordinary words that only look close alone', () => {
    const event = log.record(input({ summary: 'author=Dorian changed the tokenizer docs' }))!;
    expect(event.summary).toBe('author=Dorian changed the tokenizer docs');
  });

  it('checks a long log in pages and says where to continue', () => {
    for (let i = 0; i < 5; i += 1) log.record(input());
    expect(log.verify({ limit: 2 })).toMatchObject({ ok: true, checked: 2, nextFromSeq: 3 });
    expect(log.verify({ fromSeq: 3, limit: 2 })).toMatchObject({ checked: 2, nextFromSeq: 5 });
    const last = log.verify({ fromSeq: 5, limit: 2 });
    expect(last).toMatchObject({ ok: true, checked: 1, lastSeq: 5 });
    expect(last.nextFromSeq).toBeUndefined();
  });

  it('defaults to space visibility and refuses a participants row with nobody named', () => {
    expect(log.record(input())!.visibility).toBe('space');
    expect(log.record(input({ visibility: 'participants' }))).toBeUndefined();
    expect(
      log.record(input({ visibility: 'participants', participants: ['install:test'] }))
    ).toMatchObject({ visibility: 'participants', participants: ['install:test'] });
  });

  it('never throws into the action it records', () => {
    db.$client.close();
    expect(() => log.record(input())).not.toThrow();
    expect(log.record(input())).toBeUndefined();
  });

  it('tells observers about each committed event, one failure at a time', () => {
    const seen: number[] = [];
    log.observe(() => {
      throw new Error('boom');
    });
    log.observe((event) => seen.push(event.seq));
    log.record(input());
    log.record(input());
    expect(seen).toEqual([1, 2]);
  });
});
