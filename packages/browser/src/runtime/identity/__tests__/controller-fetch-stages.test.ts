import { expect, it, vi } from 'vitest';
import { createControllerFetchStages } from '../controller-fetch-stages.js';
it('retains exact original command/session ACK facts without exposing target or request data', () => {
  const write = vi.fn();
  const stages = createControllerFetchStages(write);
  const command = {
    id: 71,
    sessionId: 'private-session',
    method: 'Fetch.enable',
    params: { handleAuthRequests: true },
  };
  const entered = stages.entering(command);
  stages.entered(entered);
  stages.observe({ id: 71, sessionId: 'foreign', result: {} }, 'unowned');
  expect(write).toHaveBeenCalledTimes(1);
  stages.observe({ id: 71, sessionId: 'private-session', result: {} }, 'page');
  stages.observe(
    {
      method: 'Fetch.requestPaused',
      params: { requestId: 'private-request', request: { url: 'https://private.example/secret' } },
    },
    'service_worker'
  );
  expect(write.mock.calls.flat().join('')).toContain('fetch-enable-auth-ack-observed');
  expect(write.mock.calls.flat().join('')).toContain('request-paused-service_worker');
  expect(write.mock.calls.flat().join('')).not.toMatch(/private|foreign|https/);
});
it.each([false, undefined])(
  'isolates exact falsy sink failure %s and records enable/disable rejection facts',
  (cause) => {
    const rows: string[] = [];
    const stages = createControllerFetchStages((value) => {
      rows.push(value);
      throw cause;
    });
    for (const [id, method] of [
      [1, 'Fetch.enable'],
      [2, 'Fetch.disable'],
    ] as const) {
      const command = { id, method, sessionId: 'original', params: { handleAuthRequests: false } };
      expect(() => {
        const entered = stages.entering(command);
        stages.entered(entered);
        stages.observe({ id, sessionId: 'original', error: cause }, 'page');
      }).not.toThrow();
    }
    expect(rows.join('')).toContain('fetch-enable-other-ack-refused');
    expect(rows.join('')).toContain('fetch-disable-ack-refused');
  }
);
it('clears the bounded observational ACK bank on the original terminal without fabricating a late ACK', () => {
  const write = vi.fn();
  const stages = createControllerFetchStages(write);
  stages.entering({
    id: 1,
    method: 'Fetch.enable',
    sessionId: 'original',
    params: { handleAuthRequests: true },
  });
  stages.close();
  stages.observe({ id: 1, sessionId: 'original', result: {} }, 'page');
  expect(write).not.toHaveBeenCalled();
});
