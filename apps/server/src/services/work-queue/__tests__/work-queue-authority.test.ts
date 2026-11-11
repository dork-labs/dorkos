/** Durable ceilings on work handed between agents. */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { WorkQueueStore } from '../work-queue-store.js';
import { WorkQueueService } from '../work-queue-service.js';
import { anotherAgentTurnRefusal } from '../../connectors/access/turn-gate.js';
import { queuedWorkLevel } from '../work-queue-authority.js';

const CAREFUL = { asks: 'always', reach: 'everything', outsider: true } as const;
const FULL = { asks: 'never', reach: 'everything' } as const;

it('a Careful agent queues for a Full agent: the run stays Careful with requester marks', () => {
  const db = createTestDb();
  const store = new WorkQueueStore(db);
  const service = new WorkQueueService({ store, holdOf: () => null, wake() {} });
  const item = service.add(
    {
      kind: 'agent',
      agentId: 'scout',
      sessionId: 'scout-chat',
      level: CAREFUL,
      otherQueueApproved: true,
    },
    'atlas',
    { title: 'Read the brief', prompt: 'Read the brief.' }
  );
  // A fresh store proves the bound survives the requesting turn and a restart.
  const reopened = new WorkQueueStore(db);
  expect(queuedWorkLevel(reopened, item, FULL)).toEqual(CAREFUL);
  expect(reopened.authority(item.id)).toMatchObject({
    authorAgentId: 'scout',
    authorSessionId: 'scout-chat',
  });
});

describe('explicit requeue', () => {
  it('keeps the original author, marks and first-run ceiling after the target is promoted', () => {
    const store = new WorkQueueStore(createTestDb());
    const service = new WorkQueueService({ store, holdOf: () => null, wake() {} });
    const item = service.add(
      {
        kind: 'agent',
        agentId: 'scout',
        sessionId: 'original',
        level: FULL,
        otherQueueApproved: true,
      },
      'atlas',
      { title: 'Read', prompt: 'Read.' }
    );
    expect(queuedWorkLevel(store, item, CAREFUL)).toEqual(CAREFUL);
    store.markEnded(item.id, { outcome: 'finished', note: null, endedAt: '2026-11-08' });
    service.requeue(item.id);
    expect(queuedWorkLevel(store, item, FULL)).toEqual(CAREFUL);
    expect(store.authority(item.id)?.authorSessionId).toBe('original');
  });
});

it.each(['schedule', 'heartbeat'])(
  'the shared cross-agent turn gate refuses %s setup writes',
  (origin) => {
    expect(
      anotherAgentTurnRefusal(
        { sessionId: 'turn', agentPath: '/agents/scout' },
        {
          hasTurnRecord: () => true,
          marked: () => false,
          agentSenders: () => [],
          launchOrigin: () => origin,
        }
      )
    ).toBe('GRANT_MARKS_UNREADABLE');
  }
);
