/**
 * @vitest-environment jsdom
 *
 * The Schedules list tells the truth about schedules that do not do their job
 * (DOR-3123, spec `schedules-failing` SF-5 to SF-8): an honest count, a Failing
 * chip and filter, failing rows first, and one reason line per failing row.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockSchedule, createMockTransport } from '@dorkos/test-utils';
import type { Task, TaskHealth } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

const search = vi.hoisted(() => ({ value: {} as Record<string, string>, navigate: vi.fn() }));

// useFilterState reads and writes the URL through the router.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => search.navigate,
  useSearch: () => search.value,
}));

vi.mock('cronstrue', () => ({ default: { toString: (cron: string) => `Every: ${cron}` } }));

vi.mock('../ui/TaskRunHistoryPanel', () => ({ TaskRunHistoryPanel: () => null }));

import { TasksList } from '../ui/TasksList';
import { describeFailure } from '../lib/schedule-health';
import { asksWhileUnattended } from '../ui/TaskUnattendedWarning';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  search.value = {};
  search.navigate.mockClear();
});

afterEach(() => cleanup());

/** A failing health, refused Bash on its last run. */
const FAILING: TaskHealth = {
  state: 'failing',
  reason: { kind: 'tool_refused', tools: ['Bash'], nothingDone: false, message: null },
  since: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  streak: 3,
  lastRunId: 'run-3',
};

/** A schedule, healthy unless it says otherwise. */
function schedule(id: string, overrides: Partial<Task> = {}): Task {
  return createMockSchedule({
    id,
    name: id,
    displayName: id,
    nextRun: new Date(Date.now() + Number(id.replace(/\D/g, '') || 1) * 3_600_000).toISOString(),
    health: { state: 'ok', reason: null, since: null, streak: 0, lastRunId: null },
    ...overrides,
  });
}

function renderList(tasks: Task[], transport = createMockTransport()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <TasksList tasks={tasks} isLoading={false} agentMap={new Map()} onEditTask={vi.fn()} />
    </Wrapper>
  );
}

/** The names of the rows, in the order the list draws them. */
function rowOrder(): string[] {
  return screen
    .getAllByText(/^s\d$/, { selector: '[data-slot="task-name"]' })
    .map((node) => node.textContent ?? '');
}

