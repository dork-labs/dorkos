import { fixture, target } from './input-routes.fixture.js';
import { isOriginalBrowserDiagnosticRefusal as isOriginalSourceDiagnosticRefusal } from '../../../../../../../packages/browser/src/engine.js';
import express from 'express';
import { expect, it, onTestFinished, vi } from 'vitest';
import { getAuth } from '../../../core/auth/index.js';
import { BrowserApiRefusal } from '../service.js';
import request from '@dorkos/test-utils/supertest';
import { BrowserDiagnosticSummarySchema } from '@dorkos/shared/browser-schemas';
import { sessionGate } from '../../../core/auth/session-gate.js';
import { BrowserDiagnosticsHost } from '../diagnostics-host.js';
import { BrowserDiagnosticsRoutes } from '../diagnostics-routes.js';

// Real HTTP/auth/server-store/SQLite/grant/engine composition; inherited native Page/process
// doubles remain explicit. These controls establish scalar delivery, not native diagnostics.
it('delivers only original scalar diagnostics with a separate diagnostics grant through real HTTP', async () => {
  const f = await fixture();
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  const routes = new BrowserDiagnosticsRoutes(host);
  try {
    const grant = f.issueGrant(['browser.diagnostics']);
    let secretReads = 0;
    f.page.event('console', {
      type: () => 'warning',
      get text() {
        secretReads++;
        throw new Error('secret sentinel');
      },
    });
    f.page.event('pageerror', {
      get message() {
        secretReads++;
        throw new Error('secret sentinel');
      },
    });
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.use('/api/private-browser', routes.router);
    target.mount(app);
    const response = await request(target.server)
      .post('/api/private-browser/diagnostics')
      .set('Cookie', f.cookieViewer)
      .set('Origin', f.origin)
      .set('Host', f.host)
      .send({
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      });
    expect(response.status).toBe(200);
    const actual = BrowserDiagnosticSummarySchema.parse(response.body);
    expect(actual.binding).toEqual(f.seat.binding);
    expect(actual.entries.map((entry) => entry.category)).toEqual(['console', 'error']);
    expect(secretReads).toBe(0);
    expect(JSON.stringify(actual)).not.toContain('secret sentinel');
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    await routes.close();
  }
});

it('does not lend control-only or foreign-owner grant authority to diagnostics', async () => {
  const f = await fixture();
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  try {
    const grant = f.issueGrant(['browser.control']);
    const body = {
      binding: f.seat.binding,
      grant: { grantId: grant.grantId, revision: grant.grantRevision },
    };
    await expect(
      host.capture(
        f.recipientRequest.req,
        f.recipientRequest.res,
        body,
        new AbortController().signal
      )
    ).rejects.toThrow();
    const diagnostic = f.issueGrant(['browser.diagnostics']);
    await expect(
      host.capture(
        f.ownerRequest.req,
        f.ownerRequest.res,
        {
          ...body,
          grant: {
            grantId: diagnostic.grantId,
            revision: diagnostic.grantRevision,
          },
        },
        new AbortController().signal
      )
    ).rejects.toThrow();
  } finally {
    await host.close();
  }
});

it('rechecks actual grant revocation after serialization before original publication', async () => {
  const f = await fixture();
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  try {
    const grant = f.issueGrant(['browser.diagnostics']);
    const lease = await host.capture(
      f.recipientRequest.req,
      f.recipientRequest.res,
      {
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      },
      new AbortController().signal
    );
    f.grants.revoke(f.ownerAuth.current, grant.grantId, grant.grantRevision);
    let effects = 0;
    expect(() =>
      lease.publish(() => {
        effects++;
      })
    ).toThrow();
    expect(effects).toBe(0);
  } finally {
    await host.close();
  }
});

it('refuses changed Host at delivery without attributing a normal denial as unhealthy close', async () => {
  const f = await fixture();
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  try {
    const grant = f.issueGrant(['browser.diagnostics']);
    const lease = await host.capture(
      f.recipientRequest.req,
      f.recipientRequest.res,
      {
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      },
      new AbortController().signal
    );
    f.recipientRequest.req.headers.host = 'foreign.invalid';
    let effects = 0;
    expect(() =>
      lease.publish(() => {
        effects++;
      })
    ).toThrow();
    expect(effects).toBe(0);
  } finally {
    await host.close();
  }
});

