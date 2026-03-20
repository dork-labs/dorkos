/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock @xyflow/react — replaces flow edge primitives with HTML stubs.
// ---------------------------------------------------------------------------
vi.mock('@xyflow/react', () => ({
  BaseEdge: ({ id, path }: { id: string; path: string }) => (
    <path data-testid={`edge-path-${id}`} d={path} />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-renderer">{children}</div>
  ),
  getBezierPath: () => ['M0,0 C50,0 50,100 100,100', 50, 50],
  useStore: (selector: (s: unknown) => unknown) => selector({ transform: [0, 0, 1] }),
  Position: {
    Left: 'left',
    Right: 'right',
    Top: 'top',
    Bottom: 'bottom',
  },
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
      expect(screen.getByText('per-user')).toBeInTheDocument();
    });

    it('falls back to "Binding" when neither label nor sessionStrategy and selected', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{}} />);
      expect(screen.getByText('Binding')).toBeInTheDocument();
    });

    it('shows "Binding" when data is undefined and selected', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected />);
      expect(screen.getByText('Binding')).toBeInTheDocument();
    });
  });

  describe('delete button', () => {
    it('renders delete button when selected and onDelete is provided', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{ onDelete: vi.fn() }} />);
      expect(screen.getByRole('button', { name: /delete binding/i })).toBeInTheDocument();
    });

    it('does not render delete button when not selected even with onDelete', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} data={{ onDelete: vi.fn() }} />);
      expect(screen.queryByRole('button', { name: /delete binding/i })).not.toBeInTheDocument();
    });

    it('does not render delete button when onDelete is absent', () => {
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{}} />);
      expect(screen.queryByRole('button', { name: /delete binding/i })).not.toBeInTheDocument();
    });

    it('calls onDelete with the edge id when delete button is clicked', () => {
      const onDelete = vi.fn();
      render(<BindingEdge {...BASE_EDGE_PROPS} selected data={{ onDelete }} />);
      fireEvent.click(screen.getByRole('button', { name: /delete binding/i }));
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
      expect(screen.getByText('per-chat')).toBeInTheDocument();
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
