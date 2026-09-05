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

  // The banner used to announce nothing at all, so a screen-reader user was
  // never told the link had dropped. Riding `Banner` supplies the roles: a lost
  // link interrupts (`alert`), a retry waits its turn (`status`).
  it('announces a lost link assertively', () => {
    render(<ConnectionStatusBanner connectionState="disconnected" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Server link lost.');
  });

  it('announces a retry politely', () => {
    render(<ConnectionStatusBanner connectionState="reconnecting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
  });
});
