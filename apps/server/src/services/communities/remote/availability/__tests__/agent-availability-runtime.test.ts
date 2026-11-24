import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type {
  CommunityConnectionAccess,
  CommunityWireAgentAvailabilityReport,
} from '@dorkos/shared/community-wire';
import type { CommunityAgentEnrollment } from '../../agent-enrollment-store.js';
import type {
  RemoteConnectionChange,
  RemoteConnectionChangeListener,
} from '../../connection-changes.js';
import {
  AVAILABILITY_RECONCILE_MS,
  AgentAvailabilityRuntime,
} from '../agent-availability-runtime.js';

const FIRST_MS = 6_000;
const alpha = 'ref-alpha' as CommunityRef;
const beta = 'ref-beta' as CommunityRef;

/** An in-memory stand-in for the enrollment store's two reads. */
function enrollmentsOf(
  rows: Array<
    Pick<
      CommunityAgentEnrollment,
      'communityRef' | 'ownerAuthorId' | 'localAgentId' | 'remoteMemberId'
    >
  >
) {
  const active = rows.map((row) => ({
    ...row,
    state: 'active' as const,
    createdAt: '',
    updatedAt: '',
  }));
  return {
    rows: active,
    activeConnections: () => {
      const seen = new Map<string, { communityRef: CommunityRef; ownerAuthorId: string }>();
      for (const row of active)
        seen.set(`${row.communityRef}:${row.ownerAuthorId}`, {
          communityRef: row.communityRef,
          ownerAuthorId: row.ownerAuthorId,
        });
      return [...seen.values()];
    },
    activeForOwner: (communityRef: CommunityRef, ownerAuthorId: string) =>
      active.filter(
        (row) => row.communityRef === communityRef && row.ownerAuthorId === ownerAuthorId
      ),
  };
}

function spaces() {
  const sent = new Map<string, CommunityWireAgentAvailabilityReport[]>();
  return {
    sent,
    of: (communityRef: CommunityRef, ownerAuthorId: string) => ({
      supportsAgentAvailability: async () => true,
      reportAgentAvailability: async (report: CommunityWireAgentAvailabilityReport) => {
        const key = `${communityRef}:${ownerAuthorId}`;
        sent.set(key, [...(sent.get(key) ?? []), report]);
        return {
          accepted: report.agents.map((agent) => agent.agentId),
          refused: [],
          reportEverySeconds: 120,
        };
      },
    }),
  };
}

