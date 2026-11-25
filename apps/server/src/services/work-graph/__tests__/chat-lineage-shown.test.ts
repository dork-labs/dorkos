/**
 * What the lineage query shows of each started chat (W3, DOR-4969): the run
 * record answers first, a chat still launching is shown with its state and
 * title, a chat with a shown child is shown, every chat hangs under the one
 * parent the records name, and one read stops at {@link LINEAGE_MAX_CHATS}.
 * Over the real SQLite stores (`./lineage-fixture.ts`).
 */
import { describe, expect, it } from 'vitest';
import { getWorkLinkStore, LINEAGE_MAX_CHATS, LINEAGE_MAX_DEPTH } from '../index.js';
import { ran, reader, start, stores, tick, tree, up, useLineageStores } from './lineage-fixture.js';

useLineageStores();

/** A run of `chatId` the turn port saved and has not handed over. */
const queuedRun = (chatId: string) =>
  stores.runs.create({ chatKey: chatId, status: 'queued', openedBy: 'caller', origin: null });

describe('a child still launching', () => {
  it('is shown with its run’s state and the title its starter gave it', () => {
    const claimed = stores.service.reserve({
      sessionId: 'launching',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: 'root',
      originExtensionId: null,
      reason: null,
      title: 'Fix the login page',
    });
    expect(claimed.ok).toBe(true);
    ran('root');
    const run = queuedRun('launching');
    let lineage = reader().read('root');
    expect(tree(lineage)).toEqual(['1:launching<-root(started)~']);
    expect(lineage?.descendants[0]?.state).toEqual({
      kind: 'launching',
      runId: run.id,
      status: 'queued',
      title: 'Fix the login page',
    });
    stores.runs.move(run, 'starting');
    lineage = reader().read('root');
    expect(lineage?.descendants[0]?.state).toMatchObject({ kind: 'launching', status: 'starting' });
  });

  it('is shown as a chat once a run of it started, with no binding on this computer', () => {
    start('root', 'elsewhere');
    ran('root');
    // A run that started, as a chat on another computer leaves it: no session_metadata row.
    stores.runs.create({
      chatKey: 'elsewhere',
      status: 'running',
      openedBy: 'runtime',
      origin: null,
    });
    expect(reader().read('root')?.descendants[0]?.state).toEqual({ kind: 'chat' });
  });
});

describe('a middle chat the join cannot place', () => {
  it('is shown, with its live grandchild, when unbound or cancelled', () => {
    start('root', 'unbound-mid');
    start('unbound-mid', 'leaf-a');
    const cancelledMid = start('root', 'cancelled-mid');
    start('cancelled-mid', 'leaf-b');
    const run = queuedRun('cancelled-mid');
    stores.runs.move(run, 'cancelled', { endedAt: stores.runs.stamp() });
    cancelledMid.cancel();
    ran('root', 'leaf-a', 'leaf-b');
    const lineage = reader().read('root');
    expect(tree(lineage)).toEqual([
      '1:unbound-mid<-root(started)',
      '2:leaf-a<-unbound-mid(started)',
      '1:cancelled-mid<-root(started)',
      '2:leaf-b<-cancelled-mid(started)',
    ]);
    // Promoted, each comes back with a state a reader can put into words.
    for (const mid of ['unbound-mid', 'cancelled-mid'])
      expect(lineage?.descendants.find((d) => d.chatId === mid)?.state).toEqual({ kind: 'chat' });
    // Walking up, a parent goes through the join: one with a run is shown as a chat...
    expect(up(reader().read('leaf-b'))).toEqual(['1:cancelled-mid(started)', '2:root(started)']);
    // ...and one with neither a binding nor any run ends the walk, unshown.
    expect(up(reader().read('leaf-a'))).toEqual([]);
  });
});

describe('a parent a stray record names', () => {
  it('is not shown, and ends the walk up, when it has neither a chat nor any run', () => {
    start('root', 'child');
    // A row naming a parent that never ran, as a stray write would leave.
    stores.starts.insert({
      sessionId: 'orphan',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: 'ghost',
      originExtensionId: null,
      reason: null,
      createdAt: tick(),
    });
    ran('root', 'child', 'orphan');
    expect(up(reader().read('orphan'))).toEqual([]);
    expect(up(reader().read('child'))).toEqual(['1:root(started)']);
  });
});

