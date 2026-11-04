/**
 * The app window's `fetch` and "Confirm it's you" for one action (DOR-3234): a
 * held action waits on the sheet, a confirmed one answers with the action's
 * own result, a cancelled one answers with the refusal, and an expired one is
 * asked for again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import { personAwareFetch } from '../person-aware-fetch';
import {
  finishActionStepUp,
  getActionStepUpShowing,
  subscribeActionStepUp,
  type ActionStepUpOutcome,
} from '../action-step-up-signal';
import {
  finishPersonStepUp,
  getPersonStepUpOpen,
  subscribePersonStepUp,
} from '../person-step-up-signal';

const ORIGIN = 'http://localhost:4242';

/** A guarded action held for a step-up. */
function held(id: string): Response {
  return new Response(
    JSON.stringify({
      error: 'Confirm it’s you to do this.',
      code: STEP_UP_REQUIRED_CODE,
      heldActionId: id,
      expiresAt: '2026-10-30T12:02:00.000Z',
    }),
    { status: 428 }
  );
}

/** Answer each sheet the moment it shows, in order, recording which ids were asked. */
function answerWith(...outcomes: ActionStepUpOutcome[]): { asked: string[]; stop: () => void } {
  const asked: string[] = [];
  const stop = subscribeActionStepUp(() => {
    const showing = getActionStepUpShowing();
    if (showing === null || asked.includes(showing)) return;
    asked.push(showing);
    const outcome = outcomes.shift() ?? { kind: 'not-confirmed' };
    queueMicrotask(() => finishActionStepUp(showing, outcome));
  });
  return { asked, stop };
}

let stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  for (let id = getActionStepUpShowing(); id !== null; id = getActionStepUpShowing()) {
    finishActionStepUp(id, { kind: 'not-confirmed' });
  }
});

