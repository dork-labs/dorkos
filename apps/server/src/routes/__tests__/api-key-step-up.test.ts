import { describe, expect, it } from 'vitest';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('API key confirmation', () => {
  const owner = frontDoorStepUpHarness(() => []);

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds key creation from %s',
    async (via) => {
      const held = await owner
        .call('post', '/api/auth/api-key/create', via)
        .send({ name: 'Northwind' });
      expect(held.status).toBe(428);
      const before = await owner.call('get', '/api/auth/api-key/list', via);
      const list = Array.isArray(before.body) ? before.body : before.body.apiKeys;
      expect(list.every((key: { name: string }) => key.name !== 'Northwind')).toBe(true);
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      const confirmed = await owner.confirm(held.body.heldActionId, via);
      expect(confirmed.body).toMatchObject({
        ok: true,
        status: 200,
        result: { name: 'Northwind' },
      });
      const key = confirmed.body.result;
      expect(typeof key.key).toBe('string');
      const updated = await owner
        .call('post', '/api/auth/api-key/update', via)
        .send({ keyId: key.id, name: 'Northwind renamed' });
      expect(updated.status).toBe(428);
      expect((await owner.confirm(updated.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 200,
      });
      // A key is refused before a hold, even on an encrypted route.
      const program = await owner
        .call('post', '/api/auth/api-key/create', via)
        .set('Cookie', '')
        .set('x-api-key', key.key)
        .send({ name: 'Other key' });
      expect(program.status).toBe(403);
      expect(program.body).toMatchObject({ code: 'not-a-person' });
      expect(program.body.heldActionId).toBeUndefined();
      expect(
        (await owner.call('post', '/api/auth/api-key/delete', via).send({ keyId: key.id })).status
      ).toBe(200);
    }
  );

  it.each(['create', 'update'])('keeps Wi-Fi key %s refused', async (action) => {
    expect(
      (await owner.call('post', `/api/auth/api-key/${action}`, 'wifi').send({ name: 'Northwind' }))
        .status
    ).toBe(403);
  });
});
