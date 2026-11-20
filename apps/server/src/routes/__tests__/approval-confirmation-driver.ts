/** Test password ceremony for existing approval behavior checks; never bypasses the hold. */
import request from '@dorkos/test-utils/supertest';
import { readOwnerAccount } from '../../services/core/auth/index.js';
import { createStepUpRoutes } from '../step-up.js';

/**
 * The real one-use hold and commit routes, seeing the same owner the hold
 * side sees (so a computer with no owner still has no password to ask for),
 * with a made-up password.
 */
export function approvalConfirmationRoutes(origin: string) {
  return createStepUpRoutes({
    ownerId: () => readOwnerAccount()?.id ?? null,
    checkPassword: async (password) => (password === 'made-up approval password' ? 'ok' : 'wrong'),
    minPasswordLength: async () => 8,
    setOwnerPassword: async () => undefined,
    trustedOrigins: () => [origin],
  });
}

/** Finish a hold, returning the original route's result for its existing contract checks. */
export async function finishApprovalForTest<
  T extends { status: number; body: Record<string, unknown> },
>(server: Parameters<typeof request>[0], response: T, origin: string): Promise<T> {
  if (response.status !== 428) return response;
  if (typeof response.body.heldActionId !== 'string') throw new Error('Missing held action');
  const confirmed = await request(server)
    .post(`/api/step-up/${response.body.heldActionId}/password`)
    .set('Origin', origin)
    .send({ password: 'made-up approval password' });
  if (confirmed.status !== 200 || confirmed.body.ok !== true)
    throw new Error(`Approval confirmation failed: ${JSON.stringify(confirmed.body)}`);
  return { ...response, status: confirmed.body.status, body: confirmed.body.result };
}
