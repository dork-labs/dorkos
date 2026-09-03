// @vitest-environment jsdom
/**
 * `delegateRuntimeLogin` — the account pin's correctness lives in the REQUEST
 * BODY, which nothing above this seam can see (DOR-1651).
 *
 * The card resolves a session's bound account and hands it down, but if the
 * body never carries it the server signs into whichever account it was already
 * pointed at and answers `{ ok: true }`. That reads as a clean success at every
 * layer above — the card says "Signed in", and the session keeps failing. The
 * mirror image is just as quiet: sending the key on a runtime with no account
 * concept is a hard refusal, so an unpinned login must send NO key rather than
 * an explicit `undefined`. Both are pinned here against a real `Response`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSystemMethods } from '../system-methods';

const BASE = 'http://localhost:4242/api';

/** Answer the next fetch with a completed login. */
function serveOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

/** The `RequestInit` the last `fetch` call was made with. */
function lastInit(): RequestInit {
  return vi.mocked(globalThis.fetch).mock.calls.at(-1)![1] as RequestInit;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('delegateRuntimeLogin', () => {
  it('puts the pinned account on the wire, so the right account is signed in', async () => {
    serveOk();

    await createSystemMethods(BASE).delegateRuntimeLogin('claude-code', {
      accountRoot: '/Users/dev/.claude2',
    });

    expect(vi.mocked(globalThis.fetch).mock.calls.at(-1)![0]).toBe(
      `${BASE}/runtimes/claude-code/login`
    );
    expect(JSON.parse(lastInit().body as string)).toEqual({
      accountRoot: '/Users/dev/.claude2',
    });
  });

  it('sends no body at all when no account was pinned', async () => {
    // An `{ accountRoot: undefined }` body would serialize to `{}` here, which
    // is harmless — but a caller that passed the key explicitly on a runtime
    // that rejects the pin would not be. Absent must mean absent.
    serveOk();

    await createSystemMethods(BASE).delegateRuntimeLogin('codex');

    expect(lastInit().body).toBeUndefined();
  });

  it('sends no body when options are supplied without an account', async () => {
    serveOk();

    await createSystemMethods(BASE).delegateRuntimeLogin('codex', {});

    expect(lastInit().body).toBeUndefined();
  });
});
