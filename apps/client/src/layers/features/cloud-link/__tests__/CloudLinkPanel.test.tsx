/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockConnectionReadiness, createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { connectorKeys } from '@/layers/entities/connectors';
import { CloudLinkPanel } from '../ui/CloudLinkPanel';

function renderPanel(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Intentionally NO AuthClientProvider / AuthGuard — the panel must render with
  // local login disabled and unconfigured.
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CloudLinkPanel />
      </TransportProvider>
    </QueryClientProvider>
  );
  return queryClient;
}

/** Flush pending promise microtasks + due timers under fake timers. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('CloudLinkPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders with local auth disabled (no AuthGuard / session dependency)', async () => {
    const transport = createMockTransport();
    renderPanel(transport);
    // The section and its entry point render off the transport alone. The
    // panel does not title itself — the Settings dialog draws that heading
    // (DOR-918) — so the explainer is what identifies the section here.
    expect(screen.getByText(/link this instance to a dorkos account/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /link this instance/i })).toBeInTheDocument();
  });

  it('link flow: shows the user code + activation link, then the account label in place when linked', async () => {
    vi.useFakeTimers();
    const transport = createMockTransport();
    vi.mocked(transport.startCloudLink).mockResolvedValue({
      userCode: 'WXYZ7890',
      verificationUri: 'https://dorkos.ai/activate',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    const cache = renderPanel(transport);
    cache.setQueryData(connectorKeys.catalog('gmail'), { pages: [] });
    cache.setQueryData(connectorKeys.providers(), []);

    await flush();
    const linkBtn = screen.getByRole('button', { name: /link this instance/i });

    // Subsequent status polls report the linked outcome.
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
      state: 'linked',
      accountLabel: 'kai@dork.dev',
    });

    // fireEvent (not userEvent) — userEvent's internal delays deadlock under fake timers.
    await act(async () => {
      fireEvent.click(linkBtn);
    });
    await flush();

    // Pending: the code and the activation link are shown.
    expect(screen.getByText('WXYZ7890')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open the approval page/i })).toBeInTheDocument();

    // Poll fires → linked. Same panel instance updates in place.
    await flush(2500);
    expect(screen.getByText('kai@dork.dev')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlink/i })).toBeInTheDocument();
    expect(cache.getQueryState(connectorKeys.catalog('gmail'))?.isInvalidated).toBe(true);
    expect(cache.getQueryState(connectorKeys.providers())?.isInvalidated).toBe(true);
  });

  it('expired: renders the copy and a "Generate a new code" action', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'expired' });
    renderPanel(transport);

    expect(await screen.findByText(/your code expired/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate a new code/i })).toBeInTheDocument();
  });

  it('denied: renders the copy and a retry action', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'denied' });
    renderPanel(transport);

    expect(await screen.findByText(/link request denied/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('revoked: renders "This instance was unlinked" and a re-link action', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'unlinked' });
    renderPanel(transport);

    expect(await screen.findByText(/this instance was unlinked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /link again/i })).toBeInTheDocument();
  });

  it('linked: unlink calls the endpoint after confirmation and returns to idle', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getCloudStatus).mockResolvedValue({
      linked: true,
      accountLabel: 'kai@dork.dev',
      lastHeartbeatAt: new Date().toISOString(),
    });
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    const cache = renderPanel(transport);
    cache.setQueryData(connectorKeys.catalog('gmail'), { pages: [] });
    cache.setQueryData(connectorKeys.providers(), []);

    // Linked view from the settled summary.
    expect(await screen.findByText('kai@dork.dev')).toBeInTheDocument();

    // Open the confirmation and confirm.
    await user.click(screen.getByRole('button', { name: /unlink this instance/i }));
    const confirm = await screen.findByRole('button', { name: /^unlink$/i });
    await user.click(confirm);

    await waitFor(() => expect(transport.unlinkCloud).toHaveBeenCalledTimes(1));
    expect(cache.getQueryState(connectorKeys.catalog('gmail'))?.isInvalidated).toBe(true);
    expect(cache.getQueryState(connectorKeys.providers())?.isInvalidated).toBe(true);
    // Returns to the unlinked/idle entry point.
    expect(await screen.findByRole('button', { name: /link this instance/i })).toBeInTheDocument();
  });

  it('linked: the unlink confirm lists every app that stops and carries the count', async () => {
    const user = userEvent.setup();
    const base = {
      providerInstanceId: 'cpi_managed',
      identityHint: null,
      authenticationStatus: 'active',
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      mode: 'managed',
      custody: 'managed',
      payer: 'dorkos_managed',
      subscriptionCount: 0,
      usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
      readiness: createMockConnectionReadiness(),
    } as const;
    const transport = createMockTransport({
      getCloudStatus: vi.fn().mockResolvedValue({
        linked: true,
        accountLabel: 'kai@dork.dev',
        lastHeartbeatAt: null,
      }),
      getConnectorConnections: vi.fn().mockResolvedValue({
        connections: [
          {
            ...base,
            connectionId: 'a',
            toolkit: 'gmail',
            label: 'work',
            lifecycle: 'connected',
            agentCount: 2,
            everyAgent: null,
          },
          {
            ...base,
            connectionId: 'b',
            toolkit: 'notion',
            label: 'team',
            lifecycle: 'connected',
            agentCount: 1,
            everyAgent: null,
          },
          {
            ...base,
            connectionId: 'c',
            toolkit: 'linear',
            label: 'me',
            lifecycle: 'paused',
            agentCount: 0,
            everyAgent: null,
            readiness: createMockConnectionReadiness({
              state: 'paused',
              reason: 'paused',
              fix: { action: 'resume', fixableBy: 'person' },
            }),
          },
          // Through the person's own key, so unlinking does not touch it.
          {
            ...base,
            connectionId: 'd',
            toolkit: 'github',
            label: 'me',
            lifecycle: 'connected',
            agentCount: 1,
            everyAgent: null,
            mode: 'byo',
            payer: 'operator_byo',
          },
        ],
      }),
    });
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: /unlink this instance/i }));
    const confirm = await screen.findByRole('button', { name: 'Unlink and stop 2 apps' });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('These 2 apps will stop working for every agent:');
    expect(dialog).toHaveTextContent('Gmail (work) · used by 2 agents');
    expect(dialog).toHaveTextContent('Notion (team) · used by 1 agent');
    // Paused already: listed honestly, not counted as a loss.
    expect(dialog).toHaveTextContent('This app can’t be used now either way:');
    expect(dialog).toHaveTextContent('Linear (me)');
    expect(dialog).not.toHaveTextContent('Github');
    await user.click(confirm);
    await waitFor(() => expect(transport.unlinkCloud).toHaveBeenCalledTimes(1));
  });

  it('opens the activation page only for an http(s) verification URL, with the code pre-filled', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const transport = createMockTransport();
    vi.mocked(transport.startCloudLink).mockResolvedValue({
      userCode: 'WXYZ7890',
      verificationUri: 'https://dorkos.ai/activate',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: /link this instance/i }));
    await user.click(await screen.findByRole('button', { name: /open the approval page/i }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(openSpy.mock.calls[0][0] as string);
    expect(openedUrl.protocol).toBe('https:');
    expect(openedUrl.searchParams.get('code')).toBe('WXYZ7890');
    openSpy.mockRestore();
  });

  it('opt-in checkbox writes telemetry.linkAnalyticsToAccount BEFORE the link handshake fires', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    vi.mocked(transport.startCloudLink).mockResolvedValue({
      userCode: 'WXYZ7890',
      verificationUri: 'https://dorkos.ai/activate',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    renderPanel(transport);

    // The consent checkbox is off by default.
    const checkbox = await screen.findByRole('checkbox', {
      name: /connect this app’s usage data/i,
    });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: /link this instance/i }));

    // The flag was persisted with the opt-in value.
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        telemetry: { linkAnalyticsToAccount: true },
      })
    );
    // And the config write landed BEFORE the link handshake (order matters: the
    // descriptor is built server-side at link time).
    const writeOrder = vi.mocked(transport.updateConfig).mock.invocationCallOrder[0];
    const linkOrder = vi.mocked(transport.startCloudLink).mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(linkOrder);
  });

  it('defaults the opt-in off and writes false when the box is left unchecked', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    vi.mocked(transport.startCloudLink).mockResolvedValue({
      userCode: 'WXYZ7890',
      verificationUri: 'https://dorkos.ai/activate',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: /link this instance/i }));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        telemetry: { linkAnalyticsToAccount: false },
      })
    );
  });

  it('fails closed when the consent write fails: no link starts and an error shows', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    // The consent write fails (e.g. transient network error to the local server).
    vi.mocked(transport.updateConfig).mockRejectedValue(new Error('write failed'));
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: /link this instance/i }));

    // The failure surfaces honestly and the handshake NEVER fires — proceeding
    // would act on the stale persisted flag (worst case: a withdrawal that
    // failed to persist would still send the id).
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t save your choice/i);
    expect(transport.startCloudLink).not.toHaveBeenCalled();
    // The user stays on the idle entry point, free to retry.
    expect(screen.getByRole('button', { name: /link this instance/i })).toBeInTheDocument();
  });

  it('shows a friendly error when starting the link fails', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startCloudLink).mockRejectedValue(
      new Error('Couldn’t reach the DorkOS cloud to start linking. Try again shortly.')
    );
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: /link this instance/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t reach the dorkos cloud/i);
  });
  describe('pending: time left on the code', () => {
    /** Start a link whose code expires `msLeft` from now, under fake timers. */
    async function startPending(msLeft: number, verificationUri = 'https://dorkos.ai/activate') {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
      const transport = createMockTransport();
      vi.mocked(transport.startCloudLink).mockResolvedValue({
        userCode: 'WXYZ7890',
        verificationUri,
        expiresAt: new Date(Date.now() + msLeft).toISOString(),
      });
      // The server keeps reporting pending, so the countdown is the only thing moving.
      vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
      renderPanel(transport);
      await flush();
      vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'pending' });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /link this instance/i }));
      });
      await flush();
      return transport;
    }

    const visible = () => screen.getByTestId('cloud-link-expiry');

    it('counts down from expiresAt beside the waiting line', async () => {
      await startPending(4 * 60_000 + 12_000);

      expect(screen.getByRole('status')).toHaveTextContent('Waiting for you to approve.');
      expect(visible()).toHaveTextContent('This code expires in 4:12.');

      await flush(1000);
      expect(visible()).toHaveTextContent('This code expires in 4:11.');

      await flush(71_000);
      expect(visible()).toHaveTextContent('This code expires in 3:00.');
    });

    it('switches to "less than a minute" under 60 seconds, and stays there at zero', async () => {
      await startPending(61_000);
      expect(visible()).toHaveTextContent('This code expires in 1:01.');

      await flush(1000);
      expect(visible()).toHaveTextContent('This code expires in 1:00.');

      await flush(1000);
      expect(visible()).toHaveTextContent('This code expires in less than a minute.');

      // Past zero the server, not the clock, says the code expired.
      await flush(120_000);
      expect(visible()).toHaveTextContent('This code expires in less than a minute.');
    });

    it('hides the ticking sentence from screen readers and announces only at thresholds', async () => {
      await startPending(7 * 60_000 + 30_000);
      const status = screen.getByRole('status');
      const spoken = () => status.querySelector('.sr-only')?.textContent?.trim();

      // The ticking sentence is hidden AND outside the live region, so its
      // per-second changes are not mutations of the region.
      expect(visible()).toHaveAttribute('aria-hidden');
      expect(status).not.toContainElement(visible());

      // Entry: the region exists first and the sentence arrives on the first
      // tick, so it is a change a screen reader announces.
      expect(status).toHaveTextContent('Waiting for you to approve.');
      expect(spoken()).toBeUndefined();
      await flush(1000);
      expect(spoken()).toBe('This code expires in about 7 minutes.');

      // The visible clock moves every second; the spoken sentence does not.
      await flush(1000);
      expect(visible()).toHaveTextContent('This code expires in 7:28.');
      expect(spoken()).toBe('This code expires in about 7 minutes.');
      await flush(147_000);
      expect(visible()).toHaveTextContent('This code expires in 5:01.');
      expect(spoken()).toBe('This code expires in about 7 minutes.');

      // Threshold one: five minutes left.
      await flush(2000);
      expect(spoken()).toBe('This code expires in less than 5 minutes.');
      await flush(200_000);
      expect(spoken()).toBe('This code expires in less than 5 minutes.');

      // Threshold two: the last minute.
      await flush(40_000);
      expect(spoken()).toBe('This code expires in less than a minute.');
    });

    it('skips the five-minute announcement for a code that starts with less', async () => {
      await startPending(3 * 60_000 + 30_000);
      const spoken = () =>
        screen.getByRole('status').querySelector('.sr-only')?.textContent?.trim();

      await flush(1000);
      expect(spoken()).toBe('This code expires in about 3 minutes.');
      await flush(140_000);
      expect(spoken()).toBe('This code expires in about 3 minutes.');
      await flush(10_000);
      expect(spoken()).toBe('This code expires in less than a minute.');
    });

    it('leaves the countdown out when expiresAt is unreadable', async () => {
      vi.useFakeTimers();
      const transport = createMockTransport();
      vi.mocked(transport.startCloudLink).mockResolvedValue({
        userCode: 'WXYZ7890',
        verificationUri: 'https://dorkos.ai/activate',
        expiresAt: 'not a date',
      });
      vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
      renderPanel(transport);
      await flush();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /link this instance/i }));
      });
      await flush();

      expect(screen.getByRole('status')).toHaveTextContent('Waiting for you to approve.');
      expect(screen.queryByTestId('cloud-link-expiry')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).not.toHaveTextContent(/expires/i);
    });

    it.each([
      // mailto: is a scheme the shared opener WOULD dispatch, so only the panel's
      // own http(s) check stands between it and the browser.
      ['a scheme other than http(s)', 'mailto:someone@example.com'],
      ['a URL that will not parse', 'not a url at all'],
    ])('says so when the approval page will not open: %s', async (_label, verificationUri) => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      await startPending(900_000, verificationUri);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open the approval page/i }));
      });

      expect(openSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'We could not open the approval page. Copy the code and open it in your browser.'
      );
      // The code the sentence points at is still on screen, with its copy button.
      expect(screen.getByText('WXYZ7890')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy code/i })).toBeInTheDocument();
      openSpy.mockRestore();
    });

    it('shows no error when the approval page opens', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      await startPending(900_000);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open the approval page/i }));
      });

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      openSpy.mockRestore();
    });
  });
});
