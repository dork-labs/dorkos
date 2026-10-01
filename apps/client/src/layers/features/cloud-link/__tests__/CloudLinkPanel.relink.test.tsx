/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { SETTINGS_RELINK_SECTION, TransportProvider } from '@/layers/shared/model';
import { CloudLinkPanel } from '../ui/CloudLinkPanel';

const deepLink = vi.hoisted(() => ({ section: null as string | null, setSection: vi.fn() }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ section: deepLink.section, setSection: deepLink.setSection }),
}));

function linkedTransport(): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getCloudStatus).mockResolvedValue({
    linked: true,
    accountLabel: 'kai@dork.dev',
    lastHeartbeatAt: new Date().toISOString(),
  });
  vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
  vi.mocked(transport.startCloudLink).mockResolvedValue({
    userCode: 'RELINK42',
    verificationUri: 'https://dorkos.ai/activate',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  });
  return transport;
}

function renderPanel(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CloudLinkPanel />
      </TransportProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

describe('CloudLinkPanel — linking again while linked', () => {
  beforeEach(() => {
    deepLink.section = null;
    deepLink.setSection.mockReset();
  });
  afterEach(cleanup);

  it('offers Link again on a linked computer and starts a new link with it', async () => {
    const user = userEvent.setup();
    const transport = linkedTransport();
    renderPanel(transport);
    expect(await screen.findByText('kai@dork.dev')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Link again' }));
    await waitFor(() => expect(transport.startCloudLink).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('RELINK42')).toBeInTheDocument();
  });

  it('starts the new link by itself when it was opened to link again, once', async () => {
    deepLink.section = SETTINGS_RELINK_SECTION;
    const transport = linkedTransport();
    renderPanel(transport);
    expect(await screen.findByText('RELINK42')).toBeInTheDocument();
    expect(transport.startCloudLink).toHaveBeenCalledTimes(1);
    // The request is spent, so reopening Settings does not start another link.
    expect(deepLink.setSection).toHaveBeenCalledWith('account');
  });

  it('says why a new link could not start, and keeps the button to try again', async () => {
    const user = userEvent.setup();
    const transport = linkedTransport();
    vi.mocked(transport.startCloudLink).mockRejectedValueOnce(
      new Error('Couldn’t reach the DorkOS cloud. Try again shortly.')
    );
    renderPanel(transport);
    await user.click(await screen.findByRole('button', { name: 'Link again' }));
    expect(
      await screen.findByText('Couldn’t reach the DorkOS cloud. Try again shortly.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link again' })).toBeEnabled();
  });
});

describe('CloudLinkPanel — a relink request never disturbs a live code or a loading panel', () => {
  beforeEach(() => {
    deepLink.section = null;
    deepLink.setSection.mockReset();
  });
  afterEach(cleanup);

  it('leaves a code already showing alone when asked to link again', async () => {
    const user = userEvent.setup();
    const transport = linkedTransport();
    const panel = renderPanel(transport);
    await user.click(await screen.findByRole('button', { name: 'Link again' }));
    expect(await screen.findByText('RELINK42')).toBeInTheDocument();

    deepLink.section = SETTINGS_RELINK_SECTION;
    panel.rerender();
    await waitFor(() => expect(deepLink.setSection).toHaveBeenCalledWith('account'));
    expect(transport.startCloudLink).toHaveBeenCalledTimes(1);
    expect(transport.cancelCloudLink).not.toHaveBeenCalled();
    expect(screen.getByText('RELINK42')).toBeInTheDocument();
  });

  it('waits for the panel to know its state before starting', async () => {
    deepLink.section = SETTINGS_RELINK_SECTION;
    const transport = linkedTransport();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    vi.mocked(transport.getCloudStatus).mockImplementation(async () => {
      await settled;
      return { linked: true, accountLabel: 'kai@dork.dev', lastHeartbeatAt: null };
    });
    vi.mocked(transport.getCloudLinkStatus).mockImplementation(async () => {
      await settled;
      return { state: 'idle' };
    });
    renderPanel(transport);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(transport.startCloudLink).not.toHaveBeenCalled();
    expect(deepLink.setSection).not.toHaveBeenCalled();
    settle();
    expect(await screen.findByText('RELINK42')).toBeInTheDocument();
    expect(transport.startCloudLink).toHaveBeenCalledTimes(1);
  });
});

describe('CloudLinkPanel — a relink that did not finish', () => {
  beforeEach(() => {
    deepLink.section = null;
    deepLink.setSection.mockReset();
  });
  afterEach(cleanup);

  it.each([
    ['denied', 'The new link was turned down on dorkos.ai.'],
    ['expired', 'The code for the new link timed out.'],
    ['failed', 'The new link couldn’t finish.'],
  ] as const)(
    'keeps showing Linked after a %s relink, with a note that can be dismissed',
    async (relinkOutcome, line) => {
      const user = userEvent.setup();
      const transport = linkedTransport();
      vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
        state: 'linked',
        accountLabel: 'kai@dork.dev',
        relinkOutcome,
      });
      vi.mocked(transport.cancelCloudLink).mockResolvedValue({
        state: 'linked',
        accountLabel: 'kai@dork.dev',
      });
      renderPanel(transport);
      expect(await screen.findByText(new RegExp(line))).toBeInTheDocument();
      expect(screen.getByText(/This computer is still linked\./)).toBeInTheDocument();
      expect(screen.getByText('Linked')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Link again' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /unlink this instance/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      await waitFor(() => expect(transport.cancelCloudLink).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByText(new RegExp(line))).not.toBeInTheDocument());
    }
  );

  it('cancels a relink while its code is showing and goes back to Linked', async () => {
    const user = userEvent.setup();
    const transport = linkedTransport();
    vi.mocked(transport.cancelCloudLink).mockResolvedValue({
      state: 'linked',
      accountLabel: 'kai@dork.dev',
    });
    renderPanel(transport);
    await user.click(await screen.findByRole('button', { name: 'Link again' }));
    expect(await screen.findByText('RELINK42')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(transport.cancelCloudLink).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('kai@dork.dev')).toBeInTheDocument();
    expect(screen.queryByText('RELINK42')).not.toBeInTheDocument();
  });
});
