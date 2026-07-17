// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMenuCloseFocusGuard } from '../use-menu-close-focus-guard';

/**
 * Regression guard for DOR-329: menu-launched inline editors (group create,
 * group rename) were self-destructing because Radix restores focus to the menu
 * trigger when the menu closes, blurring the just-mounted editor whose
 * blur-cancel then unmounts it. jsdom cannot reproduce the native focus-restore
 * race end-to-end in every variant, so this pins the guard's contract directly:
 * armed closes are prevented exactly once; unarmed closes behave normally.
 */
describe('useMenuCloseFocusGuard', () => {
  function makeEvent() {
    const event = new Event('closeAutoFocus', { cancelable: true });
    return event;
  }

  it('does not prevent focus restore when unarmed (normal dismissal)', () => {
    const { result } = renderHook(() => useMenuCloseFocusGuard());
    const event = makeEvent();
    result.current.onCloseAutoFocus(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('prevents focus restore when armed', () => {
    const { result } = renderHook(() => useMenuCloseFocusGuard());
    result.current.arm();
    const event = makeEvent();
    result.current.onCloseAutoFocus(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('is one-shot: the close after an armed close restores focus normally', () => {
    const { result } = renderHook(() => useMenuCloseFocusGuard());
    result.current.arm();
    result.current.onCloseAutoFocus(makeEvent());

    const second = makeEvent();
    result.current.onCloseAutoFocus(second);
    expect(second.defaultPrevented).toBe(false);
  });
});
