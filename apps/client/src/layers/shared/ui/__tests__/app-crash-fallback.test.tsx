// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppCrashFallback } from '../app-crash-fallback';

describe('AppCrashFallback', () => {
  let reloadMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    reloadMock = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, reload: reloadMock },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation,
    });
  });

  it('renders error message from error prop', () => {
    render(<AppCrashFallback error={new Error('Provider crashed')} resetErrorBoundary={vi.fn()} />);
    expect(screen.getByText('Provider crashed')).toBeTruthy();
  });

  // DOR-1755: the raw error used to be the ONLY explanation on the crash
  // screen, so a person met `ENOENT: no such file or directory` with nothing
  // else to read. It now sits under a labelled Details line, below a sentence
  // that tells them what to do.
  it('leads with a plain sentence and files the raw error under Details', () => {
    render(<AppCrashFallback error={new Error('Provider crashed')} resetErrorBoundary={vi.fn()} />);

    expect(screen.getByText('DorkOS stopped. Sorry about that.')).toBeTruthy();
    expect(screen.getByText(/Reload to pick up where you left off/)).toBeTruthy();
    expect(screen.getByText('Details')).toBeTruthy();
  });

  it('renders "Reload DorkOS" button', () => {
    render(<AppCrashFallback error={new Error('fail')} resetErrorBoundary={vi.fn()} />);
    expect(screen.getByRole('button', { name: /reload dorkos/i })).toBeTruthy();
  });

  it('calls window.location.reload() when button is clicked', async () => {
    const user = userEvent.setup();
    render(<AppCrashFallback error={new Error('fail')} resetErrorBoundary={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /reload dorkos/i }));
    expect(reloadMock).toHaveBeenCalled();
  });

  it('shows stack trace in dev mode', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at Object.<anonymous>';

    render(<AppCrashFallback error={err} resetErrorBoundary={vi.fn()} />);
    expect(screen.getByText('Stack trace (dev only)')).toBeTruthy();
  });

  it('hides stack trace in production mode', () => {
    const originalDev = import.meta.env.DEV;
    import.meta.env.DEV = false;

    try {
      const err = new Error('boom');
      err.stack = 'Error: boom\n    at Object.<anonymous>';

      render(<AppCrashFallback error={err} resetErrorBoundary={vi.fn()} />);
      expect(screen.queryByText('Stack trace (dev only)')).toBeNull();
    } finally {
      import.meta.env.DEV = originalDev;
    }
  });

  it('renders with inline styles only (no className attributes on any element)', () => {
    const { container } = render(
      <AppCrashFallback error={new Error('test')} resetErrorBoundary={vi.fn()} />
    );
    const allElements = container.querySelectorAll('*');
    allElements.forEach((el) => {
      expect(el.getAttribute('class')).toBeNull();
    });
  });
});
