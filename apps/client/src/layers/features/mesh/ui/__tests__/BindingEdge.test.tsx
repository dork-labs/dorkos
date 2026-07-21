/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { EdgeActivity } from '../../model/relay-flow-store';

// ---------------------------------------------------------------------------
// Mock @xyflow/react — replaces flow edge primitives with HTML stubs. Zoom is
// mutable per-test via `mockZoom` (default 1, LOD tests override it).
// ---------------------------------------------------------------------------
let mockZoom = 1;
vi.mock('@xyflow/react', () => ({
  BaseEdge: ({ id, path }: { id: string; path: string }) => (
    <path data-testid={`edge-path-${id}`} d={path} />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-renderer">{children}</div>
  ),
  getBezierPath: () => ['M0,0 C50,0 50,100 100,100', 50, 50],
  useStore: (selector: (s: unknown) => unknown) => selector({ transform: [0, 0, mockZoom] }),
  Position: {
    Left: 'left',
    Right: 'right',
    Top: 'top',
    Bottom: 'bottom',
  },
}));

// ---------------------------------------------------------------------------
// Mock the relay-flow store — a plain selector-invoking stub, no Zustand
// subscription plumbing needed for these RTL assertions.
// ---------------------------------------------------------------------------
let mockActivity: Record<string, EdgeActivity> = {};
const mockClear = vi.fn();
vi.mock('../../model/relay-flow-store', () => ({
  useRelayFlowStore: (
    selector: (s: { activity: Record<string, EdgeActivity>; clear: typeof mockClear }) => unknown
  ) => selector({ activity: mockActivity, clear: mockClear }),
}));

// Mock the reduced-motion hook — the same pattern as AgentNode.reduced-motion.test.tsx.
const mockUsePrefersReducedMotion = vi.fn(() => false);
vi.mock('../../lib/use-reduced-motion', () => ({
  usePrefersReducedMotion: () => mockUsePrefersReducedMotion(),
}));

