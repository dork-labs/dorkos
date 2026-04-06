import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDialogTabState } from '../use-dialog-tab-state';

type TestTab = 'general' | 'advanced' | 'tools';

describe('useDialogTabState', () => {
  it('returns defaultTab as the active tab when initialTab is null', () => {
    const { result } = renderHook(() =>
      useDialogTabState<TestTab>({ open: true, initialTab: null, defaultTab: 'general' })
    );

    expect(result.current[0]).toBe('general');
  });

  it('returns initialTab as the active tab when initialTab is provided', () => {
    const { result } = renderHook(() =>
      useDialogTabState<TestTab>({ open: true, initialTab: 'advanced', defaultTab: 'general' })
    );

    expect(result.current[0]).toBe('advanced');
  });

  it('updates the active tab when setActiveTab is called', () => {
    const { result } = renderHook(() =>
      useDialogTabState<TestTab>({ open: true, initialTab: null, defaultTab: 'general' })
    );

    act(() => {
      result.current[1]('tools');
    });

    expect(result.current[0]).toBe('tools');
  });

  it('re-syncs to initialTab when the dialog re-opens', () => {
    const { result, rerender } = renderHook(
      ({ open, initialTab }: { open: boolean; initialTab: TestTab | null }) =>
        useDialogTabState<TestTab>({ open, initialTab, defaultTab: 'general' }),
      { initialProps: { open: true, initialTab: 'advanced' as TestTab | null } }
    );

    // User navigates away from the initialTab
    act(() => {
      result.current[1]('tools');
    });
    expect(result.current[0]).toBe('tools');

    // Dialog closes
    rerender({ open: false, initialTab: 'advanced' });

    // Dialog re-opens — should re-sync to initialTab
    rerender({ open: true, initialTab: 'advanced' });
    expect(result.current[0]).toBe('advanced');
  });

  it('does not re-sync when the dialog re-opens with initialTab null', () => {
    const { result, rerender } = renderHook(
      ({ open, initialTab }: { open: boolean; initialTab: TestTab | null }) =>
        useDialogTabState<TestTab>({ open, initialTab, defaultTab: 'general' }),
      { initialProps: { open: true, initialTab: null as TestTab | null } }
    );

    // User navigates to tools
    act(() => {
      result.current[1]('tools');
    });
    expect(result.current[0]).toBe('tools');

    // Dialog closes then re-opens with no initialTab
    rerender({ open: false, initialTab: null });
    rerender({ open: true, initialTab: null });

    // Active tab should remain at whatever the user left it on (tools)
    expect(result.current[0]).toBe('tools');
  });

  it('preserves the user-selected tab while the dialog stays open', () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useDialogTabState<TestTab>({ open, initialTab: 'advanced', defaultTab: 'general' }),
      { initialProps: { open: true } }
    );

    // User navigates to tools
    act(() => {
      result.current[1]('tools');
    });
    expect(result.current[0]).toBe('tools');

    // Dialog stays open — a prop change that doesn't toggle `open` should not reset the tab
    rerender({ open: true });
    expect(result.current[0]).toBe('tools');
  });
});
