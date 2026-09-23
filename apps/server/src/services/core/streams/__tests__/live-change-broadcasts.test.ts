/**
 * The REAL wiring of `agents_changed`, `config_changed` and
 * `community_connections_changed`, not a copy of it.
 *
 * ## What the copy could not prove
 *
 * The first version of this suite carried the two `index.ts` lines verbatim and
 * asserted on the result. That proves the copy. Adversarial review measured it:
 * deleting `operatorAudience` from the actual wiring in `index.ts` left every
 * test green, because no test ever reached that line. `wireLiveChangeBroadcasts`
 * exists so the decisions have a callable home; these cases call it.
 *
 * Every case here is a MUTATION PROBE — each one fails if a specific thing is
 * removed from the wiring:
 *
 * - drop the audience on `config_changed` → the agent-principal case goes red;
 * - spread the in-process change instead of picking fields → the `projectPath`
 *   case goes red;
 * - drop either subscription → its "reaches a reader" case goes red;
 * - let a config VALUE into the payload → the secret case goes red;
 * - drop the Community subscription or its audience, or let the owner or ref
 *   onto the wire → a `community_connections_changed` case goes red.
 *
 * `index.ts` calling this function is the one link left unproven by unit test,
 * and it is a single call rather than a policy: `sse-event-allowlist.test.ts`
 * scans the server tree for both literal names, so a wiring that stopped
 * broadcasting either would fail there.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  wireLiveChangeBroadcasts,
  type AgentsChangedSource,
  type CommunityConnectionsSource,
  type ConfigChange,
  type ConfigChangeSource,
} from '../live-change-broadcasts.js';
import { encodeBroadcast, type BroadcastAudience } from '../../event-fan-out.js';
import type { CallerPrincipal } from '../../../../lib/caller-principal.js';
import type { AgentIdentityChange } from '@dorkos/mesh';

/** One broadcast as the fan-out received it, audience included. */
interface Recorded {
  event: string;
  data: unknown;
  audience: BroadcastAudience | undefined;
}

/** A fan-out that keeps what it was handed, including the audience predicate. */
function recordingFanOut() {
  const sent: Recorded[] = [];
  return {
    sent,
    broadcast(event: string, data: unknown, audience?: BroadcastAudience) {
      sent.push({ event, data, audience });
    },
    /** The single broadcast of `event`, failing loudly if there is not exactly one. */
    only(event: string): Recorded {
      const matches = sent.filter((entry) => entry.event === event);
      expect(matches, `expected exactly one ${event}`).toHaveLength(1);
      return matches[0]!;
    },
    /** Whether `principal` would have received that broadcast. */
    reaches(event: string, principal: CallerPrincipal): boolean {
      const { audience } = this.only(event);
      return audience === undefined || audience(principal);
    },
  };
}

/** A mesh core that just holds its subscriber, so a test can fire one. */
function fakeMesh() {
  const callbacks: Array<(change: AgentIdentityChange) => void> = [];
  const source: AgentsChangedSource = {
    onAgentsChanged: (callback) => void callbacks.push(callback),
  };
  return {
    source,
    subscriberCount: () => callbacks.length,
    fire: (change: AgentIdentityChange) => callbacks.forEach((callback) => callback(change)),
  };
}

/** A config manager that just holds its subscriber. */
function fakeConfig() {
  const listeners: Array<(change: ConfigChange) => void> = [];
  const source: ConfigChangeSource = {
    onChange: (listener) => {
      listeners.push(listener);
      return () => {};
    },
  };
  return {
    source,
    subscriberCount: () => listeners.length,
    fire: (change: ConfigChange) => listeners.forEach((listener) => listener(change)),
  };
}

/** A Community connection store that just holds its subscriber. */
function fakeCommunityConnections() {
  type Change = { ownerKey: string; ref: string; status: string };
  const listeners: Array<(changes: readonly Change[]) => void> = [];
  const source: CommunityConnectionsSource = {
    onChange: (listener) => {
      listeners.push(listener);
      return () => {};
    },
  };
  return {
    source,
    subscriberCount: () => listeners.length,
    /** One committed write carrying `changes`. */
    fire: (...changes: Change[]) => listeners.forEach((listener) => listener(changes)),
  };
}

