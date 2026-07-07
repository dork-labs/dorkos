/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
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
    // The section and its entry point render off the transport alone.
    expect(screen.getByRole('heading', { name: /dorkos account/i })).toBeInTheDocument();
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
    renderPanel(transport);

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
    expect(screen.getByRole('button', { name: /open dorkos\.ai\/activate/i })).toBeInTheDocument();

    // Poll fires → linked. Same panel instance updates in place.
    await flush(2500);
    expect(screen.getByText('kai@dork.dev')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlink/i })).toBeInTheDocument();
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
    renderPanel(transport);

    // Linked view from the settled summary.
    expect(await screen.findByText('kai@dork.dev')).toBeInTheDocument();

    // Open the confirmation and confirm.
    await user.click(screen.getByRole('button', { name: /unlink this instance/i }));
    const confirm = await screen.findByRole('button', { name: /^unlink$/i });
    await user.click(confirm);

    await waitFor(() => expect(transport.unlinkCloud).toHaveBeenCalledTimes(1));
    // Returns to the unlinked/idle entry point.
    expect(await screen.findByRole('button', { name: /link this instance/i })).toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: /open dorkos\.ai\/activate/i }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(openSpy.mock.calls[0][0] as string);
    expect(openedUrl.protocol).toBe('https:');
    expect(openedUrl.searchParams.get('code')).toBe('WXYZ7890');
    openSpy.mockRestore();
  });

  it('shows a friendly error when starting the link fails', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startCloudLink).mockRejectedValue(
      new Error('Could not reach the DorkOS cloud to start linking. Try again shortly.')
    );
    renderPanel(transport);

    await user.click(await screen.findByRole('button', { name: /link this instance/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the dorkos cloud/i);
  });
});
