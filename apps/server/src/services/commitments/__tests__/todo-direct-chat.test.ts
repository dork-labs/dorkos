/**
 * To-do turns in the Direct chat (DOR-3088, Security's Option A and Musts 1-4): where a turn runs,
 * the card, and the ceiling every turn names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { roomEntries, type Db } from '@dorkos/db';

const { dispatch, postTodoCard } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  postTodoCard: vi.fn(),
}));
vi.mock('../../rooms/index.js', () => ({ getRoomService: () => ({ postTodoCard }) }));
vi.mock('../../session/launch/launch-session.js', () => ({
  dispatchSessionMessage: dispatch,
  isSessionLaunchRefusal: () => false,
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { todoRunsInDirectChat } from '../todo-turn-power.js';
import { todoTurnSeams } from '../todo-turn-wiring.js';
import {
  TODO_CARD_TEXT,
  todoDirectChatPort,
  type TodoDirectChatPort,
} from '../todo-direct-chat.js';
import type { TodoTurnLaunch } from '../todo-turns.js';

const CHAT = { roomId: 'room-dm', sessionId: 'session-dm' };
const PLACE = { placeOf: vi.fn() } as never;

function launchOf(overrides: Partial<TodoTurnLaunch> = {}): TodoTurnLaunch {
  return {
    todoId: 'todo-1',
    agentId: 'agent-a',
    content: 'Do it',
    permissionCeiling: undefined,
    carriedMarks: undefined,
    inDirectChat: true,
    cardForPerson: true,
    ...overrides,
  };
}

describe('todoRunsInDirectChat', () => {
  it("is the person's own to-do with no mark, and nothing else", () => {
    expect(
      todoRunsInDirectChat({ authority: 'person', authorityMarks: '{}', sourceRoomEntryId: null })
    ).toBe(true);
    expect(
      todoRunsInDirectChat({
        authority: 'person',
        authorityMarks: '{"outsider":true}',
        sourceRoomEntryId: null,
      })
    ).toBe(false);
    expect(
      todoRunsInDirectChat({
        authority: 'person',
        authorityMarks: '{"teammate":[{"roomId":"r1","authorId":"m1"}]}',
        sourceRoomEntryId: null,
      })
    ).toBe(false);
    expect(
      todoRunsInDirectChat({
        authority: 'runtime-default',
        authorityMarks: '{}',
        sourceRoomEntryId: null,
      })
    ).toBe(false);
    expect(
      todoRunsInDirectChat({
        authority: '{"asks":"never","reach":"everything"}',
        authorityMarks: '{}',
        sourceRoomEntryId: null,
      })
    ).toBe(false);
  });
});

describe('todoRunsInDirectChat and a message', () => {
  it("keeps a to-do made from a message out of it, even the person's own", () => {
    expect(
      todoRunsInDirectChat({ authority: 'person', authorityMarks: '{}', sourceRoomEntryId: 'e1' })
    ).toBe(false);
  });
});

describe('the to-do launcher', () => {
  let db: Db;
  let port: {
    chatFor: ReturnType<typeof vi.fn<TodoDirectChatPort['chatFor']>>;
    postCardOnce: ReturnType<typeof vi.fn<TodoDirectChatPort['postCardOnce']>>;
    agentLevel: ReturnType<typeof vi.fn<TodoDirectChatPort['agentLevel']>>;
  };

  function seams() {
    return todoTurnSeams({
      db,
      meshCore: () => ({
        get: () => ({ id: 'agent-a', name: 'DorkBot', runtime: 'claude-code' }) as never,
        getProjectPath: () => '/agents/dorkbot',
      }),
      roomSessionPlace: () => PLACE,
      directChats: port,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    dispatch.mockReset();
    dispatch.mockResolvedValue({ accepted: true, canonicalId: undefined });
    port = {
      chatFor: vi.fn<TodoDirectChatPort['chatFor']>(() => CHAT),
      postCardOnce: vi.fn<TodoDirectChatPort['postCardOnce']>(),
      agentLevel: vi.fn<TodoDirectChatPort['agentLevel']>(
        async () => ({ asks: 'when-risky', reach: 'workspace' }) as never
      ),
    };
  });

  it("runs the person's own to-do in the Direct chat's session, at the agent's set level", async () => {
    const { sessionId } = await seams().launch(launchOf());
    expect(sessionId).toBe('session-dm');
    expect(port.postCardOnce).toHaveBeenCalledWith('room-dm', 'todo-1');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-dm',
        roomSessionPlace: PLACE,
        unattended: true,
        // G1 / Must 4: named, so the chat's own mode can only hold it lower.
        permissionCeiling: { asks: 'when-risky', reach: 'workspace' },
      })
    );
  });

  it('runs any other to-do in a chat of its own at its stored bound, with the card still posted', async () => {
    const { sessionId } = await seams().launch(
      launchOf({
        inDirectChat: false,
        permissionCeiling: 'runtime-default',
        carriedMarks: { outsider: true },
      })
    );
    expect(sessionId).not.toBe('session-dm');
    expect(port.postCardOnce).toHaveBeenCalledWith('room-dm', 'todo-1');
    expect(port.agentLevel).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        roomSessionPlace: undefined,
        permissionCeiling: 'runtime-default',
        carriedMarks: { outsider: true },
      })
    );
  });

  it('holds a turn whose agent level cannot be read to the stranger bound (Must 4)', async () => {
    port.agentLevel.mockResolvedValue('runtime-default');
    await seams().launch(launchOf());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ permissionCeiling: 'runtime-default' })
    );
  });

  it('still starts the turn, in a chat of its own, when no Direct chat can be made', async () => {
    port.chatFor.mockImplementation(() => {
      throw new Error('rooms are not up');
    });
    const { sessionId } = await seams().launch(launchOf());
    expect(sessionId).not.toBe('session-dm');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ roomSessionPlace: undefined }));
  });

  it('makes no chat and no card for a to-do one agent gives another', async () => {
    const { sessionId } = await seams().launch(
      launchOf({ inDirectChat: false, cardForPerson: false, permissionCeiling: 'runtime-default' })
    );
    expect(port.chatFor).not.toHaveBeenCalled();
    expect(port.postCardOnce).not.toHaveBeenCalled();
    expect(sessionId).not.toBe('session-dm');
  });

  it("still runs the person's own to-do in their Direct chat when its card fails", async () => {
    port.postCardOnce.mockImplementation(() => {
      throw new Error('the room is archived');
    });
    const { sessionId } = await seams().launch(launchOf());
    expect(sessionId).toBe('session-dm');
  });

  it("posts the card with a fixed line, never the to-do's words (G3)", () => {
    postTodoCard.mockReset();
    todoDirectChatPort(db).postCardOnce('room-dm', 'todo-1');
    expect(postTodoCard).toHaveBeenCalledWith('room-dm', {
      text: TODO_CARD_TEXT,
      todoId: 'todo-1',
    });
    expect(db.select().from(roomEntries).all()).toEqual([]);
  });
});
