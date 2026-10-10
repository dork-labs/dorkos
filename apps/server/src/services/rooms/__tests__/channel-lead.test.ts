/**
 * A channel's lead (DOR-2823): the agent that answers a person's message
 * nobody else is answering.
 *
 * Driven through the real {@link RoomService} and dispatcher with only the
 * turn runner scripted, because the rule is the wiring between addressing, the
 * conversation, and the room's own setting.
 *
 * @module server/services/rooms/tests/channel-lead
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomService } from '../room-service.js';
import { RoomError } from '../room-errors.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
  '/agents/cy': { name: 'cy' },
});

interface Wired {
  service: RoomService;
  runner: ScriptedTurnRunner;
  human: string;
  room: RoomWithRoster;
  ana: string;
  bo: string;
  cy: string;
}

/**
 * A channel with Ana and Bo in it; Ana leads unless the caller says otherwise.
 *
 * @param opts.leadAgentPath - Who leads, as an agent path.
 * @param opts.quiet - The agents take turns but never post, so no
 *   conversation forms out of their answers.
 */
function open(opts: { leadAgentPath?: string; quiet?: boolean } = {}): Wired {
  const runner = scriptedRunner(() => (opts.quiet ? null : 'on it'));
  const harness = createRoomHarness({ agents: AGENTS, runner });
  const room = harness.service.createRoom(
    {
      kind: 'channel',
      title: 'Poster',
      members: [],
      agentPaths: ['/agents/ana', '/agents/bo'],
      ...(opts.leadAgentPath ? { leadAgentPath: opts.leadAgentPath } : {}),
    },
    harness.human
  );
  return {
    service: harness.service,
    runner,
    human: harness.human,
    room,
    ana: harness.authors.resolveAgent('/agents/ana', 'ana').id,
    bo: harness.authors.resolveAgent('/agents/bo', 'bo').id,
    cy: harness.authors.resolveAgent('/agents/cy', 'cy').id,
  };
}

async function say(w: Wired, text: string, replyTo?: string): Promise<RoomEntry> {
  const entry = w.service.post(w.room.id, {
    authorId: w.human,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
  await w.service.triggersIdle();
  return entry;
}

function turnsFor(w: Wired, authorId: string): number {
  return w.runner.turns.filter((turn) => turn.authorId === authorId).length;
}

function leadOf(w: Wired): string | null | undefined {
  return w.service.getRoom(w.room.id, w.human)?.leadAuthorId;
}

function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof RoomError ? err.code : String(err);
  }
  return undefined;
}

describe('who leads a channel', () => {
  it('is the first agent added, when the creator names nobody', () => {
    const w = open();
    expect(w.room.leadAuthorId).toBe(w.ana);
  });

  it('is the agent the creator names', () => {
    const w = open({ leadAgentPath: '/agents/bo' });
    expect(w.room.leadAuthorId).toBe(w.bo);
  });

  it('refuses a lead that is not one of the channel’s agents', () => {
    const harness = createRoomHarness({ agents: AGENTS, runner: scriptedRunner() });
    expect(
      refusal(() =>
        harness.service.createRoom(
          {
            kind: 'channel',
            title: 'x',
            members: [],
            agentPaths: ['/agents/ana'],
            leadAgentPath: '/agents/bo',
          },
          harness.human
        )
      )
    ).toBe('INVALID_LEAD');
  });

  it('gives a direct message no lead', () => {
    const harness = createRoomHarness({ agents: AGENTS, runner: scriptedRunner() });
    const dm = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    expect(dm.leadAuthorId ?? null).toBeNull();
  });

  it('goes to the first agent that joins a channel opened with none', () => {
    const harness = createRoomHarness({ agents: AGENTS, runner: scriptedRunner() });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Empty', members: [], agentPaths: [] },
      harness.human
    );
    expect(room.leadAuthorId ?? null).toBeNull();
    harness.service.addMember(room.id, harness.human, { agentPath: '/agents/bo' });
    expect(harness.service.getRoom(room.id, harness.human)?.leadAuthorId).toBe(
      harness.authors.resolveAgent('/agents/bo', 'bo').id
    );
  });

  it('is cleared when the lead leaves', () => {
    const w = open();
    w.service.removeMember(w.room.id, w.human, w.ana);
    expect(leadOf(w) ?? null).toBeNull();
  });
});

