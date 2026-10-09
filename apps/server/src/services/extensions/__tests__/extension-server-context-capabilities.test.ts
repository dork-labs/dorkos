import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionToolHandler } from '@dorkos/extension-api/server';
import { createTestDb } from '@dorkos/test-utils/db';
import { ExtensionInboxService, setExtensionInbox } from '../inbox/extension-inbox.js';
import { ExtensionSecretStore, resetKeyCache } from '@dorkos/shared/extension-secrets';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { createDataProviderContext } from '../extension-server-api-factory.js';
import { RegistrationCustody } from '../server-lifecycle/registration-custody.js';
import {
  invokeOriginalNotification,
  scopeContextCapabilities,
} from '../server-lifecycle/context-capabilities.js';
import { projectSettingsStore } from '../inbox/extension-project-settings.js';
import { projectRegistry } from '../../projects/project-registry.js';

const agent = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock('../agent-send/agent-send.js', () => ({
  getAgentSendService: () => ({ subscribe: agent.subscribe }),
}));
const tool = vi.hoisted(() => ({
  handler: undefined as ExtensionToolHandler | undefined,
  handle: vi.fn(),
}));
vi.mock('../agent-tools/tool-binding.js', () => ({
  createToolBinding: () => ({
    api: { handle: tool.handle },
    close: () => undefined,
    seal: () => [],
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetKeyCache();
  tool.handler = undefined;
  setExtensionInbox(null);
});

function held<T>() {
  let release!: (value: T) => void;
  const original = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { original, release };
}
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'context-capabilities-'));
  const bank = new RegistrationCustody();
  const occurrence = bank.begin('owned');
  const built = createDataProviderContext({
    extensionId: 'owned',
    extensionDir: home,
    dorkHome: home,
    requireCurrent: () => occurrence.requireCurrent(),
    ownOriginal: (enter) => occurrence.runOriginal(enter),
  });
  return {
    ...built,
    home,
    occurrence,
    bank,
    async close() {
      try {
        await occurrence.retire([built.dispose]);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  };
}

describe('remaining originating context capabilities', () => {
  it.each([false, undefined])('preserves synchronous notification failure %s', async (failure) => {
    const bank = new RegistrationCustody();
    const owner = bank.begin('owned');
    const receiver = {};
    const listener = function (this: unknown) {
      expect(this).toBe(receiver);
      throw failure;
    };
    let caught: { value: unknown } | undefined;
    try {
      invokeOriginalNotification(
        receiver,
        listener,
        [],
        () => owner.requireCurrent(),
        (enter) => owner.runOriginal(enter)
      );
    } catch (value) {
      caught = { value };
    }
    expect(caught).toEqual({ value: failure });
    await owner.retire([]);
  });
  it('returns the exact callback promise and joins it after synchronous retirement reentry', async () => {
    const bank = new RegistrationCustody();
    const owner = bank.begin('owned');
    const gate = held<void>();
    const closing: { original?: Promise<void> } = {};
    let settled = false;
    try {
      const returned = invokeOriginalNotification(
        undefined,
        () => {
          closing.original = owner.retire([]);
          void closing.original.then(() => {
            settled = true;
          });
          return gate.original;
        },
        [],
        () => owner.requireCurrent(),
        (enter) => owner.runOriginal(enter)
      );
      expect(returned).toBe(gate.original);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      gate.release();
      await closing.original;
      expect(settled).toBe(true);
    } finally {
      gate.release();
      await Promise.allSettled([gate.original, ...(closing.original ? [closing.original] : [])]);
    }
  });
  it('preserves a synchronous return and suppresses retired notification delivery', async () => {
    const owner = new RegistrationCustody().begin('owned');
    const value = {};
    const listener = vi.fn(() => value);
    expect(
      invokeOriginalNotification(
        undefined,
        listener,
        [],
        () => owner.requireCurrent(),
        (enter) => owner.runOriginal(enter)
      )
    ).toBe(value);
    await owner.retire([]);
    expect(
      invokeOriginalNotification(
        undefined,
        listener,
        [],
        () => owner.requireCurrent(),
        (enter) => owner.runOriginal(enter)
      )
    ).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('fences a real project subscription callback after retirement', async () => {
    const captured: { listener?: () => void } = {};
    vi.spyOn(projectRegistry, 'onChange').mockImplementation((listener) => {
      captured.listener = listener;
      return () => undefined;
    });
    const f = await fixture();
    const listener = vi.fn();
    try {
      f.ctx.projects.onChange(listener);
      expect(captured.listener).toBeDefined();
      captured.listener?.();
      expect(listener).toHaveBeenCalledTimes(1);
      await f.occurrence.retire([f.dispose]);
      captured.listener?.();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it.each(['set', 'delete'] as const)(
    'refuses the real locked secret %s tail after retirement',
    async (kind) => {
      const f = await fixture();
      const raw = new ExtensionSecretStore('owned', f.home);
      await raw.set('kept', 'original');
      const secretPath = path.join(f.home, 'extension-secrets', 'owned.json');
      const before = await fs.readFile(secretPath, 'utf8');
      const entered = held<void>();
      const gate = held<void>();
      const lock = withFileLock(secretPath, async () => {
        entered.release();
        await gate.original;
      });
      await entered.original;
      const original =
        kind === 'set' ? f.ctx.secrets.set('late', 'forbidden') : f.ctx.secrets.delete('kept');
      const observed = original.then(
        () => ({ ok: true }),
        (value) => ({ value })
      );
      const closing = f.occurrence.retire([f.dispose]);
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      try {
        await Promise.resolve();
        await Promise.resolve();
        expect(closed).toBe(false);
        gate.release();
        await lock;
        await closing;
        expect(await observed).toEqual({
          value: expect.objectContaining({ message: expect.stringContaining('retired') }),
        });
        expect(await fs.readFile(secretPath, 'utf8')).toBe(before);
        expect(await raw.get('kept')).toBe('original');
        expect(await raw.has('late')).toBe(false);
      } finally {
        gate.release();
        await Promise.allSettled([lock, original, closing]);
        await f.close();
      }
    }
  );
  it('retains the actual registered tool handler past host retirement', async () => {
    tool.handle.mockImplementation((_name: string, handler: ExtensionToolHandler) => {
      tool.handler = handler;
    });
    const f = await fixture();
    const gate = held<unknown>();
    const call = { signal: new AbortController().signal, agentId: 'agent' };
    f.ctx.tools.handle('work', () => gate.original);
    const handler = tool.handler;
    if (!handler) {
      await f.close();
      throw new Error('Tool handler not registered');
    }
    const original = Promise.resolve(handler({ input: true }, call));
    const observed = original.then(
      () => ({ ok: true }),
      (value) => ({ value })
    );
    const closing = f.occurrence.retire([f.dispose]);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(closed).toBe(false);
      gate.release('late');
      await closing;
      expect(await observed).toEqual({
        value: expect.objectContaining({ message: expect.stringContaining('retired') }),
      });
    } finally {
      gate.release('late');
      await Promise.allSettled([original, closing]);
      await f.close();
    }
  });
  it.each([false, undefined])('preserves an entered tool rejection %s', async (failure) => {
    tool.handle.mockImplementation((_name: string, handler: ExtensionToolHandler) => {
      tool.handler = handler;
    });
    const f = await fixture();
    try {
      f.ctx.tools.handle('work', () => Promise.reject(failure));
      const handler = tool.handler;
      if (!handler) {
        await f.close();
        throw new Error('Tool handler not registered');
      }
      const observed = Promise.resolve(
        handler(null, { signal: new AbortController().signal, agentId: 'agent' })
      ).then(
        () => ({ ok: true }),
        (value) => ({ value })
      );
      expect(await observed).toEqual({ value: failure });
    } finally {
      await f.close();
    }
  });
  it('refuses middleware successful next after original middleware retires its occurrence', async () => {
    const f = await fixture();
    const next = vi.fn();
    const closing: { original?: Promise<void> } = {};
    const receiver = {};
    const ctx = scopeContextCapabilities(
      {
        ...f.ctx,
        requirePerson: function (this: unknown, _req, _res, delivered) {
          expect(this).toBe(receiver);
          closing.original = f.occurrence.retire([f.dispose]);
          delivered();
        },
      },
      () => f.occurrence.requireCurrent(),
      (enter) => f.occurrence.runOriginal(enter)
    );
    try {
      const observed = Promise.resolve(
        Reflect.apply(ctx.requirePerson, receiver, [{}, {}, next])
      ).then(
        () => ({ ok: true }),
        (value) => ({ value })
      );
      expect(await observed).toEqual({
        value: expect.objectContaining({ message: expect.stringContaining('retired') }),
      });
      expect(next).not.toHaveBeenCalled();
      await closing.original;
    } finally {
      await Promise.allSettled(closing.original ? [closing.original] : []);
      await f.close();
    }
  });
  it.each(['projects', 'project-settings', 'agent', 'inbox', 'tools'] as const)(
    'preserves the original malformed %s callback validator',
    async (kind) => {
      tool.handle.mockImplementation((_name, handler) => {
        if (typeof handler !== 'function') throw new TypeError('Original tool handler refused');
      });
      const f = await fixture();
      try {
        const selected =
          kind === 'projects'
            ? { receiver: f.ctx.projects, method: f.ctx.projects.onChange, args: [null] }
            : kind === 'project-settings'
              ? {
                  receiver: f.ctx.projectSettings,
                  method: f.ctx.projectSettings.onChange,
                  args: [null],
                }
              : kind === 'agent'
                ? { receiver: f.ctx.agent, method: f.ctx.agent.subscribe, args: [null] }
                : kind === 'inbox'
                  ? { receiver: f.ctx.inbox, method: f.ctx.inbox.onAction, args: [null] }
                  : { receiver: f.ctx.tools, method: f.ctx.tools.handle, args: ['work', null] };
        expect(() => Reflect.apply(selected.method, selected.receiver, selected.args)).toThrow(
          TypeError
        );
      } finally {
        await f.close();
      }
    }
  );
  it.each([false, undefined])(
    'keeps retired secret get/has as rejected promises with cause %s',
    async (failure) => {
      const f = await fixture();
      try {
        f.occurrence.fail(failure);
        const get = f.ctx.secrets.get('kept');
        const has = f.ctx.secrets.has('kept');
        expect(get).toBeInstanceOf(Promise);
        expect(has).toBeInstanceOf(Promise);
        expect(
          await get.then(
            () => ({ ok: true }),
            (value) => ({ value })
          )
        ).toEqual({ value: failure });
        expect(
          await has.then(
            () => ({ ok: true }),
            (value) => ({ value })
          )
        ).toEqual({ value: failure });
      } finally {
        await f.close().catch((value) => {
          expect(value).toBe(failure);
        });
      }
    }
  );

  it.each(['agent', 'project-settings'] as const)(
    'suppresses stale original %s notifications',
    async (kind) => {
      const f = await fixture();
      const listener = vi.fn();
      const originalDelivery: { enter?: () => unknown } = {};
      agent.subscribe.mockImplementation((_id, callback) => {
        originalDelivery.enter = () => callback({ kind: 'delivered' });
        return () => undefined;
      });
      vi.spyOn(projectSettingsStore(f.home), 'onChange').mockImplementation((callback) => {
        originalDelivery.enter = () => callback('owned', '/repo');
        return () => undefined;
      });
      try {
        if (kind === 'agent') f.ctx.agent.subscribe(listener);
        else f.ctx.projectSettings.onChange(listener);
        expect(originalDelivery.enter).toBeDefined();
        originalDelivery.enter?.();
        expect(listener).toHaveBeenCalledTimes(1);
        await f.occurrence.retire([f.dispose]);
        originalDelivery.enter?.();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        await f.close();
      }
    }
  );
  it.each([false, undefined])('preserves middleware original failure %s', async (failure) => {
    const f = await fixture();
    const next = vi.fn();
    const ctx = scopeContextCapabilities(
      {
        ...f.ctx,
        requirePerson() {
          throw failure;
        },
      },
      () => f.occurrence.requireCurrent(),
      (enter) => f.occurrence.runOriginal(enter)
    );
    try {
      const original = Reflect.apply(ctx.requirePerson, undefined, [{}, {}, next]);
      expect(
        await Promise.resolve(original).then(
          () => ({ ok: true }),
          (value) => ({ value })
        )
      ).toEqual({ value: failure });
      expect(next).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
  it('joins the real inbox action callback after its host retires', async () => {
    const f = await fixture();
    const db = createTestDb();
    const inbox = new ExtensionInboxService({ db, projects: projectRegistry, dorkHome: f.home });
    setExtensionInbox(inbox);
    const delivery: { handler?: Parameters<ExtensionInboxService['setHandler']>[1] } = {};
    vi.spyOn(inbox, 'setHandler').mockImplementation((_id, handler) => {
      delivery.handler = handler;
      return () => undefined;
    });
    const gate = held<{ settled: true }>();
    f.ctx.inbox.onAction(() => gate.original);
    const handler = delivery.handler;
    if (!handler) {
      inbox.stop();
      db.$client.close();
      await f.close();
      throw new Error('Inbox action not registered');
    }
    const original = Promise.resolve(Reflect.apply(handler, undefined, [{}]));
    const observed = original.then(
      () => ({ ok: true }),
      (value) => ({ value })
    );
    const closing = f.occurrence.retire([f.dispose]);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(closed).toBe(false);
      gate.release({ settled: true });
      await closing;
      expect(await observed).toEqual({
        value: expect.objectContaining({ message: expect.stringContaining('retired') }),
      });
    } finally {
      gate.release({ settled: true });
      await Promise.allSettled([original, closing]);
      inbox.stop();
      db.$client.close();
      await f.close();
    }
  });
  it.each([false, undefined])(
    'retains the exact original rejected notification promise %s',
    async (failure) => {
      const owner = new RegistrationCustody().begin('owned');
      const original = Promise.reject(failure);
      const observed = original.then(
        () => ({ ok: true }),
        (value) => ({ value })
      );
      try {
        expect(
          invokeOriginalNotification(
            undefined,
            () => original,
            [],
            () => owner.requireCurrent(),
            (enter) => owner.runOriginal(enter)
          )
        ).toBe(original);
        expect(await observed).toEqual({ value: failure });
      } finally {
        await owner.retire([]);
        await observed;
      }
    }
  );
  it('preserves the original host receiver on subscription delivery', async () => {
    const captured: { listener?: () => void } = {};
    vi.spyOn(projectRegistry, 'onChange').mockImplementation((listener) => {
      captured.listener = listener;
      return () => undefined;
    });
    const f = await fixture();
    const receiver = {};
    const listener = vi.fn(function (this: unknown) {
      expect(this).toBe(receiver);
    });
    try {
      f.ctx.projects.onChange(listener);
      const original = captured.listener;
      if (!original) throw new Error('Subscription not entered');
      Reflect.apply(original, receiver, []);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('preserves the captured tool handler delivery receiver', async () => {
    tool.handle.mockImplementation((_name: string, handler: ExtensionToolHandler) => {
      tool.handler = handler;
    });
    const f = await fixture();
    const receiver = {};
    try {
      f.ctx.tools.handle('work', function (this: unknown) {
        expect(this).toBe(receiver);
        return 'original';
      });
      const handler = tool.handler;
      if (!handler) throw new Error('Tool handler not entered');
      expect(
        await Reflect.apply(handler, receiver, [
          null,
          { signal: new AbortController().signal, agentId: 'agent' },
        ])
      ).toBe('original');
    } finally {
      await f.close();
    }
  });
});
