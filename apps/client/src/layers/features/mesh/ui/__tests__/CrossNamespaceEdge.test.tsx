/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock @xyflow/react
// ---------------------------------------------------------------------------
vi.mock('@xyflow/react', () => ({
  BaseEdge: ({ id, path, style }: { id: string; path: string; style?: React.CSSProperties }) => (
    <path data-testid={`edge-path-${id}`} d={path} style={style} />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-renderer">{children}</div>
  ),
  getBezierPath: () => ['M0,0 C50,0 50,100 100,100', 50, 50],
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: {
    Left: 'left',
    Right: 'right',
    Top: 'top',
    Bottom: 'bottom',
  },
}));

// Mock the reduced-motion hook
const mockUsePrefersReducedMotion = vi.fn(() => false);
vi.mock('../../lib/use-reduced-motion', () => ({
  usePrefersReducedMotion: () => mockUsePrefersReducedMotion(),
}));

import { CrossNamespaceEdge } from '../CrossNamespaceEdge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_EDGE_PROPS = {
  id: 'cross-ns-edge-1',
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 100,
  sourcePosition: 'right' as const,
  targetPosition: 'left' as const,
  selected: false,
  animated: true,
  deletable: false,
  selectable: true,
  focusable: true,
  source: 'group-a',
  target: 'group-b',
  zIndex: 0,
  data: { label: 'ns-a > ns-b' },
} as Parameters<typeof CrossNamespaceEdge>[0];

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUsePrefersReducedMotion.mockReturnValue(false);
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossNamespaceEdge', () => {
  describe('rendering', () => {
    it('renders the edge path', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>,
      );
      expect(container.querySelector('[data-testid="edge-path-cross-ns-edge-1"]')).toBeInTheDocument();
    });

    it('uses var(--color-primary) for stroke color', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>,
      );
      const path = container.querySelector('[data-testid="edge-path-cross-ns-edge-1"]') as HTMLElement;
      expect(path?.style.stroke).toBe('var(--color-primary)');
    });
  });

  describe('flow particle (animateMotion)', () => {
    it('renders flow particle circle when reduced motion is not preferred', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>,
      );
      const circle = container.querySelector('circle');
      expect(circle).toBeInTheDocument();
    });

    it('does not render flow particle circle when reduced motion is preferred', () => {
      mockUsePrefersReducedMotion.mockReturnValue(true);
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>,
      );
      const circle = container.querySelector('circle');
      expect(circle).not.toBeInTheDocument();
    });

    it('flow particle has animateMotion child when present', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>,
      );
      const animateMotion = container.querySelector('animateMotion');
      expect(animateMotion).toBeInTheDocument();
    });

    it('no animateMotion element when reduced motion is preferred', () => {
      mockUsePrefersReducedMotion.mockReturnValue(true);
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>,
      );
      const animateMotion = container.querySelector('animateMotion');
      expect(animateMotion).not.toBeInTheDocument();
    });
  });

  describe('label visibility', () => {
    it('does not show label when not selected and not hovered', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>,
      );
      expect(container.querySelector('[data-testid="edge-label-renderer"]')).not.toBeInTheDocument();
    });

    it('shows label when selected', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...{ ...BASE_EDGE_PROPS, selected: true }} />
        </svg>,
      );
      expect(container.querySelector('[data-testid="edge-label-renderer"]')).toBeInTheDocument();
    });
  });
});
