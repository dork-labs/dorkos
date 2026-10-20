import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS,
  COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS,
  COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS,
  CommunityWireAgentAvailabilityReportResponseSchema,
  CommunityWireAgentAvailabilityReportSchema,
  CommunityWireChannelMembersQuerySchema,
  CommunityWireMemberSchema,
  CommunityWireSpaceFeaturesResponseSchema,
  communityAgentAvailability,
} from '../community-wire.js';

// Agent availability on the wire (specs/server-merge D4, DOR-2877).
const NOW = new Date('2026-10-15T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1_000).toISOString();

describe('communityAgentAvailability', () => {
  it('reads available up to three report intervals, then offline', () => {
    // Purpose: fails if one late report shows an agent offline, or a stopped one never does.
    expect(COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS).toBe(
      3 * COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS
    );
    expect(
      communityAgentAvailability(ago(COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS * 2), NOW)
    ).toBe('available');
    expect(communityAgentAvailability(ago(COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS), NOW)).toBe(
      'available'
    );
    expect(communityAgentAvailability(ago(COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS + 1), NOW)).toBe(
      'offline'
    );
  });

  it('reads unknown, never offline, when no app ever reported', () => {
    // Purpose: fails if an agent of an app from before reports shows as offline.
    expect(communityAgentAvailability(null, NOW)).toBe('unknown');
  });
});

describe('the availability report', () => {
  const agentId = '7b0c6a43-9d1e-4f5a-8b2c-1d3e4f5a6b7c';

  it('carries which agents and where they run, and nothing more', () => {
    // Purpose: fails if a report could carry a name, a runtime or a model.
    expect(
      CommunityWireAgentAvailabilityReportSchema.safeParse({
        agents: [{ agentId, runsOn: 'computer' }],
      }).success
    ).toBe(true);
    expect(
      CommunityWireAgentAvailabilityReportSchema.safeParse({
        agents: [{ agentId, runsOn: 'computer', displayName: 'Scout' }],
      }).success
    ).toBe(false);
    expect(
      CommunityWireAgentAvailabilityReportSchema.safeParse({ agents: [], runtime: 'x' }).success
    ).toBe(false);
    expect(
      CommunityWireAgentAvailabilityReportSchema.safeParse({
        agents: [{ agentId, runsOn: 'phone' }],
      }).success
    ).toBe(false);
  });

  it('names each agent once, and at most the highest agent limit', () => {
    // Purpose: fails if a report can repeat an agent or grow without bound.
    expect(
      CommunityWireAgentAvailabilityReportSchema.safeParse({
        agents: [
          { agentId, runsOn: 'computer' },
          { agentId, runsOn: 'agent-computer' },
        ],
      }).success
    ).toBe(false);
    const many = Array.from(
      { length: COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS + 1 },
      (_, i) => ({
        agentId: `agent-${i}`,
        runsOn: 'computer',
      })
    );
    expect(CommunityWireAgentAvailabilityReportSchema.safeParse({ agents: many }).success).toBe(
      false
    );
  });
});

describe('reading across versions', () => {
  it('reads a later space’s report answer and features with fields it does not know', () => {
    // Purpose: fails if these new responses are made strict, so an app built now would reject a
    // later space's answer the way older apps would reject new member fields.
    expect(
      CommunityWireAgentAvailabilityReportResponseSchema.parse({
        accepted: [],
        refused: [],
        reportEverySeconds: 120,
        later: true,
      })
    ).toEqual({ accepted: [], refused: [], reportEverySeconds: 120 });
    expect(
      CommunityWireSpaceFeaturesResponseSchema.parse({
        features: { agentAvailability: true, laterFeature: true },
      })
    ).toEqual({ features: { agentAvailability: true } });
  });

  it('reads a member row from a space with or without availability', () => {
    // Purpose: fails if the new member fields become required, so a new app would reject an
    // older space's member list.
    const row = {
      memberId: 'a-1',
      kind: 'agent',
      displayName: 'Scout',
      handle: 'scout',
      role: null,
      ownerMemberId: 'm-1',
      joinedAt: NOW.toISOString(),
    };
    expect(CommunityWireMemberSchema.safeParse(row).success).toBe(true);
    expect(
      CommunityWireMemberSchema.safeParse({
        ...row,
        runsOn: 'computer',
        lastSeenAt: NOW.toISOString(),
        availability: 'available',
      }).success
    ).toBe(true);
  });

  it('asks for availability among extras it may not know', () => {
    // Purpose: fails if an unknown extra in `include` stops availability being read.
    expect(
      CommunityWireChannelMembersQuerySchema.parse({ include: 'later,availability' }).include.has(
        'availability'
      )
    ).toBe(true);
    expect(CommunityWireChannelMembersQuerySchema.parse({}).include.size).toBe(0);
  });
});
