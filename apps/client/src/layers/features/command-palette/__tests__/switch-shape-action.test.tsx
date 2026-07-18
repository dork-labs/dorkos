/**
 * @vitest-environment jsdom
 *
 * The "Switch Shape" command-palette entry (DOR-355 §5): the contribution is
 * registered, and selecting it opens the Shape switcher.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PALETTE_QUICK_ACTIONS } from '../model/palette-contributions';
import { usePaletteActions } from '../model/use-palette-actions';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: () => ['/projects/current', vi.fn()],
}));

// Keep the real app store (so we can assert its flag) but stub the router-backed
// deep-link + report hooks the palette actions pull in.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  const inertDeepLink = {
    isOpen: false,
    activeTab: null,
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  };
  return {
    ...actual,
    useSettingsDeepLink: () => inertDeepLink,
    useTasksDeepLink: () => inertDeepLink,
    useRelayDeepLink: () => inertDeepLink,
    useReportIssue: () => vi.fn(),
  };
});

import { useAppStore } from '@/layers/shared/model';

afterEach(() => {
  useAppStore.getState().setShapeSwitcherOpen(false);
});

describe('Switch Shape palette entry', () => {
  it('registers a "Switch Shape" quick action wired to the switchShape action', () => {
    const entry = PALETTE_QUICK_ACTIONS.find((a) => a.id === 'switch-shape');
    expect(entry).toMatchObject({
      label: 'Switch Shape',
      action: 'switchShape',
      icon: 'Shapes',
      category: 'quick-action',
    });
  });

  it('opens the Shape switcher when the action fires', () => {
    expect(useAppStore.getState().shapeSwitcherOpen).toBe(false);
    const { result } = renderHook(() => usePaletteActions(vi.fn()));
    act(() => result.current.handleQuickAction('switchShape'));
    expect(useAppStore.getState().shapeSwitcherOpen).toBe(true);
  });
});
