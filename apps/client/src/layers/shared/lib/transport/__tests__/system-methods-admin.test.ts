// @vitest-environment jsdom
/**
 * "Restart Server" and "Reset All Data" over HTTP — specifically, what a person
 * is shown when the server says no (DOR-542).
 *
 * These two methods used to do `throw new Error(await res.text())`, and Settings
 * → Advanced hands that straight to `toast.error`. So the desktop app's 409 —
 * the one explaining that the app starts and stops the server for you — arrived
 * as the entire raw JSON body, braces and error code and all, with the sentence
 * buried inside it. Nothing above this seam can tell the difference between a
 * good message and a bad one, which is why the shape of the refusal is pinned
 * here against a real `Response`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSystemMethods } from '../system-methods';

const BASE = 'http://localhost:4242/api';

/** The refusal a desktop-managed server really sends. */
const DESKTOP_REFUSAL =
  'The DorkOS app starts and stops the server for you, so restarting it from here would ' +
  'leave you with no server running. Quit DorkOS and open it again instead.';

/** Answer the next fetch with `status` and this JSON body. */
function serve(status: number, body: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The message a rejected call carries.
 *
 * Compared for EQUALITY everywhere below, never containment: the old behaviour
 * threw the whole response body, which contains the right sentence and would
 * satisfy any substring check while still being the wrong thing to show a
 * person.
 */
async function refusalMessage(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

describe('restartServer', () => {
  it('throws the sentence the server wrote, not the body it came in', async () => {
    serve(409, { error: DESKTOP_REFUSAL, code: 'MANAGED_BY_DESKTOP' });

    await expect(refusalMessage(createSystemMethods(BASE).restartServer())).resolves.toBe(
      DESKTOP_REFUSAL
    );
  });

  it('carries the refusal code and status, so a caller can branch on them', async () => {
    serve(409, { error: DESKTOP_REFUSAL, code: 'MANAGED_BY_DESKTOP' });

    const err = (await createSystemMethods(BASE)
      .restartServer()
      .catch((e: unknown) => e)) as Error & { code?: string; status?: number };

    expect(err.code).toBe('MANAGED_BY_DESKTOP');
    expect(err.status).toBe(409);
  });

  it('posts to the admin route and hands back what it said', async () => {
    const fetchMock = serve(200, { message: 'Restart initiated.' });

    await expect(createSystemMethods(BASE).restartServer()).resolves.toEqual({
      message: 'Restart initiated.',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/admin/restart`);
  });
});

describe('resetAllData', () => {
  it('throws the sentence the server wrote, not the body it came in', async () => {
    serve(409, { error: 'Nothing has been deleted.', code: 'MANAGED_BY_DESKTOP' });

    await expect(refusalMessage(createSystemMethods(BASE).resetAllData('reset'))).resolves.toBe(
      'Nothing has been deleted.'
    );
  });

  it('sends the confirmation the server insists on', async () => {
    const fetchMock = serve(200, { message: 'Reset initiated. Server will restart.' });

    await createSystemMethods(BASE).resetAllData('reset');

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/admin/reset`);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      confirm: 'reset',
    });
  });
});
