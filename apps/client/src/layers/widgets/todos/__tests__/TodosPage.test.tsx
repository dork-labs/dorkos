// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const flag = vi.hoisted(() => ({ enabled: false, isLoading: false }));

vi.mock('@/layers/entities/todo', () => ({
  useTodosEnabledState: () => ({
    enabled: flag.enabled,
    isLoading: flag.isLoading,
    isError: false,
    isRetrying: false,
    lockedByEnv: false,
    retry: vi.fn(),
  }),
}));

vi.mock('@/layers/features/todos', () => ({
  TodoList: () => <div data-testid="todo-list" />,
  openNewTodo: vi.fn(),
}));

import { TodosPage } from '../ui/TodosPage';

afterEach(() => {
  cleanup();
  flag.enabled = false;
  flag.isLoading = false;
});

describe('TodosPage', () => {
  it('says to-dos are off, and how to turn them on, while the server has them off', () => {
    render(<TodosPage />);
    expect(screen.getByText('To-do list is off')).toBeInTheDocument();
    expect(screen.getByText('DORKOS_TODOS_ENABLED=true dorkos')).toBeInTheDocument();
    expect(screen.queryByTestId('todo-list')).toBeNull();
  });

  it('does not say they are off before the server has answered', () => {
    flag.isLoading = true;
    render(<TodosPage />);
    expect(screen.queryByText('To-do list is off')).toBeNull();
  });

  it('shows the list when to-dos are on; New to-do lives in the bar', () => {
    flag.enabled = true;
    render(<TodosPage />);
    expect(screen.getByTestId('todo-list')).toBeInTheDocument();
  });
});
