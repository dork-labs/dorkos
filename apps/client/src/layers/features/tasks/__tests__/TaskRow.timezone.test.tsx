/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { Task } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

vi.mock('cronstrue', () => ({
  default: {
    toString: (cron: string) => {
      if (cron === '30 8 * * *') return 'At 08:30 AM';
      if (cron === '0 9 * * 1-5') return 'At 09:00 AM, Monday through Friday';
      if (cron === '0 2 * * 1-5') return 'At 02:00 AM, Monday through Friday';
      return `Every: ${cron}`;
    },
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

import { useWrongTimezoneDismissals } from '../model/wrong-timezone-dismissals';
import { formatNextRun } from '../lib/task-time';
import { TaskRow } from '../ui/TaskRow';

const overnight: Task = {
  id: 'utc-morning',
  name: 'Morning review',
  description: 'Review the morning queue',
  prompt: 'Review the morning queue.',
  cron: '30 8 * * *',
  enabled: true,
  sticky: false,
  status: 'active',
  agentId: null,
  timezone: 'UTC',
  defaultCron: '30 8 * * *',
  defaultTimezone: 'UTC',
  timingOverridden: false,
  packageOwned: null,
  approvalChanges: [],
  maxRuntime: null,
  permissionMode: 'acceptEdits',
  runtime: null,
  model: null,
  effort: null,
  account: null,
  filePath: '/tmp/utc-morning/SKILL.md',
  nextRun: '2026-11-14T08:30:00.000Z',
  createdAt: '2026-11-13T12:00:00.000Z',
  updatedAt: '2026-11-13T12:00:00.000Z',
  reason: null,
  proposedBySessionId: null,
  proposedByAgentPath: null,
  proposedByName: null,
  origin: null,
  reasonSource: null,
  approvedAt: null,
  approvedBy: null,
  approvedVia: null,
  nextRuns: [],
};

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function renderRow(
  task: Task,
  transport: Transport = createMockTransport(),
  viewerTimezone: () => string | null = () => 'America/Chicago'
) {
  const Wrapper = createWrapper(transport);
  return render(
    <Wrapper>
      <TaskRow
        task={task}
        expanded={false}
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        viewerTimezone={viewerTimezone}
      />
    </Wrapper>
  );
}

describe('TaskRow viewer-local timing', () => {
  beforeEach(() => {
    localStorage.clear();
    useWrongTimezoneDismissals.setState({ dismissed: {} });
  });

  afterEach(cleanup);

  it('shows the fixed cron and next run in the viewer’s time without seconds', () => {
    renderRow(overnight);

    expect(document.body).toHaveTextContent(/Daily at 2:30 AM · Next .* 2:30 AM/);
    expect(document.body.textContent).not.toContain('UTC · Next');
    expect(document.body.textContent).not.toContain(':00 AM CST');
    // The next run wraps as one piece, never between "Next" and its time (DOR-4483).
    expect(document.querySelector('[data-slot="task-next-run"]')).toHaveClass('whitespace-nowrap');
  });

  it('words the next run the way the Needs you card does (DOR-4483)', () => {
    const now = new Date('2026-11-13T12:00:00.000Z');

    // Today has no day word, and "at" joins a day to its time.
    expect(formatNextRun('2026-11-13T18:00:00.000Z', 'America/Chicago', now)).toBe('Next 12:00 PM');
    expect(formatNextRun('2026-11-14T08:30:00.000Z', 'America/Chicago', now)).toBe(
      'Next tomorrow at 2:30 AM'
    );
    expect(formatNextRun('2026-11-16T15:00:00.000Z', 'America/Chicago', now)).toBe(
      'Next Mon at 9:00 AM'
    );
    expect(formatNextRun('2026-11-20T15:00:00.000Z', 'America/Chicago', now)).toBe(
      'Next Nov 20 at 9:00 AM'
    );
    expect(formatNextRun('not a time', 'America/Chicago', now)).toBeNull();
  });

  it('uses a compact 12-hour cron description when the zones match', () => {
    renderRow({ ...overnight, cron: '0 9 * * 1-5', timezone: 'America/Chicago' });

    expect(screen.getByText(/Weekdays at 9:00 AM/)).toBeTruthy();
  });

  it('keeps the schedule’s zone when the viewer’s clock would move it to another day', () => {
    // Monday 02:00 UTC is Sunday 8:00 PM in Chicago: "Weekdays at 8:00 PM"
    // would name the wrong days.
    renderRow({ ...overnight, cron: '0 2 * * 1-5', nextRun: '2026-11-16T02:00:00.000Z' });

    expect(screen.getByText(/Weekdays at 2:00 AM, UTC/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Weekdays at 8:00 PM');
  });

  it('shows the offer when a fixed UTC time lands overnight', () => {
    renderRow(overnight);

    expect(screen.getByText('Set in UTC, so it runs at 2:30 AM for you.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use my time zone' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep it as set' })).toBeTruthy();
  });

  it('hides the offer when the browser cannot name its zone', () => {
    // Otherwise a Chicago schedule would be offered a move to UTC, a zone the
    // person never chose.
    renderRow(
      { ...overnight, timezone: 'America/Chicago', nextRun: '2026-11-14T03:30:00.000Z' },
      createMockTransport(),
      () => null
    );

    expect(document.querySelector('[data-slot="wrong-timezone-offer"]')).toBeNull();
  });

  it('hides the offer when the schedule uses the viewer’s zone', () => {
    renderRow({ ...overnight, timezone: 'America/Chicago' });

    expect(document.querySelector('[data-slot="wrong-timezone-offer"]')).toBeNull();
  });

  it('hides the offer when the next run lands at 9 AM', () => {
    renderRow({ ...overnight, cron: '0 15 * * *', nextRun: '2026-11-14T15:00:00.000Z' });

    expect(document.querySelector('[data-slot="wrong-timezone-offer"]')).toBeNull();
  });

  it('moves only the zone when the person chooses their time', async () => {
    const transport = createMockTransport({
      updateTask: vi.fn().mockResolvedValue({ ...overnight, timezone: 'America/Chicago' }),
    });
    renderRow(overnight, transport);

    fireEvent.click(screen.getByRole('button', { name: 'Use my time zone' }));
    await waitFor(() =>
      expect(transport.updateTask).toHaveBeenCalledWith('utc-morning', {
        timezone: 'America/Chicago',
      })
    );
  });

  it('keeps the stored zone and stays hidden after remount', () => {
    const first = renderRow(overnight);
    fireEvent.click(screen.getByRole('button', { name: 'Keep it as set' }));
    expect(document.querySelector('[data-slot="wrong-timezone-offer"]')).toBeNull();
    expect(localStorage.getItem('dorkos:wrong-timezone-dismissals-v1')).toContain('utc-morning');
    first.unmount();

    renderRow(overnight);
    expect(document.querySelector('[data-slot="wrong-timezone-offer"]')).toBeNull();
  });
});
