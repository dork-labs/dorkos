import { setup } from './fixtures.js';
import { describe, expect, it } from 'vitest';
import { AgentSendError } from '@dorkos/extension-api/server';
import { AGENTS_REFUSAL, CtxDispatcher, MAX_CHILD_REGISTRATIONS } from '../../ctx-dispatcher.js';

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
});

describe('CtxDispatcher connections (DOR-3547)', () => {
  // Purpose: a ctx the host built without connections refuses at the HOST,
  // with a code an extension can branch on, whatever the child sends.
  it('refuses connections.read when the real ctx has no connections', async () => {
    const t = setup();
    const ret = await t.call('connections.read', ['LINEAR_LIST_LINEAR_PROJECTS', {}]);
    expect(ret.ok).toBe(false);
    expect(ret.error).toMatchObject({ code: 'EXTENSION_CONNECTION_NOT_DECLARED' });
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
