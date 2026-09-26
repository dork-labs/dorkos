// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RoomThreadSplit } from '../ui/RoomThreadSplit';

// The REAL library, and its browser build. Vitest resolves the package's
// `node` export here, which assumes it is rendering on a server and skips every
// layout effect — no ARIA values, no keyboard, no saved layout — so the thing
// this file exists to prove would silently never run. The browser build is the
// one the app ships.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const pkg = createRequire(import.meta.url).resolve('react-resizable-panels/package.json');
  return vi.importActual(join(dirname(pkg), 'dist/react-resizable-panels.browser.development.js'));
});
import { THREAD_SPLIT_ID, threadColumnSizingFor } from '../model/use-thread-column-sizing';

/** How wide jsdom reports every element — it lays nothing out on its own. */
let measuredWidth = 0;

beforeEach(() => {
  localStorage.clear();
  measuredWidth = 0;
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => measuredWidth);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    // 600px holds neither 320 + 360: each side is capped at half, so the
    // room is never squeezed below the thread or the other way round.
    expect(threadColumnSizingFor(600)).toEqual({ minPct: 50, maxPct: 50, defaultPct: 50 });
  });

  it('keeps a usable range before the split has been measured', () => {
    expect(threadColumnSizingFor(0)).toEqual({ minPct: 25, maxPct: 75, defaultPct: 40 });
  });
});

describe('RoomThreadSplit', () => {
  it('puts a named handle between the room and an open thread', () => {
    measuredWidth = 1000;
    renderSplit();

    const handle = screen.getByRole('separator', { name: 'Resize thread' });
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(threadSize()).toBe(40);
  });

  it('draws no handle while no thread is open', () => {
    measuredWidth = 1000;
    renderSplit(false);

    expect(screen.getByTestId('room-column')).toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('resizes from the keyboard, clamped so neither side drops below its floor', () => {
    measuredWidth = 1000;
    renderSplit();
    const handle = screen.getByRole('separator', { name: 'Resize thread' });

    // The separator describes the pane BEFORE it — the room — so the room's
    // own floor is its minimum and the thread's floor sets its maximum.
    expect(handle).toHaveAttribute('aria-valuemin', '36');
    expect(handle).toHaveAttribute('aria-valuemax', '68');

    // Moving the line left widens the thread; Home drives it all the way.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(threadSize()).toBeGreaterThan(40);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(threadSize()).toBe(64);

    // And End as far the other way: the thread stops at its 320px floor.
    fireEvent.keyDown(handle, { key: 'End' });
    expect(threadSize()).toBe(32);
  });

  it('remembers the width this reader chose, in their own browser', async () => {
    measuredWidth = 1000;
    const { unmount } = renderSplit();
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize thread' }), { key: 'Home' });

    await waitFor(() =>
      expect(localStorage.getItem(`react-resizable-panels:${THREAD_SPLIT_ID}`)).toContain('64')
    );
    unmount();

    // A thread opened later — any room, any thread — comes back at that width.
    renderSplit();
    expect(threadSize()).toBe(64);
  });
});
