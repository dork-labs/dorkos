/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { STATUS_TONE_SURFACE } from '@/layers/shared/ui';
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
    expect(screen.getByText('Server link lost. Check your network.')).toBeInTheDocument();
  });

  // The banner wears the app's shared status surfaces, so its amber and red
  // are the same ones every other warning and error surface spends — and each
  // token carries its own dark-mode value, which is what let the hand-written
  // `dark:text-red-400` pair go away.
  it('uses the warning surface for reconnecting', () => {
    const { container } = render(<ConnectionStatusBanner connectionState="reconnecting" />);
    expect(container.firstChild).toHaveClass(...STATUS_TONE_SURFACE.warning.split(' '));
  });

  it('uses the error surface for disconnected', () => {
    const { container } = render(<ConnectionStatusBanner connectionState="disconnected" />);
    expect(container.firstChild).toHaveClass(...STATUS_TONE_SURFACE.error.split(' '));
  });
});
