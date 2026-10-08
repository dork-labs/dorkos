import { logger } from '../../../../lib/logger.js';
import { BrowserLocalDestinationReceiptSchema } from '@dorkos/shared/browser-schemas';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { expect, it, onTestFinished, vi } from 'vitest';
const originFacts = vi.hoisted(() => ({ allowed: true }));
vi.mock('../../../../middleware/browser-origin.js', () => ({
  resolveBrowserOriginFacts: () => ({
    hostAllowed: originFacts.allowed,
    origin: 'http://localhost:4242',
  }),
}));
vi.mock('../../../../lib/trusted-origins.js', () => ({
  isTrustedBrowserOrigin: () => true,
}));
import { createProductionBrowserRuntimeRoutes } from '../runtime-routes.js';
import { BrokerError } from '../../egress/broker/errors.js';
import { BrowserStartupRefusal, isOriginalStartupRefusal } from '../startup-mode.js';

function fixture(
  path = '/control',
  beforeActor?: () => void,
  allowLocalDestination?: Parameters<
    typeof createProductionBrowserRuntimeRoutes
  >[0]['allowLocalDestination']
) {
  originFacts.allowed = true;
  let current = true;
  let requestAvailable = true;
  const capturedOwner = Object.assign(
    () => {
      beforeActor?.();
      return current;
    },
    { ownerId: 'fixture-owner' }
  );
  const closeMode = vi.fn(async () => {});
  const captureOwner = vi.fn(async () => capturedOwner);
  const closeBrowser = vi.fn(async () => {});
  const fenceRequests = vi.fn(() => {
    requestAvailable = false;
  });
  const delegate = vi.fn();
  const originalForBinding = vi.fn(() => ({ router: delegate }));
  const originalForTicket = vi.fn(() => ({ router: delegate }));
  const originalForAttachment = vi.fn(() => ({ router: delegate }));
  const modeCurrent = () => requestAvailable;
  const mode = {
    isOriginalStartupRefusal,
    close: closeMode,
    allowLocalDestination,
    captureOwner,
    closeBrowser,
    registry: {
      instances: () => [],
      instance: () => undefined,
      stop: async () => {},
    },
    store: { profiles: () => [] },
    modeCurrent,
    fenceRequests,
    originalForBinding,
    originalForTicket,
    originalForAttachment,
  };
  const routes = createProductionBrowserRuntimeRoutes(
    mode as unknown as Parameters<typeof createProductionBrowserRuntimeRoutes>[0]
  );
  // Read the actual Express route, rather than a test replica of admission or cleanup.
  const layer = routes.router.stack.find(
    (entry) =>
      entry.route?.path === path ||
      (Array.isArray(entry.route?.path) && entry.route.path.includes(path))
  )!;
  const dispatch = layer.route!.stack[0]!.handle as (request: Request, response: Response) => void;
  const req = Object.assign(new EventEmitter(), {
    headers: {},
    body: {},
    aborted: false,
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    statusCode: 200,
    finished: false,
    writable: true,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    json() {
      return this;
    },
    destroy() {
      this.destroyed = true;
      return this;
    },
    end(_bytes: Buffer, done: (reason?: unknown) => void) {
      done();
      return this;
    },
  });
  return {
    routes,
    mode,
    closeMode,
    captureOwner,
    closeBrowser,
    fenceRequests,
    originalForBinding,
    originalForTicket,
    originalForAttachment,
    delegate,
    modeCurrent,
    dispatch,
    req,
    res,
    revoke: () => {
      current = false;
    },
  };
}

