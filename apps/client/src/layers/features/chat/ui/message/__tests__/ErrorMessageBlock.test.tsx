/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import type { DelegatedLoginResult } from '@dorkos/shared/runtime-connect';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ErrorMessageBlock } from '../ErrorMessageBlock';

// The component deep-links to Settings → Runtimes via useSettingsDeepLink,
// which needs TanStack Router context. Override just that hook — the rest of
// the module (TransportProvider, useTransport) has to stay real, because the
// inline sign-in reaches the transport through it.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

// The card resolves the failing runtime and that session's bound account from
// the session-list cache. Mocking the LIST (not the two hooks that read it)
// keeps `useSessionRuntime`/`useSessionAccount` running for real, so these
// tests cover the lookup as well as the card.
const { sessionRows } = vi.hoisted(() => ({ sessionRows: { current: [] as Session[] } }));
vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => ({ sessions: sessionRows.current, isLoading: false }),
}));

const SESSION_ID = 'session-1';

/** A session-list row carrying only what the auth card reads off it. */
function sessionRow(runtime: string, account?: string): Session {
  return { id: SESSION_ID, runtime, ...(account ? { account } : {}) } as Session;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Render the block with the providers the inline sign-in needs. */
function renderBlock(
  ui: ReactNode,
  overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}
) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

afterEach(() => {
  cleanup();
  openSettings.mockClear();
  sessionRows.current = [];
});

