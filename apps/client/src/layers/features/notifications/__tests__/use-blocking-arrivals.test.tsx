/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Task } from '@dorkos/shared/types';

/** The world the hook reads, swapped between renders. */
const world = {
  signals: [] as { id: string; kind: string; primary: string; deepLink: string }[],
  signalsLoading: false,
  schedules: [] as Task[],
  schedulesLoading: false,
};

vi.mock('@/layers/entities/attention', () => ({
  useAttentionSignals: () => world.signals,
  useAttentionSignalsLoading: () => world.signalsLoading,
  usePendingScheduleApprovals: () => ({
    schedules: world.schedules,
    isLoading: world.schedulesLoading,
  }),
}));

const { useBlockingArrivals } = await import('../model/use-blocking-arrivals');

/** An agent parked on a permission prompt. */
function ask(id: string, who = 'Meeting Notes') {
  return { id, kind: 'permission-prompt', primary: who, deepLink: `/session?session=${id}` };
}

/** A schedule an agent proposed and parked. */
function parkedSchedule(id: string, name = 'Nightly digest'): Task {
  return { id, name, displayName: null } as unknown as Task;
}

beforeEach(() => {
  world.signals = [];
  world.signalsLoading = false;
  world.schedules = [];
  world.schedulesLoading = false;
});

describe('useBlockingArrivals', () => {
  it('says nothing about what was already waiting when it mounted', () => {
    // The difference between a knock and a nuisance. Opening the cockpit with
    // two agents parked is the person arriving at the queue, not the queue
    // arriving at them.
    world.signals = [ask('a'), ask('b')];
    const onArrive = vi.fn();

    renderHook(() => useBlockingArrivals({ onArrive }));

    expect(onArrive).not.toHaveBeenCalled();
  });

  it('reports a genuinely new arrival, once', () => {
    const onArrive = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onArrive }));

    world.signals = [ask('a')];
    rerender();

    expect(onArrive).toHaveBeenCalledTimes(1);
    expect(onArrive.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ id: 'a', who: 'Meeting Notes' }),
    ]);

    // A re-render with the same queue — which is what a refetch produces — is
    // not a second arrival.
    rerender();
    rerender();
    expect(onArrive).toHaveBeenCalledTimes(1);
  });

  it('does not fire while the queue is still loading, and does not seed from it', () => {
    // An empty list mid-load is not "nothing is waiting". Seeding from it would
    // announce every existing item the moment the query answered.
    world.signalsLoading = true;
    world.signals = [];
    const onArrive = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onArrive }));
    expect(onArrive).not.toHaveBeenCalled();

    world.signalsLoading = false;
    world.signals = [ask('a')];
    rerender();

    expect(onArrive).not.toHaveBeenCalled();
  });

  it('stays silent through the staggered settle of a page load (DOR-1385 review)', () => {
    // The regression this pins, end to end. Sessions and approvals answer
    // first, prompts a beat later — and a blocked session's signal id CHANGES
    // when the prompt lands (`blocked:<sessionId>` becomes
    // `blocked:<interactionId>`). If loading is reported as settled during that
    // window, the id change reads as a departure and an arrival, and an Ask that
    // had been waiting all along knocks and raises an OS banner.
    world.signalsLoading = true;
    world.signals = [ask('blocked:ses-1')];
    const onArrive = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onArrive }));

    // Prompts land: same Ask, new id.
    world.signalsLoading = false;
    world.signals = [ask('blocked:int-9')];
    rerender();

    expect(onArrive).not.toHaveBeenCalled();

    // …and the settled snapshot is what later arrivals are measured against, so
    // the next genuine one still speaks.
    world.signals = [ask('blocked:int-9'), ask('blocked:int-10')];
    rerender();
    expect(onArrive).toHaveBeenCalledTimes(1);
    expect(onArrive.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'blocked:int-10' })]);
  });

  it('reports the ids that stopped waiting, and how many are left', () => {
    world.signals = [ask('a'), ask('b')];
    const onDepart = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onDepart }));

    world.signals = [ask('b')];
    rerender();

    expect(onDepart).toHaveBeenCalledWith(['a'], 1);
  });

  it('reports zero remaining when the queue drains — the all-clear', () => {
    // The number is what the all-clear chime hangs off. Reporting it here rather
    // than letting callers recount is what keeps one answer to "how many are
    // waiting".
    world.signals = [ask('a'), ask('b')];
    const onDepart = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onDepart }));

    world.signals = [];
    rerender();

    expect(onDepart).toHaveBeenCalledWith(['a', 'b'], 0);
  });

  it('treats an ask answered and re-asked as a new arrival', () => {
    world.signals = [ask('a')];
    const onArrive = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onArrive }));

    world.signals = [];
    rerender();
    world.signals = [ask('a')];
    rerender();

    // An agent that asked, was answered, and asked again has asked twice.
    expect(onArrive).toHaveBeenCalledTimes(1);
  });

  it('counts a parked schedule as something waiting', () => {
    const onArrive = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onArrive }));

    world.schedules = [parkedSchedule('t1')];
    rerender();

    expect(onArrive).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'schedule:t1', who: 'Nightly digest', deepLink: '/tasks' }),
    ]);
  });

  it('ignores signals that are not blocked on a person', () => {
    const onArrive = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onArrive }));

    // An errored session and an idle nudge are news, not blockages. Widening
    // this set is what turns a knock into background noise.
    world.signals = [
      { id: 'error:s', kind: 'error', primary: 'Repo', deepLink: '/session?session=s' },
      { id: 'idle:s', kind: 'idle-timeout', primary: 'Repo', deepLink: '/session?session=s' },
    ];
    rerender();

    expect(onArrive).not.toHaveBeenCalled();
  });

  it('never carries a tool input into the summary', () => {
    // The summary reaches an OS notification, which is drawn outside DorkOS and
    // is often visible on a locked screen. It is a fixed sentence per kind, and
    // this is the assertion that keeps it one.
    const onArrive = vi.fn();
    const { rerender } = renderHook(() => useBlockingArrivals({ onArrive }));

    world.signals = [
      {
        id: 'a',
        kind: 'permission-prompt',
        primary: 'Repo',
        deepLink: '/session?session=a&cmd=rm -rf /Users/dorian/Keep',
      },
    ];
    rerender();

    const [items] = onArrive.mock.calls[0]!;
    expect(items[0].summary).not.toContain('rm -rf');
    expect(items[0].summary).toBe('Waiting for your OK before it goes on.');
  });
});
