// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { HttpTransport } from '../http-transport';

const api = 'http://localhost:4242/api';
const id = '9829f7ec-5c65-4c29-9805-a7e9339cdc79';
const launchRef = 'ecbfe87e-a48a-40ac-8437-42b5ea69ac67';
const agentId = '01JAKNXY392V20MYAZJ6Q5GD6T';

afterEach(() => vi.unstubAllGlobals());

it('uses the mounted saved-folder endpoint with an empty JSON body', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ sessionId: id, launchRef }, { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    new HttpTransport(api).allocateSession({ kind: 'location', launchRef })
  ).resolves.toEqual({
    sessionId: id,
    launchRef,
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    `${api}/session-locations/${launchRef}/chats`,
    expect.objectContaining({ method: 'POST', body: '{}' })
  );
});

it('uses the agent endpoint with only the registered agent id', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: id }, { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    new HttpTransport(api).allocateSession({ kind: 'registered-agent', agentId })
  ).resolves.toEqual({ sessionId: id });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    `${api}/session-locations/chats`,
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'registered-agent', agentId }),
    })
  );
});

it('preserves a server collision without making a second allocation request', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json(
      {
        type: 'urn:dorkos:problem:conflict',
        title: 'That clashes with a change made meanwhile.',
        status: 409,
        code: 'conflict',
        detail: 'Couldn’t start a new chat. Try again.',
      },
      { status: 409, headers: { 'Content-Type': 'application/problem+json' } }
    )
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    new HttpTransport(api).allocateSession({ kind: 'location', launchRef })
  ).rejects.toMatchObject({
    status: 409,
    code: 'conflict',
    message: 'Couldn’t start a new chat. Try again.',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
