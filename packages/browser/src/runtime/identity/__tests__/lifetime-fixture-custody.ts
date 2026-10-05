import https from 'node:https';
import type { ServerResponse, RequestListener } from 'node:http';
import type { Duplex } from 'node:stream';

const retained = new Set<object>();
/** Private finite operation custody; expired originals are never replaced or forgotten. */
export function ownLifetimeOperations() {
  const pending = new Set<Promise<unknown>>();
  let uncertain = false,
    issued = 0,
    evidenceIssued = false,
    stopping = false;
  let finishOriginal: Promise<{ state: string; pending: number }> | undefined;
  const resources = new Map<
    object,
    { close: () => Promise<unknown>; original?: Promise<unknown> }
  >();
  const owner = { pending, resources };
  retained.add(owner);
  async function wait<T>(original: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        original,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('LIFETIME_ORIGINAL_EXPIRED')), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const assertOpen = () => {
    if (stopping || uncertain) throw new Error('LIFETIME_ADMISSION_CLOSED');
  };
  const closeResource = (entry: { close: () => Promise<unknown>; original?: Promise<unknown> }) => {
    entry.original ??= Promise.resolve().then(entry.close);
    void entry.original.catch(() => {
      uncertain = true;
    });
    return entry.original;
  };
  return {
    assertOpen,
    adopt(original: object, close: () => Promise<unknown>) {
      if (resources.has(original)) return;
      const entry = { close };
      resources.set(original, entry);
      if (stopping) {
        uncertain = true;
        retained.add(owner);
        void closeResource(entry).catch(() => {});
      }
    },
    async operation<T>(factory: () => Promise<T>, milliseconds = 5000): Promise<T> {
      if (stopping || uncertain || pending.size >= 16 || ++issued > 128)
        throw new Error('LIFETIME_ADMISSION_CLOSED');
      const original = Promise.resolve().then(() => {
        assertOpen();
        return factory();
      });
      pending.add(original);
      void original.then(
        () => pending.delete(original),
        () => pending.delete(original)
      );
      try {
        return await wait(original, milliseconds);
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    // One terminal diagnostic original is permitted even after native admission is fenced.
    async evidence(factory: () => Promise<void>) {
      if (evidenceIssued || pending.size >= 16) throw new Error('LIFETIME_EVIDENCE_REFUSED');
      evidenceIssued = true;
      retained.add(owner);
      const original = Promise.resolve().then(factory);
      pending.add(original);
      void original.then(
        () => pending.delete(original),
        () => pending.delete(original)
      );
      try {
        await wait(original, 2000);
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    finish(milliseconds = 2000) {
      if (finishOriginal) return finishOriginal;
      stopping = true;
      const peers = [...resources.values()].map(closeResource);
      finishOriginal = (async () => {
        try {
          const rows = await wait(Promise.allSettled([...pending, ...peers]), milliseconds);
          if (rows.some((row) => row.status === 'rejected')) uncertain = true;
        } catch {
          uncertain = true;
        }
        const state = !uncertain && pending.size === 0 ? 'closed' : 'held';
        if (state === 'closed') retained.delete(owner);
        return { state, pending: pending.size };
      })();
      return finishOriginal;
    },
    snapshot: () => ({
      state: !uncertain && pending.size === 0 ? 'closed' : 'held',
      pending: pending.size,
    }),
  };
}

/** Delivered TLS sockets and held response originals are owned before policy/cap effects. */
export function ownLifetimeHttps(options: https.ServerOptions, handler: RequestListener) {
  const sockets = new Map<Duplex, Promise<void>>();
  const gates = new Map<string, ServerResponse>();
  let delivered = 0,
    uncertain = false,
    stopping = false;
  const server = https.createServer(options, handler);
  const owner: {
    server: typeof server;
    sockets: typeof sockets;
    gates: typeof gates;
    closeOriginal?: Promise<void>;
    listenerOriginal?: Promise<void>;
  } = { server, sockets, gates };
  retained.add(owner);
  const fail = () => {
    uncertain = true;
  };
  server.maxConnections = 16;
  server.on('error', fail);
  server.on('connection', (socket) => {
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => {
        sockets.delete(socket);
        resolve();
      })
    );
    sockets.set(socket, closed);
    socket.on('error', fail);
    if (++delivered > 64 || sockets.size > 16 || stopping) {
      fail();
      stopping = true;
      void close().catch(() => {});
      try {
        socket.destroy();
      } catch {
        fail();
      }
    }
  });
  return {
    server,
    markUncertain: fail,
    hold(key: string, response: ServerResponse) {
      if (stopping || gates.size >= 4 || gates.has(key)) {
        fail();
        response.end('refused');
        return;
      }
      gates.set(key, response);
      const timer = setTimeout(() => {
        fail();
        try {
          response.end('expired');
        } catch {
          fail();
        }
      }, 5000);
      response.once('close', () => {
        clearTimeout(timer);
        gates.delete(key);
      });
    },
    gateKeys: () => [...gates.keys()],
    release(key: string) {
      const original = gates.get(key);
      if (!original) throw new Error('LIFETIME_GATE_MISSING');
      original.end('released');
    },
    snapshot: () => ({ delivered, sockets: sockets.size, gates: gates.size, uncertain }),
    close,
  };

  function close() {
    return (owner.closeOriginal ??= Promise.resolve().then(async () => {
      stopping = true;
      for (const response of gates.values())
        try {
          response.end('closing');
        } catch {
          fail();
        }
      const listener = (owner.listenerOriginal = Promise.resolve().then(
        () =>
          new Promise<void>((resolve, reject) => {
            try {
              server.close((error) => (error ? reject(error) : resolve()));
            } catch (error) {
              reject(error);
            }
          })
      ));
      const originals = [...sockets.values(), listener];
      for (const socket of sockets.keys())
        try {
          socket.destroy();
        } catch {
          fail();
        }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rows = await Promise.race([
          Promise.allSettled(originals),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('LIFETIME_HTTPS_CLOSE_HELD')), 2000);
          }),
        ]);
        if (rows.some((row) => row.status === 'rejected')) fail();
      } catch {
        fail();
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (uncertain || sockets.size || gates.size) throw new Error('LIFETIME_HTTPS_CUSTODY_HELD');
      retained.delete(owner);
    }));
  }
}
