// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TunnelError } from '../ui/TunnelError';

afterEach(cleanup);

describe('TunnelError', () => {
  it('renders the error container', () => {
    render(<TunnelError error="some error" onRetry={vi.fn()} />);
    expect(screen.getByTestId('tunnel-error')).toBeInTheDocument();
  });

  it('always shows the "Connection failed" heading', () => {
    render(<TunnelError error="some error" onRetry={vi.fn()} />);
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('renders the "Try again" button', () => {
    render(<TunnelError error="some error" onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('calls onRetry when the "Try again" button is clicked', () => {
    const onRetry = vi.fn();
    render(<TunnelError error="some error" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not call onRetry until the button is clicked', () => {
    const onRetry = vi.fn();
    render(<TunnelError error="some error" onRetry={onRetry} />);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('displays a friendly message for auth token errors', () => {
    render(<TunnelError error="ERR_NGROK_105 bad auth" onRetry={vi.fn()} />);
    expect(screen.getByText('Check your auth token at dashboard.ngrok.com')).toBeInTheDocument();
  });

  it('displays a friendly message for timeout errors', () => {
    render(<TunnelError error="connection ETIMEDOUT" onRetry={vi.fn()} />);
    expect(screen.getByText('Connection timed out. Check your network.')).toBeInTheDocument();
  });

  it('displays a friendly message for tunnel limit errors', () => {
    render(<TunnelError error="ERR_NGROK_108 limit reached" onRetry={vi.fn()} />);
    expect(
      screen.getByText('Tunnel limit reached. Free ngrok accounts allow one active tunnel.')
    ).toBeInTheDocument();
  });

  it('displays the raw error message when no friendly mapping exists', () => {
    render(<TunnelError error="unknown weird error" onRetry={vi.fn()} />);
    expect(screen.getByText('unknown weird error')).toBeInTheDocument();
  });

  it('does not display a raw error message when a friendly mapping applies', () => {
    render(<TunnelError error="ERR_NGROK_105 bad auth" onRetry={vi.fn()} />);
    expect(screen.queryByText('ERR_NGROK_105 bad auth')).toBeNull();
  });
});
