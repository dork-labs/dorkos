// @vitest-environment jsdom
/**
 * Settings, when DorkOS also offers remote access (DOR-2086): the mode choice,
 * setup with its consent and approval, every managed state, and the way back
 * to the person's own ngrok.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { RemoteAccessReport } from '@dorkos/shared/types';
import {
  HIDDEN_REMOTE_ACCESS_REPORT,
  createMockTransport,
  createRemoteAccessReport,
} from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { resetRemoteAccessStore } from '@/layers/entities/tunnel';
import { RemoteAccessTab } from '../ui/RemoteAccessTab';
import { MANAGED_CONSENT, expiryLine } from '../ui/ManagedSetup';

vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [null, vi.fn()],
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

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

beforeEach(() => resetRemoteAccessStore());
afterEach(() => cleanup());

const tunnel = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null,
};

function renderTab(report: RemoteAccessReport, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', port: 4242, tunnel }),
    getRemoteAccessReport: vi.fn().mockResolvedValue(report),
    ...overrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RemoteAccessTab />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

const CHOICE = 'How other devices reach this computer';

describe('whether DorkOS is offered', () => {
  it('shows no choice while it is hidden, only the ngrok panel', async () => {
    renderTab(HIDDEN_REMOTE_ACCESS_REPORT);
    expect(await screen.findByText('Enable remote access')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: CHOICE })).not.toBeInTheDocument();
  });

  it('shows no choice while it is unavailable and was never chosen', async () => {
    renderTab(createRemoteAccessReport({ availability: 'unavailable', mode: 'off', state: 'off' }));
    expect(await screen.findByText('Enable remote access')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: CHOICE })).not.toBeInTheDocument();
  });

  it('offers off, your ngrok and DorkOS while it is available', async () => {
    renderTab(createRemoteAccessReport({ mode: 'off', state: 'off', url: undefined }));
    const group = await screen.findByRole('radiogroup', { name: CHOICE });
    expect(within(group).getByRole('radio', { name: 'Off' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Your ngrok' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'DorkOS' })).toBeInTheDocument();
  });

  it('keeps the ngrok token and domain settings under “Your ngrok”', async () => {
    renderTab(createRemoteAccessReport({ mode: 'byo', state: 'off', url: undefined }));
    expect(await screen.findByTestId('tunnel-settings')).toBeInTheDocument();
    expect(screen.getByText('Enable remote access')).toBeInTheDocument();
  });
});

describe('choosing a mode', () => {
  it('selects your ngrok on the server', async () => {
    const transport = renderTab(createRemoteAccessReport({ mode: 'off', state: 'off' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Your ngrok' }));
    await waitFor(() => expect(transport.setRemoteAccessMode).toHaveBeenCalledWith('byo'));
    expect(transport.startTunnel).not.toHaveBeenCalled();
  });

  it('shows setup with its consent before anything is sent, then starts it on the press', async () => {
    const transport = renderTab(
      createRemoteAccessReport({
        mode: 'off',
        state: 'off',
        url: undefined,
        enrolment: { status: 'none' },
      })
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'DorkOS' }));

    expect(await screen.findByText(MANAGED_CONSENT)).toBeInTheDocument();
    expect(transport.setRemoteAccessMode).not.toHaveBeenCalled();
    expect(transport.startRemoteEnrolment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Set up remote access' }));
    await waitFor(() => expect(transport.startRemoteEnrolment).toHaveBeenCalledTimes(1));
  });

  it('shows a refusal beside the choice', async () => {
    renderTab(createRemoteAccessReport({ mode: 'off', state: 'off' }), {
      setRemoteAccessMode: vi.fn().mockRejectedValue(new Error('Choose off, byo or managed.')),
    });
    fireEvent.click(await screen.findByRole('radio', { name: 'Your ngrok' }));
    expect(await screen.findByText('Choose off, byo or managed.')).toBeInTheDocument();
  });
});

describe('setup', () => {
  const expiresAt = new Date(Date.now() + 9.5 * 60_000).toISOString();

  it('shows the code, the approval link in a new tab, and when the code expires', async () => {
    const transport = renderTab(
      createRemoteAccessReport({
        mode: 'off',
        state: 'off',
        url: undefined,
        enrolment: {
          status: 'pending',
          userCode: 'WXYZ-1234',
          approveUrl: 'https://cloud.example.com/approve',
          expiresAt,
        },
      })
    );
    expect(await screen.findByTestId('managed-setup-code')).toHaveTextContent('WXYZ-1234');
    const link = screen.getByRole('link', { name: 'Open approval page' });
    expect(link).toHaveAttribute('href', 'https://cloud.example.com/approve');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('Code expires in 9m')).toBeInTheDocument();
    // A waiting setup is a DorkOS choice in progress.
    expect(screen.getByRole('radio', { name: 'DorkOS' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }));
    await waitFor(() => expect(transport.withdrawRemoteAccess).toHaveBeenCalledTimes(1));
  });

  it('says when the code ran out', () => {
    expect(expiryLine(new Date(0).toISOString(), Date.now())).toBe('Code expired');
    expect(expiryLine(new Date(Date.now() + 30_000).toISOString(), Date.now())).toBe(
      'Code expires in under a minute'
    );
  });

  it.each([
    ['denied', 'Setup was declined'],
    ['expired', 'Setup timed out'],
  ] as const)('a %s setup says so and offers to start again', async (status, title) => {
    const transport = renderTab(
      createRemoteAccessReport({
        mode: 'off',
        state: 'off',
        url: undefined,
        enrolment: { status },
      })
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'DorkOS' }));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(MANAGED_CONSENT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(transport.startRemoteEnrolment).toHaveBeenCalledTimes(1));
  });
});

describe('every managed state', () => {
  it('open: the address, Close now, and removal', async () => {
    const transport = renderTab(createRemoteAccessReport({ state: 'open' }));
    expect(await screen.findByText('Remote access is on')).toBeInTheDocument();
    expect(screen.getByText('calm-otter.example.com')).toBeInTheDocument();
    expect(screen.queryByText('Always available')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close now' }));
    await waitFor(() => expect(transport.closeRemoteAccess).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this computer' }));
    await waitFor(() => expect(transport.withdrawRemoteAccess).toHaveBeenCalledTimes(1));
  });

  it('says “Always available” only when DorkOS Cloud reports it', async () => {
    renderTab(createRemoteAccessReport({ state: 'open', alwaysAvailable: true }));
    expect(await screen.findByText('Always available')).toBeInTheDocument();
  });

  it('opening reads as connecting, with no address', async () => {
    renderTab(createRemoteAccessReport({ state: 'opening', url: undefined }));
    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy url/i })).not.toBeInTheDocument();
  });

  it('draining reads as closing, with no address', async () => {
    renderTab(createRemoteAccessReport({ state: 'draining', url: undefined }));
    expect(await screen.findByText('Closing…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy url/i })).not.toBeInTheDocument();
  });

  it('reconnecting says so, with the reason the report gives', async () => {
    renderTab(
      createRemoteAccessReport({
        state: 'reconnecting',
        url: undefined,
        reason: 'DorkOS Cloud reports this address open. This computer is not serving it yet.',
      })
    );
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();
    expect(
      screen.getByText(
        'DorkOS Cloud reports this address open. This computer is not serving it yet.'
      )
    ).toBeInTheDocument();
  });

  it('blocked shows its reason', async () => {
    renderTab(
      createRemoteAccessReport({
        state: 'blocked',
        url: undefined,
        reason: 'Setup did not finish. Start it again.',
      })
    );
    expect(await screen.findByText('Remote access needs attention')).toBeInTheDocument();
    expect(screen.getByText('Setup did not finish. Start it again.')).toBeInTheDocument();
  });

  it('asleep is calm: closed for now, the address kept, nothing about waking', async () => {
    renderTab(createRemoteAccessReport({ state: 'asleep' }));
    const status = await screen.findByTestId('managed-status');
    expect(within(status).getByText('Remote access is closed for now')).toBeInTheDocument();
    expect(within(status).getByText('Your address stays the same.')).toBeInTheDocument();
    expect(within(status).getByText('calm-otter.example.com')).toBeInTheDocument();
    expect(status.textContent).not.toMatch(/reconnect|asleep|wake|sleep/i);
    expect(status.innerHTML).not.toMatch(/bg-status-error|text-destructive|warning/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('when DorkOS Cloud can’t be reached, shows this computer’s state and says so', async () => {
    renderTab(
      createRemoteAccessReport({
        availability: 'unavailable',
        cloudStale: true,
        state: 'off',
        url: undefined,
      })
    );
    expect(await screen.findByTestId('managed-status-stale')).toHaveTextContent(
      'Couldn’t reach DorkOS Cloud. Showing the last known state.'
    );
    // No choice to make until Cloud answers again.
    expect(screen.queryByRole('radiogroup', { name: CHOICE })).not.toBeInTheDocument();
  });
});

describe('when the server’s answer moves under the person', () => {
  const expiresAt = new Date(Date.now() + 9.5 * 60_000).toISOString();
  const pending = createRemoteAccessReport({
    mode: 'off',
    state: 'off',
    url: undefined,
    enrolment: {
      status: 'pending',
      userCode: 'WXYZ-1234',
      approveUrl: 'https://cloud.example.com/approve',
      expiresAt,
    },
  });

  it.each([
    ['denied', 'Setup was declined'],
    ['expired', 'Setup timed out'],
  ] as const)(
    'a waiting setup that ends %s says so, with nothing pressed',
    async (status, title) => {
      const report = vi.fn().mockResolvedValue(pending);
      renderTab(pending, { getRemoteAccessReport: report });
      expect(await screen.findByTestId('managed-setup-pending')).toBeInTheDocument();

      report.mockResolvedValue({ ...pending, enrolment: { status } });
      // The pending poll runs every few seconds; the test asks sooner.
      await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'DorkOS' })).toBeChecked();
    }
  );

  it('lands focus on the status heading once setup is approved', async () => {
    const report = vi.fn().mockResolvedValue(pending);
    renderTab(pending, { getRemoteAccessReport: report });
    const cancel = await screen.findByRole('button', { name: 'Cancel setup' });
    cancel.focus();

    report.mockResolvedValue(createRemoteAccessReport({ state: 'asleep' }));
    const heading = await screen.findByRole(
      'heading',
      { name: 'Remote access is closed for now' },
      { timeout: 5000 }
    );
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

describe('turning DorkOS off while DorkOS Cloud can’t be reached', () => {
  it.each(['off', 'asleep'] as const)(
    '%s offers a plain Turn off, not only removal',
    async (state) => {
      const transport = renderTab(
        createRemoteAccessReport({ availability: 'unavailable', cloudStale: true, state })
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
      await waitFor(() => expect(transport.setRemoteAccessMode).toHaveBeenCalledWith('off'));
      expect(transport.withdrawRemoteAccess).not.toHaveBeenCalled();
    }
  );

  it('offers no second off while the choice is there to do it', async () => {
    renderTab(createRemoteAccessReport({ state: 'asleep' }));
    await screen.findByTestId('managed-status');
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });
});
