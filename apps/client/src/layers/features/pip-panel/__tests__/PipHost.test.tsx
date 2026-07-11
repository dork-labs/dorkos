/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, useReducer } from 'react';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { FloatingPanel, type FloatingPanelProps } from '@/layers/shared/ui';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { PipHost } from '../ui/PipHost';

const { demoMountSpy, demoUnmountSpy, presenceSpy } = vi.hoisted(() => ({
  demoMountSpy: vi.fn(),
  demoUnmountSpy: vi.fn(),
  presenceSpy: vi.fn(),
}));

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

// Instrument DemoPipContent with mount/unmount spies so remounts are countable.
vi.mock('../ui/DemoPipContent', () => ({
  DemoPipContent: ({ content }: { content: { kind: 'demo'; title: string } }) => {
    useEffect(() => {
      demoMountSpy();
      return () => demoUnmountSpy();
    }, []);
    return <div>{content.title}</div>;
  },
}));

// Replace the global setup's AnimatePresence passthrough with a spying
// passthrough so tests can assert the boundary itself stays mounted while its
// child conditionally renders (required for the exit animation to ever play).
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    AnimatePresence: (props: { children?: React.ReactNode }) => {
      presenceSpy();
      return props.children;
    },
  };
});

// Keep the real store (so openPip/closePip/setPipGeometry actually run) but let
// each test control the mobile flag.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: vi.fn(() => false) };
});

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    writable: true,
    configurable: true,
    value: height,
  });
}

function resetStore() {
  act(() => {
    useAppStore.setState({ pipContent: null, pipGeometry: null });
  });
}

describe('PipHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useIsMobile).mockReturnValue(false);
    setViewport(1024, 768);
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when pipContent is null, while AnimatePresence stays mounted', () => {
    const { container } = render(<PipHost />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('floating-panel')).not.toBeInTheDocument();
    // The exit boundary must exist even with nothing to show — if it only
    // mounted alongside the panel, the exit animation could never play.
    expect(presenceSpy).toHaveBeenCalled();
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

  it('keeps the default geometry referentially stable across unrelated re-renders', () => {
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Stable dock' });
    });

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
    act(() => {
      fireEvent.click(screen.getByTestId('force'));
    });

    const geometries = vi
      .mocked(FloatingPanel)
      .mock.calls.map((call) => (call[0] as FloatingPanelProps).geometry);
    expect(geometries.length).toBeGreaterThan(1);
    // Same object reference on every render — a fresh object per render would
    // churn FloatingPanel's geometry-dependent reclamp effect.
    for (const g of geometries) expect(g).toBe(geometries[0]);
  });

  it('re-pins the default dock to the corner on window resize before the first gesture', () => {
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Pinned' });
    });
    render(<PipHost />);

    act(() => {
      setViewport(800, 600);
      fireEvent(window, new Event('resize'));
    });

    const raw = screen.getByTestId('floating-panel').getAttribute('data-geometry');
    expect(JSON.parse(raw ?? '{}')).toEqual({
      x: 800 - 376,
      y: 600 - 256,
      width: 360,
      height: 240,
    });
    // Re-pinning is display-only: nothing is committed to the store.
    expect(useAppStore.getState().pipGeometry).toBeNull();
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

  it('keeps the renderer identity stable across parent re-renders (mounts exactly once)', () => {
    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Stable panel' });
    });

    // A parent whose re-render forces PipHost to re-render without changing PIP
    // state. If PIP_RENDERERS were built inline, the renderer would get a fresh
    // identity each render and React would unmount/remount the subtree.
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
    expect(demoMountSpy).toHaveBeenCalledTimes(1);
    const before = screen.getByText('Stable panel');

    act(() => {
      fireEvent.click(screen.getByTestId('force'));
    });

    // The mount effect fired exactly once and no cleanup ran: no remount.
    expect(demoMountSpy).toHaveBeenCalledTimes(1);
    expect(demoUnmountSpy).not.toHaveBeenCalled();
    // Same DOM node, too — the subtree was never recreated.
    expect(screen.getByText('Stable panel')).toBe(before);
  });
});
