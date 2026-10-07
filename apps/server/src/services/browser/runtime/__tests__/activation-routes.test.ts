import { EventEmitter } from 'node:events';
import { BrowserProductionEnableRequestSchema } from '@dorkos/shared/browser-schemas';
import type { Request, Response, Router } from 'express';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createBrowserActivationRoutes } from '../activation/activation-routes.js';

function dispatch(
  router: Router,
  changing = false,
  origin: string | undefined = undefined,
  before?: (res: Response, req: Request) => void
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === (changing ? '/runtime/enable' : '/runtime/status')
  )!;
  const req = Object.assign(new EventEmitter(), {
    headers: {
      cookie: 'fixture',
      host: 'localhost:4242',
      ...(origin === undefined ? {} : { origin }),
    },
    socket: { encrypted: false },
    method: changing ? 'POST' : 'GET',
    body: { enabled: true },
    aborted: false,
  });
  let returned!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => {
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
    type() {
      return this;
    },
    destroy() {
      this.destroyed = true;
      returned({ destroyed: true });
      return this;
    },
    json(value: unknown) {
      this.writableEnded = true;
      this.writableFinished = true;
      returned(value);
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
  before?.(res as unknown as Response, req as unknown as Request);
  layer.route!.stack[0]!.handle(req as unknown as Request, res as unknown as Response, () => {});
  return { req, res, result };
}
function owner() {
  return {
    authenticate: vi.fn(async () => (): boolean => true),
    enable: vi.fn(async () => ({ state: 'disabled' as const, enabled: false as const })),
    status: vi.fn(async () => ({ state: 'disabled' as const, enabled: false as const })),
    expected: () => false,
  };
}

it('permits authenticated trusted-host GET without Origin but completes strict missing-Origin POST denial', async () => {
  const original = owner(),
    routes = createBrowserActivationRoutes(original);
  const calls: Promise<unknown>[] = [];
  onTestFinished(async () => {
    const close = routes.close();
    const results = await Promise.allSettled([...calls, close]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const read = dispatch(routes.router);
  calls.push(read.result);
  expect(await read.result).toEqual({ state: 'disabled', enabled: false });
  expect(original.status).toHaveBeenCalledOnce();
  const change = dispatch(routes.router, true);
  calls.push(change.result);
  expect(await change.result).toHaveProperty('error');
  expect(change.res.statusCode).toBe(403);
  expect(original.enable).not.toHaveBeenCalled();
  await routes.close();
});

it('exact local publication refusal leaves subsequent genuine status and close healthy', async () => {
  const original = owner(),
    routes = createBrowserActivationRoutes(original);
  original.authenticate.mockResolvedValueOnce(() => false);
  const calls: Promise<unknown>[] = [];
  onTestFinished(async () => {
    const close = routes.close();
    const results = await Promise.allSettled([...calls, close]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const refused = dispatch(routes.router);
  calls.push(refused.result);
  expect(await refused.result).toHaveProperty('error');
  expect(refused.res.statusCode).toBe(503);
  const later = dispatch(routes.router);
  calls.push(later.result);
  expect(await later.result).toEqual({ state: 'disabled', enabled: false });
  await routes.close();
});

it('ordinary original request cancellation joins held status without poisoning subsequent status or close', async () => {
  const original = owner();
  let release!: (value: { state: 'disabled'; enabled: false }) => void, entered!: () => void;
  const held = new Promise<{ state: 'disabled'; enabled: false }>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  original.status.mockImplementationOnce(() => {
    entered();
    return held;
  });
  const routes = createBrowserActivationRoutes(original),
    calls: Promise<unknown>[] = [];
  onTestFinished(async () => {
    release({ state: 'disabled', enabled: false });
    const close = routes.close();
    const results = await Promise.allSettled([...calls, close, held]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const cancelled = dispatch(routes.router);
  calls.push(cancelled.result);
  await entering;
  cancelled.req.aborted = true;
  cancelled.req.emit('aborted');
  expect(await cancelled.result).toEqual({ destroyed: true });
  release({ state: 'disabled', enabled: false });
  await held;
  const later = dispatch(routes.router);
  calls.push(later.result);
  expect(await later.result).toEqual({ state: 'disabled', enabled: false });
  await routes.close();
});

it.each([undefined, false, new Error('ACTIVATION_PUBLICATION_REFUSED')])(
  'retains original end failure %s rather than classifying by value or message',
  async (reason) => {
    const original = owner(),
      routes = createBrowserActivationRoutes(original),
      calls: Promise<unknown>[] = [];
    onTestFinished(async () => {
      const close = routes.close();
      const results = await Promise.allSettled([...calls, close]);
      for (const result of results)
        if (result.status === 'rejected' && !Object.is(result.reason, reason)) throw result.reason;
    });
    const call = dispatch(routes.router, false, undefined, (res) => {
      res.end = () => {
        res.destroy();
        throw reason;
      };
    });
    calls.push(call.result);
    expect(await call.result).toEqual({ destroyed: true });
    await expect(routes.close()).rejects.toBe(reason);
  }
);

it('bounded plain JSON refuses accessors without invoking them or poisoning close', async () => {
  const original = owner(),
    routes = createBrowserActivationRoutes(original),
    getter = vi.fn(() => {
      throw new Error('ACCESSOR_MUST_NOT_RUN');
    }),
    calls: Promise<unknown>[] = [];
  onTestFinished(async () => {
    const close = routes.close();
    const results = await Promise.allSettled([...calls, close]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const call = dispatch(routes.router, true, 'http://localhost:4242', (_res, req) => {
    req.body = Object.defineProperty({}, 'enabled', { enumerable: true, get: getter });
  });
  calls.push(call.result);
  expect(await call.result).toHaveProperty('error');
  expect(getter).not.toHaveBeenCalled();
  expect(original.enable).not.toHaveBeenCalled();
  await routes.close();
});

it('retains exact original fixed-schema producer failure rather than classifying every object as malformed', async () => {
  const original = owner(),
    reason = new Error('ORIGINAL_SCHEMA_PRODUCER_FAILURE'),
    calls: Promise<unknown>[] = [];
  const bank: { routes?: ReturnType<typeof createBrowserActivationRoutes>; restore?: () => void } =
    {};
  onTestFinished(async () => {
    let failure: Readonly<{ value: unknown }> | undefined;
    try {
      const close = bank.routes?.close();
      const results = await Promise.allSettled([...calls, ...(close ? [close] : [])]);
      for (const result of results)
        if (result.status === 'rejected' && result.reason !== reason)
          failure ??= { value: result.reason };
    } catch (value) {
      if (value !== reason) failure ??= { value };
    }
    try {
      bank.restore?.();
    } catch (value) {
      failure ??= { value };
    }
    if (failure) throw failure.value;
  });
  const parser = vi.spyOn(BrowserProductionEnableRequestSchema, 'parse').mockImplementation(() => {
    throw reason;
  });
  bank.restore = () => parser.mockRestore();
  bank.routes = createBrowserActivationRoutes(original);
  const call = dispatch(bank.routes.router, true, 'http://localhost:4242');
  calls.push(call.result);
  expect(await call.result).toHaveProperty('error');
  expect(parser).toHaveBeenCalledOnce();
  expect(original.enable).not.toHaveBeenCalled();
  await expect(bank.routes.close()).rejects.toBe(reason);
});

it.each([undefined, false, new Error('original output failure')])(
  'first original output failure %s fences a later real enable producer',
  async (reason) => {
    const original = owner(),
      routes = createBrowserActivationRoutes(original),
      calls: Promise<unknown>[] = [];
    onTestFinished(async () => {
      const close = routes.close();
      for (const result of await Promise.allSettled([...calls, close]))
        if (result.status === 'rejected' && !Object.is(result.reason, reason)) throw result.reason;
    });
    const failed = dispatch(routes.router, false, undefined, (res) => {
      res.end = () => {
        res.destroy();
        throw reason;
      };
    });
    calls.push(failed.result);
    expect(await failed.result).toEqual({ destroyed: true });
    const subsequent = dispatch(routes.router, true, 'http://localhost:4242');
    calls.push(subsequent.result);
    expect(await subsequent.result).toHaveProperty('error');
    expect(subsequent.res.statusCode).toBe(503);
    expect(original.authenticate).toHaveBeenCalledOnce();
    expect(original.enable).not.toHaveBeenCalled();
    await expect(routes.close()).rejects.toBe(reason);
  }
);
it('first sibling output failure fences a held original authentication before enable entry', async () => {
  const reason = false;
  let release!: (actor: () => boolean) => void;
  const held = new Promise<() => boolean>((resolve) => {
    release = resolve;
  });
  const original = owner();
  original.authenticate.mockImplementationOnce(() => held);
  const routes = createBrowserActivationRoutes(original),
    calls: Promise<unknown>[] = [];
  onTestFinished(async () => {
    release(() => true);
    const close = routes.close();
    for (const result of await Promise.allSettled([...calls, close]))
      if (result.status === 'rejected' && !Object.is(result.reason, reason)) throw result.reason;
  });
  const sibling = dispatch(routes.router, true, 'http://localhost:4242');
  calls.push(sibling.result);
  await Promise.resolve();
  expect(original.authenticate).toHaveBeenCalledOnce();
  const failed = dispatch(routes.router, false, undefined, (res) => {
    res.end = () => {
      res.destroy();
      throw reason;
    };
  });
  calls.push(failed.result);
  expect(await failed.result).toEqual({ destroyed: true });
  release(() => true);
  expect(await sibling.result).toHaveProperty('error');
  expect(original.enable).not.toHaveBeenCalled();
  await expect(routes.close()).rejects.toBe(reason);
});
it('first sibling output failure fences a held original status before successful publication', async () => {
  const reason = undefined;
  let release!: (value: { state: 'disabled'; enabled: false }) => void;
  const held = new Promise<{ state: 'disabled'; enabled: false }>((resolve) => {
    release = resolve;
  });
  const original = owner();
  original.status.mockImplementationOnce(() => held);
  const routes = createBrowserActivationRoutes(original),
    calls: Promise<unknown>[] = [];
  const published: unknown[] = [];
  onTestFinished(async () => {
    release({ state: 'disabled', enabled: false });
    const close = routes.close();
    for (const result of await Promise.allSettled([...calls, close]))
      if (result.status === 'rejected' && !Object.is(result.reason, reason)) throw result.reason;
  });
  const sibling = dispatch(routes.router, false, undefined, (res) => {
    const end = res.end.bind(res);
    res.end = ((bytes: Buffer, callback: () => void) => {
      published.push(JSON.parse(bytes.toString()));
      return end(bytes, callback);
    }) as Response['end'];
  });
  calls.push(sibling.result);
  await Promise.resolve();
  await Promise.resolve();
  expect(original.status).toHaveBeenCalledOnce();
  const failed = dispatch(routes.router, true, 'http://localhost:4242', (res) => {
    res.end = () => {
      res.destroy();
      throw reason;
    };
  });
  calls.push(failed.result);
  expect(await failed.result).toEqual({ destroyed: true });
  release({ state: 'disabled', enabled: false });
  expect(await sibling.result).toHaveProperty('error');
  expect(published).toHaveLength(1);
  expect(published[0]).toHaveProperty('error');
  await expect(routes.close()).rejects.toBe(reason);
});
