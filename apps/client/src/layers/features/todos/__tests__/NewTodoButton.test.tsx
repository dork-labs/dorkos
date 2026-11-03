/**
 * @vitest-environment jsdom
 */
/**
 * New to-do in the To-dos bar (DOR-3088): hidden while to-dos are off, words on a desktop, a named
 * `+` on a phone, and it opens the app's to-do dialog blank.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const state = vi.hoisted(() => ({ enabled: true, mobile: false }));
vi.mock('@/layers/entities/todo', () => ({ useTodosEnabled: () => state.enabled }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsMobile: () => state.mobile,
}));

import { NewTodoButton } from '../ui/NewTodoButton';
import { makeTodoDialogState, makeTodoSource, openMakeTodo } from '../model/make-todo';

afterEach(() => {
  cleanup();
  makeTodoDialogState.set(false);
  state.enabled = true;
  state.mobile = false;
});

describe('NewTodoButton', () => {
  it('is not there while to-dos are off', () => {
    state.enabled = false;
    render(<NewTodoButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a blank New to-do, even after one was made from a message', () => {
    openMakeTodo({ entryId: 'entry-1', text: 'Renew the domain' });
    makeTodoDialogState.set(false);
    render(<NewTodoButton />);
    fireEvent.click(screen.getByRole('button', { name: 'New to-do' }));
    expect(makeTodoDialogState.getSnapshot()).toBe(true);
    expect(makeTodoSource()).toBeNull();
  });

  it('is a named + on a phone', () => {
    state.mobile = true;
    render(<NewTodoButton />);
    const button = screen.getByRole('button', { name: 'New to-do' });
    expect(button).not.toHaveTextContent('New to-do');
  });
});
