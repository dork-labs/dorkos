/** External sidecar DATA only; the original OpenCodeRuntime owns every native turn. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { OpencodeClient, GlobalEvent, Session } from '@opencode-ai/sdk';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import { TurnEventQueue } from '../events/global-event-hub.js';
import {
  globalEvent,
  opencodeSimpleTurn,
  serverConnected,
  sessionInfo,
} from './opencode-sse-fixtures.js';

export function createOriginalOpenCodeHomeData() {
  const sessions = new Map<string, Session>();
  const prompts: { sessionId: string; cwd: string }[] = [];
  const queues = new Set<TurnEventQueue<GlobalEvent>>();
  const clients = new Map<string, OpencodeClient>();
  function requireSession(id: string) {
    const value = sessions.get(id);
    assert.ok(value, 'The external sidecar must describe an actual seeded/created session');
    return value;
  }
  const provider: OpenCodeClientProvider = {
    async getClient(cwd) {
      const present = clients.get(cwd);
      if (present) return present;
      const client = {
        global: {
          async event(options?: { signal?: AbortSignal }) {
            const queue = new TurnEventQueue<GlobalEvent>();
            queues.add(queue);
            if (options?.signal?.aborted) queue.end();
            else options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
            queue.push(globalEvent(cwd, serverConnected()));
            return { stream: queue };
          },
        },
        session: {
          async create() {
            const value = sessionInfo('ses_' + randomUUID().replaceAll('-', ''), cwd);
            sessions.set(value.id, value);
            return { data: value };
          },
          async get(input: { path: { id: string } }) {
            return { data: requireSession(input.path.id) };
          },
          async list() {
            return { data: [] };
          },
          async messages() {
            return { data: [] };
          },
          async update(input: { path: { id: string } }) {
            return { data: requireSession(input.path.id) };
          },
          async abort() {
            return { data: true };
          },
          async todo() {
            return { data: [] };
          },
          async promptAsync(input: { path: { id: string } }) {
            const value = requireSession(input.path.id);
            assert.equal(value.directory, cwd);
            assert.ok(queues.size > 0, 'Original runtime must acquire the sidecar stream first');
            prompts.push({ sessionId: value.id, cwd });
            for (const event of opencodeSimpleTurn(value.id, 'green'))
              for (const queue of queues) queue.push(globalEvent(value.directory, event));
            return {};
          },
        },
        mcp: {
          async status() {
            return { data: {} };
          },
          async add(input: { body: { name: string } }) {
            return { data: { [input.body.name]: { status: 'connected' } } };
          },
          async disconnect() {
            return { data: true };
          },
        },
        async postSessionIdPermissionsPermissionId() {
          return { data: true };
        },
        provider: {
          async list() {
            return { data: { all: [], default: {}, connected: [] } };
          },
        },
      } as unknown as OpencodeClient;
      clients.set(cwd, client);
      return client;
    },
    peekClient: () => clients.values().next().value ?? null,
    async turnSettled() {},
  };
  return {
    provider,
    prompts,
    seed(id: string, cwd: string) {
      assert.equal(sessions.has(id), false);
      sessions.set(id, sessionInfo(id, cwd));
    },
    close() {
      for (const queue of queues) queue.end();
    },
  };
}
