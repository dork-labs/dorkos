/**
 * First-@ addressing (DOR-3401): in a channel, only the leading @mentions ask
 * anybody to answer. A later @mention is a cc — it wakes nobody, and the
 * cc'd agent learns of it the next time it reads the room. A DM keeps its own
 * rule.
 *
 * These drive the REAL dispatcher, because the claim is about how many turns a
 * message actually costs.
 *
 * @module server/services/rooms/tests/first-at-addressing
 */
import { describe, it, expect } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
});

/**
 * An owner and two agents in one room, both answering @mentions only unless a
 * case says otherwise, so every turn below is one a mention started.
 *
 * @param kind - The room's kind.
 * @param opts.reply - What each agent says when it is asked.
 * @param opts.boMode - Bo's response mode here.
 */
function open(
  kind: 'channel' | 'dm',
  opts: { reply?: (agentPath: string) => string; boMode?: ResponseMode } = {}
) {
  const runner = scriptedRunner((request) => opts.reply?.(request.agentPath) ?? 'on it');
  const harness = createRoomHarness({ agents: AGENTS, runner });
  const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
  const bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
  const room = harness.service.createRoom(
    { kind, title: 'Build', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
    harness.human
  );
  harness.service.updateMembership(room.id, harness.human, ana, 'mention-only');
  harness.service.updateMembership(room.id, harness.human, bo, opts.boMode ?? 'mention-only');
  return { ...harness, runner, room, ana, bo };
}

/** Which agents took a turn, in order. */
const turnsOf = (runner: { turns: readonly { agentPath: string }[] }) =>
  runner.turns.map((turn) => turn.agentPath);

describe('first-@ addressing in a channel', () => {
  it('wakes the agent a message starts with', async () => {
    const { service, human, runner, room } = open('channel');

    service.post(room.id, { authorId: human, text: '@ana ship it' });
    await service.triggersIdle();

    expect(turnsOf(runner)).toEqual(['/agents/ana']);
  });

  it('wakes both agents a message starts with', async () => {
    const { service, human, runner, room } = open('channel');

    service.post(room.id, { authorId: human, text: '@ana @bo: ship it' });
    await service.triggersIdle();

    expect(turnsOf(runner).sort()).toEqual(['/agents/ana', '/agents/bo']);
  });

  it('wakes the first @mention even mid-sentence, and a run right after it', async () => {
    const { service, human, runner, room } = open('channel');

    service.post(room.id, { authorId: human, text: 'hey @ana check this' });
    await service.triggersIdle();
    expect(turnsOf(runner)).toEqual(['/agents/ana']);

    service.post(room.id, { authorId: human, text: 'hey @ana @bo check this' });
    await service.triggersIdle();
    expect(turnsOf(runner).slice(1).sort()).toEqual(['/agents/ana', '/agents/bo']);
  });

  it('gives a later @mention no turn, and tells that agent next time it reads', async () => {
    // Bo answers everything here, and still takes no turn for a cc. Nobody
    // replies, so Ana's answer cannot be what wakes Bo.
    const { service, human, runner, room, bo } = open('channel', {
      boMode: 'always',
      reply: () => '',
    });

    const copied = service.post(room.id, { authorId: human, text: '@ana ship it, cc @bo' });
    await service.triggersIdle();

    expect(turnsOf(runner)).toEqual(['/agents/ana']);
    expect(copied.mentions).toContain(bo);
    expect(copied.mentionSpans?.find((span) => span.authorId === bo)?.cc).toBe(true);

    service.post(room.id, { authorId: human, text: '@bo your turn' });
    await service.triggersIdle();

    const boTurn = runner.turns.find((turn) => turn.agentPath === '/agents/bo');
    expect(boTurn?.roomContext.ccdIn).toEqual([copied.id]);
    expect(boTurn?.roomContext.pending.find((entry) => entry.id === copied.id)?.mentionsMe).toBe(
      false
    );
  });

  it('holds for an agent writing as well as a person', async () => {
    // Ana's answer names Bo second, after a mention of Ana herself.
    const { service, human, runner, room } = open('channel', {
      reply: (agentPath) => (agentPath === '/agents/ana' ? '@ana done, fyi @bo' : 'thanks'),
    });

    service.post(room.id, { authorId: human, text: '@ana ship it' });
    await service.triggersIdle();

    expect(turnsOf(runner)).toEqual(['/agents/ana']);
  });
});

describe('first-@ addressing leaves a DM alone', () => {
  it('still wakes everyone a person writes to in a DM', async () => {
    const { service, human, runner, room, ana } = open('dm', { boMode: 'always' });
    service.updateMembership(room.id, human, ana, 'always');

    const posted = service.post(room.id, { authorId: human, text: '@ana ship it, cc @bo' });
    await service.triggersIdle();

    expect(turnsOf(runner).sort()).toEqual(['/agents/ana', '/agents/bo']);
    expect(posted.mentionSpans?.some((span) => span.cc)).toBe(false);
  });

  it('still lets an agent reach another in a DM with a later @mention', async () => {
    const { service, human, runner, room } = open('dm', {
      reply: (agentPath) => (agentPath === '/agents/ana' ? '@ana done, over to @bo' : 'on it'),
    });

    service.post(room.id, { authorId: human, text: '@ana can you take the migration?' });
    await service.triggersIdle();

    expect(turnsOf(runner)).toEqual(['/agents/ana', '/agents/bo']);
  });
});
