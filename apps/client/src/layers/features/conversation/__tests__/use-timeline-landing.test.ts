// @vitest-environment jsdom
/**
 * The landing's report of "caught up at the bottom" reaches the host on arrival.
 *
 * The bug this guards: the de-duplication of top-row reports started from
 * `undefined`, which is itself the "caught up" report, so the first such report
 * after arriving was swallowed. After a landing that could not find the
 * remembered row (`end-row-gone`) the reader sat at the bottom, the host never
 * heard it, and the stale remembered row survived to the next visit.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { useTimelineLanding } from '../model/use-timeline-landing';
import type { ConversationRow } from '../lib/row-kinds';

function messageRow(id: string): ConversationRow {
  return {
    kind: 'message',
    id,
    payload: { text: id },
    grouping: { position: 'only' },
    author: { kind: 'human', id: 'author-me', displayName: 'Dorian' },
    at: '2026-08-18T10:00:00.000Z',
  };
}

const ROWS = [messageRow('e0'), messageRow('e1'), messageRow('e2')];

/** A virtualizer stand-in: the landing only scrolls it and reads its items. */
function fakeVirtualizer() {
  return {
    getVirtualItems: () =>
      ROWS.map((_, index) => ({ index, start: index * 80, end: index * 80 + 80 })),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
  } as unknown as Virtualizer<HTMLDivElement, Element>;
}

function land(resumeRow: () => string | undefined) {
  const onTopRow = vi.fn<(rowId: string | undefined) => void>();
  const virtualizer = fakeVirtualizer();
  const hook = renderHook(() =>
    useTimelineLanding({
      conversationId: 'room-1',
      rows: ROWS,
      virtualizer,
      landOn: 'end',
      landingReady: true,
      resumeRow,
      onTopRow,
    })
  );
  return { hook, onTopRow };
}

describe('useTimelineLanding — the first report after arriving', () => {
  // Purpose: after an `end-row-gone` landing, the reader at the bottom is reported as
  // caught up, so the host can forget the stale row. Fails if the first `undefined`
  // report is de-duplicated away.
  it('tells the host the reader is caught up after a remembered row was not found', () => {
    const { hook, onTopRow } = land(() => 'row-not-loaded');
    expect(hook.result.current.landedOn).toBe('end-row-gone');
    hook.result.current.reportTopRow(null, true);
    expect(onTopRow).toHaveBeenCalledTimes(1);
    expect(onTopRow).toHaveBeenCalledWith(undefined);
  });

  // Purpose: the de-duplication still holds after that first report — a reader
  // resting at the bottom is reported once, not on every settle.
  it('reports "caught up" once, not on every repeat', () => {
    const { hook, onTopRow } = land(() => undefined);
    expect(hook.result.current.landedOn).toBe('end');
    hook.result.current.reportTopRow(null, true);
    hook.result.current.reportTopRow(null, true);
    expect(onTopRow.mock.calls).toEqual([[undefined]]);
  });
});
