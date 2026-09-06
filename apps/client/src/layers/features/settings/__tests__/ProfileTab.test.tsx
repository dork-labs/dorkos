// @vitest-environment jsdom
/**
 * Settings › Profile — that it is FIRST, and that `?settings=profile` lands on it.
 *
 * Both halves are what the profile drawer's **Edit profile** button depends on.
 * That button already calls `useSettingsDeepLink().open('profile')`, and until
 * this tab existed `TabbedDialog` resolved the unknown id to nothing, fell back
 * to Appearance and logged a dev warning. So the tab id has to be exactly
 * `profile` — a rename to `you`, `account` or `identity` would leave the button
 * opening the wrong panel with no type error anywhere — and the warning's
 * absence is the assertion that the fallback is no longer being taken.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { SettingsDialog } from '../ui/SettingsDialog';

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../ui/DangerZoneTab', () => ({ DangerZoneTab: () => null }));
vi.mock('../ui/ServerRestartOverlay', () => ({ ServerRestartOverlay: () => null }));

/** The deep link the drawer's Edit button produces: `?settings=profile`. */
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: true,
    activeTab: 'profile',
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
}));

vi.mock('@radix-ui/react-dialog', async () => {
  const actual =
    await vi.importActual<typeof import('@radix-ui/react-dialog')>('@radix-ui/react-dialog');
  return { ...actual, Portal: ({ children }: { children: React.ReactNode }) => <>{children}</> };
});

beforeAll(() => {
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
});

afterEach(cleanup);

function renderDialog() {
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', port: 4242 }),
    getTeamRoster: vi.fn().mockResolvedValue({ members: MOCK_TEAM_ROSTER }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <SettingsDialog open onOpenChange={vi.fn()} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('Settings › Profile', () => {
  it('is the first tab in the sidebar', () => {
    renderDialog();
    expect(screen.getAllByRole('tab')[0]).toHaveTextContent('Profile');
  });

  it('is what `?settings=profile` opens, with no fallback taken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderDialog();

    // The real form, not the Appearance panel the fallback used to land on.
    expect(await screen.findByLabelText('Handle')).toBeInTheDocument();
    expect(screen.queryByText('Font family')).not.toBeInTheDocument();

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Unknown deep-link tab id'));
    warn.mockRestore();
  });
});
