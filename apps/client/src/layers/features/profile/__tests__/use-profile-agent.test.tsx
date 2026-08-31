/**
 * @vitest-environment jsdom
 *
 * DOR-1114: an agent edit (a rename, a new face, a convention-file change)
 * must refresh every open room's roster, not just `['team']` and the agent's
 * own manifest cache — a room's author row is drawn from its own cached
 * detail query, so leaving `roomKeys.detail` stale left a renamed agent's old
 * name sitting in an idle room's message gutter and mention pills until an
 * unrelated refetch touched it.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '@/layers/entities/room';
import { agentKeys } from '@/layers/entities/agent';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';
import { useProfileAgent } from '../model/use-profile-agent';

const AGENT_MEMBER: TeamMember = {
  id: 'agent-warden',
  kind: 'agent',
  displayName: 'Warden',
  handle: 'warden',
  color: '#6d5ae0',
  emoji: '🛡️',
  isSelf: false,
  ownerId: 'person-dorian',
  origin: 'local',
  agent: {
    manifestId: 'agent-warden',
    runtime: 'claude-code',
    model: 'opus-4.8',
    healthStatus: 'active',
    recentlyActive: false,
    projectPath: '/Users/dorian/agents/warden',
    activity: { working: null, lastActiveAt: null },
    isDefault: false,
    isSystem: false,
    registeredAt: '2026-07-04T14:20:00.000Z',
  },
};

/** A QueryClient plus every key it was asked to invalidate, in call order. */
function recordingWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return original(filters as Parameters<typeof original>[0]);
  }) as typeof queryClient.invalidateQueries;
  return { queryClient, invalidated };
}

afterEach(cleanup);

describe('useProfileAgent', () => {
  it('invalidates the roster, the agent cache, and every open room on save', async () => {
    const transport = createMockTransport();
    const { queryClient, invalidated } = recordingWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useProfileAgent(AGENT_MEMBER), { wrapper });

    await act(async () => {
      result.current.update({ displayName: 'The Warden' });
    });

    await waitFor(() =>
      expect(transport.updateAgentByPath).toHaveBeenCalledWith('/Users/dorian/agents/warden', {
        displayName: 'The Warden',
      })
    );
    expect(invalidated).toContainEqual([...TEAM_ROSTER_KEY]);
    expect(invalidated).toContainEqual(agentKeys.all);
    expect(invalidated).toContainEqual(roomKeys.details());
  });
});
