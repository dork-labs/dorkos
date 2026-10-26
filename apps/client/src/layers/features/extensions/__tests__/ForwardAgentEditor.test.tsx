/**
 * @vitest-environment jsdom
 */
/**
 * "Forwards your comments to" on a mini app's Settings card (DOR-3325): what
 * it says for none, for a picked agent, and for one that is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

let mockChoice: {
  agent: { id: string; name: string } | null;
  missingAgentId?: string | null;
} = { agent: null };

vi.mock('../api/forward-agent', () => ({
  useForwardAgent: () => ({ data: mockChoice }),
  useSetForwardAgent: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({
    data: { agents: [{ id: 'pm', name: 'dorkos-pm', displayName: 'DorkOS PM' }] },
  }),
}));

import { ForwardAgentEditor } from '../ui/ForwardAgentEditor';

beforeEach(() => {
  mockChoice = { agent: null };
});

afterEach(cleanup);

describe('ForwardAgentEditor', () => {
  it('says it forwards nothing while no agent is picked', () => {
    render(<ForwardAgentEditor extensionId="dorian-desk" name="Dorian Desk" />);
    expect(screen.getByText('None yet. It can’t send your comments anywhere.')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Agent Dorian Desk forwards to' })
    ).toHaveTextContent('Nobody');
  });

  it('shows the picked agent and what forwarding means', () => {
    mockChoice = { agent: { id: 'pm', name: 'DorkOS PM' } };
    render(<ForwardAgentEditor extensionId="dorian-desk" name="Dorian Desk" />);
    expect(screen.getByRole('combobox')).toHaveTextContent('DorkOS PM');
    expect(
      screen.getByText('Your comments reach this agent as your own words.')
    ).toBeInTheDocument();
  });

  it('says so when the picked agent is gone', () => {
    mockChoice = { agent: null, missingAgentId: 'old' };
    render(<ForwardAgentEditor extensionId="dorian-desk" name="Dorian Desk" />);
    expect(
      screen.getByText('The agent it forwarded to is gone. Pick another.')
    ).toBeInTheDocument();
  });
});