const AGENT_CHANGE: AgentIdentityChange = {
  kind: 'registered',
  agentId: '01JKAGENT0000000000000000',
  projectPath: '/Users/somebody/projects/secret-client-work',
  name: 'backend',
  displayName: 'Backend',
};

let mesh: ReturnType<typeof fakeMesh>;
let config: ReturnType<typeof fakeConfig>;
let communities: ReturnType<typeof fakeCommunityConnections>;
let fanOut: ReturnType<typeof recordingFanOut>;

beforeEach(() => {
  mesh = fakeMesh();
  config = fakeConfig();
  communities = fakeCommunityConnections();
  fanOut = recordingFanOut();
  wireLiveChangeBroadcasts({
    meshCore: mesh.source,
    configManager: config.source,
    communityConnections: communities.source,
    eventFanOut: fanOut,
    now: () => '2026-09-15T00:00:00.000Z',
  });
});

describe('agents_changed', () => {
  it('is subscribed at all', () => {
    expect(mesh.subscriberCount()).toBe(1);
  });

  it('carries names, ids and a stamp — and NOT the project path', () => {
    mesh.fire(AGENT_CHANGE);

    const { data } = fanOut.only('agents_changed');
    expect(Object.keys(data as object).sort()).toEqual([
      'agentId',
      'changedAt',
      'displayName',
      'kind',
      'name',
    ]);
    // The in-process event carried it; the wire does not.
    expect(AGENT_CHANGE.projectPath).toBeDefined();
    expect(JSON.stringify(data)).not.toContain('secret-client-work');
  });

  it('goes to everyone, an agent included — it is roster news, not private detail', () => {
    mesh.fire(AGENT_CHANGE);

    expect(fanOut.only('agents_changed').audience).toBeUndefined();
    for (const principal of PRINCIPALS) {
      expect(fanOut.reaches('agents_changed', principal), principal.kind).toBe(true);
    }
  });
});

/** One connection of every kind the fan-out can hold. */
const PRINCIPALS: CallerPrincipal[] = [
  { kind: 'operator' },
  { kind: 'program', userId: 'user-1' },
  { kind: 'agent' },
  { kind: 'bridged', platform: 'telegram', platformUserId: '42' },
];

describe('config_changed', () => {
  it('is subscribed at all', () => {
    expect(config.subscriberCount()).toBe(1);
  });

  it('carries section names and a stamp, and nothing else', () => {
    config.fire({ sections: ['tunnel'] });

    const { data } = fanOut.only('config_changed');
    expect(Object.keys(data as object).sort()).toEqual(['changedAt', 'sections']);
    expect((data as { sections: string[] }).sections).toEqual(['tunnel']);
  });

  it('is ADDRESSED: a person and a program receive it, an agent never does', () => {
    // The mutation probe for `operatorAudience`. Deleting the audience argument
    // from the wiring turns the agent case green-to-red here, which is exactly
    // what the verbatim-copy version of this suite could not do.
    config.fire({ sections: ['ui'] });

    expect(fanOut.only('config_changed').audience).toBeDefined();
    expect(fanOut.reaches('config_changed', { kind: 'operator' })).toBe(true);
    expect(fanOut.reaches('config_changed', { kind: 'program', userId: 'user-1' })).toBe(true);
    expect(fanOut.reaches('config_changed', { kind: 'agent' })).toBe(false);
    expect(
      fanOut.reaches('config_changed', {
        kind: 'bridged',
        platform: 'telegram',
        platformUserId: '42',
      })
    ).toBe(false);
  });

  it('puts no config value on either wire format', () => {
    // `ConfigManager` only ever hands over section names, so this is really a
    // guard on the wiring not reaching back for values — checked against the
    // encoded frames, which is what a connection actually receives.
    config.fire({ sections: ['tunnel', 'profile'] });

    const { event, data } = fanOut.only('config_changed');
    const encoded = encodeBroadcast(event, data);
    expect(`${encoded.json}\n${encoded.sse}`).toMatch(/^[^]*tunnel[^]*$/);
    expect(`${encoded.json}\n${encoded.sse}`).not.toContain('authtoken');
  });
});

