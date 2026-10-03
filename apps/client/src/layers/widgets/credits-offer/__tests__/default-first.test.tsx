/**
 * @vitest-environment jsdom
 */
/**
 * The default-first pattern on a runtime's connect step, end to end: the real
 * connect flow, the real credits card the app shell supplies, the real link
 * flow and the real Settings panel, over a mock transport (spec
 * `dorkos-account-by-default` §3).
 *
 * Nothing here can spend: every cloud answer is a fake the transport returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { DependencyCheck, SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { CloudCreditsStatus, CloudPlanResponse } from '@dorkos/shared/cloud-schemas';
import { cloudCreditsKeys, CreditsOfferProvider, TransportProvider } from '@/layers/shared/model';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { RuntimeConnectFlow } from '@/layers/features/runtime-connect';
import { CloudLinkPanel } from '@/layers/features/cloud-link';
import { renderCreditsOffer } from '../ui/CreditsOfferCard';

const CLI: DependencyCheck = { name: 'Claude Code CLI', description: 'cli', status: 'satisfied' };
const AUTH: DependencyCheck = {
  name: 'Claude Code authentication',
  description: 'auth',
  status: 'missing',
};

/** Requirements with Claude Code in the given sign-in state. */
function requirements(signIn: 'none' | 'expired' | 'working'): SystemRequirements {
  const auth =
    signIn === 'working'
      ? { ...AUTH, status: 'satisfied' as const }
      : signIn === 'expired'
        ? { ...AUTH, expiresAt: '2026-09-01T00:00:00.000Z' }
        : AUTH;
  return { runtimes: { 'claude-code': { dependencies: [CLI, auth] } } };
}

/** A credits report: Claude Code wired, the rest a follow-up. */
function creditsReport(over: Partial<CloudCreditsStatus> = {}): CloudCreditsStatus {
  return {
    enabled: false,
    killed: false,
    linked: false,
    ready: false,
    runtimes: { 'claude-code': 'wired', codex: 'follow-up', opencode: 'follow-up' },
    defaults: {},
    notices: [],
    ...over,
  };
}

/** A plan read whose balance has the given micro-unit figures. */
function plan(granted: string, remaining: string, added: string): CloudPlanResponse {
  return {
    available: true,
    entitlements: {} as never,
    balance: {
      allowance: {
        grantedMicro: granted,
        remainingMicro: remaining,
        resetsAt: '2026-11-01T00:00:00Z',
      },
      purchased: { remainingMicro: added },
      denomination: { unit: 'credit', microPerUnit: '1000000' },
    } as never,
  };
}

interface Setup {
  signIn?: 'none' | 'expired' | 'working';
  credits?: CloudCreditsStatus;
  linked?: boolean;
  planRead?: CloudPlanResponse;
  withSettings?: boolean;
  withSlot?: boolean;
}

function setup({
  signIn = 'none',
  credits = creditsReport(),
  linked = false,
  planRead = { available: false },
  withSettings = false,
  withSlot = true,
}: Setup = {}) {
  const transport = createMockTransport();
  vi.mocked(transport.checkRequirements).mockResolvedValue(requirements(signIn));
  vi.mocked(transport.getCloudCredits).mockResolvedValue(credits);
  vi.mocked(transport.getCloudStatus).mockResolvedValue({
    linked,
    accountLabel: linked ? 'kai@dork.dev' : null,
    lastHeartbeatAt: null,
  });
  vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: linked ? 'linked' : 'idle' });
  vi.mocked(transport.getCloudPlan).mockResolvedValue(planRead);
  vi.mocked(transport.startCloudLink).mockResolvedValue({
    userCode: 'WXYZ7890',
    verificationUri: 'https://dorkos.ai/activate',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  });
  vi.mocked(transport.setCloudCreditsDefault).mockResolvedValue(
    creditsReport({
      enabled: true,
      linked: true,
      ready: true,
      defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
    })
  );
  const onConnected = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const flow = (
    <RuntimeConnectFlow
      type="claude-code"
      connect={{ kind: 'login', label: 'Connect Claude' }}
      onConnected={onConnected}
    />
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {withSlot ? (
          <CreditsOfferProvider slot={renderCreditsOffer}>
            <div data-testid="connect-step">{flow}</div>
            {withSettings && (
              <div data-testid="settings-account">
                <CloudLinkPanel />
              </div>
            )}
          </CreditsOfferProvider>
        ) : (
          <div data-testid="connect-step">{flow}</div>
        )}
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onConnected, queryClient };
}

/** Flush promise microtasks + due timers under fake timers. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Wait until both reads the decision rests on have answered, so an absent
 * offer is absent because of the answer and not because it has not come yet.
 */
async function settled(queryClient: QueryClient) {
  await vi.waitFor(() => {
    expect(queryClient.getQueryState(cloudCreditsKeys.status())?.status).toBe('success');
    expect(queryClient.getQueryState([...REQUIREMENTS_KEY])?.status).toBe('success');
  });
  await act(async () => {});
}

