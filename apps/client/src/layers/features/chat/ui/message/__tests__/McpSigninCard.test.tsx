/**
 * The inline sign-in card and its auto-resume (DOR-1004).
 *
 * The product promise is that a person signs in, comes back, and finds the agent
 * already working — which means exactly one `ui_action` per finished sign-in.
 * Three guards keep that true, and each is pinned here because each failure is
 * silent and expensive:
 *
 * - fires ONCE, however many times the card re-renders;
 * - fires only in the tab the person actually clicked through, so a session open
 *   in three tabs does not resume the agent three times;
 * - a locked session (`409`) settles quietly — the agent is already busy, and a
 *   retry loop against a lock is a storm nobody asked for.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessagePart } from '@dorkos/shared/types';
import type { McpSigninPollResult, Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { resetMcpSigninOwnership } from '@/layers/entities/agent';
import { TransportProvider } from '@/layers/shared/model';
import { McpSigninCard, resetResumedSigninFlows } from '../McpSigninCard';

const SESSION_ID = 'sess-1';
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

/**
 * A `connected` poll body, optionally carrying a tool count.
 *
 * `toolCount` is not on `McpSigninPollResult` yet — it is being added on the
 * server side separately, which is exactly why the card reads it defensively.
 * The cast is how this test sends the body a running server may already send.
 */
function connectedPoll(toolCount?: number): McpSigninPollResult {
  return {
    status: 'connected',
    ...(toolCount === undefined ? {} : { toolCount }),
  } as McpSigninPollResult;
}

/**
 * Make the poll answer `pending` first and `connected` after.
 *
 * An adopted card starts watching its flow straight away, so a mock that answers
 * `connected` on the first call retires the link before a test can click it —
 * which is not a sign-in anyone has ever performed.
 */
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
  resetResumedSigninFlows();
  resetMcpSigninOwnership();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Render the card and click the sign-in link, making this render the flow's owner. */
async function renderAndOpen(transport: Transport) {
  const view = render(<McpSigninCard part={PART} sessionId={SESSION_ID} />, {
    wrapper: wrapperFor(transport),
  });
  await tick();
  fireEvent.click(screen.getByRole('link', { name: `Open the sign-in page for ${SERVER}` }));
  await tick();
  return view;
}

/** Click the sign-in link, which is what makes THIS render the flow's owner. */
function openSigninLink(): void {
  fireEvent.click(screen.getByRole('link', { name: `Open the sign-in page for ${SERVER}` }));
}

