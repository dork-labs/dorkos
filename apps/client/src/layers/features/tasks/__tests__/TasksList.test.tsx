/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { TasksList } from '../ui/TasksList';

// useFilterState reads/writes URL search params via the router. Both are stable
// across renders, as the router's are: a fresh object each render makes a list
// with rows re-render forever.
const router = vi.hoisted(() => ({ navigate: () => {}, search: {} }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
}));

/** A switched-on schedule; its expanded panel shows its file path. */
function schedule(id: string): Task {
  return {
    id,
    name: id,
    displayName: null,
    description: null,
    prompt: 'Do it',
    cron: '0 9 * * *',
    enabled: true,
    sticky: false,
    status: 'active',
    agentId: null,
    timezone: null,
    defaultCron: '0 9 * * *',
    defaultTimezone: null,
    timingOverridden: false,
    packageOwned: null,
    approvalChanges: [],
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    runtime: null,
    model: null,
    effort: null,
    account: null,
    filePath: `/schedules/${id}/SKILL.md`,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    reasonSource: null,
    nextRuns: [],
    approvedAt: null,
    approvedBy: null,
    approvedVia: null,
  };
}

/** The providers a real row needs. */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={createMockTransport()}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

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

afterEach(() => {
  cleanup();
});

describe('TasksList', () => {
  it('stamps the tasks-list tour anchor on the scheduled-work list', () => {
    render(<TasksList tasks={[]} isLoading={false} agentMap={new Map()} onEditTask={vi.fn()} />);
    expect(screen.getByTestId(TOUR_ANCHORS.tasksList)).toBeInTheDocument();
  });

  it('lands on the linked schedule: its row open and scrolled into view (DOR-4121)', () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled(this.getAttribute('data-schedule-row'));
    };
    render(
      <TasksList
        tasks={[schedule('a'), schedule('b')]}
        isLoading={false}
        agentMap={new Map()}
        onEditTask={vi.fn()}
        expandId="b"
      />,
      { wrapper }
    );
    expect(screen.getByText('/schedules/b/SKILL.md')).toBeInTheDocument();
    expect(screen.queryByText('/schedules/a/SKILL.md')).toBeNull();
    expect(scrolled).toHaveBeenCalledWith('b');
  });
});
