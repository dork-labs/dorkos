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

  it('reveals the cursor at its current index on the first ArrowDown, without moving it', () => {
    const { hook } = setup();
    press('ArrowDown');
    expect(hook.result.current.focusedOptionIndex).toBe(0);
  });

  it('reveals the cursor at its current index on the first ArrowUp, without moving it', () => {
    const { hook } = setup();
    press('ArrowUp');
    expect(hook.result.current.focusedOptionIndex).toBe(0);
  });

  it('moves the cursor on the second arrow key, once revealed', () => {
    const { hook } = setup();
    press('ArrowDown');
    press('ArrowDown');
    expect(hook.result.current.focusedOptionIndex).toBe(1);
  });

  it('moves the cursor backward on a second ArrowUp, once revealed', () => {
    const { hook } = setup();
    press('ArrowUp');
    press('ArrowUp');
    expect(hook.result.current.focusedOptionIndex).toBe(2);
  });

  it('toggles option 1 and reveals the cursor when Space is pressed while hidden', () => {
    const { hook, handle } = setup();
    press(' ');
    expect(handle.toggleOption).toHaveBeenCalledWith(0);
    expect(hook.result.current.focusedOptionIndex).toBe(0);
  });

  it('submits a mouse-picked answer on Enter even while the keyboard cursor is still hidden', () => {
    // The card's own submit() reads selections, not focusedOptionIndex — a
    // person who picked an answer with the mouse and never touched an arrow
    // key must still be able to submit with Enter (single-question or
    // last-tab ask). Regression test: fails if onSubmit ever re-gates on
    // keyboardEngaged.
    const { hook, handle } = setup();
    press('Enter');
    expect(handle.submit).toHaveBeenCalled();
    expect(handle.navigateQuestion).not.toHaveBeenCalled();
    expect(hook.result.current.focusedOptionIndex).toBe(-1);
  });

  it('submits on Enter once the cursor is revealed', () => {
    const { hook, handle } = setup();
    press('ArrowDown');
    press('Enter');
    expect(handle.submit).toHaveBeenCalled();
    expect(handle.navigateQuestion).not.toHaveBeenCalled();
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
