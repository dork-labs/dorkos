/**
 * The one composition three surfaces read: what needs you, what went wrong, and
 * whether either answer can be believed yet.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Task } from '@dorkos/shared/types';
import type { AttentionSignal } from '@/layers/entities/attention';

// ---------------------------------------------------------------------------
// Mocks — must be before imports
// ---------------------------------------------------------------------------

const mockSignals = vi.fn<() => AttentionSignal[]>(() => []);
const mockSignalsLoading = vi.fn<() => boolean>(() => false);
const mockSchedules = vi.fn<() => { schedules: Task[]; isLoading: boolean }>(() => ({
  schedules: [],
  isLoading: false,
}));
vi.mock('@/layers/entities/attention', () => ({
  useAttentionSignals: () => mockSignals(),
  useAttentionSignalsLoading: () => mockSignalsLoading(),
  usePendingScheduleApprovals: () => mockSchedules(),
}));

const mockActivity = vi.fn<() => { items: { id: string }[]; isLoading: boolean }>(() => ({
  items: [],
  isLoading: false,
}));
vi.mock('../model/use-activity-notifications', () => ({
  useActivityNotifications: () => mockActivity(),
}));

import { useAttentionRows } from '../model/use-attention-rows';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signal(kind: AttentionSignal['kind'], id: string): AttentionSignal {
  return {
    id,
    kind,
    primary: 'alpha',
    since: '2026-08-19T09:00:00.000Z',
    deepLink: '/session?session=ses-1',
    dismissible: false,
  };
}

function task(id: string): Task {
  return {
    id,
    name: id,
    displayName: null,
    description: null,
    prompt: 'Do the thing.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: null,
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: `/tmp/${id}/SKILL.md`,
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAttentionRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignals.mockReturnValue([]);
    mockSignalsLoading.mockReturnValue(false);
    mockSchedules.mockReturnValue({ schedules: [], isLoading: false });
    mockActivity.mockReturnValue({ items: [], isLoading: false });
  });

  it('takes only the error kind from the engine', () => {
    // The dedupe rule, at its source: a permission prompt and a question each
    // already have a card in "Waiting On You", and drawing them again as rows
    // is the same fact twice in one header.
    mockSignals.mockReturnValue([
      signal('permission-prompt', 'approval:apr-1'),
      signal('question', 'blocked:q-1'),
      signal('idle-timeout', 'idle:ses-1'),
      signal('error', 'error:ses-2'),
    ]);

    const { result } = renderHook(() => useAttentionRows());

    expect(result.current.errors.map((s) => s.id)).toEqual(['error:ses-2']);
  });

  it('counts every group into the total the badge shows', () => {
    mockSchedules.mockReturnValue({ schedules: [task('task-1')], isLoading: false });
    mockSignals.mockReturnValue([signal('error', 'error:ses-2')]);
    mockActivity.mockReturnValue({ items: [{ id: 'failed-run-1' }], isLoading: false });

    const { result } = renderHook(() => useAttentionRows());

    expect(result.current.total).toBe(3);
  });

  it('keeps one array identity for the errors while nothing is wedged', () => {
    // Three surfaces memoize on this, and a fresh empty array per render would
    // rebuild all of them on every clock tick.
    const { result, rerender } = renderHook(() => useAttentionRows());
    const first = result.current.errors;
    rerender();

    expect(result.current.errors).toBe(first);
  });

  it('is still loading while the SIGNALS source is, even with zero rows', () => {
    // The case Pulse's all-clear line turns on. The session listing behind the
    // error rows is the slowest of the three sources, so a composition that
    // reported "settled" once the other two answered would flash "All quiet"
    // over a cockpit with a wedged session in it. Seeded defect: drop
    // `signalsLoading` from the OR and this goes green with a lie behind it.
    mockSignalsLoading.mockReturnValue(true);

    const { result } = renderHook(() => useAttentionRows());

    expect(result.current.total).toBe(0);
    expect(result.current.isLoading).toBe(true);
  });

  it('is loading while the schedules or the activity sources are', () => {
    // The other two halves, so "loading" is not satisfied by one source alone.
    mockSchedules.mockReturnValue({ schedules: [], isLoading: true });
    expect(renderHook(() => useAttentionRows()).result.current.isLoading).toBe(true);

    mockSchedules.mockReturnValue({ schedules: [], isLoading: false });
    mockActivity.mockReturnValue({ items: [], isLoading: true });
    expect(renderHook(() => useAttentionRows()).result.current.isLoading).toBe(true);
  });

  it('settles only when all three have answered', () => {
    // The discriminating half of the four cases above: with nothing loading,
    // the composition says so — otherwise "loading" would be a constant.
    const { result } = renderHook(() => useAttentionRows());
    expect(result.current.isLoading).toBe(false);
  });
});
