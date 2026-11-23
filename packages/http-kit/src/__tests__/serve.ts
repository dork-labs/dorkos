/**
 * Serve a Hono app on a real Node listener on an ephemeral loopback port, so
 * the body stage reads a real `IncomingMessage` as it does in production.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { afterEach } from 'vitest';

const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

/**
 * Start `app` and return its base URL. Closed after each test.
 *
 * @param app - The app to serve.
 * @returns The base URL, `http://127.0.0.1:<port>`.
 */
export async function serve(app: {
  fetch: Parameters<typeof getRequestListener>[0];
}): Promise<string> {
  const server = createServer(getRequestListener(app.fetch));
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