function changes() {
  const listeners = new Set<RemoteConnectionChangeListener>();
  return {
    listeners,
    subscribe: (listener: RemoteConnectionChangeListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (change: Pick<RemoteConnectionChange, 'ref' | 'ownerKey' | 'status'>) => {
      for (const listener of listeners)
        listener([{ ...change, pinnedOrigin: 'https://space.test', remoteCommunityId: 'id' }]);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentAvailabilityRuntime', () => {
  it('reports each connection’s own agents to its own space, never across spaces', async () => {
    const store = enrollmentsOf([
      {
        communityRef: alpha,
        ownerAuthorId: 'owner',
        localAgentId: 'scout',
        remoteMemberId: 'a-scout',
      },
      {
        communityRef: alpha,
        ownerAuthorId: 'owner',
        localAgentId: 'atlas',
        remoteMemberId: 'a-atlas',
      },
      {
        communityRef: beta,
        ownerAuthorId: 'owner',
        localAgentId: 'scout',
        remoteMemberId: 'b-scout',
      },
    ]);
    const fake = spaces();
    const runtime = new AgentAvailabilityRuntime({
      enrollments: store,
      spaces: fake.of,
      runsOn: () => 'computer',
      random: () => 0.5,
    });
    runtime.start();
    await runtime.idle();
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(fake.sent.get('ref-alpha:owner')).toEqual([
      {
        agents: [
          { agentId: 'a-atlas', runsOn: 'computer' },
          { agentId: 'a-scout', runsOn: 'computer' },
        ],
      },
    ]);
    expect(fake.sent.get('ref-beta:owner')).toEqual([
      { agents: [{ agentId: 'b-scout', runsOn: 'computer' }] },
    ]);
    runtime.stop();
  });

  it('stops a connection’s reporter at once when it is disconnected', async () => {
    const store = enrollmentsOf([
      {
        communityRef: alpha,
        ownerAuthorId: 'owner',
        localAgentId: 'scout',
        remoteMemberId: 'a-scout',
      },
    ]);
    const fake = spaces();
    const events = changes();
    const runtime = new AgentAvailabilityRuntime({
      enrollments: store,
      spaces: fake.of,
      runsOn: () => 'computer',
      onConnectionChange: events.subscribe,
      random: () => 0.5,
    });
    runtime.start();
    await runtime.idle();
    expect(runtime.reporting()).toHaveLength(1);
    events.emit({ ref: alpha, ownerKey: 'owner', status: 'removed' });
    expect(runtime.reporting()).toHaveLength(0);
    // The disconnect revokes the enrollments, so the next reconcile does not bring it back.
    store.rows.length = 0;
    await vi.advanceTimersByTimeAsync(FIRST_MS + AVAILABILITY_RECONCILE_MS);
    expect(fake.sent.size).toBe(0);
    runtime.stop();
  });

  it('skips a space that may not be reached now', async () => {
    const store = enrollmentsOf([
      {
        communityRef: alpha,
        ownerAuthorId: 'owner',
        localAgentId: 'scout',
        remoteMemberId: 'a-scout',
      },
    ]);
    const runtime = new AgentAvailabilityRuntime({
      enrollments: store,
      spaces: spaces().of,
      runsOn: () => 'computer',
      reachable: () => false,
    });
    runtime.start();
    await runtime.idle();
    expect(runtime.reporting()).toHaveLength(0);
    runtime.stop();
  });

  it('reports each owner’s own agents over that owner’s own connection to one space', async () => {
    const store = enrollmentsOf([
      {
        communityRef: alpha,
        ownerAuthorId: 'dana',
        localAgentId: 'scout',
        remoteMemberId: 'dana-scout',
      },
      {
        communityRef: alpha,
        ownerAuthorId: 'eli',
        localAgentId: 'atlas',
        remoteMemberId: 'eli-atlas',
      },
      {
        communityRef: alpha,
        ownerAuthorId: 'eli',
        localAgentId: 'bolt',
        remoteMemberId: 'eli-bolt',
      },
    ]);
    const fake = spaces();
    const runtime = new AgentAvailabilityRuntime({
      enrollments: store,
      spaces: fake.of,
      runsOn: () => 'computer',
      random: () => 0.5,
    });
    runtime.start();
    await runtime.idle();
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(fake.sent.get('ref-alpha:dana')).toEqual([
      { agents: [{ agentId: 'dana-scout', runsOn: 'computer' }] },
    ]);
    expect(fake.sent.get('ref-alpha:eli')).toEqual([
      {
        agents: [
          { agentId: 'eli-atlas', runsOn: 'computer' },
          { agentId: 'eli-bolt', runsOn: 'computer' },
        ],
      },
    ]);
    runtime.stop();
  });

  it('starts a reporter only for a connection verified with enroll-agent access', async () => {
    const store = enrollmentsOf([
      {
        communityRef: alpha,
        ownerAuthorId: 'owner',
        localAgentId: 'scout',
        remoteMemberId: 'a-scout',
      },
      {
        communityRef: beta,
        ownerAuthorId: 'owner',
        localAgentId: 'scout',
        remoteMemberId: 'b-scout',
      },
    ]);
    const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
    const verified: CommunityConnectionAccess = {
      state: 'verified',
      effective: capabilities,
      lastKnown: { lifecycle: 'active', capabilities, verifiedAt: '2026-10-15T00:00:00.000Z' },
    };
    let betaAccess: CommunityConnectionAccess | null = {
      ...verified,
      effective: { ...capabilities, enrollAgent: false },
    };
    const runtime = new AgentAvailabilityRuntime({
      enrollments: store,
      spaces: spaces().of,
      runsOn: () => 'computer',
      resolveConnectionAccess: async (communityRef) =>
        communityRef === alpha ? verified : betaAccess,
    });
    runtime.start();
    await runtime.idle();
    expect(runtime.reporting()).toEqual(['ref-alpha\0owner']);
    // A half-failed revoke: enrollments still active, but the connection must reconnect.
    betaAccess = null;
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECONCILE_MS);
    await runtime.idle();
    expect(runtime.reporting()).toEqual(['ref-alpha\0owner']);
    betaAccess = verified;
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECONCILE_MS);
    await runtime.idle();
    expect(runtime.reporting()).toEqual(['ref-alpha\0owner', 'ref-beta\0owner']);
    runtime.stop();
  });
});