/** Whether `a` comes before `b` in the document. */
function before(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('a runtime connect step with nothing working yet', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('leads with DorkOS credits, with its own sign-in and a key as visible rows under it', async () => {
    setup();
    const offer = await screen.findByRole('button', { name: 'Use DorkOS credits' });
    const signIn = screen.getByRole('button', { name: 'Sign in with Claude' });
    const key = screen.getByRole('button', { name: 'Paste a key' });
    expect(before(offer, signIn)).toBe(true);
    expect(before(signIn, key)).toBe(true);
    expect(screen.getByText('One account for Claude Code.')).toBeInTheDocument();
    // Only the runtime's own sign-in is named: Claude Code cannot run Ollama.
    expect(screen.getByTestId('keep-it-local-note')).toHaveTextContent(
      'Prefer to keep everything on this computer? Use your own sign-in.'
    );
  });

  it('signed out, starts the one link in place, and shows the same code in Settings', async () => {
    vi.useFakeTimers();
    const { transport, onConnected } = setup({ withSettings: true });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use DorkOS credits' }));
    });
    await flush();

    expect(transport.startCloudLink).toHaveBeenCalledTimes(1);
    // One code, on both surfaces.
    expect(within(screen.getByTestId('connect-step')).getByText('WXYZ7890')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('settings-account')).getByText('WXYZ7890')
    ).toBeInTheDocument();
    // Nothing is chosen before the link lands.
    expect(transport.setCloudCreditsDefault).not.toHaveBeenCalled();

    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
      state: 'linked',
      accountLabel: 'kai@dork.dev',
    });
    vi.mocked(transport.getCloudStatus).mockResolvedValue({
      linked: true,
      accountLabel: 'kai@dork.dev',
      lastHeartbeatAt: null,
    });
    await flush(2500);
    await flush(10);

    // The surface that started it carries on: the choice is made, once.
    expect(transport.setCloudCreditsDefault).toHaveBeenCalledTimes(1);
    expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', true);
    expect(onConnected).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Claude Code is ready' })
    );
  });

  it('shows a code started from Settings right here too, since there is only one', async () => {
    vi.useFakeTimers();
    const { transport } = setup({ withSettings: true });
    await flush();
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('settings-account')).getByRole('button', {
          name: /link this computer/i,
        })
      );
    });
    await flush();

    expect(transport.startCloudLink).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('connect-step')).getByText('WXYZ7890')).toBeInTheDocument();
  });

  it('signed in, makes the choice at once and starts no link', async () => {
    const { transport } = setup({
      linked: true,
      credits: creditsReport({ enabled: true, linked: true }),
    });
    const offer = await screen.findByRole('button', { name: 'Use DorkOS credits' });
    await vi.waitFor(() => expect(offer).toBeEnabled());
    fireEvent.click(offer);
    await vi.waitFor(() =>
      expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', true)
    );
    expect(transport.startCloudLink).not.toHaveBeenCalled();
  });

  it('says "Try…" for included credits never spent, and "Buy…" with nothing left, which opens the page to add credits', async () => {
    setup({
      linked: true,
      credits: creditsReport({ enabled: true, linked: true }),
      planRead: plan('5000000', '5000000', '0'),
    });
    expect(await screen.findByRole('button', { name: 'Try DorkOS credits' })).toBeInTheDocument();
    cleanup();

    vi.spyOn(window, 'open').mockReturnValue({
      document: { title: '' },
      location: { href: '' },
      close: vi.fn(),
      opener: null,
    } as unknown as Window);
    const { transport } = setup({
      linked: true,
      credits: creditsReport({ enabled: true, linked: true }),
      planRead: plan('5000000', '0', '0'),
    });
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: true,
      url: 'https://dorkos.ai/billing/topup',
    });
    const buy = await screen.findByRole('button', { name: 'Buy DorkOS credits' });
    await vi.waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);
    await vi.waitFor(() =>
      expect(transport.createCloudBillingSession).toHaveBeenCalledWith('topup', undefined)
    );
    expect(transport.setCloudCreditsDefault).not.toHaveBeenCalled();
  });
});

describe('a runtime connect step that does not lead with credits', () => {
  afterEach(cleanup);

  it('offers nothing over a working sign-in', async () => {
    const { queryClient } = setup({ signIn: 'working' });
    await settled(queryClient);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DorkOS credits/ })).not.toBeInTheDocument();
  });

  it('keeps a working sign-in first even when new work is set to run on credits', async () => {
    const { queryClient } = setup({
      signIn: 'working',
      linked: true,
      credits: creditsReport({
        enabled: true,
        linked: true,
        defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
      }),
    });
    await settled(queryClient);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('You’re ready')).not.toBeInTheDocument();
  });

  it('leads with signing in again when the sign-in expired, never with credits', async () => {
    const { queryClient } = setup({ signIn: 'expired' });
    await settled(queryClient);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DorkOS credits/ })).not.toBeInTheDocument();
  });

  it('offers nothing for a runtime credits are not wired for', async () => {
    const { queryClient } = setup({
      credits: creditsReport({
        runtimes: { 'claude-code': 'follow-up', codex: 'follow-up', opencode: 'follow-up' },
      }),
    });
    await settled(queryClient);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DorkOS credits/ })).not.toBeInTheDocument();
  });

  it('offers nothing when credits are switched off on this computer', async () => {
    const { queryClient } = setup({ credits: creditsReport({ killed: true }) });
    await settled(queryClient);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DorkOS credits/ })).not.toBeInTheDocument();
  });

  it('says "You’re ready" and shows no card once its new work runs on credits', async () => {
    setup({
      linked: true,
      credits: creditsReport({
        enabled: true,
        linked: true,
        defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'default' } },
      }),
    });
    expect(await screen.findByText('You’re ready')).toBeInTheDocument();
    expect(
      screen.getByText('New work on Claude Code runs on your DorkOS credits.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DorkOS credits/ })).not.toBeInTheDocument();
    // A repeat visit: the other ways are folded behind one quiet line.
    expect(screen.getByRole('button', { name: 'Other ways' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('shows only its own ways where the app supplies no offer', async () => {
    const { queryClient } = setup({ withSlot: false });
    await settled(queryClient);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DorkOS credits/ })).not.toBeInTheDocument();
  });
});
