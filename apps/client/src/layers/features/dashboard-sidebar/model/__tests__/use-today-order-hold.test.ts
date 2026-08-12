// @vitest-environment jsdom
/**
 * A reorder the operator's own send earned is still deferred while they are
 * inside the zone (BC-17, and its interaction with DOR-1156).
 *
 * BC-17's rule is "rows never move under a cursor that is about to click them",
 * and it is written to defer EVERY reorder — including the legitimate ones. The
 * send is now a producer of legitimate reorders, so this is the case the
 * deferral exists for and the one nobody had driven: your own message moving the
 * row you are hovering.
 *
 * The hold is deliberately blind to WHY the order changed — it compares row keys
 * against the order it froze — so nothing send-specific was added to it. This
 * file is the proof of that, not a request for it.
 *
 * @module features/dashboard-sidebar/model/__tests__/use-today-order-hold
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SidebarRowModel } from '../build-sidebar-model';
import { useTodayOrderHold } from '../holds/use-today-order-hold';

/** A Today row, reduced to what the hold reads. */
function row(key: string): SidebarRowModel {
  return {
    key,
    target: { kind: 'session', sessionId: key.split(':')[1] ?? key, agentPath: '/a', cwd: '/a' },
    glyph: { kind: 'icon', icon: 'session' },
    primary: key,
    status: 'idle',
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    actions: ['open'],
    reason: 'today:interaction-recency',
  } as SidebarRowModel;
}

const A = row('session:a');
const B = row('session:b');
const C = row('session:c');

describe('a send-driven reorder under a hovering pointer', () => {
  it('is withheld while the pointer is inside, and applied when it leaves', () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: SidebarRowModel[] }) => useTodayOrderHold(rows, null),
      { initialProps: { rows: [A, B, C] } }
    );
    expect(result.current.rows.map((entry) => entry.key)).toEqual([
      'session:a',
      'session:b',
      'session:c',
    ]);

    // The pointer lands on Today — over the second row, say.
    act(() => result.current.handlers.onPointerEnter());

    // The operator sends a message into `c` from the composer. The model
    // re-orders honestly: `c` is now the most recently written-in.
    rerender({ rows: [C, A, B] });

    // …and the panel does not move. The row under the pointer is still the row
    // under the pointer.
    expect(result.current.rows.map((entry) => entry.key)).toEqual([
      'session:a',
      'session:b',
      'session:c',
    ]);

    act(() => result.current.handlers.onPointerLeave());

    expect(result.current.rows.map((entry) => entry.key)).toEqual([
      'session:c',
      'session:a',
      'session:b',
    ]);
  });

  it('draws a row the send has just created, rather than withholding it', () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: SidebarRowModel[] }) => useTodayOrderHold(rows, null),
      { initialProps: { rows: [A, B] } }
    );
    act(() => result.current.handlers.onPointerEnter());

    // Writing in a conversation Today has never held gives it a row for the
    // first time. Withholding THAT would look like the send did nothing, so it
    // is appended rather than deferred — the hold is about order, not presence.
    rerender({ rows: [C, A, B] });

    expect(result.current.rows.map((entry) => entry.key)).toEqual([
      'session:a',
      'session:b',
      'session:c',
    ]);
  });

  it('does not defer when nobody is in the zone', () => {
    const { result, rerender } = renderHook(
      ({ rows }: { rows: SidebarRowModel[] }) => useTodayOrderHold(rows, null),
      { initialProps: { rows: [A, B, C] } }
    );

    // The paired half. Without it, "the order held" would also be true of a
    // hook that never reorders at all.
    rerender({ rows: [C, A, B] });

    expect(result.current.rows.map((entry) => entry.key)).toEqual([
      'session:c',
      'session:a',
      'session:b',
    ]);
  });

  it('releases the hold when the operator switches conversations', () => {
    const { result, rerender } = renderHook(
      ({ rows, anchor }: { rows: SidebarRowModel[]; anchor: string | null }) =>
        useTodayOrderHold(rows, anchor),
      { initialProps: { rows: [A, B, C], anchor: 'session:a' } }
    );
    act(() => result.current.handlers.onPointerEnter());

    // A switch IS an order the operator asked for (BC-21), so the frozen order
    // is dropped and the new one is what the next frame freezes — even though
    // the pointer never left.
    rerender({ rows: [C, A, B], anchor: 'session:c' });

    expect(result.current.rows.map((entry) => entry.key)).toEqual([
      'session:c',
      'session:a',
      'session:b',
    ]);
  });
});
