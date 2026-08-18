/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TIMING } from '@/layers/shared/lib';
import { AutoHideThinking } from '../auto-hiding-parts';

const THOUGHT = { text: 'weighing the two options', isStreaming: false, elapsedMs: 1200 };

describe('AutoHideThinking', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('always shows the block when auto-hide is off', () => {
    render(<AutoHideThinking part={THOUGHT} autoHide={false} index={0} />);
    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();
  });

  it('hides a thought that was already complete on mount when auto-hide is on', () => {
    render(<AutoHideThinking part={THOUGHT} autoHide index={0} />);
    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument();
  });

  it('keeps a streaming thought visible, then hides it after the auto-hide delay once it completes', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <AutoHideThinking part={{ ...THOUGHT, isStreaming: true }} autoHide index={0} />
    );
    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();

    rerender(<AutoHideThinking part={{ ...THOUGHT, isStreaming: false }} autoHide index={0} />);
    // Still visible right after it completes — the hide is delayed, not instant.
    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(TIMING.TOOL_CALL_AUTO_HIDE_MS);
    });
    // Seeded defect: drop the `initialStatusRef.current !== 'complete'` branch's
    // timer → this stays on screen and the assertion goes red.
    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument();
  });
});
