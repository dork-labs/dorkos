import { describe, it, expect, vi } from 'vitest';
import {
  checkPerson,
  readRegisterResult,
  requirePerson,
  serverEntryRegister,
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

describe('serverEntryRegister', () => {
  it('takes a register function exported either way', () => {
    const register = vi.fn();
    expect(serverEntryRegister(register)).toBe(register);
    expect(serverEntryRegister({ default: register })).toBe(register);
  });

  it('serves a default export that has a fetch handler, as register would return it', async () => {
    const app = {
      prefix: 'app:',
      fetch(request: Request, caller: ExtensionCaller) {
        return new Response(
          `${this.prefix}${new URL(request.url).pathname}:${String(caller.person.ok)}`
        );
      },
    };
    const register = serverEntryRegister({ default: app });
    expect(register).not.toBeNull();

    const outcome = readRegisterResult(await register!({} as never, {} as never));
    const answer = await outcome.fetch!(new Request('http://localhost/items'), person);
    // Called on its owner, so a method that reads `this` (a Hono app) works,
    // and handed the caller, which a Hono app reads as `c.env`.
    expect(await answer.text()).toBe('app:/items:true');
    expect(outcome.cleanup).toBeNull();
  });

  it('finds nothing in an entry with neither', () => {
    expect(serverEntryRegister({})).toBeNull();
    expect(serverEntryRegister({ default: 42 })).toBeNull();
    expect(serverEntryRegister(null)).toBeNull();
    expect(serverEntryRegister({ default: { fetch: 'not a function' } })).toBeNull();
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
