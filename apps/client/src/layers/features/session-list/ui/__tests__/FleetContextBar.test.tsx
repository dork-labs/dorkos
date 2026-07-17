/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { FleetContextRollup } from '@/layers/entities/session';
import { FleetContextBar } from '../FleetContextBar';

// Drive the bar by mocking the rollup selector — the fold itself is covered by
// useFleetContextRollup's own tests.
const mockRollup = vi.fn<() => FleetContextRollup>();
vi.mock('@/layers/entities/session', () => ({
  useFleetContextRollup: () => mockRollup(),
}));

function rollup(overrides: Partial<FleetContextRollup> = {}): FleetContextRollup {
  return {
    total: 0,
    known: 0,
    unknown: 0,
    warning: 0,
    critical: 0,
    autoCompacted: 0,
    ...overrides,
  };
}

describe('FleetContextBar', () => {
  beforeEach(() => {
    cleanup();
    mockRollup.mockReset();
  });

  it('renders the multi-count row when the fleet is under pressure', () => {
    // Purpose: near-full (warning+critical) and auto-compacted counts render as
    // one plain-language line.
    mockRollup.mockReturnValue(rollup({ known: 5, warning: 1, critical: 1, autoCompacted: 1 }));
    render(<FleetContextBar />);
    expect(screen.getByText('2 near full · 1 auto-compacted')).toBeInTheDocument();
  });

  it('renders "All sessions have room." when known and no pressure', () => {
    // Purpose: a fleet with readings but nothing near full reads reassuringly.
    mockRollup.mockReturnValue(rollup({ known: 4 }));
    render(<FleetContextBar />);
    expect(screen.getByText('All sessions have room.')).toBeInTheDocument();
  });

  it('renders nothing when there is no reading and no pressure', () => {
    // Purpose: nothing to say ⇒ no bar; never a "0 near full" line.
    mockRollup.mockReturnValue(rollup({ total: 3, unknown: 3 }));
    const { container } = render(<FleetContextBar />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('fleet-context-bar')).toBeNull();
  });

  it('drops the zero clause when only one count has pressure', () => {
    // Purpose: a lone near-full total renders without an empty auto-compacted clause.
    mockRollup.mockReturnValue(rollup({ known: 5, warning: 2 }));
    render(<FleetContextBar />);
    expect(screen.getByText('2 near full')).toBeInTheDocument();
    expect(screen.queryByText(/auto-compacted/)).toBeNull();
  });

  it('shows an auto-compacted-only line even with no near-full sessions', () => {
    // Purpose: compaction is its own signal — it shows even when nothing is
    // near full (and even for otherwise-unknown rows).
    mockRollup.mockReturnValue(rollup({ known: 3, autoCompacted: 2 }));
    render(<FleetContextBar />);
    expect(screen.getByText('2 auto-compacted')).toBeInTheDocument();
    expect(screen.queryByText(/near full/)).toBeNull();
  });

  it('marks the status dot aria-hidden', () => {
    // Purpose: the dot is decorative; the count text carries the meaning.
    mockRollup.mockReturnValue(rollup({ known: 5, critical: 1 }));
    render(<FleetContextBar />);
    const bar = screen.getByTestId('fleet-context-bar');
    const dot = bar.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
  });
});
