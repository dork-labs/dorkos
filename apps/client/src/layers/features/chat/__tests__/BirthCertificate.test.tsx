// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { useAgentBirthStore } from '@/layers/shared/model';
import { BirthCertificate } from '../ui/BirthCertificate';

const RECORD = {
  name: 'linear-keeper',
  displayName: 'Keeper',
  agentId: 'agent_linear_keeper',
  bornAt: '2026-07-20T00:00:00.000Z',
  path: '/agents/linear-keeper',
  runtime: 'claude-code',
  kickoffMessage: '<dork-kickoff>hi</dork-kickoff>',
};

describe('BirthCertificate', () => {
  beforeEach(() => {
    useAgentBirthStore.setState({ records: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the birth line for the agent’s first (creation-marked) session', () => {
    useAgentBirthStore.getState().register('sess-1', RECORD);
    render(<BirthCertificate sessionId="sess-1" />);

    const line = screen.getByTestId('birth-certificate');
    expect(line).toHaveTextContent('Keeper');
    expect(line).toHaveTextContent('born');
    expect(line).toHaveTextContent('/agents/linear-keeper');
    // Runtime rendered by its human label, not the raw slug.
    expect(line.textContent).toMatch(/runs on/i);
  });

  it('renders nothing for a session without a birth record (never again)', () => {
    useAgentBirthStore.getState().register('sess-1', RECORD);
    render(<BirthCertificate sessionId="other-session" />);
    expect(screen.queryByTestId('birth-certificate')).toBeNull();
  });

  it('renders nothing when there is no active session', () => {
    render(<BirthCertificate sessionId={null} />);
    expect(screen.queryByTestId('birth-certificate')).toBeNull();
  });
});
