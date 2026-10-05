/**
 * The child's proxy ctx (DOR-2686 task 4.3), driven in memory: each member
 * kind sends the message the protocol says, answers settle the right promise,
 * errors come back as the extension API's own classes, reverse calls answer
 * (and drop a cancelled answer), and the local members behave like
 * in-process (`schedule`'s 5-second floor, cancelled on stop) or read the
 * host's verdict and fail closed without one (`requirePerson`). The real child runs this same code in the conformance
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
import { createToolBinding } from '../../agent-tools/tool-binding.js';
import type { ToolHandleCheck } from '../../agent-tools/tool-handle-rules.js';
import { PERSON_VERDICT_HEADER, type ChildMessage } from '../ipc-protocol.js';

const PERSON_REFUSAL = {
  error: "Only a person can change Ext A's settings.",
  code: 'extension_person_required',
  message: 'Ask them to do it in DorkOS.',
};

const errors = {
  AgentSendError: AgentSendError as never,
  InboxLimitError: InboxLimitError as never,
  InboxLinkError: InboxLinkError as never,
  StartWorkError: StartWorkError as never,
};

/** The manifest's tools as `init` carries them: two accepted, one refused. */
const TOOLS: ToolHandleCheck[] = [
  { name: 'echo', ok: true },
  { name: 'count', ok: true },
  { name: 'bad_one', ok: false, reason: 'its input schema has a z.record' },
];

function setup(
  options: { allowAgents?: boolean; failSend?: boolean; tools?: ToolHandleCheck[] } = {}
) {
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
      personRefusal: PERSON_REFUSAL,
      tools: options.tools ?? TOOLS,
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

  // Purpose: tools.handle refuses exactly what the in-process binding
  // refuses, with the same words (one rule module, both runtimes): an
  // undeclared name, a refused tool, a second handler, a non-function, and a
  // call after register() finished. A refused binding sends nothing.
  it('refuses a bad tool binding with the in-process words', () => {
    const t = setup();
    const inProcess = createToolBinding('ext-a', [
      {
        ok: true,
        name: 'echo',
        title: 'Echo',
        description: 'Echoes.',
        tier: 'observe',
      } as never,
      { ok: true, name: 'count', title: 'Count', description: 'Counts.', tier: 'act' } as never,
      {
        ok: false,
        name: 'bad_one',
        title: 'Bad',
        tier: 'observe',
        reason: 'its input schema has a z.record',
      },
    ]);
    const words = (fn: () => void): string => {
      try {
        fn();
      } catch (err) {
        return `${(err as Error).name}: ${(err as Error).message}`;
      }
      return 'no error';
    };
    const cases: Array<[string, unknown]> = [
      ['nope', () => 1],
      ['bad_one', () => 1],
      ['echo', 'not a function'],
    ];
    for (const [name, handler] of cases) {
      const child = words(() => t.ctx.tools.handle(name, handler as never));
      expect(child).not.toBe('no error');
      expect(child).toBe(words(() => inProcess.api.handle(name, handler as never)));
    }
    expect(t.sent).toEqual([]);

    t.ctx.tools.handle('echo', () => 1);
    inProcess.api.handle('echo', () => 1);
    const twice = words(() => t.ctx.tools.handle('echo', () => 2));
    expect(twice).toMatch(/twice/);
    expect(twice).toBe(words(() => inProcess.api.handle('echo', () => 2)));

    expect(t.sealTools()).toEqual(['echo']);
    inProcess.seal();
    const late = words(() => t.ctx.tools.handle('count', () => 1));
    expect(late).toMatch(/after register\(\) finished/);
    expect(late).toBe(words(() => inProcess.api.handle('count', () => 1)));
    expect(t.sent).toHaveLength(1);
  });

  // Purpose: a tool binding is one expose naming the tool, and the host's
  // rcall reaches the handler with the in-process call shape: the input, an
  // AbortSignal for this call, and the calling agent's id.
  it('exposes a tool and runs it with a signal and the agent id', async () => {
    const t = setup();
    let seen: { input: unknown; agentId: unknown; signal: unknown } | null = null;
    t.ctx.tools.handle('echo', (input, call) => {
      seen = { input, agentId: call.agentId, signal: call.signal };
      return { got: input };
    });
    expect(t.sent).toEqual([{ type: 'expose', id: 1, path: 'tools.handle', name: 'echo' }]);
    t.receive({
      type: 'rcall',
      id: 7,
      handler: 1,
      method: 'tool',
      args: [{ message: 'hi' }, { agentId: 'agent-9' }],
    });
    await vi.waitFor(() => expect(t.sent).toHaveLength(2));
    expect(t.sent[1]).toEqual({ type: 'rret', id: 7, ok: true, value: { got: { message: 'hi' } } });
    expect(seen!.input).toEqual({ message: 'hi' });
    expect(seen!.agentId).toBe('agent-9');
    expect(seen!.signal).toBeInstanceOf(AbortSignal);

    // An agent id that is not a string reads as unknown (null), as in-process.
    t.receive({ type: 'rcall', id: 8, handler: 1, method: 'tool', args: [{}, { agentId: 5 }] });
    await vi.waitFor(() => expect(t.sent).toHaveLength(3));
    expect(seen!.agentId).toBeNull();
  });

  // Purpose: the host's cancel aborts the handler's call.signal (the
  // deadline, a cancelled turn or a stop all arrive this way), and the
  // answer the handler gives afterwards is never sent.
  it('aborts the tool call signal on cancel and drops its answer', async () => {
    const t = setup();
    let signal: AbortSignal | null = null;
    let finish: (value: unknown) => void = () => {};
    t.ctx.tools.handle('echo', (_input, call) => {
      signal = call.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    t.receive({ type: 'rcall', id: 3, handler: 1, method: 'tool', args: [{}, { agentId: null }] });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    expect(signal!.aborted).toBe(false);
    t.receive({ type: 'cancel', id: 3 });
    expect(signal!.aborted).toBe(true);
    finish('late');
    await new Promise((r) => setTimeout(r, 10));
    expect(t.sent.filter((m) => m.type === 'rret')).toEqual([]);
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

  /** Run requirePerson on a request carrying `header` as the verdict. */
  function person(header: string | undefined) {
    const t = setup();
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    const headers = header === undefined ? {} : { [PERSON_VERDICT_HEADER]: header };
    t.ctx.requirePerson({ headers } as never, res as never, next);
    return { res, next };
  }

  // Purpose: the host's yes lets the request through, and only a yes does.
  it('lets a person through on the host verdict', () => {
    const { res, next } = person(JSON.stringify({ ok: true }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // Purpose: the host's refusal is answered word for word.
  it('answers the host refusal as is', () => {
    const body = { error: 'e', code: 'operator_cookie_required', message: 'm' };
    const { res, next } = person(JSON.stringify({ ok: false, status: 401, body }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(body);
  });

  // Purpose: fail closed — no verdict, an unreadable one, or one with a
  // status outside 4xx/5xx refuses with the in-process agent refusal.
  it.each([
    ['missing', undefined],
    ['not JSON', '{ok:true'],
    ['a 200 refusal', JSON.stringify({ ok: false, status: 200, body: PERSON_REFUSAL })],
    ['a truthy non-boolean', JSON.stringify({ ok: 'yes' })],
  ])('refuses when the verdict is %s', (_label, header) => {
    const { res, next } = person(header);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(PERSON_REFUSAL);
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
