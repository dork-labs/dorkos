import { describe, expect, it } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { foldNoticeRuns } from '../lib/notice-fold';

function entry(seq: number, kind: 'post' | 'notice', notice?: RoomEntry['body']['notice']) {
  return {
    roomId: 'room-1',
    seq,
    id: `e${seq}`,
    authorId: 'a',
    kind,
    body: { text: `t${seq}`, ...(notice && { notice }) },
    mentions: [],
    sessionId: null,
    cascadeRoot: `e${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  } as RoomEntry;
}

const ids = (entries: RoomEntry[]) => entries.map((e) => e.id);

describe('foldNoticeRuns', () => {
  it('leaves a room with no run of three alone', () => {
    const entries = [entry(1, 'post'), entry(2, 'notice'), entry(3, 'notice'), entry(4, 'post')];
    const out = foldNoticeRuns(entries, new Set());
    expect(ids(out.visible)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(out.foldBefore.size).toBe(0);
  });

  it('folds a run of three to its latest, with the button in its place', () => {
    const entries = [entry(1, 'notice'), entry(2, 'notice'), entry(3, 'notice'), entry(4, 'post')];
    const out = foldNoticeRuns(entries, new Set());
    expect(ids(out.visible)).toEqual(['e3', 'e4']);
    expect(out.foldBefore.get('e3')).toEqual({ runId: 'e1', count: 2, expanded: false });
  });

  it('opens a run in place, with the button at its top', () => {
    const entries = [entry(1, 'notice'), entry(2, 'notice'), entry(3, 'notice')];
    const out = foldNoticeRuns(entries, new Set(['e1']));
    expect(ids(out.visible)).toEqual(['e1', 'e2', 'e3']);
    expect(out.foldBefore.get('e1')).toEqual({ runId: 'e1', count: 2, expanded: true });
  });

  it('keeps every warm notice, and folds nothing when only warm ones would go', () => {
    const mixed = [
      entry(1, 'notice'),
      entry(2, 'notice', 'turn_failed'),
      entry(3, 'notice'),
      entry(4, 'notice'),
    ];
    const out = foldNoticeRuns(mixed, new Set());
    expect(ids(out.visible)).toEqual(['e2', 'e4']);
    expect(out.foldBefore.get('e2')?.count).toBe(2);

    const allWarm = [
      entry(1, 'notice', 'turn_failed'),
      entry(2, 'notice', 'agent_gone'),
      entry(3, 'notice'),
    ];
    const kept = foldNoticeRuns(allWarm, new Set());
    expect(ids(kept.visible)).toEqual(['e1', 'e2', 'e3']);
    expect(kept.foldBefore.size).toBe(0);
  });
});
