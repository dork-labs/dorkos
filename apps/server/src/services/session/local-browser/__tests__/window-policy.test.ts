import { EventEmitter } from 'node:events';
import type { CDPSession, Page } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { ChatWindowPolicy } from '../chat/window-policy.js';

function fixture() {
  const events = new EventEmitter();
  const session = (ids: number[]) => {
    const events = new EventEmitter();
    const send = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
      if (method === 'Runtime.enable') {
        for (const id of ids)
          events.emit('Runtime.executionContextCreated', {
            context: { id, auxData: { isDefault: true } },
          });
        events.emit('Runtime.executionContextCreated', {
          context: { id: 99, auxData: { isDefault: false } },
        });
      }
      return { result: { type: 'undefined' } };
    });
    const detach = vi.fn(async () => undefined);
    return {
      events,
      send,
      detach,
      value: { on: events.on.bind(events), send, detach } as unknown as CDPSession,
    };
  };
  const root = session([1, 2]); // A same-process iframe shares its parent's CDP session.
  const child = session([3]);
  const mainFrame = {};
  const sameProcess = {};
  const isolated = {};
  const context = {
    newCDPSession: vi.fn(async (target: unknown) => {
      if (target === sameProcess)
        throw new Error(
          "This frame does not have a separate CDP session, it is a part of the parent frame's session"
        );
      return target === isolated ? child.value : root.value;
    }),
  };
  const page = {
    context: () => context,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, sameProcess, isolated],
    on: events.on.bind(events),
    off: events.off.bind(events),
    addInitScript: vi.fn(async () => undefined),
    exposeBinding: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
  } as unknown as Page;
  const blocked = vi.fn();
  const policy = new ChatWindowPolicy(page);
  return { policy, blocked, page, root, child, events, context };
}

it('installs and updates every main-world document without granting activation', async () => {
  const f = fixture();
  await f.policy.install(f.blocked);
  await f.policy.setHeld(true);
  await f.policy.setHeld(false);
  expect(f.page.evaluate).not.toHaveBeenCalled();
  expect(f.page.exposeBinding).not.toHaveBeenCalled();
  for (const [session, ids] of [
    [f.root, [1, 2]],
    [f.child, [3]],
  ] as const) {
    const evaluations = session.send.mock.calls.filter(([method]) => method === 'Runtime.evaluate');
    expect(evaluations.length).toBeGreaterThanOrEqual(ids.length * 3);
    for (const call of evaluations)
      expect(call[1]).toMatchObject({ userGesture: false, returnByValue: true });
    expect(
      new Set(evaluations.map((call) => (call[1] as { contextId: number }).contextId))
    ).toEqual(new Set(ids));
  }
});

it('restores a taken policy after navigation without page or frame evaluation', async () => {
  const f = fixture();
  await f.policy.install(f.blocked);
  await f.policy.setHeld(true);
  f.root.send.mockClear();
  f.root.events.emit('Runtime.executionContextsCleared');
  f.root.events.emit('Runtime.executionContextCreated', {
    context: { id: 4, auxData: { isDefault: true } },
  });
  await vi.waitFor(() =>
    expect(f.root.send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        contextId: 4,
        userGesture: false,
        expression: expect.stringContaining('(true)'),
      }),
      { timeout: 3000 }
    )
  );
  expect(f.page.evaluate).not.toHaveBeenCalled();
});

it('reports a denial through a one-way binding without an evaluated reply', async () => {
  const f = fixture();
  await f.policy.install(f.blocked);
  const binding = f.root.send.mock.calls.find(
    ([method]) => method === 'Runtime.addBinding'
  )?.[1] as { name: string };
  expect(binding).toBeDefined();
  f.root.send.mockClear();
  f.root.events.emit('Runtime.bindingCalled', {
    name: binding.name,
    executionContextId: 1,
    payload: '',
  });
  expect(f.blocked).toHaveBeenCalledOnce();
  expect(f.root.send).not.toHaveBeenCalled();
});

it('detaches owned policy sessions when the page closes', async () => {
  const f = fixture();
  await f.policy.install(f.blocked);
  f.events.emit('close');
  await vi.waitFor(() => expect(f.root.detach).toHaveBeenCalledOnce());
  expect(f.child.detach).toHaveBeenCalledOnce();
});

it('does not hide a failed frame update behind a later successful update and can revoke on retry', async () => {
  const f = fixture();
  await f.policy.install(f.blocked);
  f.root.send.mockRejectedValueOnce(new Error('made-up CDP write failure'));
  await expect(f.policy.setHeld(true)).rejects.toThrow('made-up CDP write failure');
  await f.policy.setHeld(false);
  for (const connection of [f.root, f.child]) {
    const last = connection.send.mock.calls
      .filter(([method]) => method === 'Runtime.evaluate')
      .at(-1);
    expect(last?.[1]).toMatchObject({
      expression: expect.stringMatching(/\(false\)$/),
      userGesture: false,
    });
  }
});

it('refuses a hand-back update racing a disconnected policy session', async () => {
  const f = fixture();
  await f.policy.install(f.blocked);
  await f.policy.setHeld(true);
  f.root.events.emit('close');
  await expect(f.policy.setHeld(false)).rejects.toThrow('policy disconnected');
});
