/**
 * A confirm-first capability on the mount (ADR 261125-114705, decision 4), with
 * Security's four conditions (DOR-4978, 2026-11-25), each with its own test:
 * the hold is bound to the person's session and device, single-use and
 * short-lived, and no agent path can satisfy it. Driven through
 * `heartbeat.choose_triage_credits` (`PUT /api/heartbeats/triage-credits`)
 * behind the real chain, a real owner account and the real step-up routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { user } from '@dorkos/db';
import { STEP_UP_TTL_MS } from '@dorkos/shared/step-up';
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { heartbeatDomain } from '../../services/heartbeats/heartbeat-capabilities.js';
import { setTriageCreditsChoiceStore } from '../../services/heartbeats/triage/triage-credits-capability.js';
import { takeHeldStepUp } from '../../services/core/auth/step-up/step-up-holds.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const PATH = '/api/heartbeats/triage-credits';

let choice: boolean | null = null;
const record = vi.fn();
const owner = frontDoorStepUpHarness(() => [capabilityGroup(heartbeatDomain)]);

beforeEach(() => {
  choice = null;
  record.mockClear();
  setTriageCreditsChoiceStore({
    choice: () => choice,
    setChoice: (value) => {
      choice = value;
    },
    record,
  });
});
afterEach(() => {
  vi.useRealTimers();
  setTriageCreditsChoiceStore(undefined);
});

/** Ask for Use credits from one sign-in, and return the held action's id. */
async function hold(via: 'direct' | 'own-tunnel' | 'managed' = 'direct'): Promise<string> {
  const held = await owner.call('put', PATH, via).send({ useCredits: true });
  expect(held.status).toBe(428);
  expect(held.headers['cache-control']).toBe('no-store');
  return held.body.heldActionId as string;
}

/** Nothing was chosen and nothing recorded. */
function nothingChanged(): void {
  expect(choice).toBeNull();
  expect(record).not.toHaveBeenCalled();
}

describe('Use credits waits for the owner to confirm it’s them', () => {
  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds from %s, then runs once confirmed',
    async (via) => {
      const id = await hold(via);
      nothingChanged();
      expect((await owner.confirm(id, via)).body).toMatchObject({
        ok: true,
        status: 200,
        result: { useCredits: true },
      });
      expect(choice).toBe(true);
      expect(record).toHaveBeenCalledExactlyOnceWith(null, true);
    }
  );

  it('runs Not now at once, recording only a change', async () => {
    choice = true;
    const res = await owner.call('put', PATH, 'own-tunnel').send({ useCredits: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ useCredits: false });
    expect(choice).toBe(false);
    await owner.call('put', PATH).send({ useCredits: false });
    expect(record).toHaveBeenCalledExactlyOnceWith(true, false);
  });

  it('takes Not now from a Wi-Fi sign-in, and refuses Use credits there before holding', async () => {
    const yes = await owner.call('put', PATH, 'wifi').send({ useCredits: true });
    expect(yes.status).toBe(403);
    expect(yes.body.code).toBe('operator_only');
    expect(yes.body.heldActionId).toBeUndefined();
    nothingChanged();
    const no = await owner.call('put', PATH, 'wifi').send({ useCredits: false });
    expect(no.status).toBe(200);
    expect(choice).toBe(false);
  });

  it('spends nothing when the confirming request fails the front-door bar', async () => {
    const action = takeHeldStepUp(await hold('own-tunnel'));
    const result = await action!.commit({
      headers: {},
      peerAddress: '192.0.2.10',
      forwardedAddress: '192.0.2.10',
      connectionEncrypted: false,
      ingress: 'wifi',
      // The real owner, so only the place the confirmation came from fails.
      user: {
        userId: owner.db().select().from(user).get()!.id,
        credential: 'cookie',
        sessionId: 'made-up-session',
      },
      agentIdentity: undefined,
      method: 'PUT',
    });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'operator_only' });
    nothingChanged();
  });
});

describe('Security’s four conditions (DOR-4978)', () => {
  it('1. is bound to the session and device that asked: another sign-in, here or elsewhere, can’t confirm it', async () => {
    const id = await hold('direct');
    // Another sign-in on this computer, and another device over Remote Access.
    expect((await owner.confirm(id, 'direct', true)).body.code).toBe('held_by_another_browser');
    expect((await owner.confirm(id, 'own-tunnel')).body.code).toBe('held_by_another_browser');
    nothingChanged();
    expect((await owner.confirm(id, 'direct')).body).toMatchObject({ ok: true, status: 200 });
    expect(choice).toBe(true);
  });

  it('2. is single-use: a second confirm finds nothing, and the choice is recorded once', async () => {
    const id = await hold();
    expect((await owner.confirm(id)).body).toMatchObject({ ok: true, status: 200 });
    const again = await owner.confirm(id);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('expired');
    expect(record).toHaveBeenCalledOnce();
  });

  it('3. is short-lived: two minutes on, the right password runs nothing', async () => {
    const id = await hold();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + STEP_UP_TTL_MS);
    const late = await owner.confirm(id);
    expect(late.status).toBe(404);
    expect(late.body.code).toBe('expired');
    nothingChanged();
  });

  it.each([
    ['an agent', { 'X-DorkOS-Agent': 'made-up-agent-token' }],
    ['a program with a key', { Authorization: 'Bearer dork_made_up' }],
  ])('4. no agent path: %s is refused person_only, and nothing is held', async (_who, headers) => {
    const res = await owner.call('put', PATH).set(headers).send({ useCredits: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(res.body.heldActionId).toBeUndefined();
    nothingChanged();
  });

  it('4. no agent path: an agent can’t confirm the person’s hold', async () => {
    const id = await hold();
    const res = await owner
      .call('post', `/api/step-up/${id}/password`)
      .set('X-DorkOS-Agent', 'made-up-agent-token')
      .send({ password: 'made-up-correct-horse-battery' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    nothingChanged();
  });
});
