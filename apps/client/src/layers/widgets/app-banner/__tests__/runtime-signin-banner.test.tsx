/**
 * @vitest-environment jsdom
 */
/**
 * The runtime-sign-in banner: when it fires, when it goes away, and the one signal it must never
 * be keyed on.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  render as rtlRender,
  renderHook,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import {
  CreditsOfferProvider,
  TransportProvider,
  type CreditsOfferSlot,
} from '@/layers/shared/model';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';

import { deadSigninRuntimes } from '../lib/dead-runtime-signins';
import { useAppBanners } from '../model/use-app-banners';
import { RuntimeSigninBanner } from '../ui/RuntimeSigninBanner';
import { BANNER_PRIORITY, type BannerDescriptor } from '../model/banner-descriptor';

// Two seams stand in, and nothing else does.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return {
    ...actual,
    useSettingsDeepLink: () => ({ open: openSettings }),
    useEventSubscription: () => undefined,
  };
});

// motion reads matchMedia (reduced-motion) which jsdom does not implement.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  openSettings.mockClear();
});

/** One `signin.required` row, as the server writes it. */
function signinRow(
  runtime: string,
  at: string,
  extra: Partial<NotificationDTO> = {}
): NotificationDTO {
  return {
    id: `n-${runtime}-${at}`,
    kind: 'signin.required',
    tier: 'blocking',
    subject: { type: 'system', id: runtime },
    title: `Your ${runtime} sign-in stopped working`,
    createdAt: at,
    ...extra,
  };
}

/**
 * The recovery row, exactly as `emitters/runtime-signin.ts` writes it: a second
 * row carrying `outcome: 'cleared'`, and already read.
 */
function recoveryRow(runtime: string, at: string): NotificationDTO {
  return signinRow(runtime, at, {
    title: `Your ${runtime} sign-in is working again`,
    resolvedAt: at,
    outcome: 'cleared',
    readAt: at,
  });
}

describe('deadSigninRuntimes', () => {
  it('names a runtime whose newest row is a raise', () => {
    expect(deadSigninRuntimes([signinRow('claude-code', '2026-09-01T10:00:00.000Z')])).toEqual([
      'claude-code',
    ]);
  });

  it('reads the newest row by timestamp, not by arrival order', () => {
    // A refetch can interleave a page with rows that arrived live. Taking the
    // first row per runtime would resurrect a sign-in that is fixed.
    const rows = [
      signinRow('claude-code', '2026-09-01T10:00:00.000Z'),
      recoveryRow('claude-code', '2026-09-01T10:05:00.000Z'),
    ];
    expect(deadSigninRuntimes(rows)).toEqual([]);
  });
});

/** A provider tree with a transport whose Inbox page the test controls. */
function harness(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A transport answering the Inbox with exactly these rows. */
function transportWith(rows: NotificationDTO[]) {
  const transport = createMockTransport();
  transport.listNotifications = vi
    .fn()
    .mockResolvedValue({ notifications: rows, nextCursor: null, unreadCount: 0 });
  return transport;
}

function findSigninDescriptor(descriptors: BannerDescriptor[]): BannerDescriptor | undefined {
  return descriptors.find((d) => d.id === 'runtime-signin');
}

describe('runtime-signin descriptor', () => {
  it('outranks every other banner and names the dead runtime', async () => {
    const transport = transportWith([signinRow('claude-code', '2026-09-01T10:00:00.000Z')]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeDefined());

    const descriptor = findSigninDescriptor(result.current)!;
    expect(descriptor.variant).toBe('critical');
    expect(descriptor.priority).toBe(BANNER_PRIORITY.critical);
    expect(descriptor.priority).toBeGreaterThan(BANNER_PRIORITY.warning);

    render(descriptor.render());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Claude Code is signed out. Its agents and tasks wait until you sign in.'
    );
  });

  it('goes away once the recovery row lands, even though it arrives already read', async () => {
    const transport = transportWith([
      recoveryRow('claude-code', '2026-09-01T10:05:00.000Z'),
      signinRow('claude-code', '2026-09-01T10:00:00.000Z'),
    ]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });

    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeUndefined());
  });
});

describe('the banner and DorkOS credits', () => {
  const stubOffer: CreditsOfferSlot = () => <p>Stand-in offer</p>;

  function renderWithCredits(auth: Partial<DependencyCheck>) {
    const transport = createMockTransport();
    vi.mocked(transport.checkRequirements).mockResolvedValue({
      runtimes: {
        'claude-code': {
          dependencies: [
            { name: 'Claude Code CLI', description: 'cli', status: 'satisfied' },
            { name: 'Claude Code authentication', description: 'auth', status: 'missing', ...auth },
          ],
        },
      },
    });
    vi.mocked(transport.getCloudCredits).mockResolvedValue({
      enabled: false,
      killed: false,
      linked: false,
      ready: false,
      runtimes: {
        'claude-code': 'wired',
        codex: 'follow-up',
        opencode: 'follow-up',
        doe: 'follow-up',
      },
    });
    vi.mocked(transport.getCloudStatus).mockResolvedValue({
      linked: false,
      accountLabel: null,
      lastHeartbeatAt: null,
    });
    const Wrapper = harness(transport);
    render(
      <Wrapper>
        <CreditsOfferProvider slot={stubOffer}>
          <RuntimeSigninBanner runtimes={['claude-code']} />
        </CreditsOfferProvider>
      </Wrapper>
    );
    return transport;
  }

  it('leads with the same words the offer inside it uses, for a runtime with no sign-in', async () => {
    renderWithCredits({});
    const trigger = await screen.findByTestId('signin-banner-credits');
    await waitFor(() => expect(trigger).toHaveTextContent('Use DorkOS credits'));
    expect(screen.getByRole('button', { name: 'Review sign-ins' })).toBeInTheDocument();
  });
});

/** Render the banner with the same account/config providers as the app shell. */
function render(node: ReactNode) {
  return rtlRender(node, { wrapper: harness(createMockTransport()) });
}

describe('account-targeted sign-in', () => {
  it('keeps Claude5 standing after Claude4 recovers', () => {
    expect(
      deadSigninRuntimes([
        signinRow('claude-code:/accounts/five', '2026-09-01T10:00:00.000Z'),
        signinRow('claude-code:/accounts/four', '2026-09-01T10:00:00.000Z'),
        recoveryRow('claude-code:/accounts/four', '2026-09-01T10:05:00.000Z'),
      ])
    ).toEqual(['claude-code:/accounts/five']);
  });

  it('says why signing in did not work, and what to do (DOR-4426)', async () => {
    const reason = 'Sign-in timed out. Finish it in the browser within 3 minutes, then try again.';
    const login = vi.fn().mockResolvedValue({ ok: false, error: reason });
    const transport = createMockTransport({
      delegateRuntimeLogin: login,
      // A listed account, so the sign-in reaches the server and gets its answer.
      getConfig: vi.fn().mockResolvedValue({
        claudeCode: {
          resolvedAccount: '/accounts/main',
          inherited: true,
          accounts: [
            {
              id: 'five',
              path: '/accounts/five',
              label: 'Claude5',
              color: '#aabbcc',
              colorIsDefault: true,
              isAccountRoot: true,
            },
          ],
        },
      }),
    });
    rtlRender(<RuntimeSigninBanner runtimes={['claude-code:/accounts/five']} />, {
      wrapper: harness(transport),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude5' }));
    expect(await screen.findByText('Couldn’t sign in to Claude5.')).toBeInTheDocument();
    expect(login).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText('Try again.')).not.toBeInTheDocument();
  });
});
