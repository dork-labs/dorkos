/**
 * @vitest-environment jsdom
 *
 * The connect flow dialog: recommendation routing (relay adapter leads when
 * one exists), the multi-account label suggestion, and the consent sequence —
 * the server's custody disclosure is on screen BEFORE the sign-in link opens
 * anything, and polling starts only after the person opens it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorToolkit, PublicConnectedAccount } from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useConnectFlowStore } from '@/layers/entities/connectors';
import { ConnectDialog } from '../ui/ConnectDialog';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // The flow store is app-wide (it must outlive the dialog); each test resets it.
  useConnectFlowStore.getState().reset();
});

const gmail: ConnectorToolkit = { slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' };

const gatewayRecommendation = {
  recommendations: [
    {
      kind: 'gateway' as const,
      target: 'gmail',
      provider: 'composio',
      rank: 1,
      reason: 'Connect gmail through the composio gateway.',
      custody: 'managed' as const,
    },
  ],
  warnings: [],
};

const startResponse = {
  flowId: 'flow-1',
  authorizeUrl: 'https://vendor.example/authorize/gmail',
  disclosure:
    'Connecting gmail takes you to that service to sign in. Composio stores your connected ' +
    "accounts' login access in its own secure vault, not on your computer.",
};

const connectedAccount: PublicConnectedAccount = {
  id: 'acct-9' as PublicConnectedAccount['id'],
  toolkit: 'gmail',
  label: 'work',
  status: 'active',
  custody: 'managed',
  disclosure: 'Connecting work takes you to that service to sign in.',
};

function renderDialog(transport: Transport, onClose = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const ui = (service: typeof gmail | null) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ConnectDialog service={service} onClose={onClose} />
      </TransportProvider>
    </QueryClientProvider>
  );
  const view = render(ui(gmail));
  // Re-render with the parent's `service` value (the parent owns open state),
  // keeping the same QueryClient so in-flight polling is observable.
  const setService = (service: typeof gmail | null) => view.rerender(ui(service));
  return { onClose, setService };
}

describe('ConnectDialog', () => {
  it('shows the custody disclosure BEFORE the auth URL can be opened, and polls only after', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open');
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorRecommendation).mockResolvedValue(gatewayRecommendation);
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);
    vi.mocked(transport.pollConnectorFlow).mockResolvedValue({
      status: 'connected',
      account: connectedAccount,
    });

    renderDialog(transport);

    // Step 1: the label form. No sign-in link exists anywhere in this step —
    // a link rendered here would be a URL reachable before the disclosure.
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open the sign-in page/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 2: the disclosure step. The server's sentence is rendered…
    const disclosure = await screen.findByTestId('connect-disclosure');
    expect(disclosure).toHaveTextContent(startResponse.disclosure);
    // …and the ONLY route to the vendor is the link rendered beneath it.
    const signIn = screen.getByRole('link', { name: /open the sign-in page/i });
    expect(signIn).toHaveAttribute('href', startResponse.authorizeUrl);
    expect(signIn).toHaveAttribute('target', '_blank');
    // Consent ordering: nothing polls while the person is reading.
    expect(transport.pollConnectorFlow).not.toHaveBeenCalled();

    // Step 3: the person opens the sign-in page — polling begins.
    await user.click(signIn);
    await waitFor(() => expect(transport.pollConnectorFlow).toHaveBeenCalledWith('flow-1'));

    // Step 4: connected, named, and disclosed.
    expect(await screen.findByText('Gmail (work) is connected.')).toBeInTheDocument();
    expect(screen.getByText(connectedAccount.disclosure)).toBeInTheDocument();

    // Across the whole flow, nothing ever called window.open — the person's
    // click on the anchor is the only way the vendor page opens.
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('suggests the "personal" label when a first account of the service exists', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorRecommendation).mockResolvedValue(gatewayRecommendation);
    vi.mocked(transport.getConnectorAccounts).mockResolvedValue({
      accounts: [connectedAccount],
      warnings: [],
    });

    renderDialog(transport);

    await waitFor(() => expect(screen.getByLabelText(/account label/i)).toHaveValue('personal'));
    expect(screen.getByText(/a label tells them apart/i)).toBeInTheDocument();
  });

  it('asks which of the two things a dual-nature service is being connected for', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorRecommendation).mockResolvedValue({
      recommendations: [
        {
          kind: 'relay-adapter',
          target: 'gmail',
          provider: 'gmail',
          rank: 0,
          reason: 'Gmail has a purpose-built two-way adapter in DorkOS.',
        },
        ...gatewayRecommendation.recommendations,
      ],
      warnings: [],
    });

    renderDialog(transport);

    // Two different powers, named by what each one does — not one option and
    // an afterthought labelled "use the other one".
    expect(
      await screen.findByRole('button', { name: /chat with your agents in gmail/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /let agents act on your gmail account/i })
    ).toBeInTheDocument();
    // The account path says whose vault the sign-in lands in, at the fork.
    expect(screen.getByText(/goes through composio/i)).toBeInTheDocument();
    // Neither has been chosen by merely opening the dialog.
    expect(transport.startConnectorFlow).not.toHaveBeenCalled();
  });

  it('says honestly when nothing can connect the service yet', async () => {
    const transport = createMockTransport();
    renderDialog(transport);
    expect(await screen.findByText(/gmail cannot be connected yet/i)).toBeInTheDocument();
  });

  it('keeps a mid-grant flow polling after the dialog closes, and records the account', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorRecommendation).mockResolvedValue(gatewayRecommendation);
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);
    // Still pending when the person closes the dialog; the grant completes after.
    vi.mocked(transport.pollConnectorFlow)
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'connected', account: connectedAccount });

    const { onClose, setService } = renderDialog(transport);

    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('link', { name: /open the sign-in page/i }));
    await waitFor(() => expect(transport.pollConnectorFlow).toHaveBeenCalled());

    // The waiting step says closing is safe, and DISMISSING the dialog (Escape,
    // overlay, X — the paths that run handleOpenChange) does not abandon the
    // flow. The in-step "Close window" button exists too but calls onClose
    // directly, so Escape is the path that discriminates the close guard.
    expect(screen.getByText(/you can close this window/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(useConnectFlowStore.getState().step).toBe('waiting');

    // Parent closes the dialog; the hook stays mounted with the page and the
    // poll keeps running until the vendor confirms — the account is recorded
    // (accounts invalidation fires), never an orphaned grant.
    setService(null);
    await waitFor(() => expect(useConnectFlowStore.getState().step).toBe('connected'), {
      timeout: 5_000,
    });
    expect(useConnectFlowStore.getState().account).toEqual(connectedAccount);
  });

  it('abandons an un-consented flow when the dialog closes during disclosure', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorRecommendation).mockResolvedValue(gatewayRecommendation);
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);

    const { onClose } = renderDialog(transport);

    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByTestId('connect-disclosure');

    // Nothing has been granted yet — Escape abandons cleanly.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(useConnectFlowStore.getState().step).toBe('idle');
    expect(transport.pollConnectorFlow).not.toHaveBeenCalled();
  });

  it('surfaces a failed flow verbatim with a way back', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorRecommendation).mockResolvedValue(gatewayRecommendation);
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);
    vi.mocked(transport.pollConnectorFlow).mockResolvedValue({
      status: 'failed',
      error: 'The vendor rejected the connection.',
    });

    renderDialog(transport);

    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('link', { name: /open the sign-in page/i }));

    expect(await screen.findByText('The vendor rejected the connection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
