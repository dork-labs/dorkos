/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAppStore } from '@/layers/shared/model';
import { useShortcutsPanel } from '../model/use-shortcuts-panel';

describe('useShortcutsPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ shortcutsPanelOpen: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toggles shortcutsPanelOpen when ? is pressed', () => {
    renderHook(() => useShortcutsPanel());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    expect(useAppStore.getState().shortcutsPanelOpen).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    expect(useAppStore.getState().shortcutsPanelOpen).toBe(false);
  });

  it('does NOT toggle when ? is pressed inside an INPUT', () => {
    renderHook(() => useShortcutsPanel());

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent('keydown', { key: '?', bubbles: true });
    Object.defineProperty(event, 'target', { value: input });
    document.dispatchEvent(event);

    expect(useAppStore.getState().shortcutsPanelOpen).toBe(false);
    document.body.removeChild(input);
  });

  it('does NOT toggle when ? is pressed inside a TEXTAREA', () => {
    renderHook(() => useShortcutsPanel());

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    const event = new KeyboardEvent('keydown', { key: '?', bubbles: true });
    Object.defineProperty(event, 'target', { value: textarea });
    document.dispatchEvent(event);

    expect(useAppStore.getState().shortcutsPanelOpen).toBe(false);
    document.body.removeChild(textarea);
  });

  it('does NOT toggle when ? is pressed inside a contentEditable element', () => {
    renderHook(() => useShortcutsPanel());

    const div = document.createElement('div');
    div.contentEditable = 'true';
    // jsdom implements the `contentEditable` attribute but leaves
    // `isContentEditable` undefined, and the guard reads the latter — so the
    // element has to answer that question itself or this test asserts nothing.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    document.body.appendChild(div);
    div.focus();

    const event = new KeyboardEvent('keydown', { key: '?', bubbles: true });
    Object.defineProperty(event, 'target', { value: div });
    document.dispatchEvent(event);

    expect(useAppStore.getState().shortcutsPanelOpen).toBe(false);
    document.body.removeChild(div);
  });
});
