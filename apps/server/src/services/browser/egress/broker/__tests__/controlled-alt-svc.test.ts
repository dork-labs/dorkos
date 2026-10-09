import { createServer, get } from 'node:http';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import {
  originalOwnedAlternativeService,
  writeOriginalOwnedAlternativeService,
  requireOriginalAlternativeServiceResult,
} from './controlled-alt-svc.fixture.js';
const allowed = 'https://allowed.fixture.invalid',
  denied = 'https://denied.fixture.invalid';
const advertisement = 'h2="denied.fixture.invalid:443"; ma=60';
// These portable HTTP/schema controls do not manufacture a browser-selected alternative.
it('the original owned HTTP response carries the fixed alternative header without changing origin status/body', async () => {
  const sockets = new Map<Socket, Promise<void>>();
  const server = createServer((_request, response) => {
    writeOriginalOwnedAlternativeService(response, denied, [allowed, denied]);
    response.statusCode = 200;
    response.end('Original authority body');
  });
  server.on('connection', (socket) => {
    const returned = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('error', fail);
    sockets.set(socket, returned);
  });
  let first: { value: unknown } | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  server.on('error', fail);
  let request: ReturnType<typeof get> | undefined;
  let requestReturned: Promise<void> | undefined;
  let responseReturned: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('ORIGINAL_HTTP_ADDRESS_REQUIRED');
    const observed = new Promise<{
      status: number | undefined;
      header: string | string[] | undefined;
      body: string;
    }>((resolve, reject) => {
      request = get(
        { host: '127.0.0.1', port: address.port, path: '/', agent: false },
        (response) => {
          responseReturned = new Promise<void>((done) => response.once('close', done));
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (bytes: string) => {
            body += bytes;
          });
          response.on('error', (value) => {
            fail(value);
            reject(value);
          });
          response.on('end', () =>
            resolve({ status: response.statusCode, header: response.headers['alt-svc'], body })
          );
        }
      );
      requestReturned = new Promise<void>((done) => request?.once('close', done));
      request.on('error', (value) => {
        fail(value);
        reject(value);
      });
    });
    const result = await observed;
    expect(result).toEqual({ status: 200, header: advertisement, body: 'Original authority body' });
  } catch (value) {
    fail(value);
  } finally {
    try {
      request?.destroy();
    } catch (value) {
      fail(value);
    }
    for (const socket of sockets.keys()) {
      try {
        socket.destroy();
      } catch (value) {
        fail(value);
      }
    }
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    const returns = await Promise.allSettled([
      closed,
      requestReturned,
      responseReturned,
      ...sockets.values(),
    ]);
    for (const returned of returns) if (returned.status === 'rejected') fail(returned.reason);
  }
  if (first) throw first.value;
});
it.each([
  'http://denied.fixture.invalid',
  'https://foreign.fixture.invalid',
  'https://denied.fixture.invalid/path',
  'https://denied.fixture.invalid:8443',
])('refuses an unowned or changed alternative %s', (value) => {
  expect(() => originalOwnedAlternativeService(value, [allowed, denied])).toThrow();
});
it('accepts the exact owned explicit443 representation used by original tunnel ports', () => {
  expect(
    originalOwnedAlternativeService(denied + ':443', [allowed + ':443', denied + ':443'])
  ).toBe(advertisement);
});
const actualShape = {
  advertised: advertisement,
  protocol: 'h2',
  alternateProtocolUsage: 'unspecifiedReason',
  alternativeConnect: false,
  deniedBeforeDial: false,
  originalAuthorityRequest: true,
};
it('accepts the original advertised header and retained nonselection facts without calling fallback alternative use', () => {
  expect(requireOriginalAlternativeServiceResult(actualShape, advertisement)).toEqual(actualShape);
});
it.each([
  { alternativeConnect: true },
  { deniedBeforeDial: true },
  { originalAuthorityRequest: false },
  { advertised: 'h3=":443"' },
  { alternateProtocolUsage: 'alternativeJobWonRace' },
  { alternateProtocolUsage: 'mainJobWonRace' },
  { protocol: 'http/1.1' },
])('refuses changed header, alternative activity or missing owned observations %j', (change) => {
  expect(() =>
    requireOriginalAlternativeServiceResult({ ...actualShape, ...change }, advertisement)
  ).toThrow();
});
