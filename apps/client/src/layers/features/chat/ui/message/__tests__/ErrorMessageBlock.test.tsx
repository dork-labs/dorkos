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

// The card resolves the failing runtime off the session-list cache. Mocking the
// LIST rather than a lookup helper keeps the card's own resolution running for
// real, so these tests cover it too.
const { sessionRows, sessionsLoading } = vi.hoisted(() => ({
  sessionRows: { current: [] as Session[] },
  sessionsLoading: { current: false },
}));
vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => ({ sessions: sessionRows.current, isLoading: sessionsLoading.current }),
}));

const SESSION_ID = 'session-1';

/** A session-list row carrying only what the auth card reads off it. */
function sessionRow(runtime: string): Session {
  return { id: SESSION_ID, runtime } as Session;
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
  sessionsLoading.current = false;
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
    it('signs Claude Code in from the card, naming the session to sign in for', async () => {
      // Purpose: the whole point of the card. The primary button runs the
      // delegated login in place, and names THIS session so the server pins the
      // account it is bound to — signing into the default account instead would
      // report success while the session kept failing (the DOR-1652 bug).
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
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
        sessionId: SESSION_ID,
        accountRoot: undefined,
      });
      // It signed in HERE — it did not send the person to Settings.
      expect(openSettings).not.toHaveBeenCalled();
    });

    it('names the session for Codex too, and lets the server decide the account', async () => {
      // Purpose: Codex has no config-dir account concept, but the client must
      // not be the thing that knows that — sending the session id is always
      // safe, and the server resolves it to no pin. Keeping the rule in one
      // place is why the client no longer branches on runtime here.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('codex')];
      const transport = renderBlock(
        <ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />
      );

      await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));

      expect(transport.delegateRuntimeLogin).toHaveBeenCalledWith('codex', {
        sessionId: SESSION_ID,
        accountRoot: undefined,
      });
    });

    it('uses the same per-runtime wording Settings uses', async () => {
      // Purpose: the copy table is shared (entities/runtime), so a person who
      // reads "Sign in with ChatGPT" in Settings reads it here too. A private
      // copy in either surface is how the two drift.
      sessionRows.current = [sessionRow('codex')];
      renderBlock(<ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />);

      expect(
        await screen.findByRole('button', { name: 'Sign in with ChatGPT' })
      ).toBeInTheDocument();
    });

    it('keeps one login across an unmount, so scrolling away cannot start a second', async () => {
      // Purpose: the card lives in a VIRTUALIZED transcript (overscan 5), so
      // scrolling the failed turn out of view unmounts the row mid-login. With
      // component-local mutation state the remounted row showed a pristine
      // "Sign in" button and a second click spawned a second `claude auth
      // login`. The state lives in the shared MutationCache for exactly this.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const login = deferred<DelegatedLoginResult>();
      const delegateRuntimeLogin = vi.fn(() => login.promise);
      const transport = createMockTransport({ delegateRuntimeLogin });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      });
      const card = <ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />;
      const wrap = (ui: React.ReactNode) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{ui}</TransportProvider>
        </QueryClientProvider>
      );
      const view = render(wrap(card));

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByText('Waiting for sign-in to complete…')).toBeInTheDocument();

      // Scroll it out of view and back: the row unmounts and remounts.
      view.rerender(wrap(null));
      view.rerender(wrap(card));

      // Still pending — not a fresh, clickable "Sign in".
      expect(await screen.findByText('Waiting for sign-in to complete…')).toBeInTheDocument();
      expect(screen.getByTestId('auth-error-signin-button')).toBeDisabled();

      await act(async () => {
        login.resolve({ ok: true });
      });
      await waitFor(() => {
        expect(screen.getByTestId('auth-error-signin-success')).toBeInTheDocument();
      });
      // One attempt, not two.
      expect(delegateRuntimeLogin).toHaveBeenCalledTimes(1);
    });

    it('reports a completed sign-in once, even if the row remounts afterwards', async () => {
      // Purpose: `onSigninComplete` becomes a turn RE-SEND in DOR-1650, so
      // firing it twice sends the person's message twice. The success state
      // lives in the shared MutationCache and outlives the row, so a latch
      // held per component instance resets on the remount the virtualized
      // transcript performs routinely — and re-fires against a success that
      // already happened. The latch has to key on the sign-in, not the row.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const onSigninComplete = vi.fn();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      });
      const card = (
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          sessionId={SESSION_ID}
          onSigninComplete={onSigninComplete}
        />
      );
      const wrap = (ui: React.ReactNode) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={createMockTransport()}>{ui}</TransportProvider>
        </QueryClientProvider>
      );
      const view = render(wrap(card));

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => {
        expect(screen.getByTestId('auth-error-signin-success')).toBeInTheDocument();
      });
      expect(onSigninComplete).toHaveBeenCalledTimes(1);

      // Scroll the settled card out of view and back.
      view.rerender(wrap(null));
      view.rerender(wrap(card));

      // The remounted card still shows the landing — and does not re-announce it.
      expect(await screen.findByTestId('auth-error-signin-success')).toBeInTheDocument();
      expect(onSigninComplete).toHaveBeenCalledTimes(1);
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

      // The live region is mounted BEFORE there is anything to say, so the
      // status change is announced rather than appearing with its container.
      const status = screen.getByRole('status');
      expect(status).toBeEmptyDOMElement();

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByText('Waiting for sign-in to complete…')).toBeInTheDocument();
      // The button stays mounted and disabled — unmounting it would dump
      // keyboard focus to <body> in the middle of the flow.
      expect(screen.getByTestId('auth-error-signin-button')).toBeDisabled();
      expect(document.body).not.toHaveFocus();

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

    it('stands on its own when the card has no Retry to offer', async () => {
      // Purpose: the shape a mid-history auth card takes once Retry is gated to
      // the final turn (DOR-1677). The sign-in is NOT position-dependent — the
      // runtime's login is broken now, whenever it broke — so the primary
      // action and its quiet fallback both survive, and only Retry goes.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const transport = renderBlock(
        <ErrorMessageBlock message="401 revoked" category="auth_error" sessionId={SESSION_ID} />
      );

      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use an API key instead' })).toBeInTheDocument();

      // And the button that remains is the working one, not a leftover.
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(transport.delegateRuntimeLogin).toHaveBeenCalledWith('claude-code', {
        sessionId: SESSION_ID,
        accountRoot: undefined,
      });
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

  describe('auth_error — what the card says once the message re-sends (DOR-1650)', () => {
    /** Render the card with a resume decision already made for it. */
    async function signInWith(resumed: boolean, onRetry = vi.fn()) {
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const onSigninComplete = vi.fn(() => resumed);
      renderBlock(
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          sessionId={SESSION_ID}
          onRetry={onRetry}
          onSigninComplete={onSigninComplete}
        />
      );
      await user.click(await screen.findByRole('button', { name: 'Sign in' }));
      await waitFor(() => {
        expect(screen.getByTestId('auth-error-signin-success')).toBeInTheDocument();
      });
      return { onSigninComplete };
    }

    it('says the message is going again when the conversation re-sent it', async () => {
      // Purpose: the promise of the whole flow is "sign in once and your
      // message sends itself". A card that only says "Signed in." leaves the
      // person guessing whether they still have to press something.
      const { onSigninComplete } = await signInWith(true);

      expect(screen.getByRole('status')).toHaveTextContent(
        'Signed in. Sending your message again…'
      );
      expect(onSigninComplete).toHaveBeenCalledTimes(1);
    });

    it('hides Retry while the message is already on its way', async () => {
      // Purpose: a Retry button offered at the exact moment the message is
      // being re-sent is how one message becomes two.
      await signInWith(true);

      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('settles on a plain "Signed in." with Retry when nothing was re-sent', async () => {
      // Purpose: the honest half of the same sentence. When the conversation
      // decided the person moved on — a draft in the composer, a newer turn —
      // the card must not claim to be sending anything, and the decision goes
      // back to the person via Retry.
      await signInWith(false);

      expect(screen.getByRole('status')).toHaveTextContent('Signed in.');
      expect(screen.getByRole('status')).not.toHaveTextContent('Sending your message again');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('never claims to be sending when no consumer is wired at all', async () => {
      // Purpose: `onSigninComplete` is optional — the dev showcase and any
      // future host may omit it. A missing consumer must read as "nothing was
      // sent", not as a resume that never happened.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      renderBlock(<ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />);

      await user.click(await screen.findByRole('button', { name: 'Sign in' }));
      await waitFor(() => {
        expect(screen.getByTestId('auth-error-signin-success')).toBeInTheDocument();
      });
      expect(screen.getByRole('status')).not.toHaveTextContent('Sending your message again');
    });

    it('re-sends once across an unmount, and shows the settled state after', async () => {
      // Purpose: the two halves of the remount hazard, in one test.
      //
      // The half that MUST hold: the re-send fires once. The transcript is
      // virtualized (overscan 5) and a re-send grows it, so the card that
      // announced the resume is routinely scrolled out of view a moment later —
      // and a remount that re-fired would send the person's message twice.
      //
      // The half that is deliberately allowed to lapse: the "Sending your
      // message again…" line is component-local and does not survive. That is
      // the honest reading by then — the send already happened, the transcript
      // above shows it, and a card still promising a send would be the stale
      // one. Pinned so the trade-off is a decision, not a surprise.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const onSigninComplete = vi.fn(() => true);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      });
      const card = (
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          sessionId={SESSION_ID}
          onRetry={vi.fn()}
          onSigninComplete={onSigninComplete}
        />
      );
      const wrap = (ui: React.ReactNode) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={createMockTransport()}>{ui}</TransportProvider>
        </QueryClientProvider>
      );
      const view = render(wrap(card));

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Sending your message again…');
      });

      view.rerender(wrap(null));
      view.rerender(wrap(card));

      expect(await screen.findByTestId('auth-error-signin-success')).toBeInTheDocument();
      expect(onSigninComplete).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).not.toHaveTextContent('Sending your message again');
    });

    it('does not re-send when the sign-in failed', async () => {
      // Purpose: a failed sign-in fixed nothing, so re-sending would walk the
      // person straight back into the same wall. The card offers "Try again"
      // and sends nothing on its own.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const onSigninComplete = vi.fn(() => true);
      renderBlock(
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          sessionId={SESSION_ID}
          onSigninComplete={onSigninComplete}
        />,
        { delegateRuntimeLogin: vi.fn(async () => ({ ok: false, error: 'Sign-in timed out.' })) }
      );

      await user.click(await screen.findByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in timed out.');
      expect(onSigninComplete).not.toHaveBeenCalled();
    });

    it('defers the re-send when the card is scrolled away mid-sign-in, and still sends once', async () => {
      // Purpose: pin the other half of the virtualization trade-off, which is a
      // real lapse and not the same one as the remount case above.
      //
      // The hook that reports a landing lives IN the card. Scroll the failed
      // turn out of a virtualized transcript while the login is still running
      // and there is no longer anything mounted to hear it settle — so the
      // resume does not happen at that moment. It is DEFERRED, not lost: the
      // success sits in the shared MutationCache, and the row that comes back
      // into view reads it and reports then. Nothing re-reports afterwards.
      //
      // This is the right side of the trade. The alternative — hoisting the
      // subscription to the panel so it fires with nothing on screen — sends a
      // person's message while they are looking at another part of the
      // conversation, with no card anywhere saying so. On the panel-notice path
      // the question does not arise: that notice is not virtualized.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const onSigninComplete = vi.fn(() => true);
      const login = deferred<DelegatedLoginResult>();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      });
      const card = (
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          sessionId={SESSION_ID}
          onSigninComplete={onSigninComplete}
        />
      );
      const wrap = (ui: React.ReactNode) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider
            transport={createMockTransport({ delegateRuntimeLogin: () => login.promise })}
          >
            {ui}
          </TransportProvider>
        </QueryClientProvider>
      );
      const view = render(wrap(card));

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByText('Waiting for sign-in to complete…')).toBeInTheDocument();

      // Scrolled out of view, then the login lands with nothing listening.
      view.rerender(wrap(null));
      await act(async () => {
        login.resolve({ ok: true });
      });
      expect(onSigninComplete).not.toHaveBeenCalled();

      // Scrolled back: the row reads the settled attempt and reports it now.
      view.rerender(wrap(card));
      await waitFor(() => expect(onSigninComplete).toHaveBeenCalledTimes(1));

      // And once only — a second scroll-by does not send it again.
      view.rerender(wrap(null));
      view.rerender(wrap(card));
      expect(await screen.findByTestId('auth-error-signin-success')).toBeInTheDocument();
      expect(onSigninComplete).toHaveBeenCalledTimes(1);
    });

    it('reports one re-send for two cards in the same window', async () => {
      // Purpose: one failure can put two cards on screen at once — the inline
      // one in the transcript and the panel-level notice. They share a
      // QueryClient, so they share the attempt AND the once-only latch keyed on
      // its mutation id. Two cards, one login, one re-send.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const onSigninComplete = vi.fn(() => true);
      const delegateRuntimeLogin = vi.fn(async () => ({ ok: true }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      });
      const card = (
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          sessionId={SESSION_ID}
          onSigninComplete={onSigninComplete}
        />
      );
      render(
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={createMockTransport({ delegateRuntimeLogin })}>
            {card}
            {card}
          </TransportProvider>
        </QueryClientProvider>
      );

      await user.click((await screen.findAllByTestId('auth-error-signin-button'))[0]);
      await waitFor(() => {
        expect(screen.getAllByTestId('auth-error-signin-success')).toHaveLength(2);
      });

      expect(delegateRuntimeLogin).toHaveBeenCalledTimes(1);
      expect(onSigninComplete).toHaveBeenCalledTimes(1);
    });

    it('leaves a second window that did not sign in alone', async () => {
      // Purpose: the two-tab question, answered where it is decided. The
      // once-only latch is keyed by mutation id inside a per-QueryClient map,
      // and a QueryClient is per tab — there is no `broadcastQueryClient` and no
      // mutation persister in this app. So a tab that merely HAS the card open
      // never sees the other tab's login, never reaches `isSuccess`, and cannot
      // re-send. Only a tab whose own Sign in was pressed can.
      //
      // This covers only the case where ONE window pressed Sign in. Two windows
      // both pressing it is a different situation and is not a race the idle
      // guard can win: the server hands the second request the first's promise,
      // so both callbacks fire off one completion before either has POSTed.
      // That is handled by an explicit cross-window claim
      // (`useSigninResumeClaim`), tested in its own file and wired in
      // `ChatPanel` — not here, because this seam cannot see it.
      const user = userEvent.setup();
      sessionRows.current = [sessionRow('claude-code')];
      const signedInTab = vi.fn(() => true);
      const otherTab = vi.fn(() => true);
      const delegateRuntimeLogin = vi.fn(async () => ({ ok: true }));
      const transport = createMockTransport({ delegateRuntimeLogin });
      const tab = (onSigninComplete: () => boolean, testid: string) => (
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
            })
          }
        >
          <TransportProvider transport={transport}>
            <div data-testid={testid}>
              <ErrorMessageBlock
                message="401"
                category="auth_error"
                sessionId={SESSION_ID}
                onSigninComplete={onSigninComplete}
              />
            </div>
          </TransportProvider>
        </QueryClientProvider>
      );
      render(
        <>
          {tab(signedInTab, 'tab-a')}
          {tab(otherTab, 'tab-b')}
        </>
      );

      const tabA = await screen.findByTestId('tab-a');
      await user.click(tabA.querySelector('[data-testid="auth-error-signin-button"]')!);
      await waitFor(() => {
        expect(tabA.querySelector('[data-testid="auth-error-signin-success"]')).not.toBeNull();
      });

      expect(signedInTab).toHaveBeenCalledTimes(1);
      // The other window neither signed in nor re-sent anything.
      expect(otherTab).not.toHaveBeenCalled();
      expect(
        screen.getByTestId('tab-b').querySelector('[data-testid="auth-error-signin-success"]')
      ).toBeNull();
    });

    it('does not re-send for a card with no session to sign into', async () => {
      // Purpose: with no session there is no runtime, no account, and no
      // transcript — the card falls back to the settings deep-link and the
      // resume seam must not be reachable from it at all.
      const user = userEvent.setup();
      const onSigninComplete = vi.fn(() => true);
      renderBlock(
        <ErrorMessageBlock
          message="401"
          category="auth_error"
          onSigninComplete={onSigninComplete}
        />
      );

      await user.click(screen.getByRole('button', { name: 'Fix sign-in' }));
      expect(openSettings).toHaveBeenCalledWith('runtimes');
      expect(onSigninComplete).not.toHaveBeenCalled();
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
      //
      // That this path also needs NO data providers cannot be shown here,
      // because this file mocks `useSessions` and a mocked hook needs none
      // either way. `ErrorMessageBlock-no-providers.test.tsx` proves it against
      // the real session layer.
      const user = userEvent.setup();
      renderBlock(<ErrorMessageBlock message="401" category="auth_error" />);

      expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /fix sign-in/i }));

      expect(openSettings).toHaveBeenCalledWith('runtimes');
    });

    it('shows nothing while the session list is still loading', async () => {
      // Purpose: "loading" is not "no runtime". Rendering the deep-link now and
      // replacing it with a Sign in button a moment later is a control that
      // moves under the cursor on every cold load.
      sessionsLoading.current = true;
      sessionRows.current = [];
      renderBlock(<ErrorMessageBlock message="401" category="auth_error" sessionId={SESSION_ID} />);

      expect(screen.queryByRole('button', { name: /fix sign-in/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
      // The error itself still renders — only the actions wait.
      expect(screen.getByText('Sign in to your agent again')).toBeInTheDocument();
    });
  });

  it('falls back to execution-error copy for an unrecognized category', () => {
    // Forward-compat: a category the client does not know about must not crash.
    render(<ErrorMessageBlock message="future error" category={'some_future_category' as never} />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
  });
});
