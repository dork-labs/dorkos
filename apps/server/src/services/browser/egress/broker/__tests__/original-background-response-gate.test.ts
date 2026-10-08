import { createServer, request, type ServerResponse } from 'node:http';
import { expect, it, onTestFinished } from 'vitest';
import { ownOriginalBackgroundResponseGate } from './original-background-response-gate.fixture.js';

async function fixture() {
  let first: { value: unknown } | undefined;
  let gate!: ReturnType<typeof ownOriginalBackgroundResponseGate>;
  let originalResponse!: ServerResponse;
  let currentFailure: { value: unknown } | undefined;
  const socketCloses: Promise<void>[] = [];
  const server = createServer((_request, response) => {
    originalResponse = response;
    gate = ownOriginalBackgroundResponseGate(response, () => {
      if (currentFailure) throw currentFailure.value;
    });
  });
  server.on('error', (value) => {
    first ??= { value };
  });
  server.on('connection', (socket) => {
    socketCloses.push(new Promise<void>((resolve) => socket.once('close', resolve)));
    socket.on('error', (value) => {
      first ??= { value };
    });
  });
  let outgoing: ReturnType<typeof request> | undefined;
  let clientClose: Promise<void> | undefined;
  const bodyJobs: Promise<string>[] = [];
  onTestFinished(async () => {
    const ownedClose = gate?.close();
    void ownedClose?.catch(() => {});
    try {
      outgoing?.destroy();
    } catch (value) {
      first ??= { value };
    }
    const serverClose = new Promise<void>((resolve, reject) =>
      server.close((value) => (value ? reject(value) : resolve()))
    );
    void serverClose.catch(() => {});
    await Promise.allSettled([ownedClose, clientClose, ...bodyJobs, serverClose, ...socketCloses]);
    if (first) throw first.value;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ORIGINAL_GATE_LISTENER_REQUIRED');
  let bodyReturned = false;
  let resolveBody!: (value: string) => void;
  let rejectBody!: (value: unknown) => void;
  const body = new Promise<string>((yes, no) => {
    resolveBody = yes;
    rejectBody = no;
  });
  bodyJobs.push(body);
  void body.catch(() => {});
  const headers = new Promise<void>((resolve, reject) => {
    outgoing = request({ hostname: '127.0.0.1', port: address.port, path: '/' }, (incoming) => {
      socketCloses.push(new Promise<void>((yes) => incoming.once('close', yes)));
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 1024) outgoing!.destroy(new Error('ORIGINAL_GATE_BODY_BOUND'));
        else chunks.push(Buffer.from(chunk));
      });
      incoming.once('end', () => {
        bodyReturned = true;
        resolveBody(Buffer.concat(chunks).toString());
      });
      incoming.once('error', rejectBody);
      incoming.once('aborted', () => rejectBody(new Error('ORIGINAL_GATE_BODY_ABORTED')));
      resolve();
    });
    outgoing.once('error', (value) => {
      reject(value);
      rejectBody(value);
    });
    clientClose = new Promise<void>((yes) => outgoing!.once('close', yes));
    outgoing.end();
  });
  void headers.catch(() => {});
  await headers;
  return {
    gate,
    originalResponse,
    body,
    bodyReturned: () => bodyReturned,
    revoke(value: unknown) {
      currentFailure = { value };
    },
  };
}

it('holds the original HTTP body and releases once with the original response close joined', async () => {
  const f = await fixture();
  expect(f.bodyReturned()).toBe(false);
  expect(f.gate.isOriginalClosed()).toBe(false);
  expect(f.originalResponse.writableEnded).toBe(false);
  const release = f.gate.releaseOriginalResponse();
  expect(f.gate.releaseOriginalResponse()).toBe(release);
  await release;
  await f.gate.originalClose;
  expect(f.gate.isOriginalClosed()).toBe(true);
  expect(await f.body).toBe('Original owned background gate released\n');
});
it.each([false, undefined])(
  'revocation %s refuses release and still joins the original response',
  async (value) => {
    const f = await fixture();
    f.revoke(value);
    await expect(f.gate.releaseOriginalResponse()).rejects.toBe(value);
    await f.gate.originalClose;
    await expect(f.gate.close()).rejects.toBe(value);
  }
);
