// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MarkdownErrorBoundary } from '../markdown-error-boundary';

/** A child that throws on demand, mimicking a rejected lazy chunk import. */
function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error('Failed to fetch dynamically imported module');
  return <div>rendered ok</div>;
}

describe('MarkdownErrorBoundary', () => {
  // React logs caught errors to console.error; silence it for these cases so
  // the intentional throws don't spam the test output.
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders its children when nothing throws', () => {
    render(
      <MarkdownErrorBoundary resetKey="a">
        <Boom explode={false} />
      </MarkdownErrorBoundary>
    );
    expect(screen.getByText('rendered ok')).toBeTruthy();
  });

  it('shows the default note when a child throws', () => {
    render(
      <MarkdownErrorBoundary resetKey="a">
        <Boom explode />
      </MarkdownErrorBoundary>
    );
    expect(screen.getByText(/couldn.t be displayed/i)).toBeTruthy();
  });

  it('renders a custom fallback in place of the markdown', () => {
    render(
      <MarkdownErrorBoundary resetKey="a" fallback={<p>This README couldn’t be displayed.</p>}>
        <Boom explode />
      </MarkdownErrorBoundary>
    );
    expect(screen.getByText(/This README couldn/i)).toBeTruthy();
  });

  it('resets and re-attempts the render when resetKey changes', () => {
    const { rerender } = render(
      <MarkdownErrorBoundary resetKey="pkg-a">
        <Boom explode />
      </MarkdownErrorBoundary>
    );
    // Errored: fallback is shown.
    expect(screen.getByText(/couldn.t be displayed/i)).toBeTruthy();

    // New content (e.g. a different package's README) that renders fine — the
    // boundary must clear its error state, not stay stuck on the fallback.
    rerender(
      <MarkdownErrorBoundary resetKey="pkg-b">
        <Boom explode={false} />
      </MarkdownErrorBoundary>
    );
    expect(screen.getByText('rendered ok')).toBeTruthy();
    expect(screen.queryByText(/couldn.t be displayed/i)).toBeNull();
  });

  it('stays on the fallback while resetKey is unchanged', () => {
    const { rerender } = render(
      <MarkdownErrorBoundary resetKey="same">
        <Boom explode />
      </MarkdownErrorBoundary>
    );
    expect(screen.getByText(/couldn.t be displayed/i)).toBeTruthy();

    // Same key → no reset, even though the child would now render.
    rerender(
      <MarkdownErrorBoundary resetKey="same">
        <Boom explode={false} />
      </MarkdownErrorBoundary>
    );
    expect(screen.getByText(/couldn.t be displayed/i)).toBeTruthy();
    expect(screen.queryByText('rendered ok')).toBeNull();
  });
});
