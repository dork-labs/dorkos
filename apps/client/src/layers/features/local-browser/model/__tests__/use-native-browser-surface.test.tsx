/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui';
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

  it('keeps following a slide whose first frames do not move yet', async () => {
    render(<Surface onUnavailable={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
    });
    setBounds.mockClear();

    // A delayed or ease-in transition: it starts, sits still for two frames,
    // then moves with no further event.
    await act(async () => {
      document.body.dispatchEvent(new Event('transitionrun', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(FRAME_MS * 2);
    });
    rect = { ...rect, x: 90 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_MS * 2);
    });

    expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 90 }));
  });

  it('follows while a finite animation runs, but an endless one never keeps it busy', async () => {
    const running: { playState: string; effect: { getTiming: () => { iterations: number } } }[] = [
      { playState: 'running', effect: { getTiming: () => ({ iterations: Infinity }) } },
    ];
    (document as unknown as { getAnimations: () => unknown[] }).getAnimations = () => running;
    try {
      render(<Surface onUnavailable={() => {}} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FRAME_MS * 30);
      });
      const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
      const settled = measure.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FRAME_MS * 300);
      });
      // A spinner somewhere on the page: still idle.
      expect(measure.mock.calls.length).toBe(settled);

      // A one-shot slide with no events of its own.
      running.push({ playState: 'running', effect: { getTiming: () => ({ iterations: 1 }) } });
      setBounds.mockClear();
      await act(async () => {
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(FRAME_MS * 20);
      });
      rect = { ...rect, x: 120 };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FRAME_MS * 2);
      });
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 120 }));
    } finally {
      delete (document as unknown as { getAnimations?: unknown }).getAnimations;
    }
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

  // DOR-4417 and DOR-4418: real Radix layers, placed where a real window would put them.
  describe('app layers', () => {
    const WINDOW = { x: 0, y: 0, width: 1200, height: 800 };
    // Stable, as in the panel: a new callback would restart the surface on every render.
    const noop = () => {};
    let tooltipRect = { x: 600, y: 300, width: 80, height: 24 };

    function placeLayers() {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement
      ) {
        const box = this.matches('[data-slot$="-overlay"]')
          ? WINDOW
          : this.matches('[data-radix-popper-content-wrapper]')
            ? tooltipRect
            : this.contains(document.querySelector('[data-testid="surface"]'))
              ? rect
              : this.closest('[role="dialog"]')
                ? { x: 700, y: 300, width: 400, height: 300 }
                : rect;
        return {
          ...box,
          top: box.y,
          left: box.x,
          right: box.x + box.width,
          bottom: box.y + box.height,
          toJSON: () => box,
        } as DOMRect;
      });
      // jsdom lays nothing out; a real window gives every rendered element a box.
      vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
        this: HTMLElement
      ) {
        return [this.getBoundingClientRect()] as unknown as DOMRectList;
      });
    }

    function WithLayers({ dialog, tooltip }: { dialog: boolean; tooltip: boolean }) {
      return (
        <TooltipProvider>
          <Surface onUnavailable={noop} />
          <Tooltip open={tooltip}>
            <TooltipTrigger>Help</TooltipTrigger>
            <TooltipContent>More about this</TooltipContent>
          </Tooltip>
          <Dialog open={dialog}>
            <DialogContent>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>Your preferences</DialogDescription>
            </DialogContent>
          </Dialog>
        </TooltipProvider>
      );
    }

    async function settle() {
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(FRAME_MS * 10);
      });
    }

    beforeEach(() => {
      tooltipRect = { x: 600, y: 300, width: 80, height: 24 };
      placeLayers();
    });

    it('stays on screen while a tooltip opens away from it', async () => {
      const view = render(<WithLayers dialog={false} tooltip={false} />);
      await settle();
      setBounds.mockClear();

      view.rerender(<WithLayers dialog={false} tooltip />);
      await settle();

      expect(document.querySelector('[data-radix-popper-content-wrapper]')).not.toBeNull();
      expect(setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    });

    it('steps aside while a tooltip overlaps it, and comes back when it closes', async () => {
      tooltipRect = { x: 100, y: 100, width: 80, height: 24 };
      const view = render(<WithLayers dialog={false} tooltip={false} />);
      await settle();

      view.rerender(<WithLayers dialog={false} tooltip />);
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

      view.rerender(<WithLayers dialog={false} tooltip={false} />);
      await settle();
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    });

    it('hides behind a modal dialog even where the dialog box does not reach it', async () => {
      const view = render(<WithLayers dialog={false} tooltip={false} />);
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));

      view.rerender(<WithLayers dialog tooltip={false} />);
      await settle();
      // Radix never sets aria-modal; the backdrop is what covers the page.
      expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBeNull();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

      view.rerender(<WithLayers dialog={false} tooltip={false} />);
      await settle();
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    });

    // Below desktop width the right panel is itself a Sheet, with its own backdrop.
    function InPanelSheet({ dialog }: { dialog: boolean }) {
      return (
        <>
          <Sheet open>
            <SheetContent>
              <SheetTitle>Panel</SheetTitle>
              <SheetDescription>Right panel content.</SheetDescription>
              <Surface onUnavailable={noop} />
            </SheetContent>
          </Sheet>
          <Dialog open={dialog}>
            <DialogContent>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>Your preferences</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      );
    }

    it('shows inside the panel sheet, whose own backdrop sits under it', async () => {
      render(<InPanelSheet dialog={false} />);
      await settle();

      expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
      expect(setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    });

    it('still hides for a dialog opened over the panel sheet', async () => {
      const view = render(<InPanelSheet dialog={false} />);
      await settle();

      view.rerender(<InPanelSheet dialog />);
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

      view.rerender(<InPanelSheet dialog={false} />);
      await settle();
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    });
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
