import express from 'express';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { expect, it, onTestFinished, vi } from 'vitest';
const native = vi.hoisted(() => ({
  mode: vi.fn(),
  routes: vi.fn(),
  authenticate: vi.fn(),
  acquire: vi.fn(),
}));
vi.mock('../activation/activation-auth.js', () => ({
  createActivationAuthentication: () => native.authenticate,
  isOriginalActivationRefusal: () => false,
}));
vi.mock('../production-inventory.js', () => ({
  createProductionBrowserServerInventory: () => ({
    acquire: native.acquire,
    close: async () => {},
  }),
}));
vi.mock('../startup-mode.js', () => ({
  createProductionBrowserStartupMode: native.mode,
  isOriginalStartupRefusal: () => false,
}));
vi.mock('../runtime-routes.js', () => ({ createProductionBrowserRuntimeRoutes: native.routes }));
import {
  consumeBrowserIdentityChoicePermit,
  type BrowserIdentityChoicePermit,
} from '../activation/identity-choice-permit.js';
import type { ConfigManager } from '../../../core/config-manager.js';
import { createExperimentalBrowserStartup } from '../startup.js';
import type { createProductionBrowserStartupMode } from '../startup-mode.js';

// These facade-only controls never invoke agent tools. Supply the actual captured
// constructor ports, and fail if a test accidentally enters an unrelated tool.
function runtimePorts() {
  const unused = () => {
    throw new Error('UNEXPECTED_RUNTIME_TOOL_ENTRY');
  };
  return {
    prepareDisable: async () => {},
    runtimeToolsAvailable: () => false,
    runtimeOptionalToolsAvailable: () => false,
    resolveRuntimeTools: unused,
    openForRuntime: unused,
    openDelegatedForRuntime: unused,
    describeRuntimeDelegation: unused,
    describeRuntimeFileApproval: unused,
    issueRuntimeFileApproval: unused,
    closeForRuntime: unused,
  } satisfies Pick<
    ReturnType<typeof createProductionBrowserStartupMode>,
    | 'prepareDisable'
    | 'runtimeToolsAvailable'
    | 'runtimeOptionalToolsAvailable'
    | 'resolveRuntimeTools'
    | 'openForRuntime'
    | 'openDelegatedForRuntime'
    | 'describeRuntimeDelegation'
    | 'describeRuntimeFileApproval'
    | 'issueRuntimeFileApproval'
    | 'closeForRuntime'
  >;
}

function fixture() {
  native.mode.mockReset();
  native.routes.mockReset();
  native.authenticate.mockReset();
  native.acquire.mockReset();
  native.authenticate.mockResolvedValue(() => true);
  const settings = { enabled: false, chromeUserAgent: false };
  const storeFailure: { value?: Readonly<{ value: unknown }> } = {};
  const listeners = new Set<(change: { paths: string[] }) => void>();
  const config = {
    get: (key: string) => (key === 'browser' ? settings : { enabled: true }),
    setDot: (_key: string, enabled: boolean) => {
      settings.enabled = enabled;
      if (storeFailure.value) throw storeFailure.value.value;
      for (const listener of listeners) listener({ paths: ['browser.enabled'] });
    },
    chooseOwnedBrowserIdentity: (value: boolean, permit: BrowserIdentityChoicePermit): void => {
      const check = consumeBrowserIdentityChoicePermit(
        permit,
        config as unknown as ConfigManager,
        value
      );
      check();
      settings.chromeUserAgent = value;
      check();
      for (const listener of listeners) listener({ paths: ['browser.chromeUserAgent'] });
    },
    onChange: (listener: (change: { paths: string[] }) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const app = express(),
    use = vi.spyOn(app, 'use');
  const owner = createExperimentalBrowserStartup();
  const start = () =>
    owner.start({ app, config, db: {}, auth: () => ({}) } as unknown as Parameters<
      typeof owner.start
    >[0]);
  const submit = (enabled: boolean, chromeUserAgent?: boolean) => {
    const router = use.mock.calls[0]![1] as express.Router;
    const facade = router.stack[0]!.handle as express.Router;
    const layer = facade.stack.find((entry) => entry.route?.path === '/runtime/enable')!;
    const dispatch = layer.route!.stack[0]!.handle;
    const req = Object.assign(new EventEmitter(), {
      headers: { cookie: 'fixture', host: 'localhost:4242', origin: 'http://localhost:4242' },
      socket: { encrypted: false },
      method: 'POST',
      body: { enabled, ...(chromeUserAgent === undefined ? {} : { chromeUserAgent }) },
      aborted: false,
    });
    let returned!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      returned = resolve;
    });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writableFinished: false,
      finished: false,
      writable: true,
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(value: unknown) {
        return this.end(Buffer.from(JSON.stringify(value)), () => {});
      },
      type() {
        return this;
      },
      destroy() {
        this.destroyed = true;
        returned({ state: 'destroyed' });
        return this;
      },
      end(bytes: Buffer, callback: () => void) {
        this.writableEnded = true;
        this.writableFinished = true;
        callback();
        returned(JSON.parse(bytes.toString()));
        return this;
      },
    });
    dispatch(req as unknown as Request, res as unknown as Response, () => {});
    return response;
  };
  return { owner, start, submit, settings, listeners, use, config, storeFailure };
}

