/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ErrorMessageBlock } from '../ErrorMessageBlock';

// The component deep-links to Settings → Runtimes via useSettingsDeepLink,
// which needs TanStack Router context. Mock the hook to a plain spy.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', () => ({
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

describe('ErrorMessageBlock', () => {
  afterEach(() => {
    cleanup();
    openSettings.mockClear();
  });
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

  describe('auth_error', () => {
    it('renders the runtime-aware friendly heading and re-auth subtext', () => {
      render(
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
      render(<ErrorMessageBlock message="401 revoked" category="auth_error" />);

      expect(screen.getByText('Sign in to your agent again')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Your agent login stopped working. Sign in again to pick up where you left off.'
        )
      ).toBeInTheDocument();
    });

    it('renders a "Fix sign-in" button that deep-links to the runtimes settings tab', () => {
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
      render(
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

  it('falls back to execution-error copy for an unrecognized category', () => {
    // Forward-compat: a category the client does not know about must not crash.
    render(<ErrorMessageBlock message="future error" category={'some_future_category' as never} />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
  });
});
