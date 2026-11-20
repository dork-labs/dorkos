/** Explicit fixture confirmation through the real held-action/password routes. */
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Test, Response as TestResponse } from '@dorkos/test-utils/supertest';
import request from '@dorkos/test-utils/supertest';
import { env } from '../../env.js';
import { createStepUpRoutes, type StepUpRouteDeps } from '../step-up.js';

export const FIXTURE_BROWSER_HEADER = 'x-test-owner-browser';
export const FIXTURE_SESSION = 'fixture-owner-browser';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** The same fake owner password these route-isolation suites already use. */
export function stepUpFixtureRoutes(deps: Pick<StepUpRouteDeps, 'ownerId' | 'checkPassword'>) {
  return {
    path: '/api/step-up',
    routes: createStepUpRoutes({
      ...deps,
      minPasswordLength: async () => 1,
      setOwnerPassword: async () => undefined,
      trustedOrigins: () => [ORIGIN],
    }),
  };
}

/** Opt a setup request into confirmation, retaining its original response shape. */
export async function confirmFixtureRequest(
  ask: Test,
  server: Server,
  password: string
): Promise<TestResponse> {
  const browser = randomUUID();
  const held = await ask.set(FIXTURE_BROWSER_HEADER, browser);
  if (held.status !== 428) return held;
  const confirmed = await request(server)
    .post(`/api/step-up/${held.body.heldActionId}/password`)
    .set(FIXTURE_BROWSER_HEADER, browser)
    .set('Origin', ORIGIN)
    .send({ password });
  if (confirmed.status !== 200) return confirmed;
  return Object.assign(held, {
    status: confirmed.body.status,
    statusCode: confirmed.body.status,
    body: confirmed.body.result,
  });
}
