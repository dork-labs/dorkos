import { createServer, request } from 'node:http';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  createOriginalUpdateRedirect,
  originalUpdateRedirectError,
  readOriginalUpdateRedirect,
  readOriginalUpdateRedirectResult,
  runOriginalUpdateRedirect,
} from './original-update-redirect.fixture.js';
const nonce = 'fa71cdd8-4c56-41ec-8c62-9f540884fc88';
const path = `/update-redirect/${nonce}.js`;
const origins = ['https://allowed.example', 'https://denied.example'];
afterEach(() => vi.unstubAllGlobals());
it('actual HTTP script200 followed by explicit arming produces owned302 without contacting destination', async () => {
  const owner = createOriginalUpdateRedirect(() => {});
  const jobs: Promise<unknown>[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const requests = new Set<ReturnType<typeof request>>();
  let first: { value: unknown } | undefined;
  const server = createServer((incoming, response) => {
    try {
      const reply = owner.reply('allowed', incoming.url!, origins);
      if (!reply) throw new Error('ORIGINAL_REPLY_REQUIRED');
      jobs.push(new Promise<void>((yes) => response.once('close', yes)));
      response.once('error', (value) => {
        first ??= { value };
      });
      response.statusCode = reply.status;
      response.setHeader('content-type', reply.contentType);
      if (reply.location) response.setHeader('location', reply.location);
      response.end(reply.body);
    } catch (value) {
      first ??= { value };
      response.destroy();
    }
  });
  server.on('error', (value) => {
    first ??= { value };
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    jobs.push(new Promise<void>((yes) => socket.once('close', yes)));
    socket.on('error', (value) => {
      first ??= { value };
    });
  });
  onTestFinished(async () => {
    for (const original of [...requests, ...sockets])
      try {
        original.destroy();
      } catch (value) {
        first ??= { value };
      }
    const stopped = new Promise<void>((yes, no) =>
      server.close((value) => (value ? no(value) : yes()))
    );
    void stopped.catch(() => {});
    const joined = await Promise.allSettled([...jobs, stopped]);
    for (const result of joined)
      if (result.status === 'rejected') first ??= { value: result.reason };
    if (first) throw first.value;
  });
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ORIGINAL_LISTENER_REQUIRED');
  const read = () =>
    new Promise<{ status: number | undefined; location: string | undefined; body: string }>(
      (yes, no) => {
        const outgoing = request({ host: '127.0.0.1', port: address.port, path }, (incoming) => {
          jobs.push(new Promise<void>((resolve) => incoming.once('close', resolve)));
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024) outgoing.destroy(new Error('ORIGINAL_BODY_BOUND'));
            else chunks.push(Buffer.from(chunk));
          });
          incoming.once('error', no);
          incoming.once('aborted', () => no(new Error('ORIGINAL_BODY_ABORTED')));
          incoming.once('end', () =>
            yes({
              status: incoming.statusCode,
              location: incoming.headers.location,
              body: Buffer.concat(chunks).toString(),
            })
          );
        });
        requests.add(outgoing);
        jobs.push(new Promise<void>((resolve) => outgoing.once('close', resolve)));
        outgoing.once('error', no);
        outgoing.end();
      }
    );
  const initial = read();
  jobs.push(initial);
  void initial.catch(() => {});
  expect(await initial).toEqual({
    status: 200,
    location: undefined,
    body: expect.stringContaining('self.skipWaiting()'),
  });
  owner.arm(nonce, origins[0]!, origins[1]!);
  const update = read();
  jobs.push(update);
  void update.catch(() => {});
  expect(await update).toEqual({
    status: 302,
    location: origins[1] + `/forbidden/${nonce}/update-script`,
    body: '',
  });
});
it('copied owner refuses before any hostile property read and unobserved registration cannot arm', () => {
  const value = Object.defineProperty({}, 'arm', {
    get() {
      throw new Error('GETTER_ENTERED');
    },
  });
  expect(() => readOriginalUpdateRedirect(value)).toThrow(
    'UPDATE_REDIRECT_ORIGINAL_OWNER_REQUIRED'
  );
  expect(() => createOriginalUpdateRedirect(() => {}).arm(nonce, origins[0]!, origins[1]!)).toThrow(
    'UPDATE_REDIRECT_ORIGINAL_REGISTRATION_REQUIRED'
  );
});
it('changed origins and repeated arming refuse', () => {
  const owner = createOriginalUpdateRedirect(() => {});
  owner.reply('allowed', path, origins);
  expect(() => owner.arm(nonce, origins[1]!, origins[0]!)).toThrow();
  owner.arm(nonce, origins[0]!, origins[1]!);
  expect(() => owner.arm(nonce, origins[0]!, origins[1]!)).toThrow();
  expect(() => owner.reply('allowed', path, [origins[0]!, 'https://foreign.example'])).toThrow(
    'UPDATE_REDIRECT_ORIGIN_CHANGED'
  );
});
it('only the original update TypeError redirect refusal qualifies', async () => {
  const script = origins[0] + path;
  const update = vi.fn(async () => {
    throw new TypeError(`Failed to update a ServiceWorker: ${originalUpdateRedirectError}`);
  });
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistrations: async () => [{ active: { scriptURL: script }, update }] },
  });
  const result = await runOriginalUpdateRedirect(script);
  expect(readOriginalUpdateRedirectResult(result)).toEqual({
    name: 'TypeError',
    redirectError: originalUpdateRedirectError,
  });
  expect(update).toHaveBeenCalledOnce();
  expect(() =>
    readOriginalUpdateRedirectResult({ name: 'TypeError', redirectError: 'Some network error' })
  ).toThrow();
});
it.each([false, undefined, new TypeError('Different network refusal')])(
  'unrelated original update failure %s remains exact',
  async (value) => {
    const script = origins[0] + path;
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: async () => [
          {
            active: { scriptURL: script },
            update: async () => {
              throw value;
            },
          },
        ],
      },
    });
    await expect(runOriginalUpdateRedirect(script)).rejects.toBe(value);
  }
);
it('unexpected successful update and absent active registration cannot qualify rejection', async () => {
  const script = origins[0] + path;
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistrations: async () => [{ active: { scriptURL: script }, update: async () => {} }],
    },
  });
  await expect(runOriginalUpdateRedirect(script)).rejects.toThrow(
    'UPDATE_REDIRECT_UNEXPECTED_SUCCESS'
  );
  vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [] } });
  await expect(runOriginalUpdateRedirect(script)).rejects.toThrow(
    'UPDATE_REDIRECT_ORIGINAL_ACTIVE_REGISTRATION_REQUIRED'
  );
});
