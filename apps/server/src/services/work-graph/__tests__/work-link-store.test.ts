/**
 * The work graph's edge store (DOR-4968): every entity reference kind goes in
 * and comes back out, nothing is ever changed, and an old chat id resolves to
 * the current one through `rekeyed_from` edges.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { workLinks, type Db } from '@dorkos/db';
import {
  ENTITY_KINDS,
  entityRef,
  type EntityKind,
  type EntityRef,
} from '@dorkos/shared/entity-ref';
import { decodeWorkLinkRef, encodeWorkLinkRef } from '../work-link-ref.js';
import { REKEY_MAX_DEPTH, WorkLinkStore } from '../work-link-store.js';

/** One valid id per kind, in the spelling each kind is stored in. */
const SAMPLE_IDS: Record<EntityKind, string> = {
  space: 'space-acme',
  person: 'person-1',
  agent: '01KJ5Z8Y3M2N4P6Q8R0S2T4V6W',
  host: 'host-1',
  room: '01KJ5Z8Y3M2N4P6Q8R0S2T4V6X',
  entry: '01KJ5Z8Y3M2N4P6Q8R0S2T4V6Y',
  chat: '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f',
  turn: 'turn_7',
  todo: '01KJ5Z8Y3M2N4P6Q8R0S2T4V6Z',
  run: '01KJ5Z8Y3M2N4P6Q8R0S2T4V70',
  pr: 'dork-labs/dorkos#4242',
  ticket: 'DOR-4968',
  branch: 'feat/dor-4968-work-links',
  worktree: 'dor-4968-work-links',
};

function ref(kind: EntityKind, id = SAMPLE_IDS[kind]): EntityRef {
  const built = entityRef(kind, id);
  if (!built.ok) throw new Error(`bad sample ${kind}: ${built.reason}`);
  return built.value;
}

const chat = (id: string): EntityRef => ref('chat', id);

let db: Db;
let now: number;
let store: WorkLinkStore;

beforeEach(() => {
  db = createTestDb();
  now = Date.parse('2026-11-24T12:00:00Z');
  store = new WorkLinkStore({ db, now: () => now });
});

describe('the stored spelling of a reference', () => {
  it.each(ENTITY_KINDS.map((kind) => [kind]))('round-trips a %s', (kind) => {
    const stored = encodeWorkLinkRef(ref(kind));
    expect(stored).not.toBeNull();
    expect(decodeWorkLinkRef(stored!)).toEqual({ kind, id: SAMPLE_IDS[kind] });
  });

  it('writes the canonical spellings', () => {
    expect(encodeWorkLinkRef(ref('chat'))).toBe(`dork:chat:${SAMPLE_IDS.chat}`);
    expect(encodeWorkLinkRef(ref('pr'))).toBe('dork-labs/dorkos#4242');
    expect(encodeWorkLinkRef(ref('pr', '#42'))).toBe('PR #42');
    expect(encodeWorkLinkRef(ref('ticket'))).toBe('DOR-4968');
    expect(encodeWorkLinkRef(ref('branch'))).toBe('branch:feat/dor-4968-work-links');
    expect(encodeWorkLinkRef(ref('worktree'))).toBe('worktree:dor-4968-work-links');
  });

  it('folds a pull request to one spelling and drops display hints', () => {
    expect(
      encodeWorkLinkRef({ kind: 'pr', id: 'Dork-Labs/DorkOS#7', label: 'x', url: '/r/x' })
    ).toBe('dork-labs/dorkos#7');
  });

  it('refuses what is not a reference, and any non-canonical stored text', () => {
    expect(encodeWorkLinkRef({ kind: 'worktree', id: '../secret' })).toBeNull();
    expect(encodeWorkLinkRef({ kind: 'chat', id: 'has space' })).toBeNull();
    expect(decodeWorkLinkRef('Dork-Labs/DorkOS#7')).toBeNull();
    expect(decodeWorkLinkRef(`/session?session=${SAMPLE_IDS.chat}`)).toBeNull();
    expect(decodeWorkLinkRef('worktree:a/b')).toBeNull();
    expect(decodeWorkLinkRef('branch:')).toBeNull();
  });
});

