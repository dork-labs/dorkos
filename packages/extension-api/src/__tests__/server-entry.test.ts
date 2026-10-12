import { describe, it, expect, vi } from 'vitest';
import { readRegisterResult, serverEntryRegister } from '../server-entry.js';

/** A fetch handler that answers with the path it was asked for. */
const echo = (request: Request) => new Response(new URL(request.url).pathname);

describe('serverEntryRegister', () => {
  it('takes a register function exported either way', () => {
    const register = vi.fn();
    expect(serverEntryRegister(register)).toBe(register);
    expect(serverEntryRegister({ default: register })).toBe(register);
  });

  it('serves a default export that has a fetch handler, as register would return it', async () => {
    const app = {
      prefix: 'app:',
      fetch(request: Request) {
        return new Response(`${this.prefix}${new URL(request.url).pathname}`);
      },
    };
    const register = serverEntryRegister({ default: app });
    expect(register).not.toBeNull();

    const outcome = readRegisterResult(await register!({} as never, {} as never));
    const answer = await outcome.fetch!(new Request('http://localhost/items'));
    // Called on its owner, so a method that reads `this` (a Hono app) works.
    expect(await answer.text()).toBe('app:/items');
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
    expect(await (await outcome.fetch!(new Request('http://localhost/a/b'))).text()).toBe('/a/b');
    outcome.cleanup!();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('refuses a fetch or cleanup that is not a function', () => {
    expect(() => readRegisterResult({ fetch: 'nope' })).toThrow(TypeError);
    expect(() => readRegisterResult({ fetch: echo, cleanup: 1 })).toThrow(TypeError);
  });
});
