/**
 * The hold that lets an approved schedule finish saying it was approved.
 *
 * The registry half, in isolation. The card half — that pressing Approve
 * actually engages this, and that the card survives the refetch — is proven
 * against the real component in `ScheduleApprovalCard.test.tsx`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Task } from '@dorkos/shared/types';
import { APPROVAL_SETTLE_MS, discardSettlingSchedules, useScheduleApprovalCards } from '../index';
// The two writers stay off the barrel: only the card ever holds or releases a
// schedule, and a surface that could reach them from the public API could pin a
// card nobody decided.
import { holdApprovedSchedule, releaseSettledSchedule } from '../model/settling-approvals';

/** A parked schedule, only the fields this file reads. */
function proposal(id: string): Task {
  return { id, name: id, displayName: id } as Task;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  discardSettlingSchedules();
  vi.useRealTimers();
});

describe('the approval settle hold', () => {
  it('keeps an approved schedule listed after the server drops it', () => {
    const { result, rerender } = renderHook(
      ({ schedules }: { schedules: readonly Task[] }) => useScheduleApprovalCards(schedules),
      { initialProps: { schedules: [proposal('task-1')] as readonly Task[] } }
    );

    act(() => holdApprovedSchedule(proposal('task-1')));
    // The refetch: the server no longer calls it parked.
    rerender({ schedules: [] });

    expect(result.current.map((task) => task.id)).toEqual(['task-1']);
  });

  it('lets go once the receipt has had its time', () => {
    const { result, rerender } = renderHook(
      ({ schedules }: { schedules: readonly Task[] }) => useScheduleApprovalCards(schedules),
      { initialProps: { schedules: [] as readonly Task[] } }
    );

    act(() => holdApprovedSchedule(proposal('task-1')));
    rerender({ schedules: [] });
    expect(result.current).toHaveLength(1);

    // A hold that never released would pin a decided card to every surface
    // that draws proposals, forever.
    act(() => {
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS);
    });
    expect(result.current).toHaveLength(0);
  });

  it('never draws a schedule twice while the server still lists it', () => {
    // The window between pressing Approve and the refetch landing: the task is
    // in BOTH lists. Concatenating blindly would draw two cards for one
    // schedule, with two sets of buttons.
    const { result } = renderHook(() => useScheduleApprovalCards([proposal('task-1')]));

    act(() => holdApprovedSchedule(proposal('task-1')));

    expect(result.current).toHaveLength(1);
  });

  it('prefers the server’s copy of a schedule it still lists', () => {
    // The held copy is a snapshot from the moment Approve was pressed. While
    // the server still has an opinion, the server's row is the fresher one.
    const fromServer = { ...proposal('task-1'), displayName: 'Renamed since' } as Task;
    const { result } = renderHook(() => useScheduleApprovalCards([fromServer]));

    act(() => holdApprovedSchedule(proposal('task-1')));

    expect(result.current[0]?.displayName).toBe('Renamed since');
  });

  it('releases a hold whose approval was refused', () => {
    const { result, rerender } = renderHook(
      ({ schedules }: { schedules: readonly Task[] }) => useScheduleApprovalCards(schedules),
      { initialProps: { schedules: [] as readonly Task[] } }
    );

    act(() => holdApprovedSchedule(proposal('task-1')));
    expect(result.current).toHaveLength(1);

    // The server said no. The card goes back to the live list, and a stale hold
    // would draw it a second time from ours.
    act(() => releaseSettledSchedule('task-1'));
    rerender({ schedules: [] });

    expect(result.current).toHaveLength(0);
  });

  it('holds two approvals apart', () => {
    const { result } = renderHook(() => useScheduleApprovalCards([]));

    act(() => holdApprovedSchedule(proposal('task-1')));
    act(() => holdApprovedSchedule(proposal('task-2')));
    act(() => releaseSettledSchedule('task-1'));

    expect(result.current.map((task) => task.id)).toEqual(['task-2']);
  });

  it('gives a re-approved schedule a FULL hold, not the leftovers of the first', () => {
    // approve → server refuses → approve again. The second hold must run its own
    // full window. Under a registry that releases the entry but leaves the first
    // TIMER armed, that timer fires on the old deadline and deletes the new hold
    // — the receipt vanishes partway through, and the closer the two approvals
    // are the shorter the second one gets.
    const { result, rerender } = renderHook(
      ({ schedules }: { schedules: readonly Task[] }) => useScheduleApprovalCards(schedules),
      { initialProps: { schedules: [] as readonly Task[] } }
    );

    act(() => holdApprovedSchedule(proposal('task-1')));
    act(() => {
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS / 2);
    });
    act(() => releaseSettledSchedule('task-1'));
    act(() => holdApprovedSchedule(proposal('task-1')));
    rerender({ schedules: [] });

    // The first hold's deadline passes. The second hold is only halfway through
    // its own window and must still be drawn.
    act(() => {
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(1);

    // …and it ends on ITS deadline, not late and not never.
    act(() => {
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(0);
  });

  it('keeps the later deadline when the same schedule is held twice', () => {
    // Two mounted consumers can both hold the same task — the Inbox popover and
    // the home header are on screen together. Arming a second timer without
    // clearing the first lets timer #1 cut hold #2 short.
    const { result, rerender } = renderHook(
      ({ schedules }: { schedules: readonly Task[] }) => useScheduleApprovalCards(schedules),
      { initialProps: { schedules: [] as readonly Task[] } }
    );

    act(() => holdApprovedSchedule(proposal('task-1')));
    act(() => {
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS / 2);
    });
    act(() => holdApprovedSchedule(proposal('task-1')));
    rerender({ schedules: [] });

    act(() => {
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(0);
  });

  it('leaves no timer behind when a hold is released', () => {
    // A released hold that keeps its timer is a timer with nothing to do but
    // interfere with whatever is holding that id next.
    holdApprovedSchedule(proposal('task-1'));
    releaseSettledSchedule('task-1');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind when everything is discarded', () => {
    // This is the whole reason `discardSettlingSchedules` exists: it is the
    // suites' teardown, and a hold that survives it fires inside an unrelated
    // case and deletes whatever that case was holding.
    holdApprovedSchedule(proposal('task-1'));
    holdApprovedSchedule(proposal('task-2'));

    discardSettlingSchedules();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands back the same array while nothing is settling', () => {
    // Identity matters: this sits in the render path of three surfaces, and a
    // fresh array every render would re-run every memo downstream of it.
    const schedules: readonly Task[] = [proposal('task-1')];
    const { result, rerender } = renderHook(() => useScheduleApprovalCards(schedules));
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current).toBe(schedules);
  });
});
