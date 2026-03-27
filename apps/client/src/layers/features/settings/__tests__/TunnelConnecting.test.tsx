// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TunnelConnecting } from '../ui/TunnelConnecting';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('TunnelConnecting', () => {
  it('renders the connecting container', () => {
    render(<TunnelConnecting />);
    expect(screen.getByTestId('tunnel-connecting')).toBeInTheDocument();
  });

  it('renders the first step immediately on mount', () => {
    render(<TunnelConnecting />);
    expect(screen.getByText('Initialising ngrok agent')).toBeInTheDocument();
  });

  it('renders all three step labels', () => {
    render(<TunnelConnecting />);
    expect(screen.getByText('Initialising ngrok agent')).toBeInTheDocument();
    expect(screen.getByText('Opening secure tunnel')).toBeInTheDocument();
    expect(screen.getByText('Registering public URL')).toBeInTheDocument();
  });

  it('shows the second step after 500ms', () => {
    const { container } = render(<TunnelConnecting />);

    // Before 500ms the second step row is opacity-0
    const rows = container.querySelectorAll('[class*="flex items-center gap-3"]');
    expect(rows[1]?.className).toContain('opacity-0');

    act(() => {
      vi.advanceTimersByTime(500);
    });

    // After 500ms the second step becomes visible (opacity-100)
    const updatedRows = container.querySelectorAll('[class*="flex items-center gap-3"]');
    expect(updatedRows[1]?.className).toContain('opacity-100');
  });

  it('shows the third step after 1200ms', () => {
    const { container } = render(<TunnelConnecting />);

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    const rows = container.querySelectorAll('[class*="flex items-center gap-3"]');
    expect(rows[2]?.className).toContain('opacity-100');
  });

  it('first step transitions from active to done when the second step activates', () => {
    const { container } = render(<TunnelConnecting />);

    // Before 500ms — first step is active (spinner visible, text is text-foreground)
    const firstRowBefore = container.querySelectorAll('[class*="flex items-center gap-3"]')[0];
    expect(firstRowBefore?.querySelector('.animate-spin')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    // After 500ms — first step is done (no spinner, text is muted)
    const firstRowAfter = container.querySelectorAll('[class*="flex items-center gap-3"]')[0];
    expect(firstRowAfter?.querySelector('.animate-spin')).not.toBeInTheDocument();
  });
});
