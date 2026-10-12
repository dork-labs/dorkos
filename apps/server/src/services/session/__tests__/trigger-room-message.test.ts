/**
 * A room turn's `turn_start` names the room post that opened it (DOR-2113), so
 * a chat watching it live, and a log-backed runtime's reload, can show who
 * posted it instead of drawing it as the person's own words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { mockInterruptReceipt } from '@dorkos/test-utils';

// The context bag reads the real filesystem; only the turn_start matters here.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import { triggerTurn, type TriggerTurnDeps } from '../trigger-turn.js';
import { SessionLockManager } from '../session-lock.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';

const SESSION = '00000000-0000-4000-8000-0000000021a3';

function deps(): TriggerTurnDeps {
  const locks = new SessionLockManager();
  return {
    acquireLock: (sid, cid, res, token) => locks.acquireLock(sid, cid, res, token),
    releaseLock: (sid, cid, token) => locks.releaseLock(sid, cid, token),
    sendMessage: async function* () {
      yield { type: 'text_delta', data: { text: 'On it.' } } as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    },
    interruptQuery: async () => mockInterruptReceipt('not-running'),
    getInternalSessionId: () => undefined,
    rekeyProjector: () => {},
    getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
  };
}

/** Run one turn and hand back the `turn_start` it opened with. */
async function turnStartFor(roomContext?: RoomContextData) {
  const projector = getOrCreateProjector(SESSION);
  await triggerTurn({
    sessionId: SESSION,
    clientId: 'room',
    content: 'the post, word for word',
    projector,
    deps: deps(),
    ...(roomContext ? { roomContext } : {}),
  });
  await vi.waitFor(() => {
    expect(projector.replayFrom(0).some((e) => e.type === 'turn_end')).toBe(true);
  });
  return projector.replayFrom(0).find((e) => e.type === 'turn_start');
}

function roomContext(triggerEntryId: string | null): RoomContextData {
  return {
    room: { id: 'room-dorkos', kind: 'channel', name: '#dorkos', bridged: false },
    thread: null,
    members: [],
    working: [],
    pending: [],
    pendingTruncated: false,
    ownRecent: [],
    acknowledgments: [],
    triggerEntryId,
    triggerAttachments: [],
    addressing: {
      responseMode: 'always',
      engagedUntil: null,
      engagedPostsLeft: null,
      addressedNow: true,
    },
    budget: {
      automaticRepliesLeftInThisRoomThisHour: null,
      automaticRepliesLeftInTotalThisHour: null,
      repliesLeftInThisChain: null,
    },
  };
}

afterEach(() => {
  disposeProjector(SESSION);
});

describe('triggerTurn and the room post that opened a turn', () => {
  it('records the room and entry on the turn_start', async () => {
    const start = await turnStartFor(roomContext('entry-1'));
    expect(start).toMatchObject({
      type: 'turn_start',
      userMessage: 'the post, word for word',
      roomMessage: { roomId: 'room-dorkos', entryId: 'entry-1' },
    });
  });

  it('records nothing for a room turn that answered no message', async () => {
    const start = await turnStartFor(roomContext(null));
    expect(start && 'roomMessage' in start).toBe(false);
  });

  it('records nothing for a message a person sent in the chat', async () => {
    const start = await turnStartFor();
    expect(start && 'roomMessage' in start).toBe(false);
  });
});
