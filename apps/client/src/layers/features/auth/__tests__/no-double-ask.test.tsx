/**
 * @vitest-environment jsdom
 *
 * No double ask (DOR-3330, PM condition 1): whoever just created the owner
 * account, or signed in, in this browser has already proved it is them, so
 * the first chat goes straight in with no password prompt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PERSON_PROOF_HEADER, PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import { finishPersonStepUp, personAwareFetch, subscribePersonStepUp } from '@/layers/shared/lib';
import { AuthClientProvider } from '../model/auth-client-context';
import { useSignIn, useSignUp } from '../model/use-auth-session';
import { createFakeAuthClient } from './fake-auth-client';

const ORIGIN = window.location.origin;

/** A server that keeps the proof it handed out, and asks for it on a chat. */
function fakeServer() {
  let issued: string | null = null;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), ORIGIN);
    if (url.pathname.endsWith('/person-session')) {
      issued = 'proof-1';
      return new Response(JSON.stringify({ ok: true, proof: issued }), { status: 200 });
    }
    const proof = new Headers(init?.headers).get(PERSON_PROOF_HEADER);
    return proof && proof === issued
      ? new Response('{}', { status: 202 })
      : new Response(JSON.stringify({ code: PERSON_SESSION_REQUIRED_CODE }), { status: 401 });
  });
}

/** The hooks' providers, over a fake auth client. */
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AuthClientProvider client={createFakeAuthClient()}>{children}</AuthClientProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  finishPersonStepUp(false);
});

describe('no double ask', () => {
  it.each([
    ['creating the owner account', () => useSignUp(), ['a@b.test', 'pw-123456', 'Owner']],
    ['signing in', () => useSignIn(), ['a@b.test', 'pw-123456']],
  ] as const)('sends the first chat straight in after %s', async (_label, hook, args) => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server);
    const asked = vi.fn();
    const stop = subscribePersonStepUp(asked);
    const { result } = renderHook(hook, { wrapper });

    await act(async () => {
      await (result.current.run as (...a: readonly string[]) => Promise<unknown>)(...args);
    });
    const chat = await personAwareFetch(server, ORIGIN)('/api/sessions/s1/messages', {
      method: 'POST',
      body: '{"content":"hi"}',
    });
    stop();

    expect(chat.status).toBe(202);
    expect(asked).not.toHaveBeenCalled();
  });
});
