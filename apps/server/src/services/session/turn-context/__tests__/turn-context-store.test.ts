import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TurnContextStore, type TurnContextInput } from '../turn-context-store.js';

/** Made-up text standing in for an agent's memory: the thing Security says must not outlive its session. */
const MEMORY = '<agent_memory>Prefers oat milk; the launch moved to Tuesday.</agent_memory>';
const APPEND = `<agent_identity>Name: Tester</agent_identity>\n${MEMORY}`;

function turn(
  sessionId: string,
  prompt: string,
  extra: Partial<TurnContextInput> = {}
): TurnContextInput {
  return {
    sessionId,
    runtime: 'claude-code',
    place: 'chat',
    permissionMode: 'default',
    systemSentThisTurn: true,
    parts: [
      { slot: 'system_append', text: APPEND },
      { slot: 'prompt', text: prompt },
    ],
    ...extra,
  };
}

/** Every body row, read straight from SQLite rather than through the store. */
function bodies(db: Db): { hash: string; body: string }[] {
  return db.$client.prepare('SELECT hash, body FROM turn_context_bodies').all() as {
    hash: string;
    body: string;
  }[];
}

describe('TurnContextStore', () => {
  it('stores two turns with the same append as one body', () => {
    const db = createTestDb();
    const store = new TurnContextStore(db);
    store.record(turn('s1', 'first words'));
    store.record(turn('s1', 'second words'));

    const appendRows = bodies(db).filter((row) => row.body === APPEND);
    expect(appendRows).toHaveLength(1);
    // Two prompts and one shared append.
    expect(bodies(db)).toHaveLength(3);

    const records = store.listTurnContextsForSession('s1');
    expect(records).toHaveLength(2);
    expect(records[0]!.parts[0]!.bodyHash).toBe(records[1]!.parts[0]!.bodyHash);
    expect(records.map((r) => r.parts[1]!.body)).toEqual(['first words', 'second words']);
  });

  it('keeps the metadata it was given', () => {
    const store = new TurnContextStore(createTestDb());
    store.record(
      turn('s1', 'hi', {
        messageId: 'm-1',
        runtime: 'codex',
        place: 'room',
        permissionMode: 'acceptEdits',
        systemSentThisTurn: false,
      })
    );
    const [record] = store.listTurnContextsForSession('s1');
    expect(record).toMatchObject({
      messageId: 'm-1',
      runtime: 'codex',
      place: 'room',
      permissionMode: 'acceptEdits',
      systemSentThisTurn: false,
    });
    const prompt = record!.parts[1]!;
    expect(prompt).toMatchObject({ slot: 'prompt', bytes: 2, tokensEstimate: 1, redacted: false });
    expect(prompt.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deletes a session’s rows, and the memory text only it held', () => {
    const db = createTestDb();
    const store = new TurnContextStore(db);
    store.record(turn('gone', 'bye'));

    expect(store.deleteForSessions(['gone'])).toBe(1);

    expect(store.listTurnContextsForSession('gone')).toEqual([]);
    expect(db.$client.prepare('SELECT count(*) AS n FROM turn_context_parts').get()).toEqual({
      n: 0,
    });
    // Not one byte of the memory survives anywhere in the body table.
    expect(bodies(db).some((row) => row.body.includes('oat milk'))).toBe(false);
    expect(bodies(db)).toEqual([]);
  });

  it('keeps a shared body while another session still uses it, then deletes it with the last one', () => {
    const db = createTestDb();
    const store = new TurnContextStore(db);
    store.record(turn('a', 'from a'));
    store.record(turn('b', 'from b'));

    store.deleteForSessions(['a']);
    expect(bodies(db).map((row) => row.body)).toEqual(expect.arrayContaining([APPEND, 'from b']));
    expect(bodies(db).some((row) => row.body === 'from a')).toBe(false);

    store.deleteForSessions(['b']);
    expect(bodies(db)).toEqual([]);
  });

  it('drops text past 30 days but keeps hashes, sizes and token counts', () => {
    const db = createTestDb();
    let now = new Date('2026-11-01T00:00:00Z');
    const store = new TurnContextStore(db, { now: () => now });
    store.record(turn('s1', 'old words'));

    now = new Date('2026-12-05T00:00:00Z');
    expect(store.sweepExpired()).toBe(2);

    expect(bodies(db)).toEqual([]);
    const [record] = store.listTurnContextsForSession('s1');
    expect(record!.parts.map((p) => p.body)).toEqual([null, null]);
    expect(record!.parts[1]).toMatchObject({ bytes: 9, tokensEstimate: 3 });
    expect(record!.parts[1]!.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps text a recent turn still uses, but never shows it on the old turn', () => {
    const db = createTestDb();
    let now = new Date('2026-11-01T00:00:00Z');
    const store = new TurnContextStore(db, { now: () => now });
    store.record(turn('s1', 'old words'));
    now = new Date('2026-12-05T00:00:00Z');
    store.record(turn('s1', 'new words'));

    store.sweepExpired();

    expect(
      bodies(db)
        .map((row) => row.body)
        .sort()
    ).toEqual([APPEND, 'new words'].sort());
    const [oldTurn, newTurn] = store.listTurnContextsForSession('s1');
    expect(oldTurn!.parts[0]!.body).toBeNull();
    expect(newTurn!.parts[0]!.body).toBe(APPEND);
  });

  it('moves a session’s records to its canonical id', () => {
    const store = new TurnContextStore(createTestDb());
    store.record(turn('request-uuid', 'hi'));
    store.rekeySession('request-uuid', 'canonical');
    expect(store.listTurnContextsForSession('request-uuid')).toEqual([]);
    expect(store.listTurnContextsForSession('canonical')).toHaveLength(1);
  });

  it('sweeps known secret values and secret shapes before storing, and says so', () => {
    const db = createTestDb();
    const liveKey = 'made-up-live-key-0123456789abcdef';
    const store = new TurnContextStore(db, { knownSecrets: () => [liveKey] });
    store.record(turn('s1', `use ${liveKey} please`));

    const [record] = store.listTurnContextsForSession('s1');
    expect(record!.parts[1]!.body).toBe('use [redacted] please');
    expect(record!.parts[1]!.redacted).toBe(true);
    expect(record!.parts[0]!.redacted).toBe(false);
    expect(bodies(db).some((row) => row.body.includes(liveKey))).toBe(false);
  });
});
