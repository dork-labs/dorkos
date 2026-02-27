/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConnectionStatusBanner } from '../ConnectionStatusBanner';

afterEach(cleanup);

describe('ConnectionStatusBanner', () => {
  it('returns null when connected', () => {
    const { container } = render(<ConnectionStatusBanner connectionState="connected" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows reconnecting banner with Wifi icon', () => {
    render(<ConnectionStatusBanner connectionState="reconnecting" />);
    expect(screen.getByText(/Reconnecting/i)).toBeInTheDocument();
  });

  it('shows disconnected banner with WifiOff icon', () => {
    render(<ConnectionStatusBanner connectionState="disconnected" />);
    expect(screen.getByText('Connection lost. Check your network.')).toBeInTheDocument();
  });

  it('uses amber styling for reconnecting', () => {
    const { container } = render(<ConnectionStatusBanner connectionState="reconnecting" />);
    expect(container.firstChild).toHaveClass('bg-amber-500/10');
  });

  it('uses red styling for disconnected', () => {
    const { container } = render(<ConnectionStatusBanner connectionState="disconnected" />);
    expect(container.firstChild).toHaveClass('bg-red-500/10');
  });
});
