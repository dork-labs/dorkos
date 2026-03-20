/**
 * @vitest-environment jsdom
 */
// Test the transport error banner rendering logic in isolation.
// The banner is inline in ChatPanel, so we replicate its JSX here
// to test rendering without ChatPanel's extensive dependencies.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import type { TransportErrorInfo } from '../../model/chat-types';

interface TransportErrorBannerProps {
  error: TransportErrorInfo | null;
  onRetry: () => void;
}

/** Minimal replica of the inline error banner JSX from ChatPanel. */
function TransportErrorBanner({ error, onRetry }: TransportErrorBannerProps) {
  if (!error) return null;

  return (
    <div className="border-destructive/30 bg-destructive/5 mx-4 mb-2 flex items-start gap-3 rounded-lg border px-3 py-2">
      <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-destructive text-sm font-medium">{error.heading}</p>
        <p className="text-muted-foreground text-sm">{error.message}</p>
      </div>
      {error.retryable && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}

describe('TransportErrorBanner', () => {
  afterEach(cleanup);

  it('does not render when error is null', () => {
    const { container } = render(<TransportErrorBanner error={null} onRetry={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders heading and message for a network error', () => {
    const error: TransportErrorInfo = {
      heading: 'Connection failed',
      message: 'Unable to reach the server. Check your network.',
      retryable: true,
    };

    render(<TransportErrorBanner error={error} onRetry={vi.fn()} />);

    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    expect(screen.getByText('Unable to reach the server. Check your network.')).toBeInTheDocument();
  });

  it('renders heading and message for a server error', () => {
    const error: TransportErrorInfo = {
      heading: 'Server error',
      message: 'An internal error occurred. Please try again.',
      retryable: false,
    };

    render(<TransportErrorBanner error={error} onRetry={vi.fn()} />);

    expect(screen.getByText('Server error')).toBeInTheDocument();
    expect(screen.getByText('An internal error occurred. Please try again.')).toBeInTheDocument();
  });

  it('shows retry button when error.retryable is true', () => {
    const error: TransportErrorInfo = {
      heading: 'Connection failed',
      message: 'Could not connect.',
      retryable: true,
    };

    render(<TransportErrorBanner error={error} onRetry={vi.fn()} />);

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does not show retry button when error.retryable is false', () => {
    const error: TransportErrorInfo = {
      heading: 'Server error',
      message: 'Something went wrong on the server.',
      retryable: false,
    };

    render(<TransportErrorBanner error={error} onRetry={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', () => {
    const onRetry = vi.fn();
    const error: TransportErrorInfo = {
      heading: 'Connection failed',
      message: 'Could not connect.',
      retryable: true,
    };

    render(<TransportErrorBanner error={error} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders session locked error correctly without retry button', () => {
    const error: TransportErrorInfo = {
      heading: 'Session locked',
      message: 'This session is in use by another client.',
      retryable: false,
    };

    render(<TransportErrorBanner error={error} onRetry={vi.fn()} />);

    expect(screen.getByText('Session locked')).toBeInTheDocument();
    expect(screen.getByText('This session is in use by another client.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
