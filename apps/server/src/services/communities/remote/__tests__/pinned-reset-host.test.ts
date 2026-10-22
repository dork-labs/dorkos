/**
 * A Community host that resets the connection is unavailable, and the failure stays at the call
 * site: it never reaches the process-level handler (DOR-3229). Any host DorkOS talks to can reset
 * a connection, so this is the path a stranger could otherwise use to stop the server.
 */
import net from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  PinnedOriginError,
  parseCommunityOrigin,
  pinnedJson,
  pinnedSse,
} from '../pinned-origin.js';

let server: net.Server;
let origin: URL;
const reachedProcess: unknown[] = [];
const record = (error: unknown) => reachedProcess.push(error);

beforeAll(async () => {
  // Reads the request, then resets: the client sees ECONNRESET mid-request.
  server = net.createServer((socket) => socket.once('data', () => socket.resetAndDestroy()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = parseCommunityOrigin(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
});

afterAll(async () => {
  process.off('uncaughtException', record);
  process.off('unhandledRejection', record);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('rejects a JSON call with REMOTE_UNAVAILABLE, and nothing reaches the process', async () => {
  await expect(pinnedJson(origin, '/api/v1/community')).rejects.toEqual(
    new PinnedOriginError('REMOTE_UNAVAILABLE')
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reachedProcess).toEqual([]);
});

it('rejects a stream with REMOTE_UNAVAILABLE, and nothing reaches the process', async () => {
  await expect(pinnedSse(origin, '/api/v1/channels/x/events', 'token').next()).rejects.toEqual(
    new PinnedOriginError('REMOTE_UNAVAILABLE')
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reachedProcess).toEqual([]);
});
