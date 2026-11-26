/**
 * The #team conversation scenario the capture films: who answers, with what,
 * in which order, and that nobody answers twice.
 *
 * The room is a stand-in here. What this pins is the scenario's own choices;
 * that a post really lands through `rooms.post` is `sayInRoom`'s contract,
 * covered with the real service in the rooms suite.
 *
 * @module services/runtimes/test-mode/__tests__/demo-team-room-scenario
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { ScenarioContext } from '../interaction-gate.js';
import type { ScenarioWorld } from '../scenario-world.js';

/** The room log the stand-in world answers with. */
let entries: { kind: string; authorId: string; body: { text?: string } }[] = [];

/** Author id → display name, as the room's author registry would answer. */
const AUTHORS: Record<string, string> = {
  'a-lens': 'Lens',
  'a-forge': 'Forge',
  'a-sentinel': 'Sentinel',
  'a-dorkbot': 'DorkBot',
};

/** The rooms the turn reads, standing in for the server's. */
const world = {
  rooms: {
    authorOf: (id: string) =>
      AUTHORS[id] ? { naturalKey: `/agents/${id}`, displayName: AUTHORS[id] } : undefined,
    entriesAfter: () => entries as unknown as RoomEntry[],
  },
} as unknown as ScenarioWorld;

const sayInRoom = vi.fn(async (): Promise<true | false | string> => true);
vi.mock('../room-reply-scenarios.js', () => ({
  sayInRoom: (...args: unknown[]) => sayInRoom(...(args as [])),
}));

const { DEMO_TEAM_ROOM_SCENARIOS, DEMO_TEAM_ROOM_SCENARIO, TEAM_ROOM_REPLIES } =
  await import('../demo-team-room-scenario.js');
const scenario = DEMO_TEAM_ROOM_SCENARIOS[DEMO_TEAM_ROOM_SCENARIO]!;

/** The session the turn runs on, which every post must name (DOR-5032). */
const SEAT = 'team-seat';

/** A context whose waits return at once, counting how many were asked for. */
function context(onDelay?: () => void): ScenarioContext {
  return {
    sessionId: SEAT,
    world,
    signal: new AbortController().signal,
    delay: vi.fn(async () => {
      onDelay?.();
    }),
  } as unknown as ScenarioContext;
}

/** Options for a room turn by one author. */
function roomTurn(authorId: string): MessageOpts {
  return { roomTurn: { roomId: 'team', authorId, turnId: 't1' } } as MessageOpts;
}

/** Run a turn to the end and keep what it emitted. */
async function run(ctx: ScenarioContext, opts: MessageOpts | undefined): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of scenario('', ctx, opts)) events.push(event);
  return events;
}

/** The reply pinned for one agent. */
function replyOf(agent: string): string {
  return TEAM_ROOM_REPLIES.find((reply) => reply.agent === agent)!.text;
}

beforeEach(() => {
  entries = [];
  sayInRoom.mockReset();
  sayInRoom.mockResolvedValue(true);
});

describe('demo-team-room', () => {
  it('says nothing outside a room and still ends the turn', async () => {
    const events = await run(context(), undefined);
    expect(sayInRoom).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
  });

  it('posts the pinned line for the agent answering', async () => {
    await run(context(), roomTurn('a-lens'));
    expect(sayInRoom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: SEAT }),
      replyOf('Lens')
    );
  });

  it('says nothing for an agent it has no line for', async () => {
    const events = await run(context(), roomTurn('a-dorkbot'));
    expect(sayInRoom).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
  });

  it('never answers twice', async () => {
    entries = [{ kind: 'post', authorId: 'a-lens', body: { text: replyOf('Lens') } }];
    await run(context(), roomTurn('a-lens'));
    expect(sayInRoom).not.toHaveBeenCalled();
  });

  it('waits for the reply before it, then posts after it', async () => {
    let waits = 0;
    const ctx = context(() => {
      waits += 1;
      // Lens's reply lands while Forge is waiting.
      if (waits === 3) {
        entries = [{ kind: 'post', authorId: 'a-lens', body: { text: replyOf('Lens') } }];
      }
    });
    await run(ctx, roomTurn('a-forge'));
    // Three polls before Lens landed, then the beat before posting.
    expect(waits).toBe(4);
    expect(sayInRoom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: SEAT }),
      replyOf('Forge')
    );
  });

  it('still answers when the reply before it never comes', async () => {
    await run(context(), roomTurn('a-sentinel'));
    expect(sayInRoom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: SEAT }),
      replyOf('Sentinel')
    );
  });

  it('fails the turn, saying nothing, when the room refuses the post', async () => {
    sayInRoom.mockResolvedValue('Not a member of this room');
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const event of scenario('', context(), roomTurn('a-sentinel'))) {
        events.push(event);
      }
    }).rejects.toThrow('Sentinel could not answer in the room: Not a member of this room');
    expect(events.some((event) => event.type === 'text_delta')).toBe(false);
  });
});
