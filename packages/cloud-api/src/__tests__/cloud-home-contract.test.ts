/**
 * What the account directory holds, what wakes a person's DorkOS in the cloud,
 * and whether that DorkOS is the home of the private space.
 *
 * The rules pinned here are the ones a later change could widen quietly: a
 * report names the computer and its spaces and nothing else, it never carries
 * agents, its `reach` says only whether the computer offers its own page, a
 * wake a computer asks for carries nothing back, and the home-or-way-in flag
 * is optional so an older service still parses.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DirectoryReachLevelSchema,
  DirectoryReportReachSchema,
  DirectoryReportRequestSchema,
  HUB_WAKE_REQUEST_MAX_PER_HOUR,
  HUB_WAKE_REQUEST_MIN_INTERVAL_SECONDS,
  HubAssignmentSchema,
  HubWakeResponseSchema,
  ProblemSchema,
  V1_ROUTES,
} from '../index.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/** Read one fixture as a plain object. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

describe('a directory report', () => {
  it('names the computer, its reach and its spaces, and holds nothing else of the computer', () => {
    expect(Object.keys(DirectoryReportRequestSchema.shape).sort()).toEqual([
      'agents',
      'reach',
      'reportedAt',
      'spaces',
    ]);
  });

  it('is sent with no agents, and refuses a report that leaves the part out', () => {
    const report = DirectoryReportRequestSchema.parse(fixture('directory/report-request.json'));
    expect(report.agents).toEqual([]);

    // Required, so every report replaces (and so clears) agents stored before.
    const withoutAgents = fixture('directory/report-request.json');
    delete withoutAgents.agents;
    expect(DirectoryReportRequestSchema.safeParse(withoutAgents).success).toBe(false);
  });

  it('still parses a report from before, with agents and `off`, because /v1 only adds', () => {
    const older = {
      reportedAt: '2026-11-03T11:59:58Z',
      agents: [{ agentId: 'agent_0001', name: 'Researcher' }],
      reach: 'off',
    };
    expect(DirectoryReportRequestSchema.safeParse(older).success).toBe(true);
  });

  it('reports a reach of chat or full-control only, each of which an older service accepts', () => {
    expect([...DirectoryReportReachSchema.options].sort()).toEqual(['chat', 'full-control']);
    expect(DirectoryReportReachSchema.safeParse('off').success).toBe(false);
    for (const reach of DirectoryReportReachSchema.options) {
      expect(DirectoryReachLevelSchema.safeParse(reach).success, reach).toBe(true);
    }
  });
});

describe('a computer asking to wake its account`s hub', () => {
  it('is its own fixed route, under the calling instance', () => {
    expect(V1_ROUTES.instancesHubWake).toBe('/v1/instances/hub-wake');
  });

  it('answers only when it was accepted: no address, no hub, nothing the hub holds', () => {
    const accepted = HubWakeResponseSchema.parse({
      ...fixture('hubs/hub-wake.json'),
      address: 'https://hub-0001.example.invalid',
      instanceId: 'inst_0100',
    });
    expect(Object.keys(accepted)).toEqual(['acceptedAt']);
    expect(HubWakeResponseSchema.safeParse({}).success).toBe(false);
  });

  it('publishes its cap for each computer, and refuses past it as rate_limited with a wait', () => {
    expect(HUB_WAKE_REQUEST_MIN_INTERVAL_SECONDS).toBe(60);
    expect(HUB_WAKE_REQUEST_MAX_PER_HOUR).toBe(30);
    const refused = ProblemSchema.parse(fixture('problem/hub-wake-rate-limited.json'));
    expect(refused.code).toBe('rate_limited');
    expect(refused.status).toBe(429);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('home or way in', () => {
  it('reads whether an assigned hub is the home of the private space', () => {
    const home = HubAssignmentSchema.parse(fixture('hubs/assignment-private-space-home.json'));
    expect(home.state === 'assigned' && home.privateSpaceHome).toBe(true);
    const wayIn = HubAssignmentSchema.parse({ ...home, privateSpaceHome: false });
    expect(wayIn.state === 'assigned' && wayIn.privateSpaceHome).toBe(false);
  });

  it('parses an assignment from an older service with no value, which records nothing', () => {
    const older = HubAssignmentSchema.parse(fixture('hubs/assignment.json'));
    expect(older.state === 'assigned' && 'privateSpaceHome' in older).toBe(false);
  });

  it('refuses a value that is not a boolean, so a string never reads as true', () => {
    const home = fixture('hubs/assignment-private-space-home.json');
    expect(HubAssignmentSchema.safeParse({ ...home, privateSpaceHome: 'true' }).success).toBe(
      false
    );
  });
});
