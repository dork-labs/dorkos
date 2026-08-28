/**
 * @vitest-environment jsdom
 *
 * DorkBot's one line in a quiet room (team-room-home spec D5.3).
 *
 * The promises under test are the ones that make it a suggestion rather than an
 * ad: exactly one at a time, dismissing is as easy as accepting, and a dismissal
 * is remembered — the same line does not come back tomorrow morning. The real
 * app store is used deliberately here, because "it does not come back" is a
 * claim about the store's persistence, not about a mock's return value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSyncExternalStore } from 'react';
import { render, renderHook, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { PromoDefinition, PromoContext, PromoContent } from '../model/promo-types';

/** Minimal stub that satisfies the LucideIcon (ForwardRefExoticComponent) shape for tests. */
const StubIcon = forwardRef<SVGSVGElement>(() => null) as unknown as LucideIcon;

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// The app store pulls the font machinery in on import; none of it is what this
// file is about.
vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual('@/layers/shared/lib');
  return {
    ...actual,
    loadGoogleFont: vi.fn(),
    removeGoogleFont: vi.fn(),
    applyFontCSS: vi.fn(),
    removeFontCSS: vi.fn(),
    getFontConfig: () => ({ key: 'system', sans: '', mono: '', googleFontsUrl: '' }),
    isValidFontKey: () => false,
  };
});

const mockRegistry: PromoDefinition[] = [];
vi.mock('../model/promo-registry', () => ({
  get PROMO_REGISTRY() {
    return mockRegistry;
  },
}));

const mockContext: PromoContext = {
  hasAdapter: () => false,
  isTasksEnabled: false,
  isMeshEnabled: false,
  isRelayEnabled: false,
  sessionCount: 0,
  agentCount: 0,
  taskCount: 0,
  daysSinceFirstUse: 0,
  isDesktopApp: false,
  remoteAccessConfigured: false,
};
// Dismissals are config now (spec `sidebar-simplification` D4). The fake keeps
// the ONE list both surfaces read, which is the property the cross-surface case
// below is about — mocking two independent lists would make it vacuous. It is
// REACTIVE for the same reason the real hook is: the real one reads a query, so
// dismissing re-renders every reader. A plain mutable array would leave the
// card on screen after the press and the "goes away when dismissed" case would
// be asserting against a stale render rather than the behaviour.
let mockDismissedIds: string[] = [];
const dismissalListeners = new Set<() => void>();
vi.mock('@/layers/entities/config', () => ({
  usePromoDismissals: () => ({
    dismissedIds: useSyncExternalStore(
      (onChange: () => void) => {
        dismissalListeners.add(onChange);
        return () => dismissalListeners.delete(onChange);
      },
      () => mockDismissedIds
    ),
    dismissPromo: (id: string) => {
      if (mockDismissedIds.includes(id)) return;
      mockDismissedIds = [...mockDismissedIds, id];
      for (const listener of dismissalListeners) listener();
    },
  }),
}));

vi.mock('../model/use-promo-context', () => ({
  usePromoContext: () => mockContext,
}));

import { useAppStore } from '@/layers/shared/model';
import { usePromoSlot } from '../model/use-promo-slot';
import { QuietSuggestion } from '../ui/QuietSuggestion';

function makePromo(
  overrides: Partial<Omit<PromoDefinition, 'content'>> & {
    id: string;
    content?: Partial<PromoContent>;
  }
): PromoDefinition {
  const { content, ...rest } = overrides;
  return {
    placements: ['dashboard-sidebar'],
    priority: 50,
    shouldShow: () => true,
    content: {
      icon: StubIcon,
      title: 'Run agents on a schedule',
      shortDescription: 'Set a schedule and come back to finished work',
      ctaLabel: 'Set up',
      suggestion: {
        question: 'Want your agents working without you at the keyboard?',
        action: 'Set up a schedule',
      },
      ...content,
    },
    action: { type: 'action', handler: () => {} },
    ...rest,
  };
}

/** The suggestion line, or `null` when it drew nothing at all. */
function suggestionLine(): HTMLElement | null {
  return document.querySelector('[data-slot="quiet-suggestion"]');
}

