import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { session } from '@dorkos/db';
import { eq } from 'drizzle-orm';
import { env } from '../../env.js';
import {
  setHubServingState,
  resetHubServingStateForTests,
} from '../../services/core/hub/hub-serving.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('hub auth keeps its existing owner ceremony', () => {
  const proof = { header: 'x-test-hub-proof', secret: 'p'.repeat(40) };
  const owner = frontDoorStepUpHarness(() => [], {
    headers: () => ({ [proof.header]: proof.secret }),
  });
  beforeEach(async () => {
    // A cookie made by the server's OAuth callback is bound to the hub route.
    // Stamp the real test session the same way, without dialing an OAuth issuer.
    env.DORKOS_SERVER_ROLE = 'computer';
    await owner.renew('direct');
    await owner.renew('direct', true);
    const found = await owner
      .auth()!
      .api.getSession({ headers: new Headers({ cookie: owner.currentCookie() }) });
    owner.db().update(session).set({ route: 'hub' }).where(eq(session.id, found!.session.id)).run();
    setHubServingState({
      state: 'serving',
      assignment: {
        state: 'assigned',
        assignmentId: 'northwind-test-assignment',
        assignedAt: '2026-11-16T10:00:00Z',
        ownerAccountId: 'northwind-test-owner',
        issuer: 'https://accounts.example.test',
        address: `http://localhost:${env.DORKOS_PORT}`,
        frontDoorProof: proof,
      },
    });
    env.DORKOS_SERVER_ROLE = 'hub';
  });
  afterEach(() => {
    env.DORKOS_SERVER_ROLE = 'computer';
    resetHubServingStateForTests();
  });

  it('creates and updates an owner key without a local-password hold', async () => {
    const made = await owner
      .call('post', '/api/auth/api-key/create')
      .send({ name: 'Northwind hub' });
    expect(made.status).toBe(200);
    expect(made.body.heldActionId).toBeUndefined();
    expect(
      (
        await owner
          .call('post', '/api/auth/api-key/update')
          .send({ keyId: made.body.id, name: 'Northwind hub renamed' })
      ).status
    ).toBe(200);
  });
  it.each(['revoke-other-sessions', 'revoke-sessions'])(
    'keeps %s immediate for the hub owner',
    async (action) => {
      expect((await owner.call('post', `/api/auth/${action}`).send({})).status).toBe(200);
    }
  );
  it('signs out another single session without a local-password hold', async () => {
    const other = owner
      .db()
      .select()
      .from(session)
      .all()
      .find((row) => row.route !== 'hub');
    expect(other).toBeDefined();
    const result = await owner
      .call('post', '/api/auth/revoke-session')
      .send({ token: other!.token });
    expect(result.status).toBe(200);
    expect(result.body.heldActionId).toBeUndefined();
    expect(
      owner.db().select().from(session).where(eq(session.id, other!.id)).get()
    ).toBeUndefined();
  });
  it('still refuses a program caller', async () => {
    const response = await owner
      .call('post', '/api/auth/api-key/create')
      .set('Cookie', '')
      .set('x-api-key', 'made-up-program-key')
      .send({ name: 'Other' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('not-a-person');
  });
});