it('Off retains passive original main-listener acquisition and facade without native construction', async () => {
  const f = fixture();
  const originals: { start?: Promise<void>; close?: Promise<void> } = {};
  onTestFinished(async () => {
    originals.close ??= f.owner.close();
    const results = await Promise.allSettled([
      ...(originals.start ? [originals.start] : []),
      originals.close,
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  originals.start = f.start();
  await originals.start;
  expect(f.use).toHaveBeenCalledWith('/api/browser', expect.any(Function));
  expect(native.mode).not.toHaveBeenCalled();
  expect(native.routes).not.toHaveBeenCalled();
  const originalServer = {} as Parameters<typeof f.owner.listen>[1] extends () => infer T
    ? T
    : never;
  native.acquire.mockImplementation(
    (_id, _name, create: () => unknown, bind: (value: unknown) => void) => {
      const value = create();
      bind(value);
      return value;
    }
  );
  const create = vi.fn(() => originalServer),
    bind = vi.fn();
  expect(
    f.owner.listen(
      () => {
        throw new Error('FALLBACK_MUST_NOT_BYPASS_INVENTORY');
      },
      create,
      bind
    )
  ).toBe(originalServer);
  expect(native.acquire).toHaveBeenCalledWith('dorkos', 'main', create, bind);
});

it('genuine facade Off→On→Off consumes original mode verification and independent close receivers', async () => {
  const f = fixture();
  const originals: {
    start?: Promise<void>;
    close?: Promise<void>;
    on?: Promise<unknown>;
    off?: Promise<unknown>;
  } = {};
  onTestFinished(async () => {
    originals.close ??= f.owner.close();
    const results = await Promise.allSettled(Object.values(originals));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const closeMode = vi.fn(async () => {}),
    closeRoutes = vi.fn(async () => {});
  const mode = {
    ...runtimePorts(),
    setEnabled: vi.fn(async (enabled: boolean) => {
      f.settings.enabled = enabled;
      return {
        state: enabled ? 'ready' : 'disabled',
        enabled,
        ...(enabled ? { workspaces: [] } : {}),
      };
    }),
    status: vi.fn(async () => ({ state: 'ready', enabled: true, workspaces: [] })),
    modeCurrent: () => f.settings.enabled,
    close: closeMode,
  };
  native.mode.mockReturnValue(mode);
  native.routes.mockReturnValue({ router: express.Router(), close: closeRoutes });
  originals.start = f.start();
  await originals.start;
  originals.on = f.submit(true);
  expect(await originals.on).toMatchObject({ state: 'ready', enabled: true });
  expect(mode.setEnabled).toHaveBeenCalledOnce();
  // Replacement properties confer no cleanup authority after original captures.
  mode.close = vi.fn(async () => {
    throw false;
  });
  originals.off = f.submit(false);
  expect(await originals.off).toEqual({ state: 'disabled', enabled: false });
  expect(f.settings.enabled).toBe(false);
  expect(closeMode).toHaveBeenCalledOnce();
  expect(closeRoutes).toHaveBeenCalledOnce();
  expect(mode.close).not.toHaveBeenCalled();
});

it.each([undefined, false])(
  'joins held original enable failure %s before shutdown without healing',
  async (reason) => {
    const f = fixture();
    let release!: (value: unknown) => void;
    const held = new Promise<never>((_resolve, reject) => {
      release = reject;
    });
    const originals: { start?: Promise<void>; close?: Promise<void>; on?: Promise<unknown> } = {};
    onTestFinished(async () => {
      release(reason);
      originals.close ??= f.owner.close();
      const results = await Promise.allSettled(Object.values(originals));
      for (const result of results)
        if (result.status === 'rejected' && !Object.is(result.reason, reason)) throw result.reason;
    });
    let entered!: () => void;
    const enabling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const closeMode = vi.fn(async () => {}),
      closeRoutes = vi.fn(async () => {});
    native.mode.mockReturnValue({
      ...runtimePorts(),
      setEnabled: () => {
        entered();
        return held;
      },
      status: async () => ({}),
      modeCurrent: () => false,
      close: closeMode,
    });
    native.routes.mockReturnValue({ router: express.Router(), close: closeRoutes });
    originals.start = f.start();
    await originals.start;
    originals.on = f.submit(true);
    await enabling;
    originals.close = f.owner.close();
    void originals.close.catch(() => {});
    let settled = false;
    void originals.close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(closeMode).toHaveBeenCalledOnce();
    expect(closeRoutes).toHaveBeenCalledOnce();
    release(reason);
    await expect(originals.close).rejects.toBe(reason);
    expect(f.settings.enabled).toBe(false);
  }
);

it('banks whole start before original config getter reenters close and throws undefined', async () => {
  const owner = createExperimentalBrowserStartup();
  const originals: { start?: Promise<void>; close?: Promise<void> } = {};
  onTestFinished(async () => {
    originals.close ??= owner.close();
    const results = await Promise.allSettled(Object.values(originals));
    for (const result of results)
      if (result.status !== 'rejected' || result.reason !== undefined)
        throw new Error('EXACT_CONFIG_UNDEFINED_NOT_RETAINED');
  });
  const config = {
    get get() {
      originals.close = owner.close();
      void originals.close.catch(() => {});
      throw undefined;
    },
  };
  originals.start = owner.start({
    config,
    db: {},
    app: express(),
    auth: () => undefined,
  } as unknown as Parameters<typeof owner.start>[0]);
  await expect(originals.start).rejects.toBeUndefined();
  await expect(originals.close).rejects.toBeUndefined();
});

it('joins the late exact mode close after its original constructor reenters shutdown', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originals: { start?: Promise<void>; close?: Promise<void>; on?: Promise<unknown> } = {};
  onTestFinished(async () => {
    release();
    originals.close ??= f.owner.close();
    const results = await Promise.allSettled(Object.values(originals));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  let entered!: () => void;
  const closingEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalClose = vi.fn(async () => {
    entered();
    await held;
  });
  native.mode.mockImplementation(() => {
    originals.close = f.owner.close();
    return { close: originalClose };
  });
  originals.start = f.start();
  await originals.start;
  originals.on = f.submit(true);
  await closingEntered;
  let settled = false;
  void originals.close!.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(native.routes).not.toHaveBeenCalled();
  release();
  await originals.close;
  expect(originalClose).toHaveBeenCalledOnce();
});

it.each([undefined, false])(
  'enters both exact graph closes despite original false-store failure %s',
  async (reason) => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closingEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originals: {
      start?: Promise<void>;
      on?: Promise<unknown>;
      off?: Promise<unknown>;
      close?: Promise<void>;
    } = {};
    onTestFinished(async () => {
      release();
      originals.close ??= f.owner.close();
      const results = await Promise.allSettled(Object.values(originals));
      for (const result of results)
        if (result.status === 'rejected' && !Object.is(result.reason, reason)) throw result.reason;
    });
    const closeMode = vi.fn(async () => {
        entered();
        await held;
      }),
      closeRoutes = vi.fn(async () => {});
    native.mode.mockReturnValue({
      ...runtimePorts(),
      setEnabled: async () => {
        f.settings.enabled = true;
        return { state: 'ready', enabled: true, workspaces: [] };
      },
      status: async () => ({ state: 'ready', enabled: true, workspaces: [] }),
      modeCurrent: () => f.settings.enabled,
      close: closeMode,
    });
    native.routes.mockReturnValue({ router: express.Router(), close: closeRoutes });
    originals.start = f.start();
    await originals.start;
    originals.on = f.submit(true);
    await originals.on;
    f.storeFailure.value = { value: reason };
    originals.off = f.submit(false);
    await closingEntered;
    expect(closeMode).toHaveBeenCalledOnce();
    expect(closeRoutes).toHaveBeenCalledOnce();
    originals.close = f.owner.close();
    void originals.close.catch(() => {});
    let settled = false;
    void originals.close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(originals.close).rejects.toBe(reason);
    await originals.off;
  }
);

it('an old held disable removes only its captured graphs so a later Off closes the concurrent new enable', async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closingEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originals: {
    start?: Promise<void>;
    on?: Promise<unknown>;
    off?: Promise<unknown>;
    again?: Promise<unknown>;
    nextOff?: Promise<unknown>;
    close?: Promise<void>;
  } = {};
  onTestFinished(async () => {
    release();
    originals.close ??= f.owner.close();
    const results = await Promise.allSettled(Object.values(originals));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const oldModeClose = vi.fn(async () => {
      entered();
      await held;
    }),
    oldRoutesClose = vi.fn(async () => {}),
    newModeClose = vi.fn(async () => {}),
    newRoutesClose = vi.fn(async () => {});
  const mode = (close: () => Promise<void>) => ({
    ...runtimePorts(),
    setEnabled: async () => {
      f.settings.enabled = true;
      return { state: 'ready', enabled: true, workspaces: [] };
    },
    status: async () => ({ state: 'ready', enabled: true, workspaces: [] }),
    modeCurrent: () => f.settings.enabled,
    close,
  });
  native.mode.mockReturnValueOnce(mode(oldModeClose)).mockReturnValueOnce(mode(newModeClose));
  native.routes
    .mockReturnValueOnce({ router: express.Router(), close: oldRoutesClose })
    .mockReturnValueOnce({ router: express.Router(), close: newRoutesClose });
  originals.start = f.start();
  await originals.start;
  originals.on = f.submit(true);
  await originals.on;
  originals.off = f.submit(false);
  await closingEntered;
  originals.again = f.submit(true);
  expect(await originals.again).toMatchObject({ state: 'ready' });
  release();
  await originals.off;
  expect(newModeClose).not.toHaveBeenCalled();
  expect(newRoutesClose).not.toHaveBeenCalled();
  originals.nextOff = f.submit(false);
  expect(await originals.nextOff).toEqual({ state: 'disabled', enabled: false });
  expect(newModeClose).toHaveBeenCalledOnce();
  expect(newRoutesClose).toHaveBeenCalledOnce();
  originals.close = f.owner.close();
  await originals.close;
  for (const original of [oldModeClose, oldRoutesClose, newModeClose, newRoutesClose])
    expect(original).toHaveBeenCalledOnce();
});

it('selects Chrome identity through the real Off facade without constructing any browser mode', async () => {
  const f = fixture();
  onTestFinished(() => f.owner.close());
  await f.start();
  expect(await f.submit(false, true)).toEqual({ state: 'disabled', enabled: false });
  expect(f.settings.chromeUserAgent).toBe(true);
  expect(native.mode).not.toHaveBeenCalled();
});
it('holds the identity transition before owner auth and refuses concurrent enable until original selection returns', async () => {
  const f = fixture();
  let release!: (value: () => boolean) => void;
  const auth = new Promise<() => boolean>((resolve) => {
    release = resolve;
  });
  onTestFinished(async () => {
    release(() => true);
    await f.owner.close();
  });
  await f.start();
  let entered!: () => void;
  const authEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  native.authenticate
    .mockResolvedValueOnce(() => true)
    .mockImplementationOnce(() => {
      entered();
      return auth;
    });
  const selection = f.submit(false, true);
  await authEntered;
  expect(await f.submit(true)).toMatchObject({ error: expect.any(String) });
  expect(native.mode).not.toHaveBeenCalled();
  expect(f.settings.chromeUserAgent).toBe(false);
  release(() => true);
  expect(await selection).toEqual({ state: 'disabled', enabled: false });
  expect(f.settings.chromeUserAgent).toBe(true);
});

it.each([false, undefined] as const)(
  'Off retains first preparation failure %s and still writes false and joins both closes',
  async (primary) => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    const prepareEntered = vi.fn();
    const prepare = vi.fn(async () => {
      prepareEntered();
      await held;
      throw primary;
    });
    const closeMode = vi.fn(async () => {
      throw new Error('secondary mode close');
    });
    const closeRoutes = vi.fn(async () => {
      throw new Error('secondary route close');
    });
    const stop = vi.fn();
    f.listeners.add(() => {
      if (!f.settings.enabled) stop();
    });
    const pending: Promise<unknown>[] = [];
    onTestFinished(async () => {
      release();
      await Promise.allSettled([...pending, f.owner.close()]);
    });
    native.mode.mockReturnValue({
      ...runtimePorts(),
      prepareDisable: prepare,
      setEnabled: async () => {
        f.settings.enabled = true;
        return { state: 'ready', enabled: true, workspaces: [] };
      },
      status: async () => ({ state: 'ready', enabled: true, workspaces: [] }),
      modeCurrent: () => f.settings.enabled,
      close: closeMode,
    });
    native.routes.mockReturnValue({ router: express.Router(), close: closeRoutes });
    await f.start();
    await f.submit(true);
    const off = f.submit(false);
    pending.push(off);
    await vi.waitFor(() => expect(prepareEntered).toHaveBeenCalledOnce());
    expect(stop).not.toHaveBeenCalled();
    expect(closeMode).not.toHaveBeenCalled();
    expect(f.settings.enabled).toBe(true);
    release();
    expect(await off).toHaveProperty('error');
    expect(f.settings.enabled).toBe(false);
    expect(stop).toHaveBeenCalled();
    expect(closeRoutes).toHaveBeenCalledOnce();
    expect(closeMode).toHaveBeenCalledOnce();
    const closing = f.owner.close();
    pending.push(closing);
    await expect(closing).rejects.toBe(primary);
  }
);
