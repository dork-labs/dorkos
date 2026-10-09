import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import type { Server } from 'node:http';
import { expect, it, vi, onTestFinished } from 'vitest';

type OriginalFixture = (
  context: { managedReceiver: unknown },
  use: (receiver: { url: string; revisions: number[] }) => Promise<void>
) => Promise<void>;
const captured = vi.hoisted(() => ({
  fixture: undefined as OriginalFixture | undefined,
  server: undefined as Server | undefined,
}));
// Capture registration only. Listener, HTTP handler, accepted sockets and close are original Node producers.
vi.mock('../fixtures/managed-browser-receiver', async () => ({
  expect: (await import('vitest')).expect,
  test: {
    extend(definitions: { performanceReceiver: OriginalFixture }) {
      captured.fixture = definitions.performanceReceiver;
      return {};
    },
  },
}));
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>();
  const createServer = new Proxy(original.createServer, {
    apply(target, thisArg, args) {
      const server: ReturnType<typeof original.createServer> = Reflect.apply(target, thisArg, args);
      captured.server = server;
      return server;
    },
  });
  return { ...original, createServer };
});
import '../fixtures/managed-performance-receiver';

it.each([false, undefined])(
  'body %s survives socket fault and held original HTTP close while all sockets retire',
  async (bodyCause) => {
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    let entered!: () => void;
    const closeEntered = new Promise<void>((yes) => {
      entered = yes;
    });
    let returned!: () => void;
    const originalCloseReturned = new Promise<void>((yes) => {
      returned = yes;
    });
    const accepted: Socket[] = [],
      clients: Socket[] = [],
      clientCloses: Promise<void>[] = [];
    const spies: Array<{ mockRestore(): void }> = [];
    let settled = false;
    const result = captured.fixture!({ managedReceiver: {} }, async (receiver) => {
      const server = captured.server!;
      let both!: () => void;
      const bothAccepted = new Promise<void>((yes) => {
        both = yes;
      });
      server.on('connection', (socket) => {
        accepted.push(socket);
        if (accepted.length === 2) both();
      });
      const url = new URL(receiver.url);
      for (let n = 0; n < 2; n++) {
        const client = createConnection({ host: url.hostname, port: Number(url.port) });
        clients.push(client);
        client.on('error', () => {});
        clientCloses.push(new Promise<void>((yes) => client.once('close', () => yes())));
        await once(client, 'connect');
      }
      await bothAccepted;
      for (const [index, socket] of accepted.entries()) {
        const destroy = socket.destroy.bind(socket);
        let faulted = false;
        spies.push(
          vi.spyOn(socket, 'destroy').mockImplementation((error) => {
            const result = destroy(error);
            if (index === 0 && !faulted) {
              faulted = true;
              throw new Error('LATER_SOCKET_DESTROY_FAULT');
            }
            return result;
          })
        );
      }
      const originalClose = server.close.bind(server);
      spies.push(
        vi.spyOn(server, 'close').mockImplementation((callback) => {
          entered();
          return originalClose(() => {
            returned();
            void held.then(() => callback?.(new Error('LATER_CLOSE_CALLBACK_FAULT')));
          });
        })
      );
      throw bodyCause;
    });
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    onTestFinished(async () => {
      release();
      for (const client of clients) client.destroy();
      for (const socket of accepted) socket.destroy();
      try {
        await Promise.allSettled([result, ...clientCloses]);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
    await closeEntered;
    const prematureReturn = result.then(
      () => {
        throw new Error('FIXTURE_RETURNED_BEFORE_ORIGINAL_CLOSE_JOIN');
      },
      () => {
        throw new Error('FIXTURE_RETURNED_BEFORE_ORIGINAL_CLOSE_JOIN');
      }
    );
    void prematureReturn.catch(() => {});
    await Promise.race([originalCloseReturned, prematureReturn]);
    await Promise.all(clientCloses);
    expect(accepted).toHaveLength(2);
    expect(accepted.every((socket) => socket.destroyed)).toBe(true);
    expect(spies[0]).toHaveBeenCalled();
    expect(spies[1]).toHaveBeenCalled();
    expect(settled).toBe(false);
    release();
    await expect(result).rejects.toBe(bodyCause);
  }
);
