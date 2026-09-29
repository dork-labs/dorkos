import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAccountMethods } from '../account-methods';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stub `fetch` to answer every request with `body` at `status`. */
function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return {
    url,
    method: init?.method ?? 'GET',
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

describe('createAccountMethods', () => {
  const methods = createAccountMethods('/api');

  it('reads one runtime’s account usage', async () => {
    const fetchMock = answer(200, { accounts: [] });
    await expect(methods.getAccountUsage('codex')).resolves.toEqual({ accounts: [] });
    expect(call(fetchMock)).toEqual({
      url: '/api/runtimes/codex/accounts/usage',
      method: 'GET',
      body: undefined,
    });
  });

  it('reads the continue options', async () => {
    const options = { plan: { mode: 'ask' }, ranking: { accounts: [], recommendedId: null } };
    const fetchMock = answer(200, options);
    await expect(methods.getContinueOptions('s 1')).resolves.toEqual(options);
    expect(call(fetchMock).url).toBe('/api/sessions/s%201/continue-options');
  });

  it('continues on another account with the chosen account, model and runtime', async () => {
    const fetchMock = answer(202, { sessionId: 'new-session' });
    await expect(
      methods.continueSession('s1', { account: 'acct-2', model: 'sonnet', runtime: 'codex' })
    ).resolves.toEqual({ sessionId: 'new-session' });
    expect(call(fetchMock)).toEqual({
      url: '/api/sessions/s1/continue',
      method: 'POST',
      body: { account: 'acct-2', model: 'sonnet', runtime: 'codex' },
    });
  });

  it('waits for the reset', async () => {
    const fetchMock = answer(204, undefined);
    await expect(methods.waitForReset('s1', { autoResume: true })).resolves.toBeUndefined();
    expect(call(fetchMock)).toEqual({
      url: '/api/sessions/s1/wait',
      method: 'POST',
      body: { autoResume: true },
    });
  });

  it('cancels an automatic carry-over', async () => {
    const fetchMock = answer(200, { ok: true });
    await expect(methods.cancelAutoContinue('s1')).resolves.toBeUndefined();
    expect(call(fetchMock)).toMatchObject({
      url: '/api/sessions/s1/continue/cancel',
      method: 'POST',
    });
  });

  it('reads the limit history', async () => {
    const fetchMock = answer(200, { entries: [] });
    await expect(methods.getLimitHistory('s1')).resolves.toEqual({ entries: [] });
    expect(call(fetchMock).url).toBe('/api/sessions/s1/limit-history');
  });

  it('reads the Claude account folders found on this computer', async () => {
    const fetchMock = answer(200, { folders: [] });
    await expect(methods.getFoundClaudeFolders()).resolves.toEqual({ folders: [] });
    expect(call(fetchMock)).toEqual({
      url: '/api/runtimes/claude-code/accounts/found',
      method: 'GET',
      body: undefined,
    });
  });

  it('dismisses one found folder by its path', async () => {
    const fetchMock = answer(204, undefined);
    await expect(methods.dismissFoundClaudeFolder('/Users/me/.claude2')).resolves.toBeUndefined();
    expect(call(fetchMock)).toEqual({
      url: '/api/runtimes/claude-code/accounts/found/dismiss',
      method: 'POST',
      body: { path: '/Users/me/.claude2' },
    });
  });

  it('rejects a refusal with the server’s message and the status', async () => {
    const message = 'This conversation did not start here, so it can only wait for the reset.';
    answer(409, { error: message, code: 'CONTINUE_REFUSED' });
    await expect(methods.continueSession('s1', { account: 'acct-2' })).rejects.toMatchObject({
      message,
      status: 409,
    });
  });
});
