/**
 * The host dispatcher treats an isolated child as hostile (DOR-2686 task
 * 4.3): it reaches only protocol-table members of the kind the message
 * claims, only with plain data, only within the extension's grants, sends
 * back errors without host detail, and leaves nothing registered once the
 * child is gone. A stand-in ctx records every real call, so each refusal is
 * also proven to have reached nothing.
 *
 * This module holds the stand-in ctx and the dispatcher setup the suites share.
 */
import { vi, type Mock } from 'vitest';
import { type DataProviderContext } from '@dorkos/extension-api/server';

import { CtxDispatcher } from '../../ctx-dispatcher.js';
import type { CtxChildMessage, HostMessage, RetMessage } from '../../ipc-protocol.js';

/** A ctx whose every member records its calls; listeners and handlers are kept. */
export function fakeCtx() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const listen = (key: string) =>
    vi.fn((listener: (...args: unknown[]) => void) => {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    });
  let advisor: Record<string, (...args: unknown[]) => unknown> | null = null;
  let onAction: ((event: unknown) => unknown) | null = null;
  class SecretStore {
    values = new Map<string, string>();
    async get(key: string) {
      return this.values.get(key) ?? null;
    }
    async set(key: string, value: string) {
      this.values.set(key, value);
    }
    async delete(key: string) {
      this.values.delete(key);
    }
    async has(key: string) {
      return this.values.has(key);
    }
    /** Host-only: not on the SecretStore interface, not in the table. */
    async keys() {
      return [...this.values.keys()];
    }
  }
  const secrets = new SecretStore();
  const keysSpy = vi.spyOn(secrets, 'keys');
  const ctx = {
    secrets,
    settings: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn() },
    storage: { loadData: vi.fn(async () => ({ n: 1 })), saveData: vi.fn(async () => undefined) },
    schedule: vi.fn(),
    emit: vi.fn(),
    extensionId: 'ext-a',
    extensionDir: '/x',
    dorkHome: '/d',
    filesDir: '/d/f',
    accounts: {
      list: vi.fn(async () => []),
      usage: vi.fn(async () => []),
      onUsage: listen('accounts.onUsage'),
      markContinued: vi.fn(async () => undefined),
      registerAdvisor: vi.fn((a: Record<string, (...args: unknown[]) => unknown>) => {
        advisor = a;
        return () => {
          if (advisor === a) advisor = null;
        };
      }),
    },
    projects: {
      resolve: vi.fn(),
      list: vi.fn(),
      report: vi.fn(),
      onChange: listen('projects.onChange'),
    },
    inbox: {
      raise: vi.fn(),
      resolve: vi.fn(),
      record: vi.fn(),
      list: vi.fn(),
      onAction: vi.fn((handler: (event: unknown) => unknown) => {
        onAction = handler;
        return () => {
          if (onAction === handler) onAction = null;
        };
      }),
    },
    requirePerson: vi.fn(),
    projectSettings: { get: vi.fn(), onChange: listen('projectSettings.onChange') },
    sessions: { start: vi.fn(async () => ({ sessionId: 's1' })) },
    agent: {
      send: vi.fn(async () => ({ messageId: 'm1' })),
      subscribe: listen('agent.subscribe'),
    },
    tools: { handle: vi.fn() },
  };
  return {
    ctx: ctx as unknown as DataProviderContext,
    raw: ctx,
    secrets,
    keysSpy,
    listeners,
    fire: (key: string, ...args: unknown[]) => {
      for (const listener of listeners.get(key) ?? []) listener(...args);
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    advisor: () => advisor,
    onAction: () => onAction,
  };
}

/** A dispatcher over a fake ctx, with everything it sends recorded. */
export function setup(options: { allowAgents?: boolean; slots?: number } = {}) {
  const fake = fakeCtx();
  const sent: HostMessage[] = [];
  const warnings: string[] = [];
  let inFlight = 0;
  const limit = options.slots ?? 256;
  const dispatcher = new CtxDispatcher({
    extensionId: 'ext-a',
    displayName: 'Ext A',
    ctx: fake.ctx,
    allowAgents: options.allowAgents ?? false,
    send: (m) => {
      sent.push(m);
      return true;
    },
    slots: {
      acquire: () => (inFlight < limit ? (inFlight++, true) : false),
      release: () => {
        inFlight--;
      },
    },
    logger: { warn: (m) => warnings.push(m) },
  });
  const handle = (m: CtxChildMessage) => dispatcher.handle(m);
  /** Send a call and wait for its answer. */
  const call = async (path: string, args: unknown, id = 1): Promise<RetMessage> => {
    handle({ type: 'call', id, path, args });
    await vi.waitFor(() => {
      if (!sent.some((m) => m.type === 'ret' && m.id === id)) throw new Error('no answer yet');
    });
    return sent.find((m) => m.type === 'ret' && m.id === id) as RetMessage;
  };
  return { ...fake, dispatcher, sent, warnings, handle, call, inFlight: () => inFlight };
}
