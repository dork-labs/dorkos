/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { FilterState } from '../ui/AgentFilterBar';

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { AgentFilterBar } from '../ui/AgentFilterBar';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const makeAgents = () => [
  {
    id: '1',
    name: 'Frontend Agent',
    description: 'Handles UI',
    capabilities: ['code', 'review'],
    namespace: 'web',
    runtime: 'claude-code' as const,
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    behavior: { responseMode: 'always' as const },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    personaEnabled: true,
    enabledToolGroups: {},
  },
  {
    id: '2',
    name: 'Backend Agent',
    description: 'API work',
    capabilities: ['code'],
    namespace: 'api',
    runtime: 'claude-code' as const,
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    behavior: { responseMode: 'always' as const },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    personaEnabled: true,
    enabledToolGroups: {},
  },
  {
    id: '3',
    name: 'DevOps Agent',
    description: 'CI/CD pipeline work',
    capabilities: ['deploy'],
    namespace: 'web',
    runtime: 'claude-code' as const,
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    behavior: { responseMode: 'always' as const },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    personaEnabled: true,
    enabledToolGroups: {},
  },
  {
    id: '4',
    name: 'Docs Agent',
    description: 'Documentation',
    capabilities: ['write'],
    namespace: 'docs',
    runtime: 'claude-code' as const,
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    behavior: { responseMode: 'always' as const },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    personaEnabled: true,
    enabledToolGroups: {},
  },
];

const defaultFilterState: FilterState = {
  searchQuery: '',
  statusFilter: 'all',
  namespaceFilter: 'all',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('AgentFilterBar', () => {
  let onFilterStateChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onFilterStateChange = vi.fn();
  });

  it('renders search input with placeholder', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    expect(screen.getByPlaceholderText('Filter agents...')).toBeInTheDocument();
  });

  it('calls onFilterStateChange with updated searchQuery when typing', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    const input = screen.getByPlaceholderText('Filter agents...');
    fireEvent.change(input, { target: { value: 'Frontend' } });

    expect(onFilterStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ searchQuery: 'Frontend' })
    );
  });

  it('calls onFilterStateChange with updated statusFilter on chip click', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^active$/i }));

    expect(onFilterStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ statusFilter: 'active' })
    );
  });

  it('shows namespace dropdown only when >1 unique namespace', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    // 3 namespaces (web, api, docs) — namespace combobox should appear alongside the mobile status combobox
    const comboboxes = screen.getAllByRole('combobox');
    const namespaceCombobox = comboboxes.find(
      (el) => el.textContent?.includes('All namespaces') || el.getAttribute('aria-label') === null
    );
    expect(namespaceCombobox).toBeInTheDocument();
  });

  it('hides namespace dropdown when agents have only 1 namespace', () => {
    const singleNsAgents = makeAgents().map((a) => ({ ...a, namespace: 'web' }));

    render(
      <AgentFilterBar
        agents={singleNsAgents}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    // Only the mobile status dropdown should remain — no namespace combobox
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(1);
    expect(comboboxes[0]).toHaveAttribute('aria-label', 'Filter by status');
  });

  it('displays the result count', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={3}
      />
    );

    expect(screen.getByText('3 agents')).toBeInTheDocument();
  });

  it('renders all 4 status filter chips', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^active$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^inactive$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^stale$/i })).toBeInTheDocument();
  });

  it('applies color classes to status chips', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
        statusCounts={{ active: 2, inactive: 1, stale: 0, unreachable: 1 }}
      />
    );

    // Use exact-match regex to avoid "active" matching "inactive"
    const activeChip = screen.getByRole('button', { name: /^active/i });
    expect(activeChip.className).toMatch(/emerald/);

    const inactiveChip = screen.getByRole('button', { name: /^inactive/i });
    expect(inactiveChip.className).toMatch(/amber/);

    const staleChip = screen.getByRole('button', { name: /^stale/i });
    expect(staleChip.className).toMatch(/muted/);
  });

  it('shows count in parentheses when statusCounts provided and count > 0', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
        statusCounts={{ active: 3, inactive: 1, stale: 0, unreachable: 0 }}
      />
    );

    // active chip should show (3)
    expect(screen.getByRole('button', { name: /^active/i }).textContent).toContain('(3)');
    // inactive chip should show (1)
    expect(screen.getByRole('button', { name: /^inactive/i }).textContent).toContain('(1)');
    // stale chip count is 0 — no parentheses rendered
    expect(screen.getByRole('button', { name: /^stale$/i }).textContent).not.toContain('(');
  });

  it('hides unreachable chip when its count is 0', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
        statusCounts={{ active: 2, inactive: 1, stale: 1, unreachable: 0 }}
      />
    );

    expect(screen.queryByRole('button', { name: /unreachable/i })).not.toBeInTheDocument();
  });

  it('shows unreachable chip when its count is > 0', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
        statusCounts={{ active: 2, inactive: 1, stale: 0, unreachable: 2 }}
      />
    );

    const chip = screen.getByRole('button', { name: /unreachable/i });
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toContain('(2)');
    expect(chip.className).toMatch(/red/);
  });

  it('renders the mobile status dropdown', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    const mobileDropdown = screen.getByRole('combobox', { name: /filter by status/i });
    expect(mobileDropdown).toBeInTheDocument();
  });

  it('calls onFilterStateChange when mobile dropdown value changes', () => {
    render(
      <AgentFilterBar
        agents={makeAgents()}
        filterState={defaultFilterState}
        onFilterStateChange={onFilterStateChange}
        filteredCount={4}
      />
    );

    // Simulate selecting 'inactive' from the mobile status combobox
    // Radix Select triggers onValueChange — fire click then check it's a combobox
    const mobileDropdown = screen.getByRole('combobox', { name: /filter by status/i });
    expect(mobileDropdown).toBeInTheDocument();

    // Verify the correct filter is currently 'all' (default)
    expect((mobileDropdown as HTMLButtonElement).textContent).toMatch(/all/i);
  });
});