beforeEach(() => {
  mockRegistry.length = 0;
  localStorageMock.clear();
  mockDismissedIds = [];
  useAppStore.setState({ promoEnabled: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QuietSuggestion', () => {
  it('offers one line: the question, and the thing it would do', () => {
    mockRegistry.push(makePromo({ id: 'schedules' }));
    render(<QuietSuggestion />);

    expect(
      screen.getByText('Want your agents working without you at the keyboard?')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up a schedule' })).toBeInTheDocument();
  });

  it('draws exactly one line when two suggestions qualify', () => {
    mockRegistry.push(
      makePromo({ id: 'schedules', priority: 90 }),
      makePromo({
        id: 'relay',
        priority: 80,
        content: { suggestion: { question: 'Want a ping in Slack?', action: 'Set it up' } },
      })
    );
    render(<QuietSuggestion />);

    expect(document.querySelectorAll('[data-slot="quiet-suggestion"]')).toHaveLength(1);
    expect(screen.queryByText('Want a ping in Slack?')).not.toBeInTheDocument();
  });

  it('emits no DOM at all when nothing qualifies — not even an empty container', () => {
    mockRegistry.push(makePromo({ id: 'schedules', shouldShow: () => false }));
    const { container } = render(<QuietSuggestion />);

    expect(suggestionLine()).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('runs the promo when the action is pressed', () => {
    const handler = vi.fn();
    mockRegistry.push(makePromo({ id: 'schedules', action: { type: 'action', handler } }));
    render(<QuietSuggestion />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up a schedule' }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('opens the promo dialog when the action is pressed', () => {
    function StubDialog({ open }: { open: boolean }) {
      return open ? <div data-testid="promo-dialog" /> : null;
    }
    mockRegistry.push(
      makePromo({ id: 'schedules', action: { type: 'open-dialog', component: StubDialog } })
    );
    render(<QuietSuggestion />);

    expect(screen.queryByTestId('promo-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up a schedule' }));
    expect(screen.getByTestId('promo-dialog')).toBeInTheDocument();
  });

  it('names what it is dismissing, so the X is not a mystery to a screen reader', () => {
    mockRegistry.push(makePromo({ id: 'schedules' }));
    render(<QuietSuggestion />);

    expect(
      screen.getByRole('button', { name: 'Dismiss suggestion: Run agents on a schedule' })
    ).toBeInTheDocument();
  });

  it('goes away when dismissed, and does not come back on a fresh mount', () => {
    mockRegistry.push(makePromo({ id: 'schedules' }));
    const view = render(<QuietSuggestion />);

    fireEvent.click(screen.getByRole('button', { name: /^Dismiss suggestion/ }));
    expect(suggestionLine()).toBeNull();

    // Tomorrow morning: a new page, the same registry, the same install.
    view.unmount();
    render(<QuietSuggestion />);
    expect(suggestionLine()).toBeNull();

    // And it is recorded, not merely hidden — the same one list every promo
    // surface reads. Where that list is DURABLE is a different unit's job now:
    // it used to be this browser's localStorage, and it is the person's config,
    // proven in `entities/config/__tests__/use-promo-dismissals.test.tsx`.
    expect(mockDismissedIds).toEqual(['schedules']);
  });

  it('dismissing is one press, exactly like accepting', () => {
    mockRegistry.push(makePromo({ id: 'schedules' }));
    render(<QuietSuggestion />);

    // No confirmation step, no "are you sure", no menu to open first.
    const dismiss = screen.getByRole('button', { name: /^Dismiss suggestion/ });
    fireEvent.click(dismiss);
    expect(mockDismissedIds).toEqual(['schedules']);
  });

  it('takes the matching card out of the sidebar too — no means no everywhere', () => {
    mockRegistry.push(makePromo({ id: 'schedules', placements: ['dashboard-sidebar'] }));
    // The card slot agrees the promo qualifies, before anybody says anything.
    const before = renderHook(() => usePromoSlot('dashboard-sidebar', 1));
    expect(before.result.current.map((p) => p.id)).toEqual(['schedules']);
    before.unmount();

    render(<QuietSuggestion />);
    fireEvent.click(screen.getByRole('button', { name: /^Dismiss suggestion/ }));

    // Saying no to the sentence is saying no to the card: one dismissal list,
    // one answer, both surfaces.
    const after = renderHook(() => usePromoSlot('dashboard-sidebar', 1));
    expect(after.result.current).toEqual([]);
  });
});
