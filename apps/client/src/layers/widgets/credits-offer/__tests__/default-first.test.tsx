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
import type { ReactNode } from 'react';
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

/** Requirements with a runtime (Claude Code unless named) in the given sign-in state. */
function requirements(
  signIn: 'none' | 'expired' | 'working',
  runtime = 'claude-code'
): SystemRequirements {
  const auth =
    signIn === 'working'
      ? { ...AUTH, status: 'satisfied' as const }
      : signIn === 'expired'
        ? { ...AUTH, expiresAt: '2026-09-01T00:00:00.000Z' }
        : AUTH;
  return { runtimes: { [runtime]: { dependencies: [CLI, auth] } } };
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
  /** A browser that is not on the computer DorkOS runs on. */
  remote?: boolean;
  /** Draw this in place of the connect step (a harness for the card alone). */
  content?: ReactNode;
  /** The runtime whose connect step is drawn; Claude Code unless named. */
  runtime?: string;
}

function setup({
  signIn = 'none',
  credits = creditsReport(),
  linked = false,
  planRead = { available: false },
  withSettings = false,
  withSlot = true,
  remote = false,
  content,
  runtime = 'claude-code',
}: Setup = {}) {
  const transport = createMockTransport();
  if (remote) {
    vi.mocked(transport.getConfig).mockResolvedValue({
      version: '1.0.0',
      isLocalCaller: false,
      port: 4242,
    } as never);
  }
  vi.mocked(transport.checkRequirements).mockResolvedValue(requirements(signIn, runtime));
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
  const flow = content ?? (
    <RuntimeConnectFlow
      type={runtime}
      connect={{ kind: 'login', label: 'Connect Claude' }}
      onConnected={onConnected}
    />
  );
  const tree = (showFlow: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {withSlot ? (
          <CreditsOfferProvider slot={renderCreditsOffer}>
            {showFlow && <div data-testid="connect-step">{flow}</div>}
            {withSettings && (
              <div data-testid="settings-account">
                <CloudLinkPanel />
              </div>
            )}
          </CreditsOfferProvider>
        ) : (
          showFlow && <div data-testid="connect-step">{flow}</div>
        )}
      </TransportProvider>
    </QueryClientProvider>
  );
  const view = render(tree(true));
  /** Take the connect step off screen, leaving Settings where it is. */
  const hideFlow = () => view.rerender(tree(false));
  return { transport, onConnected, queryClient, hideFlow };
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
      approvedCode: 'WXYZ7890',
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

  // Codex can't search the web on credits, and every place that can move it
  // there says so (DOR-2679).
  it('says what Codex does not get on credits, on the card and once it runs on them', async () => {
    const wiredCodex = { 'claude-code': 'wired', codex: 'wired', opencode: 'follow-up' } as const;
    setup({ runtime: 'codex', credits: creditsReport({ runtimes: wiredCodex }) });
    expect(await screen.findByTestId('credits-offer-caveat')).toHaveTextContent(
      "Codex can't search the web on DorkOS credits."
    );
    cleanup();
    setup({
      runtime: 'codex',
      linked: true,
      credits: creditsReport({
        enabled: true,
        linked: true,
        runtimes: wiredCodex,
        defaults: { codex: { runsOn: 'credits', chosenBy: 'user' } },
      }),
    });
    expect(await screen.findByText('You’re ready')).toBeInTheDocument();
    expect(screen.getByTestId('credits-ready-codex')).toHaveTextContent(
      "New work on Codex runs on your DorkOS credits. Codex can't search the web on DorkOS credits."
    );
  });

  it('shows only its own ways where the app supplies no offer', async () => {
    const { queryClient } = setup({ withSlot: false });
    await settled(queryClient);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DorkOS credits/ })).not.toBeInTheDocument();
  });
});

/** Let the next poll say the code was approved. */
function approve(transport: Transport) {
  vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
    state: 'linked',
    accountLabel: 'kai@dork.dev',
    approvedCode: 'WXYZ7890',
  });
  vi.mocked(transport.getCloudStatus).mockResolvedValue({
    linked: true,
    accountLabel: 'kai@dork.dev',
    lastHeartbeatAt: null,
  });
}

describe('what happens once the link lands', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does nothing when the surface that started it is no longer on screen', async () => {
    vi.useFakeTimers();
    const { transport, hideFlow } = setup({ withSettings: true });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use DorkOS credits' }));
    });
    await flush();
    hideFlow();
    approve(transport);
    await flush(2500);
    await flush(10);

    expect(screen.getByText('kai@dork.dev')).toBeInTheDocument();
    expect(transport.setCloudCreditsDefault).not.toHaveBeenCalled();
  });

  it('does nothing for a code another surface started, even with this one on screen', async () => {
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
    approve(transport);
    await flush(2500);
    await flush(10);

    expect(transport.setCloudCreditsDefault).not.toHaveBeenCalled();
  });

  it('does nothing in another tab, which never started the code', async () => {
    vi.useFakeTimers();
    // This tab: the offer on screen, nothing started here.
    const { transport } = setup();
    await flush();
    // The server reports a link pending (another tab started it), then approved.
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'pending' });
    await flush(2500);
    approve(transport);
    await flush(2500);
    await flush(10);

    expect(transport.setCloudCreditsDefault).not.toHaveBeenCalled();
  });

  it('asks before a choice that spends, and spends only when told to', async () => {
    vi.useFakeTimers();
    const spend = vi.fn();
    const { transport } = setup({
      content: renderCreditsOffer({
        runtime: 'claude-code',
        origin: 'harness',
        onChoose: spend,
        confirmAfterLink: { prompt: 'Linked. Send again on DorkOS credits?', action: 'Send again' },
      }),
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use DorkOS credits' }));
    });
    await flush();
    approve(transport);
    await flush(2500);
    await flush(10);

    expect(screen.getByText('Linked. Send again on DorkOS credits?')).toBeInTheDocument();
    expect(spend).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    });
    await flush(10);
    expect(spend).toHaveBeenCalledTimes(1);
  });
});

