/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useReducer } from 'react';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import type { FloatingPanelProps } from '@/layers/shared/ui';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { PipHost } from '../ui/PipHost';

// Mock the floating-panel primitive to a thin harness: its drag/resize/clamp
// mechanics are covered by its own suite. Here we only assert what PipHost feeds
// it (geometry, title, wiring) and how it routes content into its children.
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/ui')>();
  return {
    ...actual,
    FloatingPanel: vi.fn((props: FloatingPanelProps) => (
      <div
        data-testid="floating-panel"
        data-title={props.title}
        data-geometry={JSON.stringify(props.geometry)}
        data-has-restore={props.onRestore ? 'true' : 'false'}
      >
        <button type="button" data-testid="fp-close" onClick={props.onClose}>
          close
        </button>
        {props.children}
      </div>
    )),
  };
});

// Keep the real store (so openPip/closePip/setPipGeometry actually run) but let
// each test control the mobile flag.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: vi.fn(() => false) };
});

function resetStore() {
  act(() => {
    useAppStore.setState({ pipContent: null, pipGeometry: null });
  });
}

describe('PipHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useIsMobile).mockReturnValue(false);
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when pipContent is null', () => {
    const { container } = render(<PipHost />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('floating-panel')).not.toBeInTheDocument();
  });

  it('renders the demo content title when pipContent is a demo descriptor', () => {
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Hello PIP' });
    });
    render(<PipHost />);
    expect(screen.getByTestId('floating-panel')).toHaveAttribute('data-title', 'Hello PIP');
    expect(screen.getByText('Hello PIP')).toBeInTheDocument();
  });

  it('uses the computed bottom-right default geometry when pipGeometry is null', () => {
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Docked' });
    });
    // no setPipGeometry call → pipGeometry stays null → host computes the dock
    render(<PipHost />);
    const raw = screen.getByTestId('floating-panel').getAttribute('data-geometry');
    expect(JSON.parse(raw ?? '{}')).toEqual({
      x: window.innerWidth - 360 - 16,
      y: window.innerHeight - 240 - 16,
      width: 360,
      height: 240,
    });
  });

  it('renders nothing and closes an open panel when the viewport is mobile', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Should close' });
    });
    render(<PipHost />);
    expect(screen.queryByTestId('floating-panel')).not.toBeInTheDocument();
    // The mobile-guard effect calls closePip(), clearing the content.
    expect(useAppStore.getState().pipContent).toBeNull();
  });

  it('wires the close control to closePip', () => {
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Closable' });
    });
    render(<PipHost />);
    act(() => {
      fireEvent.click(screen.getByTestId('fp-close'));
    });
    expect(useAppStore.getState().pipContent).toBeNull();
    expect(screen.queryByTestId('floating-panel')).not.toBeInTheDocument();
  });

  it('keeps the renderer identity stable across parent re-renders (no remount)', () => {
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Stable panel' });
    });

    // A parent whose re-render forces PipHost to re-render without changing PIP
    // state. If PIP_RENDERERS were built inline, the renderer would get a fresh
    // identity each render and React would unmount/remount the subtree, giving
    // us a different DOM node. A module-scope map keeps the node identical.
    function Harness() {
      const [, force] = useReducer((c: number) => c + 1, 0);
      return (
        <>
          <button type="button" data-testid="force" onClick={() => force()}>
            re-render
          </button>
          <PipHost />
        </>
      );
    }

    render(<Harness />);
    const before = screen.getByText('Stable panel');
    act(() => {
      fireEvent.click(screen.getByTestId('force'));
    });
    const after = screen.getByText('Stable panel');
    expect(after).toBe(before);
  });
});
