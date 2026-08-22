// @vitest-environment jsdom
/**
 * The guard that keeps a menu-launched inline editor alive while the menu that
 * opened it comes apart (DOR-1371).
 *
 * **What jsdom can and cannot say here.** It cannot reproduce the defect: the
 * blur that killed these editors came from Radix restoring focus during a real
 * close sequence, which is exactly the part jsdom does not run — the item passed
 * its unit tests for a release while doing nothing in the product. What jsdom
 * CAN pin is the rule the browser fix is made of, one branch at a time, so a
 * later edit cannot quietly widen it into "never close on blur".
 *
 * @module shared/model/__tests__/use-inline-editor-settle
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { FocusEvent } from 'react';
import { useInlineEditorSettle } from '../use-inline-editor-settle';

/** A blur handing focus to `relatedTarget`, shaped as React delivers it. */
function blur(relatedTarget: Element | null): FocusEvent<HTMLElement> {
  return { relatedTarget } as unknown as FocusEvent<HTMLElement>;
}

/** An element inside an open Radix menu surface. */
function menuItem(): HTMLElement {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  const item = document.createElement('div');
  menu.append(item);
  document.body.append(menu);
  return item;
}

describe('useInlineEditorSettle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** The hook over a real focusable input, so reclaiming focus is observable. */
  function mount() {
    const input = document.createElement('input');
    document.body.append(input);
    const ref = { current: input as HTMLElement | null };
    const { result } = renderHook(() => useInlineEditorSettle(ref));
    return { input, settle: result.current };
  }

  it('ignores a blur that hands focus to nothing, and takes it back', () => {
    const { input, settle } = mount();
    expect(settle.shouldHandleBlur(blur(null))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.activeElement).toBe(input);
  });

  it('ignores a blur that hands focus back into the menu', () => {
    // The submenu case, and the one a `relatedTarget === null` test alone
    // missed: Radix restores focus INTO its own content on the way out.
    const { input, settle } = mount();
    expect(settle.shouldHandleBlur(blur(menuItem()))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.activeElement).toBe(input);
  });

  it('acts on a blur that hands focus to a real control', () => {
    // The rule must not become "never close on blur": clicking anything else is
    // the reader moving on, and the editor closes as it always did.
    const other = document.createElement('button');
    document.body.append(other);
    const { settle } = mount();
    expect(settle.shouldHandleBlur(blur(other))).toBe(true);
  });

  it('acts on a second blur, so a menu cannot hold focus in a loop', () => {
    const { settle } = mount();
    expect(settle.shouldHandleBlur(blur(null))).toBe(false);
    expect(settle.shouldHandleBlur(blur(null))).toBe(true);
  });

  it('acts on a blur once the editor has been open long enough to read', () => {
    const { settle } = mount();
    vi.advanceTimersByTime(2_000);
    expect(settle.shouldHandleBlur(blur(null))).toBe(true);
  });
});
