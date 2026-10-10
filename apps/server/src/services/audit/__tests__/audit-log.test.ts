/**
 * The audit log writer (spec `audit-trail` §3.3): it chains, it notices an edit
 * made behind its back, it redacts what it must, and it never throws into the
 * action it records.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, eq, type Db } from '@dorkos/db';
import { AuditLog, GENESIS_HASH, computeAuditHash, type AuditInput } from '../audit-log.js';

/** Token prefixes built from parts, so no fixture reads as a real key to a secret scanner. */
const STRIPE_LIVE = ['sk', 'live', ''].join('_');
const GITHUB_PAT = ['ghp', ''].join('_');

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
    const token = `${GITHUB_PAT}abcdefghijklmnopqrstuvwxyz0123`;
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
    ['an access_token in a full URL', 'opened https://h/x?access_token=zzzz1111', 'zzzz1111'],
    ['a token after a URL scheme with a port', 'http://h:8080/cb?token=qq77ww66', 'qq77ww66'],
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

  it('keeps settings that only sound secret: counts, limits and yes/no values', () => {
    const event = log.record(
      input({
        change: [
          {
            field: 'runtimes.limits',
            before: null,
            after: {
              maxTokens: 4096,
              passwordMinLength: 8,
              tokenizer: 'cl100k',
              authRequired: true,
            },
          },
        ],
        summary: 'maxTokens=4096 tokenizer=cl100k',
      })
    )!;
    expect(event.change).toEqual([
      {
        field: 'runtimes.limits',
        before: null,
        after: { maxTokens: 4096, passwordMinLength: 8, tokenizer: 'cl100k', authRequired: true },
      },
    ]);
    expect(event.summary).toBe('maxTokens=4096 tokenizer=cl100k');
  });

  it.each([
    ['one long name run', 'a.'.repeat(50_000)],
    ['a long name before an equals sign', `${'a'.repeat(100_000)}=x`],
    ['many quoted names', '"a":'.repeat(25_000)],
    ['a long URL head', `https://${'u'.repeat(100_000)}`],
  ])('redacts pathological text quickly: %s', (_shape, text) => {
    const started = performance.now();
    log.record(input({ summary: text, error: text, reason: text }));
    // Three fields, each swept. Linear work is a few milliseconds; the old
    // pattern took seconds on the first of these (DOR-2738 review).
    expect(performance.now() - started).toBeLessThan(150);
  });

  it.each([
    [
      'a bearer header',
      'curl -H "Authorization: Bearer sk-proj-AbCdEf0123456789abcdef0123" https://api.x.com',
      'sk-proj-AbCdEf',
    ],
    [
      'a bearer header with an opaque token',
      'curl -H "Authorization: Bearer q8Zr2LmN4vB7xT1wPa9K" x.com',
      'q8Zr2LmN4vB7xT1wPa9K',
    ],
    [
      'an exported key',
      'export OPENAI_API_KEY=sk-proj-AbCdEf0123456789abcdef0123',
      'AbCdEf0123456789',
    ],
    ['a mysql short password flag', 'mysql -uroot -pHunter2Secret db', 'Hunter2Secret'],
    ['a long password flag', 'psql --password Hunter2Secret', 'Hunter2Secret'],
    ['a token flag with equals', 'gh api --token=Q8zR2lmN4vb7xt1w', 'Q8zR2lmN4vb7xt1w'],
    [
      'a URL password',
      `git clone https://bob:${GITHUB_PAT}AbCdEf0123456789abcdef0123456789abcd@github.com/x/y`,
      `${GITHUB_PAT}AbCdEf`,
    ],
    [
      'a heredoc settings file',
      `cat > app.cfg <<EOF\nSTRIPE_KEY=${STRIPE_LIVE}AbCdEf0123456789abcdef\nEOF`,
      `${STRIPE_LIVE}AbCdEf`,
    ],
    [
      'a basic auth header',
      'curl -H "Authorization: Basic YWRtaW46c2VjcmV0cGFzcw==" x.com',
      'YWRtaW46c2VjcmV0cGFzcw',
    ],
    [
      'a Telegram bot token',
      'curl https://api.telegram.org/bot123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-xY/getMe',
      'AAEhBOweik6ad9r',
    ],
    ['a curl user password', 'curl -u admin:Hunter2Secret https://x.com', 'Hunter2Secret'],
    ['a long user flag password', 'curl --user admin:Hunter2Secret https://x.com', 'Hunter2Secret'],
    ['a docker login password', 'docker login -u me -p Hunter2Secret registry.io', 'Hunter2Secret'],
    ['a cookie header', "curl -H 'Cookie: session=Q8zR2lmN4vb7xt1w' x.com", 'Q8zR2lmN4vb7xt1w'],
    [
      'an aws configure set',
      'aws configure set aws_secret_access_key Q8zR2lmN4vb7xt1wQ8zR',
      'Q8zR2lmN4vb7xt1w',
    ],
    [
      'a raw GitHub token',
      `grep -r ${GITHUB_PAT}AbCdEf0123456789abcdef0123456789abcd .`,
      `${GITHUB_PAT}AbCdEf`,
    ],
  ])('redacts a secret in a tool target, id and name alike: %s', (_shape, text, secret) => {
    const event = log.record(input({ target: { type: 'command', id: text, name: text } }))!;
    expect(event.target?.id).not.toContain(secret);
    expect(event.target?.name).not.toContain(secret);
    const [row] = db.select().from(auditEvents).all();
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('leaves ordinary flags and set commands alone', () => {
    const text = 'git config set user.name Dorian && tar -p -cf a.tar . && curl -u admin https://x';
    expect(log.record(input({ summary: text }))!.summary).toBe(text);
  });

  it('keeps an ordinary target id as it is', () => {
    const event = log.record(
      input({ target: { type: 'agent', id: '01KJXYKJYW4N8QGQ5W4GB6YM9J' } })
    )!;
    expect(event.target?.id).toBe('01KJXYKJYW4N8QGQ5W4GB6YM9J');
  });

  it('leaves ordinary words that only look close alone', () => {
    const event = log.record(input({ summary: 'author=Dorian changed the tokenizer docs' }))!;
    expect(event.summary).toBe('author=Dorian changed the tokenizer docs');
  });

  it('hands a gap at a page boundary to the next page, which reports it', () => {
    for (let i = 0; i < 6; i += 1) log.record(input());
    dropTriggers(db);
    db.delete(auditEvents).where(eq(auditEvents.seq, 4)).run();

    const first = log.verify({ limit: 3 });
    expect(first).toMatchObject({ ok: true, checked: 3, lastSeq: 3, nextFromSeq: 4 });
    expect(log.verify({ fromSeq: first.nextFromSeq, prevHash: first.lastHash })).toMatchObject({
      ok: false,
      firstBreak: { seq: 4, reason: 'this row is missing' },
    });
  });

  it('checks the link across a page boundary', () => {
    for (let i = 0; i < 4; i += 1) log.record(input());
    const first = log.verify({ limit: 2 });
    // The page carried over: the boundary link holds.
    expect(log.verify({ fromSeq: 3, prevHash: first.lastHash })).toMatchObject({ ok: true });
    // A page told the wrong predecessor names the first row of the page.
    expect(log.verify({ fromSeq: 3, prevHash: 'e'.repeat(64) })).toMatchObject({
      ok: false,
      firstBreak: { seq: 3, reason: 'it does not link to the row before it' },
    });
    // With no hash carried over, the stored row before the page is used.
    expect(log.verify({ fromSeq: 3 })).toMatchObject({ ok: true, checked: 2 });
  });

  it('names a missing row just before a page that starts mid-chain', () => {
    for (let i = 0; i < 4; i += 1) log.record(input());
    dropTriggers(db);
    db.delete(auditEvents).where(eq(auditEvents.seq, 2)).run();
    expect(log.verify({ fromSeq: 3 })).toMatchObject({
      ok: false,
      firstBreak: { seq: 2, reason: 'this row is missing' },
    });
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
