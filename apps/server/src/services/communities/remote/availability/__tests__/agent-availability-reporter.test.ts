import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommunityWireAgentAvailabilityReport,
  CommunityWireAgentAvailabilityReportResponse,
} from '@dorkos/shared/community-wire';
import { PinnedHttpError } from '../../pinned-origin.js';
import {
  AgentAvailabilityReporter,
  BASE_BACKOFF_MS,
  REFUSED_FOR_MS,
  REPORT_SECONDS_BOUNDS,
  type AgentAvailabilityReporterDeps,
} from '../agent-availability-reporter.js';
import type { ReportableAgent } from '../agent-availability-report.js';

/** With `random` at 0.5 every jitter is exactly zero, and the first report is at 6 s. */
const FIRST_MS = 6_000;

type Answer = Partial<CommunityWireAgentAvailabilityReportResponse> | Error;

function fakeSpace(options: { feature?: boolean; answers?: Answer[] } = {}) {
  const sent: CommunityWireAgentAvailabilityReport[] = [];
  let feature = options.feature ?? true;
  const answers = [...(options.answers ?? [])];
  return {
    sent,
    setFeature: (value: boolean) => (feature = value),
    space: {
      supportsAgentAvailability: vi.fn(async () => feature),
      reportAgentAvailability: vi.fn(async (report: CommunityWireAgentAvailabilityReport) => {
        sent.push(report);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return {
          accepted: report.agents.map((agent) => agent.agentId),
          refused: [],
          reportEverySeconds: 120,
          ...answer,
        };
      }),
    },
  };
}

function reporter(
  space: AgentAvailabilityReporterDeps['space'],
  agents: () => readonly ReportableAgent[],
  extra: Partial<AgentAvailabilityReporterDeps> = {}
) {
  return new AgentAvailabilityReporter({
    space,
    agents,
    runsOn: () => 'computer',
    reachable: () => true,
    random: () => 0.5,
    now: () => Date.now(),
    ...extra,
  });
}

