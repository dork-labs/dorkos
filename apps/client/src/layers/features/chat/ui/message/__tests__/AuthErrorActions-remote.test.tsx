/**
 * @vitest-environment jsdom
 */
/**
 * What the auth-error card offers a browser that is NOT on the machine DorkOS
 * runs on — a phone over the tunnel, a laptop on the LAN (DOR-1655).
 *
 * Its own file rather than a describe inside `ErrorMessageBlock.test.tsx`
 * because the two suites want opposite defaults: that one is about the local
 * inline sign-in and should keep getting it, this one moves the server's
 * locality answer per test.
 *
 * The session-list read is mocked the same way its sibling mocks it — the LIST,
 * not a lookup helper — so the card's own runtime resolution still runs for
 * real. The locality answer is NOT mocked at the hook: it comes back through a
 * real `useConfig` over the mock Transport, so `getConfig` → `isLocalCaller` →
 * hook → component is exercised end to end and a break anywhere on that path
 * shows up here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ErrorMessageBlock } from '../ErrorMessageBlock';

// Only the router-backed deep link is stubbed; every data path stays real.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

const { sessionRows } = vi.hoisted(() => ({ sessionRows: { current: [] as Session[] } }));
vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => ({ sessions: sessionRows.current, isLoading: false }),
}));

const SESSION_ID = 'session-1';

/** A session-list row carrying only what the auth card reads off it. */
function sessionRow(runtime: string): Session {
  return { id: SESSION_ID, runtime } as Session;
}

/**
 * Render the card with a server that answers `isLocalCaller` as given.
 *
 * `getConfig` is overridden rather than the hook, so the assertion below spans
 * the whole path the product uses.
 *
 * @param options - `isLocalCaller` as the server would report it (omit it
 *   entirely to stand in for a server that reports no such field), the session
 *   runtime, and whether a retry is on offer.
 */
function renderCard(options: { isLocalCaller?: boolean; runtime?: string; onRetry?: () => void }) {
  const { isLocalCaller, runtime = 'claude-code', onRetry } = options;
  sessionRows.current = [sessionRow(runtime)];

  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      ...(isLocalCaller === undefined ? {} : { isLocalCaller }),
      port: 4242,
      tunnel: { enabled: false, connected: false, url: null },
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ErrorMessageBlock
          message="401 revoked"
          category="auth_error"
          sessionId={SESSION_ID}
          {...(onRetry ? { onRetry } : {})}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

/** The guidance, once the locality answer has landed. */
function guidance(): Promise<HTMLElement> {
  return screen.findByTestId('auth-error-remote-guidance');
}

afterEach(() => {
  cleanup();
  openSettings.mockClear();
  sessionRows.current = [];
});

describe('auth-error card on a browser that is not on this machine', () => {
  it('says where signing in has to happen, and offers no sign-in button', async () => {
    const transport = renderCard({ isLocalCaller: false, onRetry: vi.fn() });

    expect(await guidance()).toHaveTextContent('Signing in needs the computer DorkOS runs on.');
    expect(screen.getByText('Open DorkOS there and sign in, then press Retry here.')).toBeVisible();

    // The two doors onto the same 403 are both gone.
    expect(screen.queryByTestId('auth-error-signin')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /use an api key instead/i })
    ).not.toBeInTheDocument();
    expect(transport.delegateRuntimeLogin).not.toHaveBeenCalled();
  });

  it('never fires the login mutation, even after the card has settled', async () => {
    const transport = renderCard({ isLocalCaller: false });
    await guidance();

    // Nothing on this card can start one — there is no control that would, and
    // no effect fires one on mount.
    for (const button of screen.queryAllByRole('button')) {
      await userEvent.click(button);
    }
    expect(transport.delegateRuntimeLogin).not.toHaveBeenCalled();
    expect(transport.storeRuntimeCredential).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'codex', 'opencode'])(
    'gives the same answer for %s — the fix is in the same place for all of them',
    async (runtime) => {
      renderCard({ isLocalCaller: false, runtime });

      expect(await guidance()).toHaveTextContent('Signing in needs the computer DorkOS runs on.');
      // OpenCode's local card is the Settings deep-link rather than a sign-in;
      // remotely that destination is just as unreachable, so it goes too.
      expect(screen.queryByRole('button', { name: /fix sign-in/i })).not.toBeInTheDocument();
    }
  );

  it('keeps Retry, because that is the one thing that does work from here', async () => {
    const onRetry = vi.fn();
    renderCard({ isLocalCaller: false, onRetry });
    await guidance();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not promise a Retry that is not on screen', async () => {
    renderCard({ isLocalCaller: false });

    expect(await guidance()).toHaveTextContent('Open DorkOS there and sign in.');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe('auth-error card on the machine DorkOS runs on', () => {
  it('still signs in inline, exactly as before', async () => {
    // The regression pin for DOR-1651's inline sign-in: the remote branch must
    // not capture the local case.
    const transport = renderCard({ isLocalCaller: true, onRetry: vi.fn() });

    const button = await screen.findByTestId('auth-error-signin-button');
    expect(screen.queryByTestId('auth-error-remote-guidance')).not.toBeInTheDocument();

    await userEvent.click(button);
    await waitFor(() => expect(transport.delegateRuntimeLogin).toHaveBeenCalledTimes(1));
    expect(transport.delegateRuntimeLogin).toHaveBeenCalledWith('claude-code', {
      sessionId: SESSION_ID,
    });
  });

  it('offers the API-key route, which only exists where it can work', async () => {
    renderCard({ isLocalCaller: true });

    await screen.findByTestId('auth-error-signin');
    expect(screen.getByRole('button', { name: /use an api key instead/i })).toBeVisible();
  });

  it('assumes local until the answer lands, then swaps once it says otherwise', async () => {
    // The unknown answer renders the LOCAL card — the polarity `useLocalCaller`
    // documents — and the swap is what has to be proven, because nothing else
    // in this file can tell "the answer arrived and was false" apart from "the
    // component happened to start out remote".
    sessionRows.current = [sessionRow('claude-code')];
    let answer: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    const transport = createMockTransport({ getConfig: vi.fn().mockReturnValue(pending) });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <ErrorMessageBlock message="401 revoked" category="auth_error" sessionId={SESSION_ID} />
        </TransportProvider>
      </QueryClientProvider>
    );

    expect(screen.getByTestId('auth-error-signin')).toBeVisible();

    answer({ version: '1.0.0', isLocalCaller: false, port: 4242 });

    expect(await guidance()).toBeVisible();
    expect(screen.queryByTestId('auth-error-signin')).not.toBeInTheDocument();
    // The button was on screen and was never pressed, so nothing was started
    // that the swap would have to take back.
    expect(transport.delegateRuntimeLogin).not.toHaveBeenCalled();
  });

  it('assumes local when the server reports no such field at all', async () => {
    // An answer nobody gave is not a `false`. Telling someone to walk to another
    // computer on the strength of a missing field would be a guess dressed as a
    // fact, so the old behaviour stands and the endpoint's own refusal — which
    // is honest — remains the floor.
    renderCard({ runtime: 'claude-code' });

    expect(await screen.findByTestId('auth-error-signin')).toBeVisible();
    expect(screen.queryByTestId('auth-error-remote-guidance')).not.toBeInTheDocument();
  });
});
