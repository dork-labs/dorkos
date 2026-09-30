/**
 * The question prompt's option cursor stays hidden until a shortcut is used.
 *
 * It always starts on the first option, and a solid ring drawn there before
 * anyone touched the keyboard read as an answer already picked (DOR-2615).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useToolShortcuts } from '../use-tool-shortcuts';

function press(key: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function setup(toolCallId = 'tc-1') {
  const handle = {
    toggleOption: vi.fn(),
    getOptionCount: () => 3,
    navigateQuestion: vi.fn(),
    submit: vi.fn(),
  };
  const hook = renderHook(
    ({ id }) => useToolShortcuts({ interactiveType: 'question', toolCallId: id }),
    { initialProps: { id: toolCallId } }
  );
  act(() => hook.result.current.handleToolRef(handle as never));
  return { hook, handle };
}

describe('useToolShortcuts option cursor', () => {
  it('shows no option cursor before a shortcut is used', () => {
    const { hook } = setup();
    expect(hook.result.current.focusedOptionIndex).toBe(-1);
  });

  it('shows the cursor once an arrow key moves it', () => {
    const { hook } = setup();
    press('ArrowDown');
    expect(hook.result.current.focusedOptionIndex).toBe(1);
  });

  it('shows the cursor on the option a digit key toggled', () => {
    const { hook, handle } = setup();
    press('3');
    expect(handle.toggleOption).toHaveBeenCalledWith(2);
    expect(hook.result.current.focusedOptionIndex).toBe(2);
  });

  it('hides it again when a new question arrives', () => {
    const { hook } = setup();
    press('ArrowDown');
    hook.rerender({ id: 'tc-2' });
    expect(hook.result.current.focusedOptionIndex).toBe(-1);
  });
});
