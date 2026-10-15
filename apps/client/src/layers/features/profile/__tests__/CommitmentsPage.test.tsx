/**
 * @vitest-environment jsdom
 */
/**
 * The Commitments page (spec `heartbeats` §12): controls on your own agent,
 * facts only on someone else's, like every other row of their profile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { TransportProvider } from '@/layers/shared/model';
import { CommitmentsPage } from '../ui/pages/CommitmentsPage';

afterEach(() => cleanup());

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;
const MANAGED = byId('agent-warden');
const PRIYA: TeamMember = {
  id: 'person-priya',
  kind: 'human',
  displayName: 'Priya',
  handle: 'priya',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  person: { role: null, lastSeenAt: null },
} as TeamMember;
const OTHERS_AGENT: TeamMember = { ...byId('agent-cartographer'), ownerId: PRIYA.id };
const ROSTER = [...MOCK_TEAM_ROSTER, PRIYA, OTHERS_AGENT];

function renderPage(member: TeamMember) {
  const transport = createMockTransport();
  vi.mocked(transport.listCommitments).mockResolvedValue({
    commitments: [
      {
        id: 'c1',
        agentId: member.agent!.manifestId,
        to: null,
        what: 'Ship the fix',
        dueAt: null,
        state: 'open',
        overdue: false,
        sourceSessionId: null,
        sourceRoomEntryId: null,
        createdAt: '2026-10-10T09:00:00.000Z',
        closedAt: null,
        note: null,
      },
    ],
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider transport={transport}>
        <CommitmentsPage member={member} roster={ROSTER} onPush={() => undefined} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('CommitmentsPage', () => {
  it('gives you the controls on an agent you manage', async () => {
    renderPage(MANAGED);
    await screen.findByText('Ship the fix');
    expect(screen.getByRole('button', { name: 'Mark kept: Ship the fix' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add commitment' })).toBeInTheDocument();
  });

  it('shows someone else’s agent’s commitments as facts, with no controls', async () => {
    renderPage(OTHERS_AGENT);
    await screen.findByText('Ship the fix');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
