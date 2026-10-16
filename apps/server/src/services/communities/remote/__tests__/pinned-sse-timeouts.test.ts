/**
 * A live space stream stays open for as long as it carries anything (DOR-2973). It used to end
 * every 30 seconds whatever it carried, and each reopening lost what was posted in the gap and
 * left the channel's copy unreadable to agents for a moment, so an agent sometimes never answered
 * a mention. Only the opening is bounded now, plus a quiet spell long enough to mean the
 * connection is dead.
 */
import { createServer, type ServerResponse, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PinnedOriginError, parseCommunityOrigin, pinnedSse } from '../pinned-origin.js';

let server: Server;
let port = 0;
/** What the test server does with each request. */
let handle: (response: ServerResponse) => void = () => undefined;
const timers: Array<ReturnType<typeof setInterval>> = [];

beforeAll(async () => {
  server = createServer((_request, response) => handle(response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  port = address.port;
});

afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const stream = (timeouts: { connectMs: number; idleMs: number }) =>
  pinnedSse(
    parseCommunityOrigin(`http://localhost:${port}`),
    '/api/v1/channels/x/events',
    'token',
    undefined,
    undefined,
    timeouts
  );

/** Open an event stream that sends a comment every `everyMs`, as a space does on a quiet stream. */
function heartbeating(response: ServerResponse, everyMs: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(': open\n\n');
  timers.push(setInterval(() => response.write(': ping\n\n'), everyMs));
}

it('keeps an open stream that carries heartbeats past the opening bound', async () => {
  // Catches a bound on the whole stream: the event arrives well after connectMs has passed.
  // The idle bound is twenty heartbeats wide, so a busy test machine cannot trip it.
  handle = (response) => {
    heartbeating(response, 50);
    setTimeout(() => response.write(`data: ${JSON.stringify({ n: 1 })}\n\n`), 1_500);
  };
  const started = Date.now();
  const iterator = stream({ connectMs: 300, idleMs: 1_000 })[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.value).toEqual({ n: 1 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  await iterator.return?.(undefined);
});

it('gives up on an open stream that goes quiet for longer than the idle bound', async () => {
  // Catches a stream with no bound at all once open: a dead connection would hang forever.
  handle = (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': open\n\n');
  };
  const started = Date.now();
  await expect(stream({ connectMs: 5_000, idleMs: 300 }).next()).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(3_000);
});

it('gives up on a stream that answers and then sends nothing at all', async () => {
  // Catches the opening bound standing in for the idle one: here it is far longer, so only the
  // idle bound armed when the answer arrives can end the stream in time.
  handle = (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
  };
  const started = Date.now();
  await expect(stream({ connectMs: 5_000, idleMs: 300 }).next()).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(3_000);
});

it('gives up on a stream that never answers within the opening bound', async () => {
  // Catches losing the opening bound while moving the timeout off the open stream.
  handle = () => undefined;
  const started = Date.now();
  const failure = await stream({ connectMs: 300, idleMs: 5_000 })
    .next()
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PinnedOriginError);
  expect((failure as PinnedOriginError).code).toBe('REMOTE_UNAVAILABLE');
  expect(Date.now() - started).toBeLessThan(3_000);
});
