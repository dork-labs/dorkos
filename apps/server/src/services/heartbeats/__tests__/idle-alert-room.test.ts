/**
 * Where the "nothing is running" line lands (DOR-3675, Security's second condition): a DorkOS
 * notice, written by no agent, naming no one, that wakes no agent, even one that answers every
 * post. Driven through the REAL room service and trigger dispatcher; only the turn runner stands in.
 */
import { describe, expect, it } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
} from '../../rooms/__tests__/room-test-harness.js';
import { createIdleAlertWatch } from '../idle-watch/idle-alert.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

describe('the "nothing is running" notice in a room', () => {
  it('is DorkOS’s notice, names no one, and wakes no agent', async () => {
    const { service, runner, authors, human } = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
      turnLimitsEnabled: false,
    });
    const room = service.createRoom(
      { kind: 'channel', title: 'dorkos', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    let now = Date.parse('2026-11-02T08:00:00Z');
    const watch = createIdleAlertWatch({
      enabled: () => true,
      chatActivity: () => undefined,
      openWork: async () => ({ lanes: 3, promises: 1 }),
      targetRoom: () => room.id,
      postNotice: (roomId, text) => void service.postNotice(roomId, { text }),
      now: () => now,
    });
    now += 45 * 60_000;
    await watch.check();
    await service.triggersIdle();

    const entries = service.readHistory(room.id, human, { limit: 10 });
    const notice = entries.find((entry) => entry.body.text.startsWith('No agent chat has run'));
    expect(notice).toMatchObject({ kind: 'notice', authorId: authors.system().id, mentions: [] });
    expect(runner.turns).toEqual([]);

    // Control: Ana does answer every post, so silence above is the notice's doing.
    service.post(room.id, { authorId: human, text: 'anyone there?' });
    await service.triggersIdle();
    expect(runner.turns).toHaveLength(1);
  });
});
