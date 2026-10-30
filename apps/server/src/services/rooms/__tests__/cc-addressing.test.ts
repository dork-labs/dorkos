/**
 * Cc addressing (DOR-3453): in a channel, every @mention asks somebody to
 * answer, unless `cc` comes before it on that line. A cc wakes nobody, and the
 * cc'd agent learns of it the next time it reads the room. A DM keeps its own
 * rule.
 *
 * These drive the REAL dispatcher, because the claim is about how many turns a
 * message actually costs.
 *
 * @module server/services/rooms/tests/cc-addressing
 */
import { describe, it, expect } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import { reachOf } from '../messages/post-reach.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
  '/agents/pm': { name: 'pm' },
});

/**
 * An owner and three agents in one room, all answering @mentions only unless a
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
  const pm = harness.authors.resolveAgent('/agents/pm', 'PM').id;
  const agentPaths =
    kind === 'dm' ? ['/agents/ana', '/agents/bo'] : ['/agents/ana', '/agents/bo', '/agents/pm'];
  const room = harness.service.createRoom(
    { kind, title: 'Build', members: [], agentPaths },
    harness.human
  );
  harness.service.updateMembership(room.id, harness.human, ana, 'mention-only');
  harness.service.updateMembership(room.id, harness.human, bo, opts.boMode ?? 'mention-only');
  if (kind === 'channel')
    harness.service.updateMembership(room.id, harness.human, pm, 'mention-only');
  return { ...harness, runner, room, ana, bo, pm };
}

/** Which agents took a turn, in order. */
const turnsOf = (runner: { turns: readonly { agentPath: string }[] }) =>
  runner.turns.map((turn) => turn.agentPath);

describe('cc addressing in a channel', () => {
  it('wakes every agent a message names', async () => {
    const { service, human, runner, room } = open('channel');

    service.post(room.id, { authorId: human, text: '@ana ship it, and tell @bo' });
    await service.triggersIdle();

    expect(turnsOf(runner).sort()).toEqual(['/agents/ana', '/agents/bo']);
  });

  it('wakes both agents a post assigns work to after naming a person first', async () => {
    // The PM's 15:39 shape: answer the person, then hand work to two agents.
    const { service, human, authors, runner, room } = open('channel', {
      reply: (agentPath) =>
        agentPath === '/agents/pm'
          ? '@dorian yes, that is the plan.\n@ana take the build. @bo take the tests.'
          : '',
    });
    authors.setHandle(human, 'dorian');

    service.post(room.id, { authorId: human, text: '@pm is that the plan?' });
    await service.triggersIdle();

    expect(turnsOf(runner)[0]).toBe('/agents/pm');
    expect(turnsOf(runner).slice(1).sort()).toEqual(['/agents/ana', '/agents/bo']);
  });

  it('wakes neither agent of `cc @a @b`', async () => {
    const { service, human, runner, room, ana, bo } = open('channel', { boMode: 'always' });

    const copied = service.post(room.id, { authorId: human, text: 'cc @ana @bo' });
    await service.triggersIdle();

    expect(turnsOf(runner)).toEqual([]);
    expect(copied.mentions).toEqual([ana, bo]);
    expect(copied.mentionSpans?.every((span) => span.cc)).toBe(true);
  });

  it('gives a cc no turn, and tells that agent next time it reads', async () => {
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
    const { service, human, runner, room } = open('channel', {
      reply: (agentPath) => (agentPath === '/agents/ana' ? 'done, cc @bo' : 'thanks'),
    });

    service.post(room.id, { authorId: human, text: '@ana ship it' });
    await service.triggersIdle();

    expect(turnsOf(runner)).toEqual(['/agents/ana']);
  });
});

describe('a post tells its author who it reached (DOR-3454)', () => {
  it('names the agent it woke and the one it only cc’d', () => {
    const { service, human, room } = open('channel');

    const entry = service.post(room.id, { authorId: human, text: '@ana ship it, cc @bo' });

    expect(reachOf(service, entry)).toEqual({ reached: 'Woke @ana. Cc: @bo.' });
  });

  it('leaves the person it named, and its own author, out of who woke', () => {
    const { service, human, authors, room, pm } = open('channel');
    authors.setHandle(human, 'dorian');

    const entry = service.post(room.id, {
      authorId: pm,
      text: '@dorian yes.\n@pm noted. @ana take the build. @bo take the tests.',
    });

    expect(reachOf(service, entry)).toEqual({ reached: 'Woke @ana, @bo.' });
  });

  it('says a post that names nobody woke nobody', () => {
    const { service, human, room } = open('channel');

    const entry = service.post(room.id, { authorId: human, text: 'morning, all' });

    expect(reachOf(service, entry)).toEqual({ reached: 'Woke nobody.' });
  });

  it('says nothing in a DM, where a post is for everyone in it', () => {
    const { service, human, room } = open('dm');

    const entry = service.post(room.id, { authorId: human, text: '@ana ship it' });

    expect(reachOf(service, entry)).toEqual({});
  });
});

describe('cc addressing leaves a DM alone', () => {
  it('still wakes everyone a person writes to in a DM', async () => {
    const { service, human, runner, room, ana } = open('dm', { boMode: 'always' });
    service.updateMembership(room.id, human, ana, 'always');

    const posted = service.post(room.id, { authorId: human, text: '@ana ship it, cc @bo' });
    await service.triggersIdle();

    expect(turnsOf(runner).sort()).toEqual(['/agents/ana', '/agents/bo']);
    expect(posted.mentionSpans?.some((span) => span.cc)).toBe(false);
  });

  it('still lets an agent reach another in a DM with a cc', async () => {
    const { service, human, runner, room } = open('dm', {
      reply: (agentPath) => (agentPath === '/agents/ana' ? 'done, cc @bo' : 'on it'),
    });

    service.post(room.id, { authorId: human, text: '@ana can you take the migration?' });
    await service.triggersIdle();

    expect(turnsOf(runner)).toEqual(['/agents/ana', '/agents/bo']);
  });
});
