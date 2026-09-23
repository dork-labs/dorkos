/**
 * A Community refusal keeps only its status and a code from the closed public error list, so a
 * cap such as an agent limit reaches the person as a state they can act on, while nothing else
 * the remote wrote (its message, or a code the app does not know) ever travels further.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PinnedHttpError, parseCommunityOrigin, pinnedJson } from '../pinned-origin.js';

let server: Server;
let port = 0;
let next: { status: number; body: string } = { status: 200, body: '{}' };

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(next.status, { 'content-type': 'application/json' });
    response.end(next.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function refusal(status: number, body: string): Promise<PinnedHttpError> {
  next = { status, body };
  const error = await pinnedJson(
    parseCommunityOrigin(`http://localhost:${port}`),
    '/api/v1/agents',
    {}
  ).catch((cause: unknown) => cause);
  if (!(error instanceof PinnedHttpError)) throw new Error('expected an HTTP refusal');
  return error;
}

it('keeps a known public code and drops the remote message', async () => {
  const error = await refusal(
    409,
    JSON.stringify({ code: 'AGENT_LIMIT_REACHED', message: 'relay me <script>' })
  );
  expect(error.status).toBe(409);
  expect(error.remoteCode).toBe('AGENT_LIMIT_REACHED');
  expect(JSON.stringify(error)).not.toContain('relay me');
  expect(error.message).not.toContain('relay me');
});

it.each([
  ['an unknown code', JSON.stringify({ code: 'SOMETHING_ELSE' })],
  ['a non-JSON body', '<html>busy</html>'],
  ['a code that is not a string', JSON.stringify({ code: { nested: true } })],
  ['an array body', JSON.stringify(['AGENT_LIMIT_REACHED'])],
])('keeps no code for %s', async (_label, body) => {
  expect((await refusal(409, body)).remoteCode).toBeUndefined();
});