describe('personAwareFetch and a held action', () => {
  it('answers with the action’s own result once the person confirms', async () => {
    const base = vi.fn(async () => held('held-1'));
    const answer = answerWith({ kind: 'confirmed', status: 201, result: { added: 'github' } });
    stops.push(answer.stop);
    const res = await personAwareFetch(base, ORIGIN)('/api/mcp-servers', {
      method: 'POST',
      body: '{"name":"github"}',
    });
    expect(answer.asked).toEqual(['held-1']);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ added: 'github' });
    // The action ran on the server when confirmed; it is never sent a second time.
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('answers with an empty body for an action that answered 204', async () => {
    const base = vi.fn(async () => held('held-1'));
    stops.push(answerWith({ kind: 'confirmed', status: 204, result: undefined }).stop);
    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers with the refusal when the person cancels, and never sends it again', async () => {
    const base = vi.fn(async () => held('held-1'));
    stops.push(answerWith({ kind: 'not-confirmed' }).stop);
    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'POST', body: '{}' });
    expect(res.status).toBe(428);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('asks for the action again after it expired, which holds it afresh', async () => {
    const base = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(held('held-1'))
      .mockResolvedValueOnce(held('held-2'));
    const answer = answerWith(
      { kind: 'ask-again' },
      { kind: 'confirmed', status: 200, result: { ok: true } }
    );
    stops.push(answer.stop);
    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'POST', body: '{}' });
    expect(answer.asked).toEqual(['held-1', 'held-2']);
    expect(base).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('a cancel still answers readably after the caller’s timeout killed the first response', async () => {
    const first = held('held-1');
    const base = vi.fn(async () => first);
    stops.push(answerWith({ kind: 'not-confirmed' }).stop);
    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'POST', body: '{}' });
    // What a fired signal leaves behind: the first response's own body can't be read.
    await first.body?.cancel();
    expect(res).not.toBe(first);
    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ code: STEP_UP_REQUIRED_CODE });
  });

  it('asks again on a fresh clock: the caller’s timeout fired while the sheet was open', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return signals.length === 1 ? held('held-1') : held('held-2');
    });
    const answer = answerWith(
      { kind: 'ask-again' },
      { kind: 'confirmed', status: 201, result: { ok: true } }
    );
    stops.push(answer.stop);
    const res = await personAwareFetch(base as typeof fetch, ORIGIN)('/api/x', {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.abort(),
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(res.status).toBe(201);
  });

  it('an expired relay confirm re-asks the same route with the same body, and is held afresh', async () => {
    const path = '/api/relay/adapters/made-up/confirm-references';
    const body = '{"fingerprint":"made-up"}';
    const sent: Array<{ url: string; method?: string; body: unknown; aborted?: boolean }> = [];
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method,
        body: init?.body,
        aborted: init?.signal?.aborted,
      });
      return sent.length === 1 ? held('held-1') : held('held-2');
    });
    const answer = answerWith(
      { kind: 'ask-again' },
      { kind: 'confirmed', status: 200, result: { ok: true } }
    );
    stops.push(answer.stop);
    const res = await personAwareFetch(base as typeof fetch, ORIGIN)(path, {
      method: 'POST',
      body,
      signal: AbortSignal.abort(),
    });
    // Two sheets, one per hold: a person confirms the new one, never the expired one.
    expect(answer.asked).toEqual(['held-1', 'held-2']);
    expect(sent).toEqual([
      { url: path, method: 'POST', body, aborted: true },
      { url: path, method: 'POST', body, aborted: false },
    ]);
    expect(res.status).toBe(200);
  });

  it('stops asking again after a few tries', async () => {
    let n = 0;
    const base = vi.fn(async () => held(`held-${++n}`));
    stops.push(
      answerWith(...Array.from({ length: 10 }, () => ({ kind: 'ask-again' as const }))).stop
    );
    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'POST', body: '{}' });
    expect(res.status).toBe(428);
    expect(base.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('a late answer for a closed sheet never ends the next one', async () => {
    const first = vi.fn(async () => held('held-1'));
    const second = vi.fn(async () => held('held-2'));
    const fetchFirst = personAwareFetch(first, ORIGIN)('/api/a', { method: 'POST', body: '{}' });
    const fetchSecond = personAwareFetch(second, ORIGIN)('/api/b', { method: 'POST', body: '{}' });
    await vi.waitFor(() => expect(getActionStepUpShowing()).toBe('held-1'));
    // held-1's sheet is cancelled; held-2's shows.
    finishActionStepUp('held-1', { kind: 'not-confirmed' });
    expect((await fetchFirst).status).toBe(428);
    await vi.waitFor(() => expect(getActionStepUpShowing()).toBe('held-2'));
    // held-1's password check answers late, as confirmed: it must not touch held-2.
    finishActionStepUp('held-1', { kind: 'confirmed', status: 201, result: { wrong: true } });
    expect(getActionStepUpShowing()).toBe('held-2');
    finishActionStepUp('held-2', { kind: 'confirmed', status: 200, result: { right: true } });
    const res = await fetchSecond;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ right: true });
  });

  it('leaves a 428 that names no held action alone', async () => {
    const base = vi.fn(async () => new Response('{"code":"other"}', { status: 428 }));
    const answer = answerWith();
    stops.push(answer.stop);
    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'POST', body: '{}' });
    expect(res.status).toBe(428);
    expect(answer.asked).toEqual([]);
  });

  it('signs in again, then asks afresh: the old hold never carries to the new session', async () => {
    const base = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(held('held-old'))
      .mockResolvedValueOnce(held('held-new'));
    const answer = answerWith(
      { kind: 'sign-in-again' },
      { kind: 'confirmed', status: 200, result: { saved: true } }
    );
    stops.push(answer.stop);
    let signIns = 0;
    stops.push(
      subscribePersonStepUp(() => {
        if (!getPersonStepUpOpen()) return;
        signIns++;
        queueMicrotask(() => finishPersonStepUp(true));
      })
    );
    const res = await personAwareFetch(base, ORIGIN)('/api/relay/adapters/wh/config', {
      method: 'PATCH',
      body: '{}',
    });
    expect(signIns).toBe(1);
    // The call went again after sign-in, and the new sheet is for a new hold.
    expect(base).toHaveBeenCalledTimes(2);
    expect(answer.asked).toEqual(['held-old', 'held-new']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });
  });

  it('a sign-in cancelled after "Sign in again" sends nothing more', async () => {
    const base = vi.fn(async () => held('held-old'));
    const answer = answerWith({ kind: 'sign-in-again' });
    stops.push(answer.stop);
    stops.push(
      subscribePersonStepUp(() => {
        if (getPersonStepUpOpen()) queueMicrotask(() => finishPersonStepUp(false));
      })
    );
    const res = await personAwareFetch(base, ORIGIN)('/api/x', { method: 'POST', body: '{}' });
    expect(res.status).toBe(428);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('never shows the sheet for another origin', async () => {
    const base = vi.fn(async () => held('held-1'));
    const answer = answerWith();
    stops.push(answer.stop);
    const res = await personAwareFetch(base, ORIGIN)('https://example.com/api/x', {
      method: 'POST',
    });
    expect(res.status).toBe(428);
    expect(answer.asked).toEqual([]);
  });
});
