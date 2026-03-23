/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { MeshStatus } from '@dorkos/shared/mesh-schemas';
import { FleetHealthBar } from '../ui/FleetHealthBar';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const makeStatus = (overrides: Partial<MeshStatus> = {}): MeshStatus => ({
  totalAgents: 11,
  activeCount: 8,
  inactiveCount: 2,
  staleCount: 1,
  unreachableCount: 0,
  byRuntime: {},
  byProject: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('FleetHealthBar', () => {
  let onStatusFilter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onStatusFilter = vi.fn();
  });

  it('renders non-zero counts for each status', () => {
    render(
      <FleetHealthBar status={makeStatus()} activeFilter="all" onStatusFilter={onStatusFilter} />
    );

    // active=8, inactive=2, stale=1 should all be present; unreachable=0 is hidden
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('does not render segments with zero count', () => {
    render(
      <FleetHealthBar
        status={makeStatus({ unreachableCount: 0 })}
        activeFilter="all"
        onStatusFilter={onStatusFilter}
      />
    );

    // "Unreachable" label should not appear
    expect(screen.queryByText('Unreachable')).not.toBeInTheDocument();
  });

  it('calls onStatusFilter with correct status when clicking a segment', () => {
    render(
      <FleetHealthBar status={makeStatus()} activeFilter="all" onStatusFilter={onStatusFilter} />
    );

    // aria-label is "8 Active" — exact match avoids collision with "2 Inactive"
    fireEvent.click(screen.getByRole('button', { name: '8 Active' }));
    expect(onStatusFilter).toHaveBeenCalledWith('active');
  });

  it('toggles off an already-active filter back to "all"', () => {
    render(
      <FleetHealthBar status={makeStatus()} activeFilter="active" onStatusFilter={onStatusFilter} />
    );

    fireEvent.click(screen.getByRole('button', { name: '8 Active' }));
    expect(onStatusFilter).toHaveBeenCalledWith('all');
  });

  it('renders the correct total agent count', () => {
    render(
      <FleetHealthBar
        status={makeStatus({ totalAgents: 11 })}
        activeFilter="all"
        onStatusFilter={onStatusFilter}
      />
    );

    expect(screen.getByText('11 agents')).toBeInTheDocument();
  });

  it('uses singular "agent" for a total of 1', () => {
    render(
      <FleetHealthBar
        status={makeStatus({
          totalAgents: 1,
          activeCount: 1,
          inactiveCount: 0,
          staleCount: 0,
          unreachableCount: 0,
        })}
        activeFilter="all"
        onStatusFilter={onStatusFilter}
      />
    );

    expect(screen.getByText('1 agent')).toBeInTheDocument();
    expect(screen.queryByText('1 agents')).not.toBeInTheDocument();
  });
});
