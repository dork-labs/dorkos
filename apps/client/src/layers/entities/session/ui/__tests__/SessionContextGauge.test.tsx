/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createMockSession } from '@dorkos/test-utils';
import type { SessionContextHealth } from '../../model/use-session-context-health';
import { SessionContextGauge } from '../SessionContextGauge';

// Drive the gauge directly by mocking its merge hook — this isolates the three
// honest render states from the store/catalog resolution (covered by the hook's
// own tests).
const mockHealth = vi.fn<() => SessionContextHealth>();
vi.mock('../../model/use-session-context-health', () => ({
  useSessionContextHealth: () => mockHealth(),
}));

// Render the tooltip content inline so its copy is assertable without hover.
vi.mock('@/layers/shared/ui', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

const session = createMockSession({ id: 's1' });

describe('SessionContextGauge', () => {
  beforeEach(() => {
    cleanup();
    mockHealth.mockReset();
  });

  it('renders a known warning reading with the amber treatment and its percent', () => {
    // Purpose: an ≥80% reading must read amber (ContextItem's vocabulary) and
    // show the compact percent.
    mockHealth.mockReturnValue({
      status: 'known',
      percent: 85,
      severity: 'warning',
      fresh: true,
      asOf: '2026-07-17T09:00:00.000Z',
    });
    render(<SessionContextGauge session={session} />);

    const gauge = screen.getByLabelText('Context 85% full');
    expect(gauge.className).toContain('text-amber-500');
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('renders a known critical reading with the red treatment', () => {
    // Purpose: an ≥95% reading must read red.
    mockHealth.mockReturnValue({
      status: 'known',
      percent: 96,
      severity: 'critical',
      fresh: true,
      asOf: '2026-07-17T09:00:00.000Z',
    });
    render(<SessionContextGauge session={session} />);

    const gauge = screen.getByLabelText('Context 96% full');
    expect(gauge.className).toContain('text-red-500');
  });

  it('adds an "as of" staleness line for a not-fresh (list) reading', () => {
    // Purpose: a list-derived reading discloses its age; a live one does not.
    mockHealth.mockReturnValue({
      status: 'known',
      percent: 40,
      severity: 'ok',
      fresh: false,
      asOf: '2020-01-01T00:00:00.000Z',
    });
    render(<SessionContextGauge session={session} />);

    expect(screen.getByText(/^as of .+\.$/)).toBeInTheDocument();
  });

  it('renders a muted unknown glyph with the honest tooltip copy and no number', () => {
    // Purpose: an unknown row reads deliberate, not broken — a muted glyph, the
    // "open it" copy, and never a fabricated 0%.
    mockHealth.mockReturnValue({
      status: 'unknown',
      fresh: false,
      asOf: '2026-07-17T09:00:00.000Z',
    });
    render(<SessionContextGauge session={session} />);

    expect(screen.getByLabelText('Context usage unknown')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Context usage isn't available for this session yet. Open it to see live usage."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('renders the auto-compacted marker + tooltip, even on an unknown row', () => {
    // Purpose: the marker rides an unknown-percent row (the marker and the
    // percent state are independent signals).
    mockHealth.mockReturnValue({
      status: 'unknown',
      autoCompactedAt: '2026-07-17T08:30:00.000Z',
      fresh: false,
      asOf: '2026-07-17T09:00:00.000Z',
    });
    render(<SessionContextGauge session={session} />);

    expect(screen.getByLabelText('Auto-compacted')).toBeInTheDocument();
    expect(screen.getByText(/^Auto-compacted .+ to free up context\.$/)).toBeInTheDocument();
  });

  it('does not steal the row click — a click on the gauge bubbles to the row', () => {
    // Purpose: the gauge is presentational within the role="button" row; it must
    // not stop propagation, so tapping it still selects the session.
    mockHealth.mockReturnValue({
      status: 'known',
      percent: 50,
      severity: 'ok',
      fresh: true,
      asOf: '2026-07-17T09:00:00.000Z',
    });
    const onRowClick = vi.fn();
    render(
      <div role="button" tabIndex={0} onClick={onRowClick}>
        <SessionContextGauge session={session} />
      </div>
    );

    fireEvent.click(screen.getByLabelText('Context 50% full'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});
