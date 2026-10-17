/**
 * Mocks for the community-connection slice of `Transport` (connecting this install to a space,
 * its saved navigation, and the owner's teammate settings there), split out of
 * `mock-factories.ts`. Nothing is connected, nothing is remembered, anyone in a space may wake
 * the owner's agents and there is no monthly limit, so a test arranges only what it is about.
 *
 * @module test-utils/mock-community-connections
 */
import { vi } from 'vitest';
import type { CommunityConnectionTransport } from '@dorkos/shared/community-connections';

/** Mocks for every method of {@link CommunityConnectionTransport}. */
export function communityConnectionTransportMocks(): CommunityConnectionTransport {
  return {
    listCommunityConnections: vi.fn().mockResolvedValue([]),
    getCommunityWakeAgentsFrom: vi.fn().mockResolvedValue({ wakeAgentsFrom: 'members' }),
    setCommunityWakeAgentsFrom: vi.fn(async (_ref: string, wakeAgentsFrom: 'me' | 'members') => ({
      wakeAgentsFrom,
    })),
    getCommunityTeammateSpend: vi.fn().mockResolvedValue({
      monthlyLimitUsd: null,
      spentUsd: 0,
      approximate: false,
      month: '2026-10',
    }),
    setCommunityTeammateSpendLimit: vi.fn(async (_ref: string, monthlyLimitUsd: number | null) => ({
      monthlyLimitUsd,
      spentUsd: 0,
      approximate: false,
      month: '2026-10',
    })),
    startCommunityConnection: vi.fn(),
    getCommunityConnection: vi.fn(),
    pollCommunityConnection: vi.fn(),
    cancelCommunityConnection: vi.fn().mockResolvedValue(undefined),
    disconnectCommunity: vi.fn().mockResolvedValue({ remoteRevoked: true, agentsNotRemoved: [] }),
    getCommunityDisconnectImpact: vi.fn().mockResolvedValue({ agents: [] }),
    getCommunityNavigation: vi
      .fn()
      .mockResolvedValue({ ownerKey: 'local-owner', order: [], destinations: [] }),
    moveCommunityNavigation: vi
      .fn()
      .mockResolvedValue({ ownerKey: 'local-owner', order: [], destinations: [] }),
    rememberCommunityNavigation: vi
      .fn()
      .mockResolvedValue({ ownerKey: 'local-owner', order: [], destinations: [] }),
    rememberCommunityInstallationDestination: vi.fn().mockResolvedValue({
      ownerKey: 'local-owner',
      installationDestination: { path: '/', search: {} },
      order: [],
      destinations: [],
    }),
    resolveCommunityNavigation: vi.fn().mockResolvedValue(null),
  };
}
