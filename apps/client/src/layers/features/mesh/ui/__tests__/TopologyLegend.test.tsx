/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render as rtlRender, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock @xyflow/react
// ---------------------------------------------------------------------------
vi.mock('@xyflow/react', () => ({
  Panel: ({ children, position }: { children: React.ReactNode; position: string }) => (
    <div data-testid={`panel-${position}`}>{children}</div>
  ),
}));

import { TopologyLegend } from '../TopologyLegend';
import { HEALTH_DISPLAY } from '../../lib/health-display';

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
});

afterEach(cleanup);

/** Render the legend and open it, as a reader does with the Legend button. */
function render(ui: React.ReactElement) {
  const result = rtlRender(ui);
  fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TopologyLegend', () => {
  describe('folding', () => {
    it('starts folded behind a Legend button, and the button opens and closes it', () => {
      rtlRender(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      const button = screen.getByRole('button', { name: 'Legend' });
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Allow rule')).not.toBeInTheDocument();

      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Allow rule')).toBeInTheDocument();

      fireEvent.click(button);
      expect(screen.queryByText('Allow rule')).not.toBeInTheDocument();
    });
  });

  describe('rendering', () => {
    it('renders the legend panel at bottom-left', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByTestId('panel-bottom-left')).toBeInTheDocument();
    });

    it('renders allow rule entry', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Allow rule')).toBeInTheDocument();
    });

    it('renders deny rule entry', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Deny rule')).toBeInTheDocument();
    });

    it('renders every health status entry, unreachable included', () => {
      // Unreachable was missing: the legend explained three colours while the
      // nodes drew four, so the one status that means "this is broken" had no
      // entry telling you what it was.
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Inactive')).toBeInTheDocument();
      expect(screen.getByText('Stale')).toBeInTheDocument();
      expect(screen.getByText('Unreachable')).toBeInTheDocument();
    });

    it('renders Relay and Tasks indicator entries', () => {
      render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(screen.getByText('Can message other agents')).toBeInTheDocument();
      expect(screen.getByText('Scheduled tasks')).toBeInTheDocument();
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

  describe('motion', () => {
    it('animates nothing at all, whatever the reader prefers', () => {
      // The "Active" swatch used to ping. Mesh health is "seen within the last
      // hour", so an animated swatch promised a liveness the colour does not
      // carry — and the legend was the only place in the cockpit teaching that
      // green-and-moving meant health rather than a turn in flight.
      const { container } = render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      expect(container.querySelector('.animate-ping')).not.toBeInTheDocument();
      expect(container.querySelector('[class*="animate-"]')).not.toBeInTheDocument();
    });
  });

  describe('design tokens for health', () => {
    it('draws each swatch from the same map the nodes draw from', () => {
      // A legend with its own colour list is a legend that can describe a
      // colour no node wears — which is exactly what `bg-green-500` here
      // beside a `ring-status-success` there had become.
      const { container } = render(<TopologyLegend namespaces={SINGLE_NAMESPACE} />);
      const classes = container.innerHTML;

      expect(classes).toContain(HEALTH_DISPLAY.active.dot);
      expect(classes).toContain(HEALTH_DISPLAY.inactive.dot);
      expect(classes).toContain(HEALTH_DISPLAY.unreachable.dot);
      expect(classes).not.toContain('bg-green-500');
      expect(classes).not.toContain('bg-amber-500');
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
      const destructiveLines = container.querySelectorAll(
        'line[stroke="var(--color-destructive)"]'
      );
      expect(destructiveLines.length).toBeGreaterThan(0);
    });
  });
});
