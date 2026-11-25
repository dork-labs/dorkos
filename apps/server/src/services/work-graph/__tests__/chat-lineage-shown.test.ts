/**
 * What the lineage query shows of each started chat (W3, DOR-4969): the run
 * record answers first, a chat still launching is shown with its state and
 * title, a chat with a shown child is shown, every chat hangs under the one
 * parent the records name, and one read stops at {@link LINEAGE_MAX_CHATS}.
 * Over the real SQLite stores (`./lineage-fixture.ts`).
 */
import { describe, expect, it } from 'vitest';
import { getWorkLinkStore, LINEAGE_MAX_CHATS } from '../index.js';
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
    expect(up(reader().read('leaf-a'))).toEqual(['1:unbound-mid(started)', '2:root(started)']);
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

describe('the cap on one read', () => {
  it(`visits at most ${LINEAGE_MAX_CHATS} chats, oldest first, and says it stopped`, () => {
    const ids = Array.from(
      { length: LINEAGE_MAX_CHATS + 1 },
      (_, i) => `wide-${String(i).padStart(4, '0')}`
    );
    for (const sessionId of ids) {
      stores.starts.insert({
        sessionId,
        kind: 'chat',
        extensionId: null,
        startedBySessionId: 'root',
        originExtensionId: null,
        reason: null,
        createdAt: tick(),
      });
    }
    ran('root', ...ids);
    const lineage = reader().read('root');
    expect(lineage?.truncated).toBe(true);
    expect(lineage?.descendants.map((d) => d.chatId)).toEqual(ids.slice(0, LINEAGE_MAX_CHATS));
  });
});
