/**
 * The child's proxy ctx (DOR-2686 task 4.3), driven in memory: each member
 * kind sends the message the protocol says, answers settle the right promise,
 * errors come back as the extension API's own classes, reverse calls answer
 * (and drop a cancelled answer), and the local members behave like
 * in-process (`schedule`'s 5-second floor, cancelled on stop) or fail closed
 * (`requirePerson`). The real child runs this same code in the conformance
 * suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSendError,
  InboxLimitError,
  InboxLinkError,
  StartWorkError,
} from '@dorkos/extension-api/server';
import { createProxyCtx, rebuildError } from '../child/proxy-ctx.js';
import { TOOLS_REFUSAL } from '../ctx-protocol.js';
import type { ChildMessage } from '../ipc-protocol.js';

const errors = {
  AgentSendError: AgentSendError as never,
  InboxLimitError: InboxLimitError as never,
  InboxLinkError: InboxLinkError as never,
  StartWorkError: StartWorkError as never,
};

function setup(options: { allowAgents?: boolean; failSend?: boolean } = {}) {
  const sent: ChildMessage[] = [];
  const logs: string[] = [];
  const proxy = createProxyCtx({
    send: (m) => {
      if (options.failSend) throw new Error('could not be cloned');
      sent.push(m);
    },
    init: {
      extensionId: 'ext-a',
      displayName: 'Ext A',
      allowAgents: options.allowAgents ?? false,
      ctx: {
        extensionDir: '/ext',
        dorkHome: '/dork',
        filesDir: '/dork/extension-data/ext-a/files',
      },
    },
    errors,
    log: (m) => logs.push(m),
  });
  return { ...proxy, sent, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('proxy ctx members', () => {
  // Purpose: const members carry the host's values.
  it('copies the const members', () => {
    const { ctx } = setup();
    expect(ctx.extensionId).toBe('ext-a');
    expect(ctx.extensionDir).toBe('/ext');
    expect(ctx.dorkHome).toBe('/dork');
    expect(ctx.filesDir).toBe('/dork/extension-data/ext-a/files');
  });

  // Purpose: a call is one `call` message, settled by its `ret`.
  it('turns a call into call/ret', async () => {
    const t = setup();
    const pending = t.ctx.secrets.get('k');
    expect(t.sent).toEqual([{ type: 'call', id: 1, path: 'secrets.get', args: ['k'] }]);
    t.receive({ type: 'ret', id: 1, ok: true, value: 'v' });
    await expect(pending).resolves.toBe('v');
  });

  // Purpose: errors come back as the extension API's own classes, by name,
  // with code and fields, so `err.code` and `instanceof` behave as in-process.
  it('rebuilds errors by name', () => {
    const agent = rebuildError(
      { name: 'AgentSendError', message: 'm', code: 'not_allowed' },
      errors
    );
    expect(agent).toBeInstanceOf(AgentSendError);
    expect((agent as AgentSendError).code).toBe('not_allowed');
    const limit = rebuildError(
      { name: 'InboxLimitError', message: 'm', code: 'inbox_limit', props: { limit: 'why' } },
      errors
    );
    expect(limit).toBeInstanceOf(InboxLimitError);
    expect((limit as InboxLimitError).limit).toBe('why');
    expect(
      rebuildError({ name: 'InboxLinkError', message: 'm', code: 'inbox_link' }, errors)
    ).toBeInstanceOf(InboxLinkError);
    expect(
      rebuildError({ name: 'StartWorkError', message: 'm', code: 'start_limit' }, errors)
    ).toMatchObject({
      code: 'start_limit',
    });
    const plain = rebuildError(
      { name: 'TypeError', message: 'bad', code: 'E_BAD', props: { n: 1 } },
      errors
    );
    expect(plain).toMatchObject({ name: 'TypeError', message: 'bad', code: 'E_BAD', n: 1 });
  });

  // Purpose: something the channel cannot carry fails the call with a
  // TypeError naming the member, instead of throwing out of nowhere.
  it('rejects a call whose arguments cannot be sent', async () => {
    const t = setup({ failSend: true });
    await expect(t.ctx.storage.saveData(() => 1)).rejects.toThrow(
      /ctx\.storage\.saveData got something/
    );
  });

  // Purpose: subscribe sends `sub`, events reach the listener, and the
  // returned function sends `unsub` once.
  it('subscribes, delivers events and unsubscribes', () => {
    const t = setup();
    const seen: unknown[] = [];
    const off = t.ctx.accounts.onUsage((u) => seen.push(u));
    expect(t.sent).toEqual([{ type: 'sub', id: 1, path: 'accounts.onUsage' }]);
    t.receive({ type: 'evt', id: 1, args: [{ id: 'default' }] });
    expect(seen).toEqual([{ id: 'default' }]);
    off();
    off();
    expect(t.sent.filter((m) => m.type === 'unsub')).toEqual([{ type: 'unsub', id: 1 }]);
    t.receive({ type: 'evt', id: 1, args: [{ id: 'late' }] });
    expect(seen).toHaveLength(1);
  });

  // Purpose: a gated subscribe throws synchronously without the grant, with
  // the host's words (the host refuses it too; see the dispatcher test).
  it('refuses agent.subscribe early without allow.agents', () => {
    const t = setup({ allowAgents: false });
    expect(() => t.ctx.agent.subscribe(() => {})).toThrow(AgentSendError);
    expect(t.sent).toEqual([]);
    const allowed = setup({ allowAgents: true });
    allowed.ctx.agent.subscribe(() => {});
    expect(allowed.sent).toEqual([{ type: 'sub', id: 1, path: 'agent.subscribe' }]);
  });

  // Purpose: tools.handle throws the table's reason.
  it('refuses tools.handle', () => {
    const t = setup();
    expect(() => t.ctx.tools.handle('x', async () => 1)).toThrow(TOOLS_REFUSAL);
  });
});

describe('proxy ctx reverse calls', () => {
  // Purpose: an advisor needs rank (as in-process), and its present methods
  // are what the host's proxy will have.
  it('exposes an advisor with its methods', async () => {
    const t = setup();
    expect(() => t.ctx.accounts.registerAdvisor({} as never)).toThrow(TypeError);
    t.ctx.accounts.registerAdvisor({
      rank: async () => ({ accounts: [], recommendedId: 'a' }),
      claims: () => true,
    });
    expect(t.sent).toEqual([
      { type: 'expose', id: 1, path: 'accounts.registerAdvisor', methods: ['rank', 'claims'] },
    ]);
    t.receive({ type: 'rcall', id: 10, handler: 1, method: 'rank', args: [[], {}] });
    await vi.waitFor(() => expect(t.sent.some((m) => m.type === 'rret')).toBe(true));
    expect(t.sent.at(-1)).toEqual({
      type: 'rret',
      id: 10,
      ok: true,
      value: { accounts: [], recommendedId: 'a' },
    });
  });

  // Purpose: a method the child never listed is not callable, even by a
  // host message that names it.
  it('answers an unknown method with an error', async () => {
    const t = setup();
    t.ctx.accounts.registerAdvisor({ rank: () => ({ accounts: [], recommendedId: null }) });
    t.receive({ type: 'rcall', id: 3, handler: 1, method: 'move', args: [] });
    await vi.waitFor(() => expect(t.sent.at(-1)).toMatchObject({ type: 'rret', id: 3, ok: false }));
  });

  // Purpose: a cancelled call's late answer is never sent.
  it('drops the answer of a cancelled call', async () => {
    const t = setup();
    let finish: (v: unknown) => void = () => {};
    t.ctx.inbox.onAction(() => new Promise((resolve) => (finish = resolve)) as never);
    t.receive({ type: 'rcall', id: 4, handler: 1, method: 'onAction', args: [{ key: 'k' }] });
    t.receive({ type: 'cancel', id: 4 });
    finish({ settled: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.sent.filter((m) => m.type === 'rret')).toEqual([]);
  });
});

describe('proxy ctx local members', () => {
  // Purpose: schedule clamps to 5 s, as in-process, and stop cancels it.
  it('clamps schedule to 5 s and cancels on stop', async () => {
    vi.useFakeTimers();
    const t = setup();
    const fn = vi.fn(async () => undefined);
    t.ctx.schedule(1, fn);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(1);
    t.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Purpose: requirePerson fails closed until the host verdict exists.
  it('refuses every request in requirePerson', () => {
    const t = setup();
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    t.ctx.requirePerson({} as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // Purpose: stop rejects calls still waiting and refuses new ones.
  it('rejects waiting calls on stop', async () => {
    const t = setup();
    const pending = t.ctx.storage.loadData();
    t.stop();
    await expect(pending).rejects.toThrow('stopped');
    await expect(t.ctx.storage.loadData()).rejects.toThrow('stopped');
  });
});
