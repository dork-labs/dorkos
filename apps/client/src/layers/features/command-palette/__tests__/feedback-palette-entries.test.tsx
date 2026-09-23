/**
 * @vitest-environment jsdom
 *
 * The palette's two feedback doors (DOR-2232): "Send feedback" is found by the
 * words a person reaches for, and "Your reports" exists and goes to the page.
 * A phone has no help menu, so the palette is one of the few ways there.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { PALETTE_QUICK_ACTIONS } from '../model/palette-contributions';
import { usePaletteActions } from '../model/use-palette-actions';
import { usePaletteSearch, type SearchableItem } from '../model/use-palette-search';
import { ICON_MAP } from '../ui/palette-constants';

const mockTransport = createMockTransport();
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/current', vi.fn()],
  useStartNewSession: () => vi.fn(),
}));
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

/** The quick actions as the palette's own corpus carries them. */
const corpus: SearchableItem[] = PALETTE_QUICK_ACTIONS.map((qa) => ({
  id: qa.id,
  name: qa.label,
  type: 'quick-action' as const,
  keywords: qa.keywords,
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
  scopes: [],
  data: qa,
}));

/** The top row for a query, whether it earned Best match or leads the list. */
function topLabel(query: string): string | undefined {
  const { result } = renderHook(() =>
    usePaletteSearch(corpus, query, { usage: {}, now: Date.now(), scope: null })
  );
  const top = result.current.bestMatch ?? result.current.rows[0];
  return top?.item.item.name;
}

describe('the feedback entries in the command palette', () => {
  it('labels the form "Send feedback"', () => {
    expect(PALETTE_QUICK_ACTIONS.find((a) => a.id === 'open-feedback')?.label).toBe(
      'Send feedback'
    );
  });

  it.each(['feedback', 'bug', 'report'])('puts Send feedback first for "%s"', (query) => {
    expect(topLabel(query)).toBe('Send feedback');
  });

  it('has a "Your reports" entry with an icon the palette can draw', () => {
    const entry = PALETTE_QUICK_ACTIONS.find((a) => a.id === 'your-reports');
    expect(entry).toMatchObject({ label: 'Your reports', action: 'openYourReports' });
    expect(ICON_MAP[entry?.icon ?? '']).toBeDefined();
    expect(topLabel('your reports')).toBe('Your reports');
  });

  it('takes "Your reports" to the page', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePaletteActions(vi.fn()), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() => result.current.handleQuickAction('openYourReports'));
    expect(navigate).toHaveBeenCalledWith({ to: '/feedback-requests' });
  });
});
