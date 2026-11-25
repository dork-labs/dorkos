import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS,
  CommunityWireAgentAvailabilityReportSchema,
} from '@dorkos/shared/community-wire';
import { buildAgentAvailabilityReport } from '../agent-availability-report.js';

const computer = () => 'computer' as const;

describe('buildAgentAvailabilityReport', () => {
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
