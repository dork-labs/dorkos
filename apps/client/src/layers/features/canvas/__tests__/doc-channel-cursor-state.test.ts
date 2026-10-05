import { describe, expect, it } from 'vitest';
import type { CanvasChannelFrame } from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelCursor } from '../model/doc-channel-cursor-state';

function frame(seq: number): CanvasChannelFrame {
  return {
    type: 'canvas_event',
    scope: 'session:cursor-fixture',
    documentId: 'doc-cursor',
    docSeq: seq,
    event: {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      type: 'app.updated',
      payload: { count: seq },
      direction: 'downstream',
      receivedAt: '2026-10-01T00:00:00.000Z',
    },
  };
}

describe('inert bounded document cursor', () => {
  it('retains200 payloads but201 eviction preserves the target', () => {
    const cursor = new DocChannelCursor();
    for (let seq = 3; seq <= 202; seq++) expect(cursor.recordGap(frame(seq))).toBe(false);
    expect(cursor.pendingCount).toBe(200);
    expect(cursor.catchUpThrough).toBe(202);
    expect(cursor.recordGap(frame(203))).toBe(true);
    expect(cursor.pendingCount).toBe(0);
    expect(cursor.catchUpThrough).toBe(203);
    cursor.advance(202);
    expect(cursor.clearReachedTarget()).toBe(false);
    cursor.advance(203);
    expect(cursor.clearReachedTarget()).toBe(true);
    expect(cursor.catchUpThrough).toBe(0);
  });
  it('returns only the next frame and never advances on extraction or a gap', () => {
    const cursor = new DocChannelCursor(),
      one = frame(1),
      two = frame(2);
    cursor.recordGap(two);
    expect(cursor.takeNextContiguous()).toBeUndefined();
    cursor.recordGap(one);
    expect(cursor.takeNextContiguous()).toBe(one);
    expect(cursor.highest).toBe(0);
    // The caller may retire here instead of advancing; no second frame is batched.
    expect(cursor.takeNextContiguous()).toBeUndefined();
    cursor.advance(1);
    expect(cursor.takeNextContiguous()).toBe(two);
    expect(cursor.highest).toBe(1);
  });
  it('discards old duplicates and preserves independent quarantine on highest-only reset', () => {
    const cursor = new DocChannelCursor(),
      two = frame(2);
    cursor.advance(10);
    cursor.recordGap(frame(1));
    expect(cursor.takeNextContiguous()).toBeUndefined();
    expect(cursor.pendingCount).toBe(0);
    cursor.recordGap(two);
    cursor.markThrough(50);
    cursor.resetHighest();
    expect(cursor.highest).toBe(0);
    expect(cursor.pendingCount).toBe(1);
    expect(cursor.catchUpThrough).toBe(50);
    cursor.reset();
    expect(cursor.pendingCount).toBe(0);
    expect(cursor.catchUpThrough).toBe(0);
    expect(cursor.highest).toBe(0);
  });
  it('does not regress progress on stale floor or no-progress page', () => {
    const cursor = new DocChannelCursor();
    cursor.advance(100);
    cursor.advance(20);
    expect(cursor.highest).toBe(100);
    cursor.markThrough(300);
    expect(cursor.clearReachedTarget()).toBe(false);
    expect(cursor.highest).toBe(100);
    expect(cursor.catchUpThrough).toBe(300);
  });
});
