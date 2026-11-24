import { setup } from './fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { CtxDispatcher } from '../../ctx-dispatcher.js';
import type { RetMessage } from '../../ipc-protocol.js';
import { createToolBinding } from '../../../agent-tools/tool-binding.js';

describe('CtxDispatcher reverse calls', () => {
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
});

describe('CtxDispatcher tools', () => {
  /** A dispatcher whose ctx.tools is a REAL binding over two declared tools. */
  function withTools() {
    const t = setup();
    const binding = createToolBinding('ext-a', [
      { ok: true, name: 'echo', title: 'Echo', description: 'Echoes.', tier: 'observe' } as never,
      {
        ok: false,
        name: 'bad_one',
        title: 'Bad',
        tier: 'observe',
        reason: 'its input schema has a z.record',
      },
    ]);
    (t.raw as { tools: unknown }).tools = binding.api;
    /** The host-side handler the real binding holds for a tool, once sealed. */
    const handlerOf = (name: string) => {
      const { handled } = binding.seal();
      return handled.find((h) => h.tool.name === name)?.handler;
    };
    return { ...t, binding, handlerOf };
  }

  /** Run a bound tool's host stub as the invoke wrapper would. */
  function invoke(
    handler: ((input: unknown, call: never) => unknown) | undefined,
    input: unknown,
    signal = new AbortController().signal
  ): Promise<unknown> {
    return Promise.resolve(handler!(input, Object.freeze({ signal, agentId: 'agent-1' }) as never));
  }

  // Purpose: a tool binding goes through the REAL ctx.tools.handle, and the
  // stub it binds is a round trip to the child carrying the input and the
  // calling agent's id, nothing else of the call.
  it('binds a tool through the real ctx.tools.handle and round-trips a call', async () => {
    const t = withTools();
    t.handle({ type: 'expose', id: 4, path: 'tools.handle', name: 'echo' });
    expect(t.sent).toEqual([]);
    const pending = invoke(t.handlerOf('echo'), { message: 'hi' });
    const rcall = t.sent.find((m) => m.type === 'rcall') as { id: number };
    expect(rcall).toMatchObject({
      handler: 4,
      method: 'tool',
      args: [{ message: 'hi' }, { agentId: 'agent-1' }],
    });
    t.handle({ type: 'rret', id: rcall.id, ok: true, value: { message: 'hi' } });
    await expect(pending).resolves.toEqual({ message: 'hi' });
    expect(t.dispatcher.dispatchCounts()).toMatchObject({ 'tools.handle': 1 });
  });

  // Purpose: the host's own copy of the manifest decides, whatever the child
  // claims: an undeclared or refused tool, a second binding, and a binding
  // with no name are refused with an error back, and nothing is bound. A
  // `call` to tools.handle is refused as the wrong kind.
  it('refuses a binding the real binding refuses', async () => {
    const t = withTools();
    t.handle({ type: 'expose', id: 1, path: 'tools.handle', name: 'nope' });
    t.handle({ type: 'expose', id: 2, path: 'tools.handle', name: 'bad_one' });
    t.handle({ type: 'expose', id: 3, path: 'tools.handle' });
    t.handle({ type: 'expose', id: 4, path: 'tools.handle', name: 'echo' });
    t.handle({ type: 'expose', id: 5, path: 'tools.handle', name: 'echo' });
    const errors = t.sent.filter((m) => m.type === 'ret') as RetMessage[];
    expect(errors.map((m) => m.id)).toEqual([1, 2, 3, 5]);
    expect(errors[0]!.error?.message).toMatch(/declares no tool by that name/);
    expect(errors[1]!.error?.message).toMatch(/DorkOS refused it/);
    expect(errors[3]!.error?.message).toMatch(/twice/);
    const ret = await t.call('tools.handle', ['echo'], 6);
    expect(ret.error).toMatchObject({ code: 'ERR_EXTENSION_CTX_UNKNOWN' });
    expect(t.binding.seal().handled.map((h) => h.tool.name)).toEqual(['echo']);
  });

  // Purpose: once register() finished (the binding is sealed), a late
  // binding from the child is refused by the real binding.
  it('refuses a binding after register() finished', () => {
    const t = withTools();
    t.binding.seal();
    t.handle({ type: 'expose', id: 1, path: 'tools.handle', name: 'echo' });
    const ret = t.sent.find((m) => m.type === 'ret') as RetMessage;
    expect(ret.error?.message).toMatch(/after register\(\) finished/);
  });

  // Purpose: a tool call has no bound of its own (the host wrapper's
  // deadline aborts it); when call.signal aborts, the child is told to
  // cancel and the call settles at once without waiting for it, and its
  // late answer reaches nobody.
  it('cancels on abort without waiting for the child, and sets no timer', async () => {
    vi.useFakeTimers();
    try {
      const t = withTools();
      t.handle({ type: 'expose', id: 1, path: 'tools.handle', name: 'echo' });
      const controller = new AbortController();
      let settled = false;
      const pending = invoke(t.handlerOf('echo'), {}, controller.signal).finally(() => {
        settled = true;
      });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      const rcall = t.sent.find((m) => m.type === 'rcall') as { id: number };
      controller.abort();
      await expect(pending).rejects.toThrow('Ext A: the call was cancelled.');
      expect(t.sent).toContainEqual({ type: 'cancel', id: rcall.id });
      t.handle({ type: 'rret', id: rcall.id, ok: true, value: 'late' });
      expect(t.warnings).toEqual([]);

      // Already aborted: nothing is sent at all.
      const before = t.sent.length;
      await expect(invoke(t.handlerOf('echo'), {}, AbortSignal.abort())).rejects.toThrow(
        'cancelled'
      );
      expect(t.sent).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  // Purpose: the child's answer passes the wire checks before the host
  // wrapper sees it: binary data is refused (Phase 4's rule), and an error
  // comes back as a plain Error.
  it('refuses a binary answer and rebuilds an error plainly', async () => {
    const t = withTools();
    t.handle({ type: 'expose', id: 1, path: 'tools.handle', name: 'echo' });
    const first = invoke(t.handlerOf('echo'), {});
    const second = invoke(t.handlerOf('echo'), {});
    const [r1, r2] = t.sent.filter((m) => m.type === 'rcall') as { id: number }[];
    t.handle({ type: 'rret', id: r1!.id, ok: true, value: new Uint8Array([1, 2]) });
    t.handle({ type: 'rret', id: r2!.id, ok: false, error: { message: 'boom', code: 'E_B' } });
    await expect(first).rejects.toThrow("can't use");
    await expect(second).rejects.toMatchObject({ message: 'boom', code: 'E_B' });
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