describe('community_connections_changed', () => {
  const ENDED = {
    ownerKey: 'owner-author-7f3a',
    ref: 'remote_0123456789abcdef0123456789abcdef',
    status: 'reconnect-required',
  };

  it('is subscribed at all', () => {
    expect(communities.subscriberCount()).toBe(1);
  });

  it('goes out the moment the store reports a write, one frame per write', () => {
    communities.fire(ENDED);
    communities.fire({ ...ENDED, status: 'removed' });

    expect(fanOut.sent.map((entry) => entry.event)).toEqual([
      'community_connections_changed',
      'community_connections_changed',
    ]);
  });

  it('sends ONE frame for a write that changed several rows', () => {
    // A sweep of three expired rows is one write; three frames would cost
    // every open window three list reads, each re-verifying every connection.
    communities.fire(
      { ...ENDED, ref: 'remote_1', status: 'removed' },
      { ...ENDED, ref: 'remote_2', status: 'removed' },
      { ...ENDED, ref: 'remote_3', status: 'removed' }
    );

    expect(fanOut.sent.map((entry) => entry.event)).toEqual(['community_connections_changed']);
  });

  it('carries a stamp and nothing else — no owner, no ref, no status', () => {
    // The global stream cannot tell one local owner's windows from another's,
    // so anything about the connection on this frame would reach them all.
    communities.fire(ENDED);

    const { event, data } = fanOut.only('community_connections_changed');
    expect(data).toEqual({ changedAt: '2026-09-15T00:00:00.000Z' });
    const encoded = encodeBroadcast(event, data);
    for (const secret of [ENDED.ownerKey, ENDED.ref, ENDED.status]) {
      expect(`${encoded.json}\n${encoded.sse}`).not.toContain(secret);
    }
  });

  it('is ADDRESSED: a person and a program receive it, an agent never does', () => {
    communities.fire(ENDED);

    expect(fanOut.only('community_connections_changed').audience).toBeDefined();
    expect(fanOut.reaches('community_connections_changed', { kind: 'operator' })).toBe(true);
    expect(
      fanOut.reaches('community_connections_changed', { kind: 'program', userId: 'user-1' })
    ).toBe(true);
    expect(fanOut.reaches('community_connections_changed', { kind: 'agent' })).toBe(false);
    expect(
      fanOut.reaches('community_connections_changed', {
        kind: 'bridged',
        platform: 'telegram',
        platformUserId: '42',
      })
    ).toBe(false);
  });
});

describe('a server with no mesh', () => {
  it('still broadcasts settings changes', () => {
    // Mesh init is allowed to fail without taking the server down. Losing
    // `config_changed` with it would be a second, unrelated outage.
    const soloConfig = fakeConfig();
    const soloFanOut = recordingFanOut();
    wireLiveChangeBroadcasts({
      meshCore: undefined,
      configManager: soloConfig.source,
      communityConnections: fakeCommunityConnections().source,
      eventFanOut: soloFanOut,
    });

    soloConfig.fire({ sections: ['ui'] });

    expect(soloFanOut.sent.map((entry) => entry.event)).toEqual(['config_changed']);
  });
});

describe('the stamp', () => {
  it('is an ISO timestamp taken at broadcast time', () => {
    // The default clock, rather than the injected one, so the real path is what
    // is being checked.
    const realMesh = fakeMesh();
    const realFanOut = recordingFanOut();
    wireLiveChangeBroadcasts({
      meshCore: realMesh.source,
      configManager: fakeConfig().source,
      communityConnections: fakeCommunityConnections().source,
      eventFanOut: realFanOut,
    });
    const before = Date.now();

    realMesh.fire(AGENT_CHANGE);

    const { changedAt } = realFanOut.only('agents_changed').data as { changedAt: string };
    expect(Date.parse(changedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(changedAt).toBe(new Date(changedAt).toISOString());
  });
});

describe('a throwing fan-out', () => {
  it('is not caught here — the mesh and config seams already swallow reactions', () => {
    // Deliberately documented rather than handled: `AgentRegistry` and
    // `ConfigManager` both catch and log a subscriber that throws, so a second
    // try/catch here would only hide which layer failed.
    const throwingFanOut = {
      broadcast: vi.fn(() => {
        throw new Error('fan-out exploded');
      }),
    };
    const ownMesh = fakeMesh();
    wireLiveChangeBroadcasts({
      meshCore: ownMesh.source,
      configManager: fakeConfig().source,
      communityConnections: fakeCommunityConnections().source,
      eventFanOut: throwingFanOut,
    });

    expect(() => ownMesh.fire(AGENT_CHANGE)).toThrow('fan-out exploded');
  });
});
