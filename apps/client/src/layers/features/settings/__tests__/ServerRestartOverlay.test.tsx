// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { ServerRestartOverlay } from '../ui/ServerRestartOverlay';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';

describe('ServerRestartOverlay', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  const defaultProps = {
    open: true,
    onDismiss: vi.fn(),
  };

  function Wrapper({ children }: { children: React.ReactNode }) {
    return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockTransport = createMockTransport();
    // Default: health check fails (server is down)
    vi.mocked(mockTransport.health).mockRejectedValue(new Error('Connection refused'));
    // Mock window.location.reload
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, reload: vi.fn() },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders loading state when open', () => {
    render(<ServerRestartOverlay {...defaultProps} />, { wrapper: Wrapper });
    expect(screen.getByText('Restarting server...')).toBeInTheDocument();
    expect(screen.getByText('Waiting for server to come back...')).toBeInTheDocument();
  });

  it('does not render when not open', () => {
    render(<ServerRestartOverlay open={false} onDismiss={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('server-restart-overlay')).not.toBeInTheDocument();
  });

  it('polls health endpoint at 1.5s intervals', async () => {
    render(<ServerRestartOverlay {...defaultProps} />, { wrapper: Wrapper });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(mockTransport.health).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(mockTransport.health).toHaveBeenCalledTimes(2);
  });

  it('reloads page when health check succeeds', async () => {
    vi.mocked(mockTransport.health).mockResolvedValueOnce({
      status: 'ok',
      version: '1.0.0',
      uptime: 0,
    });
    render(<ServerRestartOverlay {...defaultProps} />, { wrapper: Wrapper });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('shows error state after 30 second timeout', async () => {
    render(<ServerRestartOverlay {...defaultProps} />, { wrapper: Wrapper });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText(/did not restart within 30 seconds/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('Try Again resets to loading state', async () => {
    render(<ServerRestartOverlay {...defaultProps} />, { wrapper: Wrapper });
    // Trigger timeout
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText(/did not restart within 30 seconds/i)).toBeInTheDocument();
    // Click Try Again
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });
    // Should be back to loading state
    expect(screen.getByText('Restarting server...')).toBeInTheDocument();
  });

  it('Dismiss calls onDismiss callback', async () => {
    render(<ServerRestartOverlay {...defaultProps} />, { wrapper: Wrapper });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(defaultProps.onDismiss).toHaveBeenCalled();
  });
});
