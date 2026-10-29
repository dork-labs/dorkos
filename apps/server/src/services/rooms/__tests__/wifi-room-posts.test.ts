/**
 * A room post a person writes from Wi-Fi holds the turns it starts to the
 * runtime's default (DOR-3037), and that hold follows a mention the answering
 * agent makes, through the REAL room service, store, author registry and
 * trigger dispatcher. Only the turn runner stands in.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import {
  entryHeldToDefault,
  recordTurnLevels,
  setStoredEntryHoldReader,
} from '../../core/turn-power/turn-levels.js';
import { and, eq, roomEntries } from '@dorkos/db';
import { storedEntryHoldReader } from '../limits/stored-entry-hold.js';
import { ceilingForEntry } from '../limits/turn-ceiling.js';
import type { RoomService } from '../room-service.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

/** Run a turn on `sessionId` at `mode` under `opts`, as the registry's wrapper records it. */
async function ranAt(sessionId: string, mode: string, opts?: MessageOpts): Promise<void> {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => mode
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe('a room post from Wi-Fi', () => {
  let service: RoomService;
  let human: string;
  let channel: RoomWithRoster;
  const seen: RoomTurnRequest[] = [];
  const turnsOf = (agentPath: string) => seen.filter((r) => r.agentPath === agentPath);

  beforeEach(() => {
    seen.length = 0;
    const runner = outcomeRunner((request) => {
      seen.push(request);
      if (request.agentPath === '/agents/ana' && request.prompt.includes('ask bo')) {
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text: '@bo can you check the build?',
          callerSessionId: request.sessionId ?? undefined,
        });
      }
      return { text: null };
    });
    ({ service, human } = createRoomHarness({ agents, runner }));
    channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
  });

  it('holds the turn it starts to the runtime default', async () => {
    service.post(channel.id, { authorId: human, text: '@ana hello' }, false, 'runtime-default');
    await settleUntil(() => turnsOf('/agents/ana').length === 1, 'Ana was asked');
    expect(turnsOf('/agents/ana')[0]!.permissionCeiling).toBe('runtime-default');
  });

  it('leaves the same post made at this computer unbounded', async () => {
    service.post(channel.id, { authorId: human, text: '@ana hello' });
    await settleUntil(() => turnsOf('/agents/ana').length === 1, 'Ana was asked');
    expect(turnsOf('/agents/ana')[0]!.permissionCeiling).toBeUndefined();
  });

  it('holds the agent the answering turn mentions while the Wi-Fi line is in its view', async () => {
    // Ana's first turn binds her conversation, from this computer.
    service.post(channel.id, { authorId: human, text: '@ana hello' });
    await settleUntil(() => turnsOf('/agents/ana').length === 1, 'Ana was asked');
    const anaSession = turnsOf('/agents/ana')[0]!.sessionId!;
    // Her next turn answers a Wi-Fi post, so it runs held: an agent set to
    // Full autonomy runs that turn at Default, and it is marked.
    await ranAt(anaSession, 'bypassPermissions', { permissionCeiling: 'runtime-default' });

    service.post(channel.id, { authorId: human, text: '@ana ask bo' }, false, 'runtime-default');
    await settleUntil(() => turnsOf('/agents/bo').length === 1, 'Bo was asked by Ana');

    expect(turnsOf('/agents/ana')[1]!.permissionCeiling).toBe('runtime-default');
    // Ana's own level without the Wi-Fi hold and the mark her post carries on;
    // but Bo is shown the Wi-Fi line itself, first-hand, so the room is not the
    // owner's own circle and he is held as well (DOR-3390, Security's M-B).
    expect(turnsOf('/agents/bo')[0]!.permissionCeiling).toEqual([
      { asks: 'never', reach: 'everything', outsider: true },
      { asks: 'never', reach: 'everything', outsider: true },
      'runtime-default',
    ]);
  });
});

describe('a Wi-Fi room post across a restart', () => {
  it('owes no turn after the restart, so its hold, kept in memory, is never needed again', async () => {
    // The pending turn is process memory (`room-collect.ts`): a restart drops
    // it, and the post is answered only as background to the next post's turn.
    const db = createTestDb();
    const before: RoomTurnRequest[] = [];
    const first = createRoomHarness({
      agents,
      db,
      collect: { debounceMs: 60_000, maxEntries: 10 },
      runner: outcomeRunner((request) => {
        before.push(request);
        return { text: null };
      }),
    });
    const room = first.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      first.human
    );
    first.service.post(
      room.id,
      { authorId: first.human, text: '@ana hello' },
      false,
      'runtime-default'
    );

    const after: RoomTurnRequest[] = [];
    createRoomHarness({
      agents,
      db,
      runner: outcomeRunner((request) => {
        after.push(request);
        return { text: null };
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(0);
  });
});

describe('the hold kept on the post', () => {
  it('is written on the row, and read from it for a post this process did not note', async () => {
    const db = createTestDb();
    const harness = createRoomHarness({
      agents,
      db,
      runner: outcomeRunner(() => ({ text: null })),
    });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    const wifi = harness.service.post(
      room.id,
      { authorId: harness.human, text: 'from the phone' },
      false,
      'runtime-default'
    );
    const here = harness.service.post(room.id, { authorId: harness.human, text: 'from here' });
    const read = storedEntryHoldReader(db);
    expect(read(room.id, wifi.id)).toBe(true);
    expect(read(room.id, here.id)).toBe(false);

    // As after a restart: a held row whose post nobody noted in memory.
    db.update(roomEntries)
      .set({ heldToDefault: true })
      .where(and(eq(roomEntries.roomId, room.id), eq(roomEntries.id, here.id)))
      .run();
    setStoredEntryHoldReader(read);
    expect(entryHeldToDefault(here.id, room.id)).toBe(true);
    expect(
      ceilingForEntry(harness.authors, { id: here.id, authorId: harness.human, roomId: room.id })
    ).toEqual({ permissionCeiling: 'runtime-default' });
  });
});
