/**
 * An agent's room context names the operator by the name they chose — never by
 * the registry's `'You'`, which an agent reads as itself (DOR-2458).
 *
 * The registry fixes the owner's label at `'You'` on purpose: it is the right
 * word in the operator's own window. Rendered into an agent's context it is a
 * pronoun pointing at the agent — "You (person): ship it" reads as the agent's
 * own words. So every name an agent reads for the owner goes through
 * `agentFacingName`: the profile name, or "the operator".
 *
 * Driven through the real service, the real dispatcher and the real context
 * builder, with login off (the `'local'` author is the owner) and on (the
 * owner's account row), and with a second signed-in person, who keeps their own
 * name. The one substitution is the turn runner, because the alternative is a
 * model call.
 */
import { describe, it, expect } from 'vitest';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import { formatRoomContext } from '../../runtimes/shared/room-context-block.js';
import { OPERATOR_FALLBACK_NAME } from '../room-context.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
});

/**
 * One room with Ana and the operator (and optionally a second person). The
 * operator speaks, then asks Ana; the context her turn was handed is returned.
 */
async function contextFor(opts: {
  ownerUserId?: string;
  operatorName?: string | null;
  secondPerson?: boolean;
}): Promise<RoomContextData> {
  const runner = scriptedRunner(() => null);
  const harness = createRoomHarness({
    agents: AGENTS,
    runner,
    ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
    ...(opts.operatorName !== undefined ? { operatorName: () => opts.operatorName ?? null } : {}),
  });
  const room = harness.service.createRoom(
    { kind: 'channel', title: 'Release train', members: [], agentPaths: ['/agents/ana'] },
    harness.human
  );
  if (opts.secondPerson) {
    const dee = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'user:dee',
      displayName: 'Dee',
    });
    harness.service.addMember(room.id, harness.human, { authorId: dee.id });
    harness.service.post(room.id, { authorId: dee.id, text: 'the deploy is stuck' });
  }
  harness.service.post(room.id, { authorId: harness.human, text: 'ship it on Thursday' });
  harness.service.post(room.id, { authorId: harness.human, text: '@ana can you take this?' });
  await harness.service.triggersIdle();
  const turn = runner.turns.at(-1);
  if (!turn?.roomContext) throw new Error('Ana was never asked');
  return turn.roomContext;
}

/** Every author name the context carries: roster, entries, working list. */
function namesIn(context: RoomContextData): string[] {
  return [
    ...context.members.map((m) => m.displayName),
    ...context.pending.map((e) => e.authorDisplayName),
    ...context.ownRecent.map((e) => e.authorDisplayName),
    ...context.working.map((w) => w.displayName),
  ];
}

describe('the operator is named by their own name in an agent`s room context', () => {
  it('login off: the profile name, on the roster and on their messages', async () => {
    const context = await contextFor({ operatorName: 'Dorian' });

    const operator = context.members.find((m) => m.isPerson)!;
    expect(operator.displayName).toBe('Dorian');
    expect(context.pending.map((e) => e.authorDisplayName)).toContain('Dorian');
    expect(namesIn(context)).not.toContain('You');
    const block = formatRoomContext(context, { nonce: 'dddd4444' });
    expect(block).toContain('Dorian (person');
    expect(block).not.toMatch(/\bYou \(person/);
  });

  it('login on: the owner`s account row is named the same way', async () => {
    const context = await contextFor({ ownerUserId: 'owner-1', operatorName: 'Dorian' });

    expect(context.members.find((m) => m.isPerson)!.displayName).toBe('Dorian');
    expect(namesIn(context)).not.toContain('You');
  });

  it('with no profile name, the operator is "the operator" — login off and on', async () => {
    for (const ownerUserId of [undefined, 'owner-1']) {
      const context = await contextFor({ ownerUserId, operatorName: null });
      expect(context.members.find((m) => m.isPerson)!.displayName).toBe(OPERATOR_FALLBACK_NAME);
      expect(namesIn(context)).not.toContain('You');
    }
  });

  it('a second signed-in person keeps their own name; only the owner is renamed', async () => {
    const context = await contextFor({
      ownerUserId: 'owner-1',
      operatorName: 'Dorian',
      secondPerson: true,
    });

    const people = context.members.filter((m) => m.isPerson).map((m) => m.displayName);
    expect(people.sort()).toEqual(['Dee', 'Dorian']);
    expect(context.pending.map((e) => e.authorDisplayName)).toEqual(
      expect.arrayContaining(['Dee', 'Dorian'])
    );
  });
});

describe('texts the room stores, which the next turn reads back, name the operator too', () => {
  /** A room with Ana, Bo and the operator, and the texts it has stored. */
  function roomWithAgents(operatorName: string | null) {
    const harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
        '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
      }),
      runner: scriptedRunner(() => null),
      operatorName: () => operatorName,
    });
    const room = harness.service.createRoom(
      {
        kind: 'channel',
        title: 'Release train',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo'],
      },
      harness.human
    );
    const texts = (): string[] =>
      harness.store.listEntriesFrom(room.id, { afterSeq: 0, limit: 200 }).map((e) => e.body.text);
    return { harness, room, texts };
  }

  it('the stop notice: "Dorian stopped Bo", never "You stopped Bo"', async () => {
    const { harness, room, texts } = roomWithAgents('Dorian');
    const bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;

    await harness.service.haltAgent(room.id, bo, harness.human);

    expect(texts().some((t) => t.startsWith('Dorian stopped Bo.'))).toBe(true);
    expect(texts().some((t) => t.startsWith('You '))).toBe(false);
  });

  it('the canvas sentence names the operator who opened a discussion', () => {
    const { harness, room, texts } = roomWithAgents(null);
    const document = harness.service.canvas.open(room.id, harness.human, {
      type: 'json',
      data: {},
      title: 'plan',
    });
    const before = texts().length;

    harness.service.canvas.discuss(room.id, harness.human, document.id);

    const added = texts().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.startsWith('The operator started a discussion')).toBe(true);
  });

  it('the archive notice names the operator when they archive through a tool', () => {
    const { harness, room, texts } = roomWithAgents('Dorian');

    harness.service.archiveRoomFromTool(room.id, harness.human);

    expect(texts().some((t) => t.startsWith('Dorian put this channel away.'))).toBe(true);
    expect(texts().some((t) => t.startsWith('You '))).toBe(false);
  });
});
