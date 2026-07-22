/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { TasksList } from '../ui/TasksList';

// useFilterState reads/writes URL search params via the router.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
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
});