it.each([undefined, false])(
  'joins captured removers after original registration throws %s without healing',
  async (reason) => {
    const f = fixture();
    let closing: Promise<void> | undefined;
    onTestFinished(async () => {
      closing ??= f.routes.close();
      const results = await Promise.allSettled([closing]);
      if (results[0]!.status !== 'rejected' || !Object.is(results[0]!.reason, reason))
        throw new Error('ORIGINAL_REGISTRATION_CAUSE_NOT_RETAINED');
    });
    const removeRequest = vi.spyOn(f.req, 'removeListener');
    const removeResponse = vi.spyOn(f.res, 'removeListener');
    vi.spyOn(f.res, 'once').mockImplementation(() => {
      throw reason;
    });
    f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
    closing = f.routes.close();
    await expect(closing).rejects.toBe(reason);
    expect(removeRequest).toHaveBeenCalledWith('aborted', expect.any(Function));
    expect(removeResponse).toHaveBeenCalledWith('close', expect.any(Function));
    expect(f.req.listenerCount('aborted')).toBe(0);
    expect(f.closeMode).toHaveBeenCalledOnce();
  }
);

it('retains genuine writable callback custody after error response enters, including shutdown', async () => {
  const f = fixture();
  let callback: ((reason?: unknown) => void) | undefined;
  let entered!: () => void;
  const publicationEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closing: Promise<void> | undefined;
  onTestFinished(async () => {
    callback?.();
    closing ??= f.routes.close();
    const results = await Promise.allSettled([closing]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  f.res.end = (_bytes, done) => {
    callback = done;
    f.res.writableEnded = true;
    f.res.writableFinished = true;
    entered();
    return f.res;
  };
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  await publicationEntered;
  closing = f.routes.close();
  let settled = false;
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  callback!();
  await closing;
  expect(f.req.listenerCount('aborted')).toBe(0);
  expect(f.res.listenerCount('close')).toBe(0);
});

it.each([new BrokerError('CLOSED'), new BrowserStartupRefusal('runtimeMissing')])(
  'retains an original end callback typed failure as the exact later close cause',
  async (reason) => {
    const f = fixture();
    let entered!: () => void;
    const publicationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originals: { close?: Promise<void> } = {};
    onTestFinished(async () => {
      originals.close ??= f.routes.close();
      const results = await Promise.allSettled([originals.close]);
      if (results[0]!.status !== 'rejected' || results[0]!.reason !== reason)
        throw new Error('ORIGINAL_TYPED_CALLBACK_CAUSE_NOT_RETAINED');
    });
    f.res.end = (_bytes, callback) => {
      f.res.writableEnded = true;
      entered();
      callback(reason);
      return f.res;
    };
    f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
    await publicationEntered;
    originals.close = f.routes.close();
    await expect(originals.close).rejects.toBe(reason);
    expect(f.closeMode).toHaveBeenCalledOnce();
    expect(f.req.listenerCount('aborted')).toBe(0);
    expect(f.res.listenerCount('close')).toBe(0);
  }
);

it('refuses successful publication when an original output getter revokes the captured actor', async () => {
  const f = fixture('/instances/close');
  const originals: { close?: Promise<void> } = {};
  onTestFinished(async () => {
    originals.close ??= f.routes.close();
    const results = await Promise.allSettled([originals.close]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  f.req.body = {
    requestId: 'r'.repeat(22),
    browserId: 'b'.repeat(22),
    browserGeneration: 1,
  };
  let observations = 0;
  Object.defineProperty(f.req, 'aborted', {
    get() {
      if (++observations === 2) f.revoke();
      return false;
    },
  });
  let returned!: () => void;
  const publication = new Promise<void>((resolve) => {
    returned = resolve;
  });
  const bytes: Buffer[] = [];
  f.res.end = (body, callback) => {
    bytes.push(body);
    f.res.writableEnded = true;
    callback();
    returned();
    return f.res;
  };
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  await publication;
  originals.close = f.routes.close();
  await originals.close;
  expect(observations).toBe(2);
  expect(bytes).toHaveLength(1);
  expect(JSON.parse(bytes[0]!.toString())).toHaveProperty('error');
  expect(JSON.parse(bytes[0]!.toString())).not.toHaveProperty('cleanup');
});

it('refuses successful publication when the original captured actor changes Node response data and returns true', async () => {
  let calls = 0;
  const f = fixture('/instances/close', () => {
    if (++calls === 2) f.res.statusCode = 503;
  });
  const originals: { close?: Promise<void> } = {};
  onTestFinished(async () => {
    originals.close ??= f.routes.close();
    const results = await Promise.allSettled([originals.close]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  f.req.body = {
    requestId: 'r'.repeat(22),
    browserId: 'b'.repeat(22),
    browserGeneration: 1,
  };
  const bytes: Buffer[] = [];
  let returned!: () => void;
  const publication = new Promise<void>((resolve) => {
    returned = resolve;
  });
  f.res.end = (body, callback) => {
    bytes.push(body);
    f.res.writableEnded = true;
    callback();
    returned();
    return f.res;
  };
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  await publication;
  originals.close = f.routes.close();
  await originals.close;
  expect(calls).toBe(2);
  expect(bytes).toHaveLength(1);
  expect(JSON.parse(bytes[0]!.toString())).toHaveProperty('error');
  expect(JSON.parse(bytes[0]!.toString())).not.toHaveProperty('cleanup');
});

it('settles a locally denied original origin through bounded output and leaves later close healthy', async () => {
  const f = fixture();
  const originals: { close?: Promise<void> } = {};
  onTestFinished(async () => {
    try {
      originals.close ??= f.routes.close();
      const results = await Promise.allSettled([originals.close]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
      originFacts.allowed = true;
    }
  });
  const bytes: Buffer[] = [];
  let returned!: () => void;
  const publication = new Promise<void>((resolve) => {
    returned = resolve;
  });
  f.res.end = (body, callback) => {
    bytes.push(body);
    f.res.writableEnded = true;
    callback();
    returned();
    return f.res;
  };
  originFacts.allowed = false;
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  await publication;
  originals.close = f.routes.close();
  await originals.close;
  expect(bytes).toHaveLength(1);
  expect(JSON.parse(bytes[0]!.toString())).toHaveProperty('error');
  expect(f.req.listenerCount('aborted')).toBe(0);
  expect(f.res.listenerCount('close')).toBe(0);
});

// A normal shutdown denial is local; an entered original end producer's failure is not.
it.each([undefined, false, new BrokerError('CLOSED')])(
  'preserves original synchronous writable failure %s through shutdown',
  async (reason) => {
    const f = fixture();
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closing: Promise<void> | undefined;
    onTestFinished(async () => {
      closing ??= f.routes.close();
      const results = await Promise.allSettled([closing]);
      if (results[0]?.status !== 'rejected' || !Object.is(results[0].reason, reason))
        throw new Error('ORIGINAL_WRITABLE_CAUSE_NOT_RETAINED');
    });
    const end = vi.spyOn(f.res, 'end').mockImplementation(() => {
      entered();
      throw reason;
    });
    f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
    await entering;
    closing = f.routes.close();
    await expect(closing).rejects.toBe(reason);
    expect(end).toHaveBeenCalledOnce();
    expect(f.closeMode).toHaveBeenCalledOnce();
    expect(f.req.listenerCount('aborted')).toBe(0);
    expect(f.res.listenerCount('close')).toBe(0);
  }
);

it('actual owner local endpoint route consumes exact selector and joins its original output', async () => {
  const input = {
    requestId: 'local_permission_original_request',
    binding: {
      browserId: 'browser_original_reference_001',
      browserGeneration: 1,
      tabId: 'tab_original_reference_000001',
      epoch: 0,
      inputGeneration: 0,
      navigationGeneration: 0,
      viewportVersion: 0,
    },
    endpoint: 'http://127.0.0.1:4567/',
    ttlMilliseconds: 300000,
  };
  const allow = vi.fn<
    Parameters<typeof createProductionBrowserRuntimeRoutes>[0]['allowLocalDestination']
  >(async (_headers, value) => ({
    requestId: value.requestId,
    binding: value.binding,
    endpoint: new URL(value.endpoint).origin,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  }));
  const f = fixture('/runtime/local-destination', undefined, allow);
  onTestFinished(() => f.routes.close());
  const end = vi.spyOn(f.res, 'end');
  f.req.body = input;
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  await vi.waitFor(() => expect(allow).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
  const receipt = BrowserLocalDestinationReceiptSchema.parse(
    JSON.parse(end.mock.calls[0]![0].toString())
  );
  expect(receipt).toEqual({
    requestId: input.requestId,
    binding: input.binding,
    endpoint: 'http://127.0.0.1:4567',
    expiresAt: expect.any(String),
  });
  expect(f.res.statusCode).toBe(200);
  await f.routes.close();
  expect(allow.mock.calls[0]![1]).toEqual(input);
});

it.each([undefined, false])(
  'fences a second valid request and delegated routes after original writable failure %s',
  async (reason) => {
    const f = fixture('/instances/close');
    let closing: Promise<void> | undefined;
    onTestFinished(async () => {
      closing ??= f.routes.close();
      const [result] = await Promise.allSettled([closing]);
      if (result?.status !== 'rejected' || !Object.is(result.reason, reason))
        throw new Error('ORIGINAL_WRITABLE_CAUSE_NOT_RETAINED');
    });
    // The first request is locally invalid: its real error-response writer is the failing original.
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.res.end = () => {
      entered();
      throw reason;
    };
    f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
    await entering;
    const admittedBefore = f.captureOwner.mock.calls.length;
    const second = fixture('/instances/close');
    onTestFinished(() => second.routes.close());
    second.req.body = {
      requestId: 'r'.repeat(22),
      browserId: 'b'.repeat(22),
      browserGeneration: 1,
    };
    const publish = vi.spyOn(second.res, 'end');
    // Consume the original mounted handler again, with a valid request and a fresh writable.
    f.dispatch(second.req as unknown as Request, second.res as unknown as Response);
    await Promise.resolve();
    expect(second.res.statusCode).toBe(503);
    expect(f.captureOwner).toHaveBeenCalledTimes(admittedBefore);
    expect(f.closeBrowser).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    // The actual router-wide fence precedes viewer/input dispatch and metadata lookup.
    const admission = f.routes.router.stack[0]!.handle;
    const next = vi.fn();
    for (const path of [
      '/viewers/issue',
      '/input',
      '/viewers/next',
      '/viewers/disconnect',
      '/instances',
    ]) {
      Object.defineProperty(second.req, 'body', {
        configurable: true,
        get() {
          throw new Error(path);
        },
      });
      admission(second.req as unknown as Request, second.res as unknown as Response, next);
    }
    expect(next).not.toHaveBeenCalled();
    closing = f.routes.close();
    await expect(closing).rejects.toBe(reason);
  }
);

it('fences an already queued valid request after another original registration fails', async () => {
  const f = fixture('/instances/close');
  let release!: (value: Awaited<ReturnType<typeof f.captureOwner>>) => void;
  const owner = new Promise<Awaited<ReturnType<typeof f.captureOwner>>>((resolve) => {
    release = resolve;
  });
  f.captureOwner.mockReturnValueOnce(owner);
  const originals: { close?: Promise<void> } = {};
  onTestFinished(async () => {
    release(Object.assign(() => true, { ownerId: 'fixture-owner' }));
    originals.close ??= f.routes.close();
    const [result] = await Promise.allSettled([originals.close]);
    if (result?.status !== 'rejected' || result.reason !== undefined)
      throw new Error('ORIGINAL_REGISTRATION_CAUSE_NOT_RETAINED');
  });
  f.req.body = {
    requestId: 'r'.repeat(22),
    browserId: 'b'.repeat(22),
    browserGeneration: 1,
  };
  const publish = vi.spyOn(f.res, 'end');
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  await Promise.resolve();
  expect(f.captureOwner).toHaveBeenCalledOnce();
  const failing = fixture('/instances/close');
  onTestFinished(() => failing.routes.close());
  vi.spyOn(failing.res, 'once').mockImplementation(() => {
    throw undefined;
  });
  f.dispatch(failing.req as unknown as Request, failing.res as unknown as Response);
  release(Object.assign(() => true, { ownerId: 'fixture-owner' }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.closeBrowser).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  originals.close = f.routes.close();
  await expect(originals.close).rejects.toBeUndefined();
  expect(f.closeBrowser).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it.each(['/input', '/copy-selection', '/viewers/issue', '/viewers/next', '/viewers/disconnect'])(
  'fences delegated %s after an original request-body getter reentrantly latches failure',
  async (path) => {
    const f = fixture(path);
    const failing = fixture('/instances/close');
    onTestFinished(() => failing.routes.close());
    // Invoke the SAME failed owner: an original response registration fails while parsing its next body.
    const ownFail = f.routes.router.stack.find((entry) => entry.route?.path === '/instances/close')!
      .route!.stack[0]!.handle;
    vi.spyOn(failing.res, 'once').mockImplementation(() => {
      throw undefined;
    });
    let entered = false;
    Object.defineProperty(f.req, 'body', {
      get() {
        if (!entered) {
          entered = true;
          ownFail(failing.req as unknown as Request, failing.res as unknown as Response, () => {});
        }
        return {
          ticket: 't'.repeat(43),
          binding: {
            browserId: 'b'.repeat(22),
            browserGeneration: 1,
            tabId: 't'.repeat(22),
            navigationGeneration: 1,
            viewportVersion: 1,
            epoch: 1,
            inputGeneration: 1,
          },
        };
      },
    });
    const closing: { value?: Promise<void> } = {};
    onTestFinished(async () => {
      closing.value ??= f.routes.close();
      const [result] = await Promise.allSettled([closing.value]);
      if (result?.status !== 'rejected' || result.reason !== undefined)
        throw new Error('FIRST_ROUTE_CAUSE_LOST');
    });
    f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
    expect(entered).toBe(true);
    expect(f.originalForBinding).not.toHaveBeenCalled();
    expect(f.originalForTicket).not.toHaveBeenCalled();
    expect(f.delegate).not.toHaveBeenCalled();
    expect(f.fenceRequests).toHaveBeenCalledOnce();
    expect(f.modeCurrent()).toBe(false);
    closing.value = f.routes.close();
    await expect(closing.value).rejects.toBeUndefined();
  }
);

it('revokes the retained mode predicate before an already-entered delegate auth await resumes', async () => {
  const f = fixture('/input');
  const failing = fixture('/instances/close');
  onTestFinished(() => failing.routes.close());
  let release!: () => void;
  const auth = new Promise<void>((resolve) => {
    release = resolve;
  });
  let duty: Promise<void> | undefined;
  const nativeStep = vi.fn();
  const publish = vi.fn();
  f.delegate.mockImplementation(() => {
    duty = auth.then(() => {
      // Portable original delegate receiver: the real retained grants/session use this same mode predicate.
      if (!f.modeCurrent()) return;
      nativeStep();
      publish();
    });
  });
  const closing: { value?: Promise<void> } = {};
  onTestFinished(async () => {
    release();
    if (duty) await duty;
    closing.value ??= f.routes.close();
    const [result] = await Promise.allSettled([closing.value]);
    if (result?.status !== 'rejected' || result.reason !== undefined)
      throw new Error('FIRST_ROUTE_CAUSE_LOST');
  });
  f.req.body = {
    binding: {
      browserId: 'b'.repeat(22),
      browserGeneration: 1,
      tabId: 't'.repeat(22),
      navigationGeneration: 1,
      viewportVersion: 1,
      epoch: 1,
      inputGeneration: 1,
    },
  };
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  expect(f.delegate).toHaveBeenCalledOnce();
  const ownFail = f.routes.router.stack.find((entry) => entry.route?.path === '/instances/close')!
    .route!.stack[0]!.handle;
  vi.spyOn(failing.res, 'once').mockImplementation(() => {
    throw undefined;
  });
  ownFail(failing.req as unknown as Request, failing.res as unknown as Response, () => {});
  release();
  await duty;
  expect(nativeStep).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  closing.value = f.routes.close();
  await expect(closing.value).rejects.toBeUndefined();
});

const optionalBindingPaths = [
  ...['read', 'action', 'stream', 'next', 'close'].flatMap((kind) => [
    `/semantic/${kind}`,
    `/semantic/owner/${kind}`,
  ]),
  '/diagnostics',
  '/canvas/present',
];
const optionalAttachmentPaths = ['/canvas/share', '/canvas/delivery', '/canvas/detach'];
const optionalBinding = {
  browserId: 'b'.repeat(22),
  browserGeneration: 1,
  tabId: 't'.repeat(22),
  navigationGeneration: 1,
  viewportVersion: 1,
  epoch: 1,
  inputGeneration: 1,
};
it.each([...optionalBindingPaths, ...optionalAttachmentPaths])(
  'dispatches optional %s to its exact retained session, leaving authentication to the child',
  (path) => {
    const f = fixture(path);
    onTestFinished(() => f.routes.close());
    f.req.body = { binding: optionalBinding, attachmentId: 'a'.repeat(22) };
    f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
    expect(f.delegate).toHaveBeenCalledOnce();
    if (optionalBindingPaths.includes(path)) {
      expect(f.originalForBinding).toHaveBeenCalledWith(optionalBinding);
      expect(f.originalForAttachment).not.toHaveBeenCalled();
    } else {
      expect(f.originalForAttachment).toHaveBeenCalledWith('a'.repeat(22));
      expect(f.originalForBinding).not.toHaveBeenCalled();
    }
  }
);
it.each([...optionalBindingPaths, ...optionalAttachmentPaths])(
  'refuses optional %s after its original selector getter reentrantly fences this same owner',
  async (path) => {
    const f = fixture(path);
    const failing = fixture('/instances/close');
    onTestFinished(() => failing.routes.close());
    const ownFail = f.routes.router.stack.find((entry) => entry.route?.path === '/instances/close')!
      .route!.stack[0]!.handle;
    vi.spyOn(failing.res, 'once').mockImplementation(() => {
      throw false;
    });
    Object.defineProperty(f.req, 'body', {
      get() {
        ownFail(failing.req as unknown as Request, failing.res as unknown as Response, () => {});
        return { binding: optionalBinding, attachmentId: 'a'.repeat(22) };
      },
    });
    onTestFinished(async () => {
      const [result] = await Promise.allSettled([f.routes.close()]);
      if (result?.status !== 'rejected' || result.reason !== false)
        throw new Error('OPTIONAL_SELECTOR_FIRST_CAUSE_LOST');
    });
    f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
    expect(f.originalForBinding).not.toHaveBeenCalled();
    expect(f.originalForAttachment).not.toHaveBeenCalled();
    expect(f.delegate).not.toHaveBeenCalled();
    await expect(f.routes.close()).rejects.toBe(false);
  }
);

it('captures the original mode refusal predicate before a later replacement tries to excuse an unknown producer error', async () => {
  const f = fixture('/instances/close');
  const reason = new BrokerError('AUTHORITY_REFUSED');
  f.mode.isOriginalStartupRefusal = () => true;
  f.captureOwner.mockRejectedValueOnce(reason);
  f.req.body = {
    requestId: 'r'.repeat(22),
    browserId: 'b'.repeat(22),
    browserGeneration: 1,
  };
  let entered!: () => void;
  const publication = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.res.end = (_bytes, done) => {
    done();
    entered();
    return f.res;
  };
  onTestFinished(async () => {
    const [result] = await Promise.allSettled([f.routes.close()]);
    expect(result).toMatchObject({ status: 'rejected', reason });
  });
  f.dispatch(f.req as unknown as Request, f.res as unknown as Response);
  await publication;
  expect(f.fenceRequests).toHaveBeenCalledWith(reason);
  expect(f.closeBrowser).not.toHaveBeenCalled();
});

it.each([
  false,
  undefined,
  new Error('page.goto: net::ERR_INVALID_AUTH_CREDENTIALS at https://secret.invalid/'),
])(
  'publishes only fixed original navigate diagnostic after admission is fenced for %s',
  async (reason) => {
    const rows: unknown[] = [];
    const sink = vi.spyOn(logger, 'info').mockImplementation((label, row) => {
      if (label === 'Browser original navigation refusal') {
        expect(f?.fenceRequests).toHaveBeenCalledWith(reason);
        rows.push(row);
        throw undefined;
      }
    });
    const f = fixture('/runtime/navigate');
    const original = f;
    onTestFinished(async () => {
      try {
        const results = await Promise.allSettled([original.routes.close()]);
        if (results[0]?.status !== 'rejected' || !Object.is(results[0].reason, reason))
          throw new Error('ORIGINAL_NAVIGATION_CAUSE_NOT_RETAINED');
      } finally {
        sink.mockRestore();
      }
    });
    original.originalForBinding.mockImplementation(() => ({
      router: original.delegate,
      navigation: () => ({
        capture: () => ({
          navigate: async () => {
            throw reason;
          },
        }),
      }),
    }));
    original.req.body = {
      command: {
        kind: 'navigate',
        requestId: 'r'.repeat(22),
        binding: optionalBinding,
        url: 'https://example.com/',
      },
      controllerId: 'c'.repeat(22),
    };
    let published!: () => void;
    const returned = new Promise<void>((yes) => {
      published = yes;
    });
    const end = original.res.end.bind(original.res);
    const write = vi.spyOn(original.res, 'end').mockImplementation((bytes, done) => {
      const result = end(bytes, done);
      published();
      return result;
    });
    original.dispatch(original.req as unknown as Request, original.res as unknown as Response);
    await returned;
    await expect(original.routes.close()).rejects.toBe(reason);
    expect(original.closeMode).toHaveBeenCalledOnce();
    expect(original.res.statusCode).toBe(503);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ordinal: 1,
      phase: 'unknown',
      decision: 'unknown',
      code: 'unknown',
      nativeError: reason instanceof Error ? 'ERR_INVALID_AUTH_CREDENTIALS' : 'unknown',
    });
    expect(JSON.stringify(rows)).not.toContain('secret.invalid');
    expect(JSON.parse(write.mock.calls[0]![0].toString())).toEqual({
      error: 'The shared browser needs a verified installation and a signed-in owner.',
    });
  }
);

it.each(['current', 'invalid', 'unavailable'] as const)(
  'routes owner copy selection by its exact command binding: %s',
  (state) => {
    const f = fixture('/input');
    const originals: { close?: Promise<void> } = {};
    onTestFinished(() => originals.close ?? f.routes.close());
    const layer = f.routes.router.stack.find(
      (entry) => Array.isArray(entry.route?.path) && entry.route.path.includes('/copy-selection')
    );
    // The public mount must reach the same original session capability as ordinary input.
    expect(layer).toBeDefined();
    if (!layer) throw new Error('COPY_SESSION_DELEGATION_MISSING');
    const command = {
      requestId: 'r'.repeat(22),
      binding: state === 'invalid' ? { ...optionalBinding, epoch: -1 } : optionalBinding,
    };
    f.req.body = { controllerId: 'c'.repeat(22), command };
    if (state === 'unavailable') originals.close = f.routes.close();
    layer.route!.stack[0]!.handle(
      f.req as unknown as Request,
      f.res as unknown as Response,
      () => {}
    );
    if (state === 'current') {
      expect(f.originalForBinding).toHaveBeenCalledExactlyOnceWith(optionalBinding);
      expect(f.delegate).toHaveBeenCalledExactlyOnceWith(f.req, f.res, expect.any(Function));
      expect(f.req.body).toEqual({ controllerId: 'c'.repeat(22), command });
      expect(f.res.statusCode).toBe(200);
    } else {
      expect(f.originalForBinding).not.toHaveBeenCalled();
      expect(f.delegate).not.toHaveBeenCalled();
      expect(f.res.statusCode).toBe(404);
    }
    expect(f.originalForTicket).not.toHaveBeenCalled();
    expect(f.originalForAttachment).not.toHaveBeenCalled();
  }
);
