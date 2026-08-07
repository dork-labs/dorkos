/**
 * The failed half of the shared sign-in surface (DOR-982): the plain reason, the
 * raw text behind Details, and the "use your own app credentials" path that only
 * one failure family offers.
 *
 * The form is driven through the REAL hook against a mock Transport rather than
 * a frozen flow object, because the behaviour under test is not "a form renders"
 * — it is "saving credentials retries the sign-in", which only the hook does.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StartMcpSigninResult, Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { McpSigninBody, useMcpSigninFlow } from '../index';

const AGENT_ID = '01HZ0000000000000000000001';
const SERVER = 'granola';

const startResult: StartMcpSigninResult = {
  flowId: 'flow-1',
  authorizeUrl: 'https://auth.example/authorize?client_id=operator-app-id',
  alreadyConnected: false,
  disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
  message: 'sign-in link',
};

/** The rejection shape `HttpTransport` produces for a capability error payload. */
function capabilityRejection(code: string, detail: string, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    status: 400,
    body: { error: message, code, detail },
  });
}

/** The surface exactly as a card mounts it: the real hook, the shared body. */
function Harness() {
  const flow = useMcpSigninFlow(AGENT_ID, SERVER);
  return (
    <div>
      <button type="button" onClick={() => flow.start()}>
        Sign in
      </button>
      <McpSigninBody
        flow={flow}
        serverName={SERVER}
        failedActions={
          <button type="button" onClick={() => flow.start()}>
            Try again
          </button>
        }
      />
    </div>
  );
}

function renderHarness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<Harness />, { wrapper });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('a sign-in that could not start', () => {
  it('leads with the plain reason and keeps the raw OAuth text behind Details', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin).mockRejectedValue(
      capabilityRejection(
        'SIGNIN_NO_APP_REGISTRATION',
        'HTTP 404: Invalid OAuth error response. Raw body: <html>Not Found</html>',
        'This server doesn’t let DorkOS register itself. If you have app credentials from the provider, add them and try again.'
      )
    );
    renderHarness(transport);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('doesn’t let DorkOS register itself');
    // Demoting the raw text is the point: it is present, but not in the alert.
    expect(alert).not.toHaveTextContent('404');
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText(/Invalid OAuth error response/)).toBeInTheDocument();
  });

  it('offers the credentials form only for the family a person can fix', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin).mockRejectedValue(
      capabilityRejection(
        'SIGNIN_UNREACHABLE',
        'fetch failed',
        'Couldn’t reach the server to start the sign-in.'
      )
    );
    renderHarness(transport);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // Offering app credentials for an unreachable server would send a person
    // hunting for something that would not help.
    expect(
      screen.queryByRole('button', { name: 'Use your own app credentials' })
    ).not.toBeInTheDocument();
  });

  it('saves the credentials, masks the secret, and signs in again with them', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin)
      .mockRejectedValueOnce(
        capabilityRejection(
          'SIGNIN_NO_APP_REGISTRATION',
          'HTTP 404',
          'This server doesn’t let DorkOS register itself.'
        )
      )
      .mockResolvedValue(startResult);
    renderHarness(transport);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Use your own app credentials' }));

    const clientId = screen.getByLabelText(/Client ID/);
    const secret = screen.getByLabelText(/Client secret/);
    // A credential field is never a plain text box: the value is a secret the
    // moment it is typed, and shoulder-surfing is the ordinary threat.
    expect(secret).toHaveAttribute('type', 'password');

    await user.type(clientId, '  operator-app-id  ');
    await user.type(secret, 'operator-app-secret');
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }));

    await waitFor(() => {
      expect(transport.setMcpClientCredentials).toHaveBeenCalledWith(AGENT_ID, SERVER, {
        clientId: 'operator-app-id',
        clientSecret: 'operator-app-secret',
      });
    });
    // The retry is the point of the button — a save that stopped there would
    // leave the person staring at the failure they just fixed.
    await waitFor(() => {
      expect(transport.startMcpSignin).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByRole('link', { name: `Open the sign-in page for ${SERVER}` })
    ).toBeInTheDocument();
  });

  it('sends no secret when the provider issued none', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin)
      .mockRejectedValueOnce(
        capabilityRejection(
          'SIGNIN_NO_APP_REGISTRATION',
          'HTTP 404',
          'This server doesn’t let DorkOS register itself.'
        )
      )
      .mockResolvedValue(startResult);
    renderHarness(transport);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Use your own app credentials' }));
    await user.type(screen.getByLabelText(/Client ID/), 'public-app');
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }));

    await waitFor(() => {
      expect(transport.setMcpClientCredentials).toHaveBeenCalledWith(AGENT_ID, SERVER, {
        clientId: 'public-app',
      });
    });
  });

  it('reports a failed save instead of pretending the sign-in restarted', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startMcpSignin).mockRejectedValue(
      capabilityRejection(
        'SIGNIN_NO_APP_REGISTRATION',
        'HTTP 404',
        'This server doesn’t let DorkOS register itself.'
      )
    );
    vi.mocked(transport.setMcpClientCredentials).mockRejectedValue(
      new Error('Agent 01HZ has no managed MCP server named "granola".')
    );
    renderHarness(transport);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Use your own app credentials' }));
    await user.type(screen.getByLabelText(/Client ID/), 'operator-app-id');
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('has no managed MCP server named');
    });
    expect(transport.startMcpSignin).toHaveBeenCalledTimes(1);
  });
});
