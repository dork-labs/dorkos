/**
 * `heartbeat_status` (spec `heartbeats` §10 PR 6): any agent reads any agent's
 * heartbeat, summaries only. It never hands an agent the words of a held
 * message or which chat a beat ran in, and a stranger's turn reads nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../../core/capabilities/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { heartbeatDomain } from '../../heartbeat-capabilities.js';
import { computeMeasures } from '../measures.js';
import { setHeartbeatStatusReader } from '../status-capability.js';

const deps = { logger: noopLogger } as unknown as CapabilityDeps;

const juno = {
  agentPath: '/agents/juno',
  displayName: 'Juno',
  createdAt: '2026-10-10T09:00:00.000Z',
} as AgentIdentity;

const MEASURES = computeMeasures(
  'agent-otto',
  {
    beats: [],
    deliveries: [],
    answers: new Map(),
    audit: [],
    agentActions: [],
    dmRoomIds: [],
    commitments: [],
  },
  { agentPath: '/agents/otto', isAgent: () => false, windowDays: 7, since: 'x', now: 0 }
);

/** A status as the route builds it for the owner: held words and chat ids included. */
function statusOf(beats: number): HeartbeatStatus {
  return {
    enabled: true,
    wake: 'timed',
    nextBeatAt: '2026-10-12T15:00:00Z',
    skippedReason: null,
    fileError: null,
    lastBeats: Array.from({ length: beats }, (_, i) => ({
      id: `b${i}`,
      startedAt: `2026-10-12T14:${String(i).padStart(2, '0')}:00Z`,
      endedAt: null,
      kind: 'pulse',
      wake: 'timer',
      outcome: 'worked',
      summary: `Beat ${i}.`,
      raises: 0,
      sessionId: `chat-secret-${i}`,
    })),
    held: [
      {
        id: 'h1',
        to: 'acct-owner',
        rung: 'dm',
        text: 'The private words of a held message.',
        deliverAfter: '2026-10-13T13:00:00Z',
        createdAt: '2026-10-12T23:00:00Z',
      },
    ],
    report: { cadence: 'daily', to: 'acct-owner', nextReportAt: null, items: 2 },
    checks: { runsOn: 'runtime', runtime: 'claude-code', today: 0, tokens: 0, offer: false },
    measures: MEASURES,
  };
}

const capability = heartbeatDomain.capabilities.find((c) => c.id === 'heartbeat.status')!;

/** Parse and invoke the way the registry does. */
async function call(input: Record<string, unknown>, context: Partial<CapabilityHandlerContext>) {
  return (await capability.invoke(
    deps,
    capability.input.parse(input),
    context as CapabilityHandlerContext
  )) as Record<string, unknown>;
}

const status = vi.fn(async (agentId: string, _days: number) =>
  agentId === 'agent-otto' || agentId === 'agent-juno' ? statusOf(30) : undefined
);

/** Teach the capability to read the fake status. */
function install(): void {
  setHeartbeatStatusReader({
    status,
    agentIdForPath: (path) => (path === juno.agentPath ? 'agent-juno' : undefined),
  });
}

afterEach(() => {
  setHeartbeatStatusReader(undefined);
  status.mockClear();
});

describe('heartbeat_status', () => {
  it('is an observe capability in no permission area, on both MCP servers', () => {
    expect(capability.tier).toBe('observe');
    expect(capability.area).toBeNull();
    expect(capability.surfaces.mcp).toMatchObject({
      toolName: 'heartbeat_status',
      servers: ['in-session', 'external'],
    });
  });

  it("lets one agent read another's: summaries, a held count and the measures", async () => {
    install();
    const result = await call({ agentId: 'agent-otto', days: 14 }, { identity: juno });
    expect(status).toHaveBeenCalledWith('agent-otto', 14);
    expect(result).toMatchObject({ ok: true, agentId: 'agent-otto', held: 1, measures: MEASURES });
    const text = JSON.stringify(result);
    expect(text).not.toContain('chat-secret');
    expect(text).not.toContain('private words');
    expect(result.lastBeats).toHaveLength(10);
    expect((result.lastBeats as object[])[0]).toEqual({
      startedAt: '2026-10-12T14:00:00Z',
      kind: 'pulse',
      wake: 'timer',
      outcome: 'worked',
      summary: 'Beat 0.',
      raises: 0,
    });
  });

  it('reads the calling agent by default, over 7 days, and lists up to 50 beats', async () => {
    install();
    const result = await call({ beats: 50 }, { identity: juno });
    expect(status).toHaveBeenCalledWith('agent-juno', 7);
    expect(result.lastBeats).toHaveLength(30);
  });

  it('refuses plainly when it cannot answer', async () => {
    expect(await call({ agentId: 'agent-otto' }, {})).toMatchObject({ code: 'NOT_RUNNING' });
    install();
    expect(await call({}, {})).toMatchObject({ ok: false, code: 'NO_AGENT' });
    expect(await call({ agentId: 'agent-nobody' }, {})).toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
  });

  it("reads nothing on a turn a stranger started, before it reads anyone's record", async () => {
    install();
    const result = await call(
      { agentId: 'agent-otto' },
      { identity: juno, turnStartedByOutsider: true }
    );
    expect(result).toMatchObject({ ok: false, code: 'OUTSIDER_TURN' });
    expect(status).not.toHaveBeenCalled();
  });
});
