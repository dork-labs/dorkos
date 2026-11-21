/** Script only the OpenCode SDK/network edge; runtime authority remains real. */
import { vi } from 'vitest';
import type { GlobalEvent, OpencodeClient } from '@opencode-ai/sdk';
import { TurnEventQueue } from '../../events/global-event-hub.js';
import {
  globalEvent,
  serverConnected,
  sessionIdle,
  sessionInfo,
} from '../opencode-sse-fixtures.js';

/** Push-controlled SDK stream and deterministic session/MCP responses. */
export function scriptedSidecar(directory: string) {
  const connections: TurnEventQueue<GlobalEvent>[] = [];
  const sessions = new Map<string, ReturnType<typeof sessionInfo>>();
  const servers: Record<string, { status: 'connected' }> = {};
  const emit = (payload: Parameters<typeof globalEvent>[1]) => {
    for (const queue of connections) queue.push(globalEvent(directory, payload));
  };
  const client = {
    global: {
      event: vi.fn(async (options?: { signal?: AbortSignal }) => {
        const queue = new TurnEventQueue<GlobalEvent>();
        options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
        connections.push(queue);
        queue.push(globalEvent(directory, serverConnected()));
        return { stream: queue };
      }),
    },
    app: { agents: vi.fn(async () => ({ data: [] })) },
    session: {
      create: vi.fn(async () => {
        const session = sessionInfo('ses_owned' + (sessions.size + 1), directory);
        sessions.set(session.id, session);
        return { data: session };
      }),
      get: vi.fn(async ({ path }: { path: { id: string } }) => ({ data: sessions.get(path.id) })),
      list: vi.fn(async () => ({ data: [...sessions.values()] })),
      messages: vi.fn(async () => ({ data: [] })),
      update: vi.fn(async ({ path }: { path: { id: string } }) => ({
        data: sessions.get(path.id),
      })),
      promptAsync: vi.fn(async () => ({})),
      abort: vi.fn(async ({ path }: { path: { id: string } }) => {
        emit(sessionIdle(path.id));
        return { data: true };
      }),
      todo: vi.fn(async () => ({ data: [] })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    provider: { list: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })) },
    mcp: {
      status: vi.fn(async () => ({ data: { ...servers } })),
      add: vi.fn(async ({ body }: { body: { name: string } }) => {
        servers[body.name] = { status: 'connected' };
        return { data: { [body.name]: servers[body.name] } };
      }),
      disconnect: vi.fn(async () => ({ data: true })),
    },
    config: { get: vi.fn(async () => ({ data: {} })) },
  };
  return {
    client,
    sdk: client as unknown as OpencodeClient,
    emit,
    end: () => connections.forEach((q) => q.end()),
  };
}