describe('McpSigninCard', () => {
  it('shows the disclosure ABOVE the link, adopted from the pushed card', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.pollMcpSignin).mockResolvedValue({ status: 'pending' });
    render(<McpSigninCard part={PART} sessionId={SESSION_ID} />, {
      wrapper: wrapperFor(transport),
    });

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

  it('resumes the agent EXACTLY ONCE when the sign-in connects', async () => {
    const transport = createMockTransport();
    pollsThenConnects(transport, 7);
    // StrictMode, because the app runs under it (`main.tsx`) and it mounts every
    // effect twice. Without the fire-once ref that is two resume turns for one
    // sign-in — in development, on every single sign-in.
    const { rerender } = render(
      <StrictMode>
        <McpSigninCard part={PART} sessionId={SESSION_ID} />
      </StrictMode>,
      { wrapper: wrapperFor(transport) }
    );
    await tick();
    openSigninLink();
    await tick(2_100);
    expect(transport.sendUiAction).toHaveBeenCalledTimes(1);

    // Re-renders must not re-fire either: the guard is a ref, not render state.
    rerender(
      <StrictMode>
        <McpSigninCard part={PART} sessionId={SESSION_ID} />
      </StrictMode>
    );
    await tick(5_000);
    expect(transport.sendUiAction).toHaveBeenCalledTimes(1);

    const [sessionId, action] = vi.mocked(transport.sendUiAction).mock.calls[0];
    expect(sessionId).toBe(SESSION_ID);
    expect(action.payload).toMatchObject({ server: SERVER, toolCount: 7 });
    // The agent is told to carry on, and told NOT to narrate what just happened.
    expect(String(action.payload?.instructions)).toContain('Continue the task');
    expect(String(action.payload?.instructions)).toContain('Do not describe or narrate');
  });

  it('does not resume again when the transcript re-mounts', async () => {
    // Switching sessions and coming back rebuilds the whole message list — and
    // this page is still the owner, because it is still the tab that sent the
    // person to the provider. So the fire-once guard has to outlive the component
    // too, or the agent is asked to pick the job up a second time for a sign-in
    // that happened once.
    const transport = createMockTransport();
    pollsThenConnects(transport, 7);
    const { unmount } = await renderAndOpen(transport);
    await tick(2_100);
    expect(transport.sendUiAction).toHaveBeenCalledTimes(1);

    unmount();
    vi.mocked(transport.pollMcpSignin).mockResolvedValue(connectedPoll(7));
    render(<McpSigninCard part={PART} sessionId={SESSION_ID} />, {
      wrapper: wrapperFor(transport),
    });
    await tick(2_100);

    expect(transport.sendUiAction).toHaveBeenCalledTimes(1);
  });

  it('still resumes when the transcript re-mounted BEFORE the sign-in landed', async () => {
    // The person clicks the link, switches sessions while the browser tab is
    // open, and comes back. Ownership held on the component would have died with
    // it, and the sign-in would land to silence — the exact opposite of the point.
    const transport = createMockTransport();
    vi.mocked(transport.pollMcpSignin).mockResolvedValue({ status: 'pending' });
    const { unmount } = await renderAndOpen(transport);
    unmount();

    pollsThenConnects(transport, 3);
    render(<McpSigninCard part={PART} sessionId={SESSION_ID} />, {
      wrapper: wrapperFor(transport),
    });
    await tick(2_100);
    await tick(2_100);

    expect(transport.sendUiAction).toHaveBeenCalledTimes(1);
  });

  it('shows the payoff with the tool count the server reported', async () => {
    const transport = createMockTransport();
    pollsThenConnects(transport, 7);
    await renderAndOpen(transport);

    await tick(2_100);
    expect(screen.getByText('Connected — 7 tools.')).toBeInTheDocument();
  });

  it('never claims a tool count the server did not report', async () => {
    // `toolCount` is optional on the wire. Reading it as a number regardless would
    // put "Connected — 0 tools." under a sign-in that in fact worked.
    const transport = createMockTransport();
    pollsThenConnects(transport);
    await renderAndOpen(transport);

    await tick(2_100);
    expect(screen.getByText(/tools are available on the next turn/)).toBeInTheDocument();
    expect(screen.queryByText(/0 tools/)).not.toBeInTheDocument();
  });

  it('settles quietly when the session is locked, with no retry', async () => {
    const transport = createMockTransport();
    pollsThenConnects(transport, 2);
    const locked = Object.assign(new Error('Session is locked'), { code: 'SESSION_LOCKED' });
    vi.mocked(transport.sendUiAction).mockRejectedValue(locked);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await renderAndOpen(transport);
    await tick(2_100);
    expect(transport.sendUiAction).toHaveBeenCalledTimes(1);

    // No storm: the failure is terminal, and the card still shows the payoff.
    await tick(30_000);
    expect(transport.sendUiAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Connected — 2 tools.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('never resumes from a card hydrated in another tab', async () => {
    // The same card renders in every tab watching the session, and every one of
    // them WATCHES the flow — so every one of them sees it connect and shows the
    // payoff. Only the tab where the person actually clicked the link owns it and
    // may act on it; without that guard, a session open in three tabs resumes the
    // agent three times.
    const transport = createMockTransport();
    vi.mocked(transport.pollMcpSignin).mockResolvedValue(connectedPoll(7));

    render(<McpSigninCard part={PART} sessionId={SESSION_ID} />, {
      wrapper: wrapperFor(transport),
    });
    await tick(2_100);

    // It really did observe the sign-in land — this is not a test that passes
    // because nothing happened.
    expect(transport.pollMcpSignin).toHaveBeenCalled();
    expect(screen.getByText('Connected — 7 tools.')).toBeInTheDocument();
    expect(transport.sendUiAction).not.toHaveBeenCalled();
  });

  it('renders a terminal note instead of a card once the sign-in failed', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.pollMcpSignin).mockResolvedValue({ status: 'pending' });
    render(<McpSigninCard part={{ ...PART, outcome: 'failed' }} sessionId={SESSION_ID} />, {
      wrapper: wrapperFor(transport),
    });

    await tick();
    expect(screen.getByTestId('mcp-signin-failed')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