const one = [{ agentId: 'agent-1', localAgentId: 'local-1' }];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentAvailabilityReporter', () => {
  it('reports soon after start, then on the interval the space asks for', async () => {
    const fake = fakeSpace({ answers: [{ reportEverySeconds: 60 }, {}] });
    const unit = reporter(fake.space, () => one);
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS - 1);
    expect(fake.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent).toEqual([{ agents: [{ agentId: 'agent-1', runsOn: 'computer' }] }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.sent).toHaveLength(2);
    // The second answer said 120, the default.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(fake.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sent).toHaveLength(3);
    unit.dispose();
  });

  it('spreads each wait so many apps do not report in step', async () => {
    const early = fakeSpace();
    const late = fakeSpace();
    reporter(early.space, () => one, { random: () => 0 }).start();
    reporter(late.space, () => one, { random: () => 0.999 }).start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(early.sent).toHaveLength(1);
    expect(late.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(late.sent).toHaveLength(1);
    // Early's next is at 2 s + 108 s; late's at 10 s + ~132 s.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(early.sent).toHaveLength(2);
    expect(late.sent).toHaveLength(1);
    vi.clearAllTimers();
  });

  it('holds a space asking for a tiny interval to the floor', async () => {
    const fake = fakeSpace({ answers: [{ reportEverySeconds: 1 }] });
    const unit = reporter(fake.space, () => one);
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    await vi.advanceTimersByTimeAsync(REPORT_SECONDS_BOUNDS.min * 1_000 - 1);
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent).toHaveLength(2);
    unit.dispose();
  });

  it('never reports to a space without the feature', async () => {
    const fake = fakeSpace({ feature: false });
    const unit = reporter(fake.space, () => one);
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS + 10 * 120_000);
    expect(fake.space.reportAgentAvailability).not.toHaveBeenCalled();
    // It keeps asking, on the report beat, so a space that upgrades is picked up.
    expect(fake.space.supportsAgentAvailability.mock.calls.length).toBeGreaterThan(5);
    fake.setFeature(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.sent).toHaveLength(1);
    unit.dispose();
  });

  it('drops an agent from the very next report once it is removed', async () => {
    let agents: ReportableAgent[] = [
      { agentId: 'agent-1', localAgentId: 'local-1' },
      { agentId: 'agent-2', localAgentId: 'local-2' },
    ];
    const fake = fakeSpace();
    const unit = reporter(fake.space, () => agents);
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(fake.sent[0]!.agents.map((agent) => agent.agentId)).toEqual(['agent-1', 'agent-2']);
    agents = [{ agentId: 'agent-2', localAgentId: 'local-2' }];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.sent[1]!.agents.map((agent) => agent.agentId)).toEqual(['agent-2']);
    // With none left, nothing is sent at all.
    agents = [];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.sent).toHaveLength(2);
    unit.dispose();
  });

  it('stops naming a refused agent for a while, without treating it as a failure', async () => {
    const onFailing = vi.fn();
    const fake = fakeSpace({ answers: [{ refused: ['agent-2'] }] });
    const unit = reporter(
      fake.space,
      () => [
        { agentId: 'agent-1', localAgentId: 'local-1' },
        { agentId: 'agent-2', localAgentId: 'local-2' },
      ],
      { onFailing }
    );
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS + 120_000);
    expect(fake.sent[1]!.agents.map((agent) => agent.agentId)).toEqual(['agent-1']);
    await vi.advanceTimersByTimeAsync(REFUSED_FOR_MS);
    expect(fake.sent.at(-1)!.agents.map((agent) => agent.agentId)).toEqual(['agent-1', 'agent-2']);
    expect(onFailing).not.toHaveBeenCalled();
    unit.dispose();
  });

  it('backs off on failure, says so once, and returns to the beat after a success', async () => {
    const onFailing = vi.fn();
    const fake = fakeSpace({
      answers: [new PinnedHttpError(503), new Error('ECONNRESET'), new PinnedHttpError(401)],
    });
    const unit = reporter(fake.space, () => one, { onFailing });
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BASE_BACKOFF_MS);
    expect(fake.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * BASE_BACKOFF_MS - 1);
    expect(fake.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4 * BASE_BACKOFF_MS);
    expect(fake.sent).toHaveLength(4);
    expect(onFailing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.sent).toHaveLength(5);
    unit.dispose();
  });

  it('waits as long as a space asks with Retry-After', async () => {
    const fake = fakeSpace({ answers: [new PinnedHttpError(429, 'RATE_LIMITED', 300)] });
    const unit = reporter(fake.space, () => one);
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS + 299_000);
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sent).toHaveLength(2);
    unit.dispose();
  });

  it('reads a 404 to a report as an old space, not a failure', async () => {
    const onFailing = vi.fn();
    const fake = fakeSpace({ answers: [new PinnedHttpError(404)] });
    const unit = reporter(fake.space, () => one, { onFailing });
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS + 120_000);
    expect(onFailing).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(2);
    unit.dispose();
  });

  it('does not report to a space that may not be reached now', async () => {
    const fake = fakeSpace();
    const unit = reporter(fake.space, () => one, { reachable: () => false });
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS + 5 * 120_000);
    expect(fake.space.supportsAgentAvailability).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(0);
    unit.dispose();
  });

  it('clears its timer on dispose, and never reports again', async () => {
    const fake = fakeSpace();
    const unit = reporter(fake.space, () => one);
    unit.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(vi.getTimerCount()).toBe(1);
    unit.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(unit.scheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 120_000);
    expect(fake.sent).toHaveLength(1);
    unit.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a report in flight on dispose and schedules nothing after it', async () => {
    let release: (() => void) | undefined;
    const signals: AbortSignal[] = [];
    const unit = reporter(
      {
        supportsAgentAvailability: async () => true,
        reportAgentAvailability: (_report, signal) => {
          if (signal) signals.push(signal);
          return new Promise((_resolve, reject) => {
            release = () => reject(new Error('aborted'));
          });
        },
      },
      () => one
    );
    unit.start();
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(signals).toHaveLength(1);
    unit.dispose();
    expect(signals[0]!.aborted).toBe(true);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
