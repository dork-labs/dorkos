// @vitest-environment jsdom
/**
 * What the composer is allowed to tell a person when a message will not send.
 *
 * `postMessage` used to throw `HTTP 400` and nothing else, so a refusal the
 * server had written a plain sentence for — "Choose a registered agent before
 * starting this session" — reached the composer as a status code under a Retry
 * button that could only fail the same way. The server's own words are the only
 * part of that failure anybody can act on.
 *
 * @module layers/shared/lib/transport/__tests__/session-methods-send-error
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionMethods } from '../session-methods';

function setup() {
  return createSessionMethods('http://localhost:4242/api', () => 'client-1', new Map(), new Map());
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('postMessage on a refusal', () => {
  it("throws the server's sentence, not its status code", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: 'Choose a registered agent before starting this session',
            code: 'INVALID_AGENT_PATH',
          }),
      })
    );

    await expect(setup().postMessage('s1', 'hello', '/tmp')).rejects.toThrow(
      'Choose a registered agent before starting this session'
    );
  });

  it('falls back to the status when the refusal carried no reason', async () => {
    // A proxy, a crash page, anything that answers without the shape. There is
    // nothing honest to show but the status, and inventing a sentence would be
    // worse than showing one.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('not JSON')),
      })
    );

    await expect(setup().postMessage('s1', 'hello', '/tmp')).rejects.toThrow('HTTP 502');
  });
});