it('accounts overflow using the actual bounded tab event owner, without unbounded website payload', async () => {
  const f = await fixture();
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  try {
    const grant = f.issueGrant(['browser.diagnostics']);
    for (let i = 0; i < 1024; i++) f.page.event('console', { type: () => 'info' });
    const lease = await host.capture(
      f.recipientRequest.req,
      f.recipientRequest.res,
      {
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      },
      new AbortController().signal
    );
    let actual: ReturnType<typeof BrowserDiagnosticSummarySchema.parse> | undefined;
    lease.publish((bytes) => {
      expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(266240);
      actual = BrowserDiagnosticSummarySchema.parse(JSON.parse(bytes));
    });
    expect(actual).toBeDefined();
    expect(actual!.entries.length).toBeLessThanOrEqual(256);
    expect(actual!.counts.dropped).toBeGreaterThan(0);
    expect(actual!.lastAccountedSequence).toBe(actual!.entries.length);
  } finally {
    await host.close();
  }
});

it('rejects a stale protocol epoch and fences delivery on close', async () => {
  const f = await fixture();
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  const grant = f.issueGrant(['browser.diagnostics']);
  const body = {
    binding: f.seat.binding,
    grant: { grantId: grant.grantId, revision: grant.grantRevision },
  };
  try {
    await expect(
      host.capture(
        f.recipientRequest.req,
        f.recipientRequest.res,
        {
          ...body,
          binding: { ...body.binding, epoch: body.binding.epoch + 1 },
        },
        new AbortController().signal
      )
    ).rejects.toThrow();
    const lease = await host.capture(
      f.recipientRequest.req,
      f.recipientRequest.res,
      body,
      new AbortController().signal
    );
    await host.close();
    expect(() =>
      lease.publish(() => {
        throw new Error('must never enter');
      })
    ).toThrow();
  } finally {
    await host.close();
  }
});

it('real HTTP refuses missing/foreign auth, missing Origin, stale binding and disabled access uniformly', async () => {
  const f = await fixture();
  let enabled = true;
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => enabled);
  const routes = new BrowserDiagnosticsRoutes(host);
  try {
    const grant = f.issueGrant(['browser.diagnostics']);
    const body = {
      binding: f.seat.binding,
      grant: { grantId: grant.grantId, revision: grant.grantRevision },
    };
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.use('/api/private-browser', routes.router);
    target.mount(app);
    const send = (cookie: string | undefined, origin: string | undefined, value = body) => {
      const call = request(target.server)
        .post('/api/private-browser/diagnostics')
        .set('Host', f.host);
      if (cookie) call.set('Cookie', cookie);
      if (origin) call.set('Origin', origin);
      return call.send(value);
    };
    expect((await send(undefined, f.origin)).status).toBe(401);
    expect((await send(f.cookieOwner, f.origin)).status).toBe(404);
    expect((await send(f.cookieViewer, undefined)).status).toBe(404);
    expect(
      (
        await send(f.cookieViewer, f.origin, {
          ...body,
          binding: {
            ...body.binding,
            navigationGeneration: body.binding.navigationGeneration + 1,
          },
        })
      ).status
    ).toBe(404);
    enabled = false;
    expect((await send(f.cookieViewer, f.origin)).status).toBe(404);
  } finally {
    await routes.close();
  }
});

it('joins a held original server-store verification and preserves its exact undefined refusal through close', async () => {
  const f = await fixture();
  const grant = f.issueGrant(['browser.diagnostics']);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.releases.push(release); // Existing preregistered original fixture finalizer owns early failure too.
  const auth = getAuth()!,
    original = auth.api.getSession;
  const callThrough = new Proxy(original, {
    apply(target, receiver, args) {
      const originalResult = Reflect.apply(target, receiver, args);
      return Promise.resolve(originalResult).then(async () => {
        entered();
        await held;
        throw undefined;
      });
    },
  });
  const observer = vi.spyOn(auth.api, 'getSession').mockImplementation(callThrough);
  let reads = 0;
  const originalRead = f.engine.diagnostics.bind(f.engine);
  const host = new BrowserDiagnosticsHost(
    {
      diagnostics(binding) {
        reads++;
        return originalRead(binding);
      },
    },
    f.grants,
    f.identities,
    () => true
  );
  const capture = host.capture(
    f.recipientRequest.req,
    f.recipientRequest.res,
    {
      binding: f.seat.binding,
      grant: { grantId: grant.grantId, revision: grant.grantRevision },
    },
    new AbortController().signal
  );
  void capture.catch(() => undefined);
  try {
    await observed;
    let closed = false;
    const closing = host.close();
    void closing.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      }
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(reads).toBe(0);
    release();
    await expect(capture).rejects.toBeUndefined();
    await expect(closing).rejects.toBeUndefined();
  } finally {
    release();
    await Promise.allSettled([capture, host.close()]);
    observer.mockRestore();
  }
});

