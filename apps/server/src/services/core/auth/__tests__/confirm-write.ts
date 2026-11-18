/** Complete an explicitly requested auth fixture write using its original browser. */
import type { Response as TestResponse } from '@dorkos/test-utils/supertest';
import request from '@dorkos/test-utils/supertest';

export async function confirmAuthFixture(
  ask: PromiseLike<TestResponse>,
  server: Parameters<typeof request>[0],
  headers: Record<string, string>,
  password: string
): Promise<TestResponse> {
  const held = await ask;
  if (held.status !== 428) return held;
  const confirmed = await request(server)
    .post(`/api/step-up/${held.body.heldActionId}/password`)
    .set(headers)
    .send({ password });
  if (confirmed.status !== 200) return confirmed;
  return Object.assign(held, {
    status: confirmed.body.status,
    statusCode: confirmed.body.status,
    body: confirmed.body.result,
  });
}
