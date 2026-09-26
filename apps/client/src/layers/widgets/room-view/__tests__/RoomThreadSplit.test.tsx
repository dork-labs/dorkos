// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { STORAGE_KEYS } from '@/layers/shared/lib';
import { RoomThreadSplit } from '../ui/RoomThreadSplit';
import {
  LEGACY_THREAD_LAYOUT_KEY,
  threadColumnSizingFor,
  threadPctFor,
} from '../model/use-thread-column-sizing';

// The REAL library, and its browser build. Vitest resolves the package's
// `node` export here, which assumes it is rendering on a server and skips every
// layout effect — no ARIA values, no keyboard — so the thing this file exists
// to prove would silently never run. The browser build is the one the app ships.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const pkg = createRequire(import.meta.url).resolve('react-resizable-panels/package.json');
  return vi.importActual(join(dirname(pkg), 'dist/react-resizable-panels.browser.development.js'));
});

const KEY = STORAGE_KEYS.ROOM_THREAD_WIDTH;

/** How wide jsdom reports every element — it lays nothing out on its own. */
let measuredWidth = 0;
/** Every live observer's callback, so a test can say "the split just resized". */
let observers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  measuredWidth = 0;
  observers = [];
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => measuredWidth);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        observers.push(this.callback);
      }
      unobserve() {}
      disconnect() {
        observers = observers.filter((cb) => cb !== this.callback);
      }
    }
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The window, the sidebar or the right panel changed the split's width. */
function resizeSplitTo(width: number) {
  measuredWidth = width;
  act(() => observers.forEach((notify) => notify()));
}

function renderSplit(thread: boolean = true) {
  return render(
    <div style={{ height: 600 }}>
      <RoomThreadSplit
        room={<div data-testid="room-column">room</div>}
        thread={thread && <section data-testid="thread-column">thread</section>}
      />
    </div>
  );
}

/** The thread pane's current share of the split, as the library reports it. */
function threadSize(): number {
  const pane = screen.getByTestId('thread-column').closest('[data-panel-size]');
  return Number(pane?.getAttribute('data-panel-size'));
}

function handle() {
  return screen.getByRole('separator', { name: 'Resize thread' });
}

describe('threadColumnSizingFor', () => {
  it('turns the thread and room floors into percentages of the split', () => {
    // 1000px: the thread keeps 320px (32%), the room keeps 360px (so the
    // thread tops out at 64%).
    expect(threadColumnSizingFor(1000)).toEqual({ minPct: 32, maxPct: 64, defaultPct: 40 });
  });

  it('opens a first thread no narrower than its floor', () => {
    // 700px: 40% would be 280px, below the 320px floor.
    const sizing = threadColumnSizingFor(700);
    expect(sizing.minPct).toBe(45.7);
    expect(sizing.defaultPct).toBe(45.7);
  });

  it('meets in the middle when the split cannot honour both floors', () => {
    expect(threadColumnSizingFor(600)).toEqual({ minPct: 50, maxPct: 50, defaultPct: 50 });
  });

  it('keeps a usable range before the split has been measured', () => {
    expect(threadColumnSizingFor(0)).toEqual({ minPct: 25, maxPct: 75, defaultPct: 40 });
  });
});

describe('threadPctFor', () => {
  it('opens at the default when the reader never chose a width', () => {
    expect(threadPctFor(null, 1000, threadColumnSizingFor(1000))).toBe(40);
  });

  it('holds a chosen width in pixels, whatever the split', () => {
    expect(threadPctFor(500, 1000, threadColumnSizingFor(1000))).toBe(50);
    expect(threadPctFor(500, 1250, threadColumnSizingFor(1250))).toBe(40);
  });

  it('squeezes a chosen width into today’s bounds without changing it', () => {
    // 600px chosen, 700px of split: 360px of room is more than half of it, so
    // the thread is capped at half.
    expect(threadPctFor(600, 700, threadColumnSizingFor(700))).toBe(50);
  });
});

