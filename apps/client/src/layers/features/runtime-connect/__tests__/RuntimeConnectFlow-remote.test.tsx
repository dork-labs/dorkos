// @vitest-environment jsdom
/**
 * What Settings → Runtimes offers a browser that is not on the machine DorkOS
 * runs on (DOR-1655).
 *
 * The guard sits on the DISPATCHER, so these assertions deliberately span both
 * connect kinds: a `login` runtime (Claude Code, Codex) and the
 * `provider-picker` one (OpenCode). Every endpoint behind both is loopback-only,
 * so a remote browser must get the notice instead of either set of controls.
 *
 * The locality answer comes back through a real `useConfig` over the mock
 * Transport rather than a mocked hook, so `getConfig` → `isLocalCaller` → hook →
 * component runs end to end here exactly as it does in the product.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimeConnectFlow } from '../ui/RuntimeConnectFlow';

afterEach(cleanup);

/**
 * Render the connect flow against a server reporting the given locality.
 *
 * @param options - `isLocalCaller` as the server would report it (omit to stand
 *   in for a server that reports no such field) and which connect kind to show.
 */
function renderFlow(options: { isLocalCaller?: boolean; kind?: 'login' | 'provider-picker' }) {
  const { isLocalCaller, kind = 'login' } = options;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      ...(isLocalCaller === undefined ? {} : { isLocalCaller }),
      port: 4242,
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RuntimeConnectFlow
          type={kind === 'login' ? 'claude-code' : 'opencode'}
          connect={{ kind, label: 'Connect' }}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('Settings connect flow on a browser that is not on this machine', () => {
  it.each(['login', 'provider-picker'] as const)(
    'replaces the %s controls with the notice',
    async (kind) => {
      const transport = renderFlow({ isLocalCaller: false, kind });

      expect(await screen.findByTestId('remote-signin-notice')).toHaveTextContent(
        'Signing in needs the computer DorkOS runs on.'
      );
      expect(screen.queryByTestId('login-connect-claude-code')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /use an api key instead/i })
      ).not.toBeInTheDocument();
      expect(transport.delegateRuntimeLogin).not.toHaveBeenCalled();
    }
  );

  it('says nothing about a Retry, because Settings has no turn to re-send', async () => {
    renderFlow({ isLocalCaller: false });

    expect(await screen.findByTestId('remote-signin-notice')).toHaveTextContent(
      'Open DorkOS there and sign in.'
    );
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('names the on-this-computer-by-network-address case, which the main advice gets wrong', async () => {
    renderFlow({ isLocalCaller: false });

    expect(await screen.findByTestId('remote-signin-notice')).toHaveTextContent(
      'Already on that computer? Open DorkOS at localhost instead.'
    );
  });

  it('fires no connect request at all while the notice is up', async () => {
    const transport = renderFlow({ isLocalCaller: false });
    await screen.findByTestId('remote-signin-notice');

    for (const button of screen.queryAllByRole('button')) {
      await userEvent.click(button);
    }
    expect(transport.delegateRuntimeLogin).not.toHaveBeenCalled();
    expect(transport.storeRuntimeCredential).not.toHaveBeenCalled();
  });
});

describe('Settings connect flow on the machine DorkOS runs on', () => {
  it('still offers the real sign-in, exactly as before', async () => {
    renderFlow({ isLocalCaller: true });

    expect(await screen.findByTestId('login-connect-claude-code')).toBeVisible();
    expect(screen.queryByTestId('remote-signin-notice')).not.toBeInTheDocument();
  });

  it('assumes local when the server reports no such field at all', async () => {
    // Same polarity the chat card uses: an answer nobody gave is not a `false`,
    // so an older server keeps the behaviour it has today.
    renderFlow({});

    expect(await screen.findByTestId('login-connect-claude-code')).toBeVisible();
    expect(screen.queryByTestId('remote-signin-notice')).not.toBeInTheDocument();
  });
});
