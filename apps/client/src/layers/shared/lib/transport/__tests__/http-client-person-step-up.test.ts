/**
 * A person-only action from a browser with no session at this computer
 * (DOR-3330): `fetchJSON` asks for the owner's one password step-up, waits,
 * and sends the request again once, only when the person confirmed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';
import { fetchJSON } from '../http-client';
import {
  finishPersonStepUp,
  getPersonStepUpOpen,
  subscribePersonStepUp,
} from '../../person-step-up-signal';

const BASE_URL = 'http://localhost:4242';

/** The refusal a person-only action answers with before the step-up. */
function needsStepUp(): Response {
  return new Response(
    JSON.stringify({ error: 'Enter your password.', code: PERSON_SESSION_REQUIRED_CODE }),
    { status: 401 }
  );
}

/** Answer the step-up the moment it opens. */
function answerWhenAsked(confirmed: boolean): () => void {
  return subscribePersonStepUp(() => {
    if (getPersonStepUpOpen()) queueMicrotask(() => finishPersonStepUp(confirmed));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  finishPersonStepUp(false);
});

describe('fetchJSON and the person step-up', () => {
  it('asks once, then sends the same request again', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(needsStepUp())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const stop = answerWhenAsked(true);

    const result = await fetchJSON<{ ok: boolean }>(BASE_URL, '/api/approvals/a/grant', {
      method: 'POST',
      body: '{"answer":"once"}',
    });
    stop();

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1]?.body).toBe('{"answer":"once"}');
  });

  it('leaves the action refused when the person cancels', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(needsStepUp());
    const stop = answerWhenAsked(false);

    await expect(
      fetchJSON(BASE_URL, '/api/approvals/a/grant', { method: 'POST', body: '{}' })
    ).rejects.toMatchObject({ status: 401, code: PERSON_SESSION_REQUIRED_CODE });
    stop();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('asks once for two actions refused at the same time', async () => {
    let opened = 0;
    const stop = subscribePersonStepUp(() => {
      if (getPersonStepUpOpen()) {
        opened += 1;
        queueMicrotask(() => finishPersonStepUp(true));
      }
    });
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      return calls <= 2 ? needsStepUp() : new Response('{}', { status: 200 });
    });

    await Promise.all([
      fetchJSON(BASE_URL, '/api/a', { method: 'POST', body: '{}' }),
      fetchJSON(BASE_URL, '/api/b', { method: 'POST', body: '{}' }),
    ]);
    stop();

    expect(opened).toBe(1);
    expect(calls).toBe(4);
  });

  it('never asks for any other 401', async () => {
    const opened = vi.fn();
    const stop = subscribePersonStepUp(opened);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'No.', code: 'SOMETHING_ELSE' }), { status: 401 })
    );

    await expect(fetchJSON(BASE_URL, '/api/x', { method: 'POST', body: '{}' })).rejects.toThrow(
      'No.'
    );
    stop();
    expect(opened).not.toHaveBeenCalled();
  });
});
