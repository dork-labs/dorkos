/**
 * A boot-rearmed chat resolves the same place as an ordinary incoming message.
 * Real dispatcher, projector, runtime registry and SQLite queue; only the
 * runtime and the directory resolver are test doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';

import { logger } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  resetChatQueueResumeWarnings,
  resumeChatQueue,
} from '../../extensions/agent-send/agent-send-defaults.js';
import { initAgentPause, resetAgentPause } from '../../mesh/pause/agent-pause.js';
import type { VerifyChatAgentDeps } from '../launch/verify-chat-agent.js';
import type { ResolveChatPlaceDeps } from '../launch/resolve-chat-place.js';
import {
  listQueuedMessages,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
} from '../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, peekProjector } from '../session-state-projector.js';

const AGENT = '/demo/agents/beta';

let db: Db;
let queue: MessageQueueStore;
let runtime: FakeAgentRuntime;
let sessionId: string;

const quick = async function* (): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'reply' } };
  yield { type: 'done', data: {} };
};

beforeEach(() => {
  db = createTestDb();
  queue = new MessageQueueStore(db);
  setMessageQueueStore(queue);
  runtime = new FakeAgentRuntime('rearm-place').withScenarios([quick]);
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault(runtime.type);
  sessionId = crypto.randomUUID();
  setQueuedChatCeilingResolver(() => 'runtime-default');
  resetChatQueueResumeWarnings();
});

afterEach(async () => {
  await vi.waitFor(() => expect(runtime.isTurnOpen(sessionId)).toBe(false));
  setQueuedChatCeilingResolver(undefined);
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(sessionId);
  resetChatQueueResumeWarnings();
  resetAgentPause();
  vi.restoreAllMocks();
});

function bind(agentPath: string | null): void {
  db.insert(sessionMetadata)
    .values({
      sessionId,
      runtime: runtime.type,
      agentPath,
      createdAt: new Date().toISOString(),
    })
    .run();
}

function leaveChatRow(): void {
  queue.enqueue({
    sessionId,
    content: 'continue the work',
    clientId: 'chat:sender',
    disposition: 'queue',
    context: null,
  });
  resetMessageDispatcher();
}

function placeDeps(
  answer?: ResolveChatPlaceDeps['resolveWithRoom']
): Partial<ResolveChatPlaceDeps> {
  return {
    resolveWithRoom:
      answer ??
      (async (request) =>
        request.cwd !== undefined
          ? { cwd: request.cwd, rung: 'explicit' }
          : request.agentPath !== undefined
            ? { cwd: request.agentPath, rung: 'agent-home' }
            : { cwd: '/default', rung: 'default' }),
  };
}

function agentDeps(paths: string[] | undefined): VerifyChatAgentDeps {
  return {
    registeredAgentPaths: () => paths,
    pausedAgentOfTurn: () => undefined,
  };
}

describe('boot chat-queue place recovery', () => {
  it('runs a cold chat in its stored agent folder under the same session id', async () => {
    bind(AGENT);
    leaveChatRow();

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), agentDeps([AGENT]));

    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      sessionId,
      'continue the work',
      expect.objectContaining({ cwd: AGENT })
    );
    expect(peekProjector(sessionId)?.cwd).toBe(AGENT);
    expect(
      db
        .select()
        .from(sessionMetadata)
        .all()
        .map((row) => row.sessionId)
    ).toEqual([sessionId]);
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]));
  });

  it('prefers the folder known by the bound runtime', async () => {
    bind(AGENT);
    runtime.getSessionCwd = vi.fn(() => '/runtime/project');
    leaveChatRow();

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), agentDeps([AGENT]));

    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
    expect(runtime.sendMessage.mock.calls[0]![2]).toEqual(
      expect.objectContaining({ cwd: '/runtime/project' })
    );
  });

  it('carries a room agent and its folder grants into the recovered turn', async () => {
    bind(AGENT);
    leaveChatRow();
    const grants = [{ path: '/rooms/demo/files', access: 'write' as const }];
    const roomSessionPlace = {
      roomFor: () => ({ roomId: 'room-demo', agentName: 'Beta', agentPath: AGENT }),
      placeTurn: async () => ({
        cwd: AGENT,
        additionalDirectories: grants,
        worktree: '/rooms/demo/files',
      }),
    };
    const resolveWithRoom = vi.fn(async () => ({
      cwd: AGENT,
      rung: 'agent-home' as const,
      forAgent: AGENT,
      additionalDirectories: grants,
    }));

    await resumeChatQueue(
      sessionId,
      undefined,
      roomSessionPlace,
      placeDeps(resolveWithRoom),
      agentDeps([AGENT])
    );

    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
    expect(resolveWithRoom).toHaveBeenCalledWith(expect.any(Object), roomSessionPlace);
    expect(runtime.sendMessage.mock.calls[0]![2]).toEqual(
      expect.objectContaining({ forAgent: AGENT, additionalDirectories: grants })
    );
  });

  it('starts no turn and keeps the row when place resolution refuses', async () => {
    bind(AGENT);
    leaveChatRow();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await resumeChatQueue(
      sessionId,
      undefined,
      undefined,
      placeDeps(async () => ({
        cwd: AGENT,
        rung: 'explicit',
        refusal: { code: 'DESK_NOT_OWN', message: 'Use the agent home.' },
      })),
      agentDeps([AGENT])
    );

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(listQueuedMessages(sessionId)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      sessionId,
      refusalCode: 'DESK_NOT_OWN',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the row when its stored agent was removed from Mesh', async () => {
    bind(AGENT);
    leaveChatRow();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), agentDeps([]));

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(listQueuedMessages(sessionId)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      sessionId,
      reason: 'agent-not-registered',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the row when the registered agent moved to another folder', async () => {
    bind(AGENT);
    leaveChatRow();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await resumeChatQueue(
      sessionId,
      undefined,
      undefined,
      placeDeps(),
      agentDeps(['/demo/agents/moved-beta'])
    );

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(listQueuedMessages(sessionId)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      sessionId,
      reason: 'agent-not-registered',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the row when Mesh is unavailable for a stored agent', async () => {
    bind(AGENT);
    leaveChatRow();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), agentDeps(undefined));

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(listQueuedMessages(sessionId)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      sessionId,
      reason: 'agent-not-registered',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the row without recording a held send when its agent is paused', async () => {
    bind(AGENT);
    leaveChatRow();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const recordHeld = vi.fn();
    const pausedAgentOfTurn = vi.fn(() => ({ id: 'agent-1', name: 'Beta' }));
    initAgentPause({ pausedAgentOfTurn, recordHeld } as never);

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), {
      registeredAgentPaths: () => [AGENT],
    });

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(listQueuedMessages(sessionId)).toHaveLength(1);
    expect(pausedAgentOfTurn).toHaveBeenCalledWith({ cwd: AGENT });
    expect(recordHeld).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      sessionId,
      reason: 'agent-paused',
      agentId: 'agent-1',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once when the same refused chat is checked twice', async () => {
    bind(AGENT);
    leaveChatRow();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), agentDeps([]));
    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), agentDeps([]));

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(listQueuedMessages(sessionId)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('allows a new warning after the chat resumes successfully', async () => {
    bind(AGENT);
    leaveChatRow();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let paths: string[] = [];
    const deps: VerifyChatAgentDeps = {
      registeredAgentPaths: () => paths,
      pausedAgentOfTurn: () => undefined,
    };

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), deps);
    paths = [AGENT];
    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), deps);
    await vi.waitFor(() => expect(runtime.isTurnOpen(sessionId)).toBe(false));
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]));
    leaveChatRow();
    paths = [];
    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), deps);

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(listQueuedMessages(sessionId)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the default-folder behavior when the chat has no known place', async () => {
    bind(null);
    leaveChatRow();

    await resumeChatQueue(sessionId, undefined, undefined, placeDeps(), agentDeps(undefined));

    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1));
    expect(runtime.sendMessage.mock.calls[0]![2]).not.toHaveProperty('cwd');
  });
});