it('does not treat a fresh producer-thrown typed refusal as ordinary denial or healthy close', async () => {
  const f = await fixture();
  const originalRead = f.engine.diagnostics.bind(f.engine);
  const original = new BrowserApiRefusal('unavailable');
  const host = new BrowserDiagnosticsHost(
    {
      diagnostics(binding) {
        originalRead(binding);
        throw original;
      },
    },
    f.grants,
    f.identities,
    () => true
  );
  const routes = new BrowserDiagnosticsRoutes(host);
  try {
    const grant = f.issueGrant(['browser.diagnostics']);
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.use('/api/private-browser', routes.router);
    target.mount(app);
    const response = await request(target.server)
      .post('/api/private-browser/diagnostics')
      .set('Cookie', f.cookieViewer)
      .set('Origin', f.origin)
      .set('Host', f.host)
      .send({
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Shared browser details couldn’t be read.',
    });
    await expect(host.close()).rejects.toBe(original);
    await expect(routes.close()).rejects.toBe(original);
  } finally {
    await Promise.allSettled([routes.close(), host.close()]);
  }
});

it('final original admission callback changes actual response state and cannot emit the diagnostic body', async () => {
  const f = await fixture();
  const grant = f.issueGrant(['browser.diagnostics']);
  let mutation: (() => void) | undefined;
  let mutated = false;
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => {
    if (mutation) {
      const original = mutation;
      mutation = undefined;
      original();
      mutated = true;
    }
    return true;
  });
  const routes = new BrowserDiagnosticsRoutes(host);
  try {
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.use((_req, res, next) => {
      const header = res.setHeader.bind(res);
      res.setHeader = new Proxy(res.setHeader, {
        apply(_target, _receiver, args) {
          const actual = Reflect.apply(header, undefined, args);
          if (args[0] === 'Cache-Control')
            mutation = () => {
              res.statusCode = 503;
            };
          return actual;
        },
      });
      next();
    });
    app.use('/api/private-browser', routes.router);
    target.mount(app);
    const actual = await request(target.server)
      .post('/api/private-browser/diagnostics')
      .set('Cookie', f.cookieViewer)
      .set('Origin', f.origin)
      .set('Host', f.host)
      .send({
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      });
    expect(mutated).toBe(true);
    expect(actual.status).toBe(404);
    expect(actual.body).toEqual({ error: 'Shared browser is unavailable.' });
  } finally {
    await routes.close();
  }
});

it('preserves an original response acquisition getter throwing undefined after request settlement', async () => {
  const f = await fixture();
  const grant = f.issueGrant(['browser.diagnostics']);
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  const routes = new BrowserDiagnosticsRoutes(host);
  let entered = 0;
  try {
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.use((req, _res, next) => {
      const original = req.on;
      Object.defineProperty(req, 'on', {
        configurable: true,
        get() {
          entered++;
          if (entered === 1) throw undefined;
          return original;
        },
      });
      next();
    });
    app.use('/api/private-browser', routes.router);
    target.mount(app);
    await expect(
      request(target.server)
        .post('/api/private-browser/diagnostics')
        .set('Cookie', f.cookieViewer)
        .set('Origin', f.origin)
        .set('Host', f.host)
        .send({
          binding: f.seat.binding,
          grant: { grantId: grant.grantId, revision: grant.grantRevision },
        })
    ).rejects.toBeDefined();
    expect(entered).toBeGreaterThan(0);
    await expect(routes.close()).rejects.toBeUndefined();
    await expect(host.close()).resolves.toBeUndefined();
  } finally {
    await Promise.allSettled([routes.close(), host.close()]);
  }
});

it('refuses accessor final response state without invoking its throwing original getter', async () => {
  const f = await fixture();
  const grant = f.issueGrant(['browser.diagnostics']);
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => true);
  const routes = new BrowserDiagnosticsRoutes(host);
  let threw = false;
  try {
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.use((_req, res, next) => {
      const header = res.setHeader.bind(res);
      let writable = res.writable,
        armed = false;
      res.setHeader = new Proxy(res.setHeader, {
        apply(_target, _receiver, args) {
          const actual = Reflect.apply(header, undefined, args);
          if (args[0] === 'Cache-Control') armed = true;
          return actual;
        },
      });
      Object.defineProperty(res, 'writable', {
        configurable: true,
        get() {
          if (armed && !threw) {
            threw = true;
            throw undefined;
          }
          return writable;
        },
        set(value: boolean) {
          writable = value;
        },
      });
      next();
    });
    app.use('/api/private-browser', routes.router);
    target.mount(app);
    const actual = await request(target.server)
      .post('/api/private-browser/diagnostics')
      .set('Cookie', f.cookieViewer)
      .set('Origin', f.origin)
      .set('Host', f.host)
      .send({
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      });
    expect(threw).toBe(false);
    expect(actual.status).toBe(404);
    await expect(host.close()).resolves.toBeUndefined();
    await expect(routes.close()).resolves.toBeUndefined();
  } finally {
    await Promise.allSettled([routes.close(), host.close()]);
  }
});