describe('a chat two records name different parents for', () => {
  it('hangs under the parent its session_started_by row names, walking down and up', () => {
    start('row-parent', 'child');
    // A stray link from another chat, written after the row.
    getWorkLinkStore()!.record({
      from: { kind: 'chat', id: 'link-parent' },
      relation: 'started',
      to: { kind: 'chat', id: 'child' },
      source: 'server',
    });
    ran('row-parent', 'link-parent', 'child');
    expect(tree(reader().read('link-parent'))).toEqual([]);
    expect(tree(reader().read('row-parent'))).toEqual(['1:child<-row-parent(started)']);
    expect(up(reader().read('child'))).toEqual(['1:row-parent(started)']);
  });
});

/** `count` chats `parent` started, one second apart, named `<prefix>-0000` on. */
function startMany(parent: string, prefix: string, count: number): string[] {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
  for (const sessionId of ids) {
    stores.starts.insert({
      sessionId,
      kind: 'chat',
      extensionId: null,
      startedBySessionId: parent,
      originExtensionId: null,
      reason: null,
      createdAt: tick(),
    });
  }
  return ids;
}

describe('the cap on one read', () => {
  it(`holds at most ${LINEAGE_MAX_CHATS} shown chats, oldest first, and says it stopped`, () => {
    const ids = startMany('root', 'wide', LINEAGE_MAX_CHATS + 1);
    ran('root', ...ids);
    const lineage = reader().read('root');
    expect(lineage?.truncated).toBe(true);
    expect(lineage?.descendants.map((d) => d.chatId)).toEqual(ids.slice(0, LINEAGE_MAX_CHATS));
  });

  it('gives no place to a chat that is left out', () => {
    // Older starts that never ran, then a full answer's worth that did.
    startMany('root', 'never', 300);
    const shown = startMany('root', 'shown', LINEAGE_MAX_CHATS);
    ran('root', ...shown);
    const lineage = reader().read('root');
    expect(lineage?.descendants.map((d) => d.chatId)).toEqual(shown);
    expect(lineage?.truncated).toBe(false);
  });

  it('keeps the shallowest levels first when the cap falls inside a deeper one', () => {
    const top = startMany('root', 'top', LINEAGE_MAX_CHATS - 1);
    const deep = startMany(top[0]!, 'deep', 2);
    ran('root', ...top, ...deep);
    const lineage = reader().read('root');
    expect(lineage?.truncated).toBe(true);
    const kept = lineage?.descendants.map((d) => d.chatId) ?? [];
    expect(kept).toHaveLength(LINEAGE_MAX_CHATS);
    expect(new Set(kept)).toEqual(new Set([...top, deep[0]]));
  });
});

describe('truncated', () => {
  /** A chain of `length` chats, each started by the one before, that all ran. */
  function chain(length: number): string[] {
    const ids = ['chain-0000'];
    while (ids.length < length) ids.push(...startMany(ids.at(-1)!, `chain-${ids.length}`, 1));
    ran(...ids);
    return ids;
  }

  it(`is true when the ${LINEAGE_MAX_DEPTH}-level stop leaves chats out`, () => {
    const ids = chain(LINEAGE_MAX_DEPTH + 2);
    const capped = reader().read(ids[0]!);
    expect(capped?.descendants).toHaveLength(LINEAGE_MAX_DEPTH);
    expect(capped?.truncated).toBe(true);
    // One level down, the rest of the chain fits exactly.
    const whole = reader().read(ids[1]!);
    expect(whole?.descendants).toHaveLength(LINEAGE_MAX_DEPTH);
    expect(whole?.truncated).toBe(false);
  });

  it('stays false when the walk stops at the depth the caller asked for', () => {
    const ids = chain(4);
    const lineage = reader().read(ids[0]!, { depth: 1 });
    expect(lineage?.descendants.map((d) => d.chatId)).toEqual([ids[1]]);
    expect(lineage?.truncated).toBe(false);
  });
});
