import https from 'node:https';
import { expect, it, vi } from 'vitest';
import { createFixtureServerCustody } from './fixture-server.js';
it('body and finished hook reuse exactly one real HTTPS server close', async () => {
  const server = https.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = vi.spyOn(server, 'close');
  const owner = createFixtureServerCustody(server);
  const original = owner.close();
  await original;
  expect(owner.close()).toBe(original);
  await owner.close();
  expect(close).toHaveBeenCalledTimes(1);
});
