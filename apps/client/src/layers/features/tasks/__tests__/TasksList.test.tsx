/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import type { Task } from '@dorkos/shared/types';
import { TasksList } from '../ui/TasksList';

// The row itself is covered by TaskRow's tests; here only "is it expanded" matters.
vi.mock('../ui/TaskRow', () => ({
  TaskRow: ({ task, expanded }: { task: Task; expanded: boolean }) => (
    <div data-testid={`row-${task.id}`} data-expanded={String(expanded)} />
  ),
}));

/** A schedule with just what the list sorts and filters on. */
function schedule(id: string): Task {
  return { id, name: id, status: 'active', enabled: true, agentId: null } as Task;
}

// useFilterState reads/writes URL search params via the router. Both are stable
// across renders, as the router's are: a fresh object each render makes a
// list with rows re-render forever.
const router = vi.hoisted(() => ({ navigate: () => {}, search: {} }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
}));

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

  it('lands on the linked schedule opened to its history (DOR-4121)', () => {
    const tasks = [schedule('a'), schedule('b')];
    const props = { tasks, isLoading: false, agentMap: new Map(), onEditTask: vi.fn() };
    const { rerender } = render(<TasksList {...props} expandId="b" />);
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-expanded', 'false');
    // A second link while the page is open moves the expansion.
    rerender(<TasksList {...props} expandId="a" />);
    expect(screen.getByTestId('row-a')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByTestId('row-b')).toHaveAttribute('data-expanded', 'false');
  });
});
