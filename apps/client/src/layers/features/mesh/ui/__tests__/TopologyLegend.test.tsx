/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock @xyflow/react
// ---------------------------------------------------------------------------
vi.mock('@xyflow/react', () => ({
  Panel: ({ children, position }: { children: React.ReactNode; position: string }) => (
    <div data-testid={`panel-${position}`}>{children}</div>
  ),
}));

// Mock the reduced-motion hook
const mockUsePrefersReducedMotion = vi.fn(() => false);
vi.mock('../../lib/use-reduced-motion', () => ({
  usePrefersReducedMotion: () => mockUsePrefersReducedMotion(),
}));

import { TopologyLegend } from '../TopologyLegend';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SINGLE_NAMESPACE = [{ namespace: 'default', color: '#3b82f6' }];
const MULTI_NAMESPACE = [
  { namespace: 'production', color: '#22c55e' },
  { namespace: 'staging', color: '#f59e0b' },
];

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

describe('TopologyLegend', () => {
  describe('rendering', () => {
    it('renders the legend panel at bottom-left', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByTestId('panel-bottom-left')).toBeInTheDocument();
    });

    it('renders allow rule entry', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Allow rule (data flow)')).toBeInTheDocument();
    });

    it('renders deny rule entry', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Deny rule')).toBeInTheDocument();
    });

    it('renders health status entries', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Inactive')).toBeInTheDocument();
      expect(screen.getByText('Stale')).toBeInTheDocument();
    });

    it('renders Relay and Pulse indicator entries', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Relay-enabled')).toBeInTheDocument();
      expect(screen.getByText('Pulse schedules')).toBeInTheDocument();
    });

    it('renders zoom hint text', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Zoom in for more detail')).toBeInTheDocument();
    });
  });

  describe('namespace colors', () => {
    it('does not render namespace colors for single namespace', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.queryByText('default')).not.toBeInTheDocument();
    });

    it('renders namespace colors for multiple namespaces', () => {
      render(<TopologyLegend namespaces={MULTI_NAMESPACE} />);
      expect(screen.getByText('production')).toBeInTheDocument();
      expect(screen.getByText('staging')).toBeInTheDocument();
    });
  });

  describe('reduced motion', () => {
    it('shows animate-ping on active agent legend entry when reduced motion is not preferred', () => {
      const { container } = render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).toBeInTheDocument();
    });

    it('hides animate-ping on active agent legend entry when reduced motion is preferred', () => {
      mockUsePrefersReducedMotion.mockReturnValue(true);
      const { container } = render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      const pingElement = container.querySelector('.animate-ping');
      expect(pingElement).not.toBeInTheDocument();
    });
  });

  describe('design tokens', () => {
    it('uses var(--color-primary) for allow rule line', () => {
      const { container } = render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      const primaryLines = container.querySelectorAll('line[stroke="var(--color-primary)"]');
      expect(primaryLines.length).toBeGreaterThan(0);
    });

    it('uses var(--color-destructive) for deny rule line', () => {
      const { container } = render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      const destructiveLines = container.querySelectorAll('line[stroke="var(--color-destructive)"]');
      expect(destructiveLines.length).toBeGreaterThan(0);
    });
  });
});
