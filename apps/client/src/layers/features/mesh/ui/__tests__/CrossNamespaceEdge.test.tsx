/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

beforeEach(() => {
  vi.clearAllMocks();
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
        </svg>
      );
      expect(
        container.querySelector('[data-testid="edge-path-cross-ns-edge-1"]')
      ).toBeInTheDocument();
    });

    it('uses var(--color-primary) for stroke color', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>
      );
      const path = container.querySelector(
        '[data-testid="edge-path-cross-ns-edge-1"]'
      ) as HTMLElement;
      expect(path?.style.stroke).toBe('var(--color-primary)');
    });
  });

  describe('no animateMotion animation', () => {
    it('does not render animateMotion or circle elements', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>
      );
      expect(container.querySelector('animateMotion')).not.toBeInTheDocument();
      expect(container.querySelector('circle')).not.toBeInTheDocument();
    });
  });

  describe('label visibility', () => {
    it('does not show label when not selected and not hovered', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...BASE_EDGE_PROPS} />
        </svg>
      );
      expect(
        container.querySelector('[data-testid="edge-label-renderer"]')
      ).not.toBeInTheDocument();
    });

    it('shows label when selected', () => {
      const { container } = render(
        <svg>
          <CrossNamespaceEdge {...{ ...BASE_EDGE_PROPS, selected: true }} />
        </svg>
      );
      expect(container.querySelector('[data-testid="edge-label-renderer"]')).toBeInTheDocument();
    });
  });
});
