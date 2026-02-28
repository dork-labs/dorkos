/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock @xyflow/react — only NodeProps type is needed, no full canvas
// ---------------------------------------------------------------------------
vi.mock('@xyflow/react', () => ({
  // NamespaceGroupNode only uses the NodeProps type — no runtime imports needed
}));

// Mock the reduced-motion hook
const mockUsePrefersReducedMotion = vi.fn(() => false);
vi.mock('../../lib/use-reduced-motion', () => ({
  usePrefersReducedMotion: () => mockUsePrefersReducedMotion(),
}));

import { NamespaceGroupNode, type NamespaceGroupData } from '../NamespaceGroupNode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProps(overrides: Partial<NamespaceGroupData> = {}) {
  return {
    id: 'group:test-ns',
    type: 'namespace-group',
    data: {
      namespace: 'production',
      agentCount: 5,
      activeCount: 3,
      color: '#3b82f6',
      ...overrides,
    },
    selected: false,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: false,
  } as unknown as Parameters<typeof NamespaceGroupNode>[0];
}

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

describe('NamespaceGroupNode', () => {
  describe('rendering', () => {
    it('renders the namespace name', () => {
      render(<NamespaceGroupNode {...makeMockProps()} />);
      expect(screen.getByText('production')).toBeInTheDocument();
    });

    it('renders the agent count in active/total format', () => {
      render(<NamespaceGroupNode {...makeMockProps({ activeCount: 3, agentCount: 5 })} />);
      expect(screen.getByText('3/5 agents')).toBeInTheDocument();
    });

    it('renders zero active agents correctly', () => {
      render(<NamespaceGroupNode {...makeMockProps({ activeCount: 0, agentCount: 2 })} />);
      expect(screen.getByText('0/2 agents')).toBeInTheDocument();
    });

    it('applies namespace color to the name text', () => {
      render(<NamespaceGroupNode {...makeMockProps({ color: '#ef4444' })} />);
      const nameEl = screen.getByText('production');
      expect(nameEl.style.color).toBe('rgb(239, 68, 68)');
    });

    it('applies namespace color to border with transparency', () => {
      const { container } = render(
        <NamespaceGroupNode {...makeMockProps({ color: '#3b82f6' })} />,
      );
      const wrapper = container.firstChild as HTMLElement;
      // jsdom converts hex+alpha to rgba format
      expect(wrapper.style.borderColor).toBe('rgba(59, 130, 246, 0.25)');
    });

    it('uses rounded-xl border-2 styling on the wrapper', () => {
      const { container } = render(<NamespaceGroupNode {...makeMockProps()} />);
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.className).toContain('rounded-xl');
      expect(wrapper.className).toContain('border-2');
    });

    it('renders 100% width and height to fill ELK-computed dimensions', () => {
      const { container } = render(<NamespaceGroupNode {...makeMockProps()} />);
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.style.width).toBe('100%');
      expect(wrapper.style.height).toBe('100%');
    });
  });

  describe('pulse dot', () => {
    it('shows pulse dot when activeCount > 0', () => {
      const { container } = render(
        <NamespaceGroupNode {...makeMockProps({ activeCount: 2, color: '#22c55e' })} />,
      );
      // Find the small dot element
      const dots = container.querySelectorAll('.h-1\\.5.w-1\\.5.rounded-full');
      expect(dots.length).toBe(1);
    });

    it('does not show pulse dot when activeCount is 0', () => {
      const { container } = render(
        <NamespaceGroupNode {...makeMockProps({ activeCount: 0 })} />,
      );
      const dots = container.querySelectorAll('.h-1\\.5.w-1\\.5.rounded-full');
      expect(dots.length).toBe(0);
    });

    it('applies animate-pulse class when reduced motion is not preferred', () => {
      mockUsePrefersReducedMotion.mockReturnValue(false);
      const { container } = render(
        <NamespaceGroupNode {...makeMockProps({ activeCount: 1 })} />,
      );
      const dot = container.querySelector('.h-1\\.5.w-1\\.5.rounded-full');
      expect(dot?.className).toContain('animate-pulse');
    });

    it('does not apply animate-pulse class when reduced motion is preferred', () => {
      mockUsePrefersReducedMotion.mockReturnValue(true);
      const { container } = render(
        <NamespaceGroupNode {...makeMockProps({ activeCount: 1 })} />,
      );
      const dot = container.querySelector('.h-1\\.5.w-1\\.5.rounded-full');
      expect(dot?.className).not.toContain('animate-pulse');
    });

    it('uses namespace color for the pulse dot background', () => {
      const { container } = render(
        <NamespaceGroupNode {...makeMockProps({ activeCount: 1, color: '#f59e0b' })} />,
      );
      const dot = container.querySelector('.h-1\\.5.w-1\\.5.rounded-full') as HTMLElement;
      expect(dot.style.backgroundColor).toBe('rgb(245, 158, 11)');
    });
  });
});
