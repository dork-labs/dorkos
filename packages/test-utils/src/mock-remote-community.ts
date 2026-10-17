/**
 * Mocks for the remote-community slice of `Transport` (a space's channels, its roster, its
 * agents, and the person's own standing, rules, name and reports), split out of
 * `mock-factories.ts`. Reads answer nothing in particular unless a test arranges them; the
 * person's standing is clear, with no rules, so a channel is open to post in.
 *
 * @module test-utils/mock-remote-community
 */
import { vi } from 'vitest';
import type { RemoteCommunityTransport } from '@dorkos/shared/community-views';

/** Mocks for every method of {@link RemoteCommunityTransport}. */
export function remoteCommunityTransportMocks(): RemoteCommunityTransport {
  return {
    listRemoteCommunityRooms: vi.fn(),
    getRemoteCommunityRoom: vi.fn(),
    listRemoteCommunityEntries: vi.fn(),
    postRemoteCommunityEntry: vi.fn(),
    subscribeRemoteCommunityRoom: vi.fn(),
    listRemoteCommunityMembers: vi.fn(),
    joinRemoteCommunityRoom: vi.fn(),
    leaveRemoteCommunityRoom: vi.fn(),
    getRemoteCommunityReadCursor: vi.fn(),
    setRemoteCommunityReadCursor: vi.fn(),
    listRemoteCommunityAgents: vi.fn(),
    enrollRemoteCommunityAgent: vi.fn(),
    ejectRemoteCommunityAgent: vi.fn(),
    joinRemoteCommunityAgentRoom: vi.fn(),
    leaveRemoteCommunityAgentRoom: vi.fn(),
    haltRemoteCommunityRoom: vi.fn().mockResolvedValue({ stopped: 0 }),
    haltRemoteCommunityAgent: vi.fn().mockResolvedValue({ stopped: 0 }),
    retryRemoteCommunityDelivery: vi
      .fn()
      .mockImplementation(async (community, roomId) => ({ community, roomId, deliveries: [] })),
    uploadRemoteCommunityAttachment: vi.fn(),
    downloadRemoteCommunityAttachment: vi.fn(),
    getRemoteCommunityStanding: vi
      .fn()
      .mockImplementation(async (community: string, roomId: string) => ({
        community,
        roomId,
        mutedUntil: null,
        slowModeSeconds: 0,
        rules: { text: null, version: 0, acceptedVersion: 0 },
      })),
    acceptRemoteCommunityRules: vi
      .fn()
      .mockImplementation(async (_community: string, version: number) => ({
        text: 'Be kind.',
        version,
        acceptedVersion: version,
      })),
    setRemoteCommunityDisplayName: vi
      .fn()
      .mockImplementation(async (_community: string, displayName: string) => displayName.trim()),
    reportRemoteCommunityEntry: vi.fn().mockResolvedValue(undefined),
    // Direct messages (DOR-2955): a space that holds none, unless a test says otherwise.
    listRemoteCommunityDms: vi
      .fn()
      .mockImplementation(async (community: string) => ({ community, available: false, dms: [] })),
    startRemoteCommunityDm: vi.fn(),
    setRemoteCommunityAgentDms: vi
      .fn()
      .mockImplementation(async (_community: string, localAgentId: string, accepts: boolean) => ({
        localAgentId,
        acceptsDms: accepts,
      })),
    listRemoteCommunityAgentDmEntries: vi.fn(),
  };
}
