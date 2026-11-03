// @vitest-environment jsdom
/**
 * New to-do in the command palette (DOR-3088): there only while to-dos are on, and gone again
 * when they go off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/layers/entities/todo', () => ({ useTodosEnabled: () => state.enabled }));
vi.mock('@/layers/features/todos', () => ({ openNewTodo: vi.fn() }));

import { useExtensionRegistry } from '@/layers/shared/model';
import { useTodosPalette } from '../use-todos-palette';

const rows = () =>
  useExtensionRegistry
    .getState()
    .getContributions('command-palette.items')
    .map((item) => item.id);

afterEach(() => {
  state.enabled = false;
});

describe('useTodosPalette', () => {
  it('adds no row while to-dos are off', () => {
    renderHook(() => useTodosPalette());
    expect(rows()).not.toContain('new-todo');
  });

  it('adds New to-do while they are on, and takes it away when they go off', () => {
    state.enabled = true;
    const { rerender, unmount } = renderHook(() => useTodosPalette());
    expect(rows()).toContain('new-todo');
    state.enabled = false;
    rerender();
    expect(rows()).not.toContain('new-todo');
    unmount();
  });
});
