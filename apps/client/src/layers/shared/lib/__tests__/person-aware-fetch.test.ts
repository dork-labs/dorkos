/**
 * The app window's `fetch` and the owner's step-up at this computer
 * (DOR-3330): the person proof goes only to this page's own API, and a change
 * refused for want of the person's session asks once, then goes again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSON_PROOF_HEADER,
  PERSON_PROOF_STORAGE_KEY,
  PERSON_SESSION_REQUIRED_CODE,
} from '@dorkos/shared/person-session';
import { personAwareFetch } from '../person-aware-fetch';
import {
  finishPersonStepUp,
  getPersonStepUpOpen,
  subscribePersonStepUp,
} from '../person-step-up-signal';

const ORIGIN = 'http://localhost:4242';

/** The refusal a change answers with before the step-up. */
function needsStepUp(): Response {
  return new Response(
    JSON.stringify({ error: 'Enter your password.', code: PERSON_SESSION_REQUIRED_CODE }),
    { status: 401 }
  );
}

/** Answer the step-up the moment it opens, keeping a proof as a real one would. */
function answerWhenAsked(confirmed: boolean, proof = 'proof-1'): () => void {
  return subscribePersonStepUp(() => {
    if (!getPersonStepUpOpen()) return;
    if (confirmed) localStorage.setItem(PERSON_PROOF_STORAGE_KEY, proof);
    queueMicrotask(() => finishPersonStepUp(confirmed));
  });
}

/** The header a call sent. */
function sent(base: ReturnType<typeof vi.fn>, call: number, name: string): string | null {
  return new Headers((base.mock.calls[call]![1] as RequestInit).headers).get(name);
}

afterEach(() => {
  finishPersonStepUp(false);
  localStorage.clear();
});

describe('personAwareFetch', () => {
  it('sends the proof to this page’s own API', async () => {
    localStorage.setItem(PERSON_PROOF_STORAGE_KEY, 'proof-1');
    const base = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')
    );
    await personAwareFetch(base, ORIGIN)('/api/config', { method: 'PATCH', body: '{}' });
    expect(sent(base, 0, PERSON_PROOF_HEADER)).toBe('proof-1');
  });

  it('never sends the proof anywhere else', async () => {
    localStorage.setItem(PERSON_PROOF_STORAGE_KEY, 'proof-1');
    const base = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')
    );
    const wrapped = personAwareFetch(base, ORIGIN);
    await wrapped('http://localhost:5173/api/x', { method: 'POST' });
    await wrapped('https://example.com/api/x');
    await wrapped('/assets/app.js');
    for (const call of base.mock.calls) {
      expect(
        new Headers((call[1] as RequestInit | undefined)?.headers).has(PERSON_PROOF_HEADER)
      ).toBe(false);
    }
  });

  it('asks once, then sends the same change again with the new proof', async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(needsStepUp())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const stop = answerWhenAsked(true);

    const res = await personAwareFetch(base, ORIGIN)('/api/approvals/a/grant', {
      method: 'POST',
      body: '{"answer":"once"}',
    });
    stop();

    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect((base.mock.calls[1]![1] as RequestInit).body).toBe('{"answer":"once"}');
    expect(sent(base, 1, PERSON_PROOF_HEADER)).toBe('proof-1');
  });

  it('hands back the refusal when the person cancels', async () => {
    const base = vi.fn().mockResolvedValueOnce(needsStepUp());
    const stop = answerWhenAsked(false);

    const res = await personAwareFetch(base, ORIGIN)('/api/approvals/a/grant', {
      method: 'POST',
      body: '{}',
    });
    stop();

    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('asks once for two changes refused at the same time', async () => {
    let opened = 0;
    const stop = subscribePersonStepUp(() => {
      if (!getPersonStepUpOpen()) return;
      opened += 1;
      queueMicrotask(() => finishPersonStepUp(true));
    });
    let calls = 0;
    const base = vi.fn(async () => {
      calls += 1;
      return calls <= 2 ? needsStepUp() : new Response('{}');
    });
    const wrapped = personAwareFetch(base, ORIGIN);

    await Promise.all([
      wrapped('/api/a', { method: 'POST', body: '{}' }),
      wrapped('/api/b', { method: 'POST', body: '{}' }),
    ]);
    stop();

    expect(opened).toBe(1);
    expect(calls).toBe(4);
  });

  it('never asks for any other 401', async () => {
    const opened = vi.fn();
    const stop = subscribePersonStepUp(opened);
    const base = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'No.', code: 'SOMETHING_ELSE' }), { status: 401 })
    );

    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'POST', body: '{}' });
    stop();

    expect(res.status).toBe(401);
    expect(opened).not.toHaveBeenCalled();
  });
});