describe('changing the lead', () => {
  it('lets the person hand it to another agent, or to nobody', () => {
    const w = open();
    w.service.updateRoom(w.room.id, w.human, { leadAuthorId: w.bo });
    expect(leadOf(w)).toBe(w.bo);
    w.service.updateRoom(w.room.id, w.human, { leadAuthorId: null });
    expect(leadOf(w) ?? null).toBeNull();
  });

  it('lets an agent in the channel hand it on with update_room', () => {
    const w = open();
    w.service.updateRoomFromTool(w.room.id, w.ana, { leadAuthorId: w.bo });
    expect(leadOf(w)).toBe(w.bo);
  });

  it('refuses somebody who is not an agent in the channel', () => {
    const w = open();
    expect(refusal(() => w.service.updateRoom(w.room.id, w.human, { leadAuthorId: w.cy }))).toBe(
      'INVALID_LEAD'
    );
    expect(refusal(() => w.service.updateRoom(w.room.id, w.human, { leadAuthorId: w.human }))).toBe(
      'INVALID_LEAD'
    );
    expect(leadOf(w)).toBe(w.ana);
  });

  it('refuses a lead in a direct message', () => {
    const harness = createRoomHarness({ agents: AGENTS, runner: scriptedRunner() });
    const ana = harness.authors.resolveAgent('/agents/ana', 'ana').id;
    const dm = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    expect(
      refusal(() => harness.service.updateRoom(dm.id, harness.human, { leadAuthorId: ana }))
    ).toBe('INVALID_LEAD');
  });
});

describe('the lead answers what nobody else is answering', () => {
  it('takes an unaddressed post that is part of no conversation', async () => {
    const w = open({ quiet: true });
    await say(w, 'what should we work on next?');
    expect(turnsFor(w, w.ana)).toBe(1);
    expect(turnsFor(w, w.bo)).toBe(0);
  });

  it('takes it whatever its response mode', async () => {
    const w = open({ quiet: true });
    w.service.updateMembership(w.room.id, w.human, w.ana, 'mention-only');
    await say(w, 'anyone around?');
    expect(turnsFor(w, w.ana)).toBe(1);
    expect(w.runner.turns.at(-1)?.authorId).toBe(w.ana);
  });

  it('steps back when the post @mentions another agent', async () => {
    const w = open({ quiet: true });
    await say(w, '@bo can you ship the release?');
    expect(turnsFor(w, w.bo)).toBe(1);
    expect(turnsFor(w, w.ana)).toBe(0);
  });

  it('steps back for a conversation with another agent, even in a thread', async () => {
    const w = open();
    const ask = await say(w, '@bo what is next?');
    expect(turnsFor(w, w.bo)).toBe(1);

    // No @: Bo answered here last, so this is Bo's.
    await say(w, 'and after that?');
    expect(turnsFor(w, w.bo)).toBe(2);
    expect(turnsFor(w, w.ana)).toBe(0);

    // A thread on the question that named Bo is Bo's too.
    await say(w, 'one more thing about this', ask.id);
    expect(turnsFor(w, w.ana)).toBe(0);
  });

  it('never answers an agent’s post', async () => {
    const w = open({ quiet: true });
    w.service.post(w.room.id, { authorId: w.bo, text: 'deploy is out' });
    await w.service.triggersIdle();
    expect(turnsFor(w, w.ana)).toBe(0);
  });

  it('answers nothing in a channel with no lead', async () => {
    const w = open({ quiet: true });
    w.service.updateRoom(w.room.id, w.human, { leadAuthorId: null });
    await say(w, 'what should we work on next?');
    expect(w.runner.turns).toHaveLength(0);
  });
});
