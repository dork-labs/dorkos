/**
 * The phone's Home shows everything waiting on you, not only approvals and
 * questions: a schedule an agent proposed, a chat that failed, a session
 * blocked on a prompt that has not reached the list yet — and the badge counts
 * exactly what is shown (DOR-3092).
 *
 * The cards themselves are stubbed: their behaviour is their own slices'
 * suites. What this file owns is the composition and the count.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, renderHook, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const state = vi.hoisted(() => ({
  signals: [] as Array<{ id: string; kind: string; primary: string }>,
  schedules: [] as Array<{ id: string }>,
  approvals: [] as Array<{ approvalId: string }>,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

vi.mock('@/layers/entities/attention', () => ({
  approvalSignalId: (id: string) => `approval:${id}`,
  interactionSignalId: (id: string) => `blocked:${id}`,
  useAskAgentNames: () => new Map(),
  useAttentionSignals: () => state.signals,
  usePendingApprovals: () => ({ approvals: state.approvals, isError: false, retry: vi.fn() }),
  usePendingInteractions: () => ({ interactions: [] }),
  usePendingScheduleApprovals: () => ({ schedules: state.schedules }),
  useSettlingAsks: () => [],
}));

vi.mock('@/layers/features/ask', () => ({ AskList: () => null }));

vi.mock('@/layers/features/approvals', () => ({
  ApprovalList: ({ approvals }: { approvals: Array<{ approvalId: string }> }) => (
    <div data-testid="approval-list">{approvals.length}</div>
  ),
  ApprovalsUnavailable: () => null,
  useApprovalCards: (approvals: unknown[]) => approvals,
}));

vi.mock('@/layers/features/schedule-approval', () => ({
  ScheduleApprovalCard: ({ task }: { task: { id: string } }) => (
    <div data-testid="schedule-card">{task.id}</div>
  ),
  useScheduleApprovalCards: (schedules: unknown[]) => schedules,
}));

vi.mock('@/layers/features/dashboard-attention', () => ({
  AttentionSignalRow: ({ signal }: { signal: { id: string; primary: string } }) => (
    <div data-testid="signal-row">{signal.primary}</div>
  ),
}));

import { useNowAttentionSlot } from '../ui/MobileNowAttention';

/** Render the hook and then the slot it returned. */
function renderSlot() {
  const { result } = renderHook(() => useNowAttentionSlot());
  render(<>{result.current.slot}</>);
  return result.current;
}

afterEach(() => {
  cleanup();
  state.signals = [];
  state.schedules = [];
  state.approvals = [];
});

describe('useNowAttentionSlot — everything waiting', () => {
  it('draws a proposed schedule as its card, and counts it', () => {
    state.schedules = [{ id: 'task-1' }];
    state.signals = [{ id: 'schedule:task-1', kind: 'schedule-approval', primary: 'Scout' }];
    const slot = renderSlot();
    expect(screen.getByTestId('schedule-card')).toHaveTextContent('task-1');
    // Drawn once, as the card, never again as a row.
    expect(screen.queryByTestId('signal-row')).toBeNull();
    expect(slot.count).toBe(1);
  });

  it('draws a failed chat as a row that opens it, and counts it', () => {
    state.signals = [{ id: 'error:ses-1', kind: 'error', primary: 'Scout' }];
    const slot = renderSlot();
    expect(screen.getByTestId('signal-row')).toHaveTextContent('Scout');
    expect(slot.count).toBe(1);
  });

  it('draws a session blocked before its prompt arrived as a row', () => {
    state.signals = [{ id: 'blocked:ses-2', kind: 'permission-prompt', primary: 'Ana' }];
    renderSlot();
    expect(screen.getByTestId('signal-row')).toHaveTextContent('Ana');
  });

  it('never draws an approval twice: its card covers its signal', () => {
    state.approvals = [{ approvalId: 'a-1' }];
    state.signals = [
      { id: 'approval:a-1', kind: 'permission-prompt', primary: 'DorkBot' },
      { id: 'error:ses-1', kind: 'error', primary: 'Scout' },
    ];
    const slot = renderSlot();
    expect(screen.getByTestId('approval-list')).toHaveTextContent('1');
    expect(screen.getAllByTestId('signal-row').map((row) => row.textContent)).toEqual(['Scout']);
    // The badge counts the approval and the failed chat: what Home shows.
    expect(slot.count).toBe(2);
  });

  it('says nothing when nothing is waiting', () => {
    const slot = renderSlot();
    expect(slot.slot).toBeNull();
    expect(slot.count).toBe(0);
  });
});