describe('WorkLinkStore', () => {
  it('records and reads back an edge for every kind, from either end', () => {
    const subject = chat('chat-a');
    for (const kind of ENTITY_KINDS) {
      const result = store.record({
        from: subject,
        relation: 'works_on',
        to: ref(kind),
        source: 'server',
      });
      expect(result).toMatchObject({ ok: true, created: true });
    }
    expect(store.from(subject).map((link) => link.to)).toEqual(
      ENTITY_KINDS.map((kind) => ({ kind, id: SAMPLE_IDS[kind] }))
    );
    for (const kind of ENTITY_KINDS) {
      expect(store.to(ref(kind), 'works_on')).toEqual([
        expect.objectContaining({ from: { kind: 'chat', id: 'chat-a' }, relation: 'works_on' }),
      ]);
    }
  });

  it('keeps when, who and what wrote it', () => {
    const result = store.record({
      from: chat('chat-a'),
      relation: 'opened',
      to: ref('pr'),
      source: 'open-pr',
      recordingChatId: 'chat-a',
    });
    expect(result.ok && result.link).toMatchObject({
      recordedAt: '2026-11-24T12:00:00.000Z',
      recordingChatId: 'chat-a',
      source: 'open-pr',
    });
  });

  it('filters by relation', () => {
    store.record({ from: chat('chat-a'), relation: 'opened', to: ref('pr'), source: 'server' });
    store.record({ from: chat('chat-a'), relation: 'claims', to: ref('ticket'), source: 'server' });
    expect(store.from(chat('chat-a'), 'claims').map((link) => link.to)).toEqual([
      { kind: 'ticket', id: 'DOR-4968' },
    ]);
  });

  it('records an exact repeat once and hands back the first edge', () => {
    const first = store.record({
      from: chat('chat-a'),
      relation: 'opened',
      to: ref('pr'),
      source: 'server',
    });
    now += 60_000;
    const again = store.record({
      from: chat('chat-a'),
      relation: 'opened',
      to: ref('pr'),
      source: 'flow',
    });
    expect(again).toEqual({ ok: true, created: false, link: first.ok && first.link });
    expect(db.select().from(workLinks).all()).toHaveLength(1);
  });

  it('has no way to change or remove an edge', () => {
    const methods = Object.getOwnPropertyNames(WorkLinkStore.prototype).sort();
    expect(methods).toEqual([
      'constructor',
      'firstRekeyFrom',
      'from',
      'list',
      'record',
      'resolveRekey',
      'to',
    ]);
  });

  it.each([
    [{ from: { kind: 'chat', id: '' } }, 'bad-from'],
    [{ to: { kind: 'worktree', id: '/Users/someone/wt' } }, 'bad-to'],
    [{ relation: 'mentions' }, 'bad-relation'],
    [{ relation: 'rekeyed_from', to: { kind: 'pr', id: '#4' } }, 'bad-kinds'],
    [{ to: { kind: 'chat', id: 'chat-a' } }, 'self-link'],
    [{ source: 'Open PR' }, 'bad-source'],
    [{ recordingChatId: 'not an id' }, 'bad-recording-chat'],
  ] as const)('refuses %o as %s', (overrides, reason) => {
    const input = {
      from: chat('chat-a'),
      relation: 'forked_from' as const,
      to: chat('chat-b'),
      source: 'server',
      ...overrides,
    } as Parameters<WorkLinkStore['record']>[0];
    expect(store.record(input)).toEqual({ ok: false, reason });
    expect(db.select().from(workLinks).all()).toEqual([]);
  });

  describe('resolveRekey', () => {
    const rekey = (from: string, to: string) =>
      store.record({ from: chat(to), relation: 'rekeyed_from', to: chat(from), source: 'server' });

    it('follows a chain of two to the newest id', () => {
      rekey('request-id', 'sdk-id');
      now += 1000;
      rekey('sdk-id', 'resumed-id');
      expect(store.resolveRekey('request-id')).toBe('resumed-id');
      expect(store.resolveRekey('sdk-id')).toBe('resumed-id');
      expect(store.resolveRekey('resumed-id')).toBe('resumed-id');
    });

    it('can be resolved after a restart: a new store over the same database finds the old id', () => {
      rekey('request-id', 'sdk-id');
      expect(new WorkLinkStore({ db }).resolveRekey('request-id')).toBe('sdk-id');
    });

    it('stops at a cycle at the last id before one repeats', () => {
      // Two ids, so a walk that ignored the cycle and ran to the depth limit
      // (an even number of steps) would land back on the id it started from.
      rekey('a', 'b');
      rekey('b', 'a');
      expect(store.resolveRekey('a')).toBe('b');
      expect(store.resolveRekey('b')).toBe('a');
    });

    it('stops after the depth limit', () => {
      for (let step = 0; step < REKEY_MAX_DEPTH + 5; step += 1)
        rekey(`id-${step}`, `id-${step + 1}`);
      expect(store.resolveRekey('id-0')).toBe(`id-${REKEY_MAX_DEPTH}`);
    });

    it('refuses a second re-key of one id, and still resolves to the first', () => {
      expect(rekey('a', 'b')).toMatchObject({ ok: true, created: true });
      now += 1000;
      expect(rekey('a', 'c')).toEqual({ ok: false, reason: 'already-rekeyed' });
      expect(rekey('a', 'b')).toMatchObject({ ok: true, created: false });
      expect(db.select().from(workLinks).all()).toHaveLength(1);
      expect(store.resolveRekey('a')).toBe('b');
    });

    it('takes the oldest edge out of an id that has two, from before the refusal', () => {
      rekey('a', 'b');
      // A second edge written straight to the table, as a row from before
      // `record` refused one would be.
      db.insert(workLinks)
        .values({
          id: '01KJ5Z8Y3M2N4P6Q8R0S2T4V7Z',
          fromRef: encodeWorkLinkRef(chat('c'))!,
          toRef: encodeWorkLinkRef(chat('a'))!,
          relation: 'rekeyed_from',
          recordedAt: new Date(now + 1000).toISOString(),
          recordingChatId: null,
          source: 'server',
        })
        .run();
      expect(store.resolveRekey('a')).toBe('b');
    });

    it('hands back an unknown or malformed id unchanged', () => {
      expect(store.resolveRekey('never-seen')).toBe('never-seen');
      expect(store.resolveRekey('not an id')).toBe('not an id');
    });

    it('does not follow a fork', () => {
      store.record({
        from: chat('fork'),
        relation: 'forked_from',
        to: chat('source'),
        source: 'server',
      });
      expect(store.resolveRekey('source')).toBe('source');
    });
  });
});
