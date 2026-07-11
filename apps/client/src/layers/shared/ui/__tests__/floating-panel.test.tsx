/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FloatingPanel, clampGeometry, type FloatingPanelGeometry } from '../floating-panel';

const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 768;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    writable: true,
    configurable: true,
    value: height,
  });
}

const baseGeometry: FloatingPanelGeometry = { x: 100, y: 100, width: 360, height: 240 };

function renderPanel(overrides: Partial<React.ComponentProps<typeof FloatingPanel>> = {}) {
  const onGeometryChange = vi.fn();
  const onClose = vi.fn();
  const props = {
    title: 'Panel title',
    geometry: baseGeometry,
    onGeometryChange,
    onClose,
    children: <div>Panel body</div>,
    ...overrides,
  };
  const result = render(<FloatingPanel {...props} />);
  return { onGeometryChange, onClose, ...result };
}

describe('clampGeometry', () => {
  beforeEach(() => setViewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT));

  it('enforces the minimum width and height', () => {
    const result = clampGeometry({ x: 0, y: 0, width: 10, height: 10 }, 280, 180);
    expect(result.width).toBe(280);
    expect(result.height).toBe(180);
  });

  it('caps size to the viewport minus an 8px-per-edge margin', () => {
    const result = clampGeometry({ x: 0, y: 0, width: 5000, height: 5000 }, 280, 180);
    expect(result.width).toBe(VIEWPORT_WIDTH - 16);
    expect(result.height).toBe(VIEWPORT_HEIGHT - 16);
  });

  it('clamps position so the panel stays fully inside the viewport', () => {
    const result = clampGeometry({ x: 5000, y: 5000, width: 360, height: 240 }, 280, 180);
    expect(result.x).toBe(VIEWPORT_WIDTH - 360);
    expect(result.y).toBe(VIEWPORT_HEIGHT - 240);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
  });

  it('clamps negative position back to the origin', () => {
    const result = clampGeometry({ x: -50, y: -50, width: 360, height: 240 }, 280, 180);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});

describe('FloatingPanel', () => {
  beforeEach(() => setViewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders its children and title', () => {
    renderPanel();
    expect(screen.getByText('Panel title')).toBeInTheDocument();
    expect(screen.getByText('Panel body')).toBeInTheDocument();
  });

  it('exposes role="complementary" and aria-label equal to the title, with labelled icon controls', () => {
    renderPanel({ onRestore: vi.fn() });
    const root = screen.getByRole('complementary');
    expect(root).toHaveAttribute('aria-label', 'Panel title');
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(screen.getByLabelText('Restore')).toBeInTheDocument();
  });

  it('commits a single moved geometry when the header is dragged', () => {
    const { onGeometryChange } = renderPanel();
    const header = screen.getByText('Panel title').parentElement as HTMLElement;

    fireEvent.pointerDown(header, { clientX: 200, clientY: 200 });
    fireEvent.pointerMove(document, { clientX: 250, clientY: 230 });
    fireEvent.pointerUp(document, { clientX: 250, clientY: 230 });

    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    expect(onGeometryChange).toHaveBeenCalledWith(
      expect.objectContaining({ x: 150, y: 130, width: 360, height: 240 })
    );
  });

  it('never resizes below the minimum size, even when the drag would shrink it further', () => {
    const { onGeometryChange } = renderPanel({ minWidth: 280, minHeight: 180 });
    const handle = document.querySelector('.cursor-nwse-resize') as HTMLElement;
    expect(handle).toBeTruthy();

    fireEvent.pointerDown(handle, { clientX: 460, clientY: 340 });
    // Drag far up-left to try to shrink well below the minimum.
    fireEvent.pointerMove(document, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(document, { clientX: 0, clientY: 0 });

    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    const committed = onGeometryChange.mock.calls[0][0] as FloatingPanelGeometry;
    expect(committed.width).toBeGreaterThanOrEqual(280);
    expect(committed.height).toBeGreaterThanOrEqual(180);
  });

  it('re-clamps an out-of-bounds geometry on initial mount', () => {
    const { onGeometryChange } = renderPanel({
      geometry: { x: 5000, y: 5000, width: 360, height: 240 },
    });
    expect(onGeometryChange).toHaveBeenCalledWith(
      expect.objectContaining({ x: VIEWPORT_WIDTH - 360, y: VIEWPORT_HEIGHT - 240 })
    );
  });

  it('re-clamps the geometry when the window is resized', () => {
    const { onGeometryChange } = renderPanel({
      geometry: { x: 900, y: 600, width: 360, height: 240 },
    });
    onGeometryChange.mockClear();

    setViewport(500, 400);
    fireEvent(window, new Event('resize'));

    expect(onGeometryChange).toHaveBeenCalled();
    const committed = onGeometryChange.mock.calls.at(-1)?.[0] as FloatingPanelGeometry;
    expect(committed.x).toBeLessThanOrEqual(500 - committed.width);
    expect(committed.y).toBeLessThanOrEqual(400 - committed.height);
    expect(committed.x).toBeGreaterThanOrEqual(0);
    expect(committed.y).toBeGreaterThanOrEqual(0);
  });

  it('calls onClose when the close control is clicked', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the restore control unless onRestore is provided, and fires it on click', () => {
    const { rerender } = renderPanel();
    expect(screen.queryByLabelText('Restore')).not.toBeInTheDocument();

    const onRestore = vi.fn();
    rerender(
      <FloatingPanel
        title="Panel title"
        geometry={baseGeometry}
        onGeometryChange={vi.fn()}
        onClose={vi.fn()}
        onRestore={onRestore}
      >
        <div>Panel body</div>
      </FloatingPanel>
    );
    fireEvent.click(screen.getByLabelText('Restore'));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape (the panel is non-modal)', () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('aborts an in-flight drag on unmount without committing a geometry', () => {
    const { onGeometryChange, unmount } = renderPanel();
    const header = screen.getByText('Panel title').parentElement as HTMLElement;

    fireEvent.pointerDown(header, { clientX: 200, clientY: 200 });
    fireEvent.pointerMove(document, { clientX: 250, clientY: 230 });
    unmount();

    // The document listeners were removed on unmount: releasing (or moving)
    // the pointer afterward must not fire onGeometryChange.
    fireEvent.pointerMove(document, { clientX: 300, clientY: 300 });
    fireEvent.pointerUp(document, { clientX: 300, clientY: 300 });
    expect(onGeometryChange).not.toHaveBeenCalled();
  });

  it('aborts an in-flight resize on unmount without committing a geometry', () => {
    const { onGeometryChange, unmount } = renderPanel();
    const handle = document.querySelector('.cursor-nwse-resize') as HTMLElement;

    fireEvent.pointerDown(handle, { clientX: 460, clientY: 340 });
    fireEvent.pointerMove(document, { clientX: 500, clientY: 400 });
    unmount();

    fireEvent.pointerUp(document, { clientX: 500, clientY: 400 });
    expect(onGeometryChange).not.toHaveBeenCalled();
  });
});