describe('the Schedules list when something is failing (DOR-3123)', () => {
  it('SF-5: counts "N schedules · K failing", and the count applies the filter', () => {
    renderList([schedule('s1'), schedule('s2', { health: FAILING }), schedule('s3')]);

    const count = screen.getByText('3 schedules').parentElement!;
    const failing = within(count).getByRole('button', { name: '1 failing' });
    fireEvent.click(failing);
    expect(search.navigate).toHaveBeenCalled();
    const call = search.navigate.mock.calls.at(-1)![0] as { search: (s: object) => object };
    expect(call.search({})).toMatchObject({ health: 'failing' });
  });

  it('SF-5: says nothing more when nothing is failing', () => {
    renderList([schedule('s1'), schedule('s2')]);

    expect(screen.getByText('2 schedules')).toBeInTheDocument();
    expect(screen.queryByText(/failing/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Failing/ })).toBeNull();
  });

  it('SF-6: shows the Failing chip only while something fails, or while it is on', () => {
    renderList([schedule('s1', { health: FAILING })]);
    expect(screen.getByRole('button', { name: /^Failing\s*1$/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    cleanup();

    // On, with nothing left failing: the chip stays, and the list says so.
    search.value = { health: 'failing' };
    renderList([schedule('s1'), schedule('s2')]);
    expect(screen.getByRole('button', { name: /^Failing\s*0$/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      screen.getByText('Nothing is failing. Every schedule’s last run did its job.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
  });

  it('SF-6: with the filter on, only failing rows show', () => {
    search.value = { health: 'failing' };
    renderList([schedule('s1'), schedule('s2', { health: FAILING }), schedule('s3')]);

    expect(rowOrder()).toEqual(['s2']);
  });

  it('SF-7: puts failing rows first in the default sort, and respects a chosen one', () => {
    const tasks = [schedule('s1'), schedule('s2'), schedule('s3', { health: FAILING })];
    renderList(tasks);
    expect(rowOrder()).toEqual(['s3', 's1', 's2']);
    cleanup();

    search.value = { sort: 'name:asc' };
    renderList(tasks);
    expect(rowOrder()).toEqual(['s1', 's2', 's3']);
  });

  it('SF-8: a failing row names the tool and the streak, with one action, and no green dot', () => {
    renderList([schedule('s1', { health: FAILING }), schedule('s2')]);

    expect(screen.getByLabelText('Needs attention')).toBeInTheDocument();
    const reason = document.querySelector('[data-slot="task-failing-reason"]')!;
    expect(reason.textContent).toMatch(/^Bash was refused/);
    expect(reason.textContent).not.toMatch(/Something went wrong|\bwe\b/i);
    expect(screen.getByText(/Failing since .* · 3 runs/)).toBeInTheDocument();
    // One action on the row, never an offer to raise the stop.
    expect(screen.getAllByRole('button', { name: 'Open schedule s1' }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Full autonomy|Raise/)).toBeNull();
    // Healthy is the quiet default: no coloured dot on the healthy row.
    expect(document.querySelectorAll('.bg-status-success, [class*="status-success"]')).toHaveLength(
      0
    );
  });

  it('SF-8: names the stop the schedule runs at by its dial name', async () => {
    renderList([schedule('s1', { health: FAILING, permissionMode: 'acceptEdits' })]);

    expect(
      await screen.findByText('Bash was refused: this schedule runs at Act.')
    ).toBeInTheDocument();
  });

  it('SF-8: names Never ask for itself, not the Ask first stop it sits inside', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue({
        defaultRuntime: 'claude-code',
        capabilities: {
          'claude-code': {
            type: 'claude-code',
            permissionModes: {
              supported: true,
              values: [
                {
                  id: 'dontAsk',
                  label: 'Never ask',
                  stop: 'ask',
                  asks: 'always',
                  reach: 'edit',
                  promise: '',
                },
              ],
            },
          },
        },
      }),
    });
    renderList([schedule('s1', { health: FAILING, permissionMode: 'dontAsk' })], transport);

    expect(
      await screen.findByText('Bash was refused: this schedule runs at Never ask.')
    ).toBeInTheDocument();
  });

  it('SF-8: a switched-off failing row is still failing, and says it is off', () => {
    renderList([schedule('s1', { health: FAILING, enabled: false })]);

    const reason = document.querySelector('[data-slot="task-failing-reason"]')!;
    expect(reason.textContent).toMatch(/· Off$/);
  });
});

describe('describeFailure (SF-8)', () => {
  const base = { tools: [], nothingDone: false, message: null };

  it('names the tool by its readable name and the stop by its dial name', () => {
    expect(
      describeFailure({ ...base, kind: 'tool_refused', tools: ['mcp__gmail__search'] }, 'Act')
    ).toBe('gmail: search was refused: this schedule runs at Act.');
  });

  it('says when nothing got done', () => {
    expect(
      describeFailure({ ...base, kind: 'tool_refused', tools: ['Bash'], nothingDone: true }, 'Act')
    ).toBe('Nothing got done: Bash was refused at Act.');
  });

  it('counts past two tools', () => {
    expect(
      describeFailure(
        { ...base, kind: 'tools_refused', tools: ['Bash', 'Write', 'Edit', 'WebFetch'] },
        'Ask first'
      )
    ).toBe('Bash, Write and 2 more were refused: this schedule runs at Ask first.');
  });

  it('quotes a short error, and never says "Something went wrong"', () => {
    expect(describeFailure({ ...base, kind: 'error', message: 'API Error: 500' }, null)).toBe(
      'Didn’t finish: API Error: 500.'
    );
    expect(describeFailure({ ...base, kind: 'error' }, null)).toBe('Didn’t finish.');
    // A cut error ends in "…", and never gets a full stop after it.
    const cut = describeFailure(
      { ...base, kind: 'error', message: `which is not ${'x '.repeat(200)}` },
      null
    );
    expect(cut).toMatch(/…$/);
    expect(cut).not.toContain('….');
    expect(describeFailure({ ...base, kind: 'error', message: 'Is the server up?' }, null)).toBe(
      'Didn’t finish: Is the server up?'
    );
  });
});

describe('asksWhileUnattended (A1)', () => {
  const mode = (id: string, asks: 'always' | 'when-risky' | 'never') => ({
    id,
    label: id,
    stop: 'act' as const,
    asks,
    reach: 'edit' as const,
    promise: '',
  });

  it('warns for a stop that would ask, and not for Never ask or one that never asks', () => {
    expect(asksWhileUnattended(mode('acceptEdits', 'when-risky'))).toBe(true);
    expect(asksWhileUnattended(mode('default', 'always'))).toBe(true);
    expect(asksWhileUnattended(mode('dontAsk', 'always'))).toBe(false);
    expect(asksWhileUnattended(mode('bypassPermissions', 'never'))).toBe(false);
  });
});
