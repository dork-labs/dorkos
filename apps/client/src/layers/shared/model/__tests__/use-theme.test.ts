/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme, useResolvedTheme, useThemeStore } from '../use-theme';

const STORAGE_KEY = 'dorkos-theme';

beforeEach(() => {
  // The store is a module singleton; reset it to a known baseline (system + a
  // light OS) and clear the root class the wiring keeps in sync.
  act(() => useThemeStore.setState({ theme: 'system', systemDark: false }));
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});
afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('useResolvedTheme', () => {
  it('returns the explicit preference for light', () => {
    act(() => useThemeStore.getState().setTheme('light'));
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('light');
  });

  it('returns the explicit preference for dark', () => {
    act(() => useThemeStore.getState().setTheme('dark'));
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('dark');
  });

  it('resolves "system" to the OS preference and updates on an OS flip', () => {
    act(() => useThemeStore.getState().setTheme('system'));
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('light');
    // The single matchMedia listener feeds an OS change through this action.
    act(() => useThemeStore.getState().setSystemDark(true));
    expect(result.current).toBe('dark');
  });
});

describe('useTheme — shared store (S2)', () => {
  it('two hook instances see the same value; setTheme in one updates the other', () => {
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useResolvedTheme());
    expect(a.result.current.theme).toBe('system');
    expect(b.result.current).toBe('light');

    act(() => a.result.current.setTheme('dark'));

    expect(a.result.current.theme).toBe('dark');
    // The OTHER instance updates too — the whole point of the shared store.
    expect(b.result.current).toBe('dark');
  });

  it('a system OS flip propagates to every consumer', () => {
    act(() => useThemeStore.getState().setTheme('system'));
    const a = renderHook(() => useResolvedTheme());
    const b = renderHook(() => useResolvedTheme());
    expect(a.result.current).toBe('light');
    expect(b.result.current).toBe('light');

    act(() => useThemeStore.getState().setSystemDark(true));

    expect(a.result.current).toBe('dark');
    expect(b.result.current).toBe('dark');
  });

  it('keeps the root .dark class in sync with the resolved theme', () => {
    act(() => useThemeStore.getState().setTheme('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => useThemeStore.getState().setTheme('light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Under "system" the resolved OS signal drives the class.
    act(() => useThemeStore.getState().setTheme('system'));
    act(() => useThemeStore.getState().setSystemDark(true));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists the preference to localStorage', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('dark'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });
});