describe('RoomThreadSplit', () => {
  it('puts a named handle between the room and an open thread', () => {
    measuredWidth = 1000;
    renderSplit();

    expect(handle()).toHaveAttribute('tabindex', '0');
    expect(threadSize()).toBe(40);
  });

  it('draws no handle while no thread is open', () => {
    measuredWidth = 1000;
    renderSplit(false);

    expect(screen.getByTestId('room-column')).toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('describes the THREAD to a screen reader, not the room beside it', () => {
    measuredWidth = 1000;
    renderSplit();

    const thread = screen.getByTestId('thread-column').closest('[data-panel-size]')!;
    expect(handle()).toHaveAttribute('aria-controls', thread.id);
    expect(handle()).toHaveAttribute('aria-valuenow', '40');
    expect(handle()).toHaveAttribute('aria-valuemin', '32');
    expect(handle()).toHaveAttribute('aria-valuemax', '64');
  });

  it('resizes from the keyboard, the value rising as the thread widens', () => {
    measuredWidth = 1000;
    renderSplit();

    // Left moves the line toward the room: a wider thread, a bigger number.
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(threadSize()).toBe(50);
    expect(handle()).toHaveAttribute('aria-valuenow', '50');

    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(threadSize()).toBe(40);

    // Home and End are the thread's narrowest and widest — its floor, and
    // whatever leaves the room its own.
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(threadSize()).toBe(32);
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(threadSize()).toBe(64);
    expect(handle()).toHaveAttribute('aria-valuenow', '64');
  });

  it('remembers the width a reader chose, in pixels, and reopens at it', () => {
    measuredWidth = 1000;
    const { unmount } = renderSplit();
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });

    expect(localStorage.getItem(KEY)).toBe('500');
    unmount();

    // A thread opened later, in a wider window: the same 500px, not the same %.
    measuredWidth = 1250;
    renderSplit();
    expect(threadSize()).toBe(40);
  });

  it('follows a re-measure with new bounds, and says so', () => {
    measuredWidth = 1000;
    renderSplit();

    resizeSplitTo(800);

    // 320/800 = 40%, and the room's 360px leaves the thread at most 55%.
    expect(handle()).toHaveAttribute('aria-valuemin', '40');
    expect(handle()).toHaveAttribute('aria-valuemax', '55');
  });

  it('gives a squeezed thread back its chosen width once there is room again', () => {
    localStorage.setItem(KEY, '600');
    measuredWidth = 1000;
    renderSplit();
    expect(threadSize()).toBe(60);

    // The window narrows, or the right panel opens: the room's floor wins.
    resizeSplitTo(700);
    expect(threadSize()).toBe(50);
    // …and the squeeze is not a choice. Nothing the library clamped is saved.
    expect(localStorage.getItem(KEY)).toBe('600');

    resizeSplitTo(1000);
    expect(threadSize()).toBe(60);
  });

  it('does not save a key press that moved nothing', () => {
    measuredWidth = 1000;
    renderSplit();
    fireEvent.keyDown(handle(), { key: 'Home' });
    localStorage.clear();

    // Already at the thread's floor: Right Arrow cannot narrow it further.
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('treats a range of a pixel or two as no range at all', () => {
    // 641px — 1440 with the right panel open: the thread's floor is 49.9% and
    // the room's caps it at 50%, under a pixel of play. A stop a keyboard reader
    // would land on to move nothing they could see.
    measuredWidth = 641;
    renderSplit();
    expect(handle()).toHaveAttribute('tabindex', '-1');
  });

  it('offers the handle once there is real range', () => {
    measuredWidth = 700;
    renderSplit();
    expect(handle()).toHaveAttribute('tabindex', '0');
  });

  it('forgets the old library-format layout it used to save', () => {
    localStorage.setItem(LEGACY_THREAD_LAYOUT_KEY, '{"room,thread":{"layout":[50,50]}}');
    measuredWidth = 1000;
    renderSplit();
    expect(localStorage.getItem(LEGACY_THREAD_LAYOUT_KEY)).toBeNull();
  });

  it('leaves the tab order when the split has no range to offer', () => {
    // 600px cannot hold 320px of thread beside 360px of room: both sit at
    // half, and a separator that cannot move is not a stop worth making.
    measuredWidth = 600;
    renderSplit();

    expect(handle()).toHaveAttribute('tabindex', '-1');
    expect(handle()).toHaveAttribute('aria-disabled', 'true');
  });
});
