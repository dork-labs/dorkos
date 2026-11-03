// @vitest-environment jsdom
/**
 * "Make a to-do" from a message (DOR-3088): offered only while to-dos are on, and opening it
 * records the message before the dialog mounts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { enabled } = vi.hoisted(() => ({ enabled: { value: false } }));
vi.mock('@/layers/entities/todo', () => ({ useTodosEnabled: () => enabled.value }));

import { makeTodoDialogState, makeTodoSource, useMakeTodoAction } from '../model/make-todo';

afterEach(() => {
  makeTodoDialogState.set(false);
  enabled.value = false;
});

describe('useMakeTodoAction', () => {
  it('offers nothing while to-dos are off', () => {
    const { result } = renderHook(() => useMakeTodoAction('entry-1', 'Renew the domain'));
    expect(result.current).toBeUndefined();
  });

  it('opens the dialog for that message once they are on', () => {
    enabled.value = true;
    const { result } = renderHook(() => useMakeTodoAction('entry-1', 'Renew the domain'));
    act(() => result.current!());
    expect(makeTodoDialogState.getSnapshot()).toBe(true);
    expect(makeTodoSource()).toEqual({ entryId: 'entry-1', text: 'Renew the domain' });
  });
});
