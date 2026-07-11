/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach } from 'vitest';

const transport = {
  diffBaselineMediaUrl: vi.fn(
    (cwd: string, p: string, s: string): string | null =>
      `/api/diff/baseline/raw?cwd=${cwd}&path=${p}&sessionId=${s}`
  ),
  mediaUrl: vi.fn((cwd: string, p: string): string | null => `/api/files/raw?cwd=${cwd}&path=${p}`),
  revertDiffBaseline: vi.fn().mockResolvedValue(undefined),
  advanceDiffBaseline: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ selectedCwd: '/work', sessionId: 'sess-1' }),
  useTransport: () => transport,
}));

type SessionEventHandler = (sessionId: string, event: Record<string, unknown>) => void;
const streamMocks = vi.hoisted(() => ({
  handler: { current: null as SessionEventHandler | null },
}));

// The component tree pulls `cn` and (via useAgentEditRefresh) `streamManager`
// from the shared lib barrel — mock both so tests can fire session events.
vi.mock('@/layers/shared/lib', () => ({
  cn: (...inputs: unknown[]) => inputs.flat(Infinity).filter(Boolean).join(' '),
  streamManager: {
    subscribeSessionEvent: (handler: SessionEventHandler) => {
      streamMocks.handler.current = handler;
      return () => {
        streamMocks.handler.current = null;
      };
    },
  },
}));

import { CanvasImageDiffContent } from '../ui/CanvasImageDiffContent';

afterEach(cleanup);

const CONTENT = { type: 'diff' as const, sourcePath: 'assets/logo.png' };

describe('CanvasImageDiffContent', () => {
  beforeEach(() => {
    transport.diffBaselineMediaUrl.mockClear();
    transport.mediaUrl.mockClear();
    transport.revertDiffBaseline.mockClear().mockResolvedValue(undefined);
    transport.advanceDiffBaseline.mockClear().mockResolvedValue(undefined);
    transport.diffBaselineMediaUrl.mockImplementation(
      (cwd: string, p: string, s: string) =>
        `/api/diff/baseline/raw?cwd=${cwd}&path=${p}&sessionId=${s}`
    );
  });

  it('renders both layers side by side in 2-up (the default)', () => {
    render(<CanvasImageDiffContent content={CONTENT} />);
    expect(screen.getByAltText('Previous version')).toBeInTheDocument();
    expect(screen.getByAltText('Current version')).toBeInTheDocument();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
  });

  it('swipe mode overlays both layers with a draggable divider slider', () => {
    render(<CanvasImageDiffContent content={CONTENT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));

    expect(screen.getByAltText('Previous version')).toBeInTheDocument();
    expect(screen.getByAltText('Current version')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Swipe divider position' })).toBeInTheDocument();
  });

  it('onion-skin mode overlays both layers with a blend slider', () => {
    render(<CanvasImageDiffContent content={CONTENT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Onion skin' }));

    expect(screen.getByAltText('Previous version')).toBeInTheDocument();
    expect(screen.getByAltText('Current version')).toBeInTheDocument();
    expect(
      screen.getByRole('slider', { name: 'Blend between the previous and current version' })
    ).toBeInTheDocument();
  });

  it('shows a calm web-only message when the transport cannot serve baseline bytes', () => {
    transport.diffBaselineMediaUrl.mockReturnValue(null);
    render(<CanvasImageDiffContent content={CONTENT} />);
    expect(screen.getByText(/available here/)).toBeInTheDocument();
    expect(screen.queryByAltText('Previous version')).not.toBeInTheDocument();
  });

  it('confirm-gates restore: the first click arms, only the second reverts', async () => {
    render(<CanvasImageDiffContent content={CONTENT} />);

    const restore = screen.getByRole('button', {
      name: 'Restore the previous version of this image',
    });
    fireEvent.click(restore);
    expect(transport.revertDiffBaseline).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm: restore the previous version' })
    );
    expect(transport.revertDiffBaseline).toHaveBeenCalledWith('/work', 'assets/logo.png', 'sess-1');
  });

  it('degrades honestly when the baseline 404s: new-image disclosure, no restore', () => {
    render(<CanvasImageDiffContent content={CONTENT} />);

    // Simulate the baseline layer failing to load (404 NO_BASELINE).
    fireEvent.error(screen.getByAltText('Previous version'));

    expect(screen.getByText('New image')).toBeInTheDocument();
    expect(screen.getByText(/nothing to\s+restore/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Restore the previous version of this image' })
    ).not.toBeInTheDocument();
    // The current image still shows on its own.
    expect(screen.getByAltText('Current image')).toBeInTheDocument();
  });

  it('mark reviewed advances the baseline', () => {
    render(<CanvasImageDiffContent content={CONTENT} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark reviewed/ }));
    expect(transport.advanceDiffBaseline).toHaveBeenCalledWith(
      '/work',
      'assets/logo.png',
      'sess-1'
    );
  });
  it('cache-busts both layers when the agent edits the image again while open', () => {
    vi.useFakeTimers();
    try {
      render(<CanvasImageDiffContent content={CONTENT} />);
      const current = screen.getByAltText('Current version') as HTMLImageElement;
      expect(current.src).toContain('v=0');

      // A repeated agent edit re-activates the open diff doc WITHOUT a remount
      // — the live-refresh subscriber must bump the version so the "After"
      // layer refetches instead of showing a stale image.
      act(() => {
        streamMocks.handler.current!('sess-1', {
          type: 'tool_call',
          status: 'complete',
          toolName: 'Write',
          input: JSON.stringify({ file_path: 'assets/logo.png' }),
        });
      });
      act(() => {
        vi.advanceTimersByTime(450); // past the burst debounce
      });

      const refreshed = screen.getByAltText('Current version') as HTMLImageElement;
      expect(refreshed.src).toContain('v=1');
      expect((screen.getByAltText('Previous version') as HTMLImageElement).src).toContain('v=1');
    } finally {
      vi.useRealTimers();
    }
  });
});
