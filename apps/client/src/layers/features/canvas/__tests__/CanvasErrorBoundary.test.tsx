/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// Minimal Button stand-in: the real barrel pulls in the whole shared/ui surface,
// and the boundary only needs a clickable element with an accessible name.
vi.mock('@/layers/shared/ui', () => ({
  Button: ({
    children,
    onClick,
    type,
  }: {
    children: ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
  }) => (
    <button type={type ?? 'button'} onClick={onClick}>
      {children}
    </button>
  ),
}));

import { CanvasErrorBoundary } from '../ui/CanvasErrorBoundary';

// React logs every boundary-caught error to console.error — silence it so the
// suite output stays honest about real failures.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  cleanup();
});

/** A viewer that always throws on render. */
function Boom({ message = 'kaboom' }: { message?: string }): never {
  throw new Error(message);
}

describe('CanvasErrorBoundary', () => {
  it('renders its child when nothing throws', () => {
    render(
      <CanvasErrorBoundary documentId="d1">
        <div>viewer content</div>
      </CanvasErrorBoundary>
    );
    expect(screen.getByText('viewer content')).toBeInTheDocument();
  });

  it('catches a viewer render throw and shows the friendly card with Retry', () => {
    render(
      <CanvasErrorBoundary documentId="d1">
        <Boom />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText('This tab hit a problem.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // A generic (non-chunk) error never offers the app reload.
    expect(screen.queryByRole('button', { name: /reload app/i })).not.toBeInTheDocument();
  });

  it('Retry re-attempts the viewer — recovering once the underlying failure clears', async () => {
    const user = userEvent.setup();
    // A viewer whose failure is transient: while `throws` is set every render
    // fails (so the boundary shows the fallback, not React's own error-recovery
    // re-render). Clearing it before Retry proves the button re-attempts render.
    const control = { throws: true };
    function MaybeThrow() {
      if (control.throws) throw new Error('viewer unavailable');
      return <div>viewer recovered</div>;
    }

    render(
      <CanvasErrorBoundary documentId="d1">
        <MaybeThrow />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText('This tab hit a problem.')).toBeInTheDocument();
    expect(screen.queryByText('viewer recovered')).not.toBeInTheDocument();

    // The underlying failure clears, then the user retries.
    control.throws = false;
    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(screen.getByText('viewer recovered')).toBeInTheDocument();
    expect(screen.queryByText('This tab hit a problem.')).not.toBeInTheDocument();
  });

  it('offers a Reload app affordance for a stale-chunk dynamic-import error', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });

    render(
      <CanvasErrorBoundary documentId="d1">
        <Boom message="Failed to fetch dynamically imported module: https://x/CodeMirrorEditor-9f3a.js" />
      </CanvasErrorBoundary>
    );

    expect(screen.getByText('This tab hit a problem.')).toBeInTheDocument();
    // The chunk-specific hint + reload button appear only for import failures.
    expect(screen.getByText(/app may have updated/i)).toBeInTheDocument();
    // Retry is NOT offered for a stale chunk — React caches the rejected import,
    // so a remount would re-throw instantly; a full reload is the only remedy.
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /reload app/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
