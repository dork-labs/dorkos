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

type SessionEventHandler = (sessionId: string, event: Record<string, unknown>) => void;
const streamMocks = vi.hoisted(() => ({
  handler: { current: null as SessionEventHandler | null },
}));

// `streamManager` (via useAgentEditRefresh) lives on the transport subpath, not
// the lib barrel (DOR-1809). Stubbing it is what lets tests fire session events.
vi.mock('@/layers/shared/lib/transport', () => ({
  streamManager: {
    subscribeSessionEvent: (handler: SessionEventHandler) => {
      streamMocks.handler.current = handler;
      return () => {
        streamMocks.handler.current = null;
      };
    },
  },
}));

import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { CanvasImageDiffContent } from '../ui/CanvasImageDiffContent';

afterEach(cleanup);

// The app store is REAL: the folder and session the diff acts on come from the
// same state the rest of the app writes, not from a selector stub.
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <TransportProvider transport={transport as unknown as Transport}>{children}</TransportProvider>
  );
}

function renderDiff() {
  return render(<CanvasImageDiffContent content={CONTENT} />, { wrapper: Wrapper });
}

const CONTENT = { type: 'diff' as const, sourcePath: 'assets/logo.png' };

describe('CanvasImageDiffContent', () => {
  beforeEach(() => {
    useAppStore.setState({ selectedCwd: '/work', sessionId: 'sess-1' });
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
    renderDiff();
    expect(screen.getByAltText('Previous version')).toBeInTheDocument();
    expect(screen.getByAltText('Current version')).toBeInTheDocument();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
  });

  it('swipe mode overlays both layers with a draggable divider slider', () => {
    renderDiff();
    fireEvent.click(screen.getByRole('button', { name: 'Swipe' }));

    expect(screen.getByAltText('Previous version')).toBeInTheDocument();
    expect(screen.getByAltText('Current version')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Swipe divider position' })).toBeInTheDocument();
  });

  it('onion-skin mode overlays both layers with a blend slider', () => {
    renderDiff();
    fireEvent.click(screen.getByRole('button', { name: 'Onion skin' }));

    expect(screen.getByAltText('Previous version')).toBeInTheDocument();
    expect(screen.getByAltText('Current version')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Blend old and new versions' })).toBeInTheDocument();
  });

  it('shows a calm web-only message when the transport cannot serve baseline bytes', () => {
    transport.diffBaselineMediaUrl.mockReturnValue(null);
    renderDiff();
    expect(screen.getByText(/available here/)).toBeInTheDocument();
    expect(screen.queryByAltText('Previous version')).not.toBeInTheDocument();
  });

  it('confirm-gates restore: the first click arms, only the second reverts', async () => {
    renderDiff();

    const restore = screen.getByRole('button', {
      name: 'Restore the previous version of this image',
    });
    fireEvent.click(restore);
    expect(transport.revertDiffBaseline).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Press again to restore the previous version' })
    );
    expect(transport.revertDiffBaseline).toHaveBeenCalledWith('/work', 'assets/logo.png', 'sess-1');
  });

  it('degrades honestly when the baseline 404s: new-image disclosure, no restore', () => {
    renderDiff();

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
    renderDiff();
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
      renderDiff();
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
