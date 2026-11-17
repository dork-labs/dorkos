/** Persistent checks spending needs confirmation; stopping it stays free. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeartbeatTriageRoutes } from '../heartbeat-triage.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';
import { takeHeldStepUp } from '../../services/core/auth/step-up/step-up-holds.js';
import { user } from '@dorkos/db';

describe('checks credits confirmation', () => {
  let choice: boolean | null = null;
  const record = vi.fn();
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/heartbeats/triage-credits',
      routes: createHeartbeatTriageRoutes({
        choice: () => choice,
        setChoice: (value) => {
          choice = value;
        },
        record,
      }),
    },
  ]);
  beforeEach(() => {
    choice = null;
    record.mockClear();
  });
  it.each(['direct', 'own-tunnel', 'managed'] as const)('holds credits-on from %s', async (via) => {
    const held = await owner
      .call('put', '/api/heartbeats/triage-credits', via)
      .send({ useCredits: true });
    expect(held.status).toBe(428);
    expect(choice).toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
      'not-your-action'
    );
    expect(choice).toBeNull();
    expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
      ok: true,
      status: 200,
      result: { useCredits: true },
    });
    expect(choice).toBe(true);
    expect(record).toHaveBeenCalledExactlyOnceWith(null, true);
  });
  // This write has no caller check of its own, so only the hold's recheck stands here.
  it('spends nothing when the confirming request fails the front-door bar', async () => {
    const held = await owner
      .call('put', '/api/heartbeats/triage-credits', 'own-tunnel')
      .send({ useCredits: true });
    expect(held.status).toBe(428);
    const action = takeHeldStepUp(held.body.heldActionId);
    expect(action).toBeDefined();
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
    expect(result.body).toMatchObject({ code: 'NEEDS_PERSON_AT_THIS_COMPUTER' });
    expect(choice).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
  it('refuses Wi-Fi before holding or spending', async () => {
    const result = await owner
      .call('put', '/api/heartbeats/triage-credits', 'wifi')
      .send({ useCredits: true });
    expect(result.status).toBe(403);
    expect(result.body.heldActionId).toBeUndefined();
    expect(choice).toBeNull();
  });
  it('stops spending without a hold', async () => {
    choice = true;
    const result = await owner
      .call('put', '/api/heartbeats/triage-credits', 'own-tunnel')
      .send({ useCredits: false });
    expect(result.status).toBe(200);
    expect(choice).toBe(false);
  });
});
