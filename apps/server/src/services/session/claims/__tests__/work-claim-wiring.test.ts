/**
 * The work-claim wiring (DOR-4019): the reader rule decides how a holder is
 * named, a chat seen working keeps its claims, and a chat that settles on a new
 * id takes its claims with it. The reader rule, titles and lifecycle feed are
 * handed in, so no module of ours is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { MeshCore } from '@dorkos/mesh';
import type { ProjectorStatusUpdate } from '../../session-state-projector.js';
import { CLAIM_IDLE_LIMIT_MS } from '../work-claim-service.js';
import { getWorkClaims } from '../work-claim-current.js';
import { wireWorkClaims, type WorkClaimWiring } from '../work-claim-wiring.js';

const mesh = { getByPath: () => ({ id: 'agent-1' }) } as unknown as MeshCore;
const caller = { sessionId: 'asking-chat', agentPath: '/agents/ana' };

const listeners: ((update: ProjectorStatusUpdate) => void)[] = [];
const readable = new Set<string>();

let wiring: WorkClaimWiring;

beforeEach(() => {
  listeners.length = 0;
  readable.clear();
  wiring = wireWorkClaims({
    db: createTestDb(),
    meshCore: () => mesh,
    maySeeChat: (_caller, target) => readable.has(target),
    chatTitleOf: async (sessionId) => `Lane <b>${sessionId}</b>`,
    onStatusChange: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
        return true;
      };
    },
  });
});

afterEach(() => wiring.stop());

function announce(update: Partial<ProjectorStatusUpdate> & { sessionId: string }): void {
  for (const listener of [...listeners]) listener(update as ProjectorStatusUpdate);
}

describe('wireWorkClaims', () => {
  it('names a readable holder by its cleaned title and link', async () => {
    readable.add('lane-1');
    await expect(wiring.capabilityDeps.describeChat(caller, 'lane-1')).resolves.toEqual({
      title: 'Lane b lane-1 /b',
      link: '[Lane b lane-1 /b](/session?session=lane-1)',
      private: false,
    });
  });

  it('names a holder the caller may not read only as private', async () => {
    await expect(wiring.capabilityDeps.describeChat(caller, 'dm-1')).resolves.toEqual({
      title: null,
      link: null,
      private: true,
    });
  });

  it('keeps a claim alive while its chat is seen working', () => {
    vi.useFakeTimers();
    try {
      const service = getWorkClaims()!;
      service.claim('agent-1', 'lane-1', 'DOR-1');
      vi.advanceTimersByTime(CLAIM_IDLE_LIMIT_MS - 1_000);
      announce({ sessionId: 'lane-1' });
      vi.advanceTimersByTime(CLAIM_IDLE_LIMIT_MS - 1_000);
      expect(service.check('agent-1')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves claims to the id a chat settles on', () => {
    const service = getWorkClaims()!;
    service.claim('agent-1', 'minted', 'DOR-2');
    announce({ sessionId: 'canonical', retiredSessionId: 'minted' });
    expect(service.check('agent-1')).toEqual([expect.objectContaining({ sessionId: 'canonical' })]);
  });

  it('stops listening, and clears the live service, when stopped', () => {
    wiring.stop();
    expect(listeners).toHaveLength(0);
    expect(getWorkClaims()).toBeUndefined();
  });
});
