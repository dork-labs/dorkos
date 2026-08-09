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

describe('AgentNode health signal', () => {
  // Health used to ride the shared `AgentAvatar` as a coloured ring plus a
  // pulsing dot, both derived from `healthStatus === 'active'` — the mesh's
  // "seen within the last hour". That put a right-now animation on an
  // hour-old heartbeat, and put it on every list row in the cockpit besides.
  // The node draws its own still dot now, off the topology's own map.

  /** The node's health dot, when it drew one. */
  const dotOf = (container: HTMLElement) =>
    container.querySelector(
      '[title="Active"], [title="Inactive"], [title="Stale"], [title="Unreachable"]'
    );

  describe('default card (zoom 0.6-1.2)', () => {
    it('draws a health dot in the success token for an active agent', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);

      expect(dotOf(container)).toBeInTheDocument();
      expect(dotOf(container)!.className).toContain('bg-status-success');
    });

    it('never animates, so there is no motion for a preference to drop', () => {
      // The whole subject of this file, inverted: the ping is gone rather than
      // hidden under `motion-reduce`. Health is a state — "we heard from it
      // recently" — and a state that pulsed would read as a live turn.
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);

      expect(container.querySelector('.animate-ping')).not.toBeInTheDocument();
      expect(container.querySelector('[class*="animate-pulse"]')).not.toBeInTheDocument();
    });

    it('draws the warning token for inactive and a muted dot for stale', () => {
      const { container: inactive } = render(
        <AgentNode {...makeMockProps({ healthStatus: 'inactive' })} />
      );
      expect(dotOf(inactive)!.className).toContain('bg-status-warning');

      const { container: stale } = render(
        <AgentNode {...makeMockProps({ healthStatus: 'stale' })} />
      );
      expect(dotOf(stale)!.className).toContain('bg-muted-foreground/50');
    });

    it('draws the error token for an unreachable agent, which had no signal at all before', () => {
      // The old ring had four colours but the legend explained three, and the
      // avatar's dot only ever lit for `active` — an agent whose folder cannot
      // be found looked exactly like one nobody had pinged lately.
      const { container } = render(
        <AgentNode {...makeMockProps({ healthStatus: 'unreachable' })} />
      );

      expect(dotOf(container)!.className).toContain('bg-status-error');
    });

    it('leaves the disc itself carrying identity and nothing else', () => {
      // No ring on the avatar: the 2px it used to spend on health is what the
      // identity hover ring needs, and a diagnostic that changed colour under
      // the pointer read as a hover state.
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);
      const disc = container.querySelector('[data-slot="agent-avatar"]')!;

      expect(disc.className).not.toContain('ring-2');
      expect(disc.querySelector('[data-slot="identity-status-dot"]')).not.toBeInTheDocument();
    });
  });

  describe('expanded card (zoom > 1.2)', () => {
    beforeEach(() => {
      mockUseLodBand.mockReturnValue('expanded');
    });

    it('draws the same still health dot', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);

      expect(dotOf(container)!.className).toContain('bg-status-success');
      expect(container.querySelector('.animate-ping')).not.toBeInTheDocument();
    });
  });

  describe('compact pill (zoom < 0.6)', () => {
    beforeEach(() => {
      mockUseLodBand.mockReturnValue('compact');
    });

    it('keeps the health dot at the smallest band, where the ring used to be all there was', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'active' })} />);

      expect(dotOf(container)!.className).toContain('bg-status-success');
    });

    it('says inactive in amber rather than saying nothing', () => {
      const { container } = render(<AgentNode {...makeMockProps({ healthStatus: 'inactive' })} />);

      expect(dotOf(container)!.className).toContain('bg-status-warning');
      expect(container.querySelector('.animate-ping')).not.toBeInTheDocument();
    });
  });
});