describe('ErrorMessageBlock', () => {
  it('renders category heading and subtext for max_turns', () => {
    render(<ErrorMessageBlock message="Hit limit" category="max_turns" />);

    expect(screen.getByText('Turn limit reached')).toBeInTheDocument();
    expect(screen.getByText('The agent ran for its maximum number of turns.')).toBeInTheDocument();
  });

  it('shows the runtime message rather than the generic execution_error copy', () => {
    // The generic sentence only restates the heading, so it must never shadow
    // what the runtime actually said — the inline error path passes no
    // `subtext`, and used to lose the message entirely because of it.
    render(<ErrorMessageBlock message="API error" category="execution_error" />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
    expect(screen.getByText('API error')).toBeInTheDocument();
    expect(screen.queryByText('An error occurred during execution.')).not.toBeInTheDocument();
  });

  it('falls back to the generic execution_error copy when there is no message', () => {
    render(<ErrorMessageBlock message="   " category="execution_error" />);

    expect(screen.getByText('An error occurred during execution.')).toBeInTheDocument();
  });

  it('keeps the category copy and does not paraphrase it with the runtime message', () => {
    // A self-explanatory category's message is normally a restatement of its
    // own copy, so it earns no prose line — it goes under Details instead.
    render(<ErrorMessageBlock message="Reached 30 turns" category="max_turns" />);

    expect(screen.getByText('The agent ran for its maximum number of turns.')).toBeInTheDocument();
    expect(screen.queryByText('Reached 30 turns')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText('Reached 30 turns')).toBeInTheDocument();
  });

  it('surfaces a self-explanatory category message when it carries a link', () => {
    render(
      <ErrorMessageBlock
        message="Cost limit hit. Raise it at https://dorkos.ai/settings/budget"
        category="budget_exceeded"
      />
    );

    expect(screen.getByText('This session exceeded its budget.')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://dorkos.ai/settings/budget' })
    ).toBeInTheDocument();
  });

  it('does not repeat a message whose only difference from the subtext is whitespace', () => {
    // `TurnFailedNotice` and `ChatPanel` pass the SAME string as `message` and
    // `subtext`; `message` is trimmed on the way in, so an untrimmed comparison
    // printed a trailing-newline message twice (DOR-1661 review, nit 1).
    render(
      <ErrorMessageBlock
        message={'Sidecar exited\n'}
        category="execution_error"
        subtext={'Sidecar exited\n'}
      />
    );

    expect(screen.getAllByText('Sidecar exited')).toHaveLength(1);
  });

  it('does not repeat the message when the caller already put it in the subtext', () => {
    // `TurnFailedNotice`'s shape: heading + subtext both supplied.
    render(
      <ErrorMessageBlock
        message="Sidecar exited"
        category="execution_error"
        heading="OpenCode stopped unexpectedly"
        subtext="Sidecar exited"
      />
    );

    expect(screen.getAllByText('Sidecar exited')).toHaveLength(1);
  });

  it('renders category heading for budget_exceeded', () => {
    render(<ErrorMessageBlock message="Over budget" category="budget_exceeded" />);

    expect(screen.getByText('Cost limit reached')).toBeInTheDocument();
  });

  it('renders category heading for output_format_error', () => {
    render(<ErrorMessageBlock message="Bad format" category="output_format_error" />);

    expect(screen.getByText('Output format error')).toBeInTheDocument();
  });

  it('shows retry button only for execution_error with onRetry', () => {
    const onRetry = vi.fn();
    render(<ErrorMessageBlock message="Error" category="execution_error" onRetry={onRetry} />);

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does not show retry button for non-retryable categories', () => {
    const onRetry = vi.fn();
    render(<ErrorMessageBlock message="Error" category="max_turns" onRetry={onRetry} />);

    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('does not show retry button when onRetry is not provided', () => {
    render(<ErrorMessageBlock message="Error" category="execution_error" />);

    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<ErrorMessageBlock message="Error" category="execution_error" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows collapsible details when details are provided', () => {
    render(
      <ErrorMessageBlock message="Error" category="execution_error" details="Stack trace here" />
    );

    expect(screen.queryByText('Stack trace here')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText('Stack trace here')).toBeInTheDocument();
  });

  it('does not show details button when no details provided', () => {
    render(<ErrorMessageBlock message="Error" category="execution_error" />);

    expect(screen.queryByText('Details')).not.toBeInTheDocument();
  });

  it('falls back to generic heading when no category', () => {
    render(<ErrorMessageBlock message="Something went wrong" />);

    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  describe('auth_error copy', () => {
    it('renders the runtime-aware friendly heading and re-auth subtext', () => {
      renderBlock(
        <ErrorMessageBlock message="401 revoked" category="auth_error" runtimeLabel="Claude" />
      );

      expect(screen.getByText('Sign in to Claude again')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Your Claude login stopped working. Sign in again to pick up where you left off.'
        )
      ).toBeInTheDocument();
    });

    it('falls back to a neutral runtime name when none is supplied', () => {
      renderBlock(<ErrorMessageBlock message="401 revoked" category="auth_error" />);

      expect(screen.getByText('Sign in to your agent again')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Your agent login stopped working. Sign in again to pick up where you left off.'
        )
      ).toBeInTheDocument();
    });

    it('renders a "Fix sign-in" button that deep-links to the runtimes settings tab', () => {
      // No `sessionId`, so there is no runtime to sign in and the deep-link is
      // still the whole action (DOR-1651 changed only the WITH-session path;
      // its labels are covered in the inline-sign-in block below).
      render(
        <ErrorMessageBlock message="401 revoked" category="auth_error" runtimeLabel="Claude" />
      );

      fireEvent.click(screen.getByRole('button', { name: /fix sign-in/i }));
      expect(openSettings).toHaveBeenCalledWith('runtimes');
    });

    it('still shows what the runtime said instead of dropping it', () => {
      // The friendly copy used to REPLACE the raw message, so a provider error
      // carrying the one actionable instruction arrived with it deleted.
      render(
        <ErrorMessageBlock
          message="No credits. Add some at https://openrouter.ai/settings/credits"
          category="auth_error"
          runtimeLabel="OpenCode"
        />
      );

      expect(
        screen.getByText(
          'Your OpenCode login stopped working. Sign in again to pick up where you left off.'
        )
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'https://openrouter.ai/settings/credits' })
      ).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
    });

    it('does not paraphrase its own copy on claude-code, the default runtime', () => {
      // The premise "the message is provider text we were dropping" is FALSE on
      // claude-code: `messaging/message-sender.ts` already substitutes DorkOS's
      // own sentence and parks the raw string in `details`. Printing it under
      // the friendly copy gave three lines saying one thing (DOR-1661 review,
      // red 2). Verified against the real producer, not an invented shape.
      render(
        <ErrorMessageBlock
          message="Your sign-in stopped working. Sign in again to keep going."
          category="auth_error"
          details="OAuth token exchange failed: 401 invalid_grant"
          runtimeLabel="Claude"
        />
      );

      expect(
        screen.getByText(
          'Your Claude login stopped working. Sign in again to pick up where you left off.'
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Your sign-in stopped working. Sign in again to keep going.')
      ).not.toBeInTheDocument();

      // Still not lost — it joins the raw details rather than falling off.
      fireEvent.click(screen.getByText('Details'));
      expect(
        screen.getByText(/Your sign-in stopped working\. Sign in again to keep going\./)
      ).toBeInTheDocument();
    });

    it('does not paraphrase its own copy for the SDK-mapped auth message either', () => {
      // The other claude-code producer: `sdk/sdk-error-mapping.ts`.
      render(
        <ErrorMessageBlock
          message="Authentication failed. Re-authenticate Claude Code and try again."
          category="auth_error"
          runtimeLabel="Claude"
        />
      );

      expect(
        screen.queryByText('Authentication failed. Re-authenticate Claude Code and try again.')
      ).not.toBeInTheDocument();
    });

    it('renders a secondary Retry button when onRetry is provided', () => {
      const onRetry = vi.fn();
      renderBlock(
        <ErrorMessageBlock
          message="401 revoked"
          category="auth_error"
          runtimeLabel="Claude"
          onRetry={onRetry}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRetry).toHaveBeenCalledOnce();
    });
  });

  describe('URLs in error text', () => {
    it('links a URL in the subtext', () => {
      render(
        <ErrorMessageBlock
          message="Out of credits. Top up at https://openrouter.ai/settings/credits"
          category="execution_error"
        />
      );

      const link = screen.getByRole('link', {
        name: 'https://openrouter.ai/settings/credits',
      });
      expect(link).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('links a URL in a caller-supplied subtext', () => {
      render(
        <ErrorMessageBlock
          message="ignored"
          heading="Couldn't reach the provider"
          subtext="Check status at https://status.example/incidents"
        />
      );

      expect(
        screen.getByRole('link', { name: 'https://status.example/incidents' })
      ).toHaveAttribute('href', 'https://status.example/incidents');
    });

    it('links a URL inside the collapsible details', () => {
      render(
        <ErrorMessageBlock
          message="Request failed"
          category="execution_error"
          details="[http_402] See https://openrouter.ai/docs/errors"
        />
      );

      fireEvent.click(screen.getByText('Details'));
      expect(
        screen.getByRole('link', { name: 'https://openrouter.ai/docs/errors' })
      ).toHaveAttribute('href', 'https://openrouter.ai/docs/errors');
    });

    it('does not let error text inject markup', () => {
      const { container } = render(
        <ErrorMessageBlock
          message={'<img src=x onerror=alert(1)> **not bold**'}
          category="execution_error"
        />
      );

      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('strong')).toBeNull();
      expect(screen.getByText('<img src=x onerror=alert(1)> **not bold**')).toBeInTheDocument();
    });
  });

  describe('auth_error — inline sign-in (DOR-1651)', () => {
    it('signs Claude Code in from the card, pinned to that session’s account', async () => {
      // Purpose: the whole point of the card. The primary button runs the
      // delegated login in place, and pins it to the account THIS session is
      // bound to — signing into the default account instead would report
      // success while the session kept failing (the DOR-1652 seam).
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code', '/Users/dev/.claude2')];
      const transport = renderBlock(
        <ErrorMessageBlock
          message="401 revoked"
          category="auth_error"
          runtimeLabel="Claude"
          sessionId={SESSION_ID}
        />
      );

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(transport.delegateRuntimeLogin).toHaveBeenCalledWith('claude-code', {
        accountRoot: '/Users/dev/.claude2',
      });
      // It signed in HERE — it did not send the person to Settings.
      expect(openSettings).not.toHaveBeenCalled();
    });

    it('sends no account pin when the session reports no account', async () => {
      // Purpose: a single-account machine has no account to name, and an
      // unrecognized root is refused server-side — so "unknown" must mean
      // "sign into the usual account", not an invented value.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const transport = renderBlock(
        <ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />
      );

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(transport.delegateRuntimeLogin).toHaveBeenCalledWith('claude-code', undefined);
    });

    it('signs Codex in inline, and never sends it an account pin', async () => {
      // Purpose: Codex gets the same inline path, but it has no config-dir
      // account concept — the server rejects the pin outright, so a stray
      // account on the row must not turn a working sign-in into an error.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('codex', '/Users/dev/.claude2')];
      const transport = renderBlock(
        <ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />
      );

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(transport.delegateRuntimeLogin).toHaveBeenCalledWith('codex', undefined);
    });

    it('shows progress while the sign-in runs, then confirms it landed', async () => {
      // Purpose: the delegated login opens a browser and can take a while. The
      // card has to say so, then say when it is done, without the person
      // leaving the conversation to find out.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const login = deferred<DelegatedLoginResult>();
      renderBlock(
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          sessionId={SESSION_ID}
          onRetry={vi.fn()}
        />,
        { delegateRuntimeLogin: vi.fn(() => login.promise) }
      );

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByTestId('auth-error-signin-pending')).toBeInTheDocument();
      expect(screen.getByText('Waiting for sign-in to complete…')).toBeInTheDocument();

      await act(async () => {
        login.resolve({ ok: true });
      });
      expect(await screen.findByTestId('auth-error-signin-success')).toBeInTheDocument();
      expect(screen.getByText('Signed in.')).toBeInTheDocument();
    });

    it('reports a refused sign-in honestly and offers another go', async () => {
      // Purpose: a denied or timed-out login must not read as success. The
      // server's real message shows, and the button becomes "Try again".
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const transport = renderBlock(
        <ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />,
        {
          delegateRuntimeLogin: vi
            .fn()
            .mockResolvedValue({ ok: false, error: 'Sign-in timed out. Please try again.' }),
        }
      );

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Sign-in timed out. Please try again.'
      );
      expect(screen.queryByTestId('auth-error-signin-success')).not.toBeInTheDocument();

      // And the retry genuinely re-runs the sign-in.
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => {
        expect(transport.delegateRuntimeLogin).toHaveBeenCalledTimes(2);
      });
    });

    it('surfaces an endpoint refusal instead of leaving a dead button', async () => {
      // Purpose: the login route is loopback-only, and the Obsidian embed
      // declines it outright. Reaching sign-in from a phone or tunnel is
      // DOR-1655 — until then the card must say why nothing happened rather
      // than swallow the refusal.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      renderBlock(
        <ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />,
        {
          delegateRuntimeLogin: vi
            .fn()
            .mockRejectedValue(new Error('Runtime connect actions are only available locally')),
        }
      );

      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Runtime connect actions are only available locally'
      );
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('keeps the settings route as a quiet link, named for what it gets you', async () => {
      // Purpose: the API-key form lives in Settings → Runtimes. It stays
      // reachable, but demoted — one quiet link under the primary action, not
      // a second button competing with it.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      renderBlock(<ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />);

      const link = screen.getByRole('button', { name: 'Use an API key instead' });
      await user.click(link);
      expect(openSettings).toHaveBeenCalledWith('runtimes');
    });
  });

  describe('auth_error — runtimes with no sign-in to run', () => {
    it('keeps the settings deep-link for OpenCode', async () => {
      // Purpose: OpenCode's "connect" is picking where the model comes from,
      // not logging in (`runtimeAuthConnectKind` → provider-picker). An inline
      // "Sign in" button would be a lie, so the deep-link stays.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('opencode')];
      const transport = renderBlock(
        <ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />
      );

      expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /fix sign-in/i }));

      expect(openSettings).toHaveBeenCalledWith('runtimes');
      expect(transport.delegateRuntimeLogin).not.toHaveBeenCalled();
    });

    it('keeps the settings deep-link when no session is in context', async () => {
      // Purpose: with no session there is no way to know which runtime failed,
      // so there is nothing honest to sign into — fall back rather than guess.
      const user = userEvent.setup();
      const transport = renderBlock(<ErrorMessageBlock message="401" category="auth_error" />);

      expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /fix sign-in/i }));

      expect(openSettings).toHaveBeenCalledWith('runtimes');
      expect(transport.delegateRuntimeLogin).not.toHaveBeenCalled();
    });
  });

  it('falls back to execution-error copy for an unrecognized category', () => {
    // Forward-compat: a category the client does not know about must not crash.
    render(<ErrorMessageBlock message="future error" category={'some_future_category' as never} />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
  });
});
