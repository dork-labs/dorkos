/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentFleetTable } from '../ui/AgentFleetTable';
import type { AgentTableRow } from '../lib/agent-columns';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

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

function row(overrides: Partial<AgentTableRow> & { id: string; name: string }): AgentTableRow {
  return {
    workspace: { mode: 'home' },
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date(Date.now() - 60 * 60 * 24 * 30 * 1000).toISOString(),
    registeredBy: 'user',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    projectPath: `/Users/kai/code/${overrides.name}`,
    healthStatus: 'active',
    relayAdapters: [],
    relaySubject: null,
    taskCount: 0,
    lastSeenAt: new Date().toISOString(),
    lastSeenEvent: 'response_complete',
    chatState: 'inactive',
    isPastOnboardingGrace: true,
    isDefault: false,
    managedBy: null,
    ...overrides,
  };
}

const callbacks = { onNavigate: vi.fn(), onViewProfile: vi.fn(), onStartSession: vi.fn() };

function renderTable(rows: AgentTableRow[]) {
  return render(<AgentFleetTable rows={rows} grouped={false} callbacks={callbacks} />);
}

/** What each row's Managed by cell says, top to bottom. */
function managedByCells(): string[] {
  return [...document.querySelectorAll('[data-slot="agent-managed-by"]')].map(
    (cell) => cell.textContent ?? ''
  );
}

describe('the fleet table', () => {
  it('has a Managed by column', () => {
    renderTable([row({ id: '1', name: 'scout' })]);
    expect(screen.getByRole('columnheader', { name: 'Managed by' })).toBeInTheDocument();
  });

  it('names the person an agent belongs to', () => {
    renderTable([row({ id: '1', name: 'scout', managedBy: '@dorian' })]);

    // Read out of the attribution cell itself. An unscoped text match would
    // also pass if the label leaked into the identity cell, which is exactly
    // the mistake worth catching.
    expect(managedByCells()).toEqual(['@dorian']);
  });

  it('draws a dash when nothing owns the agent', () => {
    // DorkBot's case: a system agent belongs to the install, not to a person,
    // so the roster gives it no owner and the cell has to say so rather than
    // silently borrowing the operator's name. Scoped, because the Scheduled
    // column draws the same dash for a zero task count.
    renderTable([row({ id: 'dorkbot', name: 'dorkbot', managedBy: null })]);
    expect(managedByCells()).toEqual(['—']);
  });
});
