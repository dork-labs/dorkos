/**
 * @vitest-environment jsdom
 *
 * The "Switch shape" command-palette entry (DOR-355 §5): the contribution is
 * registered, and selecting it opens the Shape switcher.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { PALETTE_QUICK_ACTIONS } from '../model/palette-contributions';
import { usePaletteActions } from '../model/use-palette-actions';

const mockTransport = createMockTransport();

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // The session resolver and the chat store come along for the slash-command
  // path; only the directory hooks are stubbed.
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/current', vi.fn()],
  useStartNewSession: () => vi.fn(),
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
    useOpenConnections: () => vi.fn(),
    useReportIssue: () => vi.fn(),
    useTransport: () => mockTransport,
  };
});

import { useAppStore } from '@/layers/shared/model';

afterEach(() => {
  useAppStore.getState().setShapeSwitcherOpen(false);
});

describe('Switch shape palette entry', () => {
  it('registers a "Switch shape" quick action wired to the switchShape action', () => {
    const entry = PALETTE_QUICK_ACTIONS.find((a) => a.id === 'switch-shape');
    expect(entry).toMatchObject({
      label: 'Switch shape',
      action: 'switchShape',
      icon: 'Shapes',
      category: 'quick-action',
    });
  });

  it('opens the Shape switcher when the action fires', () => {
    expect(useAppStore.getState().shapeSwitcherOpen).toBe(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePaletteActions(vi.fn()), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() => result.current.handleQuickAction('switchShape'));
    expect(useAppStore.getState().shapeSwitcherOpen).toBe(true);
  });
});
