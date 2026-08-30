/**
 * The inline sign-in card (DOR-1004) — the DISPLAY half.
 *
 * The auto-resume that used to live here is gone: it is triggered server-side at
 * the moment the token exchange succeeds, so it fires with no tab open, survives
 * a reload, and cannot double-fire however many people are watching. What this
 * file pins is that the card holds up its end — consent order, the sign-in
 * landing without a server round trip, a terminal receipt that says what was
 * connected, a failure that offers a way out — and that it triggers NOTHING.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessagePart } from '@dorkos/shared/types';
import type { McpSigninPollResult, Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { McpSigninCard } from '../McpSigninCard';

const AGENT_ID = '01HZ0000000000000000000001';
const SERVER = 'granola';

const PART: Extract<MessagePart, { type: 'mcp_signin' }> = {
  type: 'mcp_signin',
  serverName: SERVER,
  agentId: AGENT_ID,
  flowId: 'flow-1',
  authorizeUrl: 'https://auth.example/authorize?x=1',
  disclosure: 'DorkOS keeps the resulting token encrypted on this computer.',
};

/** A `connected` poll body, optionally carrying the tool count DOR-1003 added. */
function connectedPoll(toolCount?: number): McpSigninPollResult {
  return { status: 'connected', ...(toolCount === undefined ? {} : { toolCount }) };
}

/** Make the poll answer `pending` first and `connected` after. */
function pollsThenConnects(transport: Transport, toolCount?: number): void {
  vi.mocked(transport.pollMcpSignin)
    .mockResolvedValueOnce({ status: 'pending' })
    .mockResolvedValue(connectedPoll(toolCount));
}

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * Advance the fake clock twice so the poll resolves AND React re-renders.
 *
 * Every wait here is an explicit tick rather than `waitFor`/`findBy*`: those poll
 * on real time, which never advances under fake timers, so they hang instead of
 * failing.
 *
 * @param ms - How far to move the fake clock.
 */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('McpSigninCard', () => {
  it('shows the disclosure ABOVE the link, adopted from the pushed card', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.pollMcpSignin).mockResolvedValue({ status: 'pending' });
    render(<McpSigninCard part={PART} />, { wrapper: wrapperFor(transport) });

    await tick();
    const disclosure = screen.getByText(PART.disclosure);
    const link = screen.getByRole('link', { name: `Open the sign-in page for ${SERVER}` });
    expect(link).toHaveAttribute('href', PART.authorizeUrl);
    // Reading order is the consent order.
    expect(
      disclosure.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // The card adopts the pushed flow — it never starts one of its own.
    expect(transport.startMcpSignin).not.toHaveBeenCalled();
  });

  it('triggers NOTHING when the sign-in lands — the resume is the server’s job', async () => {
    // The card used to POST a ui_action here. That resume now fires server-side
    // on the token exchange, so it survives a reload and cannot double-fire; a
    // client that still triggered would give every watching tab a second turn.
    const transport = createMockTransport();
    pollsThenConnects(transport, 7);
    render(<McpSigninCard part={PART} />, { wrapper: wrapperFor(transport) });

    await tick();
    fireEvent.click(screen.getByRole('link', { name: `Open the sign-in page for ${SERVER}` }));
    await tick(2_100);

    // It really did observe the sign-in land — this is not a test that passes
    // because nothing happened.
    expect(screen.getByText('Connected · 7 tools.')).toBeInTheDocument();
    expect(transport.sendUiAction).not.toHaveBeenCalled();
    expect(transport.postMessage).not.toHaveBeenCalled();
  });

  it('watches without a click, so a tab that did not send you still sees it land', async () => {
    const transport = createMockTransport();
    pollsThenConnects(transport, 7);
    render(<McpSigninCard part={PART} />, { wrapper: wrapperFor(transport) });

    await tick(2_100);

    expect(transport.pollMcpSignin).toHaveBeenCalledWith('flow-1');
    expect(screen.getByText('Connected · 7 tools.')).toBeInTheDocument();
    expect(transport.sendUiAction).not.toHaveBeenCalled();
  });

  it('never claims a tool count the server did not report', async () => {
    // `toolCount` is optional on the wire. Reading it as a number regardless would
    // put "Connected · 0 tools." under a sign-in that in fact worked.
    const transport = createMockTransport();
    pollsThenConnects(transport);
    render(<McpSigninCard part={PART} />, { wrapper: wrapperFor(transport) });

    await tick(2_100);
    expect(screen.getByText(/tools are available on the next turn/)).toBeInTheDocument();
    expect(screen.queryByText(/0 tools/)).not.toBeInTheDocument();
  });

  it('surfaces the provider’s OWN reason when a watched sign-in fails', async () => {
    // A watching card is not in the `waiting` phase, and the error used to be
    // computed only for that phase — so the specific reason the provider gave was
    // dropped and the person read the generic fallback instead.
    const transport = createMockTransport();
    vi.mocked(transport.pollMcpSignin)
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'failed', error: 'The workspace admin blocked this app.' });
    render(<McpSigninCard part={PART} />, { wrapper: wrapperFor(transport) });

    await tick(2_100);

    expect(screen.getByRole('alert')).toHaveTextContent('The workspace admin blocked this app.');
  });

  it('offers Try again on a failed sign-in instead of dead-ending', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.pollMcpSignin)
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'failed', error: 'nope' });
    vi.mocked(transport.startMcpSignin).mockResolvedValue({
      flowId: 'flow-2',
      authorizeUrl: 'https://auth.example/authorize?x=2',
      alreadyConnected: false,
      disclosure: PART.disclosure,
      message: 'link',
    });
    render(<McpSigninCard part={PART} />, { wrapper: wrapperFor(transport) });

    await tick(2_100);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await tick();

    expect(transport.startMcpSignin).toHaveBeenCalledWith(AGENT_ID, SERVER);
  });

  it('renders a terminal receipt naming what was connected', async () => {
    // The durable record: the runtime's transcript never saw the sign-in, and the
    // settings row shows a live status rather than a history.
    const transport = createMockTransport();
    render(<McpSigninCard part={{ ...PART, outcome: 'connected', toolCount: 7 }} />, {
      wrapper: wrapperFor(transport),
    });

    await tick();
    expect(screen.getByTestId('mcp-signin-receipt')).toHaveTextContent(
      'Connected to granola · 7 tools.'
    );
    // A settled receipt is not a live card: no link, and no polling.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(transport.pollMcpSignin).not.toHaveBeenCalled();
  });

  it('renders a receipt without a count when the server reported none', async () => {
    const transport = createMockTransport();
    render(<McpSigninCard part={{ ...PART, outcome: 'connected' }} />, {
      wrapper: wrapperFor(transport),
    });

    await tick();
    expect(screen.getByTestId('mcp-signin-receipt')).toHaveTextContent('Connected to granola.');
    expect(screen.queryByText(/0 tools/)).not.toBeInTheDocument();
  });

  it('renders a terminal note instead of a card once the sign-in failed', async () => {
    const transport = createMockTransport();
    render(<McpSigninCard part={{ ...PART, outcome: 'failed' }} />, {
      wrapper: wrapperFor(transport),
    });

    await tick();
    expect(screen.getByTestId('mcp-signin-failed')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
