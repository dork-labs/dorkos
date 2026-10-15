import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS,
  CommunityWireAgentAvailabilityReportSchema,
} from '@dorkos/shared/community-wire';
import { buildAgentAvailabilityReport } from '../agent-availability-report.js';

const computer = () => 'computer' as const;

describe('buildAgentAvailabilityReport', () => {
  it('names each agent once, by the destination id, in a stable order, with where it runs', () => {
    const report = buildAgentAvailabilityReport(
      [
        { agentId: 'b-remote', localAgentId: 'local-b' },
        { agentId: 'a-remote', localAgentId: 'local-a' },
        { agentId: 'b-remote', localAgentId: 'local-b' },
      ],
      (localAgentId) => (localAgentId === 'local-a' ? 'agent-computer' : 'computer')
    );
    expect(report).toEqual({
      agents: [
        { agentId: 'a-remote', runsOn: 'agent-computer' },
        { agentId: 'b-remote', runsOn: 'computer' },
      ],
    });
    // The space parses it strictly: availability and nothing else.
    expect(CommunityWireAgentAvailabilityReportSchema.parse(report)).toEqual(report);
  });

  it('is null when there is no agent to report, so nothing is sent', () => {
    expect(buildAgentAvailabilityReport([], computer)).toBeNull();
    expect(
      buildAgentAvailabilityReport(
        [{ agentId: 'refused', localAgentId: 'x' }],
        computer,
        new Set(['refused'])
      )
    ).toBeNull();
  });

  it('leaves out the ids it is told to skip', () => {
    const report = buildAgentAvailabilityReport(
      [
        { agentId: 'kept', localAgentId: 'a' },
        { agentId: 'refused', localAgentId: 'b' },
      ],
      computer,
      new Set(['refused'])
    );
    expect(report?.agents.map((agent) => agent.agentId)).toEqual(['kept']);
  });

  it('never names more agents than a space accepts in one report', () => {
    const agents = Array.from(
      { length: COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS + 5 },
      (_, index) => ({
        agentId: `agent-${String(index).padStart(5, '0')}`,
        localAgentId: `l${index}`,
      })
    );
    const report = buildAgentAvailabilityReport(agents, computer);
    expect(report?.agents).toHaveLength(COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS);
    expect(() => CommunityWireAgentAvailabilityReportSchema.parse(report)).not.toThrow();
  });
});
