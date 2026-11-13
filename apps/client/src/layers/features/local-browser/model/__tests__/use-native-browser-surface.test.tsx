/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { useNativeBrowserSurface } from '../use-native-browser-surface';

// DOR-3312: the shared-browser surface used to measure itself on every animation
// frame for as long as it was open, and re-scan the page for overlays on every
// body mutation. On an idle screen that is work with no end. These pin that a
// still screen costs nothing, and that a busy one costs at most one check a frame.

const FRAME_MS = 16;

function Surface({ onUnavailable }: { onUnavailable: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useNativeBrowserSurface(ref, 'conn-1', true, onUnavailable);
  return (
    <div style={{ overflow: 'hidden' }}>
      <div ref={ref} data-testid="surface" />
    </div>
  );
}

class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let setBounds: ReturnType<typeof vi.fn>;
let rect = { x: 10, y: 20, width: 300, height: 200 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'] });
  StubResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  setBounds = vi.fn(() => Promise.resolve());
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localBrowser: { setBounds },
  };
  rect = { x: 10, y: 20, width: 300, height: 200 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        ...rect,
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        toJSON: () => rect,
      }) as DOMRect
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useNativeBrowserSurface', () => {
  it('publishes its bounds once when it opens', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 5);
    });
    expect(setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1', x: 10, y: 20, visible: true })
    );
  });

  it('does no layout work while nothing on screen changes', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const settled = measure.mock.calls.length;

    // Ten idle seconds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 600);
    });

    expect(measure.mock.calls.length).toBe(settled);
  });

  it('follows the surface when the window resizes', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    setBounds.mockClear();

    rect = { x: 40, y: 20, width: 260, height: 200 };
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(FRAME_MS * 5);
    });

    expect(setBounds).toHaveBeenCalledWith(expect.objectContaining({ x: 40, width: 260 }));
  });

  it('follows the surface when its own size changes', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    setBounds.mockClear();

    rect = { x: 10, y: 20, width: 500, height: 200 };
    await act(async () => {
      for (const observer of StubResizeObserver.instances) observer.fire();
      await vi.advanceTimersByTimeAsync(FRAME_MS * 5);
    });

    expect(setBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 500 }));
  });

  it('keeps following while something animates it into place', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    setBounds.mockClear();

    // A slide-in: a style write starts it, then the box keeps moving for a few
    // frames with no further event.
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      host.style.transform = 'translateX(10px)';
      await Promise.resolve();
    });
    for (const x of [20, 30, 40, 50]) {
      rect = { ...rect, x };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FRAME_MS);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 10);
    });

    expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 50 }));
  });

  it('checks for covering overlays at most once a frame, however busy the page is', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    const query = vi.spyOn(document, 'querySelectorAll');

    // A streaming room: 200 separate DOM writes inside one frame.
    const row = document.createElement('div');
    document.body.appendChild(row);
    await act(async () => {
      for (let i = 0; i < 200; i += 1) {
        row.className = `row-${i}`;
        await Promise.resolve();
      }
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 2);
    });

    expect(query.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('hides itself when a modal dialog opens over it', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    setBounds.mockClear();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      {} as DOMRect,
    ] as unknown as DOMRectList);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    await act(async () => {
      document.body.appendChild(dialog);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(FRAME_MS * 3);
    });

    expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
  });

  it('stops all work when it closes', async () => {
    const { unmount } = render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    unmount();
    setBounds.mockClear();
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const after = measure.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      document.body.className = 'changed';
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(FRAME_MS * 60);
    });

    expect(measure.mock.calls.length).toBe(after);
    expect(setBounds).not.toHaveBeenCalled();
  });
});
