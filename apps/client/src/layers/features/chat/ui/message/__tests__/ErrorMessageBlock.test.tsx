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

  it('renders category heading and subtext for execution_error', () => {
    render(<ErrorMessageBlock message="API error" category="execution_error" />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
    expect(screen.getByText('An error occurred during execution.')).toBeInTheDocument();
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

  it('falls back to execution-error copy for an unrecognized category', () => {
    // Forward-compat: a category the client does not know about must not crash.
    render(<ErrorMessageBlock message="future error" category={'some_future_category' as never} />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
  });
});