it('marks only the exact source receiver local missing-generation refusal, not a same-code producer error', async () => {
  const f = await fixture();
  let actual: { value: unknown } | undefined;
  try {
    f.engine.diagnostics({
      ...f.seat.binding,
      browserGeneration: f.seat.binding.browserGeneration + 1,
    });
  } catch (value) {
    actual = { value };
  }
  expect(actual).toBeDefined();
  expect(isOriginalSourceDiagnosticRefusal(actual?.value)).toBe(true);
  expect(isOriginalSourceDiagnosticRefusal(new BrowserApiRefusal('inaccessible'))).toBe(false);
});

it('does not invoke a final status accessor that would revoke genuine diagnostics authority', async () => {
  const f = await fixture();
  const grant = f.issueGrant(['browser.diagnostics']);
  let enabled = true,
    armed = false,
    diagnosticStatusReads = 0;
  const host = new BrowserDiagnosticsHost(f.engine, f.grants, f.identities, () => enabled);
  const routes = new BrowserDiagnosticsRoutes(host);
  try {
    const app = express();
    app.use(express.json());
    app.use(sessionGate);
    app.use((_req, res, next) => {
      let status = res.statusCode;
      const header = res.setHeader.bind(res);
      res.setHeader = new Proxy(res.setHeader, {
        apply(_target, _receiver, args) {
          const result = Reflect.apply(header, undefined, args);
          if (args[0] === 'Cache-Control') armed = true;
          return result;
        },
      });
      Object.defineProperty(res, 'statusCode', {
        configurable: true,
        get() {
          if (armed && status === 200) {
            diagnosticStatusReads++;
            enabled = false;
          }
          return status;
        },
        set(value: number) {
          status = value;
        },
      });
      next();
    });
    app.use('/api/private-browser', routes.router);
    target.mount(app);
    const response = await request(target.server)
      .post('/api/private-browser/diagnostics')
      .set('Cookie', f.cookieViewer)
      .set('Origin', f.origin)
      .set('Host', f.host)
      .send({
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      });
    expect(armed).toBe(true);
    expect(diagnosticStatusReads).toBe(0);
    expect(enabled).toBe(true);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Shared browser is unavailable.' });
  } finally {
    await routes.close();
  }
});

it('a retained original Node publication fault refuses later authenticated diagnostics without another engine read', async () => {
  const bank: {
    routes?: BrowserDiagnosticsRoutes;
    operation?: Promise<unknown>;
    accepted: boolean;
  } = { accepted: false };
  onTestFinished(async () => {
    if (bank.operation) await Promise.allSettled([bank.operation]);
    if (bank.routes) {
      try {
        await bank.routes.close();
      } catch (value) {
        if (!bank.accepted || value !== undefined) throw value;
      }
    }
  });
  const f = await fixture();
  const read = vi.fn(f.engine.diagnostics.bind(f.engine));
  const host = new BrowserDiagnosticsHost(
    { diagnostics: read },
    f.grants,
    f.identities,
    () => true
  );
  const routes = (bank.routes = new BrowserDiagnosticsRoutes(host));
  const grant = f.issueGrant(['browser.diagnostics']);
  const app = express();
  app.use(express.json());
  app.use(sessionGate);
  let wireEntries = 0;
  app.use((_req, res, next) => {
    const original = res.end.bind(res);
    res.end = new Proxy(original, {
      apply(receiver, owner, args) {
        wireEntries++;
        if (wireEntries === 1) throw undefined;
        return Reflect.apply(receiver, owner, args);
      },
    });
    next();
  });
  app.use('/api/private-browser', routes.router);
  target.mount(app);
  const post = () =>
    request(target.server)
      .post('/api/private-browser/diagnostics')
      .set('Cookie', f.cookieViewer)
      .set('Origin', f.origin)
      .set('Host', f.host)
      .send({
        binding: f.seat.binding,
        grant: { grantId: grant.grantId, revision: grant.grantRevision },
      });
  bank.operation = post().then((value) => value);
  await Promise.allSettled([bank.operation]);
  expect(read).toHaveBeenCalledTimes(1);
  bank.accepted = true;
  const before = wireEntries;
  const second = (bank.operation = post().then((value) => value));
  const refused = await second;
  if (!refused || typeof refused !== 'object' || !('status' in refused))
    throw new Error('ORIGINAL_RESPONSE_MISSING');
  expect(refused.status).toBe(503);
  expect(read).toHaveBeenCalledTimes(1);
  expect(wireEntries).toBe(before + 1); // Only the refusal response; no second diagnostic payload.
  await expect(routes.close()).rejects.toBeUndefined();
});
