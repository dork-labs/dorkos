/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { LodBand } from '../../lib/use-lod-band';

// ---------------------------------------------------------------------------
// Mock @xyflow/react
// ---------------------------------------------------------------------------
vi.mock('@xyflow/react', () => ({
  Handle: ({ position }: { position: string }) => <div data-testid={`handle-${position}`} />,
  NodeToolbar: ({ children, isVisible }: { children: React.ReactNode; isVisible?: boolean }) =>
    isVisible ? <div data-testid="node-toolbar">{children}</div> : null,
  Position: {
    Left: 'left',
    Right: 'right',
    Top: 'top',
    Bottom: 'bottom',
  },
}));

// Mock the LOD band hook — default to 'default' band
const mockUseLodBand = vi.fn((): LodBand => 'default');
vi.mock('../../lib/use-lod-band', () => ({
  useLodBand: () => mockUseLodBand(),
}));

// Mock the reduced-motion hook
const mockUsePrefersReducedMotion = vi.fn(() => false);
vi.mock('../../lib/use-reduced-motion', () => ({
  usePrefersReducedMotion: () => mockUsePrefersReducedMotion(),
}));

// Mock sonner toast
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

import { AgentNode } from '../AgentNode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProps(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-test-1',
    type: 'agent',
    data: {
      label: 'Test Agent',
      runtime: 'claude-code',
      healthStatus: 'active',
      capabilities: ['code', 'review'],
      namespace: 'default',
      namespaceColor: '#3b82f6',
      avatarColor: 'hsl(200, 70%, 55%)',
      emoji: '🤖',
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
  } as unknown as Parameters<typeof AgentNode>[0];
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
  mockUseLodBand.mockReturnValue('default');
  mockUsePrefersReducedMotion.mockReturnValue(false);
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentNode reduced motion', () => {
  // AgentAvatar handles reduced-motion via CSS (motion-reduce:hidden) rather
  // than conditional DOM removal. The ping element is always rendered for active
  // agents; the browser respects the prefers-reduced-motion media query.

  describe('default card (zoom 0.6-1.2)', () => {
    it('renders animate-ping health pulse for active agents', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).toBeInTheDocument();
    });

    it('applies motion-reduce:hidden to the ping element for a11y', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).toBeInTheDocument();
      expect(pingElement!.className).toContain('motion-reduce:hidden');
    });

    it('does not render animate-ping for inactive agents', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'inactive' })} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).not.toBeInTheDocument();
    });

    it('does not render animate-ping for stale agents', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'stale' })} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).not.toBeInTheDocument();
    });
  });

  describe('expanded card (zoom > 1.2)', () => {
    beforeEach(() => {
      mockUseLodBand.mockReturnValue('expanded');
    });

    it('renders animate-ping for active agents in expanded view', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).toBeInTheDocument();
    });
  });

  describe('compact pill (zoom < 0.6)', () => {
    beforeEach(() => {
      mockUseLodBand.mockReturnValue('compact');
    });

    it('renders animate-ping for active agents via AgentAvatar', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).toBeInTheDocument();
    });

    it('does not render animate-ping for inactive agents in compact mode', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'inactive' })} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).not.toBeInTheDocument();
    });
  });
});
