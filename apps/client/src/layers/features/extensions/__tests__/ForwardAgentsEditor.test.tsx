/**
 * @vitest-environment jsdom
 */
/**
 * "Sends your comments to" on a mini app's Settings card (DOR-3325). Every
 * change is written as the whole list of ids, so the assertions read the list
 * it was handed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

let mockChoice: { agents: Array<{ id: string; name: string }>; missing: string[] } = {
  agents: [],
  missing: [],
};
const mockMutate = vi.fn();

vi.mock('../api/forward-agents', () => ({
  useForwardAgents: () => ({ data: mockChoice }),
  useSetForwardAgents: () => ({ mutate: mockMutate }),
}));
vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({
    data: {
      agents: [
        { id: 'pm', name: 'dorkos-pm', displayName: 'DorkOS PM' },
        { id: 'qa', name: 'dorkos-qa', displayName: 'DorkOS QA' },
      ],
    },
  }),
}));

import { ForwardAgentsEditor } from '../ui/ForwardAgentsEditor';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  mockChoice = { agents: [], missing: [] };
  mockMutate.mockReset();
});

afterEach(cleanup);

describe('ForwardAgentsEditor', () => {
  it('says it asks the first time while none is allowed', () => {
    render(<ForwardAgentsEditor extensionId="desk" name="Dorian Desk" />);
    expect(
      screen.getByText('None yet. It asks you the first time you send a comment.')
    ).toBeInTheDocument();
  });

  it('adds an agent by id', () => {
    render(<ForwardAgentsEditor extensionId="desk" name="Dorian Desk" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent for Dorian Desk' }));
    fireEvent.click(screen.getByText('DorkOS PM'));
    expect(mockMutate).toHaveBeenCalledWith(['pm'], expect.anything());
  });

  it('removes an agent, and offers to remove one that is gone', () => {
    mockChoice = { agents: [{ id: 'pm', name: 'DorkOS PM' }], missing: ['old'] };
    render(<ForwardAgentsEditor extensionId="desk" name="Dorian Desk" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove An agent that is gone' }));
    expect(mockMutate).toHaveBeenCalledWith(['pm'], expect.anything());
  });
});
