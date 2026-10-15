import { describe, it, expect, vi } from 'vitest';
import {
  checkPerson,
  readRegisterResult,
  requirePerson,
  defineServer,
  OLD_ROUTER_MESSAGE,
  OldRouterError,
  serverEntryStart,
  UNWRAPPED_SERVER_MESSAGE,
  type ExtensionCaller,
} from '../server-entry.js';

/** A fetch handler that answers with the path it was asked for. */
const echo = (request: Request) => new Response(new URL(request.url).pathname);

/** A caller the person bar admitted. */
const person: ExtensionCaller = { person: { ok: true } };

/** A caller the person bar refused, as DorkOS words it for an agent. */
const agent: ExtensionCaller = {
  person: {
    ok: false,
    status: 403,
    body: {
      error: "Only a person can change Flow's settings.",
      code: 'extension_person_required',
      message: 'DorkOS changed nothing.',
    },
  },
};

describe('serverEntryStart', () => {
  const ctx = { extensionId: 'my-ext' } as never;

  it('starts a defineServer entry with ctx alone, exported either way', async () => {
    const start = vi.fn((_given: unknown) => ({ fetch: echo }));
    const defined = defineServer(start);

    for (const exported of [defined, { default: defined }]) {
      const outcome = readRegisterResult(await serverEntryStart(exported)!(ctx));
      expect(outcome.fetch).toBeTypeOf('function');
    }
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.every((args) => args.length === 1 && args[0] === ctx)).toBe(true);
  });

  it('refuses a definition that is not a function', () => {
    expect(() => defineServer('nope' as never)).toThrow(TypeError);
  });

  it('serves a default export that has a fetch handler, as a start would return it', async () => {
    const app = {
      prefix: 'app:',
      fetch(request: Request, caller: ExtensionCaller) {
        return new Response(
          `${this.prefix}${new URL(request.url).pathname}:${String(caller.person.ok)}`
        );
      },
    };
    const start = serverEntryStart({ default: app });
    expect(start).not.toBeNull();

    const outcome = readRegisterResult(await start!(ctx));
    const answer = await outcome.fetch!(new Request('http://localhost/items'), person);
    // Called on its owner, so a method that reads `this` (a Hono app) works,
    // and handed the caller, which a Hono app reads as `c.env`.
    expect(await answer.text()).toBe('app:/items:true');
    expect(outcome.cleanup).toBeNull();
  });

  it('starts an older register(router, ctx) that leaves the router alone', async () => {
    const register = vi.fn((_router: unknown, given: unknown) => ({ fetch: echo, given }));

    const outcome = readRegisterResult(await serverEntryStart({ default: register })!(ctx));

    expect(outcome.fetch).toBeTypeOf('function');
    expect(register.mock.calls[0]![1]).toBe(ctx);
  });

  it.each([
    [
      'adds a route',
      (router: { get: (p: string, h: unknown) => void }) => router.get('/x', () => 0),
    ],
    ['reads a property', (router: { stack: unknown }) => router.stack],
    ['checks for a member', (router: object) => 'use' in router],
    ['sets a property', (router: Record<string, unknown>) => void (router.mergeParams = true)],
  ])('stops an older register that %s with the old-router message', async (_label, touch) => {
    const start = serverEntryStart((router: never) => {
      touch(router);
    })!;

    const failure = await Promise.resolve()
      .then(() => start(ctx))
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OldRouterError);
    expect((failure as OldRouterError).message).toBe(OLD_ROUTER_MESSAGE);
    expect((failure as OldRouterError).code).toBe('old_router');
  });

  it('tells a bare (ctx) => … entry to wrap itself, not that it uses the old router', async () => {
    const start = serverEntryStart({
      default: (ctx: { storage: unknown }) => ({ fetch: echo, storage: ctx.storage }),
    })!;

    const failure = await Promise.resolve()
      .then(() => start(ctx))
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe(UNWRAPPED_SERVER_MESSAGE);
  });

  it('finds nothing in an entry with none', () => {
    expect(serverEntryStart({})).toBeNull();
    expect(serverEntryStart({ default: 42 })).toBeNull();
    expect(serverEntryStart(null)).toBeNull();
    expect(serverEntryStart({ default: { fetch: 'not a function' } })).toBeNull();
  });
});

describe('readRegisterResult', () => {
  it('reads nothing as nothing', () => {
    expect(readRegisterResult(undefined)).toEqual({ cleanup: null, fetch: null });
  });

  it('reads a function as the cleanup, as it always has', () => {
    const cleanup = vi.fn();
    const outcome = readRegisterResult(cleanup);
    expect(outcome.fetch).toBeNull();
    outcome.cleanup!();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reads { fetch, cleanup }', async () => {
    const cleanup = vi.fn();
    const outcome = readRegisterResult({ fetch: echo, cleanup });
    expect(await (await outcome.fetch!(new Request('http://localhost/a/b'), person)).text()).toBe(
      '/a/b'
    );
    outcome.cleanup!();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('refuses a fetch or cleanup that is not a function', () => {
    expect(() => readRegisterResult({ fetch: 'nope' })).toThrow(TypeError);
    expect(() => readRegisterResult({ fetch: echo, cleanup: 1 })).toThrow(TypeError);
  });
});

describe('readRegisterResult passes the caller on', () => {
  it('hands a returned fetch handler the caller, called on its owner', async () => {
    const seen: unknown[] = [];
    const owner = {
      fetch(this: unknown, _request: Request, caller: ExtensionCaller) {
        seen.push(this, caller);
        return new Response(null, { status: 204 });
      },
    };
    const outcome = readRegisterResult(owner);
    await outcome.fetch!(new Request('http://localhost/'), agent);
    expect(seen).toEqual([owner, agent]);
  });
});

describe('checkPerson', () => {
  it('lets a person through', () => {
    expect(checkPerson(person)).toBeNull();
  });

  it('answers anyone else with the refusal DorkOS decided on', async () => {
    const refused = checkPerson(agent)!;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(agent.person.ok ? null : agent.person.body);
  });

  it.each([
    ['nothing', undefined],
    ['an empty object', {}],
    ['a forged yes', { person: { ok: 'true' } }],
    ['a refusal with no body', { person: { ok: false, status: 403 } }],
    ['a refusal with a success status', { person: { ok: false, status: 200, body: agent.person } }],
  ])('refuses %s, failing closed', async (_label, caller) => {
    const refused = checkPerson(caller)!;
    expect(refused).toBeInstanceOf(Response);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'extension_person_required' });
  });
});

describe('requirePerson', () => {
  it('runs the route for a person', async () => {
    const next = vi.fn(async () => undefined);
    expect(await requirePerson()({ env: person }, next)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('answers anyone else and never runs the route', async () => {
    const next = vi.fn(async () => undefined);
    const answer = await requirePerson()({ env: agent }, next);
    expect(next).not.toHaveBeenCalled();
    expect(answer).toBeInstanceOf(Response);
    expect((answer as Response).status).toBe(403);
  });

  it('refuses a context with no caller', async () => {
    const next = vi.fn(async () => undefined);
    const answer = await requirePerson()({ env: undefined }, next);
    expect(next).not.toHaveBeenCalled();
    expect((answer as Response).status).toBe(403);
  });
});
