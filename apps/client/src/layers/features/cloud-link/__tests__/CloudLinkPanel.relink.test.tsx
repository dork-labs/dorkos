/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CloudLinkPanel />
      </TransportProvider>
    </QueryClientProvider>
  );
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
