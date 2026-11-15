/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Toaster,
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

function Surface({
  onUnavailable,
  connectionId = 'conn-1',
}: {
  onUnavailable: () => void;
  connectionId?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const still = useNativeBrowserSurface(ref, connectionId, true, onUnavailable);
  return (
    <div style={{ overflow: 'hidden' }}>
      <div ref={ref} data-testid="surface">
        {still && (
          <img
            alt=""
            data-testid="still"
            src={still.url}
            style={{ left: still.left, top: still.top, width: still.width, height: still.height }}
          />
        )}
      </div>
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
let captureStill: ReturnType<typeof vi.fn>;
let stills: number;
let rect = { x: 10, y: 20, width: 300, height: 200 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'] });
  StubResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  setBounds = vi.fn(() => Promise.resolve());
  captureStill = vi.fn(() => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff])));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localBrowser: { setBounds, captureStill },
  };
  // jsdom has no object URLs; the still's lives only as long as the still.
  stills = 0;
  URL.createObjectURL = vi.fn(() => `blob:still-${(stills += 1)}`);
  URL.revokeObjectURL = vi.fn();
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
    let toastRect = { x: 860, y: 720, width: 320, height: 56 };

    function placeLayers() {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement
      ) {
        const box = this.matches('[data-slot$="-overlay"]')
          ? WINDOW
          : this.matches('[data-radix-popper-content-wrapper]')
            ? tooltipRect
            : this.matches('[data-sonner-toast]')
              ? toastRect
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

    function WithLayers({
      dialog,
      tooltip,
      connectionId,
    }: {
      dialog: boolean;
      tooltip: boolean;
      connectionId?: string;
    }) {
      return (
        <TooltipProvider>
          <Surface onUnavailable={noop} connectionId={connectionId} />
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
      toastRect = { x: 860, y: 720, width: 320, height: 56 };
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
      // One frame for its still to be drawn, then it hides (DOR-4438).
      await settle();
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
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

      view.rerender(<InPanelSheet dialog={false} />);
      await settle();
      await settle();
      expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    });

    // DOR-4438: a covered page leaves a still of itself, not a blank.
    describe('the still', () => {
      const still = () => document.querySelector<HTMLImageElement>('[data-testid="still"]');

      it('draws a still where the page was, then hides the page', async () => {
        const order: string[] = [];
        setBounds.mockImplementation((bounds: { visible: boolean }) => {
          order.push(`${bounds.visible ? 'show' : 'hide'}${still() ? ' over still' : ''}`);
          return Promise.resolve();
        });
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();

        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();
        await settle();

        expect(captureStill).toHaveBeenCalledWith('conn-1');
        expect(still()?.getAttribute('src')).toBe('blob:still-1');
        expect(still()?.style.width).toBe('300px');
        expect(still()?.style.height).toBe('200px');
        // The page never steps aside before its still is on screen.
        expect(order).toEqual(['show', 'hide over still']);
      });

      it('brings the page back first, then drops the still', async () => {
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();
        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();
        await settle();
        expect(still()).not.toBeNull();

        let stillWhenShown: boolean | null = null;
        setBounds.mockImplementation((bounds: { visible: boolean }) => {
          if (bounds.visible) stillWhenShown = !!still();
          return Promise.resolve();
        });
        view.rerender(<WithLayers dialog={false} tooltip={false} />);
        await settle();
        await settle();

        expect(stillWhenShown).toBe(true);
        expect(still()).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:still-1');
      });

      it('hides the page as before when there is no still', async () => {
        captureStill.mockResolvedValue(null);
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();

        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();

        expect(still()).toBeNull();
        expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
      });

      it('hides the page as before when the capture fails', async () => {
        captureStill.mockRejectedValue(new Error('gone'));
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();

        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();

        expect(still()).toBeNull();
        expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
      });

      it('does not wait long for a slow still, and drops it when it comes late', async () => {
        let answer!: (bytes: Uint8Array) => void;
        captureStill.mockReturnValue(new Promise<Uint8Array>((done) => (answer = done)));
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();
        setBounds.mockClear();

        view.rerender(<WithLayers dialog tooltip={false} />);
        await act(async () => {
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(100);
        });
        expect(setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
        await settle();
        expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

        await act(async () => {
          answer(new Uint8Array([1]));
          await vi.advanceTimersByTimeAsync(FRAME_MS * 4);
        });
        expect(still()).toBeNull();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
      });

      it('takes one still per cover, and none of a page that is already hidden', async () => {
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();
        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();
        await settle();

        rect = { ...rect, x: 30 };
        await act(async () => {
          window.dispatchEvent(new Event('resize'));
          await vi.advanceTimersByTimeAsync(FRAME_MS * 10);
        });

        expect(captureStill).toHaveBeenCalledTimes(1);
        expect(setBounds).toHaveBeenLastCalledWith(
          expect.objectContaining({ x: 30, visible: false })
        );
      });

      it('tries once per cover when there is no still, then stays hidden', async () => {
        captureStill.mockResolvedValue(null);
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();
        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();
        await settle();

        expect(captureStill).toHaveBeenCalledTimes(1);
      });

      it('drops the still when the page closes', async () => {
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();
        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();
        await settle();
        expect(still()).not.toBeNull();

        view.unmount();

        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:still-1');
      });

      it('drops the still when the browser moves to another chat', async () => {
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();
        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();
        await settle();
        expect(still()).not.toBeNull();

        view.rerender(<WithLayers dialog tooltip={false} connectionId="conn-2" />);
        await settle();

        expect(still()).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:still-1');
      });

      // Security's Should: a toast over the page is an app layer like any other.
      function WithToaster() {
        return (
          <>
            <Surface onUnavailable={noop} />
            <Toaster />
          </>
        );
      }

      it('leaves a still under a toast that lands on the page, and comes back after', async () => {
        toastRect = { x: 100, y: 150, width: 180, height: 56 };
        render(<WithToaster />);
        await settle();

        await act(async () => {
          toast('Saved', { id: 'over' });
        });
        await settle();
        await settle();
        expect(document.querySelector('[data-sonner-toast]')).not.toBeNull();
        expect(captureStill).toHaveBeenCalledWith('conn-1');
        expect(still()).not.toBeNull();
        expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

        await act(async () => {
          toast.dismiss('over');
          await vi.advanceTimersByTimeAsync(1_000);
        });
        // Sonner unmounts the toast after its exit; then the page comes back.
        await settle();
        await settle();
        await settle();
        expect(document.querySelector('[data-sonner-toast]')).toBeNull();
        expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
        expect(still()).toBeNull();
      });

      it('stays live for a toast in a corner away from the page', async () => {
        render(<WithToaster />);
        await settle();
        setBounds.mockClear();

        await act(async () => {
          toast('Saved', { id: 'away' });
        });
        await settle();
        await settle();

        expect(document.querySelector('[data-sonner-toast]')).not.toBeNull();
        expect(captureStill).not.toHaveBeenCalled();
        expect(setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
        await act(async () => {
          toast.dismiss('away');
          await vi.advanceTimersByTimeAsync(1_000);
        });
      });

      it('works without a still on an older desktop shell', async () => {
        (window as unknown as { electronAPI: unknown }).electronAPI = {
          localBrowser: { setBounds },
        };
        const view = render(<WithLayers dialog={false} tooltip={false} />);
        await settle();

        view.rerender(<WithLayers dialog tooltip={false} />);
        await settle();

        expect(still()).toBeNull();
        expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
      });
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
