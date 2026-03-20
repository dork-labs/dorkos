/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ThinkingBlock } from '../ThinkingBlock';

describe('ThinkingBlock', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders "Thinking..." label during streaming', () => {
    // Purpose: During active streaming, the label should show "Thinking..."
    render(<ThinkingBlock text="reasoning" isStreaming={true} />);

    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('renders "Thought for Xs" label after streaming completes', () => {
    // Purpose: After completion, shows elapsed time in collapsed chip.
    render(<ThinkingBlock text="reasoning" isStreaming={false} elapsedMs={5000} />);

    expect(screen.getByText('Thought for 5s')).toBeInTheDocument();
  });

  it('renders thinking content when expanded', () => {
    // Purpose: Content should be visible during streaming (starts expanded).
    render(<ThinkingBlock text="My thinking process here" isStreaming={true} />);

    expect(screen.getByText('My thinking process here')).toBeInTheDocument();
  });

  it('toggles content visibility on click when not streaming', () => {
    // Purpose: Post-streaming, clicking the header should expand/collapse content.
    render(<ThinkingBlock text="Detailed reasoning" isStreaming={false} elapsedMs={3000} />);

    // Initially collapsed (auto-collapse on stream end)
    expect(screen.queryByText('Detailed reasoning')).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Detailed reasoning')).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('Detailed reasoning')).not.toBeInTheDocument();
  });

  it('disables button during streaming', () => {
    // Purpose: Users should not be able to collapse while thinking is actively streaming.
    render(<ThinkingBlock text="thinking..." isStreaming={true} />);

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });

  it('has correct aria-expanded attribute', () => {
    // Purpose: ARIA compliance — screen readers need expand/collapse state.
    const { rerender } = render(<ThinkingBlock text="thinking" isStreaming={true} />);

    // Expanded during streaming
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');

    // After streaming ends, auto-collapses
    rerender(<ThinkingBlock text="thinking" isStreaming={false} elapsedMs={2000} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('has correct aria-label', () => {
    // Purpose: Verify accessible label matches visible text.
    render(<ThinkingBlock text="thinking" isStreaming={false} elapsedMs={8000} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Thought for 8s');
  });

  it('has data-testid attribute', () => {
    // Purpose: Test hook for browser tests.
    render(<ThinkingBlock text="thinking" isStreaming={false} />);

    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();
  });

  it('has data-streaming attribute when streaming', () => {
    // Purpose: CSS/selector hook for streaming state.
    render(<ThinkingBlock text="thinking" isStreaming={true} />);

    expect(screen.getByTestId('thinking-block')).toHaveAttribute('data-streaming');
  });

  it('formats duration <1s correctly', () => {
    // Purpose: Short thinking durations show "<1s".
    render(<ThinkingBlock text="quick" isStreaming={false} elapsedMs={500} />);

    expect(screen.getByText('Thought for <1s')).toBeInTheDocument();
  });

  it('formats duration in minutes correctly', () => {
    // Purpose: Long thinking durations format as "Xm Ys".
    render(<ThinkingBlock text="long" isStreaming={false} elapsedMs={125000} />);

    expect(screen.getByText('Thought for 2m 5s')).toBeInTheDocument();
  });

  it('falls back to "Thinking..." when no elapsedMs provided', () => {
    // Purpose: When thinking is done but elapsedMs wasn't tracked, show generic label.
    render(<ThinkingBlock text="thinking" isStreaming={false} />);

    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });
});
