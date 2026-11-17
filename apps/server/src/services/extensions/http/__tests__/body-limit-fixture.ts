import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi, type Mock } from 'vitest';
import { swappableServer, type SwappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { createExtensionApiRoutes } from '../../../../routes/extension-api.js';
import { createFetchHandler } from '../fetch-handler.js';

/** One real incoming/outgoing pair, observed without reading or changing its body. */
export interface BodyExchange {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
  finishedBeforeInputEnd: boolean;
  closed: Promise<void>;
}

/** A complete JSON response; upload errors are recorded separately, never used as a status. */
export interface BodyReply {
  status: number;
  body: unknown;
  complete: boolean;
  headers: http.IncomingHttpHeaders;
  uploadErrors: Error[];
}

/** Owned listener, real handler and observed exchanges for one test scope. */
interface BodyLimitFixture extends SwappableServer {
  exchanges: BodyExchange[];
  handler: Mock<(req: Request) => Promise<Response>>;
  serve(): void;
}

/** The same real extension/front-door stack as fetch-handler.test, on one owned listener. */
export function bodyLimitFixture(): BodyLimitFixture {
  const target = swappableServer();
  const exchanges: BodyExchange[] = [];
  const handler = vi.fn(async (req: Request) =>
    Response.json({ bytes: (await req.text()).length })
  );
  const serve = () => {
    exchanges.length = 0;
    handler.mockClear();
    const listener = honoGroupListener({
      path: '/api/ext',
      routes: createExtensionApiRoutes({
        getServerHandler: (id) =>
          id === 'my-ext' ? createFetchHandler('My Extension', handler) : null,
      }),
    });
    target.mount((incoming, outgoing) => {
      const exchange: BodyExchange = {
        incoming,
        outgoing,
        finishedBeforeInputEnd: false,
        closed: new Promise((resolve) => outgoing.once('close', resolve)),
      };
      outgoing.once('finish', () => {
        exchange.finishedBeforeInputEnd = !incoming.readableEnded;
      });
      exchanges.push(exchange);
      listener(incoming, outgoing);
    });
  };
  return { ...target, exchanges, handler, serve };
}

/** Send a real request and require actual complete JSON, not a request-write error or headers alone. */
export function bodyRequest(
  server: http.Server,
  body: Buffer | string | null,
  options: { declared?: number; chunked?: boolean } = {}
): { request: ClientRequest; response: Promise<BodyReply> } {
  const uploadErrors: Error[] = [];
  let request!: ClientRequest;
  let received = false;
  const response = new Promise<BodyReply>((resolve, reject) => {
    request = http.request(
      {
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        method: 'PUT',
        path: '/api/ext/my-ext/notes',
        agent: false,
        headers: {
          'content-type': 'text/plain',
          ...(options.declared !== undefined ? { 'content-length': options.declared } : {}),
          ...(options.chunked ? { 'transfer-encoding': 'chunked' } : {}),
        },
      },
      (res) => {
        received = true;
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.once('error', reject);
        res.once('end', () => {
          if (!res.complete) {
            reject(new Error('Incomplete HTTP response'));
            return;
          }
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(text),
              complete: res.complete,
              headers: res.headers,
              uploadErrors,
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('error', (error) => {
      uploadErrors.push(error);
    });
    request.once('close', () => {
      if (!received) reject(uploadErrors[0] ?? new Error('Connection closed without a response'));
    });
    if (body === null) request.flushHeaders();
    else if (options.chunked) {
      request.write(body);
      request.end();
    } else request.end(body);
  });
  return { request, response };
}