describe('two tabs, one code', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** One tab: its own query cache over the one server both tabs talk to. */
  function tab(transport: Transport, testId: string) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <CreditsOfferProvider slot={renderCreditsOffer}>
            <div data-testid={testId}>
              <RuntimeConnectFlow
                type="claude-code"
                connect={{ kind: 'login', label: 'Connect Claude' }}
              />
            </div>
          </CreditsOfferProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  it("never carries on in one tab when the other tab's code is approved", async () => {
    vi.useFakeTimers();
    const { transport } = setup({ content: <></> });
    cleanup();
    const second = {
      userCode: 'CODE2222',
      verificationUri: 'https://dorkos.ai/activate',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
    tab(transport, 'tab-a');
    tab(transport, 'tab-b');
    await flush(10);
    await flush(10);

    // Tab A starts CODE1 (WXYZ7890).
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('tab-a')).getByRole('button', { name: 'Use DorkOS credits' })
      );
    });
    await flush();
    expect(within(screen.getByTestId('tab-a')).getByText('WXYZ7890')).toBeInTheDocument();
    // Tab B starts CODE2, which replaces it on the server.
    vi.mocked(transport.startCloudLink).mockResolvedValue(second);
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('tab-b')).getByRole('button', { name: 'Use DorkOS credits' })
      );
    });
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
      state: 'pending',
      pending: second,
    });
    await flush(2500);
    await flush(10);
    // Both tabs now show the one code the server is waiting on.
    expect(within(screen.getByTestId('tab-a')).getByText('CODE2222')).toBeInTheDocument();

    // CODE2 is approved. Only tab B, which started it, carries on.
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
      state: 'linked',
      accountLabel: 'kai@dork.dev',
      approvedCode: 'CODE2222',
    });
    vi.mocked(transport.getCloudStatus).mockResolvedValue({
      linked: true,
      accountLabel: 'kai@dork.dev',
      lastHeartbeatAt: null,
    });
    await flush(2500);
    await flush(10);
    await flush(10);

    expect(transport.setCloudCreditsDefault).toHaveBeenCalledTimes(1);
  });
});

describe('before choosing, the account is read again', () => {
  afterEach(cleanup);

  it('never moves onto credits the account no longer has: it offers to add some instead', async () => {
    const { transport } = setup({
      linked: true,
      credits: creditsReport({ enabled: true, linked: true }),
      planRead: plan('5000000', '5000000', '0'),
    });
    const offer = await screen.findByRole('button', { name: 'Try DorkOS credits' });
    await vi.waitFor(() => expect(offer).toBeEnabled());
    vi.mocked(transport.getCloudPlan).mockResolvedValue(plan('5000000', '0', '0'));
    fireEvent.click(offer);

    expect(
      await screen.findByText('Your DorkOS account has no credits left to spend.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy DorkOS credits' })).toBeInTheDocument();
    expect(transport.setCloudCreditsDefault).not.toHaveBeenCalled();
  });

  it('holds the button while a signed-in plan is still loading, rather than guess', async () => {
    const { transport } = setup({
      linked: true,
      credits: creditsReport({ enabled: true, linked: true }),
    });
    vi.mocked(transport.getCloudPlan).mockReturnValue(new Promise(() => {}));
    const offer = await screen.findByRole('button', { name: /Checking your DorkOS credits/ });
    expect(offer).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Use DorkOS credits' })).not.toBeInTheDocument();
  });
});

describe('where the offer sits', () => {
  afterEach(cleanup);

  it('is offered on a phone too, with the notice standing in for signing in here', async () => {
    const { queryClient } = setup({ remote: true });
    await settled(queryClient);
    expect(await screen.findByRole('button', { name: 'Use DorkOS credits' })).toBeInTheDocument();
    expect(screen.getByTestId('remote-signin-notice')).toBeInTheDocument();
    // "This computer" would be the phone: the line names the right one.
    expect(screen.getByTestId('keep-it-local-note')).toHaveTextContent(
      'Prefer everything on the computer DorkOS runs on? Use your own sign-in there.'
    );
    expect(screen.queryByRole('button', { name: /Sign in with Claude/ })).not.toBeInTheDocument();
  });

  it('keeps a person’s "no": their own sign-in leads, credits are a row under it', async () => {
    setup({
      credits: creditsReport({
        defaults: { 'claude-code': { runsOn: 'own-sign-in', chosenBy: 'user' } },
      }),
    });
    const signIn = await screen.findByRole('button', { name: 'Sign in' });
    const offer = await screen.findByRole('button', { name: 'Use DorkOS credits' });
    expect(before(signIn, offer)).toBe(true);
    expect(screen.queryByTestId('default-first-claude-code')).not.toBeInTheDocument();
  });
});
