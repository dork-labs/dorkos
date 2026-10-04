/**
 * The host dispatcher treats an isolated child as hostile (DOR-2686 task
 * 4.3): it reaches only protocol-table members of the kind the message
 * claims, only with plain data, only within the extension's grants, sends
 * back errors without host detail, and leaves nothing registered once the
 * child is gone. A stand-in ctx records every real call, so each refusal is
 * also proven to have reached nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentSendError, type DataProviderContext } from '@dorkos/extension-api/server';
import { flatten } from '../ctx-protocol.js';
import {
  AGENTS_REFUSAL,
  CtxDispatcher,
  MAX_CHILD_REGISTRATIONS,
  REVERSE_BINDERS,
  toWireError,
} from '../ctx-dispatcher.js';
import type { CtxChildMessage, HostMessage, RetMessage } from '../ipc-protocol.js';

/** A ctx whose every member records its calls; listeners and handlers are kept. */
function fakeCtx() {
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
function setup(options: { allowAgents?: boolean; slots?: number } = {}) {
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

describe('CtxDispatcher calls', () => {
  // Purpose: a table call reaches the real method, with the real object as
  // `this` (the secret store is a class), and the value comes back.
  it('runs a table call through the real ctx', async () => {
    const t = setup();
    await t.call('secrets.set', ['k', 'v'], 1);
    const ret = await t.call('secrets.get', ['k'], 2);
    expect(ret).toEqual({ type: 'ret', id: 2, ok: true, value: 'v' });
    expect(t.dispatcher.dispatchCounts()).toMatchObject({ 'secrets.set': 1, 'secrets.get': 1 });
    expect(t.inFlight()).toBe(0);
  });

  // Purpose: nothing outside the table is reachable, including prototype
  // keys, inherited methods, and a real host method the table leaves out.
  it.each([
    'secrets.keys',
    '__proto__',
    'constructor',
    'secrets.constructor',
    'secrets.__proto__',
    'toString',
    'secrets.get.call',
    'inbox.raise.apply',
    'process.exit',
    'storage',
    'extensionId',
  ])('refuses a call to %j and reaches nothing', async (p) => {
    const t = setup();
    const ret = await t.call(p, []);
    expect(ret.ok).toBe(false);
    expect(ret.error?.code).toBe('ERR_EXTENSION_CTX_UNKNOWN');
    // The child's path is never echoed back.
    expect(ret.error?.message).toBe("That isn't something an isolated extension's ctx can do.");
    expect(t.keysSpy).not.toHaveBeenCalled();
    expect(t.dispatcher.dispatchCounts()).toEqual({});
  });

  // Purpose: a message's kind must match the table: a `call` cannot register
  // a listener, a `sub` cannot invoke a method, an `expose` cannot call.
  it('refuses a kind that does not match the table', async () => {
    const t = setup();
    expect((await t.call('accounts.onUsage', [], 1)).ok).toBe(false);
    expect((await t.call('accounts.registerAdvisor', [], 2)).ok).toBe(false);
    t.handle({ type: 'sub', id: 3, path: 'secrets.get' });
    t.handle({ type: 'expose', id: 4, path: 'storage.saveData', methods: ['rank'] });
    const refused = t.sent
      .filter((m) => m.type === 'ret' && !m.ok)
      .map((m) => (m as RetMessage).id);
    expect(refused).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(t.raw.accounts.onUsage).not.toHaveBeenCalled();
    expect(t.raw.storage.saveData).not.toHaveBeenCalled();
    expect(t.raw.accounts.registerAdvisor).not.toHaveBeenCalled();
  });

  // Purpose: arguments must be a short array of plain data. Each shape below
  // can arrive over the advanced-serialization channel (or is built to show
  // the rule), and none reaches the real method.
  it.each([
    ['a non-array', { 0: 'k' }],
    ['a string', 'k'],
    ['too many', Array.from({ length: 9 }, () => 'x')],
    ['a __proto__ key', [JSON.parse('{"__proto__": {"polluted": true}}')]],
    ['a nested __proto__ key', [{ a: [JSON.parse('{"__proto__": 1}')] }]],
    ['a Map', [new Map([['a', 1]])]],
    ['a Set', [new Set([1])]],
    ['a class instance', [new (class Evil {})()]],
    ['an Error', [new Error('x')]],
    ['a RegExp', [/x/]],
    ['a function', [() => 1]],
    ['a symbol', [Symbol('x')]],
    ['an accessor', [Object.defineProperty({}, 'x', { get: () => 1, enumerable: true })]],
    [
      'a cycle',
      (() => {
        const a: Record<string, unknown> = {};
        a.self = a;
        return [a];
      })(),
    ],
    [
      'deep nesting',
      (() => {
        let v: unknown = 'x';
        for (let i = 0; i < 40; i++) v = [v];
        return [v];
      })(),
    ],
  ])('refuses %s as arguments', async (_label, args) => {
    const t = setup();
    const ret = await t.call('storage.saveData', args);
    expect(ret.ok).toBe(false);
    expect(t.raw.storage.saveData).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // Purpose: shapes that are tiny on the channel but huge once the host uses
  // them (review blocker): a sparse array with a 90-million length, and one
  // 1.5 MB string shared by 16,000 references (3 MB on the wire, 48 GB of
  // JSON). Each is refused fast, before the real method (whose
  // JSON.stringify would block the host for seconds) is reached.
  it.each([
    [
      'a sparse array',
      () => {
        const a: unknown[] = [];
        a.length = 9e7;
        return [a];
      },
    ],
    [
      'an array with one hole',
      () => {
        const a: unknown[] = [1, 2, 3];
        delete a[1];
        return [a];
      },
    ],
    ['a shared-reference DAG', () => [new Array(16_000).fill({ t: 'x'.repeat(1.5e6) })]],
    ['a long dense array', () => [new Array(60_000).fill(0)]],
  ])('refuses %s quickly and reaches nothing', async (_label, build) => {
    const t = setup();
    const args = build();
    const began = performance.now();
    const ret = await t.call('storage.saveData', args);
    expect(performance.now() - began).toBeLessThan(500);
    expect(ret.ok).toBe(false);
    expect(t.raw.storage.saveData).not.toHaveBeenCalled();
  });

  // Purpose: the expanded budget also guards what the child answers to a
  // reverse call, and event payloads forwarded to it.
  it('applies the expanded budget to answers and events', async () => {
    const t = setup();
    t.handle({ type: 'expose', id: 1, path: 'inbox.onAction' });
    const pending = t.onAction()!({ key: 'a' }) as Promise<unknown>;
    const rcall = t.sent.find((m) => m.type === 'rcall') as { id: number };
    const shared = { t: 'x'.repeat(1.5e6) };
    t.handle({ type: 'rret', id: rcall.id, ok: true, value: new Array(16_000).fill(shared) });
    await expect(pending).rejects.toThrow("can't use");
    t.handle({ type: 'sub', id: 2, path: 'accounts.onUsage' });
    t.fire('accounts.onUsage', new Array(16_000).fill(shared));
    expect(t.sent.filter((m) => m.type === 'evt')).toEqual([]);
  });

  // Purpose: the host's OWN answer has no size budget, as in-process (an
  // extension may keep more than 4 MB in storage); only the child's data does.
  it('sends a large answer the real ctx produced', async () => {
    const t = setup();
    const big = { blob: 'y'.repeat(3e6), rows: new Array(60_000).fill(1) };
    t.raw.storage.loadData.mockResolvedValueOnce(big as never);
    const ret = await t.call('storage.loadData', []);
    expect(ret.ok).toBe(true);
  });

  // Purpose: plain data that merely uses awkward key names still works, so
  // the rule is about prototypes, not about names.
  it('accepts plain data with constructor/prototype keys, Dates and bytes', async () => {
    const t = setup();
    const data = { constructor: 'c', prototype: 1, when: new Date(0), bytes: new Uint8Array(2) };
    const ret = await t.call('storage.saveData', [data]);
    expect(ret.ok).toBe(true);
    expect(t.raw.storage.saveData).toHaveBeenCalledWith(data);
  });

  // Purpose: the 256-call limit (shared with the program broker) refuses
  // rather than queues, and reaches nothing.
  it('refuses a call when no slot is free', async () => {
    const t = setup({ slots: 0 });
    const ret = await t.call('storage.loadData', []);
    expect(ret.error).toMatchObject({ code: 'ERR_EXTENSION_TOO_MANY_CALLS' });
    expect(t.raw.storage.loadData).not.toHaveBeenCalled();
  });

  // Purpose: an answer that is not plain data never reaches the child.
  it('refuses to send an answer that is not plain data', async () => {
    const t = setup();
    t.raw.storage.loadData.mockResolvedValueOnce(new Map() as never);
    const ret = await t.call('storage.loadData', []);
    expect(ret.ok).toBe(false);
  });
});

describe('CtxDispatcher errors', () => {
  // Purpose: an error crosses as name, redacted message, code and primitive
  // fields: never a stack, never a host path, never fs detail fields.
  it('strips host detail from errors', async () => {
    const t = setup();
    const err = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open '/Users/kai/.dork/extension-data/x/data.json'"
      ),
      {
        code: 'ENOENT',
        path: '/Users/kai/.dork/extension-data/x/data.json',
        syscall: 'open',
        errno: -2,
        limit: 'why',
        nested: { a: 1 },
      }
    );
    t.raw.storage.saveData.mockRejectedValueOnce(err);
    const ret = await t.call('storage.saveData', [{}]);
    expect(ret.ok).toBe(false);
    const json = JSON.stringify(ret.error);
    expect(json).not.toContain('/Users');
    expect(json).not.toContain('.dork');
    expect(json).not.toContain('at ');
    expect(ret.error).toEqual({
      name: 'Error',
      message: expect.stringContaining('<path>'),
      code: 'ENOENT',
      props: { limit: 'why' },
    });
  });

  // Purpose: a hostile name is not trusted, and a non-Error throw is safe.
  it('normalises odd throws', () => {
    expect(toWireError(Object.assign(new Error('x'), { name: '__proto__<script>' })).name).toBe(
      'Error'
    );
    expect(toWireError('C:\\Users\\kai\\x failed').message).toBe('<path> failed');
    expect(toWireError(undefined)).toEqual({ name: 'Error', message: 'Something went wrong.' });
  });

  // Purpose: an AgentSendError's class name and code survive, so the child
  // can rebuild the class.
  it('keeps an AgentSendError recognisable', async () => {
    const t = setup({ allowAgents: true });
    t.raw.agent.send.mockRejectedValueOnce(new AgentSendError('not_found', 'No such agent.'));
    const ret = await t.call('agent.send', [{ to: 'x', text: 'y' }]);
    expect(ret.error).toMatchObject({ name: 'AgentSendError', code: 'not_found' });
  });
});

describe('CtxDispatcher allow.agents', () => {
  // Purpose: without the grant, agent.send is refused at the HOST with the
  // spec's AgentSendError, and the real method never runs.
  it('refuses agent.send without allow.agents', async () => {
    const t = setup({ allowAgents: false });
    const ret = await t.call('agent.send', [{ to: 'x', text: 'y' }]);
    expect(ret.error).toMatchObject({
      name: 'AgentSendError',
      code: 'not_allowed',
      message: AGENTS_REFUSAL,
    });
    expect(t.raw.agent.send).not.toHaveBeenCalled();
  });

  // Purpose: sessions.start gets a plain Error with the same words.
  it('refuses sessions.start without allow.agents', async () => {
    const t = setup({ allowAgents: false });
    const ret = await t.call('sessions.start', [{ project: '/p', prompt: 'x' }]);
    expect(ret.error).toEqual({ name: 'Error', message: AGENTS_REFUSAL });
    expect(t.raw.sessions.start).not.toHaveBeenCalled();
  });

  // Purpose: agent.subscribe is gated like a call.
  it('refuses agent.subscribe without allow.agents', () => {
    const t = setup({ allowAgents: false });
    t.handle({ type: 'sub', id: 7, path: 'agent.subscribe' });
    expect(t.sent).toEqual([expect.objectContaining({ type: 'ret', id: 7, ok: false })]);
    expect(t.listenerCount()).toBe(0);
  });

  // Purpose: with the grant, all three go through (the refusals above are
  // about the grant, not broken plumbing).
  it('allows them with allow.agents', async () => {
    const t = setup({ allowAgents: true });
    expect((await t.call('agent.send', [{ to: 'x', text: 'y' }], 1)).ok).toBe(true);
    expect((await t.call('sessions.start', [{ project: '/p', prompt: 'x' }], 2)).value).toEqual({
      sessionId: 's1',
    });
    t.handle({ type: 'sub', id: 3, path: 'agent.subscribe' });
    expect(t.listenerCount()).toBe(1);
  });
});

describe('CtxDispatcher subscriptions', () => {
  // Purpose: a listener forwards events as evt; unsub removes it on the real ctx.
  it('forwards events and removes the listener on unsub', () => {
    const t = setup();
    t.handle({ type: 'sub', id: 5, path: 'accounts.onUsage' });
    t.fire('accounts.onUsage', { runtime: 'claude-code', id: 'default' });
    expect(t.sent).toContainEqual({
      type: 'evt',
      id: 5,
      args: [{ runtime: 'claude-code', id: 'default' }],
    });
    t.handle({ type: 'unsub', id: 5 });
    expect(t.listenerCount()).toBe(0);
  });

  // Purpose: a reused id cannot orphan an earlier registration, and the
  // number one child may hold is capped.
  it('refuses a reused id and caps registrations', () => {
    const t = setup();
    t.handle({ type: 'sub', id: 1, path: 'projects.onChange' });
    t.handle({ type: 'sub', id: 1, path: 'projects.onChange' });
    expect(t.listenerCount()).toBe(1);
    for (let i = 2; i <= MAX_CHILD_REGISTRATIONS + 5; i++) {
      t.handle({ type: 'sub', id: i, path: 'projects.onChange' });
    }
    expect(t.listenerCount()).toBe(MAX_CHILD_REGISTRATIONS);
    expect(t.dispatcher.registrations).toBe(MAX_CHILD_REGISTRATIONS);
  });

  // Purpose: when the child dies, every listener leaves the real ctx, and a
  // late event (fired through a listener reference kept elsewhere) sends nothing.
  it('releases every listener on close and sends nothing after', () => {
    const t = setup();
    t.handle({ type: 'sub', id: 1, path: 'accounts.onUsage' });
    t.handle({ type: 'sub', id: 2, path: 'projectSettings.onChange' });
    const kept = [...(t.listeners.get('accounts.onUsage') ?? [])][0]!;
    t.dispatcher.close();
    expect(t.listenerCount()).toBe(0);
    const before = t.sent.length;
    kept({ late: true });
    expect(t.sent.length).toBe(before);
    // Messages after close reach nothing.
    t.handle({ type: 'sub', id: 3, path: 'accounts.onUsage' });
    t.handle({ type: 'call', id: 4, path: 'storage.loadData', args: [] });
    expect(t.listenerCount()).toBe(0);
    expect(t.raw.storage.loadData).not.toHaveBeenCalled();
    expect(t.sent.length).toBe(before);
  });

  // Purpose: an event payload that is not plain data is not forwarded.
  it('drops an event that is not plain data', () => {
    const t = setup();
    t.handle({ type: 'sub', id: 1, path: 'accounts.onUsage' });
    t.fire('accounts.onUsage', () => 1);
    expect(t.sent.filter((m) => m.type === 'evt')).toEqual([]);
  });
});

describe('CtxDispatcher reverse calls', () => {
  // Purpose: every reverse member in the table has a host binder, so the
  // table cannot gain one the host does not carry.
  it('has a binder for every reverse table entry', () => {
    const reverse = flatten()
      .filter((leaf) => leaf.kind.kind === 'reverse')
      .map((leaf) => leaf.path);
    expect(Object.keys(REVERSE_BINDERS).sort()).toEqual(reverse.sort());
  });

  // Purpose: the host's proxy advisor has exactly the methods the child
  // listed, each a round trip; core's own bound then applies unchanged.
  it('registers a proxy advisor with exactly the listed methods', async () => {
    const t = setup();
    t.handle({
      type: 'expose',
      id: 9,
      path: 'accounts.registerAdvisor',
      methods: ['rank', 'claims'],
    });
    const advisor = t.advisor()!;
    expect(Object.keys(advisor).sort()).toEqual(['claims', 'rank']);
    const answer = advisor.rank!([], { purpose: 'launch' });
    const rcall = t.sent.find((m) => m.type === 'rcall');
    expect(rcall).toMatchObject({ handler: 9, method: 'rank', args: [[], { purpose: 'launch' }] });
    t.handle({
      type: 'rret',
      id: (rcall as { id: number }).id,
      ok: true,
      value: { recommendedId: null, accounts: [] },
    });
    await expect(answer).resolves.toEqual({ recommendedId: null, accounts: [] });
  });

  // Purpose: an advisor method list must be advisor methods, with rank,
  // without repeats; anything else registers nothing.
  it.each([
    ['no rank', ['claims']],
    ['an unknown method', ['rank', 'constructor']],
    ['a prototype key', ['rank', '__proto__']],
    ['a repeat', ['rank', 'rank']],
    ['not a list', 'rank'],
    ['nothing', undefined],
  ])('refuses an advisor with %s', (_label, methods) => {
    const t = setup();
    t.handle({ type: 'expose', id: 1, path: 'accounts.registerAdvisor', methods });
    expect(t.advisor()).toBeNull();
    expect(t.sent).toEqual([expect.objectContaining({ type: 'ret', id: 1, ok: false })]);
    expect(t.dispatcher.registrations).toBe(0);
  });

  // Purpose: a child that never answers is cancelled and rejected at the
  // bound, and its late answer is ignored.
  it('cancels a reverse call at its bound', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.handle({ type: 'expose', id: 1, path: 'inbox.onAction' });
      const pending = t.onAction()!({ key: 'k' }) as Promise<unknown>;
      const rejected = expect(pending).rejects.toThrow("Ext A didn't answer in time.");
      await vi.advanceTimersByTimeAsync(5_000 + 300);
      await rejected;
      const rcall = t.sent.find((m) => m.type === 'rcall') as { id: number };
      expect(t.sent).toContainEqual({ type: 'cancel', id: rcall.id });
      t.handle({ type: 'rret', id: rcall.id, ok: true, value: { settled: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Purpose: the child's answer must be plain data too; its error comes
  // back as a plain host Error.
  it('checks answers and rebuilds child errors plainly', async () => {
    const t = setup();
    t.handle({ type: 'expose', id: 1, path: 'inbox.onAction' });
    const first = t.onAction()!({ key: 'a' }) as Promise<unknown>;
    const second = t.onAction()!({ key: 'b' }) as Promise<unknown>;
    const [r1, r2] = t.sent.filter((m) => m.type === 'rcall') as { id: number }[];
    t.handle({ type: 'rret', id: r1!.id, ok: true, value: JSON.parse('{"__proto__": {"x": 1}}') });
    t.handle({ type: 'rret', id: r2!.id, ok: false, error: { message: 'nope', code: 'E_X' } });
    await expect(first).rejects.toThrow("can't use");
    await expect(second).rejects.toMatchObject({ message: 'nope', code: 'E_X' });
  });

  // Purpose: a dead child leaves no advisor or handler behind, and every
  // waiting call is rejected at once (so core falls back immediately).
  it('removes reverse handlers and rejects waiting calls on close', async () => {
    const t = setup();
    t.handle({ type: 'expose', id: 1, path: 'accounts.registerAdvisor', methods: ['rank'] });
    t.handle({ type: 'expose', id: 2, path: 'inbox.onAction' });
    const pending = t.advisor()!.rank!([], {}) as Promise<unknown>;
    t.dispatcher.close();
    await expect(pending).rejects.toThrow('Ext A stopped.');
    expect(t.advisor()).toBeNull();
    expect(t.onAction()).toBeNull();
  });

  // Purpose: re-registering a replacing member (an advisor, an action
  // handler) frees the replaced entry, so it cannot exhaust the limit, and
  // the newest registration stays live on the real ctx.
  it('forgets replaced reverse handlers', () => {
    const t = setup();
    for (let i = 1; i <= MAX_CHILD_REGISTRATIONS + 10; i++) {
      t.handle({ type: 'expose', id: i, path: 'inbox.onAction' });
    }
    expect(t.dispatcher.registrations).toBe(1);
    expect(t.onAction()).not.toBeNull();
    expect(t.sent.filter((m) => m.type === 'ret')).toEqual([]);
    t.handle({ type: 'unexpose', id: MAX_CHILD_REGISTRATIONS + 10 });
    expect(t.onAction()).toBeNull();
  });

  // Purpose: tools.handle is refused until tools cross the boundary, by
  // every message kind.
  it('refuses tools.handle', async () => {
    const t = setup();
    const ret = await t.call('tools.handle', ['x'], 1);
    expect(ret.error).toMatchObject({ code: 'ERR_EXTENSION_CTX_REFUSED' });
    t.handle({ type: 'expose', id: 2, path: 'tools.handle' });
    expect(t.raw.tools.handle).not.toHaveBeenCalled();
  });
});

describe('CtxDispatcher emit', () => {
  // Purpose: emit goes through the real ctx.emit (which namespaces by the
  // real id); bad names and non-plain data are dropped.
  it('emits through the real ctx and drops bad events', () => {
    const t = setup();
    t.handle({ type: 'emit', event: 'tick', data: { n: 1 } });
    t.handle({ type: 'emit', event: '', data: 1 });
    t.handle({ type: 'emit', event: 'x'.repeat(201), data: 1 });
    t.handle({ type: 'emit', event: 'bad\nname', data: 1 });
    t.handle({ type: 'emit', event: 'ok', data: new Map() });
    expect(t.raw.emit).toHaveBeenCalledTimes(1);
    expect(t.raw.emit).toHaveBeenCalledWith('tick', { n: 1 });
  });
});
