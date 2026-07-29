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
import { ConnectDialog } from '../ui/ConnectDialog';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
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
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ConnectDialog service={gmail} onClose={onClose} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return onClose;
}

describe('ConnectDialog', () => {
  it('shows the custody disclosure BEFORE the auth URL can be opened, and polls only after', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorRecommendation).mockResolvedValue(gatewayRecommendation);
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);
    vi.mocked(transport.pollConnectorFlow).mockResolvedValue({
      status: 'connected',
      account: connectedAccount,
    });

    renderDialog(transport);

    // Step 1: label form. No disclosure, no sign-in link anywhere yet.
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

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

  it('leads with the relay adapter when one exists, generic connector one step behind', async () => {
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

    expect(
      await screen.findByRole('button', { name: /open the gmail adapter/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /use the generic connector instead/i })
    ).toBeInTheDocument();
    // The gateway flow has not been started by merely opening the dialog.
    expect(transport.startConnectorFlow).not.toHaveBeenCalled();
  });

  it('says honestly when nothing can connect the service yet', async () => {
    const transport = createMockTransport();
    renderDialog(transport);
    expect(await screen.findByText(/nothing can connect gmail yet/i)).toBeInTheDocument();
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