import { BindingEdge } from '../BindingEdge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_EDGE_PROPS = {
  id: 'binding-edge-1',
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 100,
  sourcePosition: 'right' as const,
  targetPosition: 'left' as const,
  selected: false,
  animated: false,
  deletable: true,
  selectable: true,
  focusable: true,
  source: 'adapter-1',
  target: 'agent-1',
  zIndex: 0,
} as Parameters<typeof BindingEdge>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockZoom = 1;
  mockActivity = {};
  mockUsePrefersReducedMotion.mockReturnValue(false);
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BindingEdge', () => {
  describe('rendering', () => {
    it('renders the edge path', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} />);
      expect(screen.getByTestId('edge-path-binding-edge-1')).toBeInTheDocument();
    });

    it('does not render label at rest (hover-to-reveal)', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} data={{}} />);
      expect(screen.queryByTestId('edge-label-renderer')).not.toBeInTheDocument();
    });
  });

  describe('relay-flow pulse', () => {
    it('renders the pulse when activity is present, zoom >= threshold, and reduced-motion is off', () => {
      // Purpose: the render gate honors activity.
      mockActivity = { 'binding-edge-1': { direction: 'inbound', nonce: 1 } };
      const { container } = render(<BindingEdge {...BASE_EDGE_PROPS} />);
      expect(container.querySelector('circle.fill-primary')).toBeInTheDocument();
    });

    it('does not render the pulse under reduced-motion, even with active entry and zoom in range', () => {
      // Purpose: Decision 5 — the explicit, testable reduced-motion gate.
      mockActivity = { 'binding-edge-1': { direction: 'inbound', nonce: 1 } };
      mockUsePrefersReducedMotion.mockReturnValue(true);
      const { container } = render(<BindingEdge {...BASE_EDGE_PROPS} />);
      expect(container.querySelector('circle.fill-primary')).not.toBeInTheDocument();
    });

    it('does not render the pulse below PULSE_MIN_ZOOM, even with an active entry', () => {
      // Purpose: the LOD gate — a moving dot below threshold is sub-pixel noise.
      mockActivity = { 'binding-edge-1': { direction: 'inbound', nonce: 1 } };
      mockZoom = 0.3;
      const { container } = render(<BindingEdge {...BASE_EDGE_PROPS} />);
      expect(container.querySelector('circle.fill-primary')).not.toBeInTheDocument();
    });

    it('does not render the pulse for an idle edge (no active entry)', () => {
      // Purpose: idle edges stay clean — no phantom pulse.
      const { container } = render(<BindingEdge {...BASE_EDGE_PROPS} />);
      expect(container.querySelector('circle.fill-primary')).not.toBeInTheDocument();
    });

    it('clears the store entry immediately when declining to animate below PULSE_MIN_ZOOM', () => {
      // Purpose: a pulse suppressed by the LOD gate must not sit in the store
      // waiting for zoom to return — it's dropped now, not stockpiled for a
      // later flurry when the user zooms back in.
      mockActivity = { 'binding-edge-1': { direction: 'inbound', nonce: 1 } };
      mockZoom = 0.3;
      render(<BindingEdge {...BASE_EDGE_PROPS} />);
      expect(mockClear).toHaveBeenCalledWith('binding-edge-1');
    });

    it('clears the store entry immediately when declining to animate under reduced-motion', () => {
      // Purpose: same expiry guarantee for the reduced-motion gate.
      mockActivity = { 'binding-edge-1': { direction: 'inbound', nonce: 1 } };
      mockUsePrefersReducedMotion.mockReturnValue(true);
      render(<BindingEdge {...BASE_EDGE_PROPS} />);
      expect(mockClear).toHaveBeenCalledWith('binding-edge-1');
    });
  });

  describe('label display', () => {
    it('shows explicit label when selected', () => {
      render(
        <BindingEdge
          {...BASE_EDGE_PROPS}
          selected
          data={{ label: 'Customer Support', sessionStrategy: 'per-chat' }}
        />
      );
      expect(screen.getByText('Customer Support')).toBeInTheDocument();
    });

    it('falls back to sessionStrategy when no label and selected', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{ sessionStrategy: 'per-user' }} />);
      expect(screen.getByText('Per User')).toBeInTheDocument();
    });

    it('falls back to "Binding" when neither label nor sessionStrategy and selected', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{}} />);
      expect(screen.getByText('Channel')).toBeInTheDocument();
    });

    it('shows "Binding" when data is undefined and selected', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected />);
      expect(screen.getByText('Channel')).toBeInTheDocument();
    });
  });

  describe('delete button', () => {
    it('renders delete button when selected and onDelete is provided', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{ onDelete: vi.fn() }} />);
      expect(screen.getByRole('button', { name: /remove channel/i })).toBeInTheDocument();
    });

    it('does not render delete button when not selected even with onDelete', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} data={{ onDelete: vi.fn() }} />);
      expect(screen.queryByRole('button', { name: /remove channel/i })).not.toBeInTheDocument();
    });

    it('does not render delete button when onDelete is absent', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{}} />);
      expect(screen.queryByRole('button', { name: /remove channel/i })).not.toBeInTheDocument();
    });

    it('calls onDelete with the edge id when delete button is clicked', () => {
      const onDelete = vi.fn();
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{ onDelete }} />);
      fireEvent.click(screen.getByRole('button', { name: /remove channel/i }));
      expect(onDelete).toHaveBeenCalledWith('binding-edge-1');
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe('filter badges', () => {
    it('renders chatId badge when present and selected', () => {
      render(
        <BindingEdge
          {...BASE_EDGE_PROPS}
          selected
          data={{ chatId: '12345', sessionStrategy: 'per-chat' }}
        />
      );
      expect(screen.getByText('12345')).toBeInTheDocument();
    });

    it('renders channelType badge when present and selected', () => {
      render(
        <BindingEdge
          {...BASE_EDGE_PROPS}
          selected
          data={{ channelType: 'private', sessionStrategy: 'per-chat' }}
        />
      );
      expect(screen.getByText('private')).toBeInTheDocument();
    });

    it('renders both chatId and channelType badges when both present', () => {
      render(
        <BindingEdge
          {...BASE_EDGE_PROPS}
          selected
          data={{ chatId: '12345', channelType: 'group', sessionStrategy: 'per-chat' }}
        />
      );
      expect(screen.getByText('12345')).toBeInTheDocument();
      expect(screen.getByText('group')).toBeInTheDocument();
    });

    it('does not render filter badges when neither chatId nor channelType present', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{ sessionStrategy: 'per-chat' }} />);
      // Only the session strategy label should be shown, no filter badges
      expect(screen.getByText('Per Chat')).toBeInTheDocument();
      expect(screen.queryByText('12345')).not.toBeInTheDocument();
    });

    it('does not render filter badges when not selected or hovered', () => {
      render(
        <BindingEdge {...BASE_EDGE_PROPS} data={{ chatId: '12345', channelType: 'private' }} />
      );
      // Label (and badges) should not be visible at rest
      expect(screen.queryByText('12345')).not.toBeInTheDocument();
      expect(screen.queryByText('private')).not.toBeInTheDocument();
    });
  });
});
