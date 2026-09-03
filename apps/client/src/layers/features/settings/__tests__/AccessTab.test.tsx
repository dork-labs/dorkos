// @vitest-environment jsdom
/**
 * The merged Access tab (DOR-1758).
 *
 * Security and DorkOS account were two sidebar rows, two icons and two panel
 * headers for one question — who may get into this install, and as whom — with a
 * 12-line and a 14-line wrapper for a body. They are two sections of one tab
 * now, and the two links people already have keep landing on their own half.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';

// The Security panel carries the standing-permissions block, which subscribes to
// the global event stream. This suite mounts the tab without the app shell, so
// there is no provider — stubbing the subscription keeps it about the tab.
const deepLink = vi.hoisted(() => ({ section: null as string | null }));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
    useSettingsDeepLink: () => ({
      isOpen: true,
      activeTab: 'access',
      section: deepLink.section,
      open: vi.fn(),
      close: vi.fn(),
      setTab: vi.fn(),
      setSection: vi.fn(),
    }),
  };
});

import { TransportProvider } from '@/layers/shared/model';
import { AccessTab } from '../ui/AccessTab';

function createWrapper() {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/tmp',
      nodeVersion: 'v22.0.0',
      auth: { enabled: false },
    }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  deepLink.section = null;
  cleanup();
});

describe('AccessTab', () => {
  it('holds both halves of the access question, each under its own heading', async () => {
    render(<AccessTab />, { wrapper: createWrapper() });

    expect(await screen.findByRole('heading', { name: 'On this machine' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'DorkOS account' })).toBeInTheDocument();
    // Local login, from the auth slice.
    expect(screen.getByText('Require login')).toBeInTheDocument();
  });

  it('anchors each section so an old link can scroll to the half it named', () => {
    const { container } = render(<AccessTab />, { wrapper: createWrapper() });

    // The scroll hook looks the section up by this attribute; without it the
    // legacy `?settings=account` bookmark lands at the top of the tab instead of
    // on the account section.
    expect(container.querySelector('[data-section="security"]')).not.toBeNull();
    expect(container.querySelector('[data-section="account"]')).not.toBeNull();
  });

  it('scrolls to the section a legacy deep link named, not just to some element with the attribute', async () => {
    // The test above only proved the attributes exist; it never set
    // `deepLink.section`, so `useDeepLinkScroll` never actually ran. This
    // drives the real path: `?settings=account` resolves to `section: 'account'`
    // here, and the hook has to find and scroll THAT section, not "security"
    // (review nit).
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
    deepLink.section = 'account';

    const { container } = render(<AccessTab />, { wrapper: createWrapper() });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    // `this` on the spy's call is the element `scrollIntoView` was invoked on.
    expect(scrollIntoViewSpy.mock.instances[0]).toBe(
      container.querySelector('[data-section="account"]')
    );
  });
});
