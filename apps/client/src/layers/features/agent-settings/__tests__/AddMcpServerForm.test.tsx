/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { AddMcpServerForm, TRANSPORTS } from '../ui/AddMcpServerForm';

// Radix Select drives itself with pointer capture and scrolls the highlighted
// option into view — browser APIs jsdom does not implement, and without them the
// listbox never opens, so the closed trigger is all a test can see.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

function renderForm(
  transport: Transport,
  supportedTransports: readonly (typeof TRANSPORTS)[number][],
  onAdded: (server: { name: string; transport: (typeof TRANSPORTS)[number] }) => void = () => {},
  oauthDetectedFor: string | null = null
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(
    <AddMcpServerForm
      agentId="01HZ0000000000000000000001"
      agentLabel="Test Agent"
      supportedTransports={supportedTransports}
      onAdded={onAdded}
      oauthDetectedFor={oauthDetectedFor}
    />,
    { wrapper }
  );
}

/** Open the form, then open the transport menu and read back every option offered. */
function offeredTransports(): string[] {
  fireEvent.click(screen.getByRole('button', { name: /add server/i }));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  return within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

describe('AddMcpServerForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('hides sse for a Codex-supported transport set (no SSE transport, DOR-892)', () => {
    const transport = createMockTransport();
    renderForm(transport, ['stdio', 'http']);

    expect(offeredTransports()).toEqual(['stdio', 'http']);
  });

  it('shows sse for a runtime that supports the full transport set', () => {
    const transport = createMockTransport();
    renderForm(transport, TRANSPORTS);

    expect(offeredTransports()).toEqual(['stdio', 'http', 'sse']);
  });

  it('reports what it added, with the fields still filled in (DOR-985)', async () => {
    const onAdded = vi.fn();
    const transport = createMockTransport({
      addAgentMcpServer: vi.fn().mockResolvedValue({ status: 'ok', servers: [] }),
    });
    renderForm(transport, TRANSPORTS, onAdded);

    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'granola' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'http' }));
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://mcp.granola.ai/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Reporting after `reset()` would hand back an empty name — the form's own
    // fields are cleared by then, which is why the callback reads the input it
    // submitted rather than current state.
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith({ name: 'granola', transport: 'http' })
    );
  });

  /** Fill in and submit an http server called `granola`. */
  function addHttpServer(): void {
    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'granola' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'http' }));
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://mcp.granola.ai/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  }

  /** The roster `mcp.add` returns for a server it could tell needs OAuth. */
  function oauthRoster() {
    return [
      {
        name: 'granola',
        enabled: true,
        connection: {
          transport: 'http',
          url: 'https://mcp.granola.ai/mcp',
          headers: {},
          authKind: 'oauth2',
        },
        addedAt: '2026-08-06T00:00:00.000Z',
        addedBy: 'operator',
      },
    ];
  }

  it('flows straight into signing in when the added server needs OAuth (DOR-1004)', async () => {
    // Before this, adding an OAuth server ended with the form closing and the
    // person having to spot a row telling them to press Sign in. The disclosure
    // and the link now land where they are already looking.
    const transport = createMockTransport({
      addAgentMcpServer: vi.fn().mockResolvedValue({ status: 'ok', servers: oauthRoster() }),
      startMcpSignin: vi.fn().mockResolvedValue({
        flowId: 'flow-1',
        authorizeUrl: 'https://auth.example/authorize',
        alreadyConnected: false,
        disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
        message: 'link',
      }),
    });
    renderForm(transport, TRANSPORTS);

    addHttpServer();

    await waitFor(() => expect(screen.getByText('Sign in to granola')).toBeInTheDocument());
    // Consent order: the disclosure is on screen, and the link is under it.
    expect(
      await screen.findByText('DorkOS keeps the resulting token encrypted on this computer.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the sign-in page for granola' })).toHaveAttribute(
      'href',
      'https://auth.example/authorize'
    );
  });

  it('resets as before when the added server needs no sign-in', async () => {
    const transport = createMockTransport({
      addAgentMcpServer: vi.fn().mockResolvedValue({
        status: 'ok',
        servers: [
          {
            name: 'granola',
            enabled: true,
            connection: { transport: 'http', url: 'https://mcp.granola.ai/mcp', headers: {} },
            addedAt: '2026-08-06T00:00:00.000Z',
            addedBy: 'operator',
          },
        ],
      }),
    });
    renderForm(transport, TRANSPORTS);

    addHttpServer();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add server/i })).toBeInTheDocument()
    );
    expect(screen.queryByText('Sign in to granola')).not.toBeInTheDocument();
    expect(transport.startMcpSignin).not.toHaveBeenCalled();
  });

  it('offers the sign-in when a later probe is what discovered it (DOR-1004)', async () => {
    // The slower of the two routes: `mcp.add` could not tell, and the roster's
    // unattended probe came back 401 a beat after the form had already settled.
    const transport = createMockTransport({
      startMcpSignin: vi.fn().mockResolvedValue({
        flowId: 'flow-1',
        authorizeUrl: 'https://auth.example/authorize',
        alreadyConnected: false,
        disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
        message: 'link',
      }),
    });
    renderForm(transport, TRANSPORTS, () => {}, 'granola');

    expect(await screen.findByText('Sign in to granola')).toBeInTheDocument();
  });

  it('reports nothing while the add is still waiting on approval', async () => {
    const onAdded = vi.fn();
    const transport = createMockTransport({
      addAgentMcpServer: vi.fn().mockResolvedValue({
        status: 'approval_required',
        approval: { status: 'approval_required', approvalId: 'a', approvalToken: 't' },
      }),
    });
    renderForm(transport, TRANSPORTS, onAdded);

    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'granola' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Nothing was written yet, so nothing to follow up on.
    await waitFor(() =>
      expect(screen.getByText(/Confirm this server for Test Agent/i)).toBeInTheDocument()
    );
    expect(onAdded).not.toHaveBeenCalled();
  });
});
