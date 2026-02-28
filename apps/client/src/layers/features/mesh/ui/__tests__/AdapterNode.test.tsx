/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock @xyflow/react — replaces flow primitives with simple HTML stubs so we
// can test AdapterNode rendering without a full ReactFlow canvas context.
// ---------------------------------------------------------------------------
vi.mock('@xyflow/react', () => ({
  Handle: ({ position }: { position: string }) => (
    <div data-testid={`handle-${position}`} />
  ),
  Position: {
    Left: 'left',
    Right: 'right',
    Top: 'top',
    Bottom: 'bottom',
  },
}));

import { AdapterNode, ADAPTER_NODE_WIDTH, ADAPTER_NODE_HEIGHT } from '../AdapterNode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProps(overrides: Partial<{
  adapterName: string;
  adapterType: string;
  adapterStatus: 'running' | 'stopped' | 'error';
  bindingCount: number;
}> = {}) {
  return {
    id: 'adapter-test-1',
    type: 'adapter',
    data: {
      adapterName: 'Telegram Bot',
      adapterType: 'telegram',
      adapterStatus: 'running' as const,
      bindingCount: 2,
      ...overrides,
    },
    selected: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
  } as unknown as Parameters<typeof AdapterNode>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterNode', () => {
  describe('rendering', () => {
    it('renders adapter name', () => {
      render(<AdapterNode {...makeMockProps()} />);
      expect(screen.getByText('Telegram Bot')).toBeInTheDocument();
    });

    it('renders adapter type in lowercase', () => {
      render(<AdapterNode {...makeMockProps({ adapterType: 'webhook' })} />);
      expect(screen.getByText('webhook')).toBeInTheDocument();
    });

    it('renders a source handle on the right', () => {
      render(<AdapterNode {...makeMockProps()} />);
      expect(screen.getByTestId('handle-right')).toBeInTheDocument();
    });
  });

  describe('status indicator', () => {
    it('shows green dot for running status', () => {
      const { container } = render(<AdapterNode {...makeMockProps({ adapterStatus: 'running' })} />);
      expect(container.querySelector('.bg-green-500')).toBeInTheDocument();
    });

    it('shows zinc dot for stopped status', () => {
      const { container } = render(<AdapterNode {...makeMockProps({ adapterStatus: 'stopped' })} />);
      expect(container.querySelector('.bg-zinc-400')).toBeInTheDocument();
    });

    it('shows red dot for error status', () => {
      const { container } = render(<AdapterNode {...makeMockProps({ adapterStatus: 'error' })} />);
      expect(container.querySelector('.bg-red-500')).toBeInTheDocument();
    });
  });

  describe('binding count badge', () => {
    it('shows binding count badge when bindingCount > 0', () => {
      render(<AdapterNode {...makeMockProps({ bindingCount: 3 })} />);
      expect(screen.getByText('3 bindings')).toBeInTheDocument();
    });

    it('shows singular "binding" for count of 1', () => {
      render(<AdapterNode {...makeMockProps({ bindingCount: 1 })} />);
      expect(screen.getByText('1 binding')).toBeInTheDocument();
    });

    it('does not render badge when bindingCount is 0', () => {
      render(<AdapterNode {...makeMockProps({ bindingCount: 0 })} />);
      expect(screen.queryByText(/binding/)).not.toBeInTheDocument();
    });
  });

  describe('selection ring', () => {
    it('applies ring-2 ring-primary when selected', () => {
      const { container } = render(
        <AdapterNode {...makeMockProps()} selected />,
      );
      const card = container.firstChild as HTMLElement;
      expect(card.className).toMatch(/ring-2/);
      expect(card.className).toMatch(/ring-primary/);
    });

    it('does not apply ring when not selected', () => {
      const { container } = render(
        <AdapterNode {...makeMockProps()} selected={false} />,
      );
      const card = container.firstChild as HTMLElement;
      expect(card.className).not.toMatch(/ring-2/);
    });
  });

  describe('dimensions', () => {
    it('exports ADAPTER_NODE_WIDTH and ADAPTER_NODE_HEIGHT constants', () => {
      expect(ADAPTER_NODE_WIDTH).toBeGreaterThan(0);
      expect(ADAPTER_NODE_HEIGHT).toBeGreaterThan(0);
    });

    it('applies ADAPTER_NODE_WIDTH as inline width', () => {
      const { container } = render(<AdapterNode {...makeMockProps()} />);
      const card = container.firstChild as HTMLElement;
      expect(card.style.width).toBe(`${ADAPTER_NODE_WIDTH}px`);
    });
  });
});
